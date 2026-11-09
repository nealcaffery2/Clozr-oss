// Every contract in the workspace in one place: the Contracts screen, and the
// same list as a popup from People, Dispo and Buyers. A contract opens in a
// wide centered popup with the full contracts card for its seller, deal and
// buyer, rather than squeezed into the record's side rail.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ContractsCard } from '@/components/ContractsCard';
import { ExtractedTermsView } from '@/components/ContractTerms';
import { type ContractRow, type DocFolder, KIND_LABELS, contractFolders, fileContract, folderOp, listAllContracts, listSigners, statusLabel } from '@/lib/contracts';
import { TemplateLibrary } from '@/components/TemplateLibrary';
import { DocImport } from '@/components/DocImport';
import { BulkSendPanel, DocsReports, FormLinksPanel } from '@/components/DocsTools';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import { folderAndBelow, folderTree } from '@/supabase/functions/_shared/doc-library';
import { useFocusTrap } from '@/app/components/record/useModal';
import { saveRecipientToCrm, searchContacts } from '@/lib/contract-recipients';
import type { Contact } from '@/lib/contact-search';
import { KindBadge } from '@/components/RecipientPicker';
import { loadDealForSeller } from '@/lib/deal-sheet';
import { supabase } from '@/lib/supabase';
import type { ClozrView } from '@/app/clozr/view';
import { ContractRequestNote, DemoRequests } from '@/components/contract-request/ContractRequestNote';
import { requestedContracts } from '@/lib/contract-request-api';
import { setPendingContract, useRequestStore } from '@/lib/contract-request-store';
import { DealSmartSummary, DealSummaryList } from '@/app/components/record/DealSmartSummary';
import { demoDealMemory } from '@/lib/deal-memory';
import { ScreenHeader } from '@/components/ds/Screen';

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const HAIR = 'var(--divider-2, #f0f0f1)';
const GREEN = '#0A8560';

type Directory = ReturnType<ClozrView['contractDirectory']>;
// A record's own Contracts card names one house, so the list of houses is optional.
type Seller = Omit<Directory['sellers'][number], 'houses'> & Partial<Pick<Directory['sellers'][number], 'houses'>>;
type Buyer = Directory['buyers'][number];
/** Who the popup's contracts card is about. */
type Target = { sellerId: number | null; dealId: number | null; buyerId: number | null; title: string; seller?: Seller; buyer?: Buyer;
  /** The contract opened from the list: a request from the dialer (migration 270) shows above the card. */
  contractId?: number | null };

const btn = (primary = false): React.CSSProperties => ({
  height: '32px', padding: '0 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : 'var(--surface, #fff)', color: primary ? 'var(--surface, #fff)' : INK, fontFamily: 'inherit',
});
const chip = (on: boolean): React.CSSProperties => ({
  height: '30px', padding: '0 11px', borderRadius: '999px', fontSize: '12px', fontWeight: on ? 650 : 500, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? GREEN : LINE}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)', color: on ? GREEN : 'var(--ink-2, #27272a)', fontFamily: 'inherit',
});
const th: React.CSSProperties = { position: 'sticky', top: 0, background: 'var(--c-thead, #fafafa)', borderBottom: `1px solid ${LINE}`, padding: '0 12px', height: '36px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: 'var(--meta, #71717a)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '0 12px', height: '46px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap', color: 'var(--muted, #52525b)', fontSize: '12.5px' };
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

const DAY = 864e5;
const FILTERS = [
  { id: 'all', label: 'All', test: (c: ContractRow, now: number) => !!c && now >= 0 },
  { id: 'draft', label: 'Drafts', test: (c: ContractRow) => !c.sent_at && !['completed', 'voided', 'declined', 'expired', 'awaiting_approval'].includes(c.status) },
  // Migration 114: held for an internal sign-off (the COO on an assignment) before anyone signs.
  { id: 'approval', label: 'Awaiting approval', test: (c: ContractRow) => c.status === 'awaiting_approval' },
  { id: 'out', label: 'Awaiting signature', test: (c: ContractRow) => ['sent', 'viewed'].includes(c.status) },
  { id: 'soon', label: 'Expiring soon', test: (c: ContractRow, now: number) => ['sent', 'viewed'].includes(c.status) && !!c.expires_at && Date.parse(c.expires_at) - now < 3 * DAY },
  { id: 'signed', label: 'Completed', test: (c: ContractRow) => c.status === 'completed' },
  { id: 'expired', label: 'Expired', test: (c: ContractRow) => c.status === 'expired' },
  { id: 'dead', label: 'Voided / declined', test: (c: ContractRow) => ['voided', 'declined', 'rejected'].includes(c.status) },
] as const;
type Progress = { signed: number; total: number; viewed: number };
/** contracts.folder_id is migration 115; the generated row type predates it. */
const folderOfContract = (c: ContractRow) => (c as ContractRow & { folder_id?: number | null }).folder_id ?? null;

/** A centered dialog: wide enough for the contracts card, Escape and click-away close it.
 *  Portaled to the document: the record's right rail uses `contain: layout`, which
 *  would otherwise pin this fixed layer inside that narrow column. */
export function CenteredDialog({ title, onClose, children, width = 1040, z = 70 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number; z?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useFocusTrap(ref, onClose);
  // During render, not an effect: set-state-in-effect fails CI, and the
  // initializer would stay null after a server render.
  if (host === null && typeof document !== 'undefined') setHost(document.body);
  useEffect(() => {
    if (!host) return;
    const first = ref.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    first?.focus({ preventScroll: true });
  }, [host]);
  if (!host) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: z, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center', padding: '16px' }}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: width, maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--surface, #fff)', borderRadius: '14px', boxShadow: '0 24px 70px rgba(0,0,0,.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 18px', borderBottom: `1px solid ${LINE}` }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ width: '32px', height: '32px', borderRadius: '8px', border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflow: 'auto', padding: '18px', background: 'var(--canvas, #fafafa)', flex: 1 }}>{children}</div>
      </div>
    </div>,
    host,
  );
}

