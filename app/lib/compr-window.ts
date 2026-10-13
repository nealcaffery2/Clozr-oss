// COMPR in its own window, beside CLOZR.
//
// Open in COMPR shows the deal's saved report in a window of its own, and
// every later Open reuses that window by name: drag it to the second screen
// once and each next house lands there. The window is thecompr.com itself,
// signed in as the rep, so the report, its photos and its sliders are
// COMPR's own and every edit is saved there.
//
// COMPR learns CLOZR opened it from ?clozr=<this origin> and keeps that for
// the window's life, then posts each report it paints and each edit it saves
// to window.opener (lib/compr-embed.ts parses them). CLOZR's page sends
// Cross-Origin-Opener-Policy same-origin-allow-popups and COMPR sends none,
// so the two windows keep their link. Once the window has spoken, the next
// house is a message ("open this lead") instead of a reload of the app.
'use client';

import { comprUrl } from './compr-embed';

const WINDOW_NAME = 'compr-report';

let win: Window | null = null;
/** COMPR's origin as the window last spoke from it; null until it has. */
let liveOrigin: string | null = null;
let ackTimer: ReturnType<typeof setTimeout> | null = null;

/** The deal the window was last opened for, and when: a report that comes back is that house's. */
export type ComprWindowDeal = { dealId: string; addr: string; at: number };
let opened: ComprWindowDeal | null = null;
/** A window left open past a working session no longer speaks for the house it was opened on. */
const OPENED_FOR_MS = 6 * 3_600_000;

export function comprWindowDeal(): ComprWindowDeal | null {
  return opened && Date.now() - opened.at < OPENED_FOR_MS ? opened : null;
}

const pulledAt = new Map<string, number>();
/**
 * Whether to pull a deal's COMPR numbers now: focus and visibility fire
 * together, and a record opened twice in a minute needs one pull.
 */
export function claimComprPull(dealId: string, minGapMs: number): boolean {
  const now = Date.now();
  if (now - (pulledAt.get(dealId) ?? 0) < minGapMs) return false;
  pulledAt.set(dealId, now);
  return true;
}

/** The report's address at COMPR, tagged so COMPR posts back to this CLOZR. */
export function comprReportHref(leadId: string): string {
  const q = typeof window === 'undefined' ? '' : '?' + new URLSearchParams({ clozr: window.location.origin }).toString();
  return `${comprUrl()}/r/${encodeURIComponent(leadId)}${q}`;
}

/**
 * CLOZR's own waiting page, shown in the COMPR window while a run is going.
 * It names its deal and keeps asking this page whether the run landed, so a
 * page that reloaded mid-run still moves the window on to the report.
 */
export function comprWaitHref(p: { address: string; photos: number; dealId?: string }): string {
  const q = new URLSearchParams({ addr: p.address, photos: String(p.photos), ...(p.dealId ? { deal: p.dealId } : {}) });
  return `${window.location.origin}/compr-wait.html?${q.toString()}`;
}

const runsInFlight = new Set<string>();
/** This page is running COMPR for the deal and moves the window on itself when the run lands. */
export function comprRunStarted(dealId: string): void { runsInFlight.add(dealId); }
export function comprRunEnded(dealId: string): void { runsInFlight.delete(dealId); }
export function comprRunInFlight(dealId: string): boolean { return runsInFlight.has(dealId); }

/** The COMPR window, asking from a page this one did not open it from (it reloaded since): take it over. */
export function adoptComprWindow(w: Window): void {
  if (win === w && !w.closed) return;
  win = w;
  liveOrigin = null;
}

function features(): string {
  const w = Math.min(window.screen?.availWidth || 1440, 1680);
  const h = window.screen?.availHeight || 900;
  return `popup=yes,width=${w},height=${h}`;
}

/**
 * The COMPR window, on `href`. From a click: a browser opens a new window only
 * for one. An open window is navigated where it is (no click needed), so a
 * report that finishes a minute later still lands in it.
 */
export function navigateComprWindow(href: string, deal?: { dealId: string; addr: string }): Window | null {
  if (deal) opened = { ...deal, at: Date.now() };
  if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
  // The page reloads: it is "live" again once COMPR boots and says so.
  liveOrigin = null;
  if (win && !win.closed) {
    try {
      win.location.href = href;
      win.focus();
      return win;
    } catch { /* lost: open it again by name */ }
  }
  win = window.open(href, WINDOW_NAME, features());
  win?.focus();
  return win;
}

/**
 * Show a saved report. A window COMPR is already running in gets an "open"
 * message and switches reports in place; one that does not answer within a
 * moment (it was closed, navigated away, or runs a COMPR without the bridge)
 * is navigated to the report instead.
 */
export function showComprReport(leadId: string, deal: { dealId: string; addr: string }): Window | null {
  const href = comprReportHref(leadId);
  if (win && !win.closed && liveOrigin) {
    opened = { ...deal, at: Date.now() };
    const target = win;
    target.postMessage({ source: 'clozr', type: 'open', lead_id: leadId }, liveOrigin);
    try { target.focus(); } catch { /* focus is a courtesy */ }
    if (ackTimer) clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (!target.closed) {
        try { target.location.href = href; } catch { /* closed meanwhile */ }
      }
    }, 1500);
    return target;
  }
  return navigateComprWindow(href, deal);
}

/** A message came from the COMPR window: it runs COMPR with the bridge, and answered. */
export function comprWindowSpoke(e: MessageEvent): void {
  if (!win || e.source !== win) return;
  liveOrigin = e.origin;
  if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
}

/** The COMPR window is still open. */
export function comprWindowOpen(): boolean {
  return !!win && !win.closed;
}
