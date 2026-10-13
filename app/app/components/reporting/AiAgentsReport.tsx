'use client';

// Reporting, AI Agents: every agent with its face and name, how many records
// it is working, what it sent, who replied, what it booked and handed off.
// One series per chart (touches), so one hue and no legend; every number is
// also in the table view. Reads the ai-agent function's `report` action; the
// sample graph (/demo) shows a fixed example so the screen is never blank.

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Handshake, Mail, MessageSquare, Phone, Reply, ShieldOff, Table2, Users } from 'lucide-react';
import { aiAgentApi, secondsLabel, type AgentReportRow, type AiFunnel } from '@/lib/ai-agent-client';
import { AgentAvatar } from '@/app/components/ai-agent/AgentAvatar';
import { AiaStyles } from '@/app/components/ai-agent/styles';

const BAR = '#0A8560';
const INK = '#18181b';
const MUTED = '#71717a';
const FAINT = '#a1a1aa';
const GRID = '#eef0f3';
const RANGES = [7, 30, 90] as const;

const card: React.CSSProperties = { background: '#fff', border: '1px solid var(--edge, #e4e4e7)', borderRadius: 14, boxShadow: 'var(--elev-1, 0 1px 2px rgba(0,0,0,.04))' };

export function AiAgentsReport({ workspaceId, isMobile }: { workspaceId: number | null; isMobile: boolean }) {
  const api = useMemo(() => (workspaceId ? aiAgentApi(workspaceId) : null), [workspaceId]);
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  // The answer for the range it was asked for; switching range shows loading until its own answer lands.
  const [res, setRes] = useState<{ days: number; rows: AgentReportRow[] | null; funnel: AiFunnel | null; error: string | null } | null>(null);
  const [table, setTable] = useState(false);
  const sample = useMemo(() => sampleRows(days), [days]);
  const rows = !api ? sample : res?.days === days ? res.rows : null;
  const fun = !api ? SAMPLE_FUNNEL : res?.days === days ? res.funnel : null;
  const error = api && res?.days === days ? res.error : null;

  useEffect(() => {
    if (!api) return;
    let gone = false;
    void api.report(days).then((r) => { if (!gone) setRes({ days, rows: r.ok ? r.agents : null, funnel: r.ok ? r.funnel ?? null : null, error: r.ok ? null : r.error }); });
    return () => { gone = true; };
  }, [api, days]);

  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => b.touches - a.touches || b.replies - a.replies || a.name.localeCompare(b.name)), [rows]);
  const totals = useMemo(() => sorted.reduce((t, r) => ({
    active: t.active + r.active, touches: t.touches + r.touches, replies: t.replies + r.replies, booked: t.booked + r.booked + r.voice_booked,
    handoffs: t.handoffs + r.handoffs, dnc: t.dnc + r.dnc,
  }), { active: 0, touches: 0, replies: 0, booked: 0, handoffs: 0, dnc: 0 }), [sorted]);
  const maxTouches = Math.max(1, ...sorted.map((r) => r.touches));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <AiaStyles />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: INK }}>AI agents</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: MUTED }}>
            What each agent did in the last {days} days. Every action is also on the record&apos;s timeline.{api ? '' : ' Sample numbers: this is the demo workspace.'}
          </p>
        </div>
        <div role="radiogroup" aria-label="Range" style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} onClick={() => setDays(d)}
              style={{ height: 28, padding: '0 10px', borderRadius: 7, border: '1px solid #e4e4e7', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: days === d ? INK : '#fff', color: days === d ? '#fff' : '#52525b', fontFamily: 'inherit' }}>
              {d} days
            </button>
          ))}
        </div>
        <button type="button" aria-pressed={table} onClick={() => setTable((t) => !t)}
          style={{ height: 28, padding: '0 10px', borderRadius: 7, border: '1px solid #e4e4e7', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: table ? '#f4f4f5' : '#fff', color: '#52525b', display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'inherit' }}>
          <Table2 size={13} aria-hidden /> {table ? 'Cards' : 'Table'}
        </button>
      </div>

      {error ? <div role="alert" style={{ ...card, padding: '12px 14px', color: '#991b1b', background: '#fef2f2', borderColor: '#fecaca', fontSize: 12.5 }}>{error}</div> : null}
      {!rows && !error ? <div style={{ ...card, padding: 18, fontSize: 12.5, color: MUTED }}>Loading the AI agents report…</div> : null}
      {rows && !rows.length ? (
        <div style={{ ...card, padding: 22, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>No AI agents yet</div>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: MUTED }}>An owner or admin can create one in Settings, AI Agent: a Lead manager for sellers, a Buyer assistant for buyers.</p>
        </div>
      ) : null}

      {rows && rows.length ? (
        <>
          {/* Headline tiles: the whole team of agents. */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 140 : 150}px, 1fr))`, gap: 10 }}>
            <Tile icon={<Users size={14} aria-hidden />} label="Working now" value={totals.active} hint="Records with an agent switched on" />
            <Tile icon={<MessageSquare size={14} aria-hidden />} label="Touches" value={totals.touches} hint="Texts, emails and calls sent" />
            <Tile icon={<Reply size={14} aria-hidden />} label="Replies" value={totals.replies} hint="People who answered an agent" />
            <Tile icon={<CalendarCheck size={14} aria-hidden />} label="Booked" value={totals.booked} hint="Appointments and callbacks booked" />
            <Tile icon={<Handshake size={14} aria-hidden />} label="Handed off" value={totals.handoffs} hint="Ready-to-talk records passed to a rep" />
            <Tile icon={<ShieldOff size={14} aria-hidden />} label="Opted out" value={totals.dnc} hint="Asked not to be contacted, and tagged DNC" />
          </div>

          {fun ? <FunnelCard f={fun} days={days} isMobile={isMobile} /> : null}

          {table ? <ReportTable rows={sorted} /> : (
            <>
              {/* Touches by agent: one series, horizontal bars, value at the tip. */}
              <section aria-label="Touches by agent" style={{ ...card, padding: '14px 16px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>Touches by agent</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Texts, emails and calls each agent sent, most first.</div>
                <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sorted.map((r, i) => (
                    <li key={r.agent_key} style={{ display: 'grid', gridTemplateColumns: isMobile ? '120px 1fr' : '190px 1fr', alignItems: 'center', gap: 10 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ width: 16, fontSize: 11, fontWeight: 700, color: FAINT, textAlign: 'right', flex: 'none' }}>{i + 1}</span>
                        <AgentAvatar name={r.name} src={r.avatar_url} size={24} live={r.active > 0} />
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                      </span>
                      <HBar value={r.touches} max={maxTouches} tip={`${r.name}: ${r.texts} texts, ${r.emails} emails, ${r.calls} calls`} />
                    </li>
                  ))}
                </ol>
              </section>

              {/* One card per agent. */}
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${isMobile ? 260 : 320}px), 1fr))`, gap: 12 }}>
                {sorted.map((r, i) => <AgentCard key={r.agent_key} r={r} rank={i + 1} days={days} />)}
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function Tile({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: number; hint: string }) {
  return (
    <div title={hint} style={{ ...card, padding: '11px 13px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: MUTED, fontWeight: 600 }}>
        <span style={{ color: BAR, display: 'inline-flex' }}>{icon}</span>{label}
      </div>
      <div style={{ marginTop: 4, fontSize: 24, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{value.toLocaleString('en-US')}</div>
    </div>
  );
}

/** One horizontal bar: <= 24px thick, square at the baseline, 4px round at the tip, the value just past the tip. */
function HBar({ value, max, tip }: { value: number; max: number; tip: string }) {
  const [hover, setHover] = useState(false);
  const pct = max ? (value / max) * 100 : 0;
  return (
    <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)} tabIndex={0} aria-label={tip}>
      <span style={{ flex: '0 1 auto', width: `calc(${Math.max(value ? 1.5 : 0, pct)}% - 40px)`, minWidth: value ? 4 : 0, height: 18, background: BAR, borderRadius: '0 4px 4px 0', opacity: hover ? 1 : 0.88, transition: 'opacity .12s' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{value.toLocaleString('en-US')}</span>
      {hover ? <span role="tooltip" style={tooltip}>{tip}</span> : null}
    </span>
  );
}

const tooltip: React.CSSProperties = {
  position: 'absolute', left: 0, bottom: 'calc(100% + 6px)', zIndex: 5, padding: '6px 9px', borderRadius: 8, background: INK, color: '#fff', fontSize: 11.5, whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: '0 6px 18px -8px rgba(0,0,0,.4)',
};

function AgentCard({ r, rank, days }: { r: AgentReportRow; rank: number; days: number }) {
  const stats: [React.ReactNode, string, string][] = [
    [<MessageSquare key="t" size={12} aria-hidden />, 'Texts', String(r.texts)],
    [<Mail key="e" size={12} aria-hidden />, 'Emails', String(r.emails)],
    [<Phone key="c" size={12} aria-hidden />, 'Calls', String(r.calls + r.voice_calls)],
    [<Reply key="r" size={12} aria-hidden />, 'Replies', `${r.replies}${r.records_touched ? ` · ${r.reply_rate}%` : ''}`],
    [<CalendarCheck key="b" size={12} aria-hidden />, 'Booked', String(r.booked + r.voice_booked)],
    [<Handshake key="h" size={12} aria-hidden />, 'Handed off', String(r.handoffs)],
  ];
  const done = r.enrollments.total ? Math.round(((r.enrollments.done + r.enrollments.stopped) / r.enrollments.total) * 100) : 0;
  return (
    <article className="aia-rise" style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: rank === 1 && r.touches ? 'linear-gradient(120deg, #ecfdf5, #F0FAF5)' : 'var(--band, #f6f8fb)', borderBottom: '1px solid var(--band-line, #e3e8ef)' }}>
        <AgentAvatar name={r.name} src={r.avatar_url} size={52} live={r.active > 0} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            {rank === 1 && r.touches ? <span title="Most touches in this range" style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>#1</span> : null}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>{cap(r.role_label)} · works {r.audience === 'both' ? 'sellers and buyers' : r.audience}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{r.active}</div>
          <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>working</div>
        </div>
      </header>
      <div style={{ padding: '12px 16px 14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '10px 8px' }}>
          {stats.map(([icon, k, v]) => (
            <div key={k} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: MUTED, fontWeight: 600 }}>
                <span style={{ color: BAR, display: 'inline-flex' }}>{icon}</span>{k}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Touches per day</span>
            <span style={{ fontSize: 11, color: FAINT }}>last {Math.min(days, 30)} days</span>
          </div>
          <Columns data={r.by_day} />
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: MUTED }}>
          <span>{r.enrollments.total} record{r.enrollments.total === 1 ? '' : 's'} worked</span>
          <span aria-hidden style={{ flex: 1, height: 6, borderRadius: 3, background: GRID, overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${done}%`, height: '100%', background: BAR, borderRadius: 3 }} />
          </span>
          <span>{done}% finished</span>
        </div>
        {r.dnc || r.failed ? (
          <div style={{ marginTop: 8, fontSize: 11.5, color: MUTED }}>
            {r.dnc ? `${r.dnc} asked to stop (tagged DNC)` : ''}{r.dnc && r.failed ? ' · ' : ''}{r.failed ? `${r.failed} step${r.failed === 1 ? '' : 's'} could not complete` : ''}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** Daily columns: one series, 2px gaps, square at the baseline, 4px round on top, a hairline baseline, hover for the day. */
function Columns({ data }: { data: { day: string; touches: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.touches));
  const H = 46;
  const total = data.reduce((s, d) => s + d.touches, 0);
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <div aria-hidden style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: H, borderBottom: `1px solid ${GRID}` }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <span key={d.day} onMouseEnter={() => setHover(i)}
            style={{ flex: '1 1 0', maxWidth: 24, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'default' }}>
            <span style={{ display: 'block', width: '100%', height: d.touches ? Math.max(3, Math.round((d.touches / max) * H)) : 0, background: BAR, opacity: hover === null || hover === i ? 0.9 : 0.35, borderRadius: '4px 4px 0 0', transition: 'opacity .12s' }} />
          </span>
        ))}
      </div>
      {hover !== null && data[hover] ? (
        <span role="tooltip" style={{ ...tooltip, left: `${Math.min(80, (hover / Math.max(1, data.length - 1)) * 100)}%`, bottom: H + 8 }}>
          {dayLabel(data[hover].day)}: {data[hover].touches} touch{data[hover].touches === 1 ? '' : 'es'}
        </span>
      ) : null}
      <table className="aia-sr">
        <caption>Touches per day, {total} in total</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Touches</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.touches}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ReportTable({ rows }: { rows: AgentReportRow[] }) {
  const cols = ['Agent', 'Works', 'Working now', 'Texts', 'Emails', 'Calls', 'Replies', 'Reply rate', 'Booked', 'Handed off', 'Opted out', 'Failed steps'];
  return (
    <div style={{ ...card, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <caption className="aia-sr">AI agents, every number</caption>
        <thead>
          <tr>{cols.map((c) => <th key={c} scope="col" style={{ textAlign: c === 'Agent' || c === 'Works' ? 'left' : 'right', padding: '10px 12px', fontSize: 11, color: MUTED, fontWeight: 600, borderBottom: '1px solid #e4e4e7', whiteSpace: 'nowrap' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent_key}>
              <th scope="row" style={{ textAlign: 'left', padding: '9px 12px', borderBottom: '1px solid #f4f4f5', fontWeight: 600, color: INK, whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><AgentAvatar name={r.name} src={r.avatar_url} size={22} />{r.name}</span>
              </th>
              {[r.audience, r.active, r.texts, r.emails, r.calls + r.voice_calls, r.replies, `${r.reply_rate}%`, r.booked + r.voice_booked, r.handoffs, r.dnc, r.failed].map((v, i) => (
                <td key={i} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '9px 12px', borderBottom: '1px solid #f4f4f5', color: INK, fontVariantNumeric: 'tabular-nums' }}>{String(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cap = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'AI agent');
function dayLabel(d: string): string {
  const t = Date.parse(`${d}T12:00:00`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : d;
}

/** A fixed example for the demo workspace: deterministic, so screenshots do not change. */
function sampleRows(days: number): AgentReportRow[] {
  const axis = Array.from({ length: Math.min(days, 30) }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 1) - (Math.min(days, 30) - 1 - i) * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const series = (seed: number) => axis.map((day, i) => ({ day, touches: (i * 7 + seed * 3) % 9 === 0 ? 0 : ((i * 5 + seed) % 6) + 1 }));
  const row = (key: string, name: string, role: string, audience: string, seed: number, scale: number): AgentReportRow => {
    const by_day = series(seed);
    const touches = by_day.reduce((s, d) => s + d.touches, 0);
    const texts = Math.round(touches * 0.6); const emails = Math.round(touches * 0.3); const calls = touches - texts - emails;
    return {
      agent_key: key, name, role, role_label: role === 'buyer_assistant' ? 'buyer relations assistant' : 'lead manager', avatar_url: null, audience, enabled: true, live: true, can_call: true,
      active: 12 * scale, texts, emails, calls, replies: Math.round(touches * 0.22), booked: 3 * scale, handoffs: 4 * scale, dnc: scale, records_touched: 20 * scale, failed: 0,
      by_day, enrollments: { active: 12 * scale, total: 30 * scale, done: 14 * scale, stopped: 4 * scale }, voice_calls: 6 * scale, voice_booked: scale, transferred: scale, talk_minutes: 40 * scale,
      touches, reply_rate: Math.round((Math.round(touches * 0.22) / (20 * scale)) * 100),
    };
  };
  return [row('riley', 'Riley', 'lead_manager', 'sellers', 1, 2), row('jordan', 'Jordan', 'buyer_assistant', 'buyers', 4, 3)];
}

const SAMPLE_FUNNEL: AiFunnel = {
  new_leads: 64, speed_queued: 41, contacted: 52, median_first_touch_s: 7, under_60s: 38, conversations: 23, qualified: 14, appointments: 9, transfers: 3, contracts: 2,
  reactivated: 75, reactivated_replied: 11, reactivated_booked: 3, autopilot: true, contact_rate: 44, ai_calls: 610, ai_calls_per_day: 20.3,
  by_time: { business: { leads: 18, contacted: 18, booked: 3 }, after_hours: { leads: 15, contacted: 14, booked: 3 }, weekend: { leads: 8, contacted: 8, booked: 2 } },
};

/**
 * The AI funnel, one row per step, each bar a share of new leads (one series,
 * one hue, the count and the share at the tip), with the speed to first touch
 * and what reactivation brought back beside it.
 */
function FunnelCard({ f, days, isMobile }: { f: AiFunnel; days: number; isMobile: boolean }) {
  const top = Math.max(1, f.new_leads, f.contacted);
  const steps: [string, number, string][] = [
    ['New leads', f.new_leads, 'Sellers created in the range'],
    ['Contacted by AI', f.contacted, 'Sellers an agent texted, emailed or called'],
    ['Conversations', f.conversations, 'Replied, or a call of 30 seconds or more'],
    ['Qualified', f.qualified, 'Qualification saved, or handed on as ready'],
    ['Appointments', f.appointments, 'Booked by an agent'],
    ['Live transfers', f.transfers, 'Calls the agent transferred to a person'],
    ['Contracts', f.contracts, 'Sellers the agents worked who are under contract or signed'],
  ];
  return (
    <section aria-label="AI funnel" style={{ ...card, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>AI funnel</div>
        <div style={{ fontSize: 12, color: MUTED }}>Last {days} days, distinct sellers.{f.autopilot ? '' : ' Speed and reactivation numbers start once migration 146 is applied.'}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 2fr) minmax(220px, 1fr)', gap: 16, marginTop: 12 }}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
          {steps.map(([label, n, hint]) => (
            <li key={label} title={hint} style={{ display: 'grid', gridTemplateColumns: isMobile ? '110px 1fr' : '130px 1fr', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>{label}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span aria-hidden style={{ height: 16, width: `calc(${Math.max(n ? 1.5 : 0, (n / top) * 100)}% - 70px)`, minWidth: n ? 4 : 0, background: BAR, borderRadius: '0 4px 4px 0', opacity: 0.88 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {n.toLocaleString('en-US')}{f.new_leads && label !== 'New leads' ? <span style={{ color: FAINT, fontWeight: 500 }}> · {Math.round((n / f.new_leads) * 100)}%</span> : null}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--band, #f6f8fb)', border: '1px solid var(--band-line, #e3e8ef)' }}>
            <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>Speed to first touch</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{secondsLabel(f.median_first_touch_s)}</div>
            <div style={{ fontSize: 11.5, color: MUTED }}>median · {f.under_60s} of {f.speed_queued} speed leads within a minute</div>
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--band, #f6f8fb)', border: '1px solid var(--band-line, #e3e8ef)' }}>
            <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>Contact rate</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{f.contact_rate ?? 0}%</div>
            <div style={{ fontSize: 11.5, color: MUTED }}>of sellers the AI reached out to talked back · {(f.ai_calls_per_day ?? 0).toLocaleString('en-US')} AI calls a day</div>
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--band, #f6f8fb)', border: '1px solid var(--band-line, #e3e8ef)' }}>
            <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>Reactivation</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{f.reactivated_booked.toLocaleString('en-US')} <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>booked</span></div>
            <div style={{ fontSize: 11.5, color: MUTED }}>{f.reactivated} aged leads reactivated · {f.reactivated_replied} replied</div>
          </div>
        </div>
      </div>
      {f.by_time ? (
        <div style={{ marginTop: 14, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <caption style={{ textAlign: 'left', fontSize: 12, fontWeight: 600, color: INK, paddingBottom: 6 }}>Speed-to-lead leads by when they came in</caption>
            <thead><tr>{['When', 'Leads', 'Reached by AI', 'Booked'].map((c, i) => <th key={c} scope="col" style={{ textAlign: i ? 'right' : 'left', padding: '6px 10px', fontSize: 11, color: MUTED, fontWeight: 600, borderBottom: '1px solid #e4e4e7' }}>{c}</th>)}</tr></thead>
            <tbody>
              {([['business', 'Business hours (weekdays 9 to 5)'], ['after_hours', 'After hours'], ['weekend', 'Weekends']] as const).map(([k, label]) => {
                const b = f.by_time![k];
                return (
                  <tr key={k}>
                    <th scope="row" style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, color: INK, borderBottom: '1px solid #f4f4f5' }}>{label}</th>
                    {[b.leads, b.contacted, b.booked].map((v, i) => <td key={i} style={{ textAlign: 'right', padding: '6px 10px', color: INK, fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f4f4f5' }}>{v.toLocaleString('en-US')}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
