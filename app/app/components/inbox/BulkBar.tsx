'use client';

// The bar over the All list while threads are selected: mark read or unread,
// label, archive, assign the sellers to a rep, push them into a Talkr text
// sequence or a dialer campaign. The pushes reuse what People has
// (enrollSellers, SendToCampaign); assignment is the same sellers.assigned_to
// write People's Assign panel makes.

import React, { useEffect, useState } from 'react';
import { Archive, Mail, MailOpen, X } from 'lucide-react';
import type { AssignMate } from '@/app/components/bulk/AssignPanel';
import { type Disposition, DISPOSITIONS, DISPOSITION_TONE } from '@/lib/inbox-folders';
import { type SequenceDto, api } from '@/lib/talkr-web/api';
import { Menu } from './Menu';

export function BulkBar({ count, sellers, team, talkr, onClear, onRead, onUnread, onLabel, onArchive, onAssign, onEnroll, onCampaign }: {
  count: number;
  /** How many of the selected threads are on a seller record. */
  sellers: number;
  team: AssignMate[];
  /** Talkr is linked (sequences and campaigns run there). */
  talkr: boolean;
  onClear: () => void;
  onRead: () => void;
  onUnread: () => void;
  onLabel: (d: Disposition) => void;
  onArchive: () => void;
  onAssign: (userId: string | null, name: string) => void;
  onEnroll: (s: SequenceDto) => void;
  onCampaign: () => void;
}) {
  const [seqs, setSeqs] = useState<SequenceDto[] | null>(talkr ? null : []);
  const [seqErr, setSeqErr] = useState<string | null>(null);
  useEffect(() => {
    if (!talkr) return;
    let on = true;
    api.listSequences().then(({ sequences }) => { if (on) setSeqs(sequences.filter((s) => s.enabled)); })
      .catch((e: unknown) => { if (on) { setSeqs([]); setSeqErr(e instanceof Error ? e.message : 'Talkr did not answer'); } });
    return () => { on = false; };
  }, [talkr]);
  const none = sellers === 0 ? 'None of the selected threads is on a seller record' : undefined;
  return (
    <div className="ax-bulk" role="toolbar" aria-label="Selected threads">
      <span className="ax-bulk-n" role="status">{count} selected</span>
      <button type="button" className="ax-tool" onClick={onRead} title="Mark read"><MailOpen size={14} aria-hidden />Read</button>
      <button type="button" className="ax-tool" onClick={onUnread} title="Mark unread"><Mail size={14} aria-hidden />Unread</button>
      <Menu label="Label" heading="Add a label" items={DISPOSITIONS.map((d) => ({ label: d, swatch: DISPOSITION_TONE[d].fg, run: () => onLabel(d) }))} />
      <button type="button" className="ax-tool" onClick={onArchive} title="Archive: off the list until something new happens"><Archive size={14} aria-hidden />Archive</button>
      <Menu label="Assign" heading={sellers ? `Assign ${sellers} seller${sellers === 1 ? '' : 's'} to` : 'Assign'} empty={none ?? 'No teammates yet'}
        items={sellers ? [...team.map((m) => ({ label: m.name, run: () => onAssign(m.id, m.name) })), { label: 'Nobody', run: () => onAssign(null, 'nobody') }] : []} />
      <Menu label="Sequence" heading={sellers ? `Enrol ${sellers} seller${sellers === 1 ? '' : 's'} in` : 'Sequence'}
        empty={none ?? (!talkr ? 'Talkr is not linked to this sign-in' : seqErr ? `Sequences did not load: ${seqErr}` : seqs === null ? 'Loading sequences…' : 'No enabled text sequences in Talkr')}
        items={sellers ? (seqs ?? []).map((s) => ({ label: s.name, hint: s.description ?? undefined, run: () => onEnroll(s) })) : []} />
      <button type="button" className="ax-tool" onClick={onCampaign} disabled={!sellers || !talkr} title={none ?? (!talkr ? 'Talkr is not linked to this sign-in' : 'Send the sellers to a Talkr dialer campaign')}>Campaign</button>
      <button type="button" className="ax-icon-btn ax-bulk-x" aria-label="Clear selection" onClick={onClear}><X size={15} strokeWidth={2.25} aria-hidden /></button>
    </div>
  );
}