/** The full contracts card for one seller, deal or buyer, centered. */
export function ContractPopup({ V, target, onClose, onChanged, startTemplateId, newSend }: { V: ClozrView; target: Target; onClose: () => void; onChanged?: () => void; startTemplateId?: number | null; /** Fresh send after party pick: choose template vs one-off first. */ newSend?: boolean }) {
  const ids = V.liveIds;
  // "New contract" lists the templates first; the pick reopens the card on that template, filled in.
  const [picking, setPicking] = useState(false);
  const [start, setStart] = useState<{ id: number | null; n: number }>({ id: startTemplateId ?? null, n: 0 });
  const [chooseSend, setChooseSend] = useState(newSend && !startTemplateId && !target.contractId);
  const bigBtn: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '6px', width: '100%', textAlign: 'left',
    padding: '18px 16px', borderRadius: '12px', border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', cursor: 'pointer', fontFamily: 'inherit',
  };
  if (chooseSend && ids?.workspaceId) {
    return (
      <CenteredDialog title={`New contract · ${target.title.replace(/^Contracts · /, '')}`} onClose={onClose} width={520} z={80}>
        <p style={{ margin: '0 0 14px', fontSize: '14px', color: 'var(--muted, #52525b)', lineHeight: 1.45 }}>How do you want to send it?</p>
        <div style={{ display: 'grid', gap: '10px' }}>
          <button type="button" className="dc2" onClick={() => { setChooseSend(false); setPicking(true); }} style={bigBtn}>
            <span style={{ fontSize: '16px', fontWeight: 700, color: INK }}>From templates</span>
            <span style={{ fontSize: '13px', color: MUTED }}>Pick a saved PDF or CLOZR template — fields fill from the record.</span>
          </button>
          <button type="button" className="dc2" onClick={() => { setChooseSend(false); setStart((s) => ({ id: -1, n: s.n + 1 })); }} style={bigBtn}>
            <span style={{ fontSize: '16px', fontWeight: 700, color: INK }}>One-time send</span>
            <span style={{ fontSize: '13px', color: MUTED }}>Upload a PDF or use the full editor without starting from a template.</span>
          </button>
        </div>
      </CenteredDialog>
    );
  }
  return (
    <CenteredDialog title={target.title} onClose={onClose} z={80}>
      {target.contractId && ids?.workspaceId ? (
        <ContractRequestNote workspaceId={ids.workspaceId} contractId={target.contractId}
          nameOf={(id) => V.requestTeam.find((m) => m.id === id)?.name ?? 'a teammate'} />
      ) : null}
      {target.dealId && ids?.workspaceId ? <DealSmartSummary key={target.dealId} workspaceId={ids.workspaceId} dealId={target.dealId} /> : null}
      <ContractsCard
        key={start.n}
        workspaceId={ids?.workspaceId ?? null}
        sellerId={target.sellerId}
        dealId={target.dealId}
        buyerId={target.buyerId}
        seller={target.seller ? { name: target.seller.name, email: target.seller.email, phone: target.seller.phone } : undefined}
        buyer={target.buyer ? { name: target.buyer.name, email: target.buyer.email, phone: target.buyer.phone } : undefined}
        canWrite={!!ids?.canWrite}
        onToast={V.showToast}
        onChanged={() => { onChanged?.(); V.reloadCrm(); }}
        onNewContract={() => setPicking(true)}
        startTemplateId={start.id}
      />
      {picking && ids?.workspaceId ? (
        <ContractTemplatePicker
          workspaceId={ids.workspaceId}
          who={target.seller?.name ?? target.buyer?.name ?? target.title}
          onPick={(id) => { setPicking(false); setStart((s) => ({ id, n: s.n + 1 })); }}
          // No template: the full form, open, with its upload and PandaDoc options.
          onOther={() => { setPicking(false); setStart((s) => ({ id: -1, n: s.n + 1 })); }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </CenteredDialog>
  );
}

/**
 * Someone not in the CRM yet, added from the picker: saved to People (with the
 * property, and a deal opened for it) or Buyers, matched instead when the same
 * email or phone is already there, so the contract lands on the record and the deal.
 */
function NewParty({ workspaceId, kind, start, onDone, onCancel }: { workspaceId: number; kind: 'seller' | 'buyer'; start: string; onDone: (t: Target) => void; onCancel: () => void }) {
  const [name, setName] = useState(start);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input: React.CSSProperties = { height: '36px', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 10px', fontSize: '14px', background: 'var(--surface, #fff)', width: '100%', boxSizing: 'border-box' };
  async function save() {
    setBusy(true); setErr(null);
    const { data: auth } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
    const uid = auth.user?.id ?? null;
    const r = await saveRecipientToCrm(workspaceId, { name, email, phone, addr }, kind, uid);
    if (!r.ok) { setBusy(false); setErr(r.message); return; }
    if (kind === 'buyer') { onDone({ sellerId: null, dealId: null, buyerId: Number(r.link.buyer_id), title: `Contracts · ${name.trim()}` }); return; }
    const sellerId = Number(r.link.seller_id);
    const d = await loadDealForSeller(workspaceId, sellerId, uid, true);
    setBusy(false);
    onDone({ sellerId, dealId: d.deal?.id ?? null, buyerId: null, title: `Contracts · ${name.trim()}${addr.trim() ? ` · ${addr.trim()}` : ''}` });
  }
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', background: 'var(--surface, #fff)', padding: '14px', display: 'grid', gap: '10px' }}>
      <div style={{ fontSize: '15px', fontWeight: 650, color: INK }}>New {kind === 'seller' ? 'seller' : 'buyer'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" aria-label="Full name" style={input} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" type="email" style={input} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" aria-label="Phone" type="tel" style={input} />
        {kind === 'seller' ? <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Property address" aria-label="Property address" style={input} /> : null}
      </div>
      <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted, #52525b)', lineHeight: 1.5 }}>
        {kind === 'seller' ? 'Saved to People with this property, and a deal opened for it. ' : 'Saved to Buyers. '}
        Someone already in the CRM with this email or phone is used instead of a duplicate.
      </p>
      {err ? <div role="alert" style={{ fontSize: '14px', color: 'var(--tx-red, #b91c1c)' }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" disabled={busy || name.trim().length < 2} onClick={() => void save()} style={{ ...btn(true), opacity: busy || name.trim().length < 2 ? 0.55 : 1 }}>{busy ? 'Saving…' : `Add and continue`}</button>
        <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Pick who a new contract is for: everyone the home search finds (People,
 * Buyers, Vendors, the team), or add someone new. The loaded lists answer
 * first (they know each seller's houses); the database answers the rest, so a
 * buyer added a minute ago, or one past what this page loaded, is found too.
 */
function PartyPicker({ dir, onPick, hint, workspaceId }: { dir: Directory; onPick: (t: Target) => void; hint?: string; workspaceId: number | null }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; list: Contact[] } | null>(null);
  useEffect(() => {
    if (!workspaceId || q.trim().length < 2) return;
    let live = true;
    const t = window.setTimeout(() => { void searchContacts(workspaceId, q, 25).then((list) => { if (live) setFound({ q, list }); }); }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, workspaceId]);
  const [adding, setAdding] = useState<'seller' | 'buyer' | null>(null);
  // A seller on more than one open house: which house the contract is for.
  const [houseOf, setHouseOf] = useState<Seller | null>(null);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (s: string) => terms.every((t) => s.toLowerCase().includes(t));
  const sellers = terms.length ? dir.sellers.filter((s) => hit(`${s.name} ${s.addr} ${s.phone} ${s.email}`)).slice(0, 25) : dir.sellers.slice(0, 12);
  const buyers = terms.length ? dir.buyers.filter((b) => hit(`${b.name} ${b.company} ${b.phone} ${b.email}`)).slice(0, 15) : [];
  const shownIds = new Set([...sellers.map((x) => `seller:${x.id}`), ...buyers.map((x) => `buyer:${x.id}`)]);
  const extra = found && found.q === q && terms.length ? found.list.filter((c) => !shownIds.has(`${c.kind}:${c.id}`)) : [];
  const searching = terms.length > 0 && q.trim().length >= 2 && (!found || found.q !== q);
  const pickContact = (c: Contact) => {
    const title = `Contracts · ${c.company || c.name}`;
    if (c.kind === 'seller') {
      const s = dir.sellers.find((x) => x.id === c.id);
      if (s && (s.houses?.length ?? 0) > 1) { setHouseOf(s); return; }
      onPick({ sellerId: Number(c.id), dealId: s?.dealId ?? null, buyerId: null, title, seller: s ?? { id: Number(c.id), name: c.name, email: c.email ?? '', phone: c.phone ?? '', addr: c.sub ?? '', dealId: null } });
      return;
    }
    if (c.kind === 'buyer') {
      onPick({ sellerId: null, dealId: null, buyerId: Number(c.id), title, buyer: { id: Number(c.id), name: c.name, company: c.company ?? '', email: c.email ?? '', phone: c.phone ?? '' } });
      return;
    }
    // A vendor or teammate has no contracts link of their own: they fill the first recipient.
    onPick({ sellerId: null, dealId: null, buyerId: null, title, seller: { id: 0, name: c.name, email: c.email ?? '', phone: c.phone ?? '', addr: c.sub ?? '', dealId: null } });
  };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderBottom: `1px solid ${HAIR}`, background: 'var(--surface, #fff)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px' };
  if (houseOf) {
    // The house in view (or the best deal) first.
    const houses = [...(houseOf.houses ?? [])].sort((a, b) => Number(b.dealId === houseOf.dealId) - Number(a.dealId === houseOf.dealId));
    return (
      <div>
        <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--muted, #52525b)', lineHeight: 1.45 }}>{houseOf.name} has {houses.length} open houses. Which one is this contract for?</p>
        <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflow: 'hidden', background: 'var(--surface, #fff)' }}>
          {houses.map((h) => (
            <button key={h.dealId} type="button" className="dc2" style={row} onClick={() => onPick({ sellerId: houseOf.id, dealId: h.dealId, buyerId: null, title: `Contracts · ${houseOf.name} · ${h.addr}`, seller: { ...houseOf, addr: h.addr, dealId: h.dealId } })}>
              <span style={{ fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.addr}</span>
              <span style={{ color: MUTED, flex: 'none' }}>{h.stage}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setHouseOf(null)} style={{ ...btn(), marginTop: '12px' }}>Back</button>
      </div>
    );
  }
  return (
    <div>
      {hint ? <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--muted, #52525b)', lineHeight: 1.45 }}>{hint}</p> : null}
      <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, buyers, vendors, team by name, phone or email…" aria-label="Search who the contract is for" style={{ width: '100%', height: '38px', borderRadius: '9px', border: `1px solid ${LINE}`, padding: '0 12px', fontSize: '14px', background: 'var(--surface, #fff)', marginBottom: '12px' }} />
      <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflow: 'hidden', background: 'var(--surface, #fff)' }}>
        {sellers.map((s) => (
          <button key={'s' + s.id} type="button" className="dc2" style={row} onClick={() => ((s.houses?.length ?? 0) > 1 ? setHouseOf(s) : onPick({ sellerId: s.id, dealId: s.dealId, buyerId: null, title: `Contracts · ${s.name}`, seller: s }))}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: GREEN, background: 'var(--mint-dim, #e7f8f1)', borderRadius: '999px', padding: '2px 7px' }}>PERSON</span>
            <span style={{ fontWeight: 600, color: INK }}>{s.name}</span>
            <span style={{ color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.addr}</span>
          </button>
        ))}
        {buyers.map((b) => (
          <button key={'b' + b.id} type="button" className="dc2" style={row} onClick={() => onPick({ sellerId: null, dealId: null, buyerId: b.id, title: `Contracts · ${b.company || b.name}`, buyer: b })}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--tx-mint-deep, #08694c)', background: 'var(--c-action-soft, #e7f5ef)', borderRadius: '999px', padding: '2px 7px' }}>BUYER</span>
            <span style={{ fontWeight: 600, color: INK }}>{b.company || b.name}</span>
            <span style={{ color: MUTED }}>{b.company ? b.name : ''}</span>
          </button>
        ))}
        {extra.map((c) => (
          <button key={`${c.kind}-${c.id}`} type="button" className="dc2" style={row} onClick={() => pickContact(c)}>
            <KindBadge kind={c.kind} />
            <span style={{ fontWeight: 600, color: INK }}>{c.name}</span>
            <span style={{ color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.sub ?? ''}</span>
          </button>
        ))}
        {!sellers.length && !buyers.length && !extra.length ? <div style={{ padding: '14px', fontSize: '13px', color: MUTED }}>{searching ? 'Searching…' : `No one matches “${q}”.`}</div> : null}
      </div>
      {workspaceId ? (
        adding ? (
          <div style={{ marginTop: '12px' }}>
            <NewParty workspaceId={workspaceId} kind={adding} start={q.trim()} onDone={onPick} onCancel={() => setAdding(null)} />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button type="button" onClick={() => setAdding('seller')} style={btn()}>+ New seller</button>
            <button type="button" onClick={() => setAdding('buyer')} style={btn()}>+ New buyer</button>
          </div>
        )
      ) : null}
    </div>
  );
}

type HubTab = 'contracts' | 'summaries' | 'terms' | 'bulk' | 'forms' | 'reports';

/** The list of every contract. `embedded` drops the page chrome for the popup. */
export function ContractsHub({ V, embedded }: { V: ClozrView; embedded?: boolean }) {
  const ids = V.liveIds;
  const wsId = ids?.workspaceId ?? null;
  const [rows, setRows] = useState<ContractRow[] | null>(null);
  const [progress, setProgress] = useState<Map<number, Progress>>(new Map());
  // Contracts drafted from a dialer request (migration 270), marked in the list.
  const [requested, setRequested] = useState<Map<number, { requestedBy: string | null; status: string }>>(new Map());
  // A draft to open on arrival: Open draft on the TC's alert, or after Send to TC.
  const { pending } = useRequestStore();
  const pendingId = typeof pending === 'number' ? pending : null;
  // The clock the list is judged against, read when the rows load.
  const [now, setNow] = useState(0);
  const [rev, setRev] = useState(0);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [target, setTarget] = useState<Target | null>(null);
  const [picking, setPicking] = useState(false);
  /** Set when New contract was started from a template preview. Cleared for a blank new contract. */
  const [pendingTemplate, setPendingTemplate] = useState<{ id: number; name: string } | null>(null);
  // The list of contracts, or every term Claude read off their PDFs. The
  // page's tab is in its address (/app/contracts/terms) and pushes a history
  // entry; the popup keeps its own. Bulk send and Form links are for writers.
  const [ownTab, setOwnTab] = useState<HubTab>('contracts');
  const routedTab = (V.contractsTab ?? 'contracts') as HubTab;
  const tab: HubTab = embedded ? ownTab : !ids?.canWrite && (routedTab === 'bulk' || routedTab === 'forms') ? 'contracts' : routedTab;
  const setContractsTab = V.setContractsTab;
  const setTab = (t: HubTab) => (embedded ? setOwnTab(t) : setContractsTab(t === 'contracts' ? null : t));
  // The contract open over the page is in its address too (/app/contracts/k123), replacing the entry.
  const setContractId = V.setContractId;
  const routedContract = embedded ? null : V.contractId;
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [folderRev, setFolderRev] = useState(0);
  // 'all', 'none' (not filed) or a folder id; a folder includes the ones inside it.
  const [folderSel, setFolderSel] = useState<'all' | 'none' | number>('all');
  // Built once per open: the seller/buyer names every row and the picker need.
  const dir = useMemo(() => V.contractDirectory(), [V]);
  const sellerById = useMemo(() => new Map(dir.sellers.map((s) => [s.id, s])), [dir]);
  const buyerById = useMemo(() => new Map(dir.buyers.map((b) => [b.id, b])), [dir]);
  const sellerByDeal = useMemo(() => new Map(dir.sellers.filter((s) => s.dealId).map((s) => [s.dealId as number, s])), [dir]);

  useEffect(() => {
    if (!wsId) return;
    let live = true;
    void listAllContracts(wsId).then(async (r) => {
      if (!live) return;
      setRows(r);
      setNow(Date.now());
      // "2 of 3 signed": signers only; CC and viewers never hold a contract up.
      const open = r.filter((c) => c.provider === 'clozr').map((c) => c.id);
      const sigs = await listSigners(wsId, open);
      const m = new Map<number, Progress>();
      for (const s of sigs) {
        if (s.recipient_type === 'cc' || s.recipient_type === 'viewer' || s.recipient_type === 'approver' || s.status === 'delegated') continue;
        const p = m.get(s.contract_id) ?? { signed: 0, total: 0, viewed: 0 };
        p.total++; if (s.status === 'signed') p.signed++; if (s.viewed_at) p.viewed++;
        m.set(s.contract_id, p);
      }
      if (live) setProgress(m);
      const req = await requestedContracts(wsId);
      if (live) setRequested(req);
    });
    return () => { live = false; };
    // pendingId: read again, so a draft made seconds ago is in the list to open.
  }, [wsId, rev, pendingId]);
  useEffect(() => {
    if (!wsId) return;
    let live = true;
    void contractFolders(wsId).then((r) => { if (live && r.ok) setFolders(r.data.folders); });
    return () => { live = false; };
  }, [wsId, folderRev]);
  const tree = useMemo(() => folderTree(folders), [folders]);
  const inFolder = (c: ContractRow) => {
    const f = folderOfContract(c);
    if (folderSel === 'all') return true;
    if (folderSel === 'none') return f == null || !tree.some((x) => x.id === f);
    return f != null && folderAndBelow(folders, folderSel).has(f);
  };
  async function folderAction(op: 'create' | 'rename' | 'delete') {
    if (!wsId) return;
    const cur = typeof folderSel === 'number' ? tree.find((f) => f.id === folderSel) : undefined;
    if (op === 'create') {
      const name = window.prompt(cur ? `New folder inside ${cur.path}` : 'New folder name');
      if (!name?.trim()) return;
      const r = await folderOp(wsId, 'contracts', 'create', { name: name.trim(), parent_id: cur?.id ?? null });
      if (!r.ok) return V.showToast(r.message);
    } else if (cur && op === 'rename') {
      const name = window.prompt('Rename folder', cur.name);
      if (!name?.trim()) return;
      const r = await folderOp(wsId, 'contracts', 'rename', { id: cur.id, name: name.trim() });
      if (!r.ok) return V.showToast(r.message);
    } else if (cur && op === 'delete') {
      if (!window.confirm(`Delete the folder ${cur.path}? Its contracts move up a level; none are deleted.`)) return;
      const r = await folderOp(wsId, 'contracts', 'delete', { id: cur.id });
      if (!r.ok) return V.showToast(r.message);
      setFolderSel(cur.parent_id ?? 'all');
      setRev((x) => x + 1);
    }
    setFolderRev((x) => x + 1);
  }
  async function file(c: ContractRow, folderId: number | null) {
    if (!wsId) return;
    const r = await fileContract(wsId, c.id, folderId);
    if (!r.ok) return V.showToast(r.message);
    setRows((xs) => (xs ?? []).map((x) => (x.id === c.id ? ({ ...x, folder_id: folderId } as ContractRow) : x)));
    V.showToast(folderId ? `Filed in ${tree.find((f) => f.id === folderId)?.path ?? 'folder'}` : 'Taken out of its folder');
  }

  const partyOf = (c: ContractRow) => {
    const s = (c.seller_id ? sellerById.get(c.seller_id) : undefined) ?? (c.deal_id ? sellerByDeal.get(c.deal_id) : undefined);
    const b = c.buyer_id ? buyerById.get(c.buyer_id) : undefined;
    return { s, b, label: [s?.name, s?.addr, b ? (b.company || b.name) : null].filter(Boolean).join(' · ') || '—' };
  };
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((c) => {
    if (!FILTERS.find((f) => f.id === filter)!.test(c, now)) return false;
    if (!inFolder(c)) return false;
    if (!terms.length) return true;
    const hay = `${c.name ?? ''} ${c.template_name ?? ''} ${KIND_LABELS[c.kind as keyof typeof KIND_LABELS] ?? c.kind} ${partyOf(c).label}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const open = (c: ContractRow) => {
    const p = partyOf(c);
    setPendingTemplate(null);
    setTarget({
      sellerId: c.seller_id ?? p.s?.id ?? null, dealId: c.deal_id ?? p.s?.dealId ?? null, buyerId: c.buyer_id ?? null,
      title: `${c.name || KIND_LABELS[c.kind as keyof typeof KIND_LABELS] || 'Contract'}${p.label !== '—' ? ` · ${p.label}` : ''}`, seller: p.s, buyer: p.b,
      contractId: c.id,
    });
  };
  // Open the pending draft once it is in the list (during render, guarded, not in an effect).
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  // Cleared once handled, so the same draft can be opened this way again later.
  if (pendingId == null && openedFor != null) setOpenedFor(null);
  const pendingRow = pendingId != null && rows ? rows.find((c) => c.id === pendingId) ?? null : null;
  if (pendingRow && openedFor !== pendingRow.id) {
    setOpenedFor(pendingRow.id);
    if (filter !== 'all') setFilter('all');
    open(pendingRow);
  }
  useEffect(() => { if (pendingRow) setPendingContract(null); }, [pendingRow]);
  // The address follows the open contract; a link to one this workspace does not have says so.
  const openId = target?.contractId ?? null;
  useEffect(() => { if (!embedded && openId != null) setContractId('k' + openId); }, [embedded, openId, setContractId]);
  const showToast = V.showToast;
  useEffect(() => {
    if (!routedContract || !rows || rows.some((c) => 'k' + c.id === routedContract)) return;
    setContractId(null);
    setPendingContract(null);
    showToast('That contract isn’t in this workspace');
  }, [routedContract, rows, setContractId, showToast]);

  /** What a row says about a contract: its status word, signature progress and whether it is about to expire. */
  const rowOf = (c: ContractRow) => {
    const out = ['sent', 'viewed'].includes(c.status);
    const partly = out && (progress.get(c.id)?.signed ?? 0) > 0;
    const st = partly ? { ...statusLabel(c.status), text: 'Partially signed' } : statusLabel(c.status);
    const soon = out && !!c.expires_at && Date.parse(c.expires_at) - now < 3 * DAY;
    return { out, st, soon, p: partyOf(c), pr: progress.get(c.id) };
  };
  const kindLine = (c: ContractRow) => `${KIND_LABELS[c.kind as keyof typeof KIND_LABELS] ?? c.kind}${c.provider === 'pandadoc' ? ' · PandaDoc' : ''}${requested.has(c.id) ? ` · requested by ${V.requestTeam.find((m) => m.id === requested.get(c.id)?.requestedBy)?.name ?? 'a teammate'}` : ''}`;
  const signatures = (pr: Progress | undefined) => {
    if (!pr || !pr.total) return '—';
    const bar = Math.round((pr.signed / pr.total) * 100);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }} title={`${pr.viewed} of ${pr.total} opened it`}>
        <span style={{ width: '44px', height: '4px', borderRadius: '999px', background: HAIR, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${bar}%`, background: GREEN }} /></span>
        {pr.signed} of {pr.total} signed
      </span>
    );
  };
  const folderSelect = (c: ContractRow, height: string) => (
    <select value={folderOfContract(c) ?? ''} onChange={(e) => void file(c, e.target.value ? Number(e.target.value) : null)} aria-label="Move to folder" style={{ height, maxWidth: V.isMobile ? undefined : '170px', minWidth: 0, flex: V.isMobile ? 1 : undefined, borderRadius: '7px', border: `1px solid ${LINE}`, padding: '0 6px', fontSize: '12px', background: 'var(--surface, #fff)', fontFamily: 'inherit', color: INK }}>
      <option value="">No folder</option>
      {tree.map((f) => <option key={f.id} value={f.id}>{'\u00a0\u00a0'.repeat(f.depth)}{f.name}</option>)}
    </select>
  );
  const emptyText = rows ? (rows.length ? 'No contracts match.' : 'No contracts yet. Press + New contract to send one.') : 'Loading contracts…';

  const tabs = (
    <div role="tablist" aria-label="Contracts or extracted terms" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
      {([['contracts', 'Contracts'], ['summaries', 'Deal summaries'], ['terms', 'Extracted terms'], ...(ids?.canWrite ? [['bulk', 'Bulk send'], ['forms', 'Form links']] as const : []), ['reports', 'Reports']] as const).map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className="dc2" onClick={() => setTab(id)} style={{ ...chip(tab === id), borderRadius: '8px' }}>{text}</button>
      ))}
    </div>
  );
  // One summary per deal that has a contract, newest contract first.
  const summaryDeals = useMemo(() => {
    const seen = new Set<number>();
    const out: { dealId: number; label: string }[] = [];
    for (const c of rows ?? []) {
      const id = c.deal_id ?? (c.seller_id ? sellerById.get(c.seller_id)?.dealId : null) ?? null;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const s = sellerByDeal.get(id);
      out.push({ dealId: id, label: [s?.addr, s?.name].filter(Boolean).join(' · ') || c.name || `Deal ${id}` });
      if (out.length >= 40) break;
    }
    return out;
  }, [rows, sellerById, sellerByDeal]);
  const [demoMemory] = useState(() => demoDealMemory({ dealId: 0, address: '4873 Orchard Dr' }));
  const body = !wsId ? (
    <>
      <h2 style={{ margin: '0 0 8px', fontSize: '13.5px', fontWeight: 650, color: INK }}>Deal summaries</h2>
      <DealSummaryList workspaceId={null} deals={[{ dealId: 0, label: '4873 Orchard Dr · Linda Orton' }]} demo={demoMemory} />
      <DemoRequests V={V} />
      <div style={{ padding: '28px', textAlign: 'center', color: MUTED, fontSize: '13px' }}>Contracts live on a signed-in workspace. Sign in to see and send them.</div>
    </>
  ) : tab === 'summaries' ? (
    <>
      {tabs}
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: MUTED, maxWidth: '72ch', lineHeight: 1.5 }}>
        One Smart Summary per deal with a contract: what the PDFs, the deal sheet and the mail disagree on, and what is missing. Deals with conflicts come first.
      </p>
      {rows ? <DealSummaryList workspaceId={wsId} deals={summaryDeals} /> : <p role="status" style={{ fontSize: '12.5px', color: MUTED }}>Loading contracts…</p>}
    </>
  ) : tab === 'terms' ? (
    <>
      {tabs}
      <ExtractedTermsView workspaceId={wsId} contracts={rows ?? []} onOpen={open} />
    </>
  ) : tab === 'bulk' || tab === 'forms' || tab === 'reports' ? (
    <>
      {tabs}
      {tab === 'bulk' ? <BulkSendPanel workspaceId={wsId} onToast={V.showToast} /> : tab === 'forms' ? <FormLinksPanel workspaceId={wsId} onToast={V.showToast} /> : <DocsReports workspaceId={wsId} />}
    </>
  ) : (
    <>
      {tabs}
      {ids?.canWrite && wsId && !embedded ? <DocImport workspaceId={wsId} onToast={V.showToast} /> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {FILTERS.map((f) => {
          const n = (rows ?? []).filter((c) => f.test(c, now)).length;
          return <button key={f.id} type="button" className="dc2" onClick={() => setFilter(f.id)} style={chip(filter === f.id)}>{f.label} · {n}</button>;
        })}
        <span style={{ flex: 1 }} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contract, seller, address, buyer…" aria-label="Search contracts" style={{ height: '32px', width: 'min(300px, 100%)', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 10px', fontSize: '12.5px', background: 'var(--surface, #fff)' }} />
        {ids?.canWrite && wsId && embedded ? <DocImport compact workspaceId={wsId} onToast={V.showToast} /> : null}
        <button type="button" className="dc2" onClick={() => setTemplatesOpen(true)} title="Templates, their versions and folders, and reusable sections" style={btn()}>Templates</button>
        {ids?.canWrite ? <button type="button" className="dc3" onClick={() => { setPendingTemplate(null); setPicking(true); }} style={btn(true)}>+ New contract</button> : null}
      </div>
      {tree.length || ids?.canWrite ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px', fontSize: '12.5px' }}>
          <select value={String(folderSel)} onChange={(e) => setFolderSel(e.target.value === 'all' || e.target.value === 'none' ? e.target.value : Number(e.target.value))} aria-label="Folder" style={{ height: '30px', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 8px', fontSize: '12.5px', background: 'var(--surface, #fff)', fontFamily: 'inherit' }}>
            <option value="all">All folders</option>
            <option value="none">Not in a folder</option>
            {tree.map((f) => <option key={f.id} value={f.id}>{'\u00a0\u00a0'.repeat(f.depth)}{f.name}</option>)}
          </select>
          {ids?.canWrite ? <button type="button" onClick={() => void folderAction('create')} style={{ ...btn(), height: '30px' }}>+ Folder</button> : null}
          {ids?.canWrite && typeof folderSel === 'number' ? <button type="button" onClick={() => void folderAction('rename')} style={{ ...btn(), height: '30px' }}>Rename</button> : null}
          {ids?.canWrite && typeof folderSel === 'number' ? <button type="button" onClick={() => void folderAction('delete')} style={{ ...btn(), height: '30px', color: 'var(--tx-red, #b91c1c)' }}>Delete folder</button> : null}
        </div>
      ) : null}
      {V.isMobile ? (
        <div>
          {shown.map((c) => {
            const r = rowOf(c);
            return (
              <div key={c.id} role="button" tabIndex={0} onClick={() => open(c)} onKeyDown={V.cardKey} className="dc2" style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '13px', padding: '12px 13px', marginBottom: '8px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="t-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.template_name || 'Contract'}</span>
                  <span style={{ flex: 'none', fontSize: '11px', fontWeight: 700, color: r.st.color, background: r.st.bg, borderRadius: '999px', padding: '3px 9px' }}>{r.st.text}</span>
                </div>
                <div className="t-meta" style={{ marginTop: '2px' }}>{kindLine(c)}</div>
                {r.p.label !== '—' ? <div style={{ marginTop: '6px', fontSize: '13px', color: 'var(--ink-2, #3f3f46)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.p.label}</div> : null}
                <div className="t-meta" style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
                  {r.pr?.total ? signatures(r.pr) : null}
                  <span>{c.sent_at ? `Sent ${fmtDate(c.sent_at)}` : 'Not sent'}</span>
                  {r.out && c.expires_at ? <span style={r.soon ? { color: '#b45309', fontWeight: 650 } : undefined}>Expires {fmtDate(c.expires_at)}</span> : null}
                  {c.completed_at ? <span>Signed {fmtDate(c.completed_at)}</span> : null}
                  {tree.length && !ids?.canWrite ? <span>{tree.find((f) => f.id === folderOfContract(c))?.path ?? 'No folder'}</span> : null}
                </div>
                <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: '8px', marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${HAIR}` }}>
                  <button type="button" className="dc2" onClick={() => open(c)} style={{ ...btn(), height: '36px', flex: 1 }}>Open</button>
                  {tree.length && ids?.canWrite ? folderSelect(c, '36px') : null}
                </div>
              </div>
            );
          })}
          {!shown.length ? <p role="status" style={{ margin: 0, padding: '28px 0', textAlign: 'center', color: MUTED, fontSize: '13px' }}>{emptyText}</p> : null}
        </div>
      ) : (
      <div style={{ background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'auto', maxHeight: embedded ? '62vh' : undefined }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: '760px' }}>
          <thead>
            <tr><th style={th}>Contract</th><th style={th}>For</th><th style={th}>Status</th><th style={th}>Signatures</th><th style={th}>Sent</th><th style={th}>Expires</th><th style={th}>Signed</th>{tree.length ? <th style={th}>Folder</th> : null}</tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const { st, p, pr, out, soon } = rowOf(c);
              return (
                <tr key={c.id} className="dc2" onClick={() => open(c)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...td, color: INK }}>
                    <div style={{ fontWeight: 650 }}>{c.name || c.template_name || 'Contract'}</div>
                    <div style={{ fontSize: '11px', color: MUTED }}>{kindLine(c)}</div>
                  </td>
                  <td style={{ ...td, maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</td>
                  <td style={td}><span style={{ fontSize: '11px', fontWeight: 700, color: st.color, background: st.bg, borderRadius: '999px', padding: '3px 9px' }}>{st.text}</span></td>
                  <td style={td}>{signatures(pr)}</td>
                  <td style={td}>{fmtDate(c.sent_at)}</td>
                  <td style={{ ...td, color: soon ? '#b45309' : td.color, fontWeight: soon ? 650 : 400 }}>{out ? fmtDate(c.expires_at) : '—'}</td>
                  <td style={td}>{fmtDate(c.completed_at)}</td>
                  {tree.length ? (
                    <td style={td} onClick={(e) => e.stopPropagation()}>
                      {ids?.canWrite ? folderSelect(c, '28px') : (tree.find((f) => f.id === folderOfContract(c))?.path ?? '—')}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {!shown.length ? <tr><td colSpan={tree.length ? 8 : 7} style={{ ...td, height: '80px', textAlign: 'center', color: MUTED }}>{emptyText}</td></tr> : null}
          </tbody>
        </table>
      </div>
      )}
    </>
  );

  return (
    <>
      {embedded ? body : (
        <section data-screen-label="Contracts" style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--canvas, #fafafa)' }}>
          <ScreenHeader title="Contracts" meta={rows ? `${rows.length} in this workspace` : undefined} />
          <div style={{ padding: 'var(--gutter)' }}>{body}</div>
        </section>
      )}
      {picking ? (
        <CenteredDialog title={pendingTemplate ? `Use ${pendingTemplate.name}` : 'New contract · who is it for?'} onClose={() => { setPicking(false); setPendingTemplate(null); }} width={720} z={80}>
          <PartyPicker
            dir={dir}
            workspaceId={wsId}
            hint={pendingTemplate ? `Tie ${pendingTemplate.name} to a person or a buyer. Their name and contact fill the contract.` : undefined}
            onPick={(t) => { setPicking(false); setTarget({ ...t, contractId: null }); }}
          />
        </CenteredDialog>
      ) : null}
      {templatesOpen && wsId ? (
        <CenteredDialog title="Templates" onClose={() => setTemplatesOpen(false)} width={1320} z={80}>
          <TemplateLibrary
            workspaceId={wsId}
            onToast={V.showToast}
            onUse={ids?.canWrite ? (t) => { setTemplatesOpen(false); setPendingTemplate({ id: t.id, name: t.name }); setPicking(true); } : undefined}
          />
        </CenteredDialog>
      ) : null}
      {target ? (
        <ContractPopup
          V={V}
          target={target}
          startTemplateId={pendingTemplate?.id ?? null}
          newSend={!target.contractId && !pendingTemplate}
          onClose={() => { setTarget(null); setPendingTemplate(null); if (!embedded) setContractId(null); }}
          onChanged={() => setRev((r) => r + 1)}
        />
      ) : null}
    </>
  );
}

/** The Contracts list as a popup, opened from People, Dispo and Buyers. */
export function ContractsListPopup({ V }: { V: ClozrView }) {
  if (!V.contractsOpen) return null;
  return (
    <CenteredDialog title="Contracts" onClose={V.closeContracts}>
      <ContractsHub V={V} embedded />
    </CenteredDialog>
  );
}

/** The button People, Dispo and Buyers put in their header. */
export function ContractsButton({ V, pill }: { V: ClozrView; pill?: boolean }) {
  return (
    <button type="button" className="dc2" onClick={V.openContracts} title="Every contract, and send a new one" style={{ height: pill ? '34px' : '32px', padding: '0 11px', borderRadius: pill ? '999px' : '8px', border: '1px solid var(--c-btn-line, #e4e4e7)', background: 'var(--c-btn-bg, #fff)', color: INK, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: 'inherit' }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>
      Contracts
    </button>
  );
}
