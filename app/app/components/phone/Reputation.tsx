// Settings → Phone numbers → caller reputation. The top card: every line's
// badge counts, the registrations that lower the odds of a "Spam Likely"
// label, and the unregistered-texting rule. Per line: a Good / Watch / At risk
// badge that opens the signals, the caller-name editor and the daily caps.
//
// Nothing here can promise a number will not be labelled — the analytics
// engines decide that. The copy says so, and shows what is known and what is
// manual rather than a score it does not have.
'use client';

import React, { useEffect, useState } from 'react';
import { formatPhone } from '@/lib/talkr';
import { api, type NumberReputationDto, type ReputationChecklistItemDto, type ReputationGrade, type SmsGateMode } from '@/lib/talkr-web/api';
import { loadReputation, putNumberReputation, setSummary, toggleReputationPanel, useReputation } from './reputationStore';
import { Btn, INK, LINE, MUTED, NoteBox, card, errText, field, invokeFn, label, type Note } from './ui';
import { requestSettingsTab } from '@/app/clozr/screens/settingsTab';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const GRADE: Record<ReputationGrade, { text: string; bg: string; fg: string }> = {
  good: { text: 'Good', bg: 'var(--positive-soft, #dcfce7)', fg: '#15803d' },
  watch: { text: 'Watch', bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e' },
  at_risk: { text: 'At risk', bg: 'var(--negative-soft, #fee2e2)', fg: '#b91c1c' },
};

const STATUS: Record<ReputationChecklistItemDto['status'], { text: string; bg: string; fg: string }> = {
  done: { text: 'Done', bg: 'var(--positive-soft, #dcfce7)', fg: '#15803d' },
  partial: { text: 'Partly', bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e' },
  pending: { text: 'Pending', bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e' },
  todo: { text: 'To do', bg: 'var(--negative-soft, #fee2e2)', fg: '#b91c1c' },
  manual: { text: 'Manual', bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--muted, #52525b)' },
  unknown: { text: 'Unknown', bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--muted, #52525b)' },
};

function Tag({ c, children }: { c: { bg: string; fg: string }; children: React.ReactNode }) {
  return <span style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', padding: '2px 7px', borderRadius: '999px', background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{children}</span>;
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

// ---------------------------------------------------------------------------
// Top card
// ---------------------------------------------------------------------------

export function CallerReputation({ enabled }: { enabled: boolean }) {
  const s = useReputation(enabled);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  if (!enabled) return null;
  const sum = s.summary;

  const refresh = async () => {
    setBusy(true); setNote(null);
    await loadReputation(true);
    setBusy(false);
  };
  const setGate = async (mode: SmsGateMode) => {
    if (!sum) return;
    setNote(null);
    try {
      await api.setSmsGate(mode);
      setSummary({ ...sum, sms_gate: mode });
      setNote({ ok: true, text: mode === 'block' ? 'Texts from lines not on an approved 10DLC campaign are refused.' : mode === 'warn' ? 'Texts from unregistered lines send, with a warning.' : 'Unregistered texting warns until a campaign is approved, then is refused.' });
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
    }
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600, flex: 1 }}>Caller reputation</h2>
        {sum ? (['good', 'watch', 'at_risk'] as const).map((g) => <Tag key={g} c={GRADE[g]}>{sum.counts[g]} {GRADE[g].text}</Tag>) : null}
        <Btn small disabled={busy || s.status === 'loading'} onClick={() => void refresh()}>{busy ? 'Checking…' : 'Refresh'}</Btn>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>
        No setting guarantees a number is never labelled &ldquo;Spam Likely&rdquo; — carriers and call-analytics apps decide that. These are the signals they weigh and the registrations that lower the odds. CLOZR files the 10DLC brand and campaign for you, but it cannot make the facts true: the legal name and EIN have to match the IRS letter, and the opt-in story has to match what your website actually asks people to agree to.
      </p>

      {s.status === 'loading' ? <div style={{ fontSize: '12.5px', color: MUTED }}>Reading reputation from Talkr…</div> : null}
      {s.status === 'error' ? <div style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>{s.error}</div> : null}

      {sum ? (
        <>
          {!sum.carrier_connected ? (
            <div style={{ fontSize: '12px', color: 'var(--tx-amber-deep, #92400e)', background: 'var(--caution-soft, #fef3c7)', borderRadius: '8px', padding: '7px 10px', marginBottom: '10px' }}>
              Carrier checks are off ({sum.carrier === 'telnyx' ? 'no Telnyx API key on Talkr' : `calls run on ${sum.carrier}`}). Talkr&rsquo;s own call and text signals still show; caller names, 10DLC and spam checks need Telnyx.
            </div>
          ) : null}
          {sum.ten_dlc?.error ? <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginBottom: '8px' }}>Couldn&rsquo;t read 10DLC from the carrier: {sum.ten_dlc.error}</div> : null}

          <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflow: 'hidden' }}>
            {sum.checklist.map((item, i) => (
              <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: '10px', padding: '9px 12px', borderTop: i ? '1px solid var(--divider-2, #f0f0f1)' : 0 }}>
                <div><Tag c={STATUS[item.status]}>{STATUS[item.status].text}</Tag></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: INK }}>{item.title}{item.manual && item.status !== 'manual' ? <span style={{ color: MUTED, fontWeight: 500 }}> · manual</span> : null}</div>
                  <div style={{ fontSize: '12px', color: 'var(--muted, #52525b)', lineHeight: 1.45, marginTop: '2px' }}>{item.detail}</div>
                  {CLOZR_FILES.test(`${item.key} ${item.title}`) && item.status !== 'done' ? (
                    <div style={{ fontSize: '12px', marginTop: '3px', color: INK }}>CLOZR files this from your company facts — fill them in, then Register below. <CompanyLink /></div>
                  ) : item.action || item.link ? (
                    <div style={{ fontSize: '12px', marginTop: '3px' }}>
                      {item.action ? <span style={{ color: INK }}>{item.action} </span> : null}
                      {item.link ? <a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--tx-mint, #0a8560)', fontWeight: 600 }}>Open ↗</a> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
            <span style={{ ...label, margin: 0 }}>Unregistered texting</span>
            <select value={sum.sms_gate} onChange={(e) => void setGate(e.target.value as SmsGateMode)} style={field}>
              <option value="auto">Auto — warn until a campaign is approved, then block</option>
              <option value="block">Block texts from lines not on an approved campaign</option>
              <option value="warn">Warn only</option>
            </select>
          </div>
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>
            Applies to US (+1) recipients once Talkr has read your 10DLC registration. STOP/HELP replies always send.
          </div>
        </>
      ) : null}
      <TenDlcStatus />
      <CallerRegistryStatus />
      <GuardStatus />
      <NoteBox note={note} />
    </div>
  );
}

type GuardRun = { ran_at: string; ok: boolean; numbers: number; issues: number; enforced: number; error: string | null; summary: { alerts?: string[]; open?: string[]; enforce_errors?: string[] } | null };

/**
 * The automatic guard (supabase/functions/number-guard, migration 68): what
 * it found on its last run and a button to run it now. It reads Talkr every
 * business morning, enforces pause-on-warning, the daily caps and the texting
 * gate on every line, and notifies admins of anything that got worse.
 */
function GuardStatus() {
  const session = useSession();
  const wsId = session.workspace?.id ?? null;
  const ready = !!supabase && wsId !== null;
  const [run, setRun] = useState<GuardRun | null | 'loading'>(ready ? 'loading' : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!supabase || wsId === null) return;
    let alive = true;
    supabase.from('number_guard_runs').select('ran_at, ok, numbers, issues, enforced, error, summary')
      .eq('workspace_id', wsId).order('ran_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => { if (alive) setRun((data as GuardRun | null) ?? null); });
    return () => { alive = false; };
  }, [wsId, busy]);

  const runNow = async () => {
    if (!supabase || wsId === null) return;
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.functions.invoke('number-guard', { body: { action: 'run', workspace_id: wsId } });
    const r = (data as { runs?: Array<{ ok: boolean; error?: string; issues?: number; enforced?: number }> } | null)?.runs?.[0];
    setMsg(error ? errText(error) : !r ? 'No result.' : r.ok ? `Checked. ${r.issues ?? 0} open item${r.issues === 1 ? '' : 's'}, ${r.enforced ?? 0} setting${r.enforced === 1 ? '' : 's'} corrected.` : r.error ?? 'The guard could not run.');
    setBusy(false);
  };

  if (!ready || run === 'loading') return null;
  const items = run?.summary ? [...(run.summary.alerts ?? []), ...(run.summary.open ?? [])] : [];
  return (
    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${LINE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ ...label, margin: 0 }}>Automatic guard</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: run?.ok ? 'var(--ink-2, #27272a)' : '#b91c1c' }}>
          {!run ? 'Has not run yet — it runs every business morning.'
            : run.ok ? `Last run ${when(run.ran_at)} · ${run.numbers} line${run.numbers === 1 ? '' : 's'} · ${run.issues} open · ${run.enforced} corrected`
              : `Failed ${when(run.ran_at)}: ${run.error}`}
        </span>
        {items.length ? <Btn small onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'What is open'}</Btn> : null}
        <Btn small disabled={busy} onClick={() => void runNow()}>{busy ? 'Checking…' : 'Run now'}</Btn>
      </div>
      {open && items.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12.5px', color: 'var(--ink-2, #27272a)', lineHeight: 1.5 }}>
          {items.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      ) : null}
      {msg ? <div style={{ fontSize: '12px', color: MUTED, marginTop: '6px' }}>{msg}</div> : null}
      <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>
        Every business morning: reads every line from the carrier, enforces pause-on-warning, the daily call and text caps and the texting gate, and notifies admins of anything that got worse. It also pushes a 10DLC filing you have already started, and the caller-registry job (Free Caller Registry, reputation, branded calling) for any new line.
      </div>
    </div>
  );
}

