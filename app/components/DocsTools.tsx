// The Contracts screen's PandaDoc extras (migration 179, docs-plus):
// bulk send one template to a list, public form links, and the 30-day report.
'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { type LibraryTemplate, docsPlus, listDocTemplates } from '@/lib/contracts';

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const GREEN = '#0A8560';
const box: React.CSSProperties = { background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const field: React.CSSProperties = { width: '100%', height: '36px', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 10px', fontSize: '14px', color: INK, background: 'var(--surface, #fff)', fontFamily: 'inherit', boxSizing: 'border-box' };
const lab: React.CSSProperties = { display: 'grid', gap: '6px', fontSize: '13px', color: MUTED, fontWeight: 500 };
const btn = (primary = false, off = false): React.CSSProperties => ({
  height: '36px', padding: '0 14px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.6 : 1,
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : 'var(--surface, #fff)', color: primary ? 'var(--surface, #fff)' : INK, fontFamily: 'inherit',
});
const h: React.CSSProperties = { margin: '0 0 6px', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.015em', color: INK };
const sub: React.CSSProperties = { margin: '0 0 18px', fontSize: '16px', color: 'var(--ink-3, #3f3f46)', lineHeight: 1.55, maxWidth: '68ch' };

/** Roles a recipient from outside fills (not the company's own signer). */
const outsideRoles = (t: LibraryTemplate | undefined) => (t?.signers ?? []).filter((s) => s.party !== 'company');

function useTemplates(workspaceId: number) {
  const [list, setList] = useState<LibraryTemplate[]>([]);
  useEffect(() => { let live = true; void listDocTemplates(workspaceId).then((r) => { if (live) setList(r); }); return () => { live = false; }; }, [workspaceId]);
  return list;
}

// ------------------------------------------------------------------ bulk send
type Batch = { id: number; name: string; status: string; total: number; sent: number; failed: number; created_at: string };

/** "Name, email, phone" per line; a header line or a line without an email is skipped. */
export function parseBulkRows(text: string) {
  return text.split(/\r?\n/).map((l) => l.split(/[,\t]/).map((x) => x.trim())).filter((c) => c.some((x) => /@/.test(x)))
    .map((c) => {
      const email = c.find((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) ?? '';
      const phone = c.find((x) => x !== email && x.replace(/\D/g, '').length >= 10) ?? null;
      const name = c.find((x) => x && x !== email && x !== phone) ?? email.split('@')[0];
      return { name, email: email.toLowerCase(), phone };
    }).filter((r) => r.email);
}

export function BulkSendPanel({ workspaceId, onToast }: { workspaceId: number; onToast: (m: string) => void }) {
  const templates = useTemplates(workspaceId);
  const [tplId, setTplId] = useState<number | ''>('');
  const [role, setRole] = useState('');
  const [text, setText] = useState('');
  const [days, setDays] = useState(60);
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [rev, setRev] = useState(0);
  const tpl = templates.find((t) => t.id === tplId);
  const roles = outsideRoles(tpl);
  const rows = parseBulkRows(text);

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    let t = 0;
    void supabase.from('bulk_sends' as never).select('id, name, status, total, sent, failed, created_at').eq('workspace_id', workspaceId).order('id', { ascending: false }).limit(10)
      .then(({ data }) => {
        if (!live) return;
        const list = (data ?? []) as unknown as Batch[];
        setBatches(list);
        // The cron sends 20 a minute; look again while a batch is still going.
        if (list.some((b) => b.status === 'queued' || b.status === 'running')) t = window.setTimeout(() => setRev((r) => r + 1), 20000);
      });
    return () => { live = false; window.clearTimeout(t); };
  }, [workspaceId, rev]);

  async function send() {
    if (!tpl || !rows.length) return;
    if (!window.confirm(`Send ${tpl.name} to ${rows.length} ${rows.length === 1 ? 'person' : 'people'}? Each gets their own document and signing link.`)) return;
    setBusy(true);
    const r = await docsPlus<{ bulk_send_id: number; total: number; sent: number; failed: number }>(workspaceId, 'bulk_create', {
      template_id: tpl.id, name: `${tpl.name} · ${new Date().toLocaleDateString()}`,
      rows: rows.map((x) => ({ recipient: { ...x, role: role || roles[0]?.role } })),
      options: { expires_days: days, recipient_role: role || roles[0]?.role },
    });
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast(`Queued ${r.data.total} · ${r.data.sent} sent now, the rest go out over the next few minutes`);
    setText(''); setRev((x) => x + 1);
  }

  return (
    <div style={box}>
      <h3 style={h}>Bulk send</h3>
      <p style={sub}>One template to a list of people: each gets their own copy, filled from the record, with their own link. The company signer and anyone else on the template are filled as on a normal send.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        <label style={lab}>Template
          <select value={tplId} onChange={(e) => { setTplId(e.target.value ? Number(e.target.value) : ''); setRole(''); }} style={field}>
            <option value="">Pick a template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label style={lab}>Each person signs as
          <select value={role || roles[0]?.role || ''} onChange={(e) => setRole(e.target.value)} style={field} disabled={!roles.length}>
            {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
          </select>
        </label>
        <label style={lab}>Signable for (days)
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 60)))} style={field} />
        </label>
      </div>
      <label style={{ ...lab, marginTop: '10px' }}>People, one per line: name, email, phone
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={'Jordan Lee, jordan@example.com, 555 010 2030\nSam Ortiz, sam@example.com'} style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
        <span style={{ flex: 1, fontSize: '14px', color: MUTED }}>{rows.length ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'} ready` : 'Paste a list to start.'}</span>
        <button type="button" disabled={busy || !tpl || !rows.length || rows.length > 500} onClick={() => void send()} style={btn(true, busy || !tpl || !rows.length)}>{busy ? 'Queuing…' : 'Send to all'}</button>
      </div>
      {batches.length ? (
        <table style={{ width: '100%', marginTop: '14px', fontSize: '14px', borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: MUTED, textAlign: 'left' }}><th style={{ padding: '6px 0' }}>Batch</th><th>Status</th><th>Sent</th><th>Failed</th></tr></thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} style={{ borderTop: `1px solid ${LINE}` }}>
                <td style={{ padding: '6px 0' }}>{b.name}</td><td>{b.status}</td><td>{b.sent} of {b.total}</td><td style={{ color: b.failed ? 'var(--tx-red, #b91c1c)' : undefined }}>{b.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ form links
type FormRow = { id: number; slug: string; name: string; template_id: number; public_role: string; active: boolean; uses: number; max_uses: number | null; require_email_code: boolean };

export function FormLinksPanel({ workspaceId, onToast }: { workspaceId: number; onToast: (m: string) => void }) {
  const templates = useTemplates(workspaceId);
  const [forms, setForms] = useState<FormRow[]>([]);
  const [rev, setRev] = useState(0);
  const [tplId, setTplId] = useState<number | ''>('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [intro, setIntro] = useState('');
  const tpl = templates.find((t) => t.id === tplId);
  const roles = outsideRoles(tpl);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    void supabase.from('doc_forms' as never).select('id, slug, name, template_id, public_role, active, uses, max_uses, require_email_code').eq('workspace_id', workspaceId).order('id', { ascending: false })
      .then(({ data }) => { if (live) setForms((data ?? []) as unknown as FormRow[]); });
    return () => { live = false; };
  }, [workspaceId, rev]);

  async function create() {
    if (!supabase || !tpl) return;
    const { data: me } = await supabase.auth.getUser();
    const { error } = await supabase.from('doc_forms' as never).insert({
      workspace_id: workspaceId, template_id: tpl.id, name: name.trim() || tpl.name, public_role: role || roles[0]?.role, intro: intro.trim() || null,
      require_email_code: true, created_by: me.user?.id ?? null,
    } as never);
    if (error) return onToast(error.message);
    setName(''); setIntro(''); setTplId(''); setRev((r) => r + 1);
    onToast('Form link created');
  }
  async function toggle(f: FormRow) {
    if (!supabase) return;
    const { error } = await supabase.from('doc_forms' as never).update({ active: !f.active } as never).eq('id', f.id);
    if (error) return onToast(error.message);
    setRev((r) => r + 1);
  }
  const url = (f: FormRow) => `${origin}/forms/?s=${f.slug}`;

  return (
    <div style={box}>
      <h3 style={h}>Form links</h3>
      <p style={sub}>A public link that makes a fresh document from a template for whoever opens it (a seller info form on the website, an ICA for a new rep). They confirm their email with a code, fill it in and sign; the company signer gets their turn after.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        <label style={lab}>Template
          <select value={tplId} onChange={(e) => { setTplId(e.target.value ? Number(e.target.value) : ''); setRole(''); }} style={field}>
            <option value="">Pick a template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label style={lab}>The visitor signs as
          <select value={role || roles[0]?.role || ''} onChange={(e) => setRole(e.target.value)} style={field} disabled={!roles.length}>
            {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
          </select>
        </label>
        <label style={lab}>Title on the page
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tpl?.name ?? 'Seller information form'} style={field} />
        </label>
      </div>
      <label style={{ ...lab, marginTop: '10px' }}>Intro (optional)
        <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
        <button type="button" disabled={!tpl || !roles.length} onClick={() => void create()} style={btn(true, !tpl || !roles.length)}>Create link</button>
      </div>
      {forms.length ? (
        <div style={{ marginTop: '14px', display: 'grid', gap: '8px' }}>
          {forms.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', borderTop: `1px solid ${LINE}`, paddingTop: '8px', fontSize: '14px' }}>
              <span style={{ fontWeight: 650, color: f.active ? INK : MUTED }}>{f.name}</span>
              <span style={{ color: MUTED }}>{f.uses} started{f.max_uses ? ` of ${f.max_uses}` : ''}{f.active ? '' : ' · off'}</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={btn()} onClick={() => { void navigator.clipboard?.writeText(url(f)).then(() => onToast('Link copied')); }}>Copy link</button>
              <button type="button" style={btn()} onClick={() => void toggle(f)}>{f.active ? 'Turn off' : 'Turn on'}</button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ reports
type Stats = { created: number; sent: number; viewed: number; completed: number; declined: number; expired: number; voided: number; median_hours_to_complete: number | null; value_completed: number; by_kind: Record<string, number>; by_sender: Record<string, number> };

export function DocsReports({ workspaceId }: { workspaceId: number }) {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    const to = new Date();
    const from = new Date(to.getTime() - days * 864e5);
    void supabase.rpc('docs_stats' as never, { p_workspace: workspaceId, p_from: from.toISOString(), p_to: to.toISOString() } as never)
      .then(({ data, error }) => { if (!live) return; if (error) setErr(error.message); else { setErr(null); setS(data as unknown as Stats); } });
    return () => { live = false; };
  }, [workspaceId, days]);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const step = (n: number, what: string, of?: number) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      <b style={{ fontSize: '22px', color: INK, fontVariantNumeric: 'tabular-nums' }}>{n}</b> {what}
      {of != null ? <span style={{ color: MUTED }}> ({pct(n, of)}%)</span> : null}
    </span>
  );
  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <h3 style={{ ...h, margin: 0, flex: 1 }}>Report</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ ...field, width: 'auto' }}>
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      {err ? <p style={{ ...sub, color: 'var(--tx-red, #b91c1c)' }}>{err}</p> : !s ? <p style={sub}>Loading…</p> : (
        <>
          {/* The funnel reads left to right: of what went out, how much was opened and signed. */}
          <p style={{ margin: 0, fontSize: '16px', color: 'var(--ink-3, #3f3f46)', display: 'flex', flexWrap: 'wrap', gap: '8px 18px', alignItems: 'baseline' }}>
            {step(s.sent, 'sent')}
            {step(s.viewed, 'opened', s.sent)}
            {step(s.completed, 'signed by everyone', s.sent)}
          </p>
          <p style={{ ...sub, margin: '10px 0 0' }}>
            {s.median_hours_to_complete != null ? `Half were fully signed within ${s.median_hours_to_complete} hours of sending. ` : ''}
            {s.declined || s.expired || s.voided ? `${s.declined} declined, ${s.expired} expired unsigned, ${s.voided} voided.` : 'None declined, expired or voided.'}
            {s.created > s.sent ? ` ${s.created - s.sent} drafted and not sent yet.` : ''}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '24px', marginTop: '24px', fontSize: '14px' }}>
            {([['By kind', s.by_kind], ['By sender', s.by_sender]] as const).map(([title, m]) => (
              <div key={title}>
                <div style={{ fontWeight: 650, marginBottom: '4px' }}>{title}</div>
                {Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${LINE}`, padding: '4px 0' }}><span>{k}</span><span>{n}</span></div>)}
                {!Object.keys(m).length ? <div style={{ color: MUTED }}>Nothing in this window.</div> : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
