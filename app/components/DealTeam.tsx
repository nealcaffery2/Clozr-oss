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
  type SeatVendor, chainOf, favoriteFunders, FAVORITE_FUNDERS, loadDealParties, removeDealParty, resolveSellerDeal, saveDealParty, searchSeatVendors,
  roleForContact, setDealPartyPoc, titleSuggestions,
} from '@/lib/deal-parties';
import { type Contact, KIND_LABEL } from '@/lib/contact-search';
import { RecipientPicker } from '@/components/RecipientPicker';
import type { SeatRole } from '@/lib/deal-types';
import { loadDealPickers } from '@/lib/deal-sheet';
import { sessionRole, useSession } from '@/lib/session';
import { reachClick } from '@/app/components/record/reach';
import { READ_ONLY_TITLE, useCanWrite } from '@/lib/read-only-context';
import { canSee, canSeeBuyers } from '@/lib/team';
import { buyerContactProblem } from '@/lib/buyer-contact';
import { createVendor, patchRecord } from '@/lib/crm-write';
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
  /** Seats this deal asks to have filled (lib/deal-types teamSeatsFor): novation agents and lender, second title, funder. */
  seats?: SeatRole[];
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

/** A form's `who` (u:, s:, b:, v: and the id) as the contact kind its link badge names. */
const WHO_KIND: Record<string, Contact['kind']> = { u: 'team', s: 'seller', b: 'buyer', v: 'vendor' };

const blank = (role: PartyInput['role'] = 'other'): Form => ({ role, who: '', name: '', company: '', email: '', phone: '', position: '', poc: false });

