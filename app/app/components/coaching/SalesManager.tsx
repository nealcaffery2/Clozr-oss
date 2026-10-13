'use client';

// Coaching: the AI Sales Manager. One page that ties the four parts together:
//
//   Overview         the week at a glance: team score, call-flow hit rate,
//                    flagged calls, practice, and who needs attention
//   Flagged calls    graded calls with missed-deal flags (filter by rep and
//                    flag), each opening its recording, transcript and card
//   Scorecards       per-rep KPIs for a period, framework stage hit rates
//   Submit a call    a call from outside CLOZR (transcript or recording), reviewed the same way
//   Roleplay         practise on an AI seller by phone, browser voice or text (components/coaching/Roleplay)
//   Practice         roleplay history and score trend per rep
//
// Owners and admins see the team; a rep sees their own numbers. Reads the
// sales-manager function and, for history, roleplay_sessions under RLS.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { salesManagerApi, roleplayHistory, loadCoachSettings, saveCoachSettings, type FlaggedCall, type RoleplaySessionRow, type ScorecardsResult, type CoachSettings } from '@/lib/sales-manager-client';
import { FLAG_DEFS, type FlagId } from '@/lib/sales-framework';
import { activeScorecards, fmtTalk, ruleInsights, type RepScorecard } from '@/lib/sales-scorecard';
import { DIFFICULTIES, OBJECTIONS, PERSONAS, isRoleplayFeedback, scoreTrend } from '@/lib/roleplay';
import { fmtClock } from '@/lib/call-media';
import { CallInsight } from '@/app/components/record/CallInsight';
import { Roleplay } from './Roleplay';
import { SubmitCall } from './SubmitCall';
import { FeedbackView, FlagChip, Insights, INK, LINE, MUTED, RED, Stat, StageRates, btn, card, eyebrow, gradeColor, select } from './parts';

export const COACHING_TABS = ['Overview', 'Flagged calls', 'Submit a call', 'Scorecards', 'Roleplay', 'Practice'] as const;
type Tab = (typeof COACHING_TABS)[number];
const PERIODS = [['this-week', 'This week'], ['last-week', 'Last week'], ['last-30-days', 'Last 30 days'], ['this-month', 'This month'], ['this-quarter', 'This quarter']] as const;

type Props = { workspaceId: number | null; me: string | null; admin: boolean; isMobile: boolean; toast?: (m: string) => void; initialTab?: Tab };

