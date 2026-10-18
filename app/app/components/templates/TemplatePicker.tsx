'use client';

// The template picker both inbox composers open, and the filter bar the
// Templates manager shares with it: Channel, Audience, Owner, search.

import React, { useState } from 'react';
import { AUDIENCES, AUDIENCE_LABEL, type Channel, type MessageTemplate } from '@/lib/message-templates';
import type { Teammate } from '@/lib/team';
import { Icon } from '@/app/components/talkr/Icon';
import { FIELD } from '@/app/components/talkr/ui';
import { seg as chromeSeg, segWrap as chromeSegWrap } from '@/components/ds/chrome';
import { type TemplateFilter, filterTemplates } from './useTemplates';

/** Inbox / Templates segment — shared iPhone chrome (ds/chrome). */
export const seg = (on: boolean): React.CSSProperties => ({
  ...chromeSeg(on, 'sm'),
  font: '600 11.5px/1 var(--sans)',
  color: on ? 'var(--text)' : 'var(--muted)',
});
export const segWrap: React.CSSProperties = {
  ...chromeSegWrap,
  background: 'var(--panel-2)',
};
const small: React.CSSProperties = { ...FIELD, padding: '6px 8px', font: '500 11.5px/1 var(--sans)' };

export function TemplateFilters({ f, set, team, lockChannel }: {
  f: TemplateFilter; set: (patch: Partial<TemplateFilter>) => void; team: Teammate[]; lockChannel?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!lockChannel && (
        <span style={segWrap}>
          {(['any', 'sms', 'email'] as const).map((c) => (
            <button key={c} type="button" style={seg(f.channel === c)} onClick={() => set({ channel: c })}>{c === 'any' ? 'All' : c === 'sms' ? 'SMS' : 'Email'}</button>
          ))}
        </span>
      )}
      <select aria-label="Audience" value={f.audience} onChange={(e) => set({ audience: e.target.value as TemplateFilter['audience'] })} style={small}>
        <option value="any">Any audience</option>
        {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
      </select>
      <select aria-label="Owner" value={f.owner} onChange={(e) => set({ owner: e.target.value })} style={small}>
        <option value="any">Anyone</option>
        <option value="me">Mine</option>
        <option value="shared">Shared</option>
        {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || 'Teammate'}</option>)}
      </select>
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5" style={{ ...small, minWidth: 120 }}>
        <Icon name="search" size={12} style={{ color: 'var(--muted-2)' }} />
        <input aria-label="Search templates" value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search" className="min-w-0 flex-1 bg-transparent outline-none" style={{ font: 'inherit' }} />
      </span>
    </div>
  );
}

export function ownerLabel(t: MessageTemplate, userId: string | null, team: Teammate[]): string {
  const who = t.owner_id === userId ? 'You' : team.find((m) => m.user_id === t.owner_id)?.full_name || 'Teammate';
  return t.shared ? `${who} · shared` : who;
}

/**
 * The popover above a composer. The channel is the composer's; audience starts
 * at the thread's record kind, so a buyer thread opens on buyer templates.
 */
export function TemplatePicker({ channel, audience, templates, team, userId, loading, error, onPick, onManage, onClose }: {
  channel: Channel; audience: TemplateFilter['audience']; templates: MessageTemplate[]; team: Teammate[]; userId: string | null;
  loading: boolean; error: string | null;
  onPick: (t: MessageTemplate) => void; onManage: () => void; onClose: () => void;
}) {
  const [f, setF] = useState<TemplateFilter>({ channel, audience, owner: 'any', q: '' });
  const shown = filterTemplates(templates, f, userId);
  return (
    <div className="flex max-h-80 flex-col gap-2 px-3 py-3 md:px-6" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)' }}>
      <div className="flex items-center gap-2">
        <span className="eyebrow mr-auto">CLOZR templates · {channel === 'sms' ? 'SMS' : 'Email'}</span>
        <button type="button" onClick={onManage} style={{ font: '600 11px/1 var(--sans)', color: 'var(--accent)', cursor: 'pointer' }}>Manage</button>
        <button type="button" aria-label="Close templates" onClick={onClose} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}><Icon name="x" size={14} /></button>
      </div>
      <TemplateFilters f={f} set={(p) => setF((cur) => ({ ...cur, ...p }))} team={team} />
      <div className="min-h-0 flex-1 overflow-auto" style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
        {error && <p className="p-3" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--red)' }}>{error}</p>}
        {!error && !loading && shown.length === 0 && (
          <p className="p-3" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>
            No templates match. <button type="button" onClick={onManage} style={{ color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>Create one</button>
          </p>
        )}
        {shown.map((t) => (
          <button key={t.id} type="button" onClick={() => onPick(t)} className="lift-row flex w-full flex-col gap-1 px-3 py-2 text-left" style={{ borderBottom: '1px solid var(--panel-2)', cursor: 'pointer' }}>
            <span className="flex items-center gap-2">
              <span className="mr-auto truncate" style={{ font: '600 12.5px/1.2 var(--sans)' }}>{t.name}</span>
              <span style={{ font: '700 11px/1 var(--sans)', color: 'var(--accent)' }}>{t.channel === 'sms' ? 'SMS' : 'Email'} · {AUDIENCE_LABEL[t.audience]}</span>
            </span>
            <span className="truncate" style={{ font: '400 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>{t.subject ? `${t.subject} — ` : ''}{t.body_text.replace(/\s+/g, ' ').slice(0, 140)}</span>
            <span style={{ font: '500 11px/1.2 var(--sans)', color: 'var(--muted-2)' }}>{ownerLabel(t, userId, team)}{t.category ? ` · ${t.category}` : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
