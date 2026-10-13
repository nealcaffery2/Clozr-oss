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
import { saveRecipientToCrm } from '@/lib/contract-recipients';
import { loadDealForSeller } from '@/lib/deal-sheet';
import { supabase } from '@/lib/supabase';
import type { ClozrView } from '@/app/clozr/view';

const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const HAIR = '#f0f0f1';
const GREEN = '#0A8560';

type Directory = ReturnType<ClozrView['contractDirectory']>;
// A record's own Contracts card names one house, so the list of houses is optional.
type Seller = Omit<Directory['sellers'][number], 'houses'> & Partial<Pick<Directory['sellers'][number], 'houses'>>;
type Buyer = Directory['buyers'][number];
/** Who the popup's contracts card is about. */
type Target = { sellerId: number | null; dealId: number | null; buyerId: number | null; title: string; seller?: Seller; buyer?: Buyer };

const btn = (primary = false): React.CSSProperties => ({
  height: '32px', padding: '0 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : '#fff', color: primary ? '#fff' : INK, fontFamily: 'inherit',
});
const chip = (on: boolean): React.CSSProperties => ({
  height: '30px', padding: '0 11px', borderRadius: '999px', fontSize: '12px', fontWeight: on ? 650 : 500, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? GREEN : LINE}`, background: on ? '#E7F8F1' : '#fff', color: on ? GREEN : '#27272a', fontFamily: 'inherit',
});
const th: React.CSSProperties = { position: 'sticky', top: 0, background: 'var(--c-thead, #fafafa)', borderBottom: `1px solid ${LINE}`, padding: '0 12px', height: '36px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#71717a', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '0 12px', height: '46px', borderBottom: `1px solid ${HAIR}`, whiteSpace: 'nowrap', color: '#52525b', fontSize: '12.5px' };
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
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: width, maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: '14px', boxShadow: '0 24px 70px rgba(0,0,0,.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 18px', borderBottom: `1px solid ${LINE}` }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ width: '32px', height: '32px', borderRadius: '8px', border: `1px solid ${LINE}`, background: '#fff', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflow: 'auto', padding: '18px', background: '#fafafa', flex: 1 }}>{children}</div>
      </div>
    </div>,
    host,
  );
}

/** The full contracts card for one seller, deal or buyer, centered. */
export function ContractPopup({ V, target, onClose, onChanged, startTemplateId }: { V: ClozrView; target: Target; onClose: () => void; onChanged?: () => void; startTemplateId?: number | null }) {
  const ids = V.liveIds;
  // "New contract" lists the templates first; the pick reopens the card on that template, filled in.
  const [picking, setPicking] = useState(false);
  const [start, setStart] = useState<{ id: number | null; n: number }>({ id: startTemplateId ?? null, n: 0 });
  return (
    <CenteredDialog title={target.title} onClose={onClose} z={80}>
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
  const input: React.CSSProperties = { height: '36px', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 10px', fontSize: '14px', background: '#fff', width: '100%', boxSizing: 'border-box' };
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
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', background: '#fff', padding: '14px', display: 'grid', gap: '10px' }}>
      <div style={{ fontSize: '15px', fontWeight: 650, color: INK }}>New {kind === 'seller' ? 'seller' : 'buyer'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" aria-label="Full name" style={input} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" type="email" style={input} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" aria-label="Phone" type="tel" style={input} />
        {kind === 'seller' ? <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Property address" aria-label="Property address" style={input} /> : null}
      </div>
      <p style={{ margin: 0, fontSize: '14px', color: '#52525b', lineHeight: 1.5 }}>
        {kind === 'seller' ? 'Saved to People with this property, and a deal opened for it. ' : 'Saved to Buyers. '}
        Someone already in the CRM with this email or phone is used instead of a duplicate.
      </p>
      {err ? <div role="alert" style={{ fontSize: '14px', color: '#b91c1c' }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" disabled={busy || name.trim().length < 2} onClick={() => void save()} style={{ ...btn(true), opacity: busy || name.trim().length < 2 ? 0.55 : 1 }}>{busy ? 'Saving…' : `Add and continue`}</button>
        <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
      </div>
    </div>
  );
}

/** Pick who a new contract is for: search people (sellers) and buyers by name, address, phone or email, or add someone new. */
function PartyPicker({ dir, onPick, hint, workspaceId }: { dir: Directory; onPick: (t: Target) => void; hint?: string; workspaceId: number | null }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<'seller' | 'buyer' | null>(null);
  // A seller on more than one open house: which house the contract is for.
  const [houseOf, setHouseOf] = useState<Seller | null>(null);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (s: string) => terms.every((t) => s.toLowerCase().includes(t));
  const sellers = terms.length ? dir.sellers.filter((s) => hit(`${s.name} ${s.addr} ${s.phone} ${s.email}`)).slice(0, 25) : dir.sellers.slice(0, 12);
  const buyers = terms.length ? dir.buyers.filter((b) => hit(`${b.name} ${b.company} ${b.phone} ${b.email}`)).slice(0, 15) : [];
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderBottom: `1px solid ${HAIR}`, background: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px' };
  if (houseOf) {
    // The house in view (or the best deal) first.
    const houses = [...(houseOf.houses ?? [])].sort((a, b) => Number(b.dealId === houseOf.dealId) - Number(a.dealId === houseOf.dealId));
    return (
      <div>
        <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#52525b', lineHeight: 1.45 }}>{houseOf.name} has {houses.length} open houses. Which one is this contract for?</p>
        <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflow: 'hidden', background: '#fff' }}>
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
      {hint ? <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#52525b', lineHeight: 1.45 }}>{hint}</p> : null}
      <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person or buyer by name, address, phone or email…" aria-label="Search who the contract is for" style={{ width: '100%', height: '38px', borderRadius: '9px', border: `1px solid ${LINE}`, padding: '0 12px', fontSize: '14px', background: '#fff', marginBottom: '12px' }} />
      <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflow: 'hidden', background: '#fff' }}>
        {sellers.map((s) => (
          <button key={'s' + s.id} type="button" className="dc2" style={row} onClick={() => ((s.houses?.length ?? 0) > 1 ? setHouseOf(s) : onPick({ sellerId: s.id, dealId: s.dealId, buyerId: null, title: `Contracts · ${s.name}`, seller: s }))}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: GREEN, background: '#E7F8F1', borderRadius: '999px', padding: '2px 7px' }}>PERSON</span>
            <span style={{ fontWeight: 600, color: INK }}>{s.name}</span>
            <span style={{ color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.addr}</span>
          </button>
        ))}
        {buyers.map((b) => (
          <button key={'b' + b.id} type="button" className="dc2" style={row} onClick={() => onPick({ sellerId: null, dealId: null, buyerId: b.id, title: `Contracts · ${b.company || b.name}`, buyer: b })}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: '#08694C', background: '#E7F5EF', borderRadius: '999px', padding: '2px 7px' }}>BUYER</span>
            <span style={{ fontWeight: 600, color: INK }}>{b.company || b.name}</span>
            <span style={{ color: MUTED }}>{b.company ? b.name : ''}</span>
          </button>
        ))}
        {!sellers.length && !buyers.length ? <div style={{ padding: '14px', fontSize: '13px', color: MUTED }}>No one matches “{q}”.</div> : null}
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

/** The list of every contract. `embedded` drops the page chrome for the popup. */
export function ContractsHub({ V, embedded }: { V: ClozrView; embedded?: boolean }) {
  const ids = V.liveIds;
  const wsId = ids?.workspaceId ?? null;
  const [rows, setRows] = useState<ContractRow[] | null>(null);
  const [progress, setProgress] = useState<Map<number, Progress>>(new Map());
  // The clock the list is judged against, read when the rows load.
  const [now, setNow] = useState(0);
  const [rev, setRev] = useState(0);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [target, setTarget] = useState<Target | null>(null);
  const [picking, setPicking] = useState(false);
  /** Set when New contract was started from a template preview. Cleared for a blank new contract. */
  const [pendingTemplate, setPendingTemplate] = useState<{ id: number; name: string } | null>(null);
  // The list of contracts, or every term Claude read off their PDFs.
  const [tab, setTab] = useState<'contracts' | 'terms' | 'bulk' | 'forms' | 'reports'>('contracts');
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
    });
    return () => { live = false; };
  }, [wsId, rev]);
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
    });
  };

  const tabs = (
    <div role="tablist" aria-label="Contracts or extracted terms" style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
      {([['contracts', 'Contracts'], ['terms', 'Extracted terms'], ...(ids?.canWrite ? [['bulk', 'Bulk send'], ['forms', 'Form links']] as const : []), ['reports', 'Reports']] as const).map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className="dc2" onClick={() => setTab(id)} style={{ ...chip(tab === id), borderRadius: '8px' }}>{text}</button>
      ))}
    </div>
  );
  const body = !wsId ? (
    <div style={{ padding: '28px', textAlign: 'center', color: MUTED, fontSize: '13px' }}>Contracts live on a signed-in workspace. Sign in to see and send them.</div>
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
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contract, seller, address, buyer…" aria-label="Search contracts" style={{ height: '32px', width: 'min(300px, 100%)', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 10px', fontSize: '12.5px', background: '#fff' }} />
        {ids?.canWrite && wsId && embedded ? <DocImport compact workspaceId={wsId} onToast={V.showToast} /> : null}
        <button type="button" className="dc2" onClick={() => setTemplatesOpen(true)} title="Templates, their versions and folders, and reusable sections" style={btn()}>Templates</button>
        {ids?.canWrite ? <button type="button" className="dc3" onClick={() => { setPendingTemplate(null); setPicking(true); }} style={btn(true)}>+ New contract</button> : null}
      </div>
      {tree.length || ids?.canWrite ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px', fontSize: '12.5px' }}>
          <select value={String(folderSel)} onChange={(e) => setFolderSel(e.target.value === 'all' || e.target.value === 'none' ? e.target.value : Number(e.target.value))} aria-label="Folder" style={{ height: '30px', borderRadius: '8px', border: `1px solid ${LINE}`, padding: '0 8px', fontSize: '12.5px', background: '#fff', fontFamily: 'inherit' }}>
            <option value="all">All folders</option>
            <option value="none">Not in a folder</option>
            {tree.map((f) => <option key={f.id} value={f.id}>{'\u00a0\u00a0'.repeat(f.depth)}{f.name}</option>)}
          </select>
          {ids?.canWrite ? <button type="button" onClick={() => void folderAction('create')} style={{ ...btn(), height: '30px' }}>+ Folder</button> : null}
          {ids?.canWrite && typeof folderSel === 'number' ? <button type="button" onClick={() => void folderAction('rename')} style={{ ...btn(), height: '30px' }}>Rename</button> : null}
          {ids?.canWrite && typeof folderSel === 'number' ? <button type="button" onClick={() => void folderAction('delete')} style={{ ...btn(), height: '30px', color: '#b91c1c' }}>Delete folder</button> : null}
        </div>
      ) : null}
      <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', overflow: 'auto', maxHeight: embedded ? '62vh' : undefined }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: '760px' }}>
          <thead>
            <tr><th style={th}>Contract</th><th style={th}>For</th><th style={th}>Status</th><th style={th}>Signatures</th><th style={th}>Sent</th><th style={th}>Expires</th><th style={th}>Signed</th>{tree.length ? <th style={th}>Folder</th> : null}</tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const partly = ['sent', 'viewed'].includes(c.status) && (progress.get(c.id)?.signed ?? 0) > 0;
              const st = partly ? { ...statusLabel(c.status), text: 'Partially signed' } : statusLabel(c.status);
              const p = partyOf(c);
              return (
                <tr key={c.id} className="dc2" onClick={() => open(c)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...td, color: INK }}>
                    <div style={{ fontWeight: 650 }}>{c.name || c.template_name || 'Contract'}</div>
                    <div style={{ fontSize: '11px', color: MUTED }}>{KIND_LABELS[c.kind as keyof typeof KIND_LABELS] ?? c.kind}{c.provider === 'pandadoc' ? ' · PandaDoc' : ''}</div>
                  </td>
                  <td style={{ ...td, maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</td>
                  <td style={td}><span style={{ fontSize: '11px', fontWeight: 700, color: st.color, background: st.bg, borderRadius: '999px', padding: '3px 9px' }}>{st.text}</span></td>
                  <td style={td}>{(() => {
                    const pr = progress.get(c.id);
                    if (!pr || !pr.total) return '—';
                    const bar = Math.round((pr.signed / pr.total) * 100);
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }} title={`${pr.viewed} of ${pr.total} opened it`}>
                        <span style={{ width: '44px', height: '4px', borderRadius: '999px', background: HAIR, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${bar}%`, background: GREEN }} /></span>
                        {pr.signed} of {pr.total} signed
                      </span>
                    );
                  })()}</td>
                  <td style={td}>{fmtDate(c.sent_at)}</td>
                  <td style={{ ...td, color: ['sent', 'viewed'].includes(c.status) && c.expires_at && Date.parse(c.expires_at) - now < 3 * DAY ? '#b45309' : td.color, fontWeight: ['sent', 'viewed'].includes(c.status) && c.expires_at && Date.parse(c.expires_at) - now < 3 * DAY ? 650 : 400 }}>{['sent', 'viewed'].includes(c.status) ? fmtDate(c.expires_at) : '—'}</td>
                  <td style={td}>{fmtDate(c.completed_at)}</td>
                  {tree.length ? (
                    <td style={td} onClick={(e) => e.stopPropagation()}>
                      {ids?.canWrite ? (
                        <select value={folderOfContract(c) ?? ''} onChange={(e) => void file(c, e.target.value ? Number(e.target.value) : null)} aria-label="Move to folder" style={{ height: '28px', maxWidth: '170px', borderRadius: '7px', border: `1px solid ${LINE}`, padding: '0 6px', fontSize: '12px', background: '#fff', fontFamily: 'inherit' }}>
                          <option value="">—</option>
                          {tree.map((f) => <option key={f.id} value={f.id}>{'\u00a0\u00a0'.repeat(f.depth)}{f.name}</option>)}
                        </select>
                      ) : (tree.find((f) => f.id === folderOfContract(c))?.path ?? '—')}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {rows && !shown.length ? (
              <tr><td colSpan={tree.length ? 8 : 7} style={{ ...td, height: '80px', textAlign: 'center', color: MUTED }}>{rows.length ? 'No contracts match.' : 'No contracts yet. Press + New contract to send one.'}</td></tr>
            ) : null}
            {!rows ? <tr><td colSpan={tree.length ? 8 : 7} style={{ ...td, height: '80px', textAlign: 'center', color: MUTED }}>Loading contracts…</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <>
      {embedded ? body : (
        <section data-screen-label="Contracts" style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#fafafa' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', padding: '14px 20px', background: '#fff', borderBottom: `1px solid ${LINE}` }}>
            <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Contracts</h1>
            <span style={{ fontSize: '12px', color: MUTED }}>{rows ? `${rows.length} in this workspace` : ''}</span>
          </div>
          <div style={{ padding: '16px 20px' }}>{body}</div>
        </section>
      )}
      {picking ? (
        <CenteredDialog title={pendingTemplate ? `Use ${pendingTemplate.name}` : 'New contract · who is it for?'} onClose={() => { setPicking(false); setPendingTemplate(null); }} width={720} z={80}>
          <PartyPicker
            dir={dir}
            workspaceId={wsId}
            hint={pendingTemplate ? `Tie ${pendingTemplate.name} to a person or a buyer. Their name and contact fill the contract.` : undefined}
            onPick={(t) => { setPicking(false); setTarget(t); }}
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
      {target ? <ContractPopup V={V} target={target} startTemplateId={pendingTemplate?.id ?? null} onClose={() => { setTarget(null); setPendingTemplate(null); }} onChanged={() => setRev((r) => r + 1)} /> : null}
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
