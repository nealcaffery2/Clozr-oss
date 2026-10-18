'use client';

// Settings → Integrations. iVueit's API key and secret (Client Portal), which
// server (staging while testing, production after), and the survey a photo
// order runs. Save and test logs in, lists the surveys and points iVueit's
// VueCompleted webhook at CLOZR. The key and secret are write-only.

import React, { useEffect, useState } from 'react';
import { type IvueitTemplate, ivueitSettings, saveIvueit, setupIvueit } from '@/lib/ivueit';

const PRODUCTION = 'https://prod.data.ivueit.network';
const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const muted: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', fontWeight: 500, color: 'var(--meta, #71717a)', marginBottom: '4px' };
const field: React.CSSProperties = { height: '34px', width: '100%', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '13px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)' };
const btn: React.CSSProperties = { height: '34px', padding: '0 12px', borderRadius: '8px', border: '1px solid #0A8560', background: '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' };
const ghost: React.CSSProperties = { ...btn, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', borderColor: 'var(--divider, #e4e4e7)' };

export function IvueitCard({ workspaceId, admin, demo }: { workspaceId: number | null; admin: boolean; demo: boolean }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState<'production' | 'staging'>('production');
  const [stagingUrl, setStagingUrl] = useState('');
  const [templates, setTemplates] = useState<IvueitTemplate[] | null>(null);
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const off = !admin || demo || !!busy;

  useEffect(() => {
    if (!workspaceId || demo) return;
    let live = true;
    void ivueitSettings(workspaceId).then((s) => {
      if (!live || !s) return;
      setConnected(s.connected);
      if (s.base_url && s.base_url !== PRODUCTION) { setEnv('staging'); setStagingUrl(s.base_url); }
      setTemplate(s.template_id ?? '');
    });
    return () => { live = false; };
  }, [workspaceId, demo]);

  async function test() {
    if (!workspaceId) return;
    setBusy('test');
    const r = await setupIvueit(workspaceId);
    setBusy(null);
    if (!r.ok) { setNote({ text: r.message, bad: true }); return; }
    setTemplates(r.templates);
    if (!template && r.templates.length === 1) setTemplate(r.templates[0].id);
    // Which of the three webhooks took (an older function only sends the summary string).
    const set = r.webhooks_set ?? ['VueCompleted', 'VueCanceled', 'VueEscalated'].filter((t) => new RegExp(`${t} (created|updated)`).test(r.webhook));
    const hooks = ['VueCompleted', 'VueCanceled', 'VueEscalated'].every((t) => set.includes(t))
      ? ' Finished, canceled and flagged Vues report back to CLOZR on their own.'
      : set.includes('VueCompleted')
        ? ' Finished Vues report back to CLOZR on their own. Canceled and flagged Vues did not connect. Test the connection again to retry.'
        : ' Finished Vues are picked up every 20 minutes.';
    setNote({
      text: `Connected to iVueit ${r.staging ? 'staging' : 'production'}. ${r.templates.length} survey${r.templates.length === 1 ? '' : 's'} on the account.${hooks}`,
    });
  }

  async function save() {
    if (!workspaceId || off) return;
    if (env === 'staging' && !/^https:\/\//i.test(stagingUrl.trim())) { setNote({ text: 'Paste the staging URL iVueit gave you (it starts with https://).', bad: true }); return; }
    setBusy('save');
    setNote(null);
    const r = await saveIvueit(workspaceId, {
      key: key.trim() ? key : null, secret: secret.trim() ? secret : null,
      baseUrl: env === 'staging' ? stagingUrl.trim() : '',
    });
    setBusy(null);
    if (!r.ok) { setNote({ text: r.message ?? 'Could not save.', bad: true }); return; }
    setKey(''); setSecret('');
    const s = await ivueitSettings(workspaceId);
    setConnected(!!s?.connected);
    if (s?.connected) await test();
    else setNote({ text: 'Saved. Add both the API key and the secret to connect.' });
  }

  async function pickTemplate(id: string) {
    if (!workspaceId || off) return;
    setTemplate(id);
    const r = await saveIvueit(workspaceId, { templateId: id });
    setNote(r.ok ? { text: id ? 'Photo orders use that survey.' : 'Cleared. A person picks the survey on each order.' } : { text: r.message ?? 'Could not save.', bad: true });
  }

  async function disconnect() {
    if (!workspaceId || off || !window.confirm('Disconnect iVueit? Orders already placed keep their photos; new ones cannot be placed.')) return;
    setBusy('save');
    const r = await saveIvueit(workspaceId, { key: '' });
    setBusy(null);
    if (!r.ok) { setNote({ text: r.message ?? 'Could not disconnect.', bad: true }); return; }
    setConnected(false); setTemplates(null);
    setNote({ text: 'iVueit disconnected.' });
  }

  const canSave = (key.trim().length >= 8 && secret.trim().length >= 8) || (connected === true && (key.trim() === '' && secret.trim() === ''));

  return (
    <section style={card} data-testid="ivueit-card">
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 650 }}>iVueit photos</h2>
      <p style={muted}>
        A local Vuer photographs a deal&apos;s house on order, from the deal sheet or the TC file. Paste the API key and secret from the iVueit Client Portal.
        {connected ? ' Connected.' : connected === false ? ' Not connected yet.' : ''}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        <div>
          <label htmlFor="ivu-key" style={label}>API key</label>
          <input id="ivu-key" type="password" autoComplete="off" value={key} disabled={off} onChange={(e) => setKey(e.target.value)}
            placeholder={connected ? 'Saved. Paste to replace' : ''} style={{ ...field, fontFamily: 'ui-monospace, monospace' }} />
        </div>
        <div>
          <label htmlFor="ivu-secret" style={label}>Secret</label>
          <input id="ivu-secret" type="password" autoComplete="off" value={secret} disabled={off} onChange={(e) => setSecret(e.target.value)}
            placeholder={connected ? 'Saved. Paste to replace' : ''} style={{ ...field, fontFamily: 'ui-monospace, monospace' }} />
        </div>
        <div>
          <label htmlFor="ivu-env" style={label}>Server</label>
          <select id="ivu-env" value={env} disabled={off} onChange={(e) => setEnv(e.target.value as 'production' | 'staging')} style={field}>
            <option value="production">Production</option>
            <option value="staging">Staging (testing)</option>
          </select>
        </div>
        {env === 'staging' ? (
          <div>
            <label htmlFor="ivu-url" style={label}>Staging URL from iVueit</label>
            <input id="ivu-url" type="url" value={stagingUrl} disabled={off} onChange={(e) => setStagingUrl(e.target.value)} style={field} />
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
        <button type="button" disabled={off || !canSave} onClick={() => void save()} style={{ ...btn, opacity: off || !canSave ? 0.5 : 1 }}>
          {busy === 'save' ? 'Saving…' : busy === 'test' ? 'Testing…' : 'Save and test'}
        </button>
        {connected ? (
          <>
            <button type="button" disabled={off} onClick={() => void test()} style={{ ...ghost, opacity: off ? 0.5 : 1 }}>Test connection</button>
            <button type="button" disabled={off} onClick={() => void disconnect()} style={{ ...ghost, color: 'var(--tx-red, #b91c1c)', opacity: off ? 0.5 : 1 }}>Disconnect</button>
          </>
        ) : null}
      </div>
      {connected && templates && templates.length > 1 ? (
        <div style={{ marginTop: '12px', maxWidth: '420px' }}>
          <label htmlFor="ivu-tpl" style={label}>Survey a photo order runs</label>
          <select id="ivu-tpl" value={template} disabled={off} onChange={(e) => void pickTemplate(e.target.value)} style={field}>
            <option value="">Ask on each order</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.cost != null ? ` · $${t.cost.toFixed(2)}` : ''}</option>)}
          </select>
        </div>
      ) : null}
      {note ? <p role={note.bad ? 'alert' : 'status'} style={{ ...muted, margin: '10px 0 0', color: note.bad ? 'var(--tx-red, #b91c1c)' : 'var(--ink-3, #3f3f46)' }}>{note.text}</p> : null}
      {!admin ? <p style={{ ...muted, margin: '10px 0 0' }}>An owner or admin connects iVueit. Anyone on the team can order photos after.</p> : null}
    </section>
  );
}
