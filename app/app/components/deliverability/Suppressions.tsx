'use client';

// Addresses CLOZR will not email. Checked server-side before every send.
//
// In plain words: the "never email again" list. Anyone who unsubscribed,
// complained or whose address bounced lands here by itself, and an admin can
// add someone by hand. Emailing these people again is what gets domains
// blocked, so every kind of email checks this list first.

import React, { useState } from 'react';
import { type SuppressionRow, deliverability, textValue } from '@/lib/deliverability';
import { Badge, Note, Section, fieldLabel, ghost, input, row } from './ui';

const REASON: Record<SuppressionRow['reason'], string> = { hard_bounce: 'bounced', unsubscribe: 'unsubscribed', complaint: 'complaint', manual: 'manual' };

export function Suppressions({ workspaceId, rows, admin, onChange }: { workspaceId: number; rows: SuppressionRow[]; admin: boolean; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState<SuppressionRow['reason']>('manual');
  const [noteText, setNoteText] = useState('');
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await deliverability(workspaceId, 'suppress', { email, reason, note: noteText });
    setNote(r.ok ? { ok: true, text: `${email} will not be emailed.` } : { ok: false, text: r.message });
    if (r.ok) { setEmail(''); setNoteText(''); onChange(); }
  };
  const remove = async (s: SuppressionRow) => {
    const warn = s.reason === 'hard_bounce' ? 'This address bounced. Emailing it again hurts the mailbox’s reputation.' : s.reason === 'unsubscribe' ? 'This person unsubscribed. Only remove it if they asked to hear from you again.' : '';
    if (!window.confirm(`Allow email to ${textValue(s.email)} again?${warn ? `\n\n${warn}` : ''}`)) return;
    const r = await deliverability(workspaceId, 'unsuppress', { email: s.email });
    setNote(r.ok ? { ok: true, text: `${textValue(s.email)} removed.` } : { ok: false, text: r.message });
    onChange();
  };
  const shown = rows.filter((s) => !filter || s.email.includes(filter.toLowerCase()));

  return (
    <Section
      id="all-suppressions"
      title={`Do-not-email list (${rows.length})`}
      why="Addresses CLOZR will never email again: people who unsubscribed, complained, or whose address bounced. Every email checks this list first."
      how="Hard bounces and one-click unsubscribes land here on their own. Every send checks it first; a contract signing link is held back only for bounced addresses. This is also called the suppression list."
    >
      <form onSubmit={add} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '2 1 200px', minWidth: 0 }}><span style={fieldLabel}>Email address</span>
          <input required type="email" style={{ ...input, width: '100%' }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </label>
        <label style={{ flex: '1 1 130px', minWidth: 0 }}><span style={fieldLabel}>Why</span>
          <select style={{ ...input, width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value as SuppressionRow['reason'])}>
            <option value="manual">Do not email</option><option value="unsubscribe">Asked to stop</option><option value="complaint">Complained</option><option value="hard_bounce">Bounced</option>
          </select>
        </label>
        <label style={{ flex: '2 1 160px', minWidth: 0 }}><span style={fieldLabel}>Note (optional)</span>
          <input style={{ ...input, width: '100%' }} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
        </label>
        <button type="submit" style={ghost}>Add to list</button>
      </form>
      {rows.length > 8 && (
        <label style={{ display: 'block', marginTop: '10px' }}><span style={fieldLabel}>Find an address</span>
          <input style={{ ...input, width: '100%' }} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
      )}
      <div style={{ maxHeight: '260px', overflow: 'auto', marginTop: '8px' }}>
        {shown.map((s) => (
          <div key={s.id} style={{ ...row, padding: '7px 0', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12.5px' }}>
            <span style={{ fontWeight: 500, overflowWrap: 'anywhere', minWidth: 0 }}>{textValue(s.email)}</span>
            <Badge tone={s.reason === 'manual' ? 'muted' : 'bad'}>{REASON[s.reason]}</Badge>
            <span style={{ color: 'var(--meta, #71717a)', fontSize: '11.5px', flex: 1, minWidth: 0 }}>{textValue(s.note) ? `${textValue(s.note)} · ` : ''}{new Date(s.created_at).toLocaleDateString()}</span>
            {admin && <button type="button" style={{ ...ghost, height: '26px', fontSize: '11.5px' }} onClick={() => void remove(s)}>Remove</button>}
          </div>
        ))}
        {rows.length === 0 && <p style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)', margin: '6px 0 0' }}>Nobody on the list yet. Bounces and unsubscribes are added here by themselves.</p>}
        {rows.length > 0 && shown.length === 0 && <p style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)', margin: '6px 0 0' }}>No address matches {filter}.</p>}
      </div>
      <Note note={note} />
    </Section>
  );
}
