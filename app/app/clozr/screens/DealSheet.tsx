// The deal sheet — the Podio "Deals" item, section by section.
//
// Acquisition, Disposition, Transaction Coordination, Admin / COGS, Terminated
// Contract. Every input saves on blur and the generated totals come back from
// the database with the saved row, so what is on screen is what Postgres
// computed, not a client-side estimate that could drift.
'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { BackLink } from '@/components/ds/BackLink';
import type { ClozrView } from '@/app/clozr/view';
import { dbId } from '@/lib/crm';
import { ReadOnlyNote } from '@/components/ViewAs';
import { type DealInputs, type DealSheet as Sheet, type FeeBreakdown, assignmentFee, loadDeal, loadDealForSeller, loadDealPickers, money, saveDeal, sheetBuyerOptions, touchesLinkedRows } from '@/lib/deal-sheet';
import { InlineField, type InlineOption, type InlineType, type InlineValue } from '@/components/ds/InlineField';
import { useConfirm } from '@/components/ds/Confirm';
import { fridayCloseWarning, fridayOverrideAsk, fridayOverrideNote, isFridayIso } from '@/lib/deal-close';
import { logActivity } from '@/lib/crm-write';
import { READ_ONLY_TITLE, useCanWrite } from '@/lib/read-only-context';
import { supabase } from '@/lib/supabase';
import { sessionRole, useSession } from '@/lib/session';
import { ContractsCard } from '@/components/ContractsCard';
import { DealTeam } from '@/components/DealTeam';
import { DealFiles } from '@/components/DealFiles';
import { PropertyRecords } from '@/components/PropertyRecords';
import { PriceAmendments } from '@/components/PriceAmendments';
import { AiButton } from '@/components/AiButton';
import { DEAL_TYPES, dispoAssignment, parseDealType } from '@/lib/deal-types';
import { canSeeBuyers } from '@/lib/team';
import { DEMO_DEAL } from '@/lib/deal-sheet-demo';
import { underContractBlanks } from '@/lib/section-gaps';

// The sample-data page has no workspace, so /demo alone shows one deal from memory.
const onDemoRoute = () => typeof window !== 'undefined' && window.location.pathname.startsWith('/demo');
const useDemoRoute = () => useSyncExternalStore(() => () => {}, onDemoRoute, () => false);

const label: React.CSSProperties = { display: 'block', fontSize: '12px', color: '#52525b', fontWeight: 500, marginBottom: '5px' };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const h2: React.CSSProperties = { margin: '0 0 2px', fontSize: '14px', fontWeight: 700, letterSpacing: '-0.01em' };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12px', color: '#71717a', maxWidth: '62ch', lineHeight: 1.5 };

/**
 * Whose part of the deal a section is, so the sheet reads at a glance: each
 * section carries its team's badge and a border in that team's colour, and
 * the jump bar at the top uses the same badges. Colour always comes with the
 * team's name in words.
 */
type Team = 'deal' | 'acq' | 'dispo' | 'tc' | 'money' | 'dead';
const TEAM: Record<Team, { name: string; ink: string; tint: string; line: string }> = {
  deal: { name: 'Deal', ink: '#3f3f46', tint: '#f4f4f5', line: '#e4e4e7' },
  acq: { name: 'Acquisitions', ink: '#1d4ed8', tint: '#eff4ff', line: '#b4c8f5' },
  dispo: { name: 'Dispositions', ink: '#6d28d9', tint: '#f5f3ff', line: '#d4c6f7' },
  tc: { name: 'Transaction coordination', ink: '#0A8560', tint: '#E7F8F1', line: '#9fdcc4' },
  money: { name: 'Money', ink: '#334155', tint: '#f1f5f9', line: '#cbd5e1' },
  dead: { name: 'If it fell through', ink: '#b91c1c', tint: '#fef2f2', line: '#f5c2c2' },
};
const SECTIONS: Array<{ id: string; title: string; team: Team }> = [
  { id: 'ds-type', title: 'Deal type', team: 'deal' },
  { id: 'ds-marketing', title: 'Marketing', team: 'dispo' },
  { id: 'ds-acq', title: 'Acquisition', team: 'acq' },
  { id: 'ds-dispo', title: 'Disposition', team: 'dispo' },
  { id: 'ds-tc', title: 'Closing', team: 'tc' },
  { id: 'ds-cogs', title: 'Admin / COGS', team: 'money' },
  { id: 'ds-dead', title: 'Terminated', team: 'dead' },
];
const sec = (t: Team): React.CSSProperties => ({ ...card, border: `1px solid ${TEAM[t].line}`, scrollMarginTop: '56px' });

/** A section's title with whose it is (and who on that team has the deal). */
function SectionHead({ title, team, who }: { title: string; team: Team; who?: string | null }) {
  const t = TEAM[team];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '-16px -18px 12px', padding: '10px 18px', background: t.tint, borderBottom: `1px solid ${t.line}`, borderRadius: '11px 11px 0 0' }}>
      <h2 style={{ ...h2, margin: 0, color: t.ink }}>{title}</h2>
      <span style={{ fontSize: '12px', fontWeight: 500, color: '#52525b' }}>{t.name}{who ? ` · ${who}` : ''}</span>
    </div>
  );
}

