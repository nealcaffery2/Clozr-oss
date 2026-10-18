'use client';

// The folder rail beside the All list (SmarterContact's messenger rail): the
// seven folders with their counts, the filters the rep saved, and Quick
// replies. A column on a desk; on a phone it is one scrolling strip above
// the list.

import React from 'react';
import { Archive, Ban, Bookmark, Inbox, Mail, MessageSquare, MessageSquareReply, PhoneMissed, Plus, X, Zap } from 'lucide-react';
import { FOLDERS, type Folder, type SavedFilter } from '@/lib/inbox-folders';

const ICON: Record<Folder, React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>> = {
  all: Inbox, unread: Mail, missed: PhoneMissed, unreplied: MessageSquareReply, awaiting: MessageSquare, optout: Ban, archived: Archive,
};

export function InboxRail({ folder, counts, onFolder, saved, savedId, onSaved, onNewFilter, onRemoveFilter, onQuickReplies }: {
  folder: Folder;
  counts: Record<Folder, number>;
  onFolder: (f: Folder) => void;
  saved: SavedFilter[];
  /** The saved filter in force, if one is. */
  savedId: string | null;
  onSaved: (f: SavedFilter) => void;
  onNewFilter: () => void;
  onRemoveFilter: (f: SavedFilter) => void;
  onQuickReplies: (() => void) | null;
}) {
  return (
    <nav className="ax-rail" aria-label="Inbox folders">
      <ul className="ax-rail-list">
        {FOLDERS.map((f) => {
          const I = ICON[f.id];
          const n = counts[f.id];
          return (
            <li key={f.id}>
              <button type="button" className="ax-rail-item" aria-current={folder === f.id && !savedId ? 'page' : undefined} title={f.hint} onClick={() => onFolder(f.id)}>
                <I size={15} strokeWidth={2} aria-hidden />
                <span className="ax-rail-label">{f.label}</span>
                {/* Counts that mean work: unread, missed, unreplied. The rest are sizes nobody acts on. */}
                {n > 0 && (f.id === 'unread' || f.id === 'missed' || f.id === 'unreplied') ? <span className="ax-rail-n" data-hot={f.id === 'unread' || undefined}>{n}</span> : null}
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
      {onQuickReplies ? (
        <button type="button" className="ax-rail-item ax-rail-quick" onClick={onQuickReplies} title="SMS and email templates">
          <Zap size={15} strokeWidth={2} aria-hidden />
          <span className="ax-rail-label">Quick replies</span>
        </button>
      ) : null}
    </nav>
  );
}
