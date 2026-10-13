'use client';

// One row in a conversation list.
//
// It is shared: Calls, Voicemail and the All tab all render it, and so does the
// Email tab until that one becomes Gmail. It lived inside EmailInbox.tsx, which
// meant the three tabs that have nothing to do with email imported their row
// from the email screen — so rebuilding the email screen could not help but put
// them at risk. It is its own file now, and nothing about it changed in the
// move.

import React from 'react';
import { Icon } from '@/app/components/talkr/Icon';
import { Avatar } from '@/app/components/talkr/ui';
import type { ClozrRecord } from '@/app/components/talkr/MessagesScreen';

export function InboxRow({ name, time, title, preview, record, active, unread, icon, onOpen, trailing }: {
  name: string; time: string; title?: string; preview: string;
  /** undefined outside CLOZR; null when no record has this address or number. */
  record?: ClozrRecord | null;
  active: boolean; unread?: boolean; icon?: React.ReactNode; onOpen: () => void; trailing?: React.ReactNode;
}) {
  return (
    <div className="ios-row group flex items-stretch" style={{ background: active ? 'var(--accent-soft)' : 'var(--panel)' }}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2 py-2.5 pl-1.5 pr-2 text-left" style={{ cursor: 'pointer', background: 'transparent' }}>
        <span aria-label={unread ? 'Unread' : undefined} style={{ width: 10, height: 10, borderRadius: '50%', background: unread ? 'var(--accent)' : 'transparent', flexShrink: 0, alignSelf: 'center' }} />
        <Avatar name={name} size={44} />
        <span className="ios-row-body flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="mr-auto truncate" style={{ font: '600 15px/1.25 var(--sans)', color: 'var(--text)' }}>{icon}{name}</span>
            <span style={{ font: '400 13px/1 var(--sans)', color: '#8e8e93', whiteSpace: 'nowrap' }}>{time}</span>
            <Icon name="chevron-right" size={13} style={{ color: '#c7c7cc' }} />
          </span>
          {title && <span className="truncate" style={{ font: '500 13.5px/1.3 var(--sans)', color: 'var(--text)' }}>{title}</span>}
          <span style={{ font: '400 14px/1.3 var(--sans)', color: '#8e8e93', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{preview}</span>
          {record !== undefined && (
            <span className="truncate" style={{ font: '600 11px/1.3 var(--sans)', color: record ? (record.kind === 'seller' ? '#15803d' : '#1d4ed8') : 'var(--muted-2)' }}>
              {record ? [record.kind === 'seller' ? 'Seller' : 'Buyer', record.name, record.address].filter(Boolean).join(' · ') : 'Not in CLOZR'}
            </span>
          )}
        </span>
      </button>
      {trailing}
    </div>
  );
}
