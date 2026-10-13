'use client';

// Automated texts: Talkr's sequences inside CLOZR. Unlike an action plan,
// whose text steps become tasks a rep sends by hand, a sequence sends its
// texts itself from Talkr, stops on a reply or an answered call, and can hand
// the lead on to the next sequence when it finishes.
//
// The list and builder are ported from Talkr (SequenceList, SequenceBuilder);
// this file is the CLOZR seam: the one-page navigation between them, and the
// panel that enrolls CLOZR sellers from People and from the seller record.

import React, { useEffect, useState } from 'react';
import { api, type SequenceDto } from '@/lib/talkr-web/api';
import { useSoftphone } from '@/app/components/talkr/softphoneAdapter';
import { SequenceList } from './SequenceList';
import { SequenceBuilder } from './SequenceBuilder';
import { SKIP_REASON, enrollSellers, type EnrollOutcome, type EnrollSeller } from './enrollSellers';
import '@/app/clozr/talkr-dialer.css';

export function TextSequences({ headerLeft }: { headerLeft?: React.ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section data-screen-label="Automated texts" className="talkr-dialer" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {open ? (
        <SequenceBuilder key={open} id={open} onOpen={setOpen} onBack={() => setOpen(null)} headerLeft={headerLeft} />
      ) : (
        <SequenceList onOpen={setOpen} headerLeft={headerLeft} />
      )}
    </section>
  );
}

const label: React.CSSProperties = { fontSize: '11.5px', color: '#71717a', fontWeight: 600 };
const btn: React.CSSProperties = { height: '28px', padding: '0 10px', borderRadius: '7px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12px', cursor: 'pointer', color: '#18181b', whiteSpace: 'nowrap' };

/**
 * Pick a Talkr sequence and enroll these sellers. Talkr refuses opted-out
 * numbers and holds texts for quiet hours; anything it skips is listed here.
 */
export function EnrollSellersPanel({ sellers, onClose, onDone, compact = false }: {
  sellers: EnrollSeller[];
  onClose: () => void;
  onDone: (message: string) => void;
  /** The record rail: stacked, no strip background. */
  compact?: boolean;
}) {
  const { authed } = useSoftphone();
  const [sequences, setSequences] = useState<SequenceDto[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollOutcome | null>(null);

  useEffect(() => {
    if (!authed) return;
    let gone = false;
    api.listSequences()
      .then((r) => {
        if (gone) return;
        const on = r.sequences.filter((s) => s.enabled);
        setSequences(on);
        setPick((p) => p || on[0]?.id || '');
      })
      .catch((e: Error) => { if (!gone) { setSequences([]); setError(e.message); } });
    return () => { gone = true; };
  }, [authed]);

  const n = sellers.length;
  const run = async () => {
    if (!pick || busy) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await enrollSellers(pick, sellers);
      const name = sequences?.find((s) => s.id === pick)?.name ?? 'the sequence';
      const msg = `${r.enrolled} enrolled in ${name}${r.already ? ` · ${r.already} already in it` : ''}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`;
      if (r.skipped.length) setResult(r);
      else onDone(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const wrap: React.CSSProperties = compact
    ? { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }
    : { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 16px', background: '#fff', borderBottom: '1px solid #e4e4e7' };

  return (
    <div style={wrap} data-testid="enroll-text-sequence">
      {!compact ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={label}>Automated texts for {n} selected</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ ...btn, border: 0, background: 'none', color: '#71717a' }}>Close</button>
        </div>
      ) : null}
      {!authed ? (
        <span style={{ fontSize: '12px', color: '#71717a' }}>Talkr is not connected for this sign-in, so no sequence can send. See Account.</span>
      ) : sequences === null ? (
        <span style={{ fontSize: '12px', color: '#71717a' }}>Loading sequences…</span>
      ) : sequences.length === 0 && !error ? (
        <span style={{ fontSize: '12px', color: '#71717a' }}>No sequence is switched on. Build one under Action plans, Automated texts.</span>
      ) : sequences.length ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select aria-label="Text sequence" value={pick} onChange={(e) => setPick(e.target.value)}
            style={{ height: '30px', borderRadius: '8px', border: '1px solid #e4e4e7', padding: '0 8px', fontSize: '12.5px', background: '#fff', color: '#18181b', flex: compact ? '1 1 100%' : '0 1 280px', minWidth: 0 }}>
            {sequences.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.sms_count} {s.sms_count === 1 ? 'text' : 'texts'}</option>)}
          </select>
          <button type="button" className="dc3" onClick={() => void run()} disabled={busy || !pick || !n}
            style={{ ...btn, border: '1px solid #0A8560', background: '#0A8560', color: '#fff', fontWeight: 600, opacity: busy ? 0.6 : 1, flex: compact ? '1 1 auto' : 'none' }}>
            {busy ? 'Enrolling…' : n === 1 ? 'Start texts' : `Enroll ${n}`}
          </button>
          {compact ? <button type="button" onClick={onClose} style={btn}>Cancel</button> : null}
        </div>
      ) : null}
      <span style={{ fontSize: '11.5px', color: '#71717a', lineHeight: 1.45 }}>
        Talkr sends the texts itself. Opted-out numbers are never texted, and a text due in quiet hours waits for the next window.
      </span>
      {error ? <div role="alert" style={{ fontSize: '12px', color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '7px 10px' }}>{error}</div> : null}
      {result ? (
        <div role="status" style={{ fontSize: '12px', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '7px 10px' }}>
          {result.enrolled} enrolled{result.already ? `, ${result.already} already in` : ''}, {result.skipped.length} skipped:
          <ul style={{ margin: '4px 0 0', paddingLeft: '16px' }}>
            {result.skipped.slice(0, 20).map((s, i) => <li key={i}>{s.ref}: {SKIP_REASON[s.reason] ?? s.reason}</li>)}
            {result.skipped.length > 20 ? <li>…and {result.skipped.length - 20} more</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The seller record's "Automated texts" row, under Action plans. */
export function RecordTextSequence({ seller, toast }: { seller: EnrollSeller; toast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: '12px' }} data-testid="record-text-sequence">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={label}>Automated texts</span>
        {!open ? (
          <button type="button" className="dc12" onClick={() => setOpen(true)} style={{ fontSize: '11px', color: '#0A8560', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 600 }}>
            Enroll
          </button>
        ) : null}
      </div>
      {open ? <EnrollSellersPanel compact sellers={[seller]} onClose={() => setOpen(false)} onDone={(m) => { setOpen(false); toast(m); }} /> : null}
    </div>
  );
}
