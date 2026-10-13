// Deal Machine — the scraper as a CLOZR program.
//
// Modelled on the extension's popup (Deal Machine · Log · Buyers Lists ·
// Results · Masterlist · Settings). Facebook groups and the deal-post
// commenter live on Buyr. Rebuilt at desktop size in
// CLOZR's own chrome. The extension is the runtime; this is the program. A rep
// presses RUN here, the extension in the office Chrome picks the command up on
// its next sync, and everything it does comes back through the same channel:
// the step it is on, the counts, the log, the buyers lists it opted into, and
// the deals, which land as real records through /ingest.
//
// Honest states, not optimistic ones. RUN shows as "queued" until a device acks
// it, "running" while the device reports it, and a device that has not synced
// in five minutes is shown as off — so the screen never claims a scrape is
// happening on a laptop that is closed.
//
// With Settings → Cloud on, the deal job runs in CLOZR instead (migration 187,
// deal-machine-cloud): RUN / PAUSE / RESUME / STOP go to the `clozr-cloud`
// device, which needs no Chrome, and this screen follows it the same way.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { useSession } from '@/lib/session';
import { isAdmin, type Role } from '@/lib/team';
import { ingestUrl, issueKey, setKeySetting, type MintedKey } from '@/lib/ingest';
import {
  CLOUD_COMMANDS, CLOUD_DEVICE_ID, COMMAND_LABELS, DEAL_MACHINE_SOURCE, DEFAULT_STATES, KIND_LABELS, type DealMachineState, type DmCommand, type DmLogLine,
  type DmSettings, type LandPolicy, cancelCommand, duration, loadDealMachine, loadLog, maoOf, money, saveApifyToken, saveSettings, sendCommand, since,
  subscribeDealMachine,
} from '@/lib/deal-machine';
import { DEAL_MACHINE, DEAL_MACHINE_TINT } from '@/app/clozr/brand';
import { Mark } from '@/components/ds/mark';
import { parseDollars } from '@/lib/money';

// ---- chrome ------------------------------------------------------------------

const TABS = ['Overview', 'Log', 'Buyers lists', 'Results', 'Masterlist', 'Settings'] as const;
type Tab = (typeof TABS)[number];

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '14px', padding: '16px 18px', marginBottom: '12px' };
const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: '#18181b' };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.45 };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: '#71717a', fontWeight: 600, marginBottom: '6px' };
const code: React.CSSProperties = { fontSize: '11.5px', background: '#f4f4f5', padding: '2px 6px', borderRadius: '4px', wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' };
const input: React.CSSProperties = { height: '34px', padding: '0 10px', borderRadius: '9px', border: '1px solid #d4d4d8', background: '#fff', fontSize: '13px', color: '#18181b', width: '100%', outline: 'none' };
const textarea: React.CSSProperties = { ...input, height: 'auto', minHeight: '72px', padding: '8px 10px', fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.4 };
const muted: React.CSSProperties = { fontSize: '12.5px', color: '#71717a' };
const thStyle: React.CSSProperties = { textAlign: 'left', fontSize: '11.5px', color: '#71717a', fontWeight: 600, padding: '8px 10px', background: 'var(--c-thead)', borderBottom: '1px solid var(--c-thead-line)', whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: '9px 10px', fontSize: '12.5px', borderBottom: '1px solid #f0f0f1', color: '#18181b', verticalAlign: 'middle' };

type BtnKind = 'primary' | 'machine' | 'ghost' | 'danger' | 'dark';
function Btn({ kind = 'ghost', small, disabled, onClick, children, title, style }: {
  kind?: BtnKind; small?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode; title?: string; style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    height: small ? '28px' : '34px', padding: small ? '0 10px' : '0 14px', borderRadius: '9px', fontSize: small ? '12px' : '12.5px', fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', whiteSpace: 'nowrap',
    border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', color: '#18181b', transition: 'background .12s, border-color .12s',
  };
  const kinds: Record<BtnKind, [string, React.CSSProperties]> = {
    ghost: ['dc2', {}],
    primary: ['dc10', { background: 'var(--c-primary)', borderColor: 'var(--c-primary)', color: '#fff' }],
    machine: ['clozr-dm-btn', { background: DEAL_MACHINE, borderColor: DEAL_MACHINE, color: '#fff' }],
    danger: ['dc36', { background: '#dc2626', borderColor: '#dc2626', color: '#fff' }],
    dark: ['dc6', { background: '#fff', borderColor: '#d4d4d8', color: '#18181b' }],
  };
  const [cls, extra] = kinds[kind];
  return (
    <button type="button" className={cls} disabled={disabled} onClick={onClick} title={title} style={{ ...base, ...extra, ...style }}>
      {children}
    </button>
  );
}

function Toggle({ on, onChange, disabled, children, warn }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode; warn?: boolean }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 0', borderTop: '1px solid #f0f0f1', cursor: disabled ? 'default' : 'pointer' }}>
      <span
        role="switch" aria-checked={on}
        onClick={(e) => { e.preventDefault(); if (!disabled) onChange(!on); }}
        style={{ flex: 'none', marginTop: '1px', width: '34px', height: '20px', borderRadius: '999px', background: on ? (warn ? '#d97706' : 'var(--c-primary)') : '#d4d4d8', position: 'relative', transition: 'background .15s', opacity: disabled ? 0.6 : 1 }}
      >
        <span style={{ position: 'absolute', top: '2px', left: on ? '16px' : '2px', width: '16px', height: '16px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)', transition: 'left .15s' }} />
      </span>
      <span style={{ fontSize: '13px', color: '#18181b', lineHeight: 1.4 }}>{children}</span>
    </label>
  );
}

function Stat({ n, k, color }: { n: number | string; k: string; color?: string }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: '90px', padding: '12px 14px', borderRadius: '12px', background: '#fafafa', border: '1px solid #f0f0f1' }}>
      <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.03em', color: color ?? '#18181b', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
      <div style={{ ...label, marginBottom: 0, marginTop: '6px' }}>{k}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'zinc' | 'orange' | 'blue'; children: React.ReactNode }) {
  const c = { green: ['#dcfce7', '#15803d'], amber: ['#fef3c7', '#b45309'], red: ['#fee2e2', '#b91c1c'], zinc: ['#f4f4f5', '#52525b'], orange: [DEAL_MACHINE_TINT, '#c2410c'], blue: ['#eef2ff', '#3730a3'] }[tone];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 9px', borderRadius: '999px', background: c[0], color: c[1], fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>;
}

function Dot({ color }: { color: string }) {
  return <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' }} />;
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: '22px 14px', textAlign: 'center', color: '#71717a', fontSize: '12.5px', background: '#fafafa', borderRadius: '10px', border: '1px dashed #e4e4e7' }}>{children}</div>
);

// ---- the screen ----------------------------------------------------------------

