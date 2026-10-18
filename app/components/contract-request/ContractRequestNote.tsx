// What acquisitions asked for, on the draft it made: shown at the top of the
// contract's popup in Contracts, so the TC reviews the draft against the
// request, the rep's notes and the call. Also the sample data's stand-in for
// the draft (DemoRequests), since the demo saves no contracts.
'use client';

import React, { useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { KIND_LABELS, type ContractKind } from '@/lib/contracts';
import { type RequestPayload, longDate } from '@/lib/contract-request';
import { type RequestRow, requestForContract } from '@/lib/contract-request-api';
import { type DemoRequest, setPendingContract, useRequestStore } from '@/lib/contract-request-store';
import { C, CR_CSS, Dialog, DialogHead, Glyph } from './parts';

type Shown = {
  kind: string; template: string | null; party: { side?: string; name?: string; phone?: string; email?: string } | null; address: string | null;
  price: number | null; closing: string | null; emd: number | null; terms: Record<string, string> | null; notes: string | null; summary: string | null;
  who: string; when: string; status: string;
};

const dollars = (n: number | null) => (n == null ? null : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const stamp = (iso: string | number) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The request card itself. */
export function RequestCard({ r }: { r: Shown }) {
  const facts: [string, string | null][] = [
    [r.party?.side === 'buyer' ? 'Buyer' : 'Seller', r.party?.name || null],
    ['Phone', r.party?.phone || null],
    ['Email', r.party?.email || null],
    ['Property', r.address],
    ['Price', dollars(r.price)],
    ['Closing', r.closing ? longDate(r.closing) : null],
    ['Earnest money', dollars(r.emd)],
    ...Object.entries(r.terms ?? {}).map(([k, v]) => [k.replace(/^\w+\./, '').replace(/([a-z])([A-Z])/g, '$1 $2'), v] as [string, string]),
  ];
  return (
    <section data-cr="" aria-label="Contract request" style={{ background: 'var(--surface, #fff)', border: `1px solid ${C.tintLine}`, borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
      <style>{CR_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: C.accent, display: 'inline-flex' }}><Glyph name="file-signature" size={16} /></span>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 650 }}>Requested from a call by {r.who}</h3>
        <span style={{ fontSize: 11.5, color: C.muted }}>{r.when}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 6, background: r.status === 'open' ? C.tint : 'var(--surface-2, #f4f4f5)', color: r.status === 'open' ? C.accentHover : C.ink2 }}>
          {r.status === 'open' ? 'New request' : r.status === 'seen' ? 'Seen' : r.status === 'done' ? 'Done' : r.status}
        </span>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: C.muted }}>{[KIND_LABELS[r.kind as ContractKind] ?? r.kind, r.template].filter(Boolean).join(' · ')}. Review the draft, then send it from the card below.</div>
      <dl style={{ margin: '12px 0 0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 16px' }}>
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <dt style={{ fontSize: 11.5, color: C.muted }}>{k}</dt>
            <dd style={{ margin: 0, fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{v}</dd>
          </div>
        ))}
      </dl>
      {r.notes ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 3 }}>Notes</div>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{r.notes}</p>
        </div>
      ) : null}
      {r.summary ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 3 }}>From the call</div>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: C.ink2, background: C.page, border: `1px solid ${C.hair}`, borderRadius: 8, padding: '8px 10px', maxHeight: 220, overflow: 'auto' }}>{r.summary}</p>
        </div>
      ) : null}
    </section>
  );
}

const fromRow = (r: RequestRow, who: string): Shown => ({
  kind: r.kind, template: r.template_name, party: r.party, address: r.address, price: r.price, closing: r.closing_date, emd: r.emd,
  terms: r.terms, notes: r.notes, summary: r.summary, who, when: stamp(r.created_at), status: r.status,
});
const fromPayload = (p: RequestPayload, at: number): Shown => ({
  kind: p.kind, template: p.template_name, party: p.party, address: p.address, price: p.price, closing: p.closing_date, emd: p.emd,
  terms: p.terms, notes: p.notes, summary: p.summary, who: p.requester_name, when: stamp(at), status: 'open',
});

/** The request behind a contract, at the top of its popup. Renders nothing for a contract made any other way. */
export function ContractRequestNote({ workspaceId, contractId, nameOf }: { workspaceId: number; contractId: number; nameOf: (id: string | null) => string }) {
  const [row, setRow] = useState<{ id: number; r: RequestRow | null } | null>(null);
  useEffect(() => {
    let live = true;
    void requestForContract(workspaceId, contractId).then((r) => { if (live) setRow({ id: contractId, r }); });
    return () => { live = false; };
  }, [workspaceId, contractId]);
  const r = row && row.id === contractId ? row.r : null;
  return r ? <RequestCard r={fromRow(r, nameOf(r.requested_by))} /> : null;
}

/**
 * The sample data's requests, on the Contracts screen in place of the
 * database list. One opens on its request, as the TC's draft would.
 */
export function DemoRequests({ V }: { V: ClozrView }) {
  const { demo, pending } = useRequestStore();
  const [open, setOpen] = useState<DemoRequest | null>(null);
  // Opened from the TC's alert or "Open draft": shown once, then cleared.
  const want = typeof pending === 'string' ? demo.find((d) => d.id === pending) ?? null : null;
  if (want && open?.id !== want.id) setOpen(want);
  useEffect(() => { if (want) setPendingContract(null); }, [want]);
  void V;
  if (!demo.length) return null;
  return (
    <div data-cr="" style={{ marginBottom: 16 }}>
      <style>{CR_CSS}</style>
      <div style={{ fontSize: 11.5, color: C.muted, margin: '0 0 6px' }}>Requested from calls · sample data, kept in this browser only</div>
      <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
        {demo.map((d, i) => (
          <button key={d.id} type="button" onClick={() => setOpen(d)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '10px 14px', border: 0, borderTop: i ? `1px solid ${C.hair}` : 0, background: 'var(--surface, #fff)', cursor: 'pointer', fontFamily: 'inherit', color: C.ink }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span title={d.payload.address || undefined} style={{ display: 'block', fontSize: 13.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {KIND_LABELS[d.payload.kind] ?? 'Contract'}{d.payload.address ? ` · ${d.payload.address.split(',')[0]}` : ''}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: C.muted }}>{d.payload.party.name} · requested by {d.payload.requester_name} for {d.tcName}</span>
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 6, background: 'var(--surface-2, #f4f4f5)', color: 'var(--muted, #52525b)' }}>Draft</span>
          </button>
        ))}
      </div>
      {open ? (
        <Dialog labelledBy={`demo-req-${open.id}`} onClose={() => setOpen(null)} width={880} z={80}>
          <DialogHead id={`demo-req-${open.id}`} onClose={() => setOpen(null)}
            title={`${KIND_LABELS[open.payload.kind] ?? 'Contract'} · ${open.payload.party.name}${open.payload.address ? ` · ${open.payload.address.split(',')[0]}` : ''}`}
            sub={`Draft for ${open.tcName} to review · sample data`} />
          <div style={{ overflow: 'auto', padding: 18, background: C.page }}>
            <RequestCard r={fromPayload(open.payload, open.createdAt)} />
            <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
              In a workspace this opens the draft contract itself: the template filled from {open.payload.party.name}’s record with these terms, ready for {open.tcName} to review and send for signature.
            </p>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
