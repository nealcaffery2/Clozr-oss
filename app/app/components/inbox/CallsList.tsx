'use client';

// The inbox's Calls and Voicemail tabs: Talkr's call history, one row a call,
// with call-back, the CLOZR record, and the recording played in place.

import React, { useState } from 'react';
import { type HistoryItemDto } from '@/lib/talkr-web/api';
import { formatPhone } from '@/lib/talkr-web/time';
import { Icon } from '@/app/components/talkr/Icon';
import { InboxRow } from './InboxRow';
import { TalkrCallRecording } from '@/app/components/record/CallRecording';
import { type RecordFor, isVoicemail, type useCalls } from './data';

const dur = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : null);
export const theirNumber = (h: HistoryItemDto) => (h.direction === 'inbound' ? h.from_number : h.to_number);
export const callLine = (h: HistoryItemDto) => [
  isVoicemail(h) ? 'Voicemail' : h.direction === 'inbound' ? 'Incoming' : 'Outgoing',
  dur(h.duration_seconds) ?? h.status.replace(/_/g, ' '),
  h.disposition_label, h.note ? `“${h.note}”` : null, h.user_name,
].filter(Boolean).join(' · ');
export const shortTime = (iso: string) => {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export function CallsList({ calls, voicemailOnly, authed, recordFor, placeCall, openId }: {
  calls: ReturnType<typeof useCalls>; voicemailOnly: boolean; authed: boolean;
  recordFor?: RecordFor; placeCall: (e164: string) => void; openId?: string | null;
}) {
  // The All tab remounts this (keyed) to open a call, so the prop only seeds the state.
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [q, setQ] = useState('');

  if (!authed) {
    return <p className="p-6" style={{ font: '400 13px/1.5 var(--sans)', color: 'var(--muted)' }}>Talkr isn’t connected to this sign-in yet — check the dialer, or Settings → Integrations.</p>;
  }
  const needle = q.trim().toLowerCase();
  const rows = calls.calls
    .filter((h) => !voicemailOnly || isVoicemail(h))
    .filter((h) => !needle || [h.contact_name, theirNumber(h), h.note, h.address].some((v) => v?.toLowerCase().includes(needle)));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" style={{ background: 'var(--panel)' }}>
      <div className="flex items-center gap-2 px-3 py-3">
        <div className="search-pill flex flex-1 items-center gap-2">
          <Icon name="search" size={14} style={{ color: '#8e8e93', flexShrink: 0 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={voicemailOnly ? 'Search voicemail' : 'Search calls'} className="min-w-0 flex-1 bg-transparent outline-none" style={{ font: '400 15px/1 var(--sans)', padding: '7px 0' }} />
        </div>
        <button type="button" onClick={calls.reload} style={{ font: '600 12px/1 var(--sans)', color: 'var(--accent)', cursor: 'pointer' }}>{calls.loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {calls.error && <p className="p-4" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--red)' }}>{calls.error}</p>}
        {!calls.loading && rows.length === 0 && (
          <p className="p-4" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>{voicemailOnly ? 'No voicemail.' : 'No calls yet.'}</p>
        )}
        {rows.map((h) => {
          const number = theirNumber(h);
          const rec = recordFor ? recordFor(number) : undefined;
          const missed = h.direction === 'inbound' && !h.duration_seconds;
          return (
            <React.Fragment key={h.id}>
              <InboxRow
                name={h.contact_name ?? rec?.name ?? formatPhone(number)}
                time={shortTime(h.at)}
                preview={callLine(h)}
                record={rec}
                unread={missed}
                icon={<Icon name={isVoicemail(h) ? 'voicemail' : 'phone'} size={12} style={{ color: missed ? 'var(--red)' : '#8e8e93', marginRight: 5, verticalAlign: -1 }} />}
                active={open === h.id}
                onOpen={() => setOpen(open === h.id ? null : h.id)}
                trailing={
                  <button type="button" aria-label={`Call ${formatPhone(number)}`} onClick={() => placeCall(number)} className="mr-3 self-center inline-flex h-9 w-9 items-center justify-center rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', cursor: 'pointer' }}>
                    <Icon name="phone" size={16} />
                  </button>
                }
              />
              {open === h.id && <CallDetail h={h} record={rec ?? null} />}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function CallDetail({ h, record }: { h: HistoryItemDto; record: ReturnType<RecordFor> }) {
  // The player loads the recording and transcript itself; the button keeps a
  // glance at the row from downloading audio nobody asked to hear.
  const [play, setPlay] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 py-2.5 pr-4" style={{ paddingLeft: 72, background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}>
      <span className="basis-full" style={{ font: '400 12.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
        {formatPhone(theirNumber(h))} · {new Date(h.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{h.address ? ` · ${h.address}` : ''}
      </span>
      {h.has_recording && !play && (
        <button type="button" onClick={() => setPlay(true)} className="inline-flex items-center gap-1.5" style={{ padding: '6px 11px', borderRadius: 16, background: 'var(--accent)', color: '#fff', font: '600 12px/1 var(--sans)', cursor: 'pointer' }}>
          <Icon name="play" size={12} /> Play
        </button>
      )}
      {play && (
        <div className="basis-full" style={{ minWidth: 0 }}>
          <TalkrCallRecording talkrCallId={h.id} contactName={h.contact_name ?? record?.name ?? null} autoPlay />
        </div>
      )}
      {record && (
        <button type="button" onClick={record.open} className="inline-flex items-center gap-1" style={{ font: '600 12px/1 var(--sans)', color: 'var(--accent)', cursor: 'pointer' }}>
          Go to record <Icon name="chevron-right" size={12} />
        </button>
      )}
    </div>
  );
}
