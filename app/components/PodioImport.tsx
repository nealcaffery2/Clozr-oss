// Podio — the Settings card that holds the connection, and the full-screen
// import that brings active deals and everyone on them into CLOZR.
//
//   1 · Stages and mapping   which Podio stages to bring, which Podio field fills each CLOZR field (guessed, editable)
//   2 · Preview              every deal with its parties, matched to CLOZR rows or marked new, with warnings
//   3 · Import               selected deals in batches of 10, then what was created and updated
//
// Credentials go to the podio-import function and never come back: the card
// shows only the last four characters of what is stored.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  type PodioAppKey, type PodioDeal, type PodioImportResult, type PodioInspect, type PodioPreview, type PodioStatus, type PodioSyncResult,
  type PodioSyncStatus, podio, syncProgress, syncSummary,
} from '@/lib/podio';
import { PARTY_ROLE_LABEL } from '@/lib/deal-parties';

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: '14px', fontWeight: 600 };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: '#71717a', fontWeight: 600, marginBottom: '5px' };
const field: React.CSSProperties = { width: '100%', height: '34px', padding: '0 10px', border: '1px solid #e4e4e7', borderRadius: '9px', fontSize: '13px', outline: 0, background: '#fafafa', color: '#18181b' };
const btn: React.CSSProperties = { height: '32px', padding: '0 12px', borderRadius: '9px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: '#18181b', whiteSpace: 'nowrap' };
const primary: React.CSSProperties = { ...btn, border: '1px solid #0A8560', background: '#0A8560', color: '#fff' };
const badge = (ok: boolean): React.CSSProperties => ({ display: 'inline-block', fontSize: '11px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: ok ? '#dcfce7' : '#fff7ed', color: ok ? '#15803d' : '#c2410c', border: `1px solid ${ok ? '#bbf7d0' : '#fed7aa'}` });
const Note = ({ ok, text }: { ok: boolean; text: string }) => (
  <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: ok ? '#dcfce7' : '#fee2e2', border: `1px solid ${ok ? '#bbf7d0' : '#fecaca'}`, color: ok ? '#15803d' : '#b91c1c' }}>{text}</div>
);

const EXTRA_KEYS: [PodioAppKey, string][] = [
  ['submissions', 'Submissions (live sync)'], ['contacts', 'Contacts / Sellers'], ['buyers', 'Buyers'], ['vendors', 'Vendors'], ['team', 'Team'],
  ['wholesalers', 'Wholesalers'], ['acquisitions', 'Acquisitions (sellers, live sync)'], ['communications', 'Communications (calls and texts, live sync)'], ['deals2', 'Deals (second app)'], ['other', 'Other'],
];
type AppDraft = { key: PodioAppKey; app_id: string; app_token: string; hint: string | null };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PodioCard({ workspaceId, admin, demo, isMobile, onOpenSeller, onImported }: {
  workspaceId: number | null; admin: boolean; demo: boolean; isMobile: boolean;
  onOpenSeller?: (sellerId: number) => void; onImported?: () => void;
}) {
  const [status, setStatus] = useState<{ key: number; s: PodioStatus } | null>(null);
  const [draft, setDraft] = useState<{ client_id: string; client_secret: string; apps: AppDraft[] } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState(false);
  const [nonce, setNonce] = useState(0);
  const enabled = !!workspaceId && admin && !demo;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    podio<PodioStatus>(workspaceId!, 'status').then((s) => { if (live) setStatus({ key: workspaceId!, s }); }).catch((e) => { if (live) setNote({ ok: false, text: errText(e) }); });
    return () => { live = false; };
  }, [enabled, workspaceId, nonce]);
  const s = status && status.key === workspaceId ? status.s : null;
  const saved: AppDraft[] = (s?.apps ?? []).map((a) => ({ key: a.key, app_id: String(a.app_id), app_token: '', hint: a.token_hint }));
  const v = draft ?? { client_id: '', client_secret: '', apps: saved.some((a) => a.key === 'deals') ? saved : [{ key: 'deals' as const, app_id: '', app_token: '', hint: null }, ...saved] };
  const deals = v.apps.find((a) => a.key === 'deals')!;
  const extras = v.apps.filter((a) => a.key !== 'deals');
  const setApps = (apps: AppDraft[]) => setDraft({ ...v, apps });
  const editApp = (a: AppDraft, patch: Partial<AppDraft>) => setApps(v.apps.map((x) => (x === a ? { ...x, ...patch } : x)));

  async function run(what: 'save' | 'test' | 'disconnect') {
    if (!workspaceId) return;
    setBusy(true); setNote(null);
    try {
      if (what === 'save' || (what === 'test' && draft)) {
        await podio(workspaceId, 'save', { client_id: v.client_id, client_secret: v.client_secret, apps: v.apps.filter((a) => a.app_id.trim()).map((a) => ({ key: a.key, app_id: Number(a.app_id), app_token: a.app_token })) });
        setDraft(null); setNonce((n) => n + 1);
      }
      if (what === 'disconnect') { await podio(workspaceId, 'disconnect'); setDraft(null); setNonce((n) => n + 1); setNote({ ok: true, text: 'Podio disconnected. Imported records stay.' }); }
      else if (what === 'test') {
        const r = await podio<{ app_name: string; field_count: number }>(workspaceId, 'test');
        setNote({ ok: true, text: `Connected to “${r.app_name}” · ${r.field_count} fields.` });
      } else setNote({ ok: true, text: 'Saved. Test the connection, then import.' });
    } catch (e) { setNote({ ok: false, text: errText(e) }); }
    setBusy(false);
  }

  const secretPh = (h: string | null | boolean, what: string) => (h ? `Saved${typeof h === 'string' ? ' ' + h : ''} — leave blank to keep` : what);
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px 12px' };

  return (
    <div style={card}>
      <h2 style={h2}>Podio</h2>
      <p style={sub}>
        Import active deals from Podio — the seller, buyer, title, photographer, wholesaler, agents, TC and reps on each — into their places in CLOZR.
        {' '}{!admin && !demo ? 'Only an owner or admin can connect Podio.' : demo ? 'Sign in to a workspace to connect Podio.' : `Status: ${s?.connected ? 'connected' : 'not connected'}${s?.last_import_at ? ` · last import ${new Date(s.last_import_at).toLocaleString()}` : ''}.`}
      </p>
      {enabled ? (
        <>
          <details style={{ marginBottom: '12px', fontSize: '12.5px', color: '#52525b', lineHeight: 1.55 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#18181b' }}>Where to find these in Podio</summary>
            <p style={{ margin: '6px 0' }}><b>Client ID and secret:</b> podio.com → your avatar → Account settings → API keys (podio.com/settings/api). Enter an app name and any domain, click Generate API key, and copy the Client ID and Client Secret.</p>
            <p style={{ margin: '6px 0' }}><b>App ID and token:</b> open the Deals app → the wrench (app settings) menu → Developer. Copy App ID and App Token. Podio app tokens only read their own app, so add the apps your deal fields point at (Contacts/Sellers, Buyers, Vendors, Team) the same way to bring their phone numbers and emails; without them people come over by name.</p>
          </details>
          <div style={grid}>
            <div><label style={label}>Client ID</label><input value={v.client_id} onChange={(e) => setDraft({ ...v, client_id: e.target.value })} placeholder={secretPh(s?.client_id_hint ?? null, 'clozr-import')} autoComplete="off" style={field} /></div>
            <div><label style={label}>Client secret</label><input type="password" value={v.client_secret} onChange={(e) => setDraft({ ...v, client_secret: e.target.value })} placeholder={secretPh(s?.has_secret ?? false, 'Client secret')} autoComplete="new-password" style={field} /></div>
            <div><label style={label}>Deals app ID</label><input value={deals.app_id} onChange={(e) => editApp(deals, { app_id: e.target.value.replace(/\D/g, '') })} placeholder="12345678" inputMode="numeric" style={field} /></div>
            <div><label style={label}>Deals app token</label><input type="password" value={deals.app_token} onChange={(e) => editApp(deals, { app_token: e.target.value })} placeholder={secretPh(deals.hint, 'App token')} autoComplete="new-password" style={field} /></div>
          </div>
          <div style={{ ...label, marginTop: '14px' }}>Extra apps (optional)</div>
          {extras.map((a, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '150px 1fr 1fr auto', gap: '8px', marginBottom: '8px' }}>
              <select value={a.key} onChange={(e) => editApp(a, { key: e.target.value as PodioAppKey })} style={field}>{EXTRA_KEYS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input value={a.app_id} onChange={(e) => editApp(a, { app_id: e.target.value.replace(/\D/g, '') })} placeholder="App ID" inputMode="numeric" style={field} />
              <input type="password" value={a.app_token} onChange={(e) => editApp(a, { app_token: e.target.value })} placeholder={secretPh(a.hint, 'App token')} autoComplete="new-password" style={field} />
              <button type="button" onClick={() => setApps(v.apps.filter((x) => x !== a))} style={btn}>Remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setApps([...v.apps, { key: 'contacts', app_id: '', app_token: '', hint: null }])} style={btn}>Add app</button>
          {note ? <Note {...note} /> : null}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
            <button type="button" disabled={busy || !draft} onClick={() => void run('save')} style={{ ...primary, opacity: busy || !draft ? 0.6 : 1 }}>{busy ? 'Working…' : 'Save'}</button>
            <button type="button" disabled={busy} onClick={() => void run('test')} style={btn}>Test connection</button>
            <button type="button" disabled={busy || !s?.connected} onClick={() => setFlow(true)} style={{ ...btn, opacity: s?.connected ? 1 : 0.5 }}>Import deals</button>
            {s?.connected ? <button type="button" disabled={busy} onClick={() => void run('disconnect')} style={{ ...btn, color: '#b91c1c' }}>Disconnect</button> : null}
          </div>
          {s?.sync?.available && s.client_id_hint ? <SyncPanel workspaceId={workspaceId!} sync={s.sync} onChanged={() => { setNonce((n) => n + 1); onImported?.(); }} /> : null}
        </>
      ) : null}
      {flow && workspaceId ? (
        <ImportFlow workspaceId={workspaceId} isMobile={isMobile} onClose={() => { setFlow(false); setNonce((n) => n + 1); }}
          onOpenSeller={onOpenSeller ? (id) => { setFlow(false); onOpenSeller(id); } : undefined} onImported={onImported} />
      ) : null}
    </div>
  );
}

// ---- the live sync -------------------------------------------------------------

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

/** The ten-minute Podio → CLOZR sync: when it last ran, what it did, what it could not place, and Sync now. */
function SyncPanel({ workspaceId, sync, onChanged }: { workspaceId: number; sync: Extract<PodioSyncStatus, { available: true }>; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const has = (k: string) => sync.apps.includes(k);
  const unmapped = Object.entries(sync.unmapped).sort((a, b) => b[1] - a[1]);
  const progress = syncProgress(sync.last_run?.progress);

  async function syncNow() {
    setBusy(true); setNote(null);
    try {
      const r = await podio<PodioSyncResult>(workspaceId, 'sync');
      if (r.skipped) setNote({ ok: false, text: r.skipped });
      else if (r.error) setNote({ ok: false, text: r.error });
      else if (r.counts) setNote({ ok: true, text: syncSummary({ counts: r.counts }) + (syncProgress(r.progress).length ? ' · more to come on the next run' : '') });
      onChanged();
    } catch (e) { setNote({ ok: false, text: errText(e) }); }
    setBusy(false);
  }
  async function toggle() {
    setBusy(true); setNote(null);
    try { await podio(workspaceId, 'sync_enabled', { enabled: !sync.enabled }); onChanged(); } catch (e) { setNote({ ok: false, text: errText(e) }); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid #f4f4f5' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <span style={{ ...h2, margin: 0 }}>Live sync</span>
        <span style={badge(sync.enabled && (has('submissions') || has('deals')))}>{!sync.enabled ? 'paused' : sync.running ? 'running' : 'every 10 min'}</span>
      </div>
      <p style={sub}>
        CLOZR reads the Submissions and Deals apps for items Podio changed and updates the submission or deal each one already is here
        (stage, offer, numbers, team), or adds it. A value someone changed in CLOZR stays until it changes in Podio again; nothing is ever blanked.
        {' '}A submission someone moves in CLOZR is moved in Podio too, on the next run, and so are its low offer, high offer and offer price.
        {' '}Apps: Submissions {has('submissions') ? '✓' : '— add it under Extra apps'} · Deals {has('deals') ? '✓' : '— not saved'}.
        {' '}Last sync: {when(sync.last_sync_at)}{sync.linked ? ` · ${sync.linked.toLocaleString('en-US')} Podio items linked` : ''}.
      </p>
      {sync.last_run?.counts ? <div style={{ fontSize: '12.5px', color: '#3f3f46', marginBottom: '6px' }}>Last run ({when(sync.last_run.at)}): {syncSummary(sync.last_run)}</div> : null}
      {(sync.warnings?.length ? sync.warnings : sync.last_run?.warnings ?? []).map((w) => <div key={w} style={{ fontSize: '12.5px', color: '#9a3412', marginBottom: '6px' }}>{w}</div>)}
      {progress.length ? <div style={{ fontSize: '12.5px', color: '#3f3f46', marginBottom: '6px' }}>In progress: {progress.join(' · ')}. Each run picks up where the last stopped.</div> : null}
      {sync.last_error ? <Note ok={false} text={`Last run stopped: ${sync.last_error}`} /> : null}
      {sync.push && (sync.push.waiting || sync.push.sent || sync.push.skipped || sync.push.failed) ? (
        <div data-testid="podio-push" style={{ fontSize: '12.5px', color: '#3f3f46', marginBottom: '6px' }}>
          Changes sent to Podio: {sync.push.sent.toLocaleString('en-US')}
          {sync.push.waiting ? ` · ${sync.push.waiting.toLocaleString('en-US')} waiting for the next run` : ''}
          {sync.push.skipped ? ` · ${sync.push.skipped.toLocaleString('en-US')} not sent (no such stage or field in Podio, or Podio changed it later)` : ''}
          {sync.push.failed ? ` · ${sync.push.failed.toLocaleString('en-US')} failed` : ''}
          {sync.push.recent.length ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: '18px', color: '#71717a' }}>
              {sync.push.recent.slice(0, 5).map((r) => <li key={`${r.item_id}-${r.done_at}`}>Item {r.item_id}{r.to_stage ? ` → ${r.to_stage}` : ' · offer amounts'}: {r.result}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      {unmapped.length ? (
        <div style={{ marginTop: '8px', fontSize: '12.5px', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '9px', padding: '8px 11px', lineHeight: 1.5 }}>
          Podio stages CLOZR has no stage for. These records got their other updates and kept their CLOZR stage:
          {' '}{unmapped.map(([l, n]) => `${l} (${n})`).join(' · ')}
        </div>
      ) : null}
      {sync.unmatched ? (
        <div style={{ marginTop: '8px', fontSize: '12.5px', color: '#52525b' }}>
          {sync.unmatched.toLocaleString('en-US')} Podio item{sync.unmatched === 1 ? '' : 's'} left alone: a test entry, no street address, or more than one CLOZR submission it could be (each is noted in the sync log, table podio_items).
        </div>
      ) : null}
      {note ? <Note {...note} /> : null}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
        <button type="button" disabled={busy || sync.running || !(has('submissions') || has('deals'))} onClick={() => void syncNow()} style={{ ...primary, opacity: busy || sync.running ? 0.6 : 1 }}>{busy ? 'Syncing…' : 'Sync now'}</button>
        <button type="button" disabled={busy} onClick={() => void toggle()} style={btn}>{sync.enabled ? 'Pause live sync' : 'Resume live sync'}</button>
      </div>
    </div>
  );
}

// ---- the import --------------------------------------------------------------

type Step = 'map' | 'preview' | 'import';
const BATCH = 10;

function ImportFlow({ workspaceId, isMobile, onClose, onOpenSeller, onImported }: {
  workspaceId: number; isMobile: boolean; onClose: () => void; onOpenSeller?: (id: number) => void; onImported?: () => void;
}) {
  const [step, setStep] = useState<Step>('map');
  const [spec, setSpec] = useState<PodioInspect | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [stageIds, setStageIds] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [deals, setDeals] = useState<PodioDeal[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<PodioImportResult | null>(null);

  useEffect(() => {
    let live = true;
    podio<PodioInspect>(workspaceId, 'inspect').then((r) => {
      if (!live) return;
      setSpec(r); setMapping(r.mapping); setStageIds(r.stage_options.filter((o) => o.checked).map((o) => o.id));
    }).catch((e) => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [workspaceId]);

  const stageField = spec?.fields.find((f) => f.external_id === mapping.stage);
  const groups = useMemo(() => {
    const g = new Map<string, NonNullable<typeof spec>['targets']>();
    for (const t of spec?.targets ?? []) g.set(t.group, [...(g.get(t.group) ?? []), t]);
    return [...g.entries()];
  }, [spec]);

  async function loadPreview() {
    setErr(null); setDeals([]); setWarnings([]); setStep('preview');
    const all: PodioDeal[] = []; const warn = new Set<string>();
    try {
      for (let offset = 0, total = 1; offset < total; offset += 25) {
        const r = await podio<PodioPreview>(workspaceId, 'preview', { mapping, stage_option_ids: stageIds, offset, limit: 25 });
        total = r.total; all.push(...r.deals); r.warnings.forEach((w) => warn.add(w));
        setDeals([...all]); setWarnings([...warn]); setLoading({ done: all.length, total });
        if (!r.deals.length) break;
      }
      setPicked(new Set(all.filter((d) => d.stage).map((d) => d.item_id)));
    } catch (e) { setErr(errText(e)); }
    setLoading(null);
  }

  async function runImport() {
    const ids = deals.filter((d) => picked.has(d.item_id)).map((d) => d.item_id);
    setErr(null); setStep('import'); setResult(null);
    const sum: PodioImportResult = { counts: { deals: { created: 0, updated: 0 }, sellers: { created: 0, updated: 0 }, buyers: { created: 0, updated: 0 }, vendors: { created: 0, updated: 0 }, properties: { created: 0, updated: 0 }, transactions: { created: 0, updated: 0 }, parties: 0, skipped: 0 }, imported: [], errors: [], warnings: [] };
    for (let i = 0; i < ids.length; i += BATCH) {
      setLoading({ done: i, total: ids.length });
      try {
        const r = await podio<PodioImportResult>(workspaceId, 'import', { mapping, stage_option_ids: stageIds, item_ids: ids.slice(i, i + BATCH) });
        for (const k of ['deals', 'sellers', 'buyers', 'vendors', 'properties', 'transactions'] as const) { sum.counts[k].created += r.counts[k].created; sum.counts[k].updated += r.counts[k].updated; }
        sum.counts.parties += r.counts.parties; sum.counts.skipped += r.counts.skipped;
        sum.imported.push(...r.imported); sum.errors.push(...r.errors);
        setResult({ ...sum });
        if (r.errors.some((e) => e.message.includes('rate limit'))) { setErr('Podio rate limit reached. Wait a few minutes, then run the import again — deals already imported are updated, not duplicated.'); break; }
      } catch (e) { setErr(errText(e)); break; }
    }
    setLoading(null); setResult({ ...sum }); onImported?.();
  }

  const shell: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 60, background: '#fafafa', display: 'flex', flexDirection: 'column' };
  const td: React.CSSProperties = { padding: '9px 10px', borderBottom: '1px solid #f0f0f1', verticalAlign: 'top', fontSize: '12.5px' };

  return (
    <div role="dialog" aria-label="Import deals from Podio" style={shell}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', background: '#fff', borderBottom: '1px solid #e4e4e7', flex: 'none', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Import from Podio</h1>
        {(['map', 'preview', 'import'] as Step[]).map((k, i) => (
          <span key={k} style={{ fontSize: '12.5px', color: step === k ? '#18181b' : '#a1a1aa', fontWeight: step === k ? 600 : 400 }}>{i + 1} · {k === 'map' ? 'Stages and mapping' : k === 'preview' ? 'Preview' : 'Import'}</span>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} disabled={!!loading && step === 'import'} style={btn}>Close</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '14px' : '18px 22px' }}>
        <div style={{ maxWidth: '1100px' }}>
          {err ? <div style={{ ...card, background: '#fee2e2', borderColor: '#fecaca', color: '#b91c1c', fontSize: '12.5px' }}>{err}</div> : null}
          {!spec && !err ? <div style={card}><p style={sub}>Reading the Podio app’s fields…</p></div> : null}

          {spec && step === 'map' ? (
            <>
              <div style={card}>
                <h2 style={h2}>Stages</h2>
                <p style={sub}>Deals in the ticked Podio stages are imported. Each lands on the CLOZR deal stage shown.</p>
                <label style={label}>Stage field</label>
                <select value={mapping.stage ?? ''} onChange={(e) => { setMapping({ ...mapping, stage: e.target.value }); const f = spec.fields.find((x) => x.external_id === e.target.value); setStageIds((f?.options ?? []).filter((o) => o.clozr && ['Under Contract Seller', 'In Escrow', 'Buyer Under Contract'].includes(o.clozr)).map((o) => o.id)); }} style={{ ...field, maxWidth: '360px' }}>
                  <option value="">—</option>
                  {spec.fields.filter((f) => f.type === 'category').map((f) => <option key={f.external_id} value={f.external_id}>{f.label}</option>)}
                </select>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: '12px' }}>
                  {(stageField?.options ?? []).map((o) => (
                    <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={stageIds.includes(o.id)} onChange={(e) => setStageIds(e.target.checked ? [...stageIds, o.id] : stageIds.filter((x) => x !== o.id))} style={{ accentColor: '#0A8560' }} />
                      {o.text} <span style={{ color: o.clozr ? '#71717a' : '#c2410c', fontSize: '12px' }}>→ {o.clozr ?? 'no CLOZR stage (skipped)'}</span>
                    </label>
                  ))}
                </div>
              </div>
              {spec.referenced_apps.some((a) => !a.has_token) ? (
                <div style={{ ...card, background: '#fff7ed', borderColor: '#fed7aa', fontSize: '12.5px', color: '#9a3412', lineHeight: 1.5 }}>
                  The Deals app points at Podio apps with no token saved ({spec.referenced_apps.filter((a) => !a.has_token).map((a) => a.app_id).join(', ')}). People in those apps come over by name only — add their app ID and token under Extra apps for phones and emails.
                </div>
              ) : null}
              <div style={card}>
                <h2 style={h2}>Mapping · {spec.app.name}</h2>
                <p style={sub}>Guessed from the Podio field names. Change anything that is wrong; blank means CLOZR leaves that field alone.</p>
                {groups.map(([g, ts]) => (
                  <div key={g} style={{ marginBottom: '12px' }}>
                    <div style={{ ...label, marginTop: '6px' }}>{g}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: '6px 16px' }}>
                      {ts.filter((t) => t.key !== 'stage').map((t) => {
                        const opts = spec.fields.filter((f) => t.types.includes(f.type));
                        return (
                          <label key={t.key} style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: '8px', alignItems: 'center', fontSize: '12.5px' }}>
                            <span style={{ color: '#3f3f46' }}>{t.label}{mapping[t.key] && mapping[t.key] === spec.guess[t.key] ? <span style={{ color: '#a1a1aa' }}> · guessed</span> : null}</span>
                            <select value={mapping[t.key] ?? ''} onChange={(e) => { const next = { ...mapping }; if (e.target.value) next[t.key] = e.target.value; else delete next[t.key]; setMapping(next); }} style={{ ...field, height: '30px', fontSize: '12.5px' }}>
                              <option value="">—</option>
                              {opts.map((f) => <option key={f.external_id} value={f.external_id}>{f.label} ({f.type})</option>)}
                            </select>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <button disabled={!mapping.stage || !stageIds.length} onClick={() => void loadPreview()} style={{ ...primary, opacity: !mapping.stage || !stageIds.length ? 0.6 : 1 }}>Preview deals</button>
            </>
          ) : null}

          {step === 'preview' ? (
            <>
              <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>{loading ? `Loading ${loading.done} of ${loading.total}…` : `${deals.length} deals · ${picked.size} selected`}</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => setStep('map')} disabled={!!loading} style={btn}>Back to mapping</button>
                <button onClick={() => setPicked(picked.size ? new Set() : new Set(deals.filter((d) => d.stage).map((d) => d.item_id)))} disabled={!!loading} style={btn}>{picked.size ? 'Select none' : 'Select all'}</button>
                <button onClick={() => void runImport()} disabled={!!loading || !picked.size} style={{ ...primary, opacity: loading || !picked.size ? 0.6 : 1 }}>Import {picked.size} deals</button>
              </div>
              {warnings.length ? <div style={{ ...card, background: '#fff7ed', borderColor: '#fed7aa', fontSize: '12.5px', color: '#9a3412', lineHeight: 1.5 }}>{warnings.map((w) => <div key={w}>{w}</div>)}</div> : null}
              <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '820px' }}>
                  <thead><tr style={{ textAlign: 'left', background: '#fafafa' }}>
                    <th style={{ ...td, width: '30px' }} />
                    <th style={{ ...td, ...label, margin: 0 }}>Deal</th>
                    <th style={{ ...td, ...label, margin: 0 }}>Stage</th>
                    <th style={{ ...td, ...label, margin: 0 }}>Parties</th>
                  </tr></thead>
                  <tbody>
                    {deals.map((d) => (
                      <tr key={d.item_id} style={{ opacity: d.stage ? 1 : 0.55 }}>
                        <td style={td}><input type="checkbox" disabled={!d.stage} checked={picked.has(d.item_id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(d.item_id); else n.delete(d.item_id); setPicked(n); }} style={{ accentColor: '#0A8560' }} /></td>
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{d.address ?? d.title}</div>
                          <div style={{ color: '#71717a', fontSize: '11.5px' }}>{d.link ? <a href={d.link} target="_blank" rel="noreferrer" style={{ color: '#71717a' }}>Podio #{d.item_id}</a> : `Podio #${d.item_id}`} · <span style={badge(!!d.existing_deal_id)}>{d.existing_deal_id ? 'Update' : 'New deal'}</span></div>
                          {d.warnings.map((w) => <div key={w} style={{ color: '#c2410c', fontSize: '11.5px', marginTop: '3px' }}>{w}</div>)}
                        </td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>{d.podio_stage ?? '—'}<div style={{ color: '#71717a', fontSize: '11.5px' }}>→ {d.stage ?? 'skipped'}</div></td>
                        <td style={td}>
                          {d.parties.length ? d.parties.map((p, i) => (
                            <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap', padding: '1px 0' }}>
                              <span style={{ color: '#71717a', minWidth: '96px' }}>{p.target === 'title_contact' ? 'Title contact' : PARTY_ROLE_LABEL[p.role] ?? p.role}</span>
                              <span style={{ fontWeight: 500 }}>{p.name || p.company || '—'}</span>
                              {p.company && p.company !== p.name ? <span style={{ color: '#71717a' }}>{p.company}</span> : null}
                              {p.phone || p.email ? <span style={{ color: '#a1a1aa', fontSize: '11.5px' }}>{[p.phone, p.email].filter(Boolean).join(' · ')}</span> : null}
                              {p.target !== 'title_contact' ? <span style={badge(!!p.match)} title={p.match ? `Matches ${p.match.table}: ${p.match.label}` : undefined}>{p.match ? (p.match.table === 'team' ? 'Teammate' : 'Match') : p.role === 'tc' || p.role === 'acquisitions' || p.role === 'dispositions' ? 'Unmatched' : 'New'}</span> : null}
                            </div>
                          )) : <span style={{ color: '#a1a1aa' }}>No parties mapped</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!deals.length && !loading ? <p style={{ ...sub, padding: '16px' }}>No Podio deals in those stages.</p> : null}
              </div>
            </>
          ) : null}

          {step === 'import' ? (
            <div style={card}>
              <h2 style={h2}>{loading ? `Importing ${loading.done} of ${loading.total}…` : 'Import finished'}</h2>
              <div style={{ height: '6px', borderRadius: '3px', background: '#f0f0f1', overflow: 'hidden', margin: '8px 0 14px' }}>
                <div style={{ height: '100%', width: `${loading ? Math.round((loading.done / Math.max(loading.total, 1)) * 100) : 100}%`, background: '#0A8560', transition: 'width .3s' }} />
              </div>
              {result ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: '8px', marginBottom: '12px' }}>
                    {(['deals', 'sellers', 'buyers', 'vendors', 'properties', 'transactions'] as const).map((k) => (
                      <div key={k} style={{ padding: '10px 12px', borderRadius: '10px', background: '#fafafa', border: '1px solid #f0f0f1' }}>
                        <div style={label}>{k === 'transactions' ? 'TC files' : k}</div>
                        <div style={{ fontSize: '13px' }}><b>{result.counts[k].created}</b> new · <b>{result.counts[k].updated}</b> updated</div>
                      </div>
                    ))}
                    <div style={{ padding: '10px 12px', borderRadius: '10px', background: '#fafafa', border: '1px solid #f0f0f1' }}><div style={label}>Deal team rows</div><div style={{ fontSize: '13px' }}><b>{result.counts.parties}</b> · {result.counts.skipped} skipped</div></div>
                  </div>
                  {result.errors.map((e) => <div key={e.item_id} style={{ color: '#b91c1c', fontSize: '12.5px' }}>Podio #{e.item_id}: {e.message}</div>)}
                  {result.imported.map((r) => (
                    <div key={r.item_id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12.5px' }}>
                      <span style={{ flex: 1, fontWeight: 500 }}>{r.address}</span>
                      {r.seller_id && onOpenSeller ? <button onClick={() => onOpenSeller(r.seller_id!)} style={{ ...btn, height: '28px' }}>Open seller and deal</button> : null}
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
