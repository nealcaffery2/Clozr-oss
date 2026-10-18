'use client';

/**
 * Settings → Integrations → Zapier & webhooks (owner/admin).
 *
 * Inbound reuses ingest keys: a `zapier` or `jotform` key posts flat JSON (or
 * Jotform's form post) to the same ingest function. Outbound subscriptions are
 * delivered by Postgres itself (migration 41), signed with a per-subscription
 * secret that is shown once. Contract and recipes: docs/webhooks.md.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { type IngestKey, type MintedKey, ingestKeyUrl, ingestUrl, issueKey, listKeys, setKeySetting } from '@/lib/ingest';
import {
  INBOUND_SAMPLES, WEBHOOK_EVENTS, type JotformForm, type WebhookDeliveryRow, type WebhookSubscriptionRow,
  deleteSubscription, jotformForms, jotformImportPage, listDeliveries, listSubscriptions, retryDelivery,
  sendTest, setSubscriptionActive, subscribe,
} from '@/lib/webhooks';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const sub: React.CSSProperties = { margin: '16px 0 6px', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink, #18181b)' };
const muted: React.CSSProperties = { margin: '0 0 8px', fontSize: '12px', color: 'var(--meta, #71717a)', lineHeight: 1.55 };
const field: React.CSSProperties = { height: '32px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', outline: 0, minWidth: 0, fontFamily: 'inherit' };
const btn: React.CSSProperties = { height: '30px', padding: '0 11px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)', flex: 'none' };
const primary: React.CSSProperties = { ...btn, border: '1px solid #0A8560', background: '#0A8560', color: '#fff' };
const codeBox: React.CSSProperties = { display: 'block', fontSize: '11.5px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '7px', padding: '8px 10px', overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'ui-monospace, monospace', margin: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '9px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)' };

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="dc2" style={btn} onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true))}>
      {done ? 'Copied' : label}
    </button>
  );
}

function statusColor(s: string | null) {
  return s === 'delivered' ? '#0A8560' : s === 'failed' ? '#b91c1c' : s ? '#92400e' : 'var(--subtle, #a1a1aa)';
}

export function ZapierWebhooks({ workspaceId, admin, demo }: { workspaceId: number | null; admin: boolean; demo: boolean }) {
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [subs, setSubs] = useState<WebhookSubscriptionRow[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [sample, setSample] = useState('lead.create');
  const [url, setUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [events, setEvents] = useState<string[]>(['seller.created']);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId || !admin || demo) return;
    let live = true;
    void Promise.all([listKeys(workspaceId), listSubscriptions(workspaceId), listDeliveries(workspaceId)]).then(([k, s, d]) => {
      if (!live) return;
      setKeys(k);
      setSubs(s);
      setDeliveries(d);
    });
    return () => { live = false; };
  }, [workspaceId, admin, demo, nonce]);

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setNote(r.ok ? (done ? { ok: true, text: done } : null) : { ok: false, text: r.message ?? 'That did not work.' });
    refresh();
    return r.ok;
  }

  async function mint(name: 'zapier' | 'jotform') {
    if (!workspaceId) return;
    setBusy(true);
    const r = await issueKey(workspaceId, name, name === 'zapier' ? 'Zapier / Webhook' : 'Jotform');
    setBusy(false);
    if (!r.ok) setNote({ ok: false, text: r.message ?? 'Could not issue a key.' });
    else { setMinted(r.key ?? null); setNote(null); }
    refresh();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setBusy(true);
    const r = await subscribe(workspaceId, url.trim(), events, desc.trim());
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.message }); return; }
    setSecret(r.data.secret);
    setUrl('');
    setDesc('');
    setNote(null);
    refresh();
  }

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Zapier &amp; webhooks</h2>
      <p style={muted}>Send leads in from Zapier, Make, n8n or Jotform, and push CLOZR events out to any URL. Each key files submissions as a seller, a wholesaler, or a buyer.</p>

      {demo ? (
        <p style={muted}>Supabase isn&rsquo;t configured for this deployment.</p>
      ) : !admin ? (
        <p style={muted}>Only an owner or admin can manage Zapier and webhooks.</p>
      ) : (
        <>
          {note ? (
            <div role="status" style={{ margin: '8px 0', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', border: `1px solid ${note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)'}`, color: note.ok ? 'var(--tx-green, #15803d)' : '#b91c1c' }}>{note.text}</div>
          ) : null}

          {/* ------------------------------------------------------------ inbound */}
          <div style={sub}>Inbound — into CLOZR</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="dc3" style={primary} disabled={busy} onClick={() => void mint('zapier')}>Create Zapier / webhook key</button>
            <button type="button" className="dc3" style={primary} disabled={busy} onClick={() => void mint('jotform')}>Create Jotform key</button>
          </div>

          {minted ? (
            <div style={{ marginTop: '10px', padding: '12px 13px', borderRadius: '10px', background: 'var(--mint-dim, #e7f8f1)', border: '1px solid #A8ECD2' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tx-mint, #0a8560)', fontWeight: 700, marginBottom: '8px' }}>
                Copy now — the key isn&rsquo;t shown again
              </div>
              <div style={{ ...row, borderTop: 0, padding: '3px 0' }}>
                <code style={{ ...codeBox, flex: '1 1 240px' }}>{ingestKeyUrl(minted.key)}</code>
                <Copy text={ingestKeyUrl(minted.key)} label="Copy URL with key" />
              </div>
              <div style={{ ...row, borderTop: 0, padding: '3px 0' }}>
                <code style={{ ...codeBox, flex: '1 1 240px' }}>{`Authorization: Bearer ${minted.key}`}</code>
                <Copy text={minted.key} label="Copy key" />
                <button type="button" className="dc2" style={btn} onClick={() => setMinted(null)}>Done</button>
              </div>
              <p style={{ ...muted, margin: '6px 0 0' }}>
                Prefer the header where the app allows it: <code>{ingestUrl()}</code> with the Authorization header keeps the key out of URLs and logs.
              </p>
            </div>
          ) : null}

          <p style={{ ...muted, marginTop: '12px' }}>
            <strong style={{ color: 'var(--ink, #18181b)' }}>Zapier:</strong> 1. Add an action step <em>Webhooks by Zapier → POST</em>.
            2. URL: the key URL above (or the plain URL with header <code>Authorization: Bearer clz_…</code>). Payload type: <em>JSON</em>.
            3. Data: one row per field below — <code>event</code> plus the fields you have. Lead and buyer events create or merge a record;
            <code> note.add</code>, <code>activity.log</code> and <code>email.opened</code> only attach to an existing seller or buyer matched by email or phone and never create a lead.
          </p>
          <div style={{ ...row, borderTop: 0 }}>
            <select value={sample} onChange={(e) => setSample(e.target.value)} style={field}>
              {Object.keys(INBOUND_SAMPLES).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <Copy text={JSON.stringify(INBOUND_SAMPLES[sample], null, 2)} label="Copy sample JSON" />
          </div>
          <pre style={codeBox}>{JSON.stringify(INBOUND_SAMPLES[sample], null, 2)}</pre>
          <p style={{ ...muted, marginTop: '6px' }}>Response: <code>{'{ "ok": true, "id": 812, "deduped": false, "matched": true }'}</code>. Send a stable <code>external_id</code> so retries dedupe.</p>

          <p style={{ ...muted, marginTop: '12px' }}>
            <strong style={{ color: 'var(--ink, #18181b)' }}>Jotform:</strong> create one Jotform key per form, then in Jotform open the form → <em>Settings → Integrations</em> →
            search <em>WebHooks</em> → paste the key URL (with <code>?key=</code>) → <em>Complete integration</em>. A disposition request fills What we know
            (entity, occupancy, closing date, beds, ARV, rehab, garage, photos, MLS, InvestorLift, lease, contract). Anything still unrecognised is kept as a note.
          </p>
          {keys.filter((k) => k.name === 'zapier').map((k) => (
            <div key={k.id} style={{ margin: '8px 0', padding: '11px 13px', borderRadius: '10px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)' }}>
              <div style={{ ...row, borderTop: 0, padding: 0 }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, flex: '1 1 160px', color: k.active ? 'var(--ink, #18181b)' : 'var(--subtle, #a1a1aa)' }}>
                  {k.label || 'Zapier / Webhook'} <span style={{ fontWeight: 400, color: 'var(--subtle, #a1a1aa)', fontFamily: 'ui-monospace, monospace' }}>{k.key_prefix}…</span>
                </span>
                <Creates k={k} busy={busy} run={run} />
              </div>
              <p style={{ ...muted, margin: '6px 0 0' }}>Used when the POST leaves <code>event</code> out. A body that sets <code>event</code> still wins. Who new leads go to: Settings → Round robin.</p>
            </div>
          ))}
          {keys.filter((k) => k.name === 'jotform').map((k) => (
            <JotformKey key={k.id} row={k} workspaceId={workspaceId!} busy={busy} run={run} />
          ))}

          {/* ----------------------------------------------------------- outbound */}
          <div style={sub}>Outbound — from CLOZR</div>
          <p style={muted}>
            For a Zapier trigger use <em>Webhooks by Zapier → Catch Hook</em> and paste its URL here. Each POST is JSON with headers
            <code> X-Clozr-Event</code>, <code>X-Clozr-Delivery</code> and <code>X-Clozr-Signature: t=…,v1=…</code> (HMAC-SHA256 of <code>t.body</code> with the secret).
            Failed deliveries retry for about 5 hours.
          </p>

          {secret ? (
            <div style={{ margin: '8px 0', padding: '12px 13px', borderRadius: '10px', background: 'var(--mint-dim, #e7f8f1)', border: '1px solid #A8ECD2' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--tx-mint, #0a8560)', fontWeight: 700, marginBottom: '8px' }}>Signing secret — shown once</div>
              <div style={{ ...row, borderTop: 0, padding: 0 }}>
                <code style={{ ...codeBox, flex: '1 1 240px' }}>{secret}</code>
                <Copy text={secret} />
                <button type="button" className="dc2" style={btn} onClick={() => setSecret(null)}>Done</button>
              </div>
            </div>
          ) : null}

          {subs.map((s) => (
            <div key={s.id} style={row}>
              <span style={{ flex: '1 1 220px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: s.active ? 'var(--ink, #18181b)' : 'var(--subtle, #a1a1aa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description || s.url}</span>
                <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--subtle, #a1a1aa)' }}>
                  {s.description ? `${s.url} · ` : ''}{s.events.join(', ')}
                </span>
                {s.last_status ? (
                  <span style={{ display: 'block', fontSize: '11.5px', color: statusColor(s.last_status) }}>
                    {s.last_status}{s.last_error ? ` — ${s.last_error}` : ''}{s.last_delivered_at ? ` · last delivered ${new Date(s.last_delivered_at).toLocaleString()}` : ''}
                  </span>
                ) : null}
              </span>
              <button type="button" className="dc2" style={btn} disabled={busy} onClick={() => void run(() => sendTest(s.id), 'Test queued — refresh in a minute for the response.')}>Send test</button>
              <button type="button" className="dc2" style={btn} disabled={busy} onClick={() => void run(() => setSubscriptionActive(s.id, !s.active))}>{s.active ? 'Pause' : 'Resume'}</button>
              <button type="button" className="dc2" style={{ ...btn, color: 'var(--tx-red, #b91c1c)' }} disabled={busy} onClick={() => { if (window.confirm('Delete this webhook and its delivery history?')) void run(() => deleteSubscription(s.id)); }}>Delete</button>
            </div>
          ))}

          <form onSubmit={(e) => void add(e)} style={{ marginTop: '10px', padding: '12px 13px', borderRadius: '10px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input type="url" required placeholder="https://hooks.zapier.com/hooks/catch/…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ ...field, flex: '2 1 260px' }} />
              <input placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...field, flex: '1 1 160px' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 12px', margin: '10px 0' }}>
              {WEBHOOK_EVENTS.map((ev) => (
                <label key={ev.name} style={{ display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', color: 'var(--ink-3, #3f3f46)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={events.includes(ev.name)} style={{ accentColor: 'var(--tx-mint, #0a8560)' }}
                    onChange={(e) => setEvents((cur) => e.target.checked ? [...cur, ev.name] : cur.filter((x) => x !== ev.name))} />
                  {ev.label}
                </label>
              ))}
            </div>
            <button type="submit" className="dc3" style={primary} disabled={busy || !url.trim() || !events.length}>Add webhook</button>
          </form>

          {deliveries.length ? (
            <>
              <div style={{ ...sub, display: 'flex', alignItems: 'center', gap: '8px' }}>
                Recent deliveries
                <button type="button" className="dc2" style={btn} onClick={refresh}>Refresh</button>
              </div>
              {deliveries.map((d) => (
                <div key={d.id} style={{ ...row, padding: '6px 0', fontSize: '12px' }}>
                  <code style={{ fontSize: '11.5px', flex: '0 0 170px' }}>{d.event}</code>
                  <span style={{ color: statusColor(d.status), fontWeight: 600, flex: '0 0 70px' }}>{d.status}</span>
                  <span style={{ color: 'var(--meta, #71717a)', flex: '1 1 160px', minWidth: 0 }}>
                    {d.response_code ? `HTTP ${d.response_code}` : ''}{d.error ? ` ${d.error}` : ''} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'} · {new Date(d.created_at).toLocaleString()}
                  </span>
                  {d.status === 'failed' || d.status === 'retrying' ? (
                    <button type="button" className="dc2" style={btn} disabled={busy} onClick={() => void run(() => retryDelivery(d.id), 'Retry sent.')}>Retry</button>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function Creates({ k, busy, run }: {
  k: IngestKey;
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) => Promise<boolean>;
}) {
  return (
    <label style={{ fontSize: '12px', color: 'var(--muted, #52525b)' }}>
      Creates{' '}
      <select value={k.creates} disabled={busy} style={field} aria-label={`What ${k.label || k.name} creates`}
        onChange={(e) => void run(() => setKeySetting(k.id, 'creates', e.target.value), 'That key now files ' + (e.target.value === 'wholesaler' ? 'wholesalers' : e.target.value === 'buyer' ? 'buyers' : 'sellers') + '.')}>
        <option value="seller">Seller lead</option>
        <option value="wholesaler">Wholesaler</option>
        <option value="buyer">Buyer</option>
      </select>
    </label>
  );
}

/** One Jotform key: what it creates, the API key for backfill, and the import itself. */
function JotformKey({ row: k, workspaceId, busy, run }: {
  row: IngestKey;
  workspaceId: number;
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) => Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [forms, setForms] = useState<JotformForm[] | null>(null);
  const [formId, setFormId] = useState('');
  const [progress, setProgress] = useState<string | null>(null);

  async function loadForms() {
    setProgress('Loading forms…');
    const r = await jotformForms(workspaceId, k.id);
    if (!r.ok) { setProgress(r.message); return; }
    setForms(r.data.forms);
    setFormId(r.data.forms[0]?.id ?? '');
    setProgress(null);
  }

  async function importAll() {
    const t = { created: 0, deduped: 0, updated: 0, skipped: 0 };
    const line = () => `${t.created} created · ${t.updated ? `${t.updated} updated (edited in Jotform) · ` : ''}${t.deduped} already here · ${t.skipped} skipped`;
    let offset: number | null = 0;
    while (offset !== null) {
      setProgress(`Importing… ${line()}`);
      const r = await jotformImportPage(workspaceId, k.id, formId, offset);
      if (!r.ok) { setProgress(`Stopped: ${r.message} (${t.created} created so far — run again to resume, nothing duplicates)`); return; }
      t.created += r.data.created; t.deduped += r.data.deduped; t.updated += r.data.updated ?? 0; t.skipped += r.data.skipped;
      offset = r.data.next_offset;
    }
    setProgress(`Done: ${line()}`);
  }

  return (
    <div style={{ margin: '8px 0', padding: '11px 13px', borderRadius: '10px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)' }}>
      <div style={{ ...row, borderTop: 0, padding: 0 }}>
        <span style={{ fontSize: '12.5px', fontWeight: 600, flex: '1 1 160px', color: k.active ? 'var(--ink, #18181b)' : 'var(--subtle, #a1a1aa)' }}>
          {k.label || 'Jotform'} <span style={{ fontWeight: 400, color: 'var(--subtle, #a1a1aa)', fontFamily: 'ui-monospace, monospace' }}>{k.key_prefix}…</span>
        </span>
        <Creates k={k} busy={busy} run={run} />
      </div>
      <div style={{ ...row, borderTop: 0, padding: '8px 0 0' }}>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ ...field, flex: '1 1 200px' }}
          placeholder={k.has_api_key ? 'Jotform API key stored — paste to replace' : 'Jotform API key (Account → API) for importing past submissions'} />
        <button type="button" className="dc2" style={btn} disabled={busy || apiKey.trim().length < 16}
          onClick={() => void run(() => setKeySetting(k.id, 'jotform_api_key', apiKey.trim()), 'Jotform API key saved.').then((ok) => ok && setApiKey(''))}>
          Save API key
        </button>
        <button type="button" className="dc2" style={btn} disabled={!!progress?.startsWith('Importing')} onClick={() => void loadForms()}>Import past submissions</button>
      </div>
      {forms ? (
        <div style={{ ...row, borderTop: 0, padding: '8px 0 0' }}>
          <select value={formId} onChange={(e) => setFormId(e.target.value)} style={{ ...field, flex: '1 1 220px' }}>
            {forms.map((f) => <option key={f.id} value={f.id}>{f.title} ({f.count})</option>)}
          </select>
          <button type="button" className="dc3" style={primary} disabled={!formId || !!progress?.startsWith('Importing')} onClick={() => void importAll()}>Import</button>
          <button type="button" className="dc2" style={btn} disabled={busy || !formId || k.sync_form === formId}
            onClick={() => void run(() => setKeySetting(k.id, 'sync_form', formId), 'This form now syncs into CLOZR every five minutes.')}>
            {k.sync_form === formId ? 'Auto-syncing' : 'Auto-sync this form'}
          </button>
        </div>
      ) : null}
      {k.sync_form && k.sync_form !== 'off' ? (
        <div style={{ ...row, borderTop: 0, padding: '8px 0 0' }}>
          <span style={{ fontSize: '12px', color: 'var(--tx-green, #15803d)', fontWeight: 600, flex: '1 1 220px' }}>
            Auto-sync on — form {forms?.find((f) => f.id === k.sync_form)?.title ?? k.sync_form} is pulled every five minutes, webhook or not: new submissions are added and edited ones update their record.
          </span>
          <button type="button" className="dc2" style={btn} disabled={busy}
            onClick={() => void run(() => setKeySetting(k.id, 'sync_form', 'off'), 'Auto-sync off. The WebHooks integration, if set, still delivers.')}>
            Stop auto-sync
          </button>
        </div>
      ) : (
        <p style={{ ...muted, margin: '8px 0 0' }}>
          Save the API key, open <em>Import past submissions</em>, pick the form and choose <em>Auto-sync this form</em> to pull new
          submissions every five minutes even if the form&rsquo;s WebHooks integration was never set up.
        </p>
      )}
      <p style={{ ...muted, margin: '6px 0 0' }}>Who new leads from this form go to: Settings → Round robin.</p>
      {progress ? <p style={{ ...muted, margin: '8px 0 0' }}>{progress}</p> : null}
    </div>
  );
}