const chip: React.CSSProperties = { display: 'inline-block', marginTop: '3px', padding: '0 6px', borderRadius: '999px', background: 'var(--c-genius-soft, #f0faf5)', color: 'var(--tx-mint-deep, #08694c)', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.04em', lineHeight: '17px' };
const star = (on: boolean): React.CSSProperties => ({ background: 'none', border: 0, padding: '0 4px 0 0', fontSize: '14px', lineHeight: 1, color: on ? 'var(--tx-amber, #b45309)' : 'var(--line, #d4d4d8)', verticalAlign: '-1px' });

export function DealTeam({ dealId, sellerId, buyerId, vendorId, onCall, onOpenSeller, onOpenDeal, onOpenBareDeal, onOpenBuyer, onOpenVendor, onChanged, bare, seats }: Props) {
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
  const allRows = (cur?.rows ?? []).filter((r) => seeBuyers || (r.role !== 'buyer' && !r.buyer_id));
  if (onDeals && !allRows.length) return null;
  // The first row in each seat's role shows in that seat; anyone else in the role stays in the list.
  const seated = new Map((onDeals ? [] : seats ?? []).map((role) => [role, allRows.find((r) => r.role === role) ?? null]));
  const seatedIds = new Set([...seated.values()].flatMap((r) => (r ? [r.id] : [])));
  const rows = allRows.filter((r) => !seatedIds.has(r.id));

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
    const who = r.user_id ? `u:${r.user_id}` : r.vendor_id ? `v:${r.vendor_id}` : r.buyer_id ? `b:${r.buyer_id}` : r.seller_id ? `s:${r.seller_id}` : '';
    open({
      id: r.id, role: r.role, who, name: r.name ?? '', company: r.company ?? '', email: r.email ?? '', phone: r.phone ?? '',
      position: r.chain_position ?? '', poc: !!r.is_poc, had: { position: !!r.chain_position, poc: !!r.is_poc },
    });
  }
  // Picking someone from contacts fills their details and their role from what they are (lib/deal-parties
  // roleForContact): a seller is the Seller, a title company Title. Every field, the role too, stays editable.
  function pickContact(c: Contact) {
    if (!form) return;
    const seat = c.kind === 'team' ? pickers?.team.find((u) => u.id === c.id)?.role : c.trade;
    setForm({
      ...form, who: `${c.kind === 'team' ? 'u' : c.kind[0]}:${c.id}`, role: roleForContact(c.kind, seat),
      name: c.name, company: c.company ?? '', email: c.email ?? '', phone: c.phone ?? '',
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
      seller_id: t === 's' ? Number(id) : null,
      name: clean(form.name), company: clean(form.company), email: clean(form.email), phone: clean(form.phone),
      // Only sent when set (or cleared on an edit), so a row with neither saves the way it always has.
      ...(form.position || form.had?.position ? { chain_position: form.position || null } : {}),
      ...(form.poc || form.had?.poc ? { is_poc: form.poc } : {}),
    };
    if (!p.user_id && !p.vendor_id && !p.buyer_id && !p.seller_id && !p.name && !p.company) return setErr('Pick someone or type a name.');
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
      {workspaceId ? (
        <RecipientPicker workspaceId={workspaceId} value={form.name} autoFocus={!form.id} style={{ gridColumn: '1 / -1' }}
          placeholder="Search contacts: people, buyers, vendors, title, team. Or type a new name"
          kinds={seeBuyers ? undefined : ['seller', 'vendor', 'team']}
          linked={form.who ? KIND_LABEL[WHO_KIND[form.who.slice(0, 1)]] : null}
          onUnlink={() => setForm({ ...form, who: '' })}
          onChange={(name) => setForm({ ...form, name })} onPick={pickContact} />
      ) : null}
      <select aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Form['role'] })} style={input}>
        {(addableRoles.includes(form.role) ? addableRoles : [form.role, ...addableRoles]).map((r) => <option key={r} value={r}>{PARTY_ROLE_LABEL[r] ?? r}</option>)}
      </select>
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
      {!onDeals && cur && !teamDeal ? <div style={{ fontSize: '12px', color: 'var(--meta, #71717a)', marginTop: '6px' }}>No deal yet.</div> : null}
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
      {!onDeals && teamDeal && workspaceId && seated.size ? (
        <div data-testid="deal-seats" style={{ padding: '6px 0', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>
          {[...seated].map(([role, party]) => (
            <Seat key={role} role={role} party={party} workspaceId={workspaceId} dealId={teamDeal} canEdit={canEdit}
              onSaved={() => { setNonce((n) => n + 1); onChanged?.(role); }} onRemove={(r) => void remove(r)} />
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
              <b>{r.chain_position}</b> {r.is_poc ? <span style={{ color: 'var(--tx-amber, #b45309)' }} title="Point of contact">★</span> : null}{r.name || r.company || '—'}
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

/** What each seat searches first and files a new vendor as. */
const SEAT: Record<SeatRole, { fits: RegExp; kind: string }> = {
  listing_agent: { fits: /realtor|agent/i, kind: 'Realtor' },
  buyers_agent: { fits: /realtor|agent/i, kind: 'Realtor' },
  lender: { fits: /lend/i, kind: 'Lender' },
  second_title: { fits: /title/i, kind: 'Title Company' },
  transactional_funder: { fits: /fund|lend/i, kind: 'Transactional Funder' },
};

type NewVendor = { name: string; company: string; email: string; phone: string };
const NO_VENDOR: NewVendor = { name: '', company: '', email: '', phone: '' };

/**
 * One seat the deal asks for (listing agent, buyer's agent, lender, second
 * title, transactional funder). Empty, it searches Vendors and fills the
 * contact in from the pick; someone not in Vendors is added there and to the
 * team in one step. A transactional funder seat offers the favorites first.
 */
function Seat({ role, party, workspaceId, dealId, canEdit, onSaved, onRemove }: {
  role: SeatRole; party: DealPartyWithDeal | null; workspaceId: number; dealId: number; canEdit: boolean;
  onSaved: () => void; onRemove: (r: DealPartyWithDeal) => void;
}) {
  const session = useSession();
  const cfg = SEAT[role];
  const label = PARTY_ROLE_LABEL[role] ?? role;
  const [mode, setMode] = useState<'view' | 'search' | 'new'>('view');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ q: string; list: SeatVendor[] } | null>(null);
  const [fresh, setFresh] = useState<NewVendor>(NO_VENDOR);
  const [favs, setFavs] = useState<SeatVendor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const empty = !party;

  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = window.setTimeout(() => { void searchSeatVendors(workspaceId, q, cfg.fits).then((list) => { if (live) setHits({ q, list }); }); }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, workspaceId, cfg.fits]);
  useEffect(() => {
    if (role !== 'transactional_funder' || !empty) return;
    let live = true;
    void favoriteFunders(workspaceId).then((f) => { if (live) setFavs(f); });
    return () => { live = false; };
  }, [role, empty, workspaceId]);

  async function put(v: { vendor_id: number; company: string; name: string | null; email: string | null; phone: string | null }) {
    setBusy(true);
    const e = await saveDealParty(workspaceId, dealId, {
      role, user_id: null, buyer_id: null, vendor_id: v.vendor_id,
      name: v.name || v.company, company: v.company, email: v.email, phone: v.phone,
    }, party?.id);
    setBusy(false);
    if (e) return setErr(e);
    setErr(null); setMode('view'); setQ(''); setHits(null);
    onSaved();
  }
  async function addNew() {
    const name = fresh.name.trim(), company = fresh.company.trim(), email = fresh.email.trim(), phone = fresh.phone.trim();
    if (!name && !company) return setErr('Type a name or a company.');
    setBusy(true);
    const r = await createVendor(workspaceId, { name: company || name, contact: name, email, phone, kind: cfg.kind }, session.user?.id ?? null);
    setBusy(false);
    if (!r.ok || !r.id) return setErr(r.message ?? 'Could not add the vendor.');
    setFresh(NO_VENDOR);
    await put({ vendor_id: r.id, company: company || name, name: name || null, email: email || null, phone: phone || null });
  }
  // What was typed in the search carries into the new vendor form.
  function startNew(name = '') {
    const t = q.trim();
    setErr(null);
    setFresh({ ...NO_VENDOR, name: name || (/[\d@]/.test(t) ? '' : t), email: t.includes('@') ? t : '', phone: /^[\d\s()+.-]{7,}$/.test(t) ? t : '' });
    setMode('new');
  }

  const missingFavs = role === 'transactional_funder' && favs
    ? FAVORITE_FUNDERS.filter((n) => !favs.some((f) => (f.name ?? '').toLowerCase() === n.toLowerCase()))
    : [];
  const list = hits && hits.q === q && q.trim().length >= 2 ? hits.list : null;
  const editing = !party || mode !== 'view';

  return (
    <div data-testid={`seat-${role}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 120px) 1fr', gap: '10px', alignItems: 'start', padding: '6px 0', fontSize: '12.5px' }}>
      <span style={{ color: 'var(--meta, #71717a)', paddingTop: '6px' }}>{label}</span>
      <div style={{ minWidth: 0 }}>
        {party && !editing ? (
          <>
            <span style={{ fontWeight: 600 }}>{party.name || party.company || '—'}</span>
            {party.company && party.company !== party.name ? <span style={{ color: 'var(--meta, #71717a)' }}> · {party.company}</span> : null}
            {party.phone || party.email ? <span style={{ display: 'block', color: 'var(--meta, #71717a)', fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[party.phone, party.email].filter(Boolean).join(' · ')}</span> : null}
            {canEdit ? (
              <span style={{ display: 'flex', gap: '10px', marginTop: '2px' }}>
                <button type="button" style={{ ...act, color: 'var(--meta, #71717a)' }} onClick={() => { setErr(null); setMode('search'); }}>Change</button>
                <button type="button" style={{ ...act, color: 'var(--meta, #71717a)' }} onClick={() => onRemove(party)}>Remove</button>
              </span>
            ) : null}
          </>
        ) : !canEdit ? (
          <span style={{ color: 'var(--meta, #71717a)', display: 'inline-block', paddingTop: '6px' }}>Not set</span>
        ) : mode === 'new' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '6px' }}>
            <label style={cap}>Name<input value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} style={{ ...input, marginTop: '3px' }} /></label>
            <label style={cap}>Company<input value={fresh.company} onChange={(e) => setFresh({ ...fresh, company: e.target.value })} style={{ ...input, marginTop: '3px' }} /></label>
            <label style={cap}>Email<input type="email" value={fresh.email} onChange={(e) => setFresh({ ...fresh, email: e.target.value })} style={{ ...input, marginTop: '3px' }} /></label>
            <label style={cap}>Phone<input type="tel" value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} style={{ ...input, marginTop: '3px' }} /></label>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" style={{ ...btn, background: '#0A8560', borderColor: '#0A8560', color: '#fff' }} disabled={busy} onClick={() => void addNew()}>{busy ? 'Adding…' : 'Add to vendors and the deal'}</button>
              <button type="button" style={btn} onClick={() => { setMode('search'); setErr(null); }}>Back to search</button>
              <span style={cap}>Saved in Vendors as {cfg.kind}</span>
            </div>
          </div>
        ) : (
          <>
            {role === 'transactional_funder' && (favs?.length || missingFavs.length) ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
                {(favs ?? []).map((f) => (
                  <button key={f.vendor_id} type="button" disabled={busy} onClick={() => void put(f)} title={[f.phone, f.email].filter(Boolean).join(' · ') || undefined}
                    style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: '5px', borderColor: '#fcd34d', background: 'var(--tint-amber, #fffbeb)' }}>
                    <span style={star(true)} aria-hidden>★</span><b>{f.name}</b><span style={{ color: 'var(--meta, #71717a)' }}>· {f.company}</span>
                  </button>
                ))}
                {missingFavs.map((n) => <button key={n} type="button" style={btn} onClick={() => startNew(n)}>+ {n}</button>)}
              </div>
            ) : null}
            <input aria-label={`Find a ${label.toLowerCase()} in Vendors`} placeholder="Search Vendors: name, company, email or phone" value={q}
              onChange={(e) => setQ(e.target.value)} style={input} />
            {list ? (
              <div style={{ marginTop: '4px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', overflow: 'hidden' }}>
                {list.map((v) => (
                  <button key={v.vendor_id} type="button" disabled={busy} onClick={() => void put(v)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 9px', minHeight: '32px', border: 0, borderBottom: '1px solid var(--divider-2, #f0f0f1)', background: 'var(--surface, #fff)', cursor: 'pointer', fontSize: '12.5px', color: 'var(--ink, #18181b)' }}>
                    <b>{v.name || v.company}</b>{v.name && v.company !== v.name ? <span style={{ color: 'var(--meta, #71717a)' }}> · {v.company}</span> : null}
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--meta, #71717a)' }}>{[v.kind, v.phone, v.email].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
                {!list.length ? <div style={{ padding: '7px 9px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>No vendor matches “{q.trim()}”.</div> : null}
              </div>
            ) : null}
            <span style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button type="button" style={act} onClick={() => startNew()}>+ New vendor</button>
              {party ? <button type="button" style={{ ...act, color: 'var(--meta, #71717a)' }} onClick={() => { setMode('view'); setQ(''); }}>Cancel</button> : null}
            </span>
          </>
        )}
        {err ? <div role="alert" style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginTop: '4px' }}>{err}</div> : null}
      </div>
    </div>
  );
}
