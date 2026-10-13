// Buyers' own smart lists: a name over the list, filters and columns that
// were on, saved by anyone on the team and opened from the rail. They are
// `saved_views` rows on screen 'buyers' (lib/smart-lists.ts), the same store
// People's smart lists use; the Views menu on Buyers skips them.
//
// Only the one who saved a list can delete it (saved_views RLS). The system
// lists above them (Buyers and the prospect pens) are not rows and cannot be
// deleted.
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '@/app/components/record/useModal';
import { useConfirm } from '@/components/ds/Confirm';
import { RailRow, type RailItem } from '@/components/ds/ListRail';
import { deleteSmartList, insertSmartList, loadSmartLists, smartListVisible, type SmartList } from '@/lib/smart-lists';

export type BuyerSmartList = SmartList<Record<string, string>>;

export type BuyerSmartLists = {
  lists: BuyerSmartList[];
  /** Resolves to the saved list, or null when it did not save. */
  create: (l: Omit<BuyerSmartList, 'id' | 'mine'>) => Promise<BuyerSmartList | null>;
  remove: (l: BuyerSmartList) => Promise<boolean>;
};

/** The workspace's Buyers smart lists this user can open. In the demo they live in this browser. */
export function useBuyerSmartLists(workspaceId: number | null, me: string | null): BuyerSmartLists {
  const [lists, setLists] = useState<BuyerSmartList[]>([]);
  useEffect(() => {
    let alive = true;
    void loadSmartLists<Record<string, string>>(workspaceId, me, 'buyers').then((rows) => {
      if (alive && rows) setLists(rows.filter((l) => !me || smartListVisible(l, me)));
    });
    return () => { alive = false; };
  }, [workspaceId, me]);
  const create = async (l: Omit<BuyerSmartList, 'id' | 'mine'>) => {
    const draft: BuyerSmartList = { ...l, id: 'new', mine: true };
    const id = await insertSmartList(workspaceId, me, draft, lists, 'buyers');
    if (!id) return null;
    const made = { ...draft, id };
    setLists((cur) => [...cur, made].sort((a, b) => a.name.localeCompare(b.name)));
    return made;
  };
  const remove = async (l: BuyerSmartList) => {
    const ok = await deleteSmartList(workspaceId, me, l.id, lists, 'buyers');
    if (ok) setLists((cur) => cur.filter((x) => x.id !== l.id));
    return ok;
  };
  return { lists, create, remove };
}

const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
  </svg>
);

export const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** Ask, then delete. The rail's button and the phone strip's both come here. */
export function useRemoveSmartList(smart: BuyerSmartLists, onGone: (l: BuyerSmartList) => void, toast: (msg: string, tone?: 'success' | 'error') => void) {
  const { confirm } = useConfirm();
  return async (l: BuyerSmartList) => {
    const ok = await confirm({
      title: `Delete "${l.name}"?`,
      body: 'The list goes for everyone it was shared with. The contacts on it stay where they are.',
      confirmLabel: 'Delete list',
      tone: 'danger',
    });
    if (!ok) return;
    if (!(await smart.remove(l))) { toast(`"${l.name}" did not delete. Check your connection and try again.`, 'error'); return; }
    onGone(l);
    toast(`Deleted "${l.name}"`, 'success');
  };
}

/** A saved list on the rail, with a delete button beside it for the one who saved it. */
export function SavedRailRow({ item, list, onRemove }: { item: RailItem; list: BuyerSmartList; onRemove: (l: BuyerSmartList) => void }) {
  return (
    <div className="cz-rail-item">
      <RailRow item={item} />
      {list.mine !== false ? (
        <button type="button" className="cz-rail-remove" onClick={() => onRemove(list)} aria-label={`Delete smart list ${list.name}`} title="Delete this smart list">
          <XIcon />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Name a new smart list. It keeps the list, filters and columns on screen now;
 * the summary under the name says which, so nothing is saved blind.
 */
export function NewSmartListDialog({ open, suggested, keeps, onSave, onClose }: {
  open: boolean;
  suggested: string;
  /** What it will keep, in words: "Buyer Prospects · Type: Wholesaler". */
  keeps: string;
  onSave: (name: string, shared: boolean) => Promise<boolean>;
  onClose: () => void;
}) {
  if (!open) return null;
  return <NewSmartListForm key={suggested} suggested={suggested} keeps={keeps} onSave={onSave} onClose={onClose} />;
}

function NewSmartListForm({ suggested, keeps, onSave, onClose }: { suggested: string; keeps: string; onSave: (name: string, shared: boolean) => Promise<boolean>; onClose: () => void }) {
  const [name, setName] = useState(suggested);
  const [shared, setShared] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLFormElement>(null);
  useFocusTrap(box, onClose, 'input[name="smart-list-name"]');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) { setError('Give the list a name.'); return; }
    setSaving(true);
    setError('');
    const ok = await onSave(clean, shared);
    setSaving(false);
    if (!ok) setError('The list did not save. Check your connection and try again.');
  };
  return (
    <div role="presentation" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'grid', placeItems: 'center', background: 'rgba(12,13,16,.28)', padding: '16px' }}>
      <form ref={box} role="dialog" aria-modal="true" aria-labelledby="buyer-smart-list-title" onSubmit={submit} onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(420px, 100%)', background: '#fff', borderRadius: '14px', padding: '18px', boxShadow: '0 2.8px 2.2px rgba(0,0,0,.034), 0 6.7px 5.3px rgba(0,0,0,.048), 0 12.5px 10px rgba(0,0,0,.06), 0 22.3px 17.9px rgba(0,0,0,.072), 0 41.8px 33.4px rgba(0,0,0,.086), 0 100px 80px rgba(0,0,0,.12)' }}>
        <h2 id="buyer-smart-list-title" style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em', color: '#18181b' }}>New smart list</h2>
        <label htmlFor="buyer-smart-list-name" style={{ display: 'block', marginTop: '14px', fontSize: '11.5px', fontWeight: 500, color: '#71717a' }}>Name</label>
        <input id="buyer-smart-list-name" name="smart-list-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off"
          style={{ marginTop: '4px', width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e4e4e7', fontSize: '16px', fontWeight: 600, color: '#18181b' }} />
        <p style={{ margin: '10px 0 0', fontSize: '12.5px', color: '#3f3f46', lineHeight: 1.5 }}>
          <span style={{ color: '#71717a' }}>Keeps </span>{keeps}
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', minHeight: '32px', fontSize: '13px', color: '#18181b', cursor: 'pointer' }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} style={{ width: '16px', height: '16px', accentColor: '#0A8560' }} />
          Everyone on the team can open it
        </label>
        {error ? <p role="alert" style={{ margin: '8px 0 0', fontSize: '12.5px', color: '#b91c1c' }}>{error}</p> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <button type="button" className="dc2" onClick={onClose} style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', color: '#18181b', fontSize: '12.5px', fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" className="dc2" disabled={saving} style={{ height: '32px', padding: '0 14px', borderRadius: '8px', border: 0, background: '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: saving ? 'progress' : 'pointer', opacity: saving ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save list'}
          </button>
        </div>
      </form>
    </div>
  );
}
