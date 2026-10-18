// Deal team — everyone on a deal (deal_parties, migration 40), grouped by role.
//
// On a seller, the deal sheet and the TC file it lists the deal's team with
// call and email actions, and anyone on the team can add, edit or remove
// people inline. Reps, buyer and title sync to the deal's own columns in the
// database (migration 46), so Deals, Dispo and the Deal Sheet agree.
// On a buyer or vendor it lists the deals they are on, read-only, with a link
// back to the seller's record.
'use client';

import React, { useEffect, useState } from 'react';
import {
  ADDABLE_ROLES, CHAIN_POSITIONS, type ChainPosition, type DealPartyWithDeal, type PartyInput, PARTY_ROLE_LABEL, type TitleSuggestion,
  chainOf, loadDealParties, removeDealParty, resolveSellerDeal, saveDealParty, setDealPartyPoc, titleSuggestions,
} from '@/lib/deal-parties';
import { loadDealPickers } from '@/lib/deal-sheet';
import { sessionRole, useSession } from '@/lib/session';
import { reachClick } from '@/app/components/record/reach';
import { READ_ONLY_TITLE, useCanWrite } from '@/lib/read-only-context';
import { canSee, canSeeBuyers } from '@/lib/team';
import { buyerContactProblem } from '@/lib/buyer-contact';
import { patchRecord } from '@/lib/crm-write';
import { supabase } from '@/lib/supabase';
import { RepPicker, type RepRole } from '@/components/ds/RepPicker';
import { useConfirm } from '@/components/ds/Confirm';
import type { Rep } from '@/lib/clozr-types';

type Props = {
  dealId?: number | null; sellerId?: number | null; buyerId?: number | null; vendorId?: number | null;
  onCall?: (name: string, phone: string) => void;
  onOpenSeller?: (sellerId: number) => void;
  /** A deal row on a buyer or vendor: that deal's record, pinned to the deal. */
  onOpenDeal?: (sellerId: number, dealId: number) => void;
  /** The same row when the deal has no sellers-table seller (the seller is a vendor). */
  onOpenBareDeal?: (dealId: number) => void;
  /** Click a buyer, title rep or other vendor on the team to open where their contact lives. */
  onOpenBuyer?: (buyerId: number) => void;
  onOpenVendor?: (vendor: { id: number; name: string; role: string }) => void;
  /** After the team changes, with the party role (or rep column) that changed: the deal's rep/buyer/title columns may have changed with it. */
  onChanged?: (role: string) => void;
  /** No card chrome — for the record screens' narrow side columns. */
  bare?: boolean;
};

type Pickers = Awaited<ReturnType<typeof loadDealPickers>>;

/** The deal's own rep columns: the one place each is picked (the deal sheet and TC show them). */
/**
 * Every member is offered in every seat: Acme Homes' members and partnerships
 * seats work deals too, and the sheet's old pickers offered them.
 */
const REP_SEATS: { col: RepCol; label: string; roles: RepRole[] | undefined }[] = [
  { col: 'owner_id', label: 'Acquisitions', roles: undefined },
  { col: 'lead_manager_id', label: 'Lead manager', roles: undefined },
  { col: 'dispo_rep_id', label: 'Dispositions', roles: undefined },
  { col: 'dispo_rep2_id', label: 'Second dispositions', roles: undefined },
  { col: 'tc_rep_id', label: 'Transaction coordinator', roles: undefined },
];
const REP_ROLES = new Set<string>(['acquisitions', 'dispositions', 'tc']);
type RepCol = 'owner_id' | 'lead_manager_id' | 'dispo_rep_id' | 'dispo_rep2_id' | 'tc_rep_id';
type DealReps = Partial<Record<RepCol, string | null>>;