export function SalesManager({ workspaceId, me, admin, isMobile, toast, initialTab = 'Overview' }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [period, setPeriod] = useState<string>('this-week');
  const [sc, setSc] = useState<{ period: string; res: ScorecardsResult | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const api = useMemo(() => (workspaceId ? salesManagerApi(workspaceId) : null), [workspaceId]);

  useEffect(() => {
    if (!api) return;
    let gone = false;
    void api.scorecards(period).then((r) => { if (!gone) setSc({ period, res: r.ok ? r : null, error: r.ok ? null : r.error }); });
    return () => { gone = true; };
  }, [api, period, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const scores = sc?.period === period ? sc : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: INK }}>AI Sales Manager</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: MUTED }}>
            Reviews every recorded seller call, scores it against the acquisitions call flow, flags missed deals and coaches the fix.{admin ? '' : ' Your own calls and practice.'}
          </p>
        </div>
        {tab === 'Overview' || tab === 'Scorecards' ? (
          <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} style={select}>
            {PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        ) : null}
      </div>
      <div role="tablist" style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${LINE}`, overflowX: 'auto' }}>
        {COACHING_TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}
            style={{ height: 34, padding: '0 11px', border: 0, borderBottom: `2px solid ${tab === t ? INK : 'transparent'}`, background: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: tab === t ? INK : MUTED, whiteSpace: 'nowrap' }}>
            {t}
          </button>
        ))}
      </div>
      {!api ? <div style={{ ...card, fontSize: 13, color: MUTED }}>The AI Sales Manager reads a live workspace. Sign in to see your team.</div> : null}
      {api && tab === 'Overview' ? <Overview scores={scores} admin={admin} go={setTab} api={api} toast={toast} onGraded={refresh} workspaceId={workspaceId!} /> : null}
      {api && tab === 'Flagged calls' ? <Flagged api={api} admin={admin} workspaceId={workspaceId!} me={me} cards={scores?.res?.cards ?? []} isMobile={isMobile} /> : null}
      {api && tab === 'Submit a call' ? <SubmitCall workspaceId={workspaceId!} me={me} admin={admin} cards={scores?.res?.cards ?? []} toast={toast} /> : null}
      {api && tab === 'Scorecards' ? <Scorecards scores={scores} isMobile={isMobile} /> : null}
      {api && tab === 'Roleplay' ? <Roleplay workspaceId={workspaceId} isMobile={isMobile} onScored={refresh} onArmed={() => setTab('Practice')} /> : null}
      {api && tab === 'Practice' ? <Practice workspaceId={workspaceId!} me={me} admin={admin} cards={scores?.res?.cards ?? []} /> : null}
    </div>
  );
}

// ---- Overview --------------------------------------------------------------------

function Overview({ scores, admin, go, api, toast, onGraded, workspaceId }: {
  scores: { res: ScorecardsResult | null; error: string | null } | null; admin: boolean; go: (t: Tab) => void;
  api: ReturnType<typeof salesManagerApi>; toast?: (m: string) => void; onGraded: () => void; workspaceId: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!scores) return <div style={{ ...card, fontSize: 13, color: MUTED }}>Loading…</div>;
  if (scores.error || !scores.res) return <div style={{ ...card, fontSize: 13, color: RED }}>{scores.error ?? 'Could not load the scorecards.'}</div>;
  const cards = activeScorecards(scores.res.cards);
  const t = scores.res.team;
  const mine = !admin ? cards[0] ?? scores.res.cards[0] ?? null : null;
  const watch = [...cards].filter((c) => c.reviewedCalls > 0).sort((a, b) => b.flaggedCalls - a.flaggedCalls || (a.avgCallScore ?? 100) - (b.avgCallScore ?? 100)).slice(0, 3);

  const grade = async () => {
    setBusy('grade');
    const r = await api.reviewBacklog();
    setBusy(null);
    toast?.(r.ok ? (r.graded ? `Graded ${r.graded} call${r.graded === 1 ? '' : 's'}.` : 'Nothing left to grade in the last two weeks.') : r.error);
    if (r.ok && r.graded) onGraded();
  };
  const weekly = async () => {
    setBusy('weekly');
    const r = await api.weeklyTest();
    setBusy(null);
    toast?.(r.ok ? `Sent to ${r.to}.` : r.error);
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {t ? (
          <>
            <Stat label="Graded calls" value={t.reviewedCalls} hint="Recorded seller conversations the AI scored" />
            <Stat label="Avg call score" value={t.avgCallScore ?? 'n/a'} color={gradeColor(t.avgCallScore)} />
            <Stat label="Call-flow hit rate" value={t.frameworkHitRate != null ? `${t.frameworkHitRate}%` : 'n/a'} color={gradeColor(t.frameworkHitRate)} hint="Share of the acquisitions stages hit, across graded calls" />
            <Stat label="Flagged calls" value={t.flaggedCalls} color={t.flaggedCalls ? RED : INK} hint="Missed-deal flags" />
            <Stat label="Roleplays" value={t.roleplaySessions} />
            <Stat label="Contracts" value={t.contracts} />
          </>
        ) : mine ? (
          <>
            <Stat label="Graded calls" value={mine.reviewedCalls} />
            <Stat label="Avg call score" value={mine.avgCallScore ?? 'n/a'} color={gradeColor(mine.avgCallScore)} />
            <Stat label="Call-flow hit rate" value={mine.frameworkHitRate != null ? `${mine.frameworkHitRate}%` : 'n/a'} color={gradeColor(mine.frameworkHitRate)} />
            <Stat label="Flagged calls" value={mine.flaggedCalls} color={mine.flaggedCalls ? RED : INK} />
            <Stat label="Roleplays" value={mine.roleplaySessions} />
            <Stat label="Avg roleplay" value={mine.avgRoleplayScore ?? 'n/a'} color={gradeColor(mine.avgRoleplayScore)} />
          </>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
        <Pillar title="AI call reviews" body="Every recorded seller call is transcribed and scored: hidden objections, missed closing moments, areas of improvement and emotional engagement, the 13-stage call flow, and a flag when a deal was left on the table. Calls from outside CLOZR can be submitted too." action="Flagged calls" onClick={() => go('Flagged calls')} />
        <Pillar title="AI roleplay" body="Eight seller personas, three difficulties and objection drills. Call the roleplay line from your phone (or talk in the browser, or type), then get the same scorecard a real call gets, with a model answer for the hardest moment." action="Start a roleplay" onClick={() => go('Roleplay')} />
        <Pillar title="Rep scorecards" body="Calls, conversations, talk time, appointments set and held, offers, contracts, call score, stage hit rates, flags and practice per rep. Mailed to owners every Monday with three coaching points each." action="Scorecards" onClick={() => go('Scorecards')} />
      </div>

      {admin && watch.length ? (
        <div style={card}>
          <div style={{ ...eyebrow, marginBottom: 8 }}>Coach these first</div>
          <div style={{ display: 'grid', gap: 12 }}>
            {watch.map((c) => (
              <div key={c.id}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>
                  {c.name} <span style={{ color: gradeColor(c.avgCallScore) }}>{c.avgCallScore ?? 'n/a'}</span>
                  <span style={{ fontWeight: 400, color: MUTED }}> · {c.reviewedCalls} graded · {c.flaggedCalls} flagged</span>
                </div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#27272a', lineHeight: 1.5 }}>
                  {ruleInsights(c).map((l) => <li key={l}>{l}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {mine ? (
        <div style={card}>
          <div style={{ ...eyebrow, marginBottom: 6 }}>Your focus</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>{ruleInsights(mine).map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      ) : null}

      {admin ? (
        <div style={{ ...card, display: 'grid', gap: 10 }}>
          <div style={eyebrow}>Manager tools</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={btn} disabled={!!busy} onClick={grade}>{busy === 'grade' ? 'Grading…' : 'Grade recent ungraded calls'}</button>
            <button type="button" style={btn} disabled={!!busy} onClick={weekly}>{busy === 'weekly' ? 'Sending…' : 'Email me this week\'s scorecards'}</button>
          </div>
          <WeeklySettings workspaceId={workspaceId} toast={toast} />
          <PhoneLineSettings api={api} workspaceId={workspaceId} toast={toast} />
        </div>
      ) : null}
      {scores.res.notes.length ? <div style={{ fontSize: 11.5, color: MUTED }}>{scores.res.notes.join(' ')}</div> : null}
    </div>
  );
}

function Pillar({ title, body, action, onClick }: { title: string; body: string; action: string; onClick: () => void }) {
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{title}</div>
      <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.5, flex: 1 }}>{body}</div>
      <div><button type="button" onClick={onClick} style={btn}>{action}</button></div>
    </div>
  );
}

function WeeklySettings({ workspaceId, toast }: { workspaceId: number; toast?: (m: string) => void }) {
  const [s, setS] = useState<CoachSettings | null | 'none'>(null);
  const [recipients, setRecipients] = useState('');
  useEffect(() => {
    let gone = false;
    void loadCoachSettings(workspaceId).then((r) => {
      if (gone) return;
      setS(r ?? 'none');
      setRecipients((r?.weekly_recipients ?? []).join(', '));
    });
    return () => { gone = true; };
  }, [workspaceId]);
  if (s === null) return null;
  const on = s === 'none' ? true : s.weekly_email;
  const save = async (patch: { weekly_email?: boolean; weekly_recipients?: string[] }) => {
    const err = await saveCoachSettings(workspaceId, patch);
    toast?.(err ?? 'Saved.');
    if (!err) setS((prev) => ({ ...(prev && prev !== 'none' ? prev : { weekly_email: true, weekly_recipients: [], weekly_at: '08:00', weekly_tz: 'America/Chicago', last_weekly_at: null, last_weekly_error: null, next_weekly_at: null }), ...patch }));
  };
  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={on} onChange={(e) => void save({ weekly_email: e.target.checked })} />
        Weekly scorecard email, Mondays at 8:00 (Central) for the week before
      </label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="Recipients, comma separated. Empty: every owner and admin."
          style={{ flex: '1 1 280px', height: 30, borderRadius: 8, border: `1px solid ${LINE}`, padding: '0 10px', fontSize: 12.5 }} />
        <button type="button" style={btn} onClick={() => void save({ weekly_recipients: recipients.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /@/.test(x)) })}>Save</button>
      </div>
      {s !== 'none' && (s.last_weekly_at || s.last_weekly_error) ? (
        <div style={{ color: s.last_weekly_error ? RED : MUTED }}>
          {s.last_weekly_at ? `Last sent ${new Date(s.last_weekly_at).toLocaleString()}.` : ''} {s.last_weekly_error ?? ''}
        </div>
      ) : null}
    </div>
  );
}

// ---- Flagged calls ----------------------------------------------------------------

function Flagged({ api, admin, workspaceId, me, cards, isMobile }: {
  api: ReturnType<typeof salesManagerApi>; admin: boolean; workspaceId: number; me: string | null; cards: RepScorecard[]; isMobile: boolean;
}) {
  const [rep, setRep] = useState<string>('');
  const [flag, setFlag] = useState<FlagId | ''>('');
  const [days, setDays] = useState(30);
  const [res, setRes] = useState<{ key: string; calls: FlaggedCall[] | null; error: string | null } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const key = `${rep}|${flag}|${days}`;
  useEffect(() => {
    let gone = false;
    void api.flagged({ repId: rep || null, flag: flag || null, days }).then((r) => { if (!gone) setRes({ key, calls: r.ok ? r.calls : null, error: r.ok ? null : r.error }); });
    return () => { gone = true; };
  }, [api, rep, flag, days, key]);
  const cur = res?.key === key ? res : null;
  const reps = cards.filter((c) => c.calls > 0 || c.reviewedCalls > 0);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {admin ? (
          <select aria-label="Rep" value={rep} onChange={(e) => setRep(e.target.value)} style={select}>
            <option value="">Every rep</option>
            {reps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : null}
        <select aria-label="Flag" value={flag} onChange={(e) => setFlag(e.target.value as FlagId | '')} style={select}>
          <option value="">Every flag</option>
          {FLAG_DEFS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <select aria-label="Range" value={days} onChange={(e) => setDays(Number(e.target.value))} style={select}>
          {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      {!cur ? <div style={{ ...card, fontSize: 13, color: MUTED }}>Loading…</div> : null}
      {cur?.error ? <div style={{ ...card, fontSize: 13, color: RED }}>{cur.error}</div> : null}
      {cur?.calls && !cur.calls.length ? <div style={{ ...card, fontSize: 13, color: MUTED }}>No flagged calls in this range. Calls are flagged once a recording over a minute is transcribed and graded.</div> : null}
      {(cur?.calls ?? []).map((c) => (
        <div key={c.id} style={{ ...card, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: gradeColor(c.overall), fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>{c.overall ?? '–'}</span>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{c.seller_name ?? 'Unfiled caller'}{c.address ? <span style={{ fontWeight: 400, color: MUTED }}> · {c.address}</span> : null}</div>
              <div style={{ fontSize: 12, color: MUTED }}>
                {c.rep_name ?? 'Unknown rep'} · {new Date(c.occurred_at).toLocaleString()} · {fmtClock(c.duration_s ?? 0)}{c.hit_rate != null ? ` · call flow ${c.hit_rate}%` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{c.flags.map((f) => <FlagChip key={f.id} flag={f} />)}</div>
            <button type="button" style={btn} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Close' : c.has_recording ? 'Listen' : 'Transcript'}</button>
          </div>
          {c.verdict ? <div style={{ fontSize: 12.5, color: '#3f3f46', lineHeight: 1.5 }}>{c.verdict}</div> : null}
          <Insights items={c.insights} />
          {open === c.id ? (
            <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 10, marginLeft: isMobile ? 0 : 4 }}>
              {/* sellerId null: no record-update suggestions (and no model call) from a review screen. */}
              <CallInsight communicationId={c.id} workspaceId={workspaceId} sellerId={null} me={me} canWrite={false} prospectName={c.seller_name} repName={c.rep_name} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---- Scorecards ---------------------------------------------------------------------

function Scorecards({ scores, isMobile }: { scores: { res: ScorecardsResult | null; error: string | null } | null; isMobile: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!scores) return <div style={{ ...card, fontSize: 13, color: MUTED }}>Loading…</div>;
  if (scores.error || !scores.res) return <div style={{ ...card, fontSize: 13, color: RED }}>{scores.error ?? 'Could not load the scorecards.'}</div>;
  const cards = scores.res.admin ? activeScorecards(scores.res.cards) : scores.res.cards;
  if (!cards.length) return <div style={{ ...card, fontSize: 13, color: MUTED }}>No rep activity in this period.</div>;
  const pct = (n: number | null) => (n == null ? '–' : `${n}%`);
  const cols: [string, (c: RepScorecard) => React.ReactNode, string?][] = [
    ['Calls', (c) => c.calls], ['Convos', (c) => c.conversations, 'Calls of two minutes or more'], ['Talk', (c) => fmtTalk(c.talkTimeS)],
    ['Appts set', (c) => c.appointmentsSet], ['Held', (c) => c.appointmentsHeld], ['Offers', (c) => c.offersMade], ['Contracts', (c) => c.contracts],
    ['Contract rate', (c) => pct(c.contractRate), 'Contracts per appointment held'],
    ['Call score', (c) => <span style={{ color: gradeColor(c.avgCallScore), fontWeight: 700 }}>{c.avgCallScore ?? '–'}</span>],
    ['Flow hit', (c) => pct(c.frameworkHitRate), 'Acquisitions call-flow stages hit'], ['Flagged', (c) => c.flaggedCalls],
    ['Roleplays', (c) => c.roleplaySessions], ['RP score', (c) => c.avgRoleplayScore ?? '–'],
  ];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th style={th}>Rep</th>
              {cols.map(([l, , hint]) => <th key={l} title={hint} style={{ ...th, textAlign: 'right' }}>{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <React.Fragment key={c.id}>
                <tr onClick={() => setOpen(open === c.id ? null : c.id)} style={{ cursor: 'pointer', background: open === c.id ? '#fafafa' : undefined }}>
                  <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{c.name}</td>
                  {cols.map(([l, get]) => <td key={l} style={{ ...td, textAlign: 'right' }}>{get(c)}</td>)}
                </tr>
                {open === c.id ? (
                  <tr>
                    <td colSpan={cols.length + 1} style={{ ...td, background: '#fafafa' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, padding: '6px 2px' }}>
                        <div>
                          <div style={{ ...eyebrow, marginBottom: 6 }}>Call-flow stage hit rate</div>
                          <StageRates rates={c.stageHitRates} />
                        </div>
                        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
                          <div>
                            <div style={{ ...eyebrow, marginBottom: 6 }}>Flags</div>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {FLAG_DEFS.filter((f) => c.flags[f.id] > 0).map((f) => <FlagChip key={f.id} flag={{ label: `${f.label} ×${c.flags[f.id]}`, severity: f.severity }} />)}
                              {!c.flaggedCalls ? <span style={{ fontSize: 12, color: MUTED }}>None</span> : null}
                            </div>
                          </div>
                          <div>
                            <div style={{ ...eyebrow, marginBottom: 6 }}>Coaching</div>
                            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{ruleInsights(c).map((l) => <li key={l}>{l}</li>)}</ul>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: MUTED }}>Click a rep for stage hit rates and coaching. Activity numbers match the leaderboard; scores come from graded calls over a minute.</div>
    </div>
  );
}
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${LINE}`, ...eyebrow, fontSize: 10, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #f0f0f1', color: INK };

