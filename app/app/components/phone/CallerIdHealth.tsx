// Settings → Talkr → Caller ID health, and the dialer's "See numbers": how the
// rotation (talkr docs/dialers.md §9) is spreading calls over the org's lines.
//
//   Strategy card   how a line is picked, the daily cap and rest-on-flag
//                   setting for every line (Talkr's per-line protection,
//                   saved line by line through the reputation API)
//   Summary strip   outbound calls, lines used, local area code match for the
//                   rep's own calls, lines resting, lines over cap
//   Lines table     label, number, area, today, 7 days, load against the cap,
//                   health chips, reached, rest control
//
// Counts come from Talkr history the way lib/caller-spin.ts loads them;
// grades, caps and the paused state from the reputation summary (admins, and
// null for a rep, whose table then shows CLOZR's number_health rows). Talkr
// has no "rest this line now": the nearest thing is pause-on-warning, so
// Rest here arms that and a paused line reads as resting.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { areaCity, formatPhone } from '@/lib/talkr';
import { api, setTalkrDemo, type MeDto, type NumberReputationDto, type ReputationSummaryDto } from '@/lib/talkr-web/api';
import { lineLoads, loadShare, localMatchRate, SUGGESTED_CAP, uncoveredAreaCodes, type HealthCall } from '@/lib/caller-health';
import { areaCodeOf } from '@/lib/rvm';
import { lineOwner, useLineNames } from '@/lib/line-names';
import { demoTalkr } from '@/lib/inbox-demo';
import type { BookCallerLine, BookHealth } from '@/lib/number-book';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { Button, Card, Notice } from '@/app/components/talkr/ui';
import { useSoftphone } from '@/app/components/talkr/softphoneAdapter';
import { ChipView, healthChips } from './HealthChips';
import { putNumberReputation, setSummary, useReputation } from './reputationStore';