function CompanyLink() {
  return (
    <button type="button" onClick={() => requestSettingsTab({ main: 'workspace', tab: 'company' })} style={{ padding: 0, border: 0, background: 'none', color: 'var(--tx-mint, #0a8560)', fontWeight: 600, fontSize: 'inherit', cursor: 'pointer', fontFamily: 'inherit' }}>
      Edit company facts
    </button>
  );
}

/** Talkr's checklist predates CLOZR filing 10DLC itself and still says "do it in the portal". */
const CLOZR_FILES = /10dlc|ten_dlc|campaign/i;

type Registration = {
  status: 'draft' | 'submitting' | 'brand_pending' | 'campaign_pending' | 'assigning' | 'active' | 'failed';
  brand_status: string | null;
  campaign_status: string | null;
  last_error: string | null;
  submitted_at: string | null;
  active_at: string | null;
};

const REG: Record<Registration['status'], { text: string; c: { bg: string; fg: string } }> = {
  draft: { text: 'Not filed', c: STATUS.todo },
  submitting: { text: 'Filing', c: STATUS.pending },
  brand_pending: { text: 'Brand filed', c: STATUS.pending },
  campaign_pending: { text: 'Campaign filed', c: STATUS.pending },
  assigning: { text: 'Attaching lines', c: STATUS.pending },
  active: { text: 'Registered', c: STATUS.done },
  failed: { text: 'Rejected', c: STATUS.todo },
};