/** Scroll the deal sheet to a section, below the sticky bar. */
function jump(id: string) {
  const el = document.getElementById(id);
  const sc = el?.closest('section');
  if (!el || !sc) return;
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 52;
}

/** Sticky row of the sections, coloured by team; a click scrolls there. */
function JumpBar() {
  return (
    <nav aria-label="Deal sheet sections" style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '8px 0', marginBottom: '8px', background: 'var(--c-page, #fafafa)' }}>
      {SECTIONS.map((x) => {
        const t = TEAM[x.team];
        return (
          <a key={x.id} href={`#${x.id}`} onClick={(e) => { e.preventDefault(); jump(x.id); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${t.line}`, background: '#fff', color: '#18181b', fontSize: '12.5px', fontWeight: 600, textDecoration: 'none' }}>
            <span aria-hidden style={{ width: '8px', height: '8px', borderRadius: '50%', background: t.ink }} />{x.title}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * The rep just moved this deal to Under Contract - Seller and landed here. The
 * deal is already on the board; this asks for the deal type and the
 * Acquisition section, and the list shrinks as each field saves. Finished
 * closes it, blanks or not: the deal sheet reminders keep asking.
 */
function UnderContractPrompt({ deal, onDone }: { deal: Sheet; onDone: (missing: number) => void }) {
  const missing = underContractBlanks(deal);
  const done = missing.length === 0;
  const t = TEAM.acq;
  return (
    <div data-testid="dealsheet-under-contract" role="status"
      style={{ ...card, display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', border: `1px solid ${done ? '#86efac' : t.line}`, background: done ? '#f0fdf4' : t.tint }}>
      <div style={{ flex: 1, minWidth: '220px' }}>
        <h2 style={{ ...h2, color: done ? '#166534' : t.ink }}>{done ? 'Deal sheet filled in' : 'Under contract · the deal is on the Deals board'}</h2>
        <p style={{ ...sub, margin: '4px 0 0', color: '#52525b', lineHeight: 1.45 }}>
          {done ? 'Deal type and Acquisition are complete.' : `Fill in the deal type at the top and the Acquisition section. Still blank: ${missing.join(', ')}.`}
        </p>
      </div>
      {done ? null : (
        <button type="button" onClick={() => jump(missing[0] === 'deal type' ? 'ds-type' : 'ds-acq')} style={linkBtn}>
          {missing[0] === 'deal type' ? 'Go to deal type' : 'Go to Acquisition'}
        </button>
      )}
      <button type="button" data-testid="dealsheet-under-contract-done" onClick={() => onDone(missing.length)}
        style={{ ...linkBtn, background: t.ink, borderColor: t.ink, color: '#fff' }}>
        Finished
      </button>
    </div>
  );
}

type Pickers = Awaited<ReturnType<typeof loadDealPickers>>;

/** The prices the assignment fee is worked out from; an edit to one stores the new fee with it. */
const FEE_INPUTS: (keyof DealInputs)[] = ['offer_amount', 'price_drop', 'sold_price', 'marketed_price'];

export function DealSheet({ V }: { V: ClozrView }) {
  const s = useSession();
  const demo = useDemoRoute();
  const workspaceId = s.workspace?.id ?? null;
  const seeBuyers = canSeeBuyers(sessionRole(s));
  const sellerId = V.dealSheetFor.personId ? dbId(V.dealSheetFor.personId) : NaN;
  const grid = V.isMobile ? '1fr' : 'repeat(4, minmax(0, 1fr))';

  // Keyed on the seller so switching records reads as "loading" instantly
  // rather than briefly showing the previous deal's numbers.
  const [state, setState] = useState<{ key: string; deal: Sheet | null; pickers: Pickers; err: string | null } | null>(null);
  const dealId = V.dealSheetFor.dealId ?? null;
  const key = `${workspaceId}:${sellerId}:${dealId ?? ''}`;
  useEffect(() => {
    if (!workspaceId || (dealId == null && !Number.isFinite(sellerId))) return;
    let live = true;
    // A specific deal when one was picked (a partner's submission, even with no seller), else the contact's live deal.
    const load = dealId != null ? loadDeal(dealId).then((deal) => ({ deal, message: deal ? undefined : 'That deal is not available.' })) : loadDealForSeller(workspaceId, sellerId, s.user?.id ?? null);
    void Promise.all([load, loadDealPickers(workspaceId)])
      .then(([d, p]) => { if (live) setState({ key, deal: d.deal, pickers: p, err: d.message ?? null }); });
    return () => { live = false; };
  }, [workspaceId, sellerId, dealId, key, s.user?.id]);
  const cur = state && state.key === key ? state : demo && V.isLiveData === false ? { key, deal: DEMO_DEAL, pickers: { team: [], vendors: [], buyers: [], sources: [] } as Pickers, err: null } : null;
  const deal = cur?.deal ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [orderReq, setOrderReq] = useState(0);
  const [teamRev, setTeamRev] = useState(0);
  const dealDbId = deal?.id ?? null;
  // Whether the contract price was amended (the drop is then already in it): read once per deal.
  const [amended, setAmended] = useState<{ id: number; yes: boolean } | null>(null);
  const dealUpdated = deal?.updated_at ?? null;
  useEffect(() => {
    if (!supabase || dealDbId == null || !workspaceId) return;
    let live = true;
    void supabase.from('deal_price_changes').select('id', { count: 'exact', head: true }).eq('deal_id', dealDbId).eq('field', 'offer_amount')
      .then(({ count }) => { if (live) setAmended({ id: dealDbId, yes: (count ?? 0) > 0 }); });
    return () => { live = false; };
  }, [dealDbId, dealUpdated, workspaceId]);
  const amendedYes = amended?.id === dealDbId ? amended.yes : true;
  const amendedKnown = amended?.id === dealDbId;
  const fee = deal ? assignmentFee(deal, amendedYes) : null;
  const previewOnly = !useCanWrite();
  const demoSheet = demo && V.isLiveData === false;
  // A View-as preview, or a seat that cannot write deals, reads the sheet as text.
  const readOnly = demoSheet ? null : previewOnly ? READ_ONLY_TITLE : V.liveIds && !V.liveIds.canWrite ? 'Your seat can view this deal but not edit it' : null;
  const { confirmReason } = useConfirm();

  /**
   * The one save on the sheet. Opening it writes nothing: the assignment fee is
   * worked out on screen and stored only with an edit to one of the prices it
   * comes from. A Friday close date asks for a typed reason first, and the
   * reason goes on the deal's activity.
   */
  async function save(patch: Partial<DealInputs>): Promise<SaveResult> {
    if (!deal) return { ok: false, message: 'No deal is open.' };
    let override: string | null = null;
    if (typeof patch.close_date === 'string' && isFridayIso(patch.close_date)) {
      override = await confirmReason(fridayOverrideAsk(patch.close_date));
      if (!override) return { ok: false, message: 'Not saved. Pick Monday to Thursday, or give a reason to keep Friday.' };
    }
    if (demoSheet) { setNote('Sample data, not saved'); return { ok: true }; }
    let next = patch;
    // The fee needs to know whether the contract price was amended; until that read is
    // back the stored fee is left alone (an under contract price edit is itself the amendment).
    if (FEE_INPUTS.some((k) => k in patch) && (amendedKnown || 'offer_amount' in patch)) {
      const after = assignmentFee({ ...deal, ...patch } as Sheet, amendedYes || 'offer_amount' in patch).fee;
      if (after != null && Number(deal.assignment_fee ?? NaN) !== after) next = { ...patch, assignment_fee: after };
    }
    const r = await saveDeal(deal.id, next);
    if (!r.ok) { setNote(null); return { ok: false, message: r.message ?? 'The save didn’t go through. Try again' }; }
    setState((st) => (st && st.key === key ? { ...st, deal: r.deal ?? st.deal } : st));
    if (override && workspaceId != null && typeof patch.close_date === 'string') {
      void logActivity(workspaceId, 'deal', deal.id, 'tc', 'Friday close kept', fridayOverrideNote(patch.close_date, override, 'deal sheet'), s.user?.id ?? null).catch(() => {});
    }
    setNote('Saved');
    setTimeout(() => setNote(null), 1200);
    // A field that only lives on the deal re-reads this deal and its seller
    // (five reads); one that also writes the TC file, the checklist or the
    // stage re-reads the workspace.
    if (touchesLinkedRows(patch)) V.reloadCrm();
    else V.refreshDealCrm(deal.id);
    return { ok: true };
  }

  // Opening the sheet never makes a deal; this is the one place on it that does.
  async function startDeal() {
    if (!workspaceId || !Number.isFinite(sellerId)) return;
    const r = await loadDealForSeller(workspaceId, sellerId, s.user?.id ?? null, true);
    if (!r.deal) return setNote(r.message ?? 'Could not start a deal.');
    setState((st) => (st && st.key === key ? { ...st, deal: r.deal, err: null } : st));
    V.refreshSellerCrm(sellerId);
  }

  // The team syncs reps, buyer and title onto the deal in the database — read them back.
  async function refreshDeal() {
    if (!deal) return;
    const fresh = await loadDeal(deal.id);
    if (fresh) setState((st) => (st && st.key === key ? { ...st, deal: fresh } : st));
    setTeamRev((n) => n + 1); // drop the sheet's drafts so picked reps show the synced value
    V.reloadCrm();
  }

  if (V.isLiveData === false && !demo) {
    return (
      <section data-screen-label="Deal sheet" style={{ flex: 1, minWidth: 0, padding: '20px' }}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><h2 style={{ ...h2, flex: 1 }}>Deal sheet</h2><AiButton kind="lane" onClick={() => V.openLane(V.dealSheetFor.personId)} /></div>
          <p style={sub}>The full Podio-style deal record — acquisition, dispo, TC, COGS and profit. It edits a real deal, so it is not part of the sample-data demo. Sign in to use it.</p>
        </div>
      </section>
    );
  }

  return (
    <section data-screen-label="Deal sheet" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: V.isMobile ? '14px' : '18px 22px', background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: '#71717a', marginBottom: '12px', flexWrap: 'wrap' }}>
        <BackLink to={V.backFor('deals')} />
        <span aria-hidden>/</span>
        {V.dealSheetFor.personId
          ? <button className="dc12" onClick={V.openThisPerson} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: '#71717a', fontSize: '12.5px' }}>{V.dealSheetFor.name}</button>
          : <span style={{ color: '#71717a' }}>{V.dealSheetFor.name}</span>}
        <span>/</span>
        <span style={{ color: '#18181b', fontWeight: 600 }}>Deal sheet · {V.dealSheetFor.addr}</span>
        {deal && V.dealStageOfDb(deal.id) != null ? (
          // The deal's stage, movable here: the same save as dragging its card on the board.
          <select aria-label="Deal stage" data-testid="dealsheet-stage" title="Move this deal to another stage"
            value={V.dealStageOfDb(deal.id) ?? ''} onChange={(e) => V.setDealStageDb(deal.id, e.target.value)}
            style={{ height: '28px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px', fontWeight: 600, color: '#18181b', padding: '0 8px', cursor: 'pointer' }}>
            {(V.dealStageChoices.includes(V.dealStageOfDb(deal.id) ?? '') ? V.dealStageChoices : [V.dealStageOfDb(deal.id) ?? '', ...V.dealStageChoices]).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : null}
        {(V.dealSheetFor.vendorSellers ?? []).map((v) => (
          // A role without People (TC, Notary) sees the name without a link to it.
          <button key={v.id} type="button" className="dc12" title={V.can.people ? 'Open this vendor' : undefined} disabled={!V.can.people}
            onClick={() => V.openVendorContact({ id: dbId(v.id), name: v.name, role: 'seller' })}
            style={{ height: '24px', padding: '0 8px', borderRadius: '999px', border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', fontSize: '11.5px', fontWeight: 600, cursor: V.can.people ? 'pointer' : 'default' }}>
            Seller · {v.company && v.company !== v.name ? `${v.name} · ${v.company}` : v.name}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {note ? <span style={{ fontSize: '12px', color: note === 'Saved' ? '#0A8560' : '#b91c1c', fontWeight: 600 }}>{note}</span> : null}
        {deal && workspaceId ? (
          <button type="button" data-testid="header-order-photos" onClick={() => setOrderReq((n) => n + 1)}
            title="Order iVueit photos of this house. A local Vuer shoots it and the photos land under Files & photos."
            style={{ height: '28px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px', fontWeight: 600, color: '#18181b', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Order photos
          </button>
        ) : null}
        {deal ? (
          <button type="button" data-testid="dealsheet-archive" onClick={() => V.archiveDealDb(deal.id, !V.dealArchivedDb(deal.id))}
            title={V.dealArchivedDb(deal.id) ? 'Put this deal back on the board and Dispo' : 'Archive: off the Deals board, the deal list and Dispo'}
            style={{ height: '28px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px', fontWeight: 600, color: '#52525b', cursor: 'pointer' }}>
            {V.dealArchivedDb(deal.id) ? 'Restore' : 'Archive'}
          </button>
        ) : null}
        <AiButton kind="lane" onClick={() => V.openLane(V.dealSheetFor.personId)} />
      </div>

      <ReadOnlyNote />
      {!cur ? <div style={card}><p style={sub}>Loading the deal…</p></div> : null}
      {cur && !deal ? (
        <div style={card}>
          <p style={{ ...sub, color: cur.err ? '#b91c1c' : '#71717a' }}>{cur.err ?? 'No deal on this seller yet.'}</p>
          {!cur.err && Number.isFinite(sellerId) && V.liveIds?.canWrite ? (
            <button type="button" data-testid="dealsheet-start" onClick={() => void startDeal()} style={{ ...linkBtn, background: '#0A8560', borderColor: '#0A8560', color: '#fff' }}>Start a deal</button>
          ) : null}
        </div>
      ) : null}
      {deal && V.dealSheetPrompt ? (
        <UnderContractPrompt deal={deal} onDone={(missing) => {
          V.endDealSheetPrompt();
          if (missing) V.showToast(`Deal saved · ${missing} detail${missing === 1 ? '' : 's'} still blank, your reminders will ask`);
        }} />
      ) : null}
      {deal ? <DealTeam dealId={deal.id} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} onChanged={() => void refreshDeal()} /> : null}
      {deal && fee ? <Sections key={teamRev} deal={deal} pickers={cur!.pickers} grid={grid} save={save} readOnly={readOnly} seeBuyers={seeBuyers} onOpenSeller={V.dealSheetFor.personId ? V.openThisPerson : undefined} buyerOpts={sheetBuyerOptions(V.sheetBuyers, deal.buyer_id)} fee={fee} /> : null}
      {deal && workspaceId ? (
        <div style={sec('deal')}>
          <SectionHead title="Price amendments" team="deal" />
          <p style={sub}>Every change to a price on this deal — who, when and by how much.</p>
          <PriceAmendments workspaceId={workspaceId} dealId={deal.id} reloadKey={deal.updated_at} />
        </div>
      ) : null}
      {deal && workspaceId ? (
        <div style={sec('deal')}>
          <SectionHead title="Property records" team="deal" />
          <p style={sub}>The public record COMPR pulled for this property.</p>
          <PropertyRecords dealId={deal.id} reloadKey={deal.updated_at} />
        </div>
      ) : null}
      {deal && workspaceId ? (
        <div style={sec('deal')}>
          <SectionHead title="Files & photos" team="deal" />
          <p style={sub}>Contracts, inspections, anything on this deal. Upload many at once or paste links.</p>
          <DealFiles
            workspaceId={workspaceId}
            dealId={deal.id}
            canWrite
            onToast={V.showToast}
            onOpenPhotos={(title, urls, start) => V.openPhotoShow(title, urls, deal.id, start)}
            fallbackPhotos={V.P.photos.length ? V.P.photos : [V.P.streetSafe].filter(Boolean)}
            orderRequest={orderReq}
          />
        </div>
      ) : null}
      {deal && workspaceId ? (
        <ContractsCard
          workspaceId={workspaceId} sellerId={deal.seller_id} dealId={deal.id} buyerId={seeBuyers ? (deal.buyer_id ?? null) : null}
          seller={{ name: V.P.name, email: V.P.email, phone: V.P.phone }}
          canWrite onToast={V.showToast} onChanged={V.reloadCrm}
        />
      ) : null}
    </section>
  );
}

/**
 * What a field on the sheet needs: the deal, how to save one patch (which
 * resolves ok or with the message the field shows under itself), and why this
 * seat cannot edit, when it cannot.
 */
type Ctx = {
  deal: Sheet;
  save: (p: Partial<DealInputs>) => Promise<SaveResult>;
  readOnly: string | null;
};
type SaveResult = { ok: boolean; message?: string };

/**
 * One click-to-edit field (components/ds/InlineField): blur or Enter saves,
 * Esc cancels, an unchanged value is not saved, and "abc" in a money field is
 * an error under the field, never a 0. `zero` columns are NOT NULL in the
 * database: clearing one saves 0.
 */
function F({ f, k, l, type = 'text', ph, wide, zero, note }: {
  f: Ctx; k: keyof DealInputs; l: string; type?: InlineType; ph?: string; wide?: boolean; zero?: boolean; note?: React.ReactNode;
}) {
  const raw = f.deal[k];
  const value: InlineValue = raw == null ? null : typeof raw === 'number' ? raw : typeof raw === 'boolean' ? String(raw) : type === 'date' ? String(raw).slice(0, 10) : String(raw);
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : undefined, minWidth: 0, display: 'flex', flexDirection: 'column' }} data-field={k}>
      <InlineField recordId={'deal' + f.deal.id} field={String(k)} label={l} showLabel type={type} value={value} placeholder={ph ?? 'Add'} width="100%"
        readOnly={f.readOnly} onSave={(v) => f.save({ [k]: v == null && zero ? 0 : v } as Partial<DealInputs>)} />
      {note}
    </div>
  );
}

/** A value this section shows but another place edits (the deal team, the database). */
function Info({ l, v, hint, testId }: { l: string; v: React.ReactNode; hint?: string; testId?: string }) {
  return (
    <div style={{ minWidth: 0 }} title={hint}>
      <span style={{ ...label, fontSize: '11.5px', marginBottom: '4px' }}>{l}</span>
      <div data-testid={testId} style={{ minHeight: '28px', display: 'flex', alignItems: 'center', fontSize: '13px', fontWeight: 600, color: '#18181b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v || <span style={{ color: '#71717a', fontWeight: 500 }}>Not set</span>}</div>
    </div>
  );
}

/** Under a Friday close date: the rule, in red, every time the sheet shows it. */
function FridayNote({ iso }: { iso: string | null | undefined }) {
  const w = fridayCloseWarning(iso);
  if (!w) return null;
  return <span role="alert" data-testid="dealsheet-friday" style={{ fontSize: '11.5px', color: '#b91c1c', fontWeight: 600, marginTop: '4px', lineHeight: 1.4 }}>{w}</span>;
}
function DealTypeBanner({ value, onPick, disabled }: { value: string | null; onPick: (label: string) => void; disabled?: boolean }) {
  const current = parseDealType(value);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {DEAL_TYPES.map((t) => {
        const on = current?.key === t.key;
        return (
          <button key={t.key} type="button" onClick={() => onPick(t.label)} aria-pressed={on} disabled={disabled}
            style={{ height: '36px', padding: '0 14px', borderRadius: '999px', border: on ? `1px solid ${t.fg}` : '1px solid #e4e4e7', background: on ? t.bg : '#fff', color: on ? t.fg : '#27272a', fontWeight: 750, fontSize: '13px', cursor: disabled ? 'default' : 'pointer' }}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function Total({ l, v, strong }: { l: string; v: number; strong?: boolean }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: '10px', background: strong ? '#dcfce7' : '#fafafa', border: `1px solid ${strong ? '#bbf7d0' : '#f0f0f1'}` }}>
      <div style={label}>{l}</div>
      <div style={{ fontSize: strong ? '20px' : '16px', fontWeight: 700, letterSpacing: '-0.02em', color: v < 0 ? '#b91c1c' : strong ? '#15803d' : '#18181b' }}>{money(v)}</div>
    </div>
  );
}

const linkBtn: React.CSSProperties = { height: '28px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px', fontWeight: 600, color: '#18181b', cursor: 'pointer' };

function DispoHint({ type }: { type: string | null }) {
  const how = dispoAssignment(type);
  if (!how) return null;
  const text = how === 'round_robin'
    ? 'Novation assigns this from the dispositions round robin when the seat is empty. It stays editable.'
    : 'Whoever is selling this deal.';
  return <div style={{ fontSize: '11px', color: '#71717a', marginTop: '4px', lineHeight: 1.4 }}>{text}</div>;
}

/** What dispo needs from the file, without asking for people the contract already names. */
function DispoFacts({ deal, pickers, onOpenSeller }: { deal: Sheet; pickers: Pickers; onOpenSeller?: () => void }) {
  const acq = pickers.team.find((t) => t.id === deal.owner_id)?.label || deal.acq_agent || '—';
  const report = deal.buyer_report_url || deal.compr_cma_url || '';
  return (
    <div data-testid="dealsheet-dispo-facts" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
      <span data-testid="dealsheet-acq-rep" style={{ fontSize: '12.5px', color: '#27272a' }}>
        <span style={{ ...label, display: 'inline', marginRight: '6px' }}>Acquisition rep</span>
        <b>{acq}</b>
      </span>
      <span data-testid="dealsheet-asking" style={{ fontSize: '12.5px', color: '#27272a' }}>
        <span style={{ ...label, display: 'inline', marginRight: '6px' }}>Asking price</span>
        <b>{money(deal.asking_price)}</b>
      </span>
      <span style={{ flex: 1 }} />
      {onOpenSeller ? <button type="button" data-testid="dealsheet-seller" onClick={onOpenSeller} style={linkBtn}>Seller record</button> : null}
      <button type="button" data-testid="dealsheet-compr-report" disabled={!report}
        title={report ? 'Open the COMPR report' : 'No COMPR report on this deal yet'}
        onClick={() => { if (report) window.open(report, '_blank', 'noopener'); }}
        style={{ ...linkBtn, cursor: report ? 'pointer' : 'not-allowed', opacity: report ? 1 : 0.5 }}>
        COMPR report
      </button>
    </div>
  );
}

function Sections({ deal, pickers, grid, save, readOnly, seeBuyers, onOpenSeller, buyerOpts, fee }: {
  deal: Sheet; pickers: Pickers; grid: string; save: (p: Partial<DealInputs>) => Promise<SaveResult>; readOnly: string | null;
  seeBuyers: boolean; onOpenSeller?: () => void; buyerOpts: { id: number; label: string; at?: number }[]; fee: FeeBreakdown;
}) {
  const f: Ctx = { deal, save, readOnly };
  const who = (id: string | null | undefined, fallback?: string | null) => (id ? pickers.team.find((t) => t.id === id)?.label : null) || fallback || '';
  const titleVendor = pickers.vendors.find((v) => v.id === deal.title_vendor_id);
  const buyer = deal.buyer_id != null ? buyerOpts.find((b) => b.id === deal.buyer_id)?.label ?? `Buyer ${deal.buyer_id}` : '';
  const onTeam = 'Set on the deal team above';
  const g: React.CSSProperties = { display: 'grid', gridTemplateColumns: grid, gap: '10px 12px' };
  const yesNo: InlineOption[] = [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }];

  return (
    <>
      <JumpBar />
      <div style={sec('deal')} id="ds-type">
        <SectionHead title="Deal type" team="deal" />
        <p style={sub}>Assignment, JV, double close, or novation. Novation with no dispo yet is dealt by the dispositions round robin. Assignment and double close keep whoever is selling it. Novation uses the novation TC checklist. The other three use the assignment checklist. Property #, lead source and contract status fill in from the deal — they are not typed here again.</p>
        <DealTypeBanner value={deal.transaction_type} disabled={!!readOnly} onPick={(label) => void save({ transaction_type: label })} />
        <div style={{ ...g, marginTop: '12px' }}>
          <Info l="Property #" testId="dealsheet-tracker-no" v={deal.tracker_no != null ? `Property ${deal.tracker_no}` : 'Assigned when the deal hits the board'} />
          <Info l="Lead source" testId="dealsheet-lead-source" v={deal.lead_source || 'From the seller\'s source'} />
          <Info l="Contract status" testId="dealsheet-contract-status" v={deal.stage || ''} />
        </div>
      </div>

      <div style={sec('dispo')} id="ds-marketing">
        <SectionHead title="Marketing" team="dispo" />
        <p style={sub}>What buyer texts and emails say about this deal: {'{{headline}}'}, {'{{description}}'}, {'{{garage}}'}. View Full Deal is the COMPR buyer report, Photos is COMPR&rsquo;s photo set, and Comps &amp; underwriting is the buyer CMA PDF. A typed marketing link is only used when COMPR has not shared a report yet.</p>
        <div style={g}>
          <F f={f} k="marketing_headline" l="Headline" ph="Add a headline" wide />
          <F f={f} k="marketing_url" l="Marketing / more-info link" ph="Add a link" wide />
          <F f={f} k="garage_spaces" l="Garage spaces" type="number" />
          <F f={f} k="marketed_price" l="Marketed price" type="money" />
          <F f={f} k="marketed_fee" l="Marketed fee" type="money" />
          <F f={f} k="target_assignment" l="Target assignment" type="money" />
          <F f={f} k="price_drop" l="Price drop" type="money" />
          <F f={f} k="marketing_description" l="Property description" type="textarea" ph="Add a description" wide />
        </div>
      </div>

      <div style={sec('acq')} id="ds-acq">
        <SectionHead title="Acquisition" team="acq" who={who(deal.owner_id, deal.acq_agent)} />
        <p style={sub}>Who got it, and the seller contract. The acquisitions rep and the lead manager are set on the deal team.</p>
        <div style={g}>
          <Info l="Acquisitions rep" testId="dealsheet-acq-pick" v={who(deal.owner_id, deal.acq_agent)} hint={onTeam} />
          <Info l="Lead manager" testId="dealsheet-lead-manager" v={who(deal.lead_manager_id, deal.lead_manager)} hint={onTeam} />
          <F f={f} k="offer_amount" l="Under contract price" type="money" />
          <F f={f} k="arv" l="ARV" type="money" />
          <F f={f} k="rehab" l="Rehab estimate" type="money" />
          <F f={f} k="earnest_money" l="Earnest money" type="money" />
          <F f={f} k="contract_date" l="Contract date" type="date" />
          <F f={f} k="option_ends_on" l="Option period ends" type="date" />
          <F f={f} k="close_date" l="Close date" type="date" note={<FridayNote iso={deal.close_date} />} />
          <F f={f} k="option_fee" l="Option fee" type="money" />
          <F f={f} k="option_period_days" l="Option period (days)" type="number" ph="10" />
          <F f={f} k="emd_due_days" l="EMD due within (days)" type="number" ph="3" />
          <F f={f} k="underwriting_url" l="Underwriting spreadsheet" ph="Add a link" wide />
          <F f={f} k="condition_notes" l="Condition" type="textarea" wide />
          <F f={f} k="occupancy_notes" l="Occupancy / vacate" type="textarea" wide />
          <F f={f} k="special_provisions" l="Special provisions (printed on the contract)" type="textarea" wide />
        </div>
      </div>

      <div style={sec('dispo')} id="ds-dispo">
        <SectionHead title="Disposition" team="dispo" who={who(deal.dispo_rep_id, deal.dispo_agent)} />
        <p style={sub}>Who is selling it, set once on the deal team, and what it sold for. Wholesale fee is sold price less contract price.</p>
        <DispoFacts deal={deal} pickers={pickers} onOpenSeller={onOpenSeller} />
        <div style={g}>
          <div>
            <Info l="Dispositions" testId="dealsheet-dispo-pick" v={who(deal.dispo_rep_id, deal.dispo_agent)} hint={onTeam} />
            <DispoHint type={deal.transaction_type} />
          </div>
          <Info l="Second dispositions" v={who(deal.dispo_rep2_id)} hint={onTeam} />
          {seeBuyers ? <Info l="Buyer" testId="dealsheet-buyer" v={buyer} hint={onTeam} /> : null}
          <F f={f} k="sold_price" l="Sold price" type="money" />
          <F f={f} k="dispo_upsell" l="Dispo upsell" type="money" />
          <F f={f} k="dispo_fee" l="Dispo fee" type="money" />
          <F f={f} k="buyer_option_ends_on" l="Buyer option ends" type="date" />
          <F f={f} k="marketing_started_on" l="Marketing started" type="date" />
          <Total l="Wholesale fee" v={deal.wholesale_fee} strong />
          <div title={fee.fee == null ? 'Needs an under contract price and a sold or marketed price' : undefined}>
            <Total l={fee.projected ? 'Assignment fee (projected)' : 'Assignment fee'} v={fee.fee ?? 0} strong={!fee.projected} />
            <div style={{ fontSize: '11px', color: '#71717a', marginTop: '4px', lineHeight: 1.4 }}>
              {fee.fee == null ? 'Add the under contract price and a sold or marketed price.' : `${fee.projected ? 'Marketed' : 'Sold'} ${money(fee.buyer)} − contract ${money(fee.contract)}${fee.drop ? ` (after ${money(fee.drop)} price drop)` : ''}`}
            </div>
          </div>
        </div>
      </div>

      <div style={sec('tc')} id="ds-tc">
        <SectionHead title="Closing" team="tc" who={who(deal.tc_rep_id, deal.coordinator)} />
        <p style={sub}>The TC, the title company and the closing. The TC and title are on the deal team.</p>
        <div style={g}>
          <Info l="Transaction coordinator" testId="dealsheet-tc-pick" v={who(deal.tc_rep_id, deal.coordinator)} hint={onTeam} />
          <Info l="Title company" testId="dealsheet-title" v={titleVendor?.label ?? (deal.title_vendor_id ? `Vendor ${deal.title_vendor_id}` : '')} hint={onTeam} />
          <Info l="Title contact" v={deal.title_contact || titleVendor?.contact || ''} hint={onTeam} />
          <Info l="Title email" v={deal.title_email || titleVendor?.email || ''} hint={onTeam} />
          <Info l="Title phone" v={deal.title_phone || titleVendor?.phone || ''} hint={onTeam} />
          <F f={f} k="property_access" l="Access" ph="Lockbox, vacant, seller lets in" />
          <F f={f} k="access_instructions" l="Lockbox code / access notes" type="textarea" ph="Add the code and where the box is" wide />
          <F f={f} k="closed_on" l="Closed on" type="date" />
          <F f={f} k="tc_fee" l="TC fee" type="money" />
        </div>
      </div>

      <div style={sec('money')} id="ds-cogs">
        <SectionHead title="Admin / COGS" team="money" />
        <p style={sub}>Every cost that comes out of the wholesale fee. Commissions are computed from the percentages; totals are computed by the database.</p>
        <div style={g}>
          <F f={f} k="cogs_bonuses" l="Bonuses" type="money" zero />
          <F f={f} k="cogs_lockbox" l="Lockbox" type="money" zero />
          <F f={f} k="cogs_photos" l="Photos" type="money" zero />
          <F f={f} k="cogs_lead" l="Lead cost" type="money" zero />
          <F f={f} k="cogs_contractor" l="Contractor costs" type="money" zero />
          <F f={f} k="cogs_earnest_lost" l="Earnest money lost" type="money" zero />
          <F f={f} k="cogs_notary" l="Notary fees" type="money" zero />
          <F f={f} k="cogs_title_fees" l="Title fees" type="money" zero />
          <F f={f} k="cogs_transactional" l="Transactional funding" type="money" zero />
          <F f={f} k="cogs_realtor" l="Realtor commissions" type="money" zero />
          <F f={f} k="lac_pct" l="LAC %" type="number" ph="0" zero />
          <F f={f} k="bac_pct" l="BAC %" type="number" ph="0" zero />
          <Total l="Listing agent commission" v={deal.listing_agent_commission} />
          <Total l="Buyer's agent commission" v={deal.buyers_agent_commission} />
          <F f={f} k="cogs_flat_fee" l="Flat fee cost" type="money" zero />
          <F f={f} k="cogs_concessions" l="Concessions" type="money" zero />
        </div>
        <div style={{ ...g, marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #f0f0f1' }}>
          <Total l="Total COGS" v={deal.total_cogs} />
          <Total l="Deal net profit" v={deal.deal_net_profit} />
          <F f={f} k="team_commissions_paid" l="Team commissions paid" type="money" zero />
          <Total l="Final profit" v={deal.final_profit} strong />
        </div>
      </div>

      <div style={sec('dead')} id="ds-dead">
        <SectionHead title="Terminated" team="dead" />
        <p style={sub}>Only if it fell through.</p>
        <div style={g}>
          <div style={{ minWidth: 0 }}>
            <InlineField recordId={'deal' + deal.id} field="terminated" label="Terminated" showLabel type="select" options={yesNo} width="100%"
              value={deal.terminated ? 'yes' : 'no'} readOnly={readOnly} onSave={(v) => save({ terminated: v === 'yes' })} />
          </div>
          <F f={f} k="terminated_on" l="Terminated on" type="date" />
          <div style={{ minWidth: 0 }}>
            <InlineField recordId={'deal' + deal.id} field="earnest_refunded" label="Earnest refunded" showLabel type="select" width="100%"
              options={[{ value: '', label: 'Not set' }, ...yesNo]} readOnly={readOnly}
              value={deal.earnest_refunded == null ? '' : deal.earnest_refunded ? 'yes' : 'no'}
              onSave={(v) => save({ earnest_refunded: v === 'yes' ? true : v === 'no' ? false : null })} />
          </div>
          <F f={f} k="termination_reason" l="Reason" type="textarea" wide />
        </div>
      </div>
    </>
  );
}