/** The deal's rep ids. Before migration 239 there is no lead_manager_id, so that read falls back without it. */
async function loadDealReps(dealId: number): Promise<DealReps | null> {
  if (!supabase) return null;
  const all = await supabase.from('deals').select('owner_id, dispo_rep_id, dispo_rep2_id, tc_rep_id, lead_manager_id' as 'owner_id').eq('id', dealId).maybeSingle();
  if (!all.error) return (all.data as DealReps | null) ?? null;
  const some = await supabase.from('deals').select('owner_id, dispo_rep_id, dispo_rep2_id, tc_rep_id').eq('id', dealId).maybeSingle();
  return (some.data as DealReps | null) ?? null;
}

/** The roster as RepPicker's team map. */
function rosterTeam(team: Pickers['team']): Record<string, Rep> {
  const out: Record<string, Rep> = {};
  for (const u of team) {
    const initials = u.label.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
    out[u.id] = { id: u.id, name: u.label, initials, role: '', dept: u.role === 'tc' ? 'TC' : '', memberRole: u.role };
  }
  return out;
}
type Form = {
  id?: number; role: PartyInput['role']; who: string; name: string; company: string; email: string; phone: string;
  /** Daisy chain (migration 186): OOR, W1–W3, or '' when not in one; and the TC's point of contact. */
  position: ChainPosition | ''; poc: boolean;
  /** What the row had, so an edit clears a position or star it no longer has. */
  had?: { position: boolean; poc: boolean };
};

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const cap: React.CSSProperties = { fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 500 };
const act: React.CSSProperties = { fontSize: '11.5px', color: 'var(--tx-mint, #0a8560)', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 500, textDecoration: 'none' };
const input: React.CSSProperties = { width: '100%', height: '30px', padding: '0 8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '7px', fontSize: '12.5px', outline: 0, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', minWidth: 0 };
const btn: React.CSSProperties = { height: '28px', padding: '0 12px', borderRadius: '7px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', cursor: 'pointer', color: 'var(--ink, #18181b)' };

/** Vendor service types that fit a team role, so picking a title company is not a scroll through every wholesaler. */
const VENDOR_KIND_FOR_ROLE: Partial<Record<PartyInput['role'], RegExp>> = {
  title: /title|attorney/i, photographer: /photo|notary/i, wholesaler: /wholesal/i, lender: /lend/i, attorney: /attorney|law/i,
  listing_agent: /realtor|agent/i, buyers_agent: /realtor|agent/i, contractor: /contract/i,
};

const blank = (role: PartyInput['role'] = 'other'): Form => ({ role, who: '', name: '', company: '', email: '', phone: '', position: '', poc: false });

