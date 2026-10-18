'use client';

// How fast CLOZR is for the people using it, written to public.client_vitals
// (migration 365), so "is the app fast?" is a query instead of a guess.
//
// A view is one address: a new hash starts the next one, and so does the tab
// going hidden. A view open 10 minutes is closed, so a tab that never hides
// still reports. Each view sends at most 20 rows:
//   inp         its 15 worst interactions (click, tap, key) over 40 ms, each
//               split into input delay, processing and presentation;
//   long_frame  its 5 worst frames over 200 ms, with the script that ran longest.
// Once per page load: lcp, first_screen (the shell's first render with the
// workspace loaded) and load (the browser's load event).
//
// Each row carries the screen from the hash (never its record id), the build
// and a short browser name. A target is the control's tag, first class name,
// role and nearest data-testid with id parts dropped. Never its text, an
// aria-label (many carry a name, a title or a phone), a record id or anything
// typed.
//
// Like client-errors: never throws into the app, never retries, sends nothing
// signed out or during a View-as preview. Rows go out once a minute and when
// the tab hides, as one POST with keepalive so a closing tab still sends.

import { useEffect } from 'react';
import { decodeNavHash } from './nav-hash';
import { isReadOnly } from './read-only';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase';

/** Share of page loads that report. ponytail: 1 while the team is small; lower it when rows per day start to matter. */
export const SAMPLE_RATE = 1;
const INP_MIN_MS = 40;
const LONG_FRAME_MS = 200;
const MAX_INP = 15;
const MAX_FRAMES = 5;
const VIEW_MAX_MS = 10 * 60_000;
const FLUSH_MS = 60_000;
/** Rows per request, well under keepalive's 64 KB. */
const MAX_BATCH = 60;
/** The table's limits (migration 365): one bad row would fail the whole insert. */
const MAX_MS = 3_600_000;
const MAX_TARGET = 120;

export type VitalKind = 'inp' | 'lcp' | 'first_screen' | 'long_frame' | 'load';

/** A row waiting to be sent. `iid` is the browser's interactionId (0 for anything else) and is not sent. */
export type VitalRow = {
  kind: VitalKind;
  screen: string;
  value_ms: number;
  input_delay_ms: number | null;
  processing_ms: number | null;
  presentation_ms: number | null;
  target: string | null;
  iid: number;
};

const ms = (n: number) => (Number.isFinite(n) ? Math.min(MAX_MS, Math.max(0, Math.round(n))) : 0);
const clip = (s: string | null) => (s ? s.slice(0, MAX_TARGET) : null);
const WORD = /^[a-z][a-z-]*[a-z]$/;
const SCREEN = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** The screen the hash names; a bare hash is Home. */
export function screenOf(hash: string): string {
  const s = decodeNavHash(hash)?.screen ?? 'home';
  return SCREEN.test(s) ? s : 'other';
}

export function one(kind: VitalKind, screen: string, value: number, target: string | null): VitalRow {
  return { kind, screen, value_ms: ms(value), input_delay_ms: null, processing_ms: null, presentation_ms: null, target: clip(target), iid: 0 };
}

export type EventEntry = { name: string; startTime: number; duration: number; processingStart: number; processingEnd: number; interactionId?: number };

/**
 * One interaction's Event Timing entries (pointerdown, pointerup, click; or
 * keydown, keyup) as an inp row: the longest entry's duration, input delay from
 * the first, processing from the first handler to the last, the rest is
 * presentation. Named after the event whose handlers ran longest, e.g.
 * `click button.cz-btn record-archive`.
 */
export function interactionRow(group: EventEntry[], screen: string, target: string | null): VitalRow {
  const first = group.reduce((a, e) => (e.startTime < a.startTime ? e : a));
  const busiest = group.reduce((a, e) => (e.processingEnd - e.processingStart > a.processingEnd - a.processingStart ? e : a));
  const duration = Math.max(...group.map((e) => e.duration));
  const end = Math.max(...group.map((e) => e.processingEnd));
  return {
    kind: 'inp',
    screen,
    value_ms: ms(duration),
    input_delay_ms: ms(first.processingStart - first.startTime),
    processing_ms: ms(end - first.processingStart),
    presentation_ms: ms(first.startTime + duration - end),
    target: clip(WORD.test(busiest.name) ? (target ? `${busiest.name} ${target}` : busiest.name) : target),
    iid: first.interactionId ?? 0,
  };
}

/** What a description reads from an element (an Element in the browser). */
type El = { tagName: string; getAttribute(name: string): string | null; closest(selector: string): El | null };

const CONTROL = 'button, a, input, select, textarea, label, summary, [role], [tabindex], [contenteditable]';

/**
 * `button.lift-row[checkbox] today-row`: tag, first class name, role and the
 * nearest data-testid, its id parts dropped. Nothing a person wrote or a
 * record holds: no text, no aria-label, no id.
 */