// ---- Practice history -------------------------------------------------------------------

function Practice({ workspaceId, me, admin, cards }: { workspaceId: number; me: string | null; admin: boolean; cards: RepScorecard[] }) {
  const [who, setWho] = useState<string>(admin ? '' : me ?? '');
  const [rows, setRows] = useState<{ who: string; list: RoleplaySessionRow[] | null; error: string | null } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    void roleplayHistory(workspaceId, { userId: who || null }).then((r) => {
      if (gone) return;
      setRows(Array.isArray(r) ? { who, list: r, error: null } : { who, list: null, error: r.error });
    });
    return () => { gone = true; };
  }, [workspaceId, who]);
  const cur = rows?.who === who ? rows : null;
  const names = new Map(cards.map((c) => [c.id, c.name]));
  const byRep = useMemo(() => {
    const m = new Map<string, RoleplaySessionRow[]>();
    for (const r of cur?.list ?? []) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
    return [...m.entries()];
  }, [cur]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {admin ? (
        <div>
          <select aria-label="Rep" value={who} onChange={(e) => setWho(e.target.value)} style={select}>
            <option value="">Every rep</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      ) : null}
      {!cur ? <div style={{ ...card, fontSize: 13, color: MUTED }}>Loading…</div> : null}
      {cur?.error ? <div style={{ ...card, fontSize: 13, color: RED }}>{cur.error}</div> : null}
      {cur?.list && !cur.list.length ? <div style={{ ...card, fontSize: 13, color: MUTED }}>No roleplays in the last 90 days.</div> : null}
      {byRep.map(([uid, list]) => {
        const trend = scoreTrend(list.map((r) => ({ at: r.started_at, score: r.score })));
        const scored = list.filter((r) => r.score != null);
        const avg = scored.length ? Math.round(scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length) : null;
        return (
          <div key={uid} style={{ ...card, display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: INK, flex: '1 1 160px' }}>{names.get(uid) ?? (uid === me ? 'You' : 'Teammate')}</div>
              <span style={{ fontSize: 12, color: MUTED }}>{list.length} session{list.length === 1 ? '' : 's'} · avg <b style={{ color: gradeColor(avg) }}>{avg ?? '–'}</b>{trend.delta != null ? ` · trend ${trend.delta >= 0 ? '+' : ''}${trend.delta}` : ''}</span>
              <Spark points={trend.points} />
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {list.map((r) => (
                <div key={r.id}>
                  <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} disabled={!isRoleplayFeedback(r.feedback)}
                    style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'center', border: 0, background: 'none', padding: '4px 0', cursor: isRoleplayFeedback(r.feedback) ? 'pointer' : 'default', fontSize: 12.5, color: INK, textAlign: 'left' }}>
                    <span style={{ width: 30, fontWeight: 700, color: gradeColor(r.score), fontVariantNumeric: 'tabular-nums' }}>{r.score ?? '–'}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {PERSONAS.find((p) => p.id === r.persona)?.label ?? r.persona} · {DIFFICULTIES.find((d) => d.id === r.difficulty)?.label ?? r.difficulty}
                      {r.objection ? ` · ${OBJECTIONS.find((o) => o.id === r.objection)?.label ?? r.objection}` : ''}
                      <span style={{ color: MUTED }}> · {r.mode} · {new Date(r.started_at).toLocaleDateString()}{r.status !== 'scored' ? ` · ${r.status}` : ''}</span>
                    </span>
                    {r.stage_hit_rate != null ? <span style={{ fontSize: 11.5, color: MUTED }}>flow {r.stage_hit_rate}%</span> : null}
                  </button>
                  {open === r.id && isRoleplayFeedback(r.feedback) ? <div style={{ padding: '6px 0 10px 40px' }}><FeedbackView f={r.feedback} /></div> : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 90, h = 22;
  const xs = points.map((_, i) => (i / (points.length - 1)) * w);
  const ys = points.map((p) => h - (Math.max(0, Math.min(100, p)) / 100) * h);
  return (
    <svg width={w} height={h} aria-label="Score trend" role="img">
      <polyline fill="none" stroke={INK} strokeWidth={1.5} points={xs.map((x, i) => `${x},${ys[i]}`).join(' ')} />
    </svg>
  );
}


function PhoneLineSettings({ api, workspaceId, toast }: { api: ReturnType<typeof salesManagerApi>; workspaceId: number; toast?: (m: string) => void }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    void loadCoachSettings(workspaceId).then((r) => { if (!gone) setPhone(r?.roleplay_phone ?? ''); });
    return () => { gone = true; };
  }, [workspaceId]);
  if (phone === null) return null;
  const save = async () => {
    setBusy(true);
    const r = await api.setupPhone(phone);
    setBusy(false);
    if (r.ok) setPhone(r.phone ?? '');
    toast?.(r.ok ? `Roleplay line ready: ${r.phone}. Reps in every workspace call it.` : r.error);
  };
  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }}>
      <div>Roleplay phone line: reps arm a scenario, then call this number from the cell on their profile. One line serves every workspace. Leave it blank to use a spare ElevenLabs number.</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Blank picks a spare number"
          style={{ flex: '0 1 220px', height: 30, borderRadius: 8, border: `1px solid ${LINE}`, padding: '0 10px', fontSize: 12.5 }} />
        <button type="button" style={btn} disabled={busy} onClick={save}>{busy ? 'Setting up…' : 'Set up the line'}</button>
      </div>
    </div>
  );
}
