'use client';

// Settings → Email deliverability → Resend blast domain.
// Campaigns send from the workspace's own sending subdomain (deals.<domain>)
// so a blast cannot burn the company root or anyone's Gmail. This card holds
// the workspace's Resend key and blast sender, shows the records Resend
// wants, the webhook to paste, and verifies the domain.
//
// In plain words: buyer blasts are the "here is a new deal" emails sent to
// buyers already on the list. They go out through a mail service (Resend)
// from a separate domain, each rep from their own handful of addresses, and
// replies land in that rep's real inbox. Each workspace uses its own Resend
// account and domain. This box shows each rep's addresses and how much they
// sent today, and holds the setup steps.

import React, { useState } from 'react';
import { type Overview, type ResendDnsRecord, type ResendStatus, deliverability, resendDomainFields, resendRecordFields, resendWebhookUrl, textValue } from '@/lib/deliverability';
import { Badge, Copy, Icon, Note, NotSetUp, Section, danger, fieldLabel, ghost, input, mono, primary, row } from './ui';
import { loadSettings, saveSettings } from '@/lib/integrations';

/** Keep only strings from a connect/verify payload. A Resend domain object never lands in state. */
function taken(incoming: ResendStatus): ResendStatus {
  const fields = resendDomainFields(incoming.domain, incoming.status, incoming.region);
  const records = (Array.isArray(incoming.records) ? incoming.records : []).flatMap((rec) => {
    const row = resendRecordFields(rec);
    return row ? [row] : [];
  });
  return { ...incoming, domain: fields.name || null, status: fields.status || null, region: fields.region || null, records };
}