type RegistryState = {
  enterprise_id: string | null;
  reputation_status: string | null;
  loa_status: string | null;
  dir_id: string | null;
  dir_status: string | null;
  fcr_job_status: string | null;
  last_code: string | null;
  last_error: string | null;
  last_run_at: string | null;
  notes: string[] | null;
};

/**
 * Free Caller Registry plus Telnyx Number Reputation, remediation and branded
 * calling (migration 91, supabase/functions/caller-registry). The code from
 * First Orion, Hiya and TNS is read from AgentMail. A new number is queued
 * the moment it is bought.
 */
export function CallerRegistryStatus() {
  const session = useSession();
  const wsId = session.workspace?.id ?? null;
  const ready = !!supabase && wsId !== null;
  const [state, setState] = useState<RegistryState | null | 'loading'>(ready ? 'loading' : null);
  const [lines, setLines] = useState<Array<{ phone_e164: string; fcr_status: string; reputation_enrolled: boolean; branded_attached: boolean; spam_risk: string | null }>>([]);
  const [busy, setBusy] = useState<'sync' | 'run' | null>(null);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (!supabase || wsId === null) return;
    let alive = true;
    supabase.from('caller_registry_state').select('enterprise_id, reputation_status, loa_status, dir_id, dir_status, fcr_job_status, last_code, last_error, last_run_at, notes').eq('workspace_id', wsId).maybeSingle()
      .then(({ data }) => { if (alive) setState((data as RegistryState | null) ?? null); });
    supabase.from('caller_lines').select('phone_e164, fcr_status, reputation_enrolled, branded_attached, spam_risk').eq('workspace_id', wsId)
      .then(({ data }) => { if (alive) setLines((data as typeof lines) ?? []); });
    return () => { alive = false; };
  }, [wsId, busy]);

  if (!ready || state === 'loading') return null;

  const run = async (action: 'mail' | 'advance', key: 'sync' | 'run') => {
    if (!supabase || wsId === null) return;
    setBusy(key); setNote(null);
    const { data: r, error } = await invokeFn<{ notes?: string[]; problems?: Array<{ field: string; problem: string }>; error?: string }>('caller-registry', { action, workspace_id: wsId });
    const notes = r?.notes?.filter(Boolean).join(' ') ?? '';
    if (error) setNote({ ok: false, text: error });
    else if (r?.problems?.length) setNote({ ok: false, text: `${notes ? `${notes}\n` : ''}Missing company facts: ${r.problems.map((p) => p.field.replace(/_/g, ' ')).join(', ')}. Fill them in under Settings → Workspace → Company & 10DLC.` });
    else setNote({ ok: true, text: notes || (action === 'mail' ? 'Inbox checked.' : 'Registry run finished.') });
    setBusy(null);
  };

  const waiting = lines.filter((l) => l.fcr_status === 'queued' || l.fcr_status === 'submitting' || l.fcr_status === 'code_ready');
  return (
    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${LINE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ ...label, margin: 0 }}>Caller registry</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>
          {!state?.last_run_at ? 'Not run yet. Buying a number queues it; the morning guard runs the rest.'
            : `${lines.length} line${lines.length === 1 ? '' : 's'} tracked${waiting.length ? ` · ${waiting.length} still need Free Caller Registry` : ''}. Last run ${when(state.last_run_at)}.`}
        </span>
        <Btn small disabled={!!busy} onClick={() => void run('mail', 'sync')}>{busy === 'sync' ? 'Reading mail…' : 'Sync AgentMail'}</Btn>
        <Btn small primary disabled={!!busy} onClick={() => void run('advance', 'run')}>{busy === 'run' ? 'Running…' : 'Run registrations'}</Btn>
      </div>
      <div style={{ fontSize: '12.5px', color: 'var(--ink-2, #27272a)', marginTop: '6px', lineHeight: 1.45 }}>
        Reputation {state?.reputation_status ?? 'not started'}{state?.loa_status ? ` · LOA ${state.loa_status}` : ''}.
        {' '}Branded calling {state?.dir_status ?? 'not started'}.
        {state?.last_code ? <> Verification code from AgentMail: <b>{state.last_code}</b>.</> : null}
        {state?.fcr_job_status ? <> Registry form: {state.fcr_job_status}.</> : null}
      </div>
      {state?.last_error ? <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginTop: '4px' }}>{state.last_error}</div> : null}
      <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>
        Free Caller Registry has no API. CLOZR reads the verification email from the AgentMail inbox set under Company &amp; 10DLC and, when Firecrawl is configured, submits new numbers on the form. Telnyx Number Reputation, spam remediation, 10DLC line assignment and branded calling run on the carrier API once the enterprise, the LOA and the terms exist. Tick Automatic filing there to create the enterprise and the display identity from the company facts.{' '}
        <CompanyLink />
      </div>
      <NoteBox note={note} />
    </div>
  );
}