const WINDOW_MS = 7 * 86_400_000;
const CAPS = [60, 80, 100] as const;
const META: React.CSSProperties = { font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' };
const SELECT: React.CSSProperties = { height: 28, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', font: '500 12.5px/1 var(--sans)', color: 'var(--text)' };
const GHOST: React.CSSProperties = { padding: '0 10px', height: 28, font: '500 12.5px/1 var(--sans)' };

type Row = {
  id: string; phone: string; name: string; area: string | null; city: string | null;
  today: number; week: number; cap: number | null; paused: boolean; restOnFlag: boolean | null;
  reached: number | null; rep: NumberReputationDto | null;
  chips: ReturnType<typeof healthChips>;
};

/** number_health's shape from a reputation report, so the chips read the same with or without CLOZR's nightly row. */
function healthFromRep(r: NumberReputationDto): BookHealth {
  const a = r.attestation.observed_7d;
  return {
    phone_e164: r.phone_e164, talkr_number_id: r.id, grade: r.grade, paused: r.paused,
    spam_risk: r.spam?.status === 'ok' ? r.spam.spam_risk : null,
    attestation_a_7d: a.a_share, attestation_calls_7d: a.total,
    ten_dlc_assigned: r.ten_dlc.assigned, ten_dlc_status: r.ten_dlc.campaign?.campaign_status ?? null,
    campaign_approved: r.ten_dlc.campaign?.approved ?? null, checked_at: r.checked_at,
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

export function CallerIdHealth({ isMobile }: { isMobile: boolean }) {
  const s = useSession();
  const ws = s.workspace?.id ?? null;
  const { authed } = useSoftphone();
  // Sample data (/demo): Talkr is answered from lib/inbox-demo, as the Inbox
  // does. Installed while the first render runs, before the loads below ask Talkr.
  const [demo] = useState(() => !!s.demo || (typeof window !== 'undefined' && window.location.pathname.startsWith('/demo')));
  useState(() => { if (demo) setTalkrDemo(demoTalkr); return null; });
  useEffect(() => {
    if (!demo) return;
    setTalkrDemo(demoTalkr);
    return () => setTalkrDemo(null);
  }, [demo]);
  const ready = demo || authed;

  const [me, setMe] = useState<MeDto | null>(null);
  const [calls, setCalls] = useState<HealthCall[] | null>(null);
  const [scope, setScope] = useState<'own' | 'org'>('own');
  const [err, setErr] = useState<string | null>(null);
  const [db, setDb] = useState<{ health: BookHealth[]; caller: BookCallerLine[] }>({ health: [], caller: [] });
  const rep = useReputation();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    // ponytail: one page of 500; a 7-day window past that only trims the oldest calls off the counts.
    void Promise.all([
      api.getMe(),
      api.history({ type: 'calls', direction: 'outbound', from: since, limit: 500 }),
      api.reputationSummary().then((sum) => setSummary(sum)).catch(() => null),
    ]).then(([m, h]) => {
      if (!live) return;
      setMe(m);
      setCalls(h.items.map((i) => ({ at: i.at, from_number: i.from_number, to_number: i.to_number, user_id: i.user_id })));
      setScope(h.scope);
      setErr(null);
    }).catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [ready, nonce]);

  useEffect(() => {
    if (!ws || !supabase) return;
    let live = true;
    const rows = (q: PromiseLike<{ data: unknown }>) => Promise.resolve(q).then((r) => (r.data ?? []) as never[]).catch(() => [] as never[]);
    void Promise.all([
      rows(supabase.from('number_health' as never).select('phone_e164,talkr_number_id,grade,paused,spam_risk,attestation_a_7d,attestation_calls_7d,ten_dlc_assigned,ten_dlc_status,campaign_approved,checked_at').eq('workspace_id', ws)),
      rows(supabase.from('caller_lines' as never).select('phone_e164,pool,fcr_status,reputation_enrolled,branded_attached,spam_risk,market_state').eq('workspace_id', ws)),
    ]).then(([health, caller]) => { if (live) setDb({ health: health as BookHealth[], caller: caller as BookCallerLine[] }); });
    return () => { live = false; };
  }, [ws, nonce]);

  useLineNames();
  const summary = rep.summary;
  const rows = useMemo<Row[]>(() => {
    if (!me || !calls) return [];
    // The rotation runs over the rep's own lines (DialSessionSetup); a rep with none dials on the office lines.
    const mine = me.org_numbers.filter((n) => n.assigned_user_id === me.id);
    const lines = mine.length ? mine : me.org_numbers;
    const loads = lineLoads(lines, calls);
    const byPhone = <T extends { phone_e164: string }>(list: T[]) => new Map(list.map((x) => [x.phone_e164, x]));
    const reps = new Map((summary?.numbers ?? []).map((n) => [n.id, n]));
    const healthRows = byPhone(db.health);
    const callerRows = byPhone(db.caller);
    return lines.map((n) => {
      const r = reps.get(n.id) ?? null;
      const health = healthRows.get(n.phone_e164) ?? (r ? healthFromRep(r) : null);
      const caller = callerRows.get(n.phone_e164) ?? null;
      const owner = lineOwner(n, me.id);
      const label = (n.label ?? '').trim();
      return {
        id: n.id, phone: n.phone_e164,
        name: [owner, label && label.toLowerCase() !== owner.toLowerCase() ? label : ''].filter(Boolean).join(' · ') || (n.assigned_user_id ? formatPhone(n.phone_e164) : 'Shared'),
        area: n.area_code || areaCodeOf(n.phone_e164), city: areaCity(n.phone_e164),
        today: loads[n.id]?.today ?? 0, week: loads[n.id]?.week ?? 0,
        cap: r?.protection.daily_call_cap ?? null, paused: r?.paused ?? health?.paused ?? false,
        restOnFlag: r ? r.protection.pause_on_warning : null,
        reached: r?.metrics.answer_rate_7d ?? null, rep: r,
        chips: healthChips({ caller, health }),
      };
    }).sort((a, b) => b.week - a.week || a.name.localeCompare(b.name));
  }, [me, calls, summary, db]);

  if (!ready) return <Notice>Talkr is not connected for this sign-in yet. See Account for why.</Notice>;
  if (err) return <Notice tone="error">Talkr could not be read: {err}</Notice>;
  if (!me || !calls) return <span style={META}>Reading your lines and the last seven days from Talkr…</span>;
  if (!rows.length) return <Notice>No active lines on Talkr yet. Buy one under Numbers and the rotation starts with it.</Notice>;

  // The strip is about the rep's own dialing; a line's load (the cap is per line) counts everyone on it.
  const mine = scope === 'org' ? calls.filter((c) => c.user_id === me.id) : calls;
  const outbound = mine.length;
  const used = new Set(rows.filter((r) => r.week > 0).map((r) => r.id)).size;
  const local = localMatchRate(mine, null);
  const resting = rows.filter((r) => r.paused).length;
  const overCap = rows.filter((r) => r.cap !== null && r.today >= r.cap).length;
  const uncovered = uncoveredAreaCodes(rows.map((r) => ({ phone_e164: r.phone, area_code: r.area })), mine);
  const own = rows.some((r) => me.org_numbers.find((n) => n.id === r.id)?.assigned_user_id === me.id);
  // Sample data accepts the controls and says a save is not available, as the Inbox composer does.
  const canEdit = !!summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={META}>{own ? (rows.length === 1 ? 'Your one line' : `Your ${rows.length} lines`) : `${rows.length} office line${rows.length === 1 ? '' : 's'}, none of your own`} · last 7 days{scope === 'own' ? ' · your calls' : ''}</span>
        <Button tone="quiet" className="ml-auto" style={GHOST} onClick={() => setNonce((n) => n + 1)}>Refresh</Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Strategy rows={rows} canEdit={canEdit} summary={summary} />
        <Card className="flex flex-wrap gap-5" style={{ flex: '1 1 380px', minWidth: 0, padding: '14px 16px', alignContent: 'flex-start' }}>
          <Stat value={String(outbound)} label="Outbound calls" />
          <Stat value={String(used)} label="Lines used" />
          <Stat value={pct(local)} label="Local area code match" />
          <Stat value={String(resting)} label="Flagged lines, resting" tone={resting ? 'amber' : undefined} />
          <Stat value={String(overCap)} label="Over daily cap" tone={overCap ? 'amber' : undefined} />
          <span style={{ ...META, flex: '1 1 100%' }}>
            {rows[0]!.week > 0 ? `The busiest line carried ${rows[0]!.week} of ${rows.reduce((n, r) => n + r.week, 0)} calls on these lines. ` : ''}The bar below is today&rsquo;s calls against the line&rsquo;s daily cap.
          </span>
        </Card>
      </div>

      <Card padded={false} style={{ overflow: 'hidden' }}>
        <div className="flex items-center gap-2" style={{ padding: '12px 12px 8px' }}>
          <span style={{ font: '650 13.5px/1.25 var(--sans)' }}>Your lines</span>
          <span style={META}>Sorted by calls this week</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: isMobile ? 760 : undefined, borderCollapse: 'collapse', font: '500 12.5px/1.3 var(--sans)', fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                {['Line', 'Number', 'Area', 'Today', '7 days', 'Load', 'Health', 'Reached', ''].map((h, i) => (
                  <th key={i} scope="col" style={{ textAlign: 'left', ...META, padding: '8px 12px', background: 'var(--panel-2)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap', width: h === 'Load' ? '18%' : undefined }}>
                    {h || <span className="sr-only">Rest</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <LineRow key={r.id} r={r} canEdit={canEdit} />)}
            </tbody>
          </table>
        </div>
      </Card>

      <span style={META}>
        Health comes from the carrier lookups Talkr runs each morning; a dash under Reached means Talkr has no answer rate for the line yet.
        {uncovered.length ? ` Area codes you dial with no local line: ${uncovered.map((u) => `${u.area}${areaCity(`+1${u.area}5550000`) ? ` ${areaCity(`+1${u.area}5550000`)}` : ''} (${u.calls} call${u.calls === 1 ? '' : 's'})`).join(', ')}.` : ''}
      </span>
    </div>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'amber' }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <b style={{ font: '700 22px/1.2 var(--sans)', letterSpacing: '-0.02em', color: tone ? 'var(--amber)' : 'var(--text)' }}>{value}</b>
      <span style={META}>{label}</span>
    </span>
  );
}

/**
 * How a line is picked, and the two protections Talkr keeps per line, set
 * here for every line at once. Saved one PATCH per line; the texting cap on
 * each line is left as it is.
 */
function Strategy({ rows, canEdit, summary }: { rows: Row[]; canEdit: boolean; summary: ReputationSummaryDto | null }) {
  const caps = rows.map((r) => r.cap);
  const common = (xs: (number | null)[]) => xs.length && xs.every((x) => x === xs[0]) ? xs[0] : undefined;
  const [cap, setCap] = useState<string>(() => { const c = common(caps); return c === undefined ? '' : c === null ? 'none' : String(c); });
  const [rest, setRest] = useState<string>(() => rows.every((r) => r.restOnFlag) ? 'flag' : rows.every((r) => r.restOnFlag === false) ? 'never' : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    if (!summary) return;
    setBusy(true); setNote(null);
    let saved = 0;
    const failed: string[] = [];
    for (const r of rows) {
      if (!r.rep) continue;
      const protection = {
        daily_call_cap: cap === '' ? r.rep.protection.daily_call_cap : cap === 'none' ? null : Number(cap),
        daily_sms_cap: r.rep.protection.daily_sms_cap,
        pause_on_warning: rest === '' ? r.rep.protection.pause_on_warning : rest === 'flag',
      };
      try {
        putNumberReputation((await api.updateNumberReputation(r.id, { protection })).reputation);
        saved++;
      } catch {
        failed.push(formatPhone(r.phone));
      }
    }
    setNote(failed.length ? `Saved ${saved}; Talkr refused ${failed.join(', ')}.` : `Saved on ${saved} line${saved === 1 ? '' : 's'}. Talkr refuses calls past the cap for the rest of the day.`);
    setBusy(false);
  };

  return (
    <Card style={{ flex: '1 1 380px', minWidth: 0, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '650 13.5px/1.25 var(--sans)' }}>How your lines are picked</span>
      <ol style={{ margin: 0, paddingLeft: 18, font: '500 12.5px/1.6 var(--sans)', color: 'var(--dark-2)' }}>
        <li>A line in the seller&rsquo;s area code, when you have one.</li>
        <li>Otherwise the line with the fewest calls this week.</li>
        <li>A line resting on a spam flag or over its daily cap is skipped.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <label style={META} htmlFor="cih-cap">Daily cap per line</label>
        <select id="cih-cap" value={cap} disabled={!canEdit || busy} onChange={(e) => setCap(e.target.value)} style={SELECT}>
          {cap === '' ? <option value="">Mixed</option> : null}
          {CAPS.map((c) => <option key={c} value={c}>{c} calls</option>)}
          <option value="none">No cap</option>
        </select>
        <label style={META} htmlFor="cih-rest">Rest after a spam flag</label>
        <select id="cih-rest" value={rest} disabled={!canEdit || busy} onChange={(e) => setRest(e.target.value)} style={SELECT}>
          {rest === '' ? <option value="">Mixed</option> : null}
          <option value="flag">Until the flag clears</option>
          <option value="never">Keep dialing</option>
        </select>
        {canEdit ? <Button tone="accent" className="ml-auto" style={GHOST} disabled={busy || (cap === '' && rest === '')} onClick={() => void save()}>{busy ? 'Saving…' : 'Save caps'}</Button> : null}
      </div>
      <span style={META}>
        {canEdit ? 'Applies to every line. Blank texting caps stay as they are.' : 'A Talkr owner or admin sets caps, under Numbers.'}
        {' '}Talkr has no timed rest: a line rests while its spam warning is active, and the morning guard clears it.
      </span>
      {note ? <span role="status" style={META}>{note}</span> : null}
    </Card>
  );
}

function LineRow({ r, canEdit }: { r: Row; canEdit: boolean }) {
  const [busy, setBusy] = useState(false);
  const share = loadShare(r.today, r.cap);
  const over = r.cap !== null && r.today >= r.cap;
  const toggle = async () => {
    if (!r.rep) return;
    setBusy(true);
    try {
      putNumberReputation((await api.updateNumberReputation(r.id, { protection: { ...r.rep.protection, pause_on_warning: !r.restOnFlag } })).reputation);
    } catch { /* the row keeps its old state; the strategy card's note is where a refusal is explained */ }
    setBusy(false);
  };
  const td: React.CSSProperties = { padding: '9px 12px', borderBottom: '1px solid var(--line-soft)', whiteSpace: 'nowrap', verticalAlign: 'middle' };
  return (
    <tr style={{ opacity: r.paused ? 0.75 : 1 }}>
      <td style={{ ...td, fontWeight: 600, whiteSpace: 'normal', minWidth: 120 }}>{r.name}</td>
      <td style={td}>{formatPhone(r.phone)}</td>
      <td style={td}>{r.area ?? '—'}{r.city ? ` · ${r.city}` : ''}</td>
      <td style={td}>{r.today}</td>
      <td style={td}>{r.week}</td>
      <td style={td}>
        <div title={`${r.today} of ${r.cap ?? `${SUGGESTED_CAP} suggested`} today`} aria-label={`${r.today} of ${r.cap ?? SUGGESTED_CAP} calls today`} role="img" style={{ height: 6, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden', minWidth: 90 }}>
          <div style={{ height: '100%', width: `${Math.round(share * 100)}%`, background: over ? 'var(--amber)' : 'var(--accent)' }} />
        </div>
      </td>
      <td style={td}>
        <span className="inline-flex flex-wrap items-center gap-1">
          {r.chips.length ? r.chips.map((c) => <ChipView key={c.key} chip={c} />) : <ChipView chip={{ text: 'No signals yet', tone: 'off', detail: 'The morning number check fills these in' }} />}
        </span>
      </td>
      <td style={td}>{pct(r.reached)}</td>
      <td style={{ ...td, textAlign: 'right' }}>
        {r.paused
          ? <span style={META}>Resting · spam warning</span>
          : r.restOnFlag === null
            ? null
            : canEdit
              ? <Button tone="ghost" style={GHOST} disabled={busy} title={r.restOnFlag ? 'Keeps dialing through a spam flag' : 'Rests this line while a spam flag is on it'} onClick={() => void toggle()}>{r.restOnFlag ? 'Rests on flag' : 'Rest on flag'}</Button>
              : <span style={META}>{r.restOnFlag ? 'Rests on flag' : 'Dials through flags'}</span>}
      </td>
    </tr>
  );
}