export function ResendCard({ workspaceId, admin, overview, onChange }: { workspaceId: number; admin: boolean; overview: Overview; onChange: () => void }) {
  const [data, setData] = useState<ResendStatus | null>(overview.resend ? taken(overview.resend) : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hook = textValue(data?.webhook_url) || resendWebhookUrl();
  const fields = resendDomainFields(data?.domain, data?.status, data?.region);
  const records: ResendDnsRecord[] = (Array.isArray(data?.records) ? data.records : []).flatMap((rec) => {
    const row = resendRecordFields(rec);
    return row ? [row] : [];
  });
  const status = fields.status.toLowerCase();

  const load = async () => {
    setBusy(true); setNote(null);
    const r = await deliverability<ResendStatus>(workspaceId, 'resend_status');
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setData(taken(r.data));
  };
  const verify = async () => {
    if (!admin) return;
    setBusy(true); setNote(null);
    const r = await deliverability<ResendStatus>(workspaceId, 'resend_ensure_domain');
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    const next = taken(r.data);
    setData((cur) => ({ ...(cur ?? next), ...next, domain: next.domain || (typeof cur?.domain === 'string' ? cur.domain : null) }));
    onChange();
    setNote({ ok: true, text: next.status === 'verified' ? 'Resend verified the domain.' : 'Records requested from Resend. Add them at the DNS host, then verify again.' });
  };
  const pause = async (resume: boolean, senderId?: number) => {
    if (!admin) return;
    setBusy(true); setNote(null);
    const r = await deliverability(workspaceId, resume ? 'resume_sender' : 'pause_sender', senderId ? { sender_id: senderId } : {});
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    onChange();
    void load();
    setNote({ ok: true, text: resume ? 'Address resumed.' : 'Address paused.' });
  };
  const pool = data?.senders?.length ? data.senders : data?.sender ? [data.sender] : [];
  const groups = new Map<string, typeof pool>();
  for (const s of pool) {
    const key = textValue(s.user_id) || textValue(s.reply_to) || textValue(s.from_email);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const root = fields.name ? fields.name.replace(/^deals\./, '') : 'your company domain';
  const how = (
    <>
      Dispo campaigns send through Resend from a sending subdomain{fields.name ? <> ({fields.name})</> : null} so a blast cannot burn {root} or a rep&apos;s Gmail. Each workspace uses its own Resend account and domain; without its own key it falls back to the project&apos;s.
      Owner, admin, and dispositions reps each get 10 addresses on that domain (morgan1@ through morgan10@). Every address starts at 50 a day and climbs 20% a day to 100, so a warm rep can send 1,000 a day from their own pool. A campaign uses only the launching rep&apos;s addresses, under that rep&apos;s name, and every reply goes to their real inbox. The CRM files the send and the reply on that rep. AgentMail stays on inbound and agent inboxes and is not on this pipe.
    </>
  );
  const applied = (next: ResendStatus | undefined) => {
    if (next) setData((cur) => ({ ...(cur ?? next), ...taken(next), records: cur?.records ?? [] }));
    onChange();
  };

  // Not wired yet: the owner sets this workspace's Resend key and sender here.
  // A domain already connected (records pending) still shows the full box.
  if (!data?.configured && !fields.name) {
    return (
      <NotSetUp
        id="warm-resend"
        title="Buyer blasts (Resend)"
        why="Sends deal blasts to your buyer list from a separate domain, so a blast can never hurt your main address or a rep's Gmail. Add this workspace's Resend key and a sender on a sending subdomain to turn it on."
        how={how}
        action={admin ? <SenderSetup workspaceId={workspaceId} data={data} onSaved={applied} /> : <p style={{ margin: 0, fontSize: '12.5px', color: '#71717a' }}>An owner or admin sets the Resend key and blast sender.</p>}
      />
    );
  }

  return (
    <Section
      id="warm-resend"
      title="Buyer blasts (Resend)"
      why="Deal blasts to your buyer list go out from their own domain, so a blast can never hurt your main address or a rep's Gmail. Each rep's addresses send under that rep's name."
      how={how}
      actions={(
        <>
          {fields.name ? <span style={{ fontSize: '12.5px', color: '#3f3f46', minWidth: 0, overflowWrap: 'anywhere' }}>{fields.name}</span> : null}
          {status === 'verified' ? <Badge tone="good">Domain verified</Badge> : <Badge tone="warn">{status ? `Domain ${status}` : 'Waiting on DNS'}</Badge>}
          {fields.region ? <span title="Resend region" style={{ fontSize: '12.5px', color: '#71717a' }}>{fields.region}</span> : null}
          <button type="button" style={ghost} disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : 'Refresh'}</button>
          {admin && <button type="button" style={ghost} disabled={busy} onClick={() => void verify()}>{status === 'verified' ? 'Re-check' : 'Verify domain'}</button>}
        </>
      )}
    >
      {pool.length > 0 && (
        <div style={{ borderTop: '1px solid #f0f0f1' }}>
          {[...groups.values()].map((list) => {
            const head = list[0];
            const sent = list.reduce((n, s) => n + s.sent_today, 0);
            const allowance = list.reduce((n, s) => n + (s.settings.paused ? 0 : s.allowance), 0);
            const paused = list.filter((s) => s.settings.paused).length;
            const label = textValue(head.from_name) || textValue(head.from_email);
            const groupKey = textValue(head.user_id) || textValue(head.reply_to) || textValue(head.from_email) || label;
            // One line per rep; the rep's individual addresses fold away.
            return (
              <details key={groupKey} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12.5px' }}>
                <summary style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minHeight: '28px', borderRadius: '6px' }}>
                  <span style={{ color: '#71717a', display: 'inline-flex' }}><Icon name="chevron" size={14} /></span>
                  <strong style={{ fontWeight: 600 }}>{label}</strong>
                  <span style={{ color: '#52525b', fontVariantNumeric: 'tabular-nums' }}>{list.length} {list.length === 1 ? 'address' : 'addresses'} · {sent} of {allowance} sent today</span>
                  {paused ? <Badge tone="bad">{paused} paused</Badge> : null}
                  {textValue(head.reply_to) ? <span style={{ color: '#71717a', overflowWrap: 'anywhere' }}>replies go to {textValue(head.reply_to)}</span> : null}
                </summary>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', margin: '6px 0 2px 22px' }}>
                  {list.map((s) => (
                    <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 0' }}>
                      <span style={{ ...mono, wordBreak: 'normal' }}>{textValue(s.from_email).split('@')[0]}</span>
                      <span style={{ color: '#71717a', fontVariantNumeric: 'tabular-nums' }}>{s.sent_today}/{s.allowance}</span>
                      {s.settings.paused ? <Badge tone="bad">paused</Badge> : null}
                      {admin && (s.settings.paused
                        ? <button type="button" style={{ ...ghost, height: '26px' }} disabled={busy} onClick={() => void pause(true, s.id)}>Resume</button>
                        : <button type="button" style={{ ...ghost, height: '26px', color: '#b91c1c' }} disabled={busy} onClick={() => void pause(false, s.id)}>Pause</button>)}
                    </span>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
      {!data?.webhook_secret_set ? <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#92400e' }}>Bounces and spam complaints are not coming back from Resend yet, so bad addresses stay on the list. Open Setup details below and add the webhook.</p> : null}
      {records.length > 0 && (
        <div style={{ ...row, marginTop: '10px' }}>
          <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>Add these at the DNS host for {fields.name}</div>
          {records.map((rec) => (
            <div key={`${textValue(rec.type)}:${textValue(rec.name)}:${textValue(rec.value)}`} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0,1fr) auto', gap: '8px', alignItems: 'start', padding: '6px 0', fontSize: '12px' }}>
              <span style={{ fontWeight: 700 }}>{textValue(rec.type)}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', ...mono }}>{textValue(rec.name)}</span>
                <span style={{ display: 'block', color: '#52525b', ...mono, fontSize: '11px', marginTop: '2px' }}>{textValue(rec.value)}</span>
              </span>
              <Copy text={textValue(rec.value)} />
            </div>
          ))}
        </div>
      )}
      {textValue(data?.error) ? <p role="alert" style={{ margin: '10px 0 0', fontSize: '12.5px', color: '#b91c1c' }}>Resend: {textValue(data?.error)}</p> : null}
      <details style={{ marginTop: '12px' }}>
        <summary style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', fontSize: '12px', fontWeight: 600, color: '#0A8560' }}><Icon name="chevron" size={13} />Setup details: Resend account, more capacity and the bounce webhook</summary>
        <div style={row}>
          <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>Resend account and sender</div>
          <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#52525b', lineHeight: 1.5 }}>
            {data?.own_key ? 'This workspace sends with its own Resend key.' : data?.key_source === 'project' ? 'This workspace sends with the project Resend key (RESEND_API_KEY). Add its own key to keep its mail on its own account.' : 'No Resend key yet.'}
            {' '}{data?.own_from ? `Blasts go out as ${textValue(data.own_from)}.` : data?.from ? `Blasts go out as ${textValue(data.from)}, the project sender.` : ''}
          </p>
          {admin ? <SenderSetup workspaceId={workspaceId} data={data} onSaved={(next) => { applied(next); void load(); }} /> : null}
        </div>
        <MoreCapacity workspaceId={workspaceId} admin={admin} reps={groups.size} onChange={() => { onChange(); void load(); }} />
        <div style={row}>
          <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>Resend webhook</div>
          <p style={{ margin: '0 0 6px', fontSize: '12px', color: '#52525b', lineHeight: 1.5 }}>
            In {data?.own_key ? "this workspace's" : 'the'} Resend account, under Webhooks, subscribe to email.bounced, email.failed and email.complained. Paste this URL, then save the signing secret{data?.own_key ? ' below' : <> on the project as <code>RESEND_WEBHOOK_SECRET</code> (or below, for this workspace only)</>}.
          </p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 200px', minWidth: 0, padding: '8px 10px', border: '1px solid #e4e4e7', borderRadius: '8px', background: '#fafafa', ...mono }}>{hook || 'Supabase is not configured'}</span>
            {hook ? <Copy text={hook} /> : null}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: '12px', color: data?.webhook_secret_set ? '#08694C' : '#92400e' }}>
            {data?.webhook_secret_set ? (data?.own_webhook_secret ? "This workspace's signing secret is saved." : 'Signing secret is set on the project.') : 'No signing secret yet, so bounces will not suppress until one is saved.'}
          </p>
          {admin ? <WebhookSecret workspaceId={workspaceId} saved={!!data?.own_webhook_secret} onSaved={(next) => applied(next)} /> : null}
        </div>
      </details>
      <Note note={note} />
    </Section>
  );
}

/**
 * More blast capacity: extra Resend domains (each verified on Resend, then its
 * reps' addresses appear on the next refresh) and more addresses per rep.
 * Every address keeps its own warm-up, so capacity grows as they warm.
 */
function MoreCapacity({ workspaceId, admin, reps, onChange }: { workspaceId: number; admin: boolean; reps: number; onChange: () => void }) {
  const [domains, setDomains] = useState<string[] | null>(null);
  const [perRep, setPerRep] = useState('10');
  const [adding, setAdding] = useState('');
  const [records, setRecords] = useState<{ domain: string; list: ResendDnsRecord[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Read once, during render rather than in an effect (set-state-in-effect fails CI).
  if (domains === null) {
    setDomains([]);
    void loadSettings(workspaceId).then((s) => {
      setDomains(Array.isArray(s.blast_domains) ? s.blast_domains : []);
      setPerRep(String(s.blast_addresses_per_rep ?? 10));
    });
  }

  const add = async () => {
    const d = adding.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^.*@/, '').replace(/\/.*$/, '');
    if (!d) return;
    setBusy(true); setNote(null);
    const r = await deliverability<ResendStatus>(workspaceId, 'resend_ensure_domain', { domain: d });
    if (!r.ok) { setBusy(false); return setNote({ ok: false, text: r.message }); }
    const connected = taken(r.data);
    const next = Array.from(new Set([...(domains ?? []), d]));
    const saved = await saveSettings(workspaceId, { blast_domains: next });
    setBusy(false);
    if (!saved.ok) return setNote({ ok: false, text: saved.message ?? 'Not saved.' });
    setDomains(next); setAdding('');
    setRecords({ domain: connected.domain || d, list: connected.records ?? [] });
    setNote({ ok: true, text: connected.status === 'verified' ? `${d} is verified. Its addresses appear on the next refresh.` : `Add the records below for ${d} at its DNS host. Once Resend verifies it and the domain check passes, each rep gets addresses there.` });
    onChange();
  };
  const remove = async (d: string) => {
    const next = (domains ?? []).filter((x) => x !== d);
    setBusy(true);
    const saved = await saveSettings(workspaceId, { blast_domains: next });
    setBusy(false);
    if (saved.ok) setDomains(next);
    setNote(saved.ok ? { ok: true, text: `${d} is no longer used for new addresses. Addresses already made there keep sending until paused.` } : { ok: false, text: saved.message ?? 'Not saved.' });
  };
  const savePerRep = async () => {
    const n = Math.max(1, Math.min(25, Math.floor(Number(perRep) || 10)));
    setBusy(true);
    const saved = await saveSettings(workspaceId, { blast_addresses_per_rep: n });
    setBusy(false);
    setPerRep(String(n));
    setNote(saved.ok ? { ok: true, text: `${n} addresses per rep per domain. New ones appear on the next refresh, each with its own warm-up.` } : { ok: false, text: saved.message ?? 'Not saved.' });
    if (saved.ok) onChange();
  };
  const per = Math.max(1, Math.min(25, Math.floor(Number(perRep) || 10)));
  const domainCount = 1 + (domains?.length ?? 0);
  const field: React.CSSProperties = { height: '30px', padding: '0 9px', border: '1px solid #e4e4e7', borderRadius: '8px', fontSize: '12.5px' };

  return (
    <div style={row}>
      <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>More sending capacity</div>
      <p style={{ margin: '0 0 6px', fontSize: '12px', color: '#52525b', lineHeight: 1.5 }}>
        Once warm, each rep can send about {(per * domainCount * 100).toLocaleString('en-US')} a day ({per} addresses × {domainCount} domain{domainCount === 1 ? '' : 's'} × 100){reps ? `; ${(per * domainCount * 100 * reps).toLocaleString('en-US')} across ${reps} rep${reps === 1 ? '' : 's'}` : ''}. For more, add another sending subdomain (for example offers.yourdomain.com) rather than piling addresses on one: each domain carries its own reputation, so one flagged domain does not stop the rest.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
        {(domains ?? []).map((d) => {
          const label = resendDomainFields(d).name || textValue(d);
          if (!label) return null;
          return (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '3px 8px', border: '1px solid #e4e4e7', borderRadius: '8px' }}>
              {label}
              {admin ? <button type="button" style={{ ...ghost, color: '#b91c1c' }} disabled={busy} onClick={() => void remove(typeof d === 'string' ? d : label)}>Remove</button> : null}
            </span>
          );
        })}
        {!domains?.length ? <span style={{ fontSize: '12px', color: '#71717a' }}>No extra domains yet.</span> : null}
      </div>
      {admin ? (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input aria-label="Extra blast domain" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="offers.yourdomain.com" style={{ ...field, flex: '1 1 200px' }} />
          <button type="button" style={primary} disabled={busy || !adding.trim()} onClick={() => void add()}>Add domain</button>
          <span style={{ fontSize: '12px', color: '#52525b' }}>Addresses per rep</span>
          <input aria-label="Addresses per rep" value={perRep} onChange={(e) => setPerRep(e.target.value)} inputMode="numeric" style={{ ...field, width: '56px' }} />
          <button type="button" style={ghost} disabled={busy} onClick={() => void savePerRep()}>Save</button>
        </div>
      ) : null}
      {records?.list.length ? (
        <div style={{ marginTop: '8px' }}>
          {records.list.map((rec) => (
            <div key={`${textValue(rec.type)}:${textValue(rec.name)}:${textValue(rec.value)}`} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0,1fr) auto', gap: '8px', alignItems: 'start', padding: '4px 0', fontSize: '12px' }}>
              <span style={{ fontWeight: 700 }}>{textValue(rec.type)}</span>
              <span style={{ minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', wordBreak: 'break-all' }}>{textValue(rec.name)}<br />{textValue(rec.value)}</span>
              <Copy text={textValue(rec.value)} />
            </div>
          ))}
        </div>
      ) : null}
      <Note note={note} />
    </div>
  );
}

type Saved = (next: ResendStatus | undefined) => void;

/**
 * This workspace's Resend key and blast sender. The key is checked against
 * Resend before it is stored (sealed, never sent back); the sender must be on
 * the workspace's own domain, ideally a sending subdomain.
 */
function SenderSetup({ workspaceId, data, onSaved }: { workspaceId: number; data: ResendStatus | null; onSaved: Saved }) {
  const [key, setKey] = useState('');
  const [from, setFrom] = useState(textValue(data?.own_from) || textValue(data?.suggested_from));
  const [busy, setBusy] = useState<'key' | 'from' | 'clear' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const saveKey = async (clear = false) => {
    setBusy(clear ? 'clear' : 'key'); setNote(null);
    const r = await deliverability<{ resend: ResendStatus }>(workspaceId, 'resend_key', { key: clear ? null : key });
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setKey('');
    setNote({ ok: true, text: clear ? 'Resend key removed. Blasts use the project key again.' : 'Resend key saved. Blasts from this workspace use it.' });
    onSaved(r.data.resend);
  };
  const saveFrom = async () => {
    setBusy('from'); setNote(null);
    const r = await deliverability<{ resend: ResendStatus; retired: number }>(workspaceId, 'blast_sender', { from: from.trim() || null });
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    const retired = r.data.retired ? ` ${r.data.retired} address${r.data.retired === 1 ? '' : 'es'} on the old domain stopped rotating.` : '';
    setNote({ ok: true, text: from.trim() ? `Blast sender saved. Verify the domain on Resend next.${retired}` : `Blast sender cleared.${retired}` });
    onSaved(r.data.resend);
  };
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <form onSubmit={(e) => { e.preventDefault(); void saveFrom(); }}>
        <label htmlFor={`dlv-blast-from-${workspaceId}`} style={fieldLabel}>Blast sender (name and address on a sending subdomain)</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input id={`dlv-blast-from-${workspaceId}`} autoComplete="off" spellCheck={false} style={{ ...input, flex: '1 1 260px' }} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Company <deals@deals.yourdomain.com>" />
          <button type="submit" style={ghost} disabled={busy !== null || from.trim() === textValue(data?.own_from)}>{busy === 'from' ? 'Saving…' : 'Save sender'}</button>
        </div>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
        <label htmlFor={`dlv-resend-key-${workspaceId}`} style={fieldLabel}>Resend API key, full access (Resend, API Keys)</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input id={`dlv-resend-key-${workspaceId}`} type="password" autoComplete="off" spellCheck={false} style={{ ...input, flex: '1 1 260px' }} value={key} onChange={(e) => setKey(e.target.value)} placeholder={data?.own_key ? 'Saved. Paste a new key to replace it' : 're_…'} />
          <button type="submit" style={ghost} disabled={busy !== null || !key.trim()}>{busy === 'key' ? 'Checking…' : data?.own_key ? 'Replace key' : 'Save key'}</button>
          {data?.own_key ? <button type="button" style={danger} disabled={busy !== null} onClick={() => { if (window.confirm('Remove this workspace\'s Resend key? Blasts fall back to the project key.')) void saveKey(true); }}>{busy === 'clear' ? 'Removing…' : 'Remove key'}</button> : null}
        </div>
      </form>
      <Note note={note} />
    </div>
  );
}

/** The signing secret of this workspace's Resend webhook (whsec_…), stored sealed. */
function WebhookSecret({ workspaceId, saved, onSaved }: { workspaceId: number; saved: boolean; onSaved: Saved }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (clear = false) => {
    setBusy(true); setNote(null);
    const r = await deliverability<{ resend: ResendStatus }>(workspaceId, 'resend_key', { webhook_secret: clear ? null : secret });
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setSecret('');
    setNote({ ok: true, text: clear ? 'Signing secret removed.' : 'Signing secret saved. Bounces from this Resend account now suppress.' });
    onSaved(r.data.resend);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ marginTop: '8px' }}>
      <label htmlFor={`dlv-resend-hook-${workspaceId}`} style={fieldLabel}>Webhook signing secret for this workspace</label>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input id={`dlv-resend-hook-${workspaceId}`} type="password" autoComplete="off" spellCheck={false} style={{ ...input, flex: '1 1 260px' }} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={saved ? 'Saved. Paste a new secret to replace it' : 'whsec_…'} />
        <button type="submit" style={ghost} disabled={busy || !secret.trim()}>{busy ? 'Saving…' : saved ? 'Replace secret' : 'Save secret'}</button>
        {saved ? <button type="button" style={danger} disabled={busy} onClick={() => void save(true)}>Remove</button> : null}
      </div>
      <Note note={note} />
    </form>
  );
}