type TelnyxBalance = { balance: number; available: number; creditLimit: number; pending: number; currency: string };
const money = (n: number, cur = 'USD') => n.toLocaleString('en-US', { style: 'currency', currency: cur });
const TOPUPS = [25, 50, 100];

/**
 * The Telnyx account's balance, and a top-up from the card on file
 * (supabase/functions/telnyx-billing). Telnyx bills the 10DLC registry fees
 * up front, so a low balance stalls a filing; this is where that shows and
 * where it is fixed without leaving CLOZR.
 */
export function TelnyxFunds({ onAdded }: { onAdded?: () => void }) {
  const session = useSession();
  const wsId = session.workspace?.id ?? null;
  const [bal, setBal] = useState<TelnyxBalance | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [amount, setAmount] = useState('25');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (!supabase || wsId === null) return;
    let alive = true;
    void invokeFn<TelnyxBalance & { error?: string }>('telnyx-billing', { action: 'balance', workspace_id: wsId }).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data) { setLoadErr(error ?? 'The balance could not be read.'); return; }
      setLoadErr(null);
      setBal(data);
    });
    return () => { alive = false; };
  }, [wsId, rev]);

  if (!supabase || wsId === null) return null;

  const add = async () => {
    const n = Number(amount.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n <= 0) { setNote({ ok: false, text: 'Enter an amount in dollars.' }); return; }
    if (!window.confirm(`Charge ${money(n)} to the card on file with Telnyx and add it to the account balance?`)) return;
    setBusy(true); setNote(null);
    const { data, error } = await invokeFn<{ ok?: boolean; error?: string; charged?: string; balance?: TelnyxBalance | null; filing?: string | null }>('telnyx-billing', { action: 'add', workspace_id: wsId, amount: n });
    setBusy(false);
    if (error || !data?.ok) { setNote({ ok: false, text: error ?? data?.error ?? 'The payment did not go through.' }); return; }
    if (data.balance) setBal(data.balance);
    setNote({ ok: true, text: `Added ${money(Number(data.charged ?? n))} to Telnyx.${data.filing ? ` 10DLC: ${data.filing}` : ''}` });
    setRev((r) => r + 1);
    onAdded?.();
  };

  // Telnyx will not file a 10DLC campaign on less than this.
  const low = !!bal && bal.available < 6;
  return (
    <div style={{ paddingBottom: '10px', marginBottom: '10px', borderBottom: `1px solid ${LINE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ ...label, margin: 0 }}>Telnyx balance</span>
        {bal ? (
          <Tag c={low ? STATUS.todo : STATUS.done}>{money(bal.balance, bal.currency)}</Tag>
        ) : <Tag c={STATUS.pending}>{loadErr ? 'Unavailable' : 'Loading'}</Tag>}
        <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>
          {loadErr ? loadErr
            : !bal ? 'Reading the balance from Telnyx…'
              : low ? 'Under the $6.00 Telnyx needs before it files a 10DLC campaign. Add funds to keep the filing moving.'
                : `${money(bal.available, bal.currency)} available${bal.creditLimit ? ` (includes a ${money(bal.creditLimit, bal.currency)} credit limit)` : ''}${bal.pending ? ` · ${money(bal.pending, bal.currency)} pending` : ''}.`}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
        {TOPUPS.map((t) => (
          <Btn key={t} small disabled={busy} onClick={() => setAmount(String(t))}>{amount === String(t) ? '✓ ' : ''}${t}</Btn>
        ))}
        <input
          aria-label="Amount to add, in dollars"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ ...field, width: '90px', height: '26px' }}
        />
        <Btn small primary disabled={busy || !!loadErr} onClick={() => void add()}>{busy ? 'Charging…' : 'Add funds'}</Btn>
        <span style={{ fontSize: '11.5px', color: MUTED }}>Charges the card saved on your Telnyx account, $10–$500 at a time.</span>
      </div>
      <NoteBox note={note} />
    </div>
  );
}

/**
 * Filing the 10DLC brand and campaign (migration 76,
 * supabase/functions/ten-dlc-register). The facts live in workspace settings
 * because they are typed once; this is the button that spends them, and the
 * place a rejection says which field was wrong.
 */
export function TenDlcStatus() {
  const session = useSession();
  const wsId = session.workspace?.id ?? null;
  const ready = !!supabase && wsId !== null;
  const [reg, setReg] = useState<Registration | null | 'loading'>(ready ? 'loading' : null);
  const [busy, setBusy] = useState<'check' | 'register' | null>(null);
  const [problems, setProblems] = useState<Array<{ field: string; problem: string }>>([]);
  const [note, setNote] = useState<Note>(null);
  const [regRev, setRegRev] = useState(0);

  useEffect(() => {
    if (!supabase || wsId === null) return;
    let alive = true;
    supabase.from('ten_dlc_registrations')
      .select('status, brand_status, campaign_status, last_error, submitted_at, active_at')
      .eq('workspace_id', wsId).maybeSingle()
      .then(({ data }) => { if (alive) setReg((data as Registration | null) ?? null); });
    return () => { alive = false; };
  }, [wsId, busy, regRev]);

  if (!ready || reg === 'loading') return null;

  const run = async (action: 'check' | 'register') => {
    if (!supabase || wsId === null) return;
    setBusy(action); setNote(null); setProblems([]);
    if (action === 'register' && !window.confirm('File with The Campaign Registry now? Each brand and campaign submission carries a registry fee, and a rejected campaign cannot be edited.')) { setBusy(null); return; }
    const { data: r, error } = await invokeFn<{ ok?: boolean; error?: string; waiting?: string; message?: string; carrier?: string; problems?: Array<{ field: string; problem: string }> }>('ten-dlc-register', { action, workspace_id: wsId });
    if (r?.problems?.length) {
      setProblems(r.problems);
      setNote({ ok: false, text: `${r.problems.length} thing${r.problems.length === 1 ? '' : 's'} to fix before this can be filed — Settings → Workspace → Company & 10DLC.` });
    } else if (error) setNote({ ok: false, text: error });
    else if (r?.ok && action === 'check' && r.carrier === 'talkr') setNote({ ok: false, text: 'The facts are complete, but CLOZR has no Telnyx key (neither the TELNYX_API_KEY secret nor Vault telnyx_api_key), so Register cannot reach Telnyx.' });
    else if (r?.ok && action === 'check') setNote({ ok: true, text: 'The facts are complete. Register files the brand, then the campaign, then attaches your lines.' });
    else if (r?.waiting) setNote({ ok: true, text: r.message ?? `Waiting on the ${r.waiting}.` });
    else if (r?.ok) setNote({ ok: true, text: 'Filed. The carriers answer by webhook — you will get a notification either way.' });
    else setNote({ ok: false, text: r?.error ?? 'The filing could not run.' });
    setBusy(null);
  };

  // Telnyx refused for want of funds (functions/ten-dlc-register saves it as
  // 'funds: …'; older rows kept the raw message as 'failed'). Nothing was
  // filed and nothing is wrong with the facts, so it is not a rejection.
  const unfunded = !!reg && (reg.last_error?.startsWith('funds:') || /must have at least \$/i.test(reg.last_error ?? ''));
  const state = unfunded ? { text: 'Needs Telnyx funds', c: STATUS.pending } : reg ? REG[reg.status] : REG.draft;
  return (
    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${LINE}` }}>
      <TelnyxFunds onAdded={() => setRegRev((r) => r + 1)} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ ...label, margin: 0 }}>10DLC registration</span>
        <Tag c={state.c}>{state.text}</Tag>
        <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>
          {unfunded ? (reg.last_error?.startsWith('funds:')
            ? reg.last_error.slice('funds:'.length).trim()
            : `Telnyx needs at least $6.00 on the account to pay the registry fee. Add funds at portal.telnyx.com → Billing, then press Continue filing (or CLOZR retries at the next morning check). Your brand is ${reg.brand_status ?? 'filed'}.`)
          : !reg || reg.status === 'draft' ? 'Nothing filed yet — texts from these lines are filtered.'
            : reg.status === 'active' ? `Registered ${when(reg.active_at)}.`
              : reg.status === 'failed' ? (reg.last_error ?? 'The carriers refused the filing.')
                : `Brand ${reg.brand_status ?? 'pending'}${reg.campaign_status ? ` · campaign ${reg.campaign_status}` : ''}.`}
        </span>
        <Btn small disabled={!!busy} onClick={() => void run('check')}>{busy === 'check' ? 'Checking…' : 'Check facts'}</Btn>
        {reg?.status !== 'active' ? (
          <Btn small primary disabled={!!busy} onClick={() => void run('register')}>{busy === 'register' ? 'Filing…' : reg?.submitted_at ? 'Continue filing' : 'Register'}</Btn>
        ) : null}
      </div>
      {problems.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', lineHeight: 1.5 }}>
          {problems.map((p, i) => <li key={`${p.field}-${i}`}><b style={{ fontWeight: 600 }}>{p.field}</b> — {p.problem}</li>)}
        </ul>
      ) : null}
      <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>
        Brand, then campaign, then your numbers — CLOZR makes all three carrier calls and takes the answers by webhook. The facts it files (legal name, EIN, the opt-in story, the sample messages) come from Company &amp; 10DLC; a rejection names the field that was wrong. Each submission carries a registry fee and a rejected campaign cannot be edited, so Check facts first.{' '}
        <CompanyLink />
      </div>
      <NoteBox note={note} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per line