const chip: React.CSSProperties = { display: 'inline-block', marginTop: '3px', padding: '0 6px', borderRadius: '999px', background: 'var(--c-genius-soft, #f0faf5)', color: 'var(--tx-mint-deep, #08694c)', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', lineHeight: '17px' };
const star = (on: boolean): React.CSSProperties => ({ background: 'none', border: 0, padding: '0 4px 0 0', fontSize: '14px', lineHeight: 1, color: on ? '#f59e0b' : 'var(--line, #d4d4d8)', verticalAlign: '-1px' });

export function DealTeam({ dealId, sellerId, buyerId, vendorId, onCall, onOpenSeller, onOpenDeal, onOpenBareDeal, onOpenBuyer, onOpenVendor, onChanged, bare }: Props) {
  const session = useSession();
  const workspaceId = session.workspace?.id ?? null;
  // A View-as preview reads the team but cannot change it (lib/read-only.ts).
  const canWrite = useCanWrite();
  const role = sessionRole(session);
  const seeBuyers = canSeeBuyers(role);
  // A name links only to a screen this role can open (TC and Notary have no
  // People or buyer record); otherwise it is plain text, calls and email kept.
  const openSeller = canSee(role, 'person') ? onOpenSeller : undefined;
  const openBuyer = canSee(role, 'buyer') ? onOpenBuyer : undefined;
  const openVendor = canSee(role, 'people') ? onOpenVendor : undefined;
  const onDeals = !!(buyerId || vendorId);
  const key = `${dealId}:${sellerId}:${buyerId}:${vendorId}`;
  const [state, setState] = useState<{ key: string; dealId: number | null; rows: DealPartyWithDeal[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [pickers, setPickers] = useState<Pickers | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [titleSug, setTitleSug] = useState<{ key: string; state: string | null; list: TitleSuggestion[]; decide: string | null } | null>(null);
  const [reps, setReps] = useState<{ dealId: number; v: DealReps } | null>(null);
  const { confirm } = useConfirm();

  useEffect(() => {
    // No workspace (the /demo sample): nothing to read, and no failed requests.
    if (!workspaceId || (!dealId && !sellerId && !buyerId && !vendorId)) return;
    let live = true;
    void (async () => {
      if (buyerId || vendorId) {
        const rows = await loadDealParties({ buyerId, vendorId });
        if (live) setState({ key, dealId: null, rows });
        return;
      }
      const id = dealId ?? (await resolveSellerDeal(sellerId!));
      const rows = id ? await loadDealParties({ dealId: id }) : [];
      if (live) setState({ key, dealId: id, rows });
      if (id) {
        const [r, p] = await Promise.all([loadDealReps(id), workspaceId && !pickers ? loadDealPickers(workspaceId) : Promise.resolve(null)]);
        if (live && r) setReps({ dealId: id, v: r });
        if (live && p) setPickers(p);
      }
      // A live deal with no title company says so, with who could take it.
      const sug = id && !rows.some((r) => r.role === 'title') ? await titleSuggestions(id) : null;
      if (live) setTitleSug(sug ? { key: `${key}:${nonce}`, ...sug } : null);
    })();
    return () => { live = false; };
  }, [key, nonce, dealId, sellerId, buyerId, vendorId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- pickers load once

  const cur = state?.key === key ? state : null;
  const rows = (cur?.rows ?? []).filter((r) => seeBuyers || (r.role !== 'buyer' && !r.buyer_id));
  if (onDeals && !rows.length) return null;

  const teamDeal = cur?.dealId ?? null;
  const canEdit = !!teamDeal && !!workspaceId && canWrite;
  // Our own reps are the seats above (one picker each), so the add form offers everyone else.
  const addableRoles = ADDABLE_ROLES.filter((r) => !REP_ROLES.has(r) && (seeBuyers || r !== 'buyer'));

  function open(f: Form) {
    setErr(null);
    setForm(f);
    if (!pickers && workspaceId) void loadDealPickers(workspaceId).then(setPickers);
  }
  function edit(r: DealPartyWithDeal) {
    const who = r.user_id ? `u:${r.user_id}` : r.vendor_id ? `v:${r.vendor_id}` : r.buyer_id ? `b:${r.buyer_id}` : '';
    open({
      id: r.id, role: r.role, who, name: r.name ?? '', company: r.company ?? '', email: r.email ?? '', phone: r.phone ?? '',
      position: r.chain_position ?? '', poc: !!r.is_poc, had: { position: !!r.chain_position, poc: !!r.is_poc },
    });
  }
  // Picking someone fills their details in; the fields stay editable.
  function pick(who: string) {
    if (!form) return;
    const [t, id] = [who.slice(0, 1), who.slice(2)];
    const u = t === 'u' ? pickers?.team.find((x) => x.id === id) : null;
    const v = t === 'v' ? pickers?.vendors.find((x) => String(x.id) === id) : null;
    const b = t === 'b' ? pickers?.buyers.find((x) => String(x.id) === id) : null;
    setForm({
      ...form, who,
      name: u?.label ?? v?.contact ?? b?.name ?? form.name,
      company: v?.label ?? b?.company ?? (u ? '' : form.company),
      email: u?.email ?? v?.email ?? b?.email ?? form.email,
      phone: v?.phone ?? b?.phone ?? form.phone,
    });
  }
  // New buyer rows typed in, not picked from Buyers. Edits of older rows keep the old rule.
  const typedBuyer = !!form && form.role === 'buyer' && !form.id && !form.who;
  async function save() {
    if (!form || !teamDeal || !workspaceId) return;
    const t = form.who.slice(0, 1), id = form.who.slice(2);
    const clean = (s: string) => s.trim() || null;
    const p: PartyInput = {
      role: form.role,
      user_id: t === 'u' ? id : null, vendor_id: t === 'v' ? Number(id) : null, buyer_id: t === 'b' ? Number(id) : null,
      name: clean(form.name), company: clean(form.company), email: clean(form.email), phone: clean(form.phone),
      // Only sent when set (or cleared on an edit), so a row with neither saves the way it always has.
      ...(form.position || form.had?.position ? { chain_position: form.position || null } : {}),
      ...(form.poc || form.had?.poc ? { is_poc: form.poc } : {}),
    };
    if (!p.user_id && !p.vendor_id && !p.buyer_id && !p.name && !p.company) return setErr('Pick someone or type a name.');
    // A buyer typed in by hand needs a phone and an email, same as Quick Add.
    if (typedBuyer) { const c = buyerContactProblem(p); if (c) return setErr(c); }
    setBusy(true);
    const e = await saveDealParty(workspaceId, teamDeal, p, form.id);
    setBusy(false);
    if (e) return setErr(e);
    setForm(null);
    setNonce((n) => n + 1);
    // An edit that moved a buyer (or seller) to another role still changed that one.
    const was = form.id ? cur?.rows.find((r) => r.id === form.id)?.role : undefined;
    onChanged?.(was === 'buyer' || was === 'seller' ? was : p.role);
  }
  // A rep seat saves to the deal's own column; the database names them and syncs the team rows (migrations 46, 239).
  async function saveRep(col: RepCol, userId: string | null) {
    if (!teamDeal) return;
    const before = reps?.dealId === teamDeal ? reps.v : {};
    setReps({ dealId: teamDeal, v: { ...before, [col]: userId } });
    setBusy(true);
    const r = await patchRecord('deals', teamDeal, { [col]: userId });
    setBusy(false);
    if (!r.ok) { setReps({ dealId: teamDeal, v: before }); return setErr(r.message); }
    setErr(null);
    setNonce((n) => n + 1);
    onChanged?.(col);
  }
  async function addTitle(t: TitleSuggestion) {
    if (!teamDeal || !workspaceId) return;
    setBusy(true);
    const e = await saveDealParty(workspaceId, teamDeal, { role: 'title', user_id: null, buyer_id: null, vendor_id: t.vendor_id, name: t.name, company: t.company, email: t.email, phone: t.phone });
    setBusy(false);
    if (e) return setErr(e);
    setNonce((n) => n + 1);
    onChanged?.('title');
  }
  async function togglePoc(r: DealPartyWithDeal) {
    const e = await setDealPartyPoc(r.id, !r.is_poc);
    if (e) return setErr(e);
    setNonce((n) => n + 1);
  }
  async function remove(r: DealPartyWithDeal) {
    const ok = await confirm({ title: `Remove ${r.name || r.company || 'this person'} from the deal team?`, body: 'Their contact stays; they come off this deal.', confirmLabel: 'Remove', tone: 'danger' });
    if (!ok) return;
    const e = await removeDealParty(r.id);
    if (e) return setErr(e);
    setNonce((n) => n + 1);
    onChanged?.(r.role);
  }

  const formEl = form ? (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '6px', padding: '10px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>
      <select aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Form['role'] })} style={input}>
        {(addableRoles.includes(form.role) ? addableRoles : [form.role, ...addableRoles]).map((r) => <option key={r} value={r}>{PARTY_ROLE_LABEL[r] ?? r}</option>)}
      </select>
      <select aria-label="Who" value={form.who} onChange={(e) => pick(e.target.value)} style={input}>
        <option value="">{pickers ? 'Someone outside (type below)' : 'Loading…'}</option>
        {pickers?.team.length ? <optgroup label="Our team">{pickers.team.map((u) => <option key={u.id} value={`u:${u.id}`}>{u.label}</option>)}</optgroup> : null}
        {(() => {
          // The role narrows the vendor list: Title shows title companies, Photographer shows photographers/notaries.
          const want = VENDOR_KIND_FOR_ROLE[form.role];
          const vs = (pickers?.vendors ?? []).filter((v) => !want || want.test(v.kind ?? '') || form.who === `v:${v.id}`);
          return vs.length ? <optgroup label={want ? PARTY_ROLE_LABEL[form.role] + ' vendors' : 'Vendors'}>{vs.map((v) => <option key={v.id} value={`v:${v.id}`}>{v.label}{v.contact ? ` · ${v.contact}` : ''}{v.state ? ` (${v.state})` : ''}</option>)}</optgroup> : null;
        })()}
        {seeBuyers && pickers?.buyers.length ? <optgroup label="Buyers">{pickers.buyers.map((b) => <option key={b.id} value={`b:${b.id}`}>{b.label}</option>)}</optgroup> : null}
      </select>
      <input aria-label="Name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input} />
      <input aria-label="Company" placeholder="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} style={input} />
      <input aria-label="Email" type="email" placeholder={typedBuyer ? 'Email *' : 'Email'} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={input} />
      <input aria-label="Phone" type="tel" placeholder={typedBuyer ? 'Phone *' : 'Phone'} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={input} />
      <select aria-label="Chain position" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value as Form['position'] })} style={input}>
        <option value="">Chain position (none)</option>
        {CHAIN_POSITIONS.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}
      </select>
      <button type="button" aria-pressed={form.poc} onClick={() => setForm({ ...form, poc: !form.poc })}
        style={{ ...input, cursor: 'pointer', textAlign: 'left', color: form.poc ? 'var(--tx-amber-deep, #92400e)' : 'var(--meta, #71717a)', background: form.poc ? 'var(--tint-amber, #fffbeb)' : 'var(--surface, #fff)', borderColor: form.poc ? '#fcd34d' : 'var(--divider, #e4e4e7)' }}>
        <span style={star(form.poc)}>{form.poc ? '★' : '☆'}</span>{form.poc ? 'Point of contact' : 'Mark as point of contact'}
      </button>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button style={{ ...btn, background: '#0A8560', borderColor: '#0A8560', color: '#fff' }} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : form.id ? 'Save' : 'Add'}</button>
        <button style={btn} onClick={() => { setForm(null); setErr(null); }}>Cancel</button>
      </div>
    </div>
  ) : null;

  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <h2 style={{ margin: 0, fontSize: '13.5px', fontWeight: 650, color: 'var(--ink, #18181b)', flex: 1 }}>{onDeals ? 'On deals' : 'Deal team'}</h2>
        {!onDeals && !form ? <button style={{ ...act, opacity: canEdit ? 1 : 0.4, cursor: canEdit ? 'pointer' : 'default' }} disabled={!canEdit} title={canWrite ? undefined : READ_ONLY_TITLE} onClick={() => open(blank())}>+ Add</button> : null}
      </div>
      {!onDeals && cur && !teamDeal ? <div style={{ fontSize: '12px', color: 'var(--subtle, #a1a1aa)', marginTop: '6px' }}>No deal yet.</div> : null}
      {err ? <div role="alert" style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginTop: '6px' }}>{err}</div> : null}
      {!onDeals && teamDeal && pickers ? (
        <div data-testid="deal-reps" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 10px', padding: '10px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>
          {REP_SEATS.map((seat) => (
            <RepPicker key={seat.col} label={seat.label} team={rosterTeam(pickers.team)} roles={seat.roles} disabled={busy}
              value={reps?.dealId === teamDeal ? reps.v[seat.col] ?? null : null}
              readOnlyReason={canEdit ? null : canWrite ? 'Open the deal to change its team' : READ_ONLY_TITLE}
              onChange={(id) => void saveRep(seat.col, id)} />
          ))}
        </div>
      ) : null}
      {form && !form.id ? formEl : null}
      {!onDeals && chainOf(rows).length ? (
        <div data-testid="deal-chain" style={{ margin: '8px 0 2px', padding: '7px 10px', borderRadius: '9px', background: 'var(--c-genius-soft, #f0faf5)', border: '1px solid var(--c-action-line, #a7dcc5)', fontSize: '12px', color: 'var(--tx-mint-deep, #08694c)', lineHeight: 1.6 }}>
          <span style={{ ...cap, color: 'var(--tx-mint-deep, #08694c)', marginRight: '6px' }}>Chain</span>
          {chainOf(rows).map((r, i) => (
            <React.Fragment key={r.id}>
              {i ? <span style={{ color: 'var(--c-action-line, #a7dcc5)', margin: '0 5px' }}>→</span> : null}
              <b>{r.chain_position}</b> {r.is_poc ? <span style={{ color: '#f59e0b' }} title="Point of contact">★</span> : null}{r.name || r.company || '—'}
            </React.Fragment>
          ))}
        </div>
      ) : null}
      {!onDeals && canEdit && !form && titleSug?.key === `${key}:${nonce}` ? (
        <div style={{ margin: '8px 0 2px', padding: '9px 10px', borderRadius: '9px', background: 'var(--tint-amber, #fffbeb)', border: '1px solid var(--tint-amber-2, #fde68a)' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--tx-amber-deep, #92400e)' }}>
            No title company on this deal{titleSug.state ? ` · ${titleSug.state}` : ''}
          </div>
          {titleSug.decide ? <div data-testid="title-decide" style={{ fontSize: '12px', color: 'var(--tx-amber-deep, #92400e)', marginTop: '4px' }}>{titleSug.decide}</div> : null}
          {titleSug.list.map((t) => (
            <div key={t.vendor_id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '12px' }}>
              <span style={{ minWidth: 0, flex: 1 }}>
                <b style={{ color: 'var(--ink, #18181b)' }}>{t.company}</b>
                {t.name ? <span style={{ color: 'var(--muted, #52525b)' }}> · {t.name}</span> : null}
                <span style={{ display: 'block', fontSize: '11px', color: '#a16207' }}>{t.main ? '★ ' : ''}{t.why}{t.phone ? ` · ${t.phone}` : ''}</span>
              </span>
              <button style={{ ...btn, height: '24px', padding: '0 9px', fontSize: '11.5px' }} disabled={busy} onClick={() => void addTitle(t)}>Add</button>
            </div>
          ))}
          <button style={{ ...act, marginTop: '6px', fontSize: '11.5px' }} onClick={() => open(blank('title'))}>
            {titleSug.list.length ? 'Someone else…' : 'Add the title company…'}
          </button>
        </div>
      ) : null}
      {onDeals ? rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px' }}>
          <span style={{ color: 'var(--meta, #71717a)', flex: 'none' }}>{PARTY_ROLE_LABEL[r.role] ?? r.role}</span>
          {r.deal_seller_id && openSeller
            ? <button style={{ ...act, flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => (onOpenDeal ? onOpenDeal(r.deal_seller_id!, r.deal_id) : openSeller(r.deal_seller_id!))}>{r.deal_address ?? `Deal ${r.deal_id}`} →</button>
            : onOpenBareDeal
              ? <button style={{ ...act, flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => onOpenBareDeal(r.deal_id)}>{r.deal_address ?? `Deal ${r.deal_id}`} →</button>
              : <span style={{ fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.deal_address ?? `Deal ${r.deal_id}`}</span>}
        </div>
      )) : rows.map((r) => form?.id === r.id ? <React.Fragment key={r.id}>{formEl}</React.Fragment> : (
        <div key={r.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 100px) 1fr', gap: '10px', alignItems: 'start', padding: '7px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px' }}>
          <span style={{ color: 'var(--meta, #71717a)' }}>
            {PARTY_ROLE_LABEL[r.role] ?? r.role}
            {r.chain_position ? <span style={{ display: 'block' }}><span style={chip} title={CHAIN_POSITIONS.find((c) => c.code === r.chain_position)?.label}>{r.chain_position}</span></span> : null}
          </span>
          <span style={{ minWidth: 0 }}>
            {canEdit
              ? <button type="button" aria-pressed={!!r.is_poc} title={r.is_poc ? 'Point of contact · tap to unstar' : 'Mark as point of contact'} onClick={() => void togglePoc(r)} style={{ ...star(!!r.is_poc), cursor: 'pointer' }}>{r.is_poc ? '★' : '☆'}</button>
              : r.is_poc ? <span style={star(true)} title="Point of contact">★</span> : null}
            {r.seller_id && openSeller && r.seller_id !== sellerId
              ? <button style={{ ...act, color: 'var(--ink, #18181b)', fontWeight: 600, textDecoration: 'underline', textDecorationColor: 'var(--line, #d4d4d8)', textUnderlineOffset: '2px' }} title="Open their record" onClick={() => openSeller(r.seller_id!)}>{r.name}</button>
              : r.buyer_id && openBuyer && r.buyer_id !== buyerId
                ? <button style={{ ...act, color: 'var(--ink, #18181b)', fontWeight: 600, textDecoration: 'underline', textDecorationColor: 'var(--line, #d4d4d8)', textUnderlineOffset: '2px' }} title="Open the buyer record" onClick={() => openBuyer(r.buyer_id!)}>{r.name || r.company || 'Buyer'}</button>
                : r.vendor_id && openVendor && r.vendor_id !== vendorId
                  ? <button style={{ ...act, color: 'var(--ink, #18181b)', fontWeight: 600, textDecoration: 'underline', textDecorationColor: 'var(--line, #d4d4d8)', textUnderlineOffset: '2px' }} title="Open their contact" onClick={() => openVendor({ id: r.vendor_id!, name: r.name || r.company || '', role: r.role })}>{r.name || r.company || '—'}</button>
                  : <span style={{ fontWeight: 600 }}>{r.name || r.company || '—'}</span>}
            {r.company && r.company !== r.name ? <span style={{ color: 'var(--meta, #71717a)' }}> · {r.company}</span> : null}
            {r.phone || r.email ? <span style={{ display: 'block', color: 'var(--meta, #71717a)', fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[r.phone, r.email].filter(Boolean).join(' · ')}</span> : null}
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '2px' }}>
              {r.phone ? (onCall ? <button style={act} onClick={() => onCall(r.name || r.company || r.phone!, r.phone!)}>Call</button> : <a style={act} href={`tel:${r.phone}`}>Call</a>) : null}
              {r.phone ? <a style={act} href={`sms:${r.phone}`} onClick={(e) => reachClick(e, 'text', { name: r.name || r.company || '', phone: r.phone, email: r.email })}>Text</a> : null}
              {r.email ? <a style={act} href={`mailto:${r.email}`} onClick={(e) => reachClick(e, 'email', { name: r.name || r.company || '', phone: r.phone, email: r.email })}>Email</a> : null}
              {canEdit ? <button style={{ ...act, color: 'var(--meta, #71717a)' }} onClick={() => edit(r)}>Edit</button> : null}
              {canEdit ? <button style={{ ...act, color: 'var(--meta, #71717a)' }} onClick={() => void remove(r)}>Remove</button> : null}
            </span>
          </span>
        </div>
      ))}
    </>
  );
  return bare ? <div style={{ marginTop: '14px' }}>{body}</div> : <div style={card}>{body}</div>;
}