export function describeTarget(node: unknown): string | null {
  const el = node as El | null;
  if (!el || typeof el.closest !== 'function' || typeof el.tagName !== 'string') return null;
  const c = el.closest(CONTROL) ?? el;
  const cls = (c.getAttribute('class') ?? '').split(/\s+/).find((k) => WORD.test(k));
  const role = c.getAttribute('role');
  const testid = (c.closest('[data-testid]')?.getAttribute('data-testid') ?? '')
    .split(/[-_]/)
    .filter((p) => /^[a-z]+$/i.test(p))
    .join('-')
    .slice(0, 40);
  return clip(c.tagName.toLowerCase() + (cls ? '.' + cls : '') + (role && WORD.test(role) ? `[${role}]` : '') + (testid ? ' ' + testid : ''));
}

/** `/_next/static/chunks/useClozr-Dk2lAbc1.js?v=1` → `useClozr`. */
export function chunkName(url: string | undefined): string | null {
  const m = /([\w.-]+?)(?:-[\w-]{8})?\.m?js(?:[?#]|$)/.exec(url ?? '');
  return m ? m[1]!.slice(0, 40) : null;
}

type Script = { duration: number; invokerType?: string; sourceURL?: string };
export type FrameEntry = { duration: number; scripts?: Script[] };

/** A long animation frame (or long task) as a row; the target is the longest script's kind and chunk. */
export function frameRow(e: FrameEntry, screen: string): VitalRow {
  const top = (e.scripts ?? []).reduce<Script | null>((a, s) => (!a || s.duration > a.duration ? s : a), null);
  const kind = top?.invokerType && WORD.test(top.invokerType) ? top.invokerType : null;
  return one('long_frame', screen, e.duration, [kind, chunkName(top?.sourceURL)].filter(Boolean).join(' ') || null);
}

// ---- views ------------------------------------------------------------------

export type Views = { key: string; at: number; inp: VitalRow[]; frames: VitalRow[]; out: VitalRow[] };
export const newViews = (): Views => ({ key: '', at: 0, inp: [], frames: [], out: [] });

/** The n worst rows, worst first. One interaction counts once, at its longest entry. */
export function keepWorst(list: VitalRow[], row: VitalRow, n: number): VitalRow[] {
  const same = row.iid ? list.find((r) => r.iid === row.iid) : undefined;
  if (same && same.value_ms >= row.value_ms) return list;
  return [...list.filter((r) => r !== same), row].sort((a, b) => b.value_ms - a.value_ms).slice(0, n);
}

/** End the open view: its rows join the outbox and the next view is `key`. */
export function closeView(v: Views, key: string): void {
  v.out.push(...v.inp, ...v.frames);
  v.key = key;
  v.inp = [];
  v.frames = [];
}

/** An inp or long_frame row for the view at `key` (a new key closes the open view); a view's age runs from its first row. */
export function hold(v: Views, key: string, at: number, row: VitalRow): void {
  if (key !== v.key) closeView(v, key);
  if (!v.inp.length && !v.frames.length) v.at = at;
  if (row.kind === 'inp') v.inp = keepWorst(v.inp, row, MAX_INP);
  else v.frames = keepWorst(v.frames, row, MAX_FRAMES);
}

/** The next batch: closed views, plus the open one once the address moved on, the tab hides or it has run VIEW_MAX_MS. */
export function drain(v: Views, key: string, at: number, hidden: boolean): VitalRow[] {
  if (hidden || key !== v.key || at - v.at >= VIEW_MAX_MS) closeView(v, key);
  return v.out.splice(0, MAX_BATCH);
}

export type VitalContext = { workspaceId: number; release: string | null; userAgent: string | null };

/** The insert body: the table's columns only. user_id is the database's auth.uid(). */
export function payload(rows: VitalRow[], ctx: VitalContext) {
  return rows.map((r) => ({
    workspace_id: ctx.workspaceId,
    kind: r.kind,
    screen: r.screen,
    value_ms: r.value_ms,
    input_delay_ms: r.input_delay_ms,
    processing_ms: r.processing_ms,
    presentation_ms: r.presentation_ms,
    target: r.target,
    release: ctx.release,
    user_agent: ctx.userAgent,
  }));
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Linux/, 'Linux'],
];

/** `Chrome 141 Windows 8c`: browser and major version, system, CPU cores. */
export function shortAgent(ua: string, cores?: number): string {
  const b = BROWSERS.find(([re]) => re.test(ua));
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'other';
  return `${b ? `${b[1]} ${b[0].exec(ua)![1]}` : 'other'} ${os}${cores ? ` ${cores}c` : ''}`.slice(0, 80);
}

/** The entry chunk's hash, `/_next/static/chunks/index-LaZZR5ab.js` → `LaZZR5ab`: it changes with each deploy. */
export function releaseOf(src: string | null | undefined): string | null {
  return /\/index-([\w-]{6,40})\.js/.exec(src ?? '')?.[1] ?? null;
}

// ---- the browser ------------------------------------------------------------

/** The commit, when Vercel exposes it at build time (it does not today; see client-errors). */
const COMMIT = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;

const views = newViews();
let auth: { token: string | null; workspaceId: number | null } = { token: null, workspaceId: null };
let started = false;
let on = false;
let hiddenAt = Infinity;
let firstFlush = true;
let firstScreen = false;
let lcp: VitalRow | null = null;
let release: string | null = null;
let agent: string | null = null;
/** Recent presses and keys: an entry's target is null once its element left the page (a closed task's row). */
const pressed: { t: number; el: EventTarget | null }[] = [];

const now = () => performance.now();
const here = () => window.location.hash;

function observe(type: string, cb: (entries: PerformanceEntry[]) => void, extra?: object) {
  try {
    new PerformanceObserver((list) => {
      try {
        if (!isReadOnly()) cb(list.getEntries());
      } catch { /* never into the app */ }
    }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
  } catch { /* this browser does not have it */ }
}

function start() {
  if (started) return;
  started = true;
  if (typeof PerformanceObserver === 'undefined' || Math.random() >= SAMPLE_RATE) return;
  on = true;
  hiddenAt = document.visibilityState === 'hidden' ? 0 : Infinity;
  release = COMMIT ?? releaseOf(document.querySelector('script[src*="/index-"]')?.getAttribute('src'));
  agent = shortAgent(navigator.userAgent, navigator.hardwareConcurrency);

  const note = (e: Event) => {
    pressed.push({ t: e.timeStamp, el: e.target });
    if (pressed.length > 8) pressed.shift();
  };
  window.addEventListener('pointerdown', note, { capture: true, passive: true });
  window.addEventListener('keydown', note, { capture: true, passive: true });

  observe('event', (entries) => {
    const groups = new Map<number, (EventEntry & { target: EventTarget | null })[]>();
    for (const e of entries as unknown as (EventEntry & { target: EventTarget | null })[]) {
      if (e.interactionId) groups.set(e.interactionId, [...(groups.get(e.interactionId) ?? []), e]);
    }
    for (const g of groups.values()) {
      const start = Math.min(...g.map((e) => e.startTime));
      const el = g.find((e) => e.target)?.target ?? pressed.findLast((p) => p.t <= start + 1)?.el ?? null;
      hold(views, here(), now(), interactionRow(g, screenOf(here()), describeTarget(el)));
    }
  }, { durationThreshold: INP_MIN_MS });

  observe('largest-contentful-paint', (entries) => {
    const e = entries.at(-1) as (PerformanceEntry & { element?: Element | null }) | undefined;
    if (firstFlush && e && e.startTime < hiddenAt) lcp = one('lcp', screenOf(here()), e.startTime, describeTarget(e.element));
  });

  const loaf = PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  observe(loaf ? 'long-animation-frame' : 'longtask', (entries) => {
    for (const e of entries as unknown as FrameEntry[]) {
      if (e.duration > LONG_FRAME_MS) hold(views, here(), now(), frameRow(e, screenOf(here())));
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    hiddenAt = Math.min(hiddenAt, now());
    flush(true);
  });
  window.setInterval(() => flush(false), FLUSH_MS);
}

function flush(hidden: boolean) {
  try {
    if (firstFlush) {
      firstFlush = false;
      if (lcp) views.out.push(lcp);
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav && nav.loadEventEnd > 0) views.out.push(one('load', screenOf(here()), nav.loadEventEnd, nav.type));
    }
    const rows = drain(views, here(), now(), hidden);
    const { token, workspaceId } = auth;
    if (!rows.length || !token || !workspaceId || isReadOnly()) return;
    void fetch(`${SUPABASE_URL}/rest/v1/client_vitals`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload(rows, { workspaceId, release, userAgent: agent })),
    }).catch(() => { /* a lost batch is fine */ });
  } catch { /* never into the app */ }
}

/**
 * Mount once, in the app page: who to send as (the session's token and
 * workspace), and whether the shell is showing (its first time is
 * first_screen). A View-as preview records and sends nothing (isReadOnly).
 */
export function useVitals(token: string | null, workspaceId: number | null, shown: boolean): void {
  useEffect(() => {
    try {
      start();
      auth = { token, workspaceId };
      if (on && shown && !firstScreen) {
        firstScreen = true;
        const t = now();
        if (t < hiddenAt) {
          performance.mark('clozr:first-screen');
          views.out.push(one('first_screen', screenOf(here()), t, null));
        }
      }
    } catch { /* never into the app */ }
    return () => {
      auth = { token: null, workspaceId: null };
    };
  }, [token, workspaceId, shown]);
}