export function DealMachine({ V }: { V: ClozrView }) {
  const sess = useSession();
  const workspaceId = sess.workspace?.id ?? null;
  const role = (sess.workspace?.role as Role | undefined) ?? null;
  const admin = isAdmin(role) && !sess.demo;
  const canOperate = !sess.demo && (role === null || ['owner', 'admin', 'acquisitions', 'dispositions'].includes(role));

  const [tab, setTab] = useState<Tab>('Overview');
  const [state, setState] = useState<DealMachineState | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void loadDealMachine(sess.demo ? null : workspaceId).then((r) => { if (live) setState(sess.demo ? { ...r, offline: true } : r); });
    return () => { live = false; };
  }, [workspaceId, sess.demo, reloads]);

  // Realtime for the rows that change while a run is on, plus a slow poll so a
  // device going quiet (no row changes at all) still turns the light off.
  useEffect(() => {
    if (!workspaceId || sess.demo) return;
    const off = subscribeDealMachine(workspaceId, reload);
    const t = setInterval(reload, 30_000);
    return () => { off(); clearInterval(t); };
  }, [workspaceId, sess.demo, reload]);

  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);

  // Cloud on: the cloud is the runtime this screen drives. Off: the freshest extension.
  const cloudOn = !!state?.settings.cloud.enabled;
  const extensions = state?.devices.filter((d) => d.deviceId !== CLOUD_DEVICE_ID) ?? [];
  const device = cloudOn ? state?.devices.find((d) => d.deviceId === CLOUD_DEVICE_ID) ?? null : extensions.find((d) => d.online) ?? extensions[0] ?? null;
  const online = !!device?.online;
  const activeRun = state?.runs.find((r) => ['running', 'paused', 'stopping'].includes(r.status)) ?? null;
  const running = online && (device?.isRunning || !!activeRun);
  const runState = !online ? 'offline' : device?.runState === 'paused' ? 'paused' : device?.runState === 'stopping' ? 'stopping' : running ? 'running' : 'idle';
  const pendingCmds = state?.commands ?? [];

  const cmd = useCallback(async (command: DmCommand['command'], args: Record<string, unknown> = {}) => {
    if (!workspaceId) return;
    setBusy(true);
    const toCloud = cloudOn && CLOUD_COMMANDS.has(command);
    const r = await sendCommand(workspaceId, command, args, toCloud ? CLOUD_DEVICE_ID : null);
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.message ?? 'Could not queue that.' }); return; }
    setNote({
      ok: true,
      text: toCloud ? `${COMMAND_LABELS[command]} sent to CLOZR Cloud — it starts within seconds, no Chrome needed.`
        : online ? `${COMMAND_LABELS[command]} queued — the extension picks it up within a minute.`
          : `${COMMAND_LABELS[command]} queued. No extension is online right now; it runs when one checks in (within the hour).`,
    });
    reload();
  }, [workspaceId, online, cloudOn, reload]);

  const headStatus = (() => {
    if (!state) return null;
    if (state.offline) return <Pill tone="zinc">Sample</Pill>;
    if (!state.key) return <Pill tone="amber"><Dot color="#d97706" />No key</Pill>;
    if (cloudOn && state.apifyConnected === false) return <Pill tone="amber"><Dot color="#d97706" />Cloud · no Apify token</Pill>;
    if (cloudOn && !online) return <Pill tone="zinc"><Dot color="#a1a1aa" />Cloud · checking in</Pill>;
    if (!online) return <Pill tone="zinc"><Dot color="#a1a1aa" />Extension off · seen {since(device?.lastSeenAt)}</Pill>;
    if (runState === 'paused') return <Pill tone="amber"><Dot color="#d97706" />Paused</Pill>;
    if (runState === 'stopping') return <Pill tone="amber"><Dot color="#d97706" />Stopping</Pill>;
    if (runState === 'running') return <Pill tone="green"><Dot color="#16a34a" />Running</Pill>;
    return <Pill tone="green"><Dot color="#16a34a" />Online · idle</Pill>;
  })();

  return (
    <section data-screen-label="Deal Machine" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <style>{`.clozr-dm-btn:hover{background:#c2410c !important;border-color:#c2410c !important}.clozr-dm-tab:hover{color:#18181b !important}.clozr-dm-row:hover{background:#fafafa}`}</style>
      <div style={{ background: '#fff', borderBottom: '1px solid #e4e4e7', padding: V.isMobile ? '10px 12px 0' : '12px 20px 0' }}>
        <div data-head style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', rowGap: '8px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: DEAL_MACHINE, flex: 'none' }} />
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Deal Machine</h1>
          <span style={{ fontSize: '12px', color: '#71717a' }}>{cloudOn ? 'Running in CLOZR · InvestorLift · Facebook groups' : 'InvestorLift · Facebook groups · RealEstateBees · buyers lists'}</span>
          <div style={{ flex: 1 }} />
          {headStatus}
          {device ? <span style={{ fontSize: '11.5px', color: '#71717a' }}>{device.label ?? device.deviceId.slice(0, 8)}{device.version ? ` · v${device.version}` : ''}</span> : null}
        </div>
        <div data-tabs style={{ display: 'flex', gap: '2px', marginTop: '10px', overflow: 'auto' }}>
          {TABS.map((t) => {
            const on = t === tab;
            const badge = t === 'Log' && activeRun ? '●' : t === 'Buyers lists' && state ? state.totals.optedIn : t === 'Results' && state ? state.totals.deals : null;
            return (
              <button key={t} type="button" className="clozr-dm-tab" onClick={() => setTab(t)} style={{ height: '36px', padding: '0 11px', border: 0, borderBottom: `2px solid ${on ? DEAL_MACHINE : 'transparent'}`, background: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 500, color: on ? '#18181b' : '#71717a', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {t}
                {badge !== null && badge !== 0 ? <span style={{ fontSize: '10.5px', fontWeight: 700, color: on ? DEAL_MACHINE : '#a1a1aa', ...(badge === '●' ? { color: '#16a34a' } : {}) }}>{badge}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: V.isMobile ? '12px 12px 40px' : '16px 20px 40px' }}>
        <div style={{ maxWidth: tab === 'Log' || tab === 'Results' ? '1100px' : '860px' }}>
          {note ? (
            <div role="status" style={{ ...card, padding: '11px 13px', background: note.ok ? '#dcfce7' : '#fee2e2', borderColor: note.ok ? '#bbf7d0' : '#fecaca', color: note.ok ? '#15803d' : '#b91c1c', fontSize: '12.5px' }}>{note.text}</div>
          ) : null}

          {!state ? <p style={muted}>Reading…</p> : state.offline ? (
            <div style={card}>
              <h2 style={h2}>Sample workspace</h2>
              <p style={{ ...sub, marginBottom: 0 }}>Deal Machine runs against a real workspace. Sign in and issue the extension its key from Settings here to see it live.</p>
            </div>
          ) : (
            <>
              {!state.key && tab !== 'Settings' ? (
                <div style={{ ...card, background: DEAL_MACHINE_TINT, borderColor: `${DEAL_MACHINE}44` }}>
                  <h2 style={h2}>Not connected yet</h2>
                  <p style={{ ...sub, marginBottom: '10px' }}>Deal Machine needs its key before anything it finds can land here, in the cloud or from the extension. {admin ? 'Issue it under Settings → Integrations; for the extension, paste it in once and this screen takes over from the popup.' : 'An owner or admin issues it under Settings → Integrations.'}</p>
                  <Btn kind="machine" small onClick={() => setTab('Settings')}>Open Settings</Btn>
                </div>
              ) : null}

              {tab === 'Overview' ? <Overview V={V} state={state} cloudOn={cloudOn} device={device} online={online} runState={runState} activeRun={activeRun} pending={pendingCmds} canOperate={canOperate} busy={busy} cmd={cmd} onCancel={async (id) => { await cancelCommand(id); reload(); }} onDryRun={async (v) => { if (!workspaceId) return; await saveSettings(workspaceId, { ...state.settings, dryRun: v }); reload(); }} /> : null}
              {tab === 'Log' ? <LogTab workspaceId={workspaceId} runs={state.runs} activeRun={activeRun} toast={V.showToast} /> : null}
              {tab === 'Buyers lists' ? <BuyersLists state={state} canOperate={canOperate} busy={busy} cmd={cmd} /> : null}
              {tab === 'Results' ? <Results V={V} state={state} /> : null}
              {tab === 'Masterlist' ? <Masterlist V={V} state={state} setTab={setTab} /> : null}
              {tab === 'Settings' ? <SettingsTab V={V} state={state} workspaceId={workspaceId} admin={admin} canOperate={canOperate} reload={reload} setNote={setNote} /> : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- Overview ---------------------------------------------------------------------

function Overview({ V, state, cloudOn, device, online, runState, activeRun, pending, canOperate, busy, cmd, onCancel, onDryRun }: {
  V: ClozrView; state: DealMachineState; cloudOn: boolean; device: DealMachineState['devices'][number] | null; online: boolean; runState: string;
  activeRun: DealMachineState['runs'][number] | null; pending: DmCommand[]; canOperate: boolean; busy: boolean;
  cmd: (c: DmCommand['command'], args?: Record<string, unknown>) => Promise<void>; onCancel: (id: number) => Promise<void>; onDryRun: (v: boolean) => Promise<void>;
}) {
  const queued = (c: string) => pending.some((p) => p.command === c);
  const lastDone = state.runs.find((r) => !['running', 'paused', 'stopping'].includes(r.status)) ?? null;
  const shown = activeRun ?? lastDone;
  const counts = shown?.counts ?? {};
  const progress = device?.progress && activeRun ? device.progress : null;
  const pct = progress?.step && progress?.total ? Math.round((progress.step / progress.total) * 100) : activeRun ? 8 : 0;
  const diag = (shown?.diag ?? null) as Record<string, Record<string, number> | number> | null;
  const disabled = !canOperate || busy || !state.key;
  // The cloud cannot start without its Apify token; the extension jobs below do not need it.
  const runDisabled = disabled || (cloudOn && state.apifyConnected === false);
  const isRunning = runState === 'running' || runState === 'paused' || runState === 'stopping';

  return (
    <>
      <div style={{ ...card, padding: '18px 20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          <Btn kind="machine" disabled={runDisabled || isRunning || queued('run')} onClick={() => cmd('run')} style={{ height: '44px', padding: '0 22px', fontSize: '14px', letterSpacing: '.04em', boxShadow: '0 4px 14px rgba(234,88,12,.28)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            {queued('run') ? 'QUEUED' : isRunning ? 'RUNNING' : 'RUN DEAL MACHINE'}
          </Btn>
          <Btn disabled={disabled || runState !== 'running' || queued('pause')} onClick={() => cmd('pause')}>⏸ Pause</Btn>
          <Btn disabled={disabled || runState !== 'paused' || queued('resume')} onClick={() => cmd('resume')}>▶ Resume</Btn>
          <Btn kind="dark" disabled={disabled || !isRunning || queued('stop')} onClick={() => cmd('stop')}>⏹ Stop</Btn>
          <div style={{ flex: 1 }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: '#18181b', cursor: canOperate ? 'pointer' : 'default' }}>
            <input type="checkbox" checked={state.settings.dryRun} disabled={!canOperate} onChange={(e) => void onDryRun(e.target.checked)} style={{ width: '15px', height: '15px', accentColor: DEAL_MACHINE }} />
            Dry run <span style={muted}>(log only, submit nothing)</span>
          </label>
        </div>
        <div style={{ marginTop: '14px', height: '6px', borderRadius: '999px', background: '#f4f4f5', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, borderRadius: '999px', background: runState === 'paused' ? '#d97706' : DEAL_MACHINE, transition: 'width .5s cubic-bezier(.4,0,.2,1)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginTop: '8px', fontSize: '12px', color: '#71717a', flexWrap: 'wrap' }}>
          <span>
            {!state.key ? 'Issue the key under Settings → Integrations to enable the controls.'
              : cloudOn && state.apifyConnected === false ? 'Cloud is on but has no Apify token. An owner or admin pastes it under Settings → Cloud.'
              : cloudOn && !online ? 'CLOZR Cloud checks in every two minutes; RUN starts it at once.'
              : !online ? `Extension is off — commands queue and run when it checks in. ${device ? `Last seen ${since(device.lastSeenAt)}.` : 'No extension has connected yet.'}`
              : activeRun ? (device?.step ?? activeRun.step ?? `${KIND_LABELS[activeRun.kind] ?? activeRun.kind} running…`)
              : `Idle · ${KIND_LABELS[lastDone?.kind ?? ''] ?? 'last run'} ${lastDone ? since(lastDone.endedAt ?? lastDone.startedAt) : 'never'}`}
          </span>
          <span style={{ fontWeight: 700, fontSize: '11.5px', color: runState === 'running' ? '#15803d' : runState === 'paused' || runState === 'stopping' ? '#b45309' : '#a1a1aa' }}>{runState}</span>
        </div>
        {pending.length ? (
          <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #f0f0f1', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {pending.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12.5px' }}>
                <Pill tone={p.status === 'acked' ? 'green' : 'amber'}>{p.status === 'acked' ? 'picked up' : 'queued'}</Pill>
                <span style={{ fontWeight: 600 }}>{COMMAND_LABELS[p.command] ?? p.command}</span>
                <span style={muted}>{since(p.createdAt)}</span>
                <div style={{ flex: 1 }} />
                {p.status === 'pending' && canOperate ? <Btn small onClick={() => void onCancel(p.id)}>Cancel</Btn> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
          <h2 style={{ ...h2, margin: 0 }}>{activeRun ? 'Current run' : 'Last run'}</h2>
          {shown ? <span style={muted}>{KIND_LABELS[shown.kind] ?? shown.kind} · {shown.trigger} · started {since(shown.startedAt)} · {duration(shown.startedAt, shown.endedAt)}{shown.dryRun ? ' · dry run' : ''}</span> : <span style={muted}>Nothing has run yet.</span>}
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Stat n={counts.scraped ?? 0} k="Scraped" color="#2d5bff" />
          <Stat n={counts.valid ?? 0} k="Valid" />
          <Stat n={counts.qualified ?? 0} k="Qualified" color="#15803d" />
          <Stat n={counts.clozr ?? counts.submitted ?? 0} k="To CLOZR" color={DEAL_MACHINE} />
          <Stat n={counts.optedIn ?? 0} k="Opted in" color="#0A8560" />
        </div>
        {shown?.error ? <p style={{ ...muted, color: '#b91c1c', marginTop: '10px', marginBottom: 0 }}>{shown.error}</p> : null}
        {diag ? (
          <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #f0f0f1', fontSize: '12.5px', color: '#52525b', display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : '1fr 1fr', gap: '4px 18px' }}>
            {(['investorlift', 'facebook', 'reb', 'email'] as const).map((k) => {
              const d = diag[k] as Record<string, number> | undefined;
              if (!d) return null;
              const name = { investorlift: 'InvestorLift', facebook: 'Facebook', reb: 'RealEstateBees', email: 'Email' }[k];
              const errs = Array.isArray((d as unknown as { errors?: unknown[] }).errors) ? (d as unknown as { errors: unknown[] }).errors.length : Number(d.errors ?? 0);
              return <span key={k}><strong style={{ color: '#18181b' }}>{name}</strong> · valid {d.valid ?? 0} · scraped {d.scraped ?? 0}{errs ? <span style={{ color: '#b91c1c' }}> · {errs} error{errs === 1 ? '' : 's'}</span> : ''}</span>;
            })}
            <span>Address {Number(diag.withAddress ?? 0)} · ARV {Number(diag.withArv ?? 0)} · Asking {Number(diag.withAskingPrice ?? 0)}</span>
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={h2}>More jobs</h2>
        <p style={sub}>{cloudOn ? 'Scrape only runs in the cloud like RUN. The buyers-list bot, InvestorLift ETL and Blitz still need the Chrome extension (they fill forms in a logged-in browser) and queue for it.' : 'Each one is the same pipeline with parts left out. They queue like RUN and never overlap: the extension refuses a second job while one is on.'}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <Btn disabled={runDisabled || isRunning || queued('scrape')} onClick={() => cmd('scrape')}>Scrape only</Btn>
          <Btn disabled={disabled || isRunning || queued('buyers_list')} onClick={() => cmd('buyers_list')} style={{ borderColor: '#A7DCC5', color: '#08694C', background: '#F0FAF5' }}>Buyers list only</Btn>
          <Btn disabled={disabled || isRunning || queued('il_etl')} onClick={() => cmd('il_etl')}>InvestorLift ETL</Btn>
          <Btn disabled={disabled || isRunning || queued('blitz')} onClick={() => cmd('blitz')} title="Opt into every market's buyers lists now, ignoring the daily pacing" style={{ borderColor: '#fecaca', color: '#b91c1c', background: '#fef2f2' }}>Blitz: all markets</Btn>
          <div style={{ flex: 1 }} />
          <Btn kind="danger" small disabled={!canOperate || busy || !state.key || queued('force_reset')} onClick={() => cmd('force_reset')} title="Clears a run the extension thinks is still going after Chrome crashed">Force reset stuck run</Btn>
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Recent runs</h2>
        <p style={sub}>What the cloud and the extension reported, newest first. Open the Log tab for the line-by-line.</p>
        {state.runs.length === 0 ? <Empty>No runs yet. Press RUN, or switch on scheduled runs under Settings → General.</Empty> : (
          <div style={{ overflowX: 'auto', border: '1px solid #e4e4e7', borderRadius: '10px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Started', 'Job', 'Trigger', 'Status', 'Scraped', 'Valid', 'Qualified', 'To CLOZR', 'Took'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {state.runs.slice(0, 12).map((r) => (
                  <tr key={r.id} className="clozr-dm-row">
                    <td style={tdStyle}>{new Date(r.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td style={tdStyle}>{KIND_LABELS[r.kind] ?? r.kind}{r.deviceId === CLOUD_DEVICE_ID ? <span style={{ ...muted, marginLeft: '6px' }}>cloud</span> : null}{r.dryRun ? <span style={{ ...muted, marginLeft: '6px' }}>dry</span> : null}</td>
                    <td style={tdStyle}>{r.trigger}</td>
                    <td style={tdStyle}><Pill tone={r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'running' ? 'blue' : r.status === 'stopped' ? 'zinc' : 'amber'}>{r.status}</Pill></td>
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{r.counts.scraped ?? '—'}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{r.counts.valid ?? '—'}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{r.counts.qualified ?? '—'}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{r.counts.clozr ?? r.counts.submitted ?? '—'}</td>
                    <td style={tdStyle}>{duration(r.startedAt, r.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {state.devices.length ? (
        <div style={card}>
          <h2 style={h2}>Runtimes</h2>
          <p style={sub}>CLOZR Cloud and every Chrome that has checked in with this workspace’s key. One at a time runs a job; the others stay in reserve.</p>
          {state.devices.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderTop: '1px solid #f0f0f1', fontSize: '12.5px' }}>
              <Dot color={d.online ? '#16a34a' : '#a1a1aa'} />
              <span style={{ fontWeight: 600 }}>{d.label ?? d.deviceId.slice(0, 12)}</span>
              <span style={muted}>{d.version ? `v${d.version} · ` : ''}{d.online ? (d.isRunning ? d.step ?? 'running' : 'idle') : `last seen ${since(d.lastSeenAt)}`}</span>
              <div style={{ flex: 1 }} />
              {d.settingsVersion !== null && d.settingsVersion < state.settingsVersion ? <Pill tone="amber">settings pending</Pill> : d.online ? <Pill tone="green">in sync</Pill> : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

// ---- Log ------------------------------------------------------------------------

const LEVEL_ORDER = { error: 3, warn: 2, info: 1, debug: 0 } as const;
const LEVEL_COLOR = { error: '#b91c1c', warn: '#b45309', info: '#18181b', debug: '#71717a' } as const;

function LogTab({ workspaceId, runs, activeRun, toast }: { workspaceId: number | null; runs: DealMachineState['runs']; activeRun: DealMachineState['runs'][number] | null; toast: (m: string) => void }) {
  const [lines, setLines] = useState<DmLogLine[]>([]);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<keyof typeof LEVEL_ORDER>('info');
  const [runId, setRunId] = useState<number | 'all'>('all');
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  // Switching runs restarts the tail from that run's first line.
  const pickRun = (v: number | 'all') => { setLines([]); lastId.current = 0; setRunId(v); };

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const pull = async () => {
      const fresh = await loadLog(workspaceId, { sinceId: lastId.current || undefined, runId: runId === 'all' ? null : runId, limit: lastId.current ? 300 : 500 });
      if (!live || !fresh.length) return;
      lastId.current = fresh[fresh.length - 1].id;
      setLines((prev) => [...prev, ...fresh].slice(-2000));
    };
    void pull();
    const t = setInterval(pull, activeRun ? 3000 : 10_000);
    return () => { live = false; clearInterval(t); };
  }, [workspaceId, runId, activeRun]);

  useEffect(() => { if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [lines, follow]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return lines.filter((l) => LEVEL_ORDER[l.level] >= LEVEL_ORDER[level] && (!q || l.msg.toLowerCase().includes(q) || (l.tag ?? '').toLowerCase().includes(q)));
  }, [lines, filter, level]);

  const text = () => shown.map((l) => `${l.ts.slice(11, 23)} ${l.level.toUpperCase().padEnd(5)} [${l.tag ?? 'bg'}] ${l.msg}`).join('\n');
  const download = () => {
    const blob = new Blob([text()], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `deal-machine-log-${new Date().toISOString().slice(0, 19)}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return (
    <div style={{ ...card, padding: '14px 16px', display: 'flex', flexDirection: 'column', minHeight: '60vh' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <h2 style={{ ...h2, margin: 0 }}>Live log</h2>
        <span style={muted}>{activeRun ? 'following the run · refreshes every 3s' : 'idle · refreshes every 10s'}</span>
        <div style={{ flex: 1 }} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter… (substring, case-insensitive)" style={{ ...input, width: '260px', height: '30px' }} />
        <select value={level} onChange={(e) => setLevel(e.target.value as keyof typeof LEVEL_ORDER)} style={{ ...input, width: 'auto', height: '30px' }}>
          <option value="debug">debug+</option><option value="info">info+</option><option value="warn">warn+</option><option value="error">errors</option>
        </select>
        <select value={String(runId)} onChange={(e) => pickRun(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={{ ...input, width: 'auto', height: '30px', maxWidth: '220px' }}>
          <option value="all">All runs</option>
          {runs.slice(0, 20).map((r) => <option key={r.id} value={r.id}>{KIND_LABELS[r.kind] ?? r.kind} · {new Date(r.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#52525b' }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        <Btn small onClick={() => navigator.clipboard?.writeText(text()).then(() => toast('Log copied'))}>Copy</Btn>
        <Btn small onClick={download}>Download</Btn>
      </div>
      <div ref={boxRef} style={{ flex: 1, minHeight: '50vh', overflow: 'auto', background: '#0c0d10', color: '#e4e4e7', borderRadius: '10px', padding: '10px 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11.5px', lineHeight: 1.55 }}>
        {shown.length === 0 ? <span style={{ color: '#71717a' }}>{lines.length ? 'Nothing matches the filter.' : 'No log lines yet. The extension ships its log every few seconds while it runs.'}</span> : shown.map((l) => (
          <div key={l.id} style={{ display: 'flex', gap: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: '#71717a', flex: 'none' }}>{l.ts.slice(11, 19)}</span>
            <span style={{ color: l.level === 'error' ? '#f87171' : l.level === 'warn' ? '#fbbf24' : l.level === 'debug' ? '#71717a' : '#a1a1aa', flex: 'none', width: '38px', fontSize: '11px', paddingTop: '2px' }}>{l.level}</span>
            <span style={{ color: '#fdba74', flex: 'none' }}>[{l.tag ?? 'bg'}]</span>
            <span style={{ color: l.level === 'error' ? '#fca5a5' : '#e4e4e7' }}>{l.msg}</span>
          </div>
        ))}
      </div>
      <div style={{ ...muted, marginTop: '8px', color: LEVEL_COLOR.debug }}>{shown.length} of {lines.length} lines · kept 14 days</div>
    </div>
  );
}

// ---- Buyers lists -----------------------------------------------------------------

function BuyersLists({ state, canOperate, busy, cmd }: { state: DealMachineState; canOperate: boolean; busy: boolean; cmd: (c: DmCommand['command']) => Promise<void> }) {
  const opted = state.optins.filter((o) => o.status === 'opted_in');
  const failed = state.optins.filter((o) => o.status === 'no_form' || o.status === 'failed');
  const runs = state.runs.filter((r) => r.kind === 'buyers_list' || r.kind === 'blitz').length;
  const disabled = !canOperate || busy || !state.key;
  return (
    <>
      <div style={card}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          <div>
            <h2 style={h2}>Buyers list bot</h2>
            <p style={{ ...sub, marginBottom: 0 }}>Finds wholesaler sites through Bing, opts {state.settings.contact.email || 'the contact identity'} into their cash-buyer lists, and captures every buyer and wholesaler it meets into CLOZR.</p>
          </div>
          <div style={{ flex: 1 }} />
          <Pill tone={state.settings.buyersList.autoSubmit ? 'amber' : 'zinc'}>auto-submit {state.settings.buyersList.autoSubmit ? 'on' : 'off'}</Pill>
          <Btn kind="primary" disabled={disabled} onClick={() => cmd('buyers_list')} style={{ background: '#0A8560', borderColor: '#0A8560' }}>Run buyers list bot now</Btn>
          <Btn disabled={disabled || !failed.length} onClick={() => cmd('retry_failed_optins')}>Retry failed</Btn>
        </div>
      </div>
      <div style={card}>
        <h2 style={h2}>Stats</h2>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
          <Stat n={state.totals.optedIn} k="Opted in" color="#0A8560" />
          <Stat n={state.optins.length} k="Visited" />
          <Stat n={runs} k="Runs" />
          <Stat n={failed.length} k="No form" color={failed.length ? '#b45309' : undefined} />
          <Stat n={state.totals.wholesalers} k="Wholesalers captured" color="#15803d" />
        </div>
      </div>
      <div style={card}>
        <h2 style={h2}>Where it has been</h2>
        <p style={sub}>One row per domain, latest outcome. A domain that once opted in stays opted in.</p>
        {state.optins.length === 0 ? <Empty>No opt-ins yet. Run the bot, or press RUN — it is step 4 of the full pipeline.</Empty> : (
          <div style={{ overflowX: 'auto', border: '1px solid #e4e4e7', borderRadius: '10px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Domain', 'Status', 'Method', 'Detail', 'Tries', 'Last'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {state.optins.map((o) => (
                  <tr key={o.id} className="clozr-dm-row">
                    <td style={tdStyle}>{o.url ? <a href={o.url} target="_blank" rel="noreferrer" style={{ color: '#0369a1', textDecoration: 'none' }}>{o.domain}</a> : o.domain}</td>
                    <td style={tdStyle}><Pill tone={o.status === 'opted_in' ? 'green' : o.status === 'queued' ? 'blue' : o.status === 'skipped' ? 'zinc' : 'amber'}>{o.status.replace('_', ' ')}</Pill></td>
                    <td style={tdStyle}>{o.method ?? '—'}</td>
                    <td style={{ ...tdStyle, maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#52525b' }} title={o.detail ?? ''}>{o.detail ?? '—'}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{o.attempts}</td>
                    <td style={tdStyle}>{since(o.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {opted.length ? <p style={{ ...muted, marginTop: '8px', marginBottom: 0 }}>The wholesalers behind these lists are in Buyers, tagged from the extension; the deals they email arrive as leads through the Email step.</p> : null}
      </div>
    </>
  );
}

// ---- Results -----------------------------------------------------------------------

function Results({ V, state }: { V: ClozrView; state: DealMachineState }) {
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'clears' | 'misses'>('all');
  const pct = state.settings.deal.maoPct;
  const rows = state.landed.map((d) => {
    const mao = d.mao ?? maoOf(d.arv, d.rehab, pct);
    const clears = d.asking !== null && mao !== null ? d.asking <= mao : null;
    return { d, mao, clears };
  }).filter(({ d, clears }) => (only === 'all' || (only === 'clears' ? clears === true : clears === false))
    && (!q || [d.address, d.city, d.state, d.sourceId, d.leadSource].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase())));
  const srcLabel = (s: string | null) => ({ investorlift: 'InvestorLift', fb_group: 'Facebook', realestatebees: 'RealEstateBees', bing: 'Bing', manual: 'Manual', email: 'Email' } as Record<string, string>)[s ?? ''] ?? (s ?? '—');
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div>
          <h2 style={{ ...h2, margin: 0 }}>What has landed · {state.totals.deals}</h2>
          <p style={{ ...sub, margin: '4px 0 0' }}>Every deal Deal Machine landed, from the cloud or the extension, newest first, as real CLOZR records. Clears means asking ≤ {pct}% of ARV − rehab − $20k.</p>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', border: '1px solid #e4e4e7', borderRadius: '9px', overflow: 'hidden' }}>
          {(['all', 'clears', 'misses'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setOnly(k)} style={{ height: '30px', padding: '0 12px', border: 0, background: only === k ? '#18181b' : '#fff', color: only === k ? '#fff' : '#52525b', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>{k}</button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search address, city, source" style={{ ...input, width: '240px', height: '30px' }} />
      </div>
      {rows.length === 0 ? <Empty>{state.landed.length ? 'Nothing matches.' : state.key ? 'Nothing yet. Deals land here when a run finds something in the buy box.' : 'Nothing yet — there is no Deal Machine key to land finds under.'}</Empty> : (
        <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : 'repeat(auto-fill, minmax(320px, 1fr))', gap: '10px' }}>
          {rows.map(({ d, mao, clears }) => (
            <button key={d.id} type="button" className="dc37" onClick={() => V.openLandedDeal(d.id, d.sellerId)} style={{ textAlign: 'left', border: '1px solid #e4e4e7', borderRadius: '12px', background: '#fff', padding: 0, cursor: 'pointer', overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'box-shadow .15s, border-color .15s' }}>
              <div style={{ height: '110px', background: d.heroImageUrl ? `#e4e4e7 url(${d.heroImageUrl}) center/cover no-repeat` : `linear-gradient(135deg, ${DEAL_MACHINE_TINT}, #fde8d3)`, position: 'relative' }}>
                <span style={{ position: 'absolute', top: '8px', left: '8px' }}><Pill tone="orange">{srcLabel(d.leadSource)}</Pill></span>
                {clears !== null ? <span style={{ position: 'absolute', top: '8px', right: '8px' }}><Pill tone={clears ? 'green' : 'amber'}>{clears ? 'clears' : 'misses'}</Pill></span> : null}
              </div>
              <div style={{ padding: '10px 12px 12px' }}>
                <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.address ?? d.sourceId ?? `Deal ${d.id}`}</div>
                <div style={{ ...muted, marginTop: '2px' }}>{[d.city, d.state].filter(Boolean).join(', ') || '—'} · {d.stage} · {since(d.createdAt)}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px', marginTop: '10px' }}>
                  {([['Asking', d.asking], ['ARV', d.arv], ['Rehab', d.rehab], ['MAO', mao]] as [string, number | null][]).map(([k, v]) => (
                    <span key={k}><span style={{ ...label, marginBottom: '2px' }}>{k}</span><span style={{ fontSize: '12.5px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: k === 'MAO' ? DEAL_MACHINE : '#18181b' }}>{money(v)}</span></span>
                  ))}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Masterlist ----------------------------------------------------------------------

function Masterlist({ V, state, setTab }: { V: ClozrView; state: DealMachineState; setTab: (t: Tab) => void }) {
  return (
    <>
      <div style={card}>
        <h2 style={h2}>Masterlist</h2>
        <p style={sub}>Everything the extension has ever put into this workspace. Unlike the popup’s masterlist these are records, not a local cache: they survive a reinstall and every rep sees the same list.</p>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Stat n={state.totals.deals} k="Deals" color="#2d5bff" />
          <Stat n={state.totals.buyers} k="Buyers captured" color="#15803d" />
          <Stat n={state.totals.wholesalers} k="Wholesalers" color="#0A8560" />
          <Stat n={state.totals.optedIn} k="Buyers lists" color={DEAL_MACHINE} />
          <Stat n={state.totals.groups} k="FB groups in Buyr" />
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          <Btn small onClick={() => setTab('Results')}>Open deals</Btn>
          <Btn small onClick={V.goBuyers}>Open Buyers</Btn>
          <Btn small onClick={() => setTab('Buyers lists')}>Open buyers lists</Btn>
          <Btn small onClick={V.goBuyr}>Facebook groups in Buyr</Btn>
        </div>
      </div>
      <div style={card}>
        <h2 style={h2}>Recent deals</h2>
        {state.landed.length === 0 ? <Empty>Nothing yet.</Empty> : state.landed.slice(0, 10).map((d, i) => (
          <button key={d.id} type="button" className="dc15" onClick={() => V.openLandedDeal(d.id, d.sellerId)} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '9px 6px', border: 0, borderTop: i === 0 ? '1px solid #f0f0f1' : '1px solid #f0f0f1', background: 'none', textAlign: 'left', cursor: 'pointer', borderRadius: '6px' }}>
            <span style={{ color: DEAL_MACHINE, display: 'inline-flex' }}><Mark label={'Deal Machine'} /></span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.address ?? d.sourceId ?? `Deal ${d.id}`}</span>
              <span style={{ display: 'block', fontSize: '12px', color: '#71717a', marginTop: '1px' }}>{d.stage} · ARV {money(d.arv)} · rehab {money(d.rehab)} · MAO {money(d.mao ?? maoOf(d.arv, d.rehab, state.settings.deal.maoPct))} · {since(d.createdAt)}</span>
            </span>
          </button>
        ))}
      </div>
      <div style={card}>
        <h2 style={h2}>Buyers lists opted into</h2>
        {state.optins.filter((o) => o.status === 'opted_in').length === 0 ? <Empty>None yet.</Empty> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
            {state.optins.filter((o) => o.status === 'opted_in').slice(0, 60).map((o) => (
              <a key={o.id} href={o.url ?? `https://${o.domain}`} target="_blank" rel="noreferrer" style={{ fontSize: '12px', padding: '4px 9px', borderRadius: '999px', background: '#F0FAF5', color: '#08694C', textDecoration: 'none', border: '1px solid #A7DCC5' }}>{o.domain}</a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---- Settings -------------------------------------------------------------------------

const SECTIONS = ['Cloud', 'General', 'Contact', 'Deal criteria', 'Buyers list bot', 'Integrations', 'Advanced'] as const;

const LAND_POLICIES: [LandPolicy, string, string][] = [
  ['qualified', 'Only deals that clear the MAO', 'In the buy box and asking ≤ the MAO. The tightest list; a deal with no ARV never lands.'],
  ['buybox', 'Every buy-box deal', 'In a fund market and inside its price and beds / baths / year rules, MAO or not. The verdict is in the deal’s notes.'],
  ['valid', 'Every real house deal', 'Also houses outside the buy box. Lenders, realtors, land, condos and owner finance never land under any setting.'],
];

function SettingsTab({ V, state, workspaceId, admin, canOperate, reload, setNote }: {
  V: ClozrView; state: DealMachineState; workspaceId: number | null; admin: boolean; canOperate: boolean; reload: () => void; setNote: (n: { ok: boolean; text: string }) => void;
}) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>(state.key ? 'Cloud' : 'Integrations');
  const [tokenDraft, setTokenDraft] = useState('');
  const [draft, setDraft] = useState<DmSettings>(state.settings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [statesText, setStatesText] = useState(state.settings.markets.enabledStates.join(', '));
  const [citiesText, setCitiesText] = useState(state.settings.markets.enabledCities.join(', '));
  const [allowText, setAllowText] = useState(state.settings.buyersList.allowlistDomains.join('\n'));

  // A save elsewhere (another rep, the extension's first sync) lands as a new
  // settings version; adopt it unless this form has unsaved edits. Derived
  // state set during render, not in an effect, so nothing renders twice.
  const [seenVersion, setSeenVersion] = useState(state.settingsVersion);
  if (!dirty && seenVersion !== state.settingsVersion) {
    setSeenVersion(state.settingsVersion);
    setDraft(state.settings);
    setStatesText(state.settings.markets.enabledStates.join(', '));
    setCitiesText(state.settings.markets.enabledCities.join(', '));
    setAllowText(state.settings.buyersList.allowlistDomains.join('\n'));
  }

  const patch = <K extends keyof DmSettings>(k: K, v: Partial<DmSettings[K]> | DmSettings[K]) => {
    setDraft((d) => ({ ...d, [k]: typeof d[k] === 'object' && d[k] !== null ? { ...(d[k] as object), ...(v as object) } : v }));
    setDirty(true);
  };

  const save = async () => {
    if (!workspaceId) return;
    const next: DmSettings = {
      ...draft,
      markets: {
        ...draft.markets,
        enabledStates: [...new Set(statesText.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)))],
        enabledCities: [...new Set(citiesText.split(',').map((x) => x.trim()).filter(Boolean))],
      },
      buyersList: { ...draft.buyersList, allowlistDomains: [...new Set(allowText.split(/\r?\n|,/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))] },
    };
    setSaving(true);
    const r = await saveSettings(workspaceId, next);
    setSaving(false);
    if (!r.ok) { setNote({ ok: false, text: r.message ?? 'Could not save.' }); return; }
    setDirty(false);
    setNote({ ok: true, text: next.cloud.enabled ? 'Saved. CLOZR Cloud uses it from its next tick; the extension applies it on its next sync.' : 'Saved. The extension applies it on its next sync, within a minute.' });
    reload();
  };

  async function saveToken(clear = false) {
    if (!workspaceId) return;
    setBusy(true);
    const r = await saveApifyToken(workspaceId, clear ? '' : tokenDraft.trim());
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.message ?? 'Could not save the token.' }); return; }
    setTokenDraft('');
    setNote({ ok: true, text: clear ? 'Apify token removed. Cloud runs stop until one is saved.' : 'Apify token saved. CLOZR keeps it server-side; it is never shown again.' });
    reload();
  }

  const endpoint = ingestUrl();
  const key = state.key;
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => V.showToast(`${what} copied`), () => setNote({ ok: false, text: 'This browser would not let the page copy. Select it and copy by hand.' }));

  async function mint() {
    if (!workspaceId) return;
    setBusy(true);
    const r = await issueKey(workspaceId, DEAL_MACHINE_SOURCE, 'Deal Machine');
    setBusy(false);
    if (!r.ok || !r.key) { setNote({ ok: false, text: r.message ?? 'Could not issue a key.' }); return; }
    setMinted(r.key);
    setNote({ ok: true, text: 'Key issued. Copy it now — it is not shown again.' });
    reload();
  }
  async function toggleCompr() {
    if (!key) return;
    setBusy(true);
    const r = await setKeySetting(key.id, 'auto_compr', key.auto_compr === 'off' ? 'on' : 'off');
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.message ?? 'Could not change that.' }); return; }
    reload();
  }

  // Dollars read like everywhere else ("250k" is 250,000); a half-typed value keeps its digits.
  const numIn = (v: string) => (v.trim() === '' ? null : parseDollars(v).value ?? (Number(v.replace(/[^0-9.]/g, '')) || 0));
  const ro = !canOperate;

  return (
    <>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {SECTIONS.map((sct) => (
          <button key={sct} type="button" onClick={() => setSection(sct)} style={{ height: '30px', padding: '0 12px', borderRadius: '999px', border: `1px solid ${section === sct ? '#18181b' : '#e4e4e7'}`, background: section === sct ? '#18181b' : '#fff', color: section === sct ? '#fff' : '#52525b', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>{sct}</button>
        ))}
        <div style={{ flex: 1 }} />
        {dirty ? <Btn kind="machine" disabled={saving || ro} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</Btn> : <span style={{ ...muted, alignSelf: 'center' }}>v{state.settingsVersion} · {state.devices.every((d) => !d.online || (d.settingsVersion ?? 0) >= state.settingsVersion) ? 'applied on every online extension' : 'waiting for an extension to sync'}</span>}
      </div>

      {section === 'Cloud' ? (
        <>
          <div style={card}>
            <h2 style={h2}>Run Deal Machine in CLOZR</h2>
            <p style={sub}>No Chrome, no office laptop. CLOZR pulls InvestorLift and your Facebook groups on a server through Apify, judges every find itself (the lender / realtor / land / owner-finance gates, the fund buy box, asking ≤ {draft.deal.maoPct}% ARV − rehab − $20k) and lands the good ones as deals. RUN, Pause and Stop on the Overview go to the cloud while this is on; with Scheduled runs on (General) it runs by itself at 8:00 and 18:00 Central.</p>
            <Toggle on={draft.cloud.enabled} disabled={ro} onChange={(v) => patch('cloud', { enabled: v })}><strong>Cloud runs</strong> — {draft.cloud.enabled ? 'on: the deal scrape runs in CLOZR.' : 'off: the deal scrape waits for the Chrome extension.'} The buyers-list bot and the Facebook group jobs still run in the extension either way.</Toggle>
          </div>

          <div style={card}>
            <h2 style={h2}>Apify</h2>
            <p style={sub}>The cloud reads InvestorLift and Facebook through Apify actors, billed to your Apify account (apify.com → Settings → API &amp; Integrations → Personal API token). CLOZR stores the token server-side and never sends it to a browser.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {state.apifyConnected === null ? <Pill tone="zinc">migration 187 not applied</Pill>
                : state.apifyConnected ? <Pill tone="green"><Dot color="#16a34a" />connected</Pill>
                  : <Pill tone="amber"><Dot color="#d97706" />no token</Pill>}
              {admin ? (
                <>
                  <input type="password" autoComplete="off" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder={state.apifyConnected ? 'Paste a new token to replace it' : 'apify_api_…'} style={{ ...input, width: '300px', maxWidth: '100%' }} />
                  <Btn kind="machine" small disabled={busy || tokenDraft.trim().length < 20} onClick={() => void saveToken()}>Save token</Btn>
                  {state.apifyConnected ? <Btn small disabled={busy} onClick={() => void saveToken(true)}>Remove</Btn> : null}
                </>
              ) : <span style={muted}>An owner or admin saves the token.</span>}
            </div>
          </div>

          <div style={card}>
            <h2 style={h2}>Sources</h2>
            <Toggle on={draft.cloud.investorlift} disabled={ro} onChange={(v) => patch('cloud', { investorlift: v })}><strong>InvestorLift</strong> — every active listing in the buy-box states. Most listings hide the street until you ask, so those land as “Undisclosed (InvestorLift …)” with the city, numbers, dispo contact and link; fill the street in when you get it.</Toggle>
            <Toggle on={draft.cloud.facebook} disabled={ro} onChange={(v) => patch('cloud', { facebook: v })}><strong>Facebook groups</strong> — the active groups in Buyr → Facebook groups, least recently read first. Apify reads public groups; a private group needs the extension.</Toggle>
            <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: '10px 14px', marginTop: '8px' }}>
              <div><span style={label}>InvestorLift max listings</span><input type="number" min={20} max={5000} value={draft.cloud.ilMaxItems} disabled={ro} onChange={(e) => patch('cloud', { ilMaxItems: Number(e.target.value) || 500 })} style={input} /></div>
              <div><span style={label}>Posts per group</span><input type="number" min={5} max={200} value={draft.cloud.fbPostsPerGroup} disabled={ro} onChange={(e) => patch('cloud', { fbPostsPerGroup: Number(e.target.value) || 40 })} style={input} /></div>
              <div><span style={label}>Groups per run</span><input type="number" min={1} max={200} value={draft.cloud.fbMaxGroups} disabled={ro} onChange={(e) => patch('cloud', { fbMaxGroups: Number(e.target.value) || 25 })} style={input} /></div>
              <div><span style={label}>Posts newer than (days)</span><input type="number" min={1} max={30} value={draft.cloud.fbDays} disabled={ro} onChange={(e) => patch('cloud', { fbDays: Number(e.target.value) || 3 })} style={input} /></div>
            </div>
          </div>

          <div style={card}>
            <h2 style={h2}>What lands in CLOZR</h2>
            <p style={sub}>Every find is judged; this decides which verdicts become deals (stage Prospect, source Deal Machine). The rest are counted on the run and listed in the Log with the reason.</p>
            {LAND_POLICIES.map(([k, t, d]) => (
              <label key={k} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '9px 0', borderTop: '1px solid #f0f0f1', cursor: ro ? 'default' : 'pointer' }}>
                <input type="radio" name="dm-land" checked={draft.cloud.land === k} disabled={ro} onChange={() => patch('cloud', { land: k })} style={{ marginTop: '3px', accentColor: DEAL_MACHINE }} />
                <span style={{ fontSize: '13px', lineHeight: 1.4 }}><strong>{t}</strong> <span style={muted}>— {d}</span></span>
              </label>
            ))}
          </div>
        </>
      ) : null}

      {section === 'General' ? (
        <div style={card}>
          <h2 style={h2}>General</h2>
          <p style={sub}>Toggles save with the button above. They reach the extension on its next sync.</p>
          <Toggle on={draft.autoRun} disabled={ro} onChange={(v) => patch('autoRun', v)}><strong>Scheduled runs</strong> — {draft.cloud.enabled ? 'CLOZR Cloud runs the deal scrape at 8:00 and 18:00 Central on its own. The extension, if one is on, still does 9:30 buyers list and 10:30 group discovery in its local time.' : '8:00 Deal Machine, 18:00 scrape, 9:30 buyers list, 10:30 group discovery, in the extension’s local time. Chrome has to be open; a sleeping laptop runs nothing. Turn on Cloud runs to drop that.'}</Toggle>
          <Toggle on={draft.fastMode} disabled={ro} onChange={(v) => patch('fastMode', v)}><strong>Fast mode</strong> — shorter timeouts and delays. Finishes sooner, may miss a slow page.</Toggle>
          <Toggle on={draft.dryRun} disabled={ro} onChange={(v) => patch('dryRun', v)} warn><strong>Dry run</strong> — log every deal it would submit and submit none. The same switch as on the Overview.</Toggle>
        </div>
      ) : null}

      {section === 'Contact' ? (
        <div style={card}>
          <h2 style={h2}>Contact identity</h2>
          <p style={sub}>What the buyers-list bot types into opt-in forms, and the number InvestorLift texts a code to.</p>
          <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : '1fr 1fr', gap: '10px 14px' }}>
            {([['firstName', 'First name', 'Drew'], ['lastName', 'Last name', 'Park'], ['email', 'Email', 'drew@yourcompany.com'], ['phone', 'Phone', '2105550160'], ['company', 'Company', 'Acme Homes'], ['ilVerificationPhone', 'InvestorLift verify phone', '2105550160']] as const).map(([k, l, ph]) => (
              <div key={k}><span style={label}>{l}</span><input value={draft.contact[k]} placeholder={ph} disabled={ro} onChange={(e) => patch('contact', { [k]: e.target.value } as Partial<DmSettings['contact']>)} style={input} /></div>
            ))}
            <div><span style={label}>Max purchase price</span><input value={draft.contact.maxPrice ?? ''} placeholder="500000" disabled={ro} inputMode="numeric" onChange={(e) => patch('contact', { maxPrice: numIn(e.target.value) })} style={input} /></div>
          </div>
          <div style={{ marginTop: '10px' }}><span style={label}>Buyer notes (pasted into “comments” fields)</span><textarea value={draft.contact.notes} disabled={ro} onChange={(e) => patch('contact', { notes: e.target.value })} placeholder="Cash buyer, close in 14 days, any condition, SFR and small multi in the markets below." style={textarea} /></div>
        </div>
      ) : null}

      {section === 'Deal criteria' ? (
        <>
          <div style={card}>
            <h2 style={h2}>The formula</h2>
            <p style={sub}>A deal qualifies when <strong>asking ≤ {draft.deal.maoPct}% × ARV − rehab − $20,000</strong> (the $20k is the assignment fee the rule reserves), the ARV is inside the range, and the property is in an enabled market. The fund buy box (each state’s price cap and each metro’s beds / baths / sqft / year rules, buybox-config.js) is applied on top, by the cloud and the extension alike.</p>
            <div style={{ display: 'grid', gridTemplateColumns: V.isMobile ? '1fr' : '1fr 1fr 1fr', gap: '10px 14px' }}>
              <div><span style={label}>MAO %</span><input type="number" min={50} max={90} value={draft.deal.maoPct} disabled={ro} onChange={(e) => patch('deal', { maoPct: Number(e.target.value) || 70 })} style={input} /></div>
              <div><span style={label}>Min ARV</span><input value={draft.deal.minArv} disabled={ro} inputMode="numeric" onChange={(e) => patch('deal', { minArv: numIn(e.target.value) ?? 0 })} style={input} /></div>
              <div><span style={label}>Max ARV</span><input value={draft.deal.maxArv} disabled={ro} inputMode="numeric" onChange={(e) => patch('deal', { maxArv: numIn(e.target.value) ?? 0 })} style={input} /></div>
            </div>
          </div>
          <div style={card}>
            <h2 style={h2}>Target markets</h2>
            <p style={sub}>States the scraper keeps deals from, and the cities or counties within them. Leave cities empty to take the whole state.</p>
            <div style={{ marginBottom: '10px' }}><span style={label}>Enabled states</span><input value={statesText} disabled={ro} onChange={(e) => { setStatesText(e.target.value); setDirty(true); }} placeholder={DEFAULT_STATES.join(', ')} style={input} /></div>
            <div style={{ marginBottom: '4px' }}><span style={label}>Cities / counties</span><input value={citiesText} disabled={ro} onChange={(e) => { setCitiesText(e.target.value); setDirty(true); }} placeholder="San Antonio, Houston, Charlotte" style={input} /></div>
            <Toggle on={draft.markets.mode === 'strict'} disabled={ro} onChange={(v) => patch('markets', { mode: v ? 'strict' : 'loose' })}><strong>Strict geography</strong> — a deal outside the enabled markets is dropped. Off, it is kept and flagged so you can see what you are missing.</Toggle>
          </div>
        </>
      ) : null}

      {section === 'Buyers list bot' ? (
        <div style={card}>
          <h2 style={h2}>Buyers list bot</h2>
          <p style={sub}>How the bot behaves on wholesaler sites it finds through Bing.</p>
          <Toggle on={draft.buyersList.autoSubmit} disabled={ro} warn onChange={(v) => patch('buyersList', { autoSubmit: v })}><strong>Auto-submit opt-in forms</strong> — fill and submit without a person confirming each one. Off, it fills the form and leaves the tab open for you.</Toggle>
          <div style={{ marginTop: '10px' }}><span style={label}>Always-approved domains</span><textarea value={allowText} disabled={ro} onChange={(e) => { setAllowText(e.target.value); setDirty(true); }} placeholder={'houstonhousebuyers.com\ncarrot-site.com'} style={textarea} /><p style={{ ...muted, marginTop: '6px', marginBottom: 0 }}>One per line. These submit even with auto-submit off.</p></div>
        </div>
      ) : null}

      {section === 'Integrations' ? (
        <>
          <div style={card}>
            <h2 style={h2}>Connection</h2>
            <p style={sub}>The extension signs everything with one ingest key: what it finds goes to <code style={code}>/ingest</code>, its heartbeat, commands and log go to <code style={code}>/deal-machine</code>. Nothing else about it is configured in the popup any more.</p>
            <div style={{ marginBottom: '12px' }}>
              <span style={label}>Endpoint</span>
              {endpoint ? <><code style={code}>{endpoint}</code> <Btn small onClick={() => copy(endpoint, 'Endpoint')} style={{ marginLeft: '8px' }}>Copy</Btn></> : <span style={muted}>Supabase is not configured on this deployment.</span>}
            </div>
            {minted ? (
              <div style={{ marginBottom: '12px', padding: '11px 13px', background: DEAL_MACHINE_TINT, border: `1px solid ${DEAL_MACHINE}33`, borderRadius: '9px' }}>
                <span style={label}>The key — shown once</span>
                <code style={{ ...code, background: '#fff' }}>{minted.key}</code>
                <Btn small onClick={() => copy(minted.key, 'Key')} style={{ marginLeft: '8px' }}>Copy</Btn>
                <p style={{ ...muted, margin: '8px 0 0' }}>CLOZR stores a hash of this, never the key itself. Paste it into the extension’s Settings → Integrations → CLOZR. Lose it and you issue a new one rather than recover this.</p>
              </div>
            ) : null}
            <div>
              <span style={label}>Key</span>
              {key ? (
                <span style={{ fontSize: '12.5px', color: '#18181b' }}>
                  <code style={code}>{key.key_prefix}…</code>
                  <span style={{ color: '#71717a', marginLeft: '8px' }}>issued {since(key.created_at)} · {key.active ? `last used ${since(key.last_used_at)}` : 'disabled'}</span>
                </span>
              ) : <span style={muted}>{admin ? 'No key has been issued, so anything the extension sends is refused.' : 'No key is visible to your role. An owner or admin issues it.'}</span>}
            </div>
            {admin && !key ? <Btn kind="machine" disabled={busy || !endpoint} onClick={() => void mint()} style={{ marginTop: '14px' }}>Issue the Deal Machine key</Btn> : null}
          </div>

          {key ? (
            <div style={card}>
              <h2 style={h2}>Auto-run COMPR</h2>
              <p style={sub}>Underwrite each new deal as it lands. Only ever runs on a deal the delivery just created, so a re-scrape of the same listing is never underwritten twice. Two switches have to agree: the extension asks (below) and this key allows.</p>
              <Toggle on={key.auto_compr !== 'off'} disabled={!admin || busy} onChange={() => void toggleCompr()}><strong>Key allows COMPR</strong> — {key.auto_compr === 'off' ? 'off: CLOZR ignores the extension’s request to underwrite.' : 'on: a new deal is underwritten when the extension asks.'}{!admin ? ' Only an owner or admin can change this.' : ''}</Toggle>
              <Toggle on={draft.integrations.autoCompr} disabled={ro} onChange={(v) => patch('integrations', { autoCompr: v })}><strong>Extension asks for COMPR</strong> on every deal it posts that has a street, a state and a named contact.</Toggle>
            </div>
          ) : null}

          <div style={card}>
            <h2 style={h2}>Where finds go</h2>
            <Toggle on={draft.integrations.clozrEnabled} disabled={ro} onChange={(v) => patch('integrations', { clozrEnabled: v })}><strong>Post to CLOZR</strong> — deals, wholesalers and captured buyers land here as records. Off means the popup-era world: Podio only.</Toggle>
            <Toggle on={draft.integrations.podioEnabled} disabled={ro} onChange={(v) => patch('integrations', { podioEnabled: v })}><strong>Keep the Podio JV push</strong> — runs beside CLOZR through yourcompany.com/api/podio-jv-lead. Turn off once the Podio board is retired.</Toggle>
            <Toggle on={draft.integrations.sheetsWebhookEnabled} disabled={ro} onChange={(v) => patch('integrations', { sheetsWebhookEnabled: v })}><strong>Google Sheets webhook</strong> for captured buyer emails (the URL stays in the extension).</Toggle>
          </div>

          <div style={card}>
            <h2 style={h2}>Fallbacks</h2>
            <p style={sub}>Paid services the extension leans on when a page will not give the data up. The API tokens stay in the extension; the switches and daily caps live here.</p>
            <Toggle on={draft.integrations.firecrawlEnabled} disabled={ro} onChange={(v) => patch('integrations', { firecrawlEnabled: v })}><strong>Firecrawl</strong> — cloud form filler for buyers-list opt-ins the in-browser bot could not complete.</Toggle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', padding: '6px 0 10px 46px' }}>
              <div><span style={label}>Firecrawl daily limit</span><input type="number" min={1} max={100} value={draft.integrations.firecrawlDailyLimit} disabled={ro} onChange={(e) => patch('integrations', { firecrawlDailyLimit: Number(e.target.value) || 10 })} style={{ ...input, maxWidth: '120px' }} /></div>
            </div>
            <Toggle on={draft.integrations.apifyEnabled} disabled={ro} onChange={(v) => patch('integrations', { apifyEnabled: v })}><strong>Apify</strong> — pulls Facebook group posts and Google results when Bing returns nothing.</Toggle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', padding: '6px 0 4px 46px' }}>
              <div><span style={label}>Apify daily limit</span><input type="number" min={1} max={50} value={draft.integrations.apifyDailyLimit} disabled={ro} onChange={(e) => patch('integrations', { apifyDailyLimit: Number(e.target.value) || 5 })} style={{ ...input, maxWidth: '120px' }} /></div>
            </div>
          </div>
        </>
      ) : null}

      {section === 'Advanced' ? (
        <>
          <div style={card}>
            <h2 style={h2}>Pointing the extension here</h2>
            <p style={sub}>Load <code style={code}>chrome-extension/</code> unpacked, open its Settings → Integrations → CLOZR, paste the endpoint and key, switch it on. From then on it takes its settings, groups and commands from this screen and the popup is a status window.</p>
            <p style={{ ...muted, marginBottom: 0 }}>Everything it sends carries <code style={code}>source: &quot;{DEAL_MACHINE_SOURCE}&quot;</code> and the listing or post id as its <code style={code}>source_id</code>, so re-scraping the same post updates that deal instead of making a second one. A wrong mapping is replayable: <code style={code}>select public.ingest_replay(&lt;workspace&gt;, &apos;deal_machine&apos;)</code>.</p>
          </div>
          <div style={card}>
            <h2 style={h2}>What never leaves the extension</h2>
            <p style={{ ...muted, marginBottom: 0 }}>The extension’s own Apify, Firecrawl and Sheets tokens · the Vercel cron secret and ETL token · the InvestorLift and Facebook sessions themselves. These are secrets or cookies; CLOZR has no reason to hold them. The cloud’s Apify token is separate and lives server-side (Settings → Cloud).</p>
          </div>
        </>
      ) : null}

      {dirty ? (
        <div style={{ position: 'sticky', bottom: '8px', display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px', background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(6px)', border: '1px solid #e4e4e7', borderRadius: '12px', boxShadow: 'var(--shadow-md)' }}>
          <span style={{ ...muted, alignSelf: 'center', marginRight: 'auto' }}>Unsaved changes</span>
          <Btn onClick={() => { setDirty(false); setDraft(state.settings); setStatesText(state.settings.markets.enabledStates.join(', ')); setCitiesText(state.settings.markets.enabledCities.join(', ')); setAllowText(state.settings.buyersList.allowlistDomains.join('\n')); }}>Discard</Btn>
          <Btn kind="machine" disabled={saving || ro} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</Btn>
        </div>
      ) : null}
    </>
  );
}