// ---------------------------------------------------------------------------

/** The line's badge; opens its panel. Renders nothing until the summary has the line. */
export function ReputationBadge({ numberId }: { numberId: string }) {
  const s = useReputation();
  const r = s.summary?.numbers.find((n) => n.id === numberId);
  if (!r) return null;
  const g = GRADE[r.grade];
  return (
    <button
      type="button"
      onClick={() => toggleReputationPanel(numberId)}
      title={r.warnings.map((w) => w.message).join('\n') || 'No warnings'}
      style={{ border: 0, cursor: 'pointer', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', padding: '2px 7px', borderRadius: '999px', background: g.bg, color: g.fg, fontFamily: 'inherit' }}
    >
      Reputation: {g.text}{r.paused ? ' · paused' : ''}
    </button>
  );
}

/** The open line's signals and controls; nothing when another line (or none) is open. */
export function ReputationPanel({ numberId }: { numberId: string }) {
  const s = useReputation();
  const r = s.summary?.numbers.find((n) => n.id === numberId);
  if (s.open !== numberId || !r) return null;
  // Keyed on the saved values so the drafts reset after a save or a refresh.
  return <PanelBody key={`${r.checked_at}|${r.cnam?.name}|${r.cnam?.enabled}|${JSON.stringify(r.protection)}`} r={r} />;
}

function PanelBody({ r }: { r: NumberReputationDto }) {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState(r.cnam?.name ?? '');
  const [cnamOn, setCnamOn] = useState(r.cnam?.enabled ?? true);
  const [callCap, setCallCap] = useState(r.protection.daily_call_cap?.toString() ?? '');
  const [smsCap, setSmsCap] = useState(r.protection.daily_sms_cap?.toString() ?? '');
  const [pause, setPause] = useState(r.protection.pause_on_warning);

  const run = async (key: string, fn: () => Promise<{ reputation: NumberReputationDto }>, ok: string) => {
    setBusy(key); setNote(null);
    try {
      putNumberReputation((await fn()).reputation);
      setNote({ ok: true, text: ok });
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  };
  const cap = (v: string) => (v.trim() === '' ? null : Math.max(1, Math.floor(Number(v))));
  const nameOk = /^[A-Za-z0-9 ]{1,15}$/.test(name.trim());
  const m = r.metrics;
  const att = r.attestation.observed_30d;
  const codes = Object.entries(m.sms_error_codes);

  return (
    <div style={{ margin: '0 12px 12px', padding: '12px', border: `1px dashed ${LINE}`, borderRadius: '10px', background: 'var(--surface, #fff)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <span style={{ ...label, margin: 0, flex: 1 }}>Reputation · {formatPhone(r.phone_e164)}</span>
        <span style={{ fontSize: '11.5px', color: MUTED }}>Carrier checked {when(r.checked_at)}</span>
        <Btn small disabled={Boolean(busy)} onClick={() => void run('refresh', () => api.numberReputation(r.id, true), 'Re-read from the carrier.')}>{busy === 'refresh' ? 'Checking…' : 'Refresh line'}</Btn>
      </div>
      {r.check_error ? <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginBottom: '8px' }}>Last carrier check failed: {r.check_error}</div> : null}
      {r.paused ? <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginBottom: '8px' }}>Outbound calls from this line are paused until the warning clears.</div> : null}

      {r.warnings.length ? (
        <ul style={{ margin: '0 0 10px', padding: 0, listStyle: 'none', display: 'grid', gap: '5px' }}>
          {r.warnings.map((w) => (
            <li key={w.code} style={{ fontSize: '12.5px', lineHeight: 1.45, display: 'flex', gap: '8px', alignItems: 'baseline' }}>
              <Tag c={GRADE[w.level]}>{GRADE[w.level].text}</Tag><span>{w.message}</span>
            </li>
          ))}
        </ul>
      ) : <div style={{ fontSize: '12.5px', color: 'var(--tx-mint, #0a8560)', marginBottom: '10px' }}>No warnings on this line.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px', marginBottom: '12px' }}>
        <Signal title="STIR/SHAKEN">
          Expected <b>{r.attestation.expected ?? '—'}</b> (you own this number on the carrier).{' '}
          {att.total ? <>Reported on {att.total} calls in 30 days: A {att.A} · B {att.B} · C {att.C}.</> : <>The carrier doesn&rsquo;t report attestation on outbound call events.</>}
        </Signal>
        <Signal title="Caller name (CNAM)">
          {r.cnam ? (r.cnam.enabled ? <>Listed as <b>{r.cnam.name}</b>.</> : <>Not listed{r.cnam.name ? ` (saved: ${r.cnam.name})` : ''}.</>) : r.carrier_connected ? 'Not checked yet.' : 'Needs the Telnyx carrier.'}
        </Signal>
        <Signal title="Spam check">
          {r.spam?.status === 'ok'
            ? <>Risk <b>{r.spam.spam_risk ?? 'not rated yet'}</b>{r.spam.spam_category ? ` · ${r.spam.spam_category}` : ''}. Checked by Telnyx {when(r.spam.last_refreshed_at)}.</>
            : r.spam?.status === 'not_enrolled' ? 'Not enrolled in Telnyx Number Reputation yet. The morning registry job enrolls it once that product is approved, and files it on Free Caller Registry.'
            : 'Not checked.'}
        </Signal>
        <Signal title="10DLC (texting)">
          {r.ten_dlc.assigned === null ? 'Registration not read yet.'
            : r.ten_dlc.assigned ? <>On approved campaign {r.ten_dlc.campaign?.usecase ?? r.ten_dlc.campaign?.id}{r.ten_dlc.brand ? ` (${r.ten_dlc.brand.name})` : ''}.</>
            : r.ten_dlc.campaign ? <>Assigned to a campaign that is {r.ten_dlc.campaign.campaign_status ?? 'not approved'}{r.ten_dlc.assignment_status && r.ten_dlc.assignment_status !== 'ASSIGNED' ? ` (${r.ten_dlc.assignment_status})` : ''}.</>
            : 'Not on any campaign. US carriers filter or block its texts.'}
        </Signal>
        <Signal title="Calls">
          {m.calls_today} today · {m.calls_7d} in 7 days. Answer rate {pct(m.answer_rate_7d)} (prior week {pct(m.answer_rate_prior_7d)}). Avg talk {m.avg_talk_seconds_7d ?? '—'}s · under 10s {pct(m.short_call_rate_7d)}.
        </Signal>
        <Signal title="Texts">
          {m.sms_sent_7d} sent in 7 days · {pct(m.sms_failure_rate_7d)} failed.{codes.length ? <> Carrier errors: {codes.map(([c, k]) => `${c}×${k}`).join(', ')}.</> : null}
        </Signal>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
        <div>
          <span style={label}>Outbound caller name</span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={name} maxLength={15} onChange={(e) => setName(e.target.value)} placeholder="ACME HOMES" disabled={!r.carrier_connected} style={{ ...field, width: '150px' }} />
            <label style={{ fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input type="checkbox" checked={cnamOn} disabled={!r.carrier_connected} onChange={(e) => setCnamOn(e.target.checked)} /> Listed
            </label>
            <Btn small primary disabled={!r.carrier_connected || Boolean(busy) || (cnamOn && !nameOk)} onClick={() => void run('cnam', () => api.updateNumberReputation(r.id, { cnam: { enabled: cnamOn, name: name.trim() || null } }), cnamOn ? 'Caller name sent to the carrier. It can take a few days to show on phones.' : 'Caller name listing turned off.')}>
              {busy === 'cnam' ? 'Saving…' : 'Save name'}
            </Btn>
          </div>
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>Up to 15 letters, digits and spaces.</div>
        </div>
        <div>
          <span style={label}>Daily limits for this line</span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={callCap} inputMode="numeric" onChange={(e) => setCallCap(e.target.value.replace(/\D/g, ''))} placeholder="Calls (100 suggested)" style={{ ...field, width: '140px' }} />
            <input value={smsCap} inputMode="numeric" onChange={(e) => setSmsCap(e.target.value.replace(/\D/g, ''))} placeholder="Texts (no cap)" style={{ ...field, width: '110px' }} />
          </div>
          <label style={{ fontSize: '12px', display: 'flex', gap: '5px', alignItems: 'center', marginTop: '6px' }}>
            <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} /> Pause outbound calls while this line shows a possible spam label
          </label>
          <div style={{ marginTop: '6px' }}>
            <Btn small primary disabled={Boolean(busy)} onClick={() => void run('caps', () => api.updateNumberReputation(r.id, { protection: { daily_call_cap: cap(callCap), daily_sms_cap: cap(smsCap), pause_on_warning: pause } }), 'Limits saved. Talkr refuses calls and texts past them for the rest of the day.')}>
              {busy === 'caps' ? 'Saving…' : 'Save limits'}
            </Btn>
          </div>
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>Blank means no cap. Days follow the workspace time zone.</div>
        </div>
      </div>
      <NoteBox note={note} />
    </div>
  );
}

function Signal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '8px', padding: '8px 10px', background: 'var(--canvas, #fafafa)' }}>
      <div style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '3px' }}>{title}</div>
      <div style={{ fontSize: '12.5px', color: INK, lineHeight: 1.45 }}>{children}</div>
    </div>
  );
}
