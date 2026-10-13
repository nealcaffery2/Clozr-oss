// The name box on a contract recipient, with a typeahead across People
// (sellers), Buyers, Vendors and the team. Picking someone fills name, email
// and phone and keeps the link to their record (migration 114), so the
// contract shows on that record's Contracts card. Typing a name that is not
// in the CRM is fine; it is offered to People or Buyers on send.
'use client';

import React, { useEffect, useId, useState } from 'react';
import { type Contact, KIND_LABEL } from '@/lib/contact-search';
import { searchContacts } from '@/lib/contract-recipients';

const KIND_COLOR: Record<Contact['kind'], { color: string; bg: string }> = {
  seller: { color: '#0A8560', bg: '#E7F8F1' },
  buyer: { color: '#6d28d9', bg: '#ede9fe' },
  vendor: { color: '#b45309', bg: '#fef3c7' },
  team: { color: '#1d4ed8', bg: '#dbeafe' },
};

export function KindBadge({ kind }: { kind: Contact['kind'] }) {
  const c = KIND_COLOR[kind];
  return <span style={{ fontSize: '11px', fontWeight: 700, color: c.color, background: c.bg, borderRadius: '999px', padding: '2px 7px', flex: 'none' }}>{KIND_LABEL[kind]}</span>;
}

export function RecipientPicker({ workspaceId, value, onChange, onPick, linked, onUnlink, placeholder = 'Name — or search People, Buyers, team', style, autoFocus, kinds }: {
  workspaceId: number; value: string; onChange: (name: string) => void; onPick: (c: Contact) => void;
  /** "People", "Buyers"… when this recipient is linked to a record. */
  linked?: string | null; onUnlink?: () => void;
  placeholder?: string; style?: React.CSSProperties; autoFocus?: boolean;
  /** Limit the kinds offered (approvers: the team). */
  kinds?: Contact['kind'][];
}) {
  const listId = useId();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ q: string; list: Contact[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = window.setTimeout(() => {
      void searchContacts(workspaceId, q).then((list) => { if (live) setHits({ q, list }); });
    }, 180);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, workspaceId]);

  const shown = open && hits && hits.q === q && q.trim().length >= 2 ? hits.list.filter((c) => !kinds || kinds.includes(c.kind)) : [];
  const pick = (c: Contact) => { onPick(c); setOpen(false); setQ(''); };

  return (
    <div style={{ position: 'relative', minWidth: 0, ...style }}>
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!shown.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(shown[Math.min(active, shown.length - 1)]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        style={{ width: '100%', height: '34px', padding: linked ? '0 78px 0 10px' : '0 10px', border: '1px solid #e4e4e7', borderRadius: '9px', fontSize: '13px', outline: 0, background: '#fafafa', color: '#18181b' }}
      />
      {linked ? (
        <button type="button" onClick={onUnlink} title={`Linked to ${linked}. Click to unlink.`} style={{ position: 'absolute', right: '6px', top: '7px', height: '20px', padding: '0 7px', border: 0, borderRadius: '999px', background: '#E7F8F1', color: '#0A8560', fontSize: '10.5px', fontWeight: 700, cursor: 'pointer' }}>
          {linked} ×
        </button>
      ) : null}
      {shown.length ? (
        <ul id={listId} role="listbox" style={{ position: 'absolute', left: 0, right: 0, top: '38px', zIndex: 30, margin: 0, padding: '4px', listStyle: 'none', background: '#fff', border: '1px solid #e4e4e7', borderRadius: '10px', boxShadow: '0 12px 32px rgba(0,0,0,.14)', maxHeight: '280px', overflow: 'auto', minWidth: '280px' }}>
          {shown.map((c, i) => (
            <li
              key={`${c.kind}:${c.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 9px', borderRadius: '7px', cursor: 'pointer', background: i === active ? '#f4f4f5' : 'transparent', fontSize: '12.5px' }}
            >
              <KindBadge kind={c.kind} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600, color: '#18181b' }}>{c.name}</span>
                <span style={{ display: 'block', color: '#71717a', fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[c.email, c.phone, c.sub].filter(Boolean).join(' · ') || 'No email or phone on file'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
