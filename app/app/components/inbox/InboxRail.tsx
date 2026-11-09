'use client';

// The folder rail beside the All list (SmarterContact's messenger rail): the
// seven folders with their counts, the filters the rep saved, and Quick
// replies. A column on a desk; on a phone it is one scrolling strip above
// the list. Deal blasts: one inbox per deal still being marketed.

import React from 'react';
import { Archive, Ban, Bookmark, Clock, House, Inbox, Mail, MessageSquare, MessageSquareReply, PhoneMissed, Plus, X, Zap } from 'lucide-react';
import { type Folder, type FolderItem, type SavedFilter, foldersFor } from '@/lib/inbox-folders';

const ICON: Record<Folder, React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>> = {
  all: Inbox, unread: Mail, missed: PhoneMissed, unreplied: MessageSquareReply, awaiting: MessageSquare, scheduled: Clock, optout: Ban, archived: Archive,
};

export function InboxRail({ folder, counts, onFolder, saved, savedId, onSaved, onNewFilter, onRemoveFilter, onQuickReplies, kind = null, blasts = [], blastDeal = null, onBlast }: {
  folder: Folder;
  /** The channel tab the rail sits beside (null on All): folders that cannot apply there are left out. */
  kind?: FolderItem['kind'] | null;
  counts: Record<Folder, number>;
  onFolder: (f: Folder) => void;
  saved: SavedFilter[];
  /** The saved filter in force, if one is. */
  savedId: string | null;
  onSaved: (f: SavedFilter) => void;
  onNewFilter: () => void;
  onRemoveFilter: (f: SavedFilter) => void;
  onQuickReplies: (() => void) | null;
  /** Deals with a live blast: picking one shows only the buyers it texted. */
  blasts?: { deal_id: number; address: string }[];
  blastDeal?: number | null;
  onBlast?: (dealId: number | null) => void;
}) {
  return (
    <nav className="ax-rail" aria-label="Inbox folders">
      <ul className="ax-rail-list">
        {foldersFor(kind).map((f) => {
          const I = ICON[f.id];
          const n = counts[f.id];
          return (
            <li key={f.id}>
              <button type="button" className="ax-rail-item" aria-current={folder === f.id && !savedId ? 'page' : undefined} title={f.hint} onClick={() => onFolder(f.id)}>
                <I size={15} strokeWidth={2} aria-hidden />
                <span className="ax-rail-label">{f.label}</span>
                {/* Counts that mean work: unread, missed, unreplied, scheduled. The rest are sizes nobody acts on. */}
                {n > 0 && (f.id === 'unread' || f.id === 'missed' || f.id === 'unreplied' || f.id === 'scheduled') ? <span className="ax-rail-n" data-hot={f.id === 'unread' || undefined}>{n}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="ax-rail-sec">
        <span className="ax-rail-h">Saved filters</span>
        <button type="button" className="ax-rail-plus" aria-label="New saved filter" title="Set up a filter and save it here" onClick={onNewFilter}><Plus size={14} strokeWidth={2.25} aria-hidden /></button>
      </div>
      <ul className="ax-rail-list">
        {saved.map((s) => (
          <li key={s.id} className="ax-rail-saved">
            <button type="button" className="ax-rail-item" aria-current={savedId === s.id ? 'page' : undefined} onClick={() => onSaved(s)} title={`Apply “${s.name}”`}>
              <Bookmark size={15} strokeWidth={2} aria-hidden />
              <span className="ax-rail-label">{s.name}</span>
            </button>
            <button type="button" className="ax-rail-x" aria-label={`Delete the saved filter ${s.name}`} onClick={() => onRemoveFilter(s)}><X size={12} strokeWidth={2.25} aria-hidden /></button>
          </li>
        ))}
        {saved.length === 0 ? <li className="ax-rail-none">None yet. Filter the list, then Save filter.</li> : null}
      </ul>
      {blasts.length && onBlast ? (
        <>
          <div className="ax-rail-sec"><span className="ax-rail-h">Deal blasts</span></div>
          <ul className="ax-rail-list" data-testid="inbox-blasts">
            {blasts.map((b) => (
              <li key={b.deal_id}>
                <button type="button" className="ax-rail-item" aria-current={blastDeal === b.deal_id ? 'page' : undefined}
                  title={blastDeal === b.deal_id ? 'Back to every thread' : `Only buyers the ${b.address} blast texted`}
                  onClick={() => onBlast(blastDeal === b.deal_id ? null : b.deal_id)}>
                  <House size={15} strokeWidth={2} aria-hidden />
                  <span className="ax-rail-label">{b.address}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {onQuickReplies ? (
        <button type="button" className="ax-rail-item ax-rail-quick" onClick={onQuickReplies} title="SMS and email templates">
          <Zap size={15} strokeWidth={2} aria-hidden />
          <span className="ax-rail-label">Quick replies</span>
        </button>
      ) : null}
    </nav>
  );
}
