// The buyer profile — what Dispo Genius calls the Genius Profile.
//
// Contact and type, the buy box (locations with a Restricted flag, strategy,
// property types, price / sqft / year ranges, bed and bath minimums,
// restricted rehab levels and specialty rehabs), deal economics, advanced
// restrictions / requirements / strict criteria, and how they want to be
// reached. One form for new and edit; saving writes buyers.criteria and
// re-matches the buyer against active inventory (lib/crm-write).
'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import {
  BUYER_TYPES, CHANNELS, ENTITY_TYPES, FUNDING, LOCATION_CHIPS, PROPERTY_CHIPS, PROPERTY_TYPES, PURCHASE_METHODS, REHAB_LEVELS,
  SPECIALTY_REHABS, STRATEGIES, STRICT_OPTIONS, type BuyBox, type LocationPref, type LocationType, type Opt, emptyBuyBox, normalizeBuyBox,
} from '@/lib/buyer-profile';
import { isSecretTag, SECRET_BLACKLIST_TAG, visibleTags } from '@/lib/secret-list';
import { type BuyerProfileInput, createBuyer, updateBuyer } from '@/lib/crm-write';
import { buyerContactProblem } from '@/lib/buyer-contact';
import { parseDollars } from '@/lib/money';
import { useConfirm } from '@/components/ds/Confirm';
import { refreshBuyerRow } from '@/app/components/buyer/BuyerProfileFields';
import { supabase } from '@/lib/supabase';
import { STATE_NAMES, stateOfZip } from '@/lib/market-geo';
import { citiesIn, countiesIn, formatPop, searchPlaces, type GeoPlace } from '@/lib/us-cities';
import { fillBuyBoxGaps, type BuyerProfileSeed } from '@/lib/call-profile';

const MINT = '#0A8560';
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600, marginBottom: '5px' };
const field: React.CSSProperties = { width: '100%', height: '34px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', fontSize: '13px', outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)', boxSizing: 'border-box' };
const area: React.CSSProperties = { ...field, height: 'auto', minHeight: '70px', padding: '8px 10px', resize: 'vertical' };
const btn = (primary: boolean, disabled = false): React.CSSProperties => ({ height: '34px', padding: '0 14px', borderRadius: '9px', border: `1px solid ${primary ? 'var(--ink, #18181b)' : 'var(--divider, #e4e4e7)'}`, background: disabled ? 'var(--line, #d4d4d8)' : primary ? 'var(--ink, #18181b)' : 'var(--surface, #fff)', color: primary ? 'var(--surface, #fff)' : 'var(--ink, #18181b)', fontSize: '12.5px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' });
// The 50 states + DC by full name (STATE_NAMES also carries PR, which the Census pick lists do not).
const STATES = Object.keys(STATE_NAMES).filter((c) => c !== 'PR').sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]));

type Form = {
  name: string; company: string; phone: string; email: string; buyer_type: string; entity_type: string; website: string; pof_url: string; pof_verified: boolean;
  preferred_channel: string; wants_calls: boolean; wants_follow_ups: boolean; wants_sold_alerts: boolean;
  vetted: boolean; vip: boolean; blacklisted: boolean; active: boolean; tags: string; notes: string; box: BuyBox;
};
const blank = (): Form => ({ name: '', company: '', phone: '', email: '', buyer_type: 'investor', entity_type: 'llc', website: '', pof_url: '', pof_verified: false, preferred_channel: 'email_and_sms', wants_calls: true, wants_follow_ups: true, wants_sold_alerts: false, vetted: false, vip: false, blacklisted: false, active: true, tags: '', notes: '', box: emptyBuyBox() });
/** A new buyer's form opened from a call (components/talkr/CallProfileCard): what was said, the rest left as a new form has it. */
const seeded = (form: Form, seed: BuyerProfileSeed): Form => ({
  ...form,
  name: seed.name ?? form.name, company: seed.company ?? form.company, phone: seed.phone ?? form.phone, email: seed.email ?? form.email,
  buyer_type: seed.buyer_type ?? form.buyer_type, notes: seed.notes ?? form.notes, box: seed.box ? normalizeBuyBox(seed.box) : form.box,
});

type Tab = 'Profile' | 'Buy box' | 'Economics' | 'Advanced' | 'Contact';
const TABS: Tab[] = ['Profile', 'Buy box', 'Economics', 'Advanced', 'Contact'];
// An existing buyer's name, phones, emails, type, POF, vetted, VIP and stage
// are edited in place on the record (BuyerRecord's profile fields), so this
// dialog is only the bulk buy box for them: it cannot write a stale copy of
// anything the record changed while it was open.
const EDIT_TABS: Tab[] = ['Buy box', 'Economics', 'Advanced', 'Contact'];

export function BuyerProfileModal({ open, buyerId, seed, workspaceId, userId, onClose, onSaved, onToast }: {
  open: boolean; buyerId: number | null;
  /**
   * What a call said (the dialer's "From this call"). A new buyer's form opens
   * filled with it; an existing buyer's buy box takes it only where it is empty.
   * Nothing saves until the rep presses Save.
   */
  seed?: BuyerProfileSeed | null;
  workspaceId: number | null; userId: string | null;
  onClose: () => void; onSaved: () => void; onToast: (msg: string) => void;
}) {
  // Keyed on the buyer so opening a different profile starts from a clean form.
  if (!open) return null;
  return <ProfileDialog key={buyerId ?? 'new'} buyerId={buyerId} seed={seed ?? null} workspaceId={workspaceId} userId={userId} onClose={onClose} onSaved={onSaved} onToast={onToast} />;
}

function ProfileDialog({ buyerId, seed, workspaceId, userId, onClose, onSaved, onToast }: {
  buyerId: number | null; seed: BuyerProfileSeed | null; workspaceId: number | null; userId: string | null;
  onClose: () => void; onSaved: () => void; onToast: (msg: string) => void;
}) {
  const [f, setF] = useState<Form>(() => (seed && !buyerId ? seeded(blank(), seed) : blank()));
  const [tab, setTab] = useState<Tab>(buyerId ? 'Buy box' : 'Profile');
  const tabs = buyerId ? EDIT_TABS : TABS;
  // A form filled from a call is unsaved work: closing it asks first.
  const [dirty, setDirty] = useState(!!seed);
  const seedBox = useRef(seed?.box ?? null);
  // Number fields that hold something unreadable ("abc"): Save waits for them.
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const badCount = Object.values(bad).filter(Boolean).length;
  const report = (key: string) => (b: boolean) => setBad((x) => (!!x[key] === b ? x : { ...x, [key]: b }));
  const { confirm } = useConfirm();
  // A click outside or Esc never throws typing away without asking.
  const requestClose = async () => {
    if (busy) return;
    if (dirty && !(await confirm({ title: 'Discard your changes?', body: 'What you changed in this profile has not been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', tone: 'danger' }))) return;
    onClose();
  };
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!buyerId && !!supabase);
  const [err, setErr] = useState<string | null>(null);
  // Migration 54: the date a paused buyer becomes active again (the "active again" automation reads it).
  const [activeAgain, setActiveAgain] = useState('');
  const heldSecret = useRef(false);

  useEffect(() => {
    if (!buyerId || !supabase) return;
    let live = true;
    void supabase.from('buyers').select('*').eq('id', buyerId).maybeSingle().then(({ data }) => {
      if (!live) return;
      setLoading(false);
      if (!data) return;
      const r = data as Record<string, unknown>;
      const rawTags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
      heldSecret.current = rawTags.some(isSecretTag);
      setActiveAgain(typeof r.active_again_at === 'string' ? r.active_again_at.slice(0, 10) : '');
      setF({
        name: String(r.name ?? ''), company: String(r.company ?? ''), phone: String(r.phone ?? ''), email: String(r.email ?? ''),
        buyer_type: String(r.buyer_type ?? 'investor'), entity_type: String(r.entity_type ?? 'llc'), website: String(r.website ?? ''), pof_url: String(r.pof_url ?? ''), pof_verified: !!r.pof_verified_at,
        preferred_channel: String(r.preferred_channel ?? 'email_and_sms'), wants_calls: r.wants_calls !== false, wants_follow_ups: r.wants_follow_ups !== false, wants_sold_alerts: r.wants_sold_alerts === true,
        vetted: !!r.vetted_at, vip: r.vip === true, blacklisted: !!r.blacklisted_at, active: !/inactive/i.test(String(r.status ?? 'Active')),
        tags: visibleTags(rawTags).join(', '), notes: String(r.notes ?? ''),
        box: ((stored: BuyBox) => (seedBox.current ? fillBuyBoxGaps(stored, seedBox.current) : stored))(
          normalizeBuyBox(r.criteria && typeof r.criteria === 'object' && Object.keys(r.criteria as object).length ? r.criteria : { locations: { cities: (r.markets as string[]) ?? [] }, price: { max: r.max_purchase_price } }),
        ),
      });
    });
    return () => { live = false; };
  }, [buyerId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setDirty(true); setF((x) => ({ ...x, [k]: v })); };
  const setBox = (patch: Partial<BuyBox>) => { setDirty(true); setF((x) => ({ ...x, box: { ...x.box, ...patch } })); };
  const setEcon = (patch: Partial<BuyBox['economics']>) => { setDirty(true); setF((x) => ({ ...x, box: { ...x.box, economics: { ...x.box.economics, ...patch } } })); };
  // A new buyer needs both a phone and an email. An existing one keeps the old
  // rule (name plus either) so legacy imports with only one can still save;
  // the gap shows as a hint instead.
  const contactProblem = buyerContactProblem(f, !buyerId);
  const missing = buyerId ? false : !f.name.trim() || !!contactProblem;

  const submit = async () => {
    if (!workspaceId) return setErr('Sign in to save a buyer.');
    if (badCount) return setErr('Fix the highlighted numbers first.');
    const inverted = ([['Price', f.box.price], ['Square footage', f.box.sqft], ['Year built', f.box.year_built], ['Lot size', f.box.lot_sqft]] as [string, { min?: number | null; max?: number | null }][])
      .find(([, x]) => x.min != null && x.max != null && x.min > x.max);
    if (inverted) return setErr(`${inverted[0]}: the low end is above the high end.`);
    setBusy(true); setErr(null);
    // Editing: only the buy box and how they want to be reached. Everything
    // else on the record saves where it is shown, one field at a time.
    const payload: BuyerProfileInput = buyerId ? {
      preferred_channel: f.preferred_channel, wants_calls: f.wants_calls, wants_follow_ups: f.wants_follow_ups, wants_sold_alerts: f.wants_sold_alerts,
      criteria: normalizeBuyBox(f.box),
    } : {
      name: f.name, company: f.company, phone: f.phone, email: f.email, buyer_type: f.buyer_type, entity_type: f.entity_type, website: f.website, pof_url: f.pof_url, pof_verified: f.pof_verified,
      preferred_channel: f.preferred_channel, wants_calls: f.wants_calls, wants_follow_ups: f.wants_follow_ups, wants_sold_alerts: f.wants_sold_alerts,
      vetted: f.vetted, vip: f.vip, blacklisted: f.blacklisted, active: f.active,
      tags: [...f.tags.split(',').map((t) => t.trim()).filter((t) => t && !isSecretTag(t)), ...(heldSecret.current ? [SECRET_BLACKLIST_TAG] : [])],
      notes: f.notes, criteria: normalizeBuyBox(f.box),
    };
    const r = buyerId ? await updateBuyer(workspaceId, buyerId, payload) : await createBuyer(workspaceId, payload, userId);
    setBusy(false);
    if (!r.ok) return setErr(r.message ?? 'Could not save.');
    if (buyerId && supabase) {
      const { error } = await supabase.from('buyers').update({ active_again_at: activeAgain ? new Date(activeAgain + 'T09:00:00').toISOString() : null }).eq('id', buyerId);
      if (error) onToast('Profile saved, but the inactive-until date did not: ' + error.message);
    }
    if (buyerId) void refreshBuyerRow(buyerId);
    onToast((buyerId ? 'Buy box saved' : f.name.trim() + ' added to buyers') + (r.message ? ' · ' + r.message : ''));
    onSaved(); onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(24,24,27,.42)', display: 'grid', placeItems: 'center', padding: '16px' }}
      onClick={() => void requestClose()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void requestClose(); } }}>
      <div role="dialog" aria-modal="true" aria-label={buyerId ? 'Buy box' : 'New buyer'} onClick={(e) => e.stopPropagation()} style={{ width: 'min(860px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--surface, #fff)', borderRadius: '14px', boxShadow: '0 30px 80px -20px rgba(18,22,45,.4)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
            <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>{buyerId ? 'Buy box' : 'New buyer'}</h2>
            <span style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>{buyerId ? 'Saving re-matches this buyer against active inventory.' : 'Lands in Buyers and is matched against active dispo inventory right away.'}</span>
            <span style={{ flex: 1 }} />
            <button type="button" aria-label="Close" onClick={() => void requestClose()} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--meta, #71717a)', width: '28px', height: '28px', display: 'grid', placeItems: 'center' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          {seed ? (
            <p role="status" style={{ margin: '10px 0 0', padding: '8px 10px', borderRadius: '8px', background: 'var(--c-genius-soft, #f0faf5)', border: '1px solid var(--c-action-line, #a7dcc5)', fontSize: '12.5px', color: 'var(--ink, #18181b)' }}>
              {buyerId ? 'The empty parts of this buy box are filled from the call.' : 'Filled from the call.'} Check each field, then save. Nothing is saved until you do.
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--divider, #e4e4e7)', marginTop: '10px', overflowX: 'auto' }}>
            {tabs.map((t) => (
              <button key={t} onClick={() => setTab(t)} style={{ height: '36px', padding: '0 10px', border: 0, borderBottom: `2px solid ${tab === t ? 'var(--ink, #18181b)' : 'transparent'}`, background: 'none', fontSize: '13px', fontWeight: tab === t ? 600 : 500, color: tab === t ? 'var(--ink, #18181b)' : 'var(--meta, #71717a)', cursor: 'pointer', marginBottom: '-1px', whiteSpace: 'nowrap' }}>{t}</button>
            ))}
          </div>
        </div>
        <div style={{ padding: '16px 20px', overflow: 'auto', flex: 1 }}>
          {loading ? <p style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>Loading…</p> : null}
          {tab === 'Profile' && !buyerId ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
              <Text l="Buyer name *" v={f.name} on={(v) => set('name', v)} ph="Drew Collins" />
              <Text l="Company" v={f.company} on={(v) => set('company', v)} ph="Company" />
              <Select l="Type" v={f.buyer_type} on={(v) => set('buyer_type', v)} opts={BUYER_TYPES} />
              <Select l="Entity" v={f.entity_type} on={(v) => set('entity_type', v)} opts={ENTITY_TYPES} />
              <Text l="Phone *" v={f.phone} on={(v) => set('phone', v)} ph="(214) 555-0201" />
              <Text l="Email *" v={f.email} on={(v) => set('email', v)} ph="name@company.com" />
              {buyerId && !loading && buyerContactProblem(f) && (f.phone.trim() || f.email.trim())
                ? <p style={{ gridColumn: '1 / -1', margin: '-4px 0 0', fontSize: '12px', color: '#a16207' }}>{buyerContactProblem(f)} Saving still works.</p> : null}
              <Text l="Website" v={f.website} on={(v) => set('website', v)} ph="https://" />
              <Text l="Tags (comma-separated)" v={f.tags} on={(v) => set('tags', v)} ph="cash, repeat" />
              <div style={{ gridColumn: '1 / -1' }}><label style={label}>Notes</label><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} style={area} /></div>
            </div>
          ) : null}
          {tab === 'Buy box' ? (
            <div style={{ display: 'grid', gap: '16px' }}>
              <Locations prefs={f.box.location_prefs} on={(p) => setBox({ location_prefs: p })} />
              <Chips l="Strategy type *" opts={STRATEGIES} v={f.box.strategies} on={(v) => setBox({ strategies: v })} />
              <Chips l="Desired property type *" opts={PROPERTY_TYPES} v={f.box.property_types} on={(v) => setBox({ property_types: v })} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
                <Range key={`price${loading}`} l="Purchase price range" r={f.box.price} on={(r) => setBox({ price: r })} prefix="$" report={report('price')} />
                <Range key={`sqft${loading}`} l="Living area square footage" r={f.box.sqft} on={(r) => setBox({ sqft: r })} report={report('sqft')} />
                <Range key={`year${loading}`} l="Year built range" r={f.box.year_built} on={(r) => setBox({ year_built: r })} phMin="1900" report={report('year')} />
                <Range key={`lot${loading}`} l="Lot size (sqft)" r={f.box.lot_sqft} on={(r) => setBox({ lot_sqft: r })} report={report('lot')} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
                <Seg l="Bedroom preference" v={f.box.beds.min ?? null} steps={[1, 2, 3, 4, 5]} on={(n) => setBox({ beds: { min: n } })} />
                <Seg l="Bathroom preference" v={f.box.baths.min ?? null} steps={[1, 1.5, 2, 3, 4]} on={(n) => setBox({ baths: { min: n } })} />
              </div>
              <Chips l="Restricted rehab levels · buyer does not want" opts={REHAB_LEVELS} v={f.box.rehab.avoided} on={(v) => setBox({ rehab: { avoided: v } })} tone="red" />
              <Chips l="Restricted specialty rehabs · buyer does not want" opts={SPECIALTY_REHABS} v={f.box.specialty_avoid} on={(v) => setBox({ specialty_avoid: v })} tone="red" />
            </div>
          ) : null}
          {tab === 'Economics' ? (
            <div style={{ display: 'grid', gap: '16px' }}>
              <Chips l="Funding" opts={FUNDING} v={f.box.economics.funding ?? []} on={(v) => setEcon({ funding: v })} />
              <Chips l="Purchase methods they accept" opts={PURCHASE_METHODS} v={f.box.purchase_methods} on={(v) => setBox({ purchase_methods: v })} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                <Num key={`maxofarv${loading}`} l="Max % of ARV" v={f.box.economics.max_arv_pct} on={(n) => setEcon({ max_arv_pct: n })} suffix="%" report={report('maxofarv')} />
                <Num key={`mindiscountfroma${loading}`} l="Min discount from ask" v={f.box.economics.min_discount_pct} on={(n) => setEcon({ min_discount_pct: n })} suffix="%" report={report('mindiscountfroma')} />
                <Num key={`targetroi${loading}`} l="Target ROI" v={f.box.economics.target_roi_pct} on={(n) => setEcon({ target_roi_pct: n })} suffix="%" report={report('targetroi')} />
                <Num key={`mincaprate${loading}`} l="Min cap rate" v={f.box.economics.min_cap_rate} on={(n) => setEcon({ min_cap_rate: n })} suffix="%" report={report('mincaprate')} />
                <Num key={`mincashflowmo${loading}`} l="Min cash flow / mo" v={f.box.economics.min_cashflow} on={(n) => setEcon({ min_cashflow: n })} prefix="$" report={report('mincashflowmo')} />
                <Num key={`minrentmo${loading}`} l="Min rent / mo" v={f.box.economics.min_rent} on={(n) => setEcon({ min_rent: n })} prefix="$" report={report('minrentmo')} />
                <Num key={`typicalemd${loading}`} l="Typical EMD" v={f.box.economics.emd_typical} on={(n) => setEcon({ emd_typical: n })} prefix="$" report={report('typicalemd')} />
                <Num key={`closeindays${loading}`} l="Close in (days)" v={f.box.economics.close_days} on={(n) => setEcon({ close_days: n })} report={report('closeindays')} />
                <Num key={`inspectiondays${loading}`} l="Inspection (days)" v={f.box.economics.inspection_days} on={(n) => setEcon({ inspection_days: n })} report={report('inspectiondays')} />
                <Num key={`maxrehabbudget${loading}`} l="Max rehab budget" v={f.box.economics.max_rehab_budget} on={(n) => setEcon({ max_rehab_budget: n })} prefix="$" report={report('maxrehabbudget')} />
                <Select l="Max rehab level" v={f.box.economics.max_rehab_level ?? ''} on={(v) => setEcon({ max_rehab_level: v || null })} opts={[['', 'Any'], ...REHAB_LEVELS]} />
                <Num key={`mingaragestalls${loading}`} l="Min garage stalls" v={f.box.economics.min_garages} on={(n) => setEcon({ min_garages: n })} report={report('mingaragestalls')} />
                <Num key={`timelinetobuyday${loading}`} l="Timeline to buy (days)" v={f.box.timeline_days} on={(n) => setBox({ timeline_days: n })} report={report('timelinetobuyday')} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
                {buyerId ? null : <Text l="Proof of funds (link)" v={f.pof_url} on={(v) => set('pof_url', v)} ph="https://" />}
                {buyerId ? null : <Toggle l="POF verified" v={f.pof_verified} on={(v) => set('pof_verified', v)} />}
              </div>
            </div>
          ) : null}
          {tab === 'Advanced' ? (
            <div style={{ display: 'grid', gap: '16px' }}>
              <Chips l="Strict criteria · a miss is a hard no instead of a lower score" opts={STRICT_OPTIONS} v={f.box.strict} on={(v) => setBox({ strict: v })} tone="amber" />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
                <div style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', padding: '12px', display: 'grid', gap: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>Property restrictions <span style={{ fontWeight: 400, color: 'var(--meta, #71717a)' }}>· buyer does not want</span></div>
                  <Chips l="Location characteristics" opts={LOCATION_CHIPS} v={f.box.restrictions} on={(v) => setBox({ restrictions: v })} tone="red" />
                  <Chips l="Property characteristics" opts={PROPERTY_CHIPS} v={f.box.restrictions} on={(v) => setBox({ restrictions: v })} tone="red" />
                </div>
                <div style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', padding: '12px', display: 'grid', gap: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>Property requirements <span style={{ fontWeight: 400, color: 'var(--meta, #71717a)' }}>· buyer must have</span></div>
                  <Chips l="Location characteristics" opts={LOCATION_CHIPS} v={f.box.requirements} on={(v) => setBox({ requirements: v })} tone="mint" />
                  <Chips l="Property characteristics" opts={PROPERTY_CHIPS} v={f.box.requirements} on={(v) => setBox({ requirements: v })} tone="mint" />
                </div>
              </div>
              <div><label style={label}>Buy box notes</label><textarea value={f.box.notes ?? ''} onChange={(e) => setBox({ notes: e.target.value })} style={area} placeholder="Anything the matcher can't encode: HOA max, no corner lots, prefers brick…" /></div>
            </div>
          ) : null}
          {tab === 'Contact' ? (
            <div style={{ display: 'grid', gap: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
                <Select l="Preferred channel" v={f.preferred_channel} on={(v) => set('preferred_channel', v)} opts={CHANNELS} />
                <div style={{ display: 'grid', gap: '8px', alignContent: 'end' }}>
                  <Toggle l="Wants calls" v={f.wants_calls} on={(v) => set('wants_calls', v)} />
                  <Toggle l="Wants follow-ups" v={f.wants_follow_ups} on={(v) => set('wants_follow_ups', v)} />
                  <Toggle l="Wants sold alerts" v={f.wants_sold_alerts} on={(v) => set('wants_sold_alerts', v)} />
                </div>
              </div>
              <div style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', padding: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
                {buyerId ? null : <Toggle l="Active buyer" hint="Off = paused: never matched or sent deals" v={f.active} on={(v) => set('active', v)} />}
                {buyerId ? (
                  <label style={{ display: 'grid', gap: '4px', fontSize: '12.5px' }}>
                    <span>Inactive until <span style={{ color: 'var(--meta, #71717a)' }}>· optional, for the &ldquo;active again&rdquo; automation</span></span>
                    <input type="date" value={activeAgain} onChange={(e) => { setDirty(true); setActiveAgain(e.target.value); }} style={{ height: '30px', borderRadius: '7px', border: '1px solid var(--divider, #e4e4e7)', padding: '0 8px', fontSize: '12.5px' }} />
                  </label>
                ) : null}
                {buyerId ? null : (
                  <>
                    <Toggle l="Vetted" hint="Talked to them; POF or track record confirmed" v={f.vetted} on={(v) => set('vetted', v)} />
                    <Toggle l="VIP" hint="Gets the 24-hour head start on blasts" v={f.vip} on={(v) => set('vip', v)} />
                    <Toggle l="Blacklist" hint="Never matched, never sent deals" v={f.blacklisted} on={(v) => set('blacklisted', v)} red />
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 20px', borderTop: '1px solid var(--divider, #e4e4e7)', background: 'var(--canvas, #fafafa)' }}>
          <span style={{ fontSize: '12px', color: err || badCount ? 'var(--tx-red, #b91c1c)' : 'var(--meta, #71717a)', flex: 1 }}>{err ?? (badCount ? 'Fix the highlighted numbers first.' : !missing ? '' : !f.name.trim() ? 'Name, phone and email are required.' : contactProblem)}</span>
          <button type="button" onClick={() => void requestClose()} disabled={busy} style={btn(false)}>Cancel</button>
          <button type="button" onClick={submit} disabled={busy || missing || badCount > 0} style={btn(true, busy || missing || badCount > 0)}>{busy ? 'Saving…' : buyerId ? 'Save buy box' : 'Create buyer'}</button>
        </div>
      </div>
    </div>
  );
}

// ---- controls ---------------------------------------------------------------

function Text({ l, v, on, ph }: { l: string; v: string; on: (v: string) => void; ph?: string }) {
  return <div><label style={label}>{l}</label><input value={v} onChange={(e) => on(e.target.value)} placeholder={ph} style={field} /></div>;
}
function Select({ l, v, on, opts }: { l: string; v: string; on: (v: string) => void; opts: Opt }) {
  return <div><label style={label}>{l}</label><select value={v} onChange={(e) => on(e.target.value)} style={field}>{opts.map(([c, t]) => <option key={c} value={c}>{t}</option>)}</select></div>;
}
/**
 * A number typed as text: the draft is kept as typed ("1." and "250k" stay on
 * screen), and the value only moves when it reads. Money (a `$` prefix) reads
 * through lib/money, so "250k" is 250,000 and "abc" is an error, never 0.
 */
function readNum(raw: string, money: boolean): { value: number | null; error?: string } {
  if (money) return parseDollars(raw);
  const t = raw.trim().replace(/,/g, '');
  if (!t) return { value: null };
  return /^\d+(?:\.\d*)?$|^\.\d+$/.test(t) ? { value: Number(t) } : { value: null, error: 'Enter a number' };
}
function useNumDraft(v: number | null | undefined, money: boolean, on: (n: number | null) => void, report: (bad: boolean) => void) {
  const shownFor = (n: number | null | undefined) => (n == null ? '' : money ? n.toLocaleString('en-US') : String(n));
  const [text, setText] = useState(() => shownFor(v));
  const [error, setError] = useState<string | null>(null);
  const change = (raw: string) => {
    setText(raw);
    const r = readNum(raw, money);
    setError(r.error ?? null);
    report(!!r.error);
    if (!r.error) on(r.value);
  };
  return { text, error, change };
}
function Num({ l, v, on, prefix, suffix, report = () => {} }: { l: string; v?: number | null; on: (n: number | null) => void; prefix?: string; suffix?: string; report?: (bad: boolean) => void }) {
  const id = useId();
  const d = useNumDraft(v, prefix === '$', on, report);
  return (
    <div><label htmlFor={id} style={label}>{l}</label>
      <div style={{ position: 'relative' }}>
        {prefix ? <span style={{ position: 'absolute', left: '10px', top: '9px', fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>{prefix}</span> : null}
        <input id={id} inputMode="decimal" value={d.text} aria-invalid={d.error ? true : undefined} onChange={(e) => d.change(e.target.value)} style={{ ...field, paddingLeft: prefix ? '22px' : '10px', paddingRight: suffix ? '26px' : '10px', ...(d.error ? { borderColor: '#dc2626' } : {}) }} />
        {suffix ? <span style={{ position: 'absolute', right: '10px', top: '9px', fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>{suffix}</span> : null}
      </div>
      {d.error ? <div role="alert" style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '4px' }}>{d.error}</div> : null}
    </div>
  );
}
function Range({ l, r, on, prefix, phMin, report = () => {} }: { l: string; r: { min?: number | null; max?: number | null }; on: (r: { min: number | null; max: number | null }) => void; prefix?: string; phMin?: string; report?: (bad: boolean) => void }) {
  const money = prefix === '$';
  const [bad, setBad] = useState({ min: false, max: false });
  const flag = (k: 'min' | 'max') => (b: boolean) => {
    const next = { ...bad, [k]: b };
    setBad(next);
    report(next.min || next.max);
  };
  const lo = useNumDraft(r.min, money, (n) => on({ min: n, max: r.max ?? null }), flag('min'));
  const hi = useNumDraft(r.max, money, (n) => on({ min: r.min ?? null, max: n }), flag('max'));
  const inverted = r.min != null && r.max != null && r.min > r.max;
  const error = lo.error || hi.error || (inverted ? 'The low end is above the high end' : null);
  return (
    <div><label style={label}>{l}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input inputMode="decimal" aria-label={`${l}, low`} value={lo.text} placeholder={phMin ?? (prefix ? '$0' : '0')} onChange={(e) => lo.change(e.target.value)} style={{ ...field, ...(lo.error ? { borderColor: '#dc2626' } : {}) }} />
        <span style={{ color: 'var(--subtle, #a1a1aa)' }}>–</span>
        <input inputMode="decimal" aria-label={`${l}, high`} value={hi.text} placeholder="No max" onChange={(e) => hi.change(e.target.value)} style={{ ...field, ...(hi.error ? { borderColor: '#dc2626' } : {}) }} />
      </div>
      {error ? <div role="alert" style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '4px' }}>{error}</div> : null}
    </div>
  );
}
function Seg({ l, v, steps, on }: { l: string; v: number | null; steps: number[]; on: (n: number | null) => void }) {
  const pill = (on_: boolean): React.CSSProperties => ({ height: '30px', padding: '0 12px', borderRadius: '8px', border: `1px solid ${on_ ? MINT : 'var(--divider, #e4e4e7)'}`, background: on_ ? MINT : 'var(--surface, #fff)', color: on_ ? 'var(--surface, #fff)' : 'var(--muted, #52525b)', fontSize: '12.5px', cursor: 'pointer' });
  return (
    <div><label style={label}>{l}</label>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => on(null)} style={pill(v == null)}>Any</button>
        {steps.map((n) => <button key={n} type="button" onClick={() => on(n)} style={pill(v === n)}>{n}+</button>)}
      </div>
    </div>
  );
}
function Chips({ l, opts, v, on, tone = 'mint' }: { l: string; opts: Opt; v: string[]; on: (v: string[]) => void; tone?: 'mint' | 'red' | 'amber' }) {
  const onColor = tone === 'red' ? { bg: 'var(--negative-soft, #fee2e2)', fg: '#991b1b', bd: 'var(--tint-red-2, #fecaca)' } : tone === 'amber' ? { bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e', bd: 'var(--tint-amber-2, #fde68a)' } : { bg: 'var(--positive-soft, #dcfce7)', fg: MINT, bd: 'var(--tint-green-3, #bbf7d0)' };
  return (
    <div><label style={label}>{l}</label>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {opts.map(([c, t]) => {
          const on_ = v.includes(c);
          return <button key={c} type="button" onClick={() => on(on_ ? v.filter((x) => x !== c) : [...v, c])} style={{ height: '28px', padding: '0 11px', borderRadius: '999px', border: `1px solid ${on_ ? onColor.bd : 'var(--divider, #e4e4e7)'}`, background: on_ ? onColor.bg : 'var(--surface, #fff)', color: on_ ? onColor.fg : 'var(--muted, #52525b)', fontSize: '12px', cursor: 'pointer', fontWeight: on_ ? 600 : 400 }}>{t}</button>;
        })}
      </div>
    </div>
  );
}
function Toggle({ l, hint, v, on, red }: { l: string; hint?: string; v: boolean; on: (v: boolean) => void; red?: boolean }) {
  return (
    <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '13px' }}>
      <button type="button" role="switch" aria-checked={v} onClick={() => on(!v)} style={{ flex: 'none', width: '36px', height: '20px', borderRadius: '999px', border: 0, background: v ? (red ? '#dc2626' : MINT) : '#d4d4d8', position: 'relative', cursor: 'pointer', marginTop: '1px' }}>
        <span style={{ position: 'absolute', top: '2px', left: v ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '50%', background: 'var(--surface, #fff)', transition: 'left .15s' }} />
      </button>
      <span><span style={{ fontWeight: 600 }}>{l}</span>{hint ? <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>{hint}</span> : null}</span>
    </label>
  );
}
function Locations({ prefs, on }: { prefs: LocationPref[]; on: (p: LocationPref[]) => void }) {
  // Picked, never typed: cities and counties come from the Census lists in
  // lib/us-cities, states from STATE_NAMES, and a ZIP must place in a state.
  const [kind, setKind] = useState<LocationType>('city');
  const [st, setSt] = useState('TX');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const listId = useId();
  const hits = kind === 'city' || kind === 'county' ? searchPlaces(kind === 'county' ? countiesIn(st) : citiesIn(st), q, 8) : [];
  const hiC = Math.min(hi, hits.length - 1);
  const zip = q.replace(/\D/g, '').slice(0, 5);
  const zipSt = zip.length === 5 ? stateOfZip(zip) : null;
  const zipOk = !!zipSt && STATES.includes(zipSt);
  const reset = () => { setQ(''); setHi(0); setNote(null); };
  const push = (entry: LocationPref) => {
    const dup = prefs.some((p) => p.type === entry.type && p.name.toLowerCase() === entry.name.toLowerCase() && (!p.state || !entry.state || p.state === entry.state));
    if (dup) return setNote(`${entry.type === 'state' ? STATE_NAMES[entry.name] : entry.name} is already on the list.`);
    on([...prefs, entry]); reset();
  };
  const pick = (p: GeoPlace) => push({ name: p.name, type: kind, state: st, restricted: false });
  const addZip = () => { if (zipOk) push({ name: zip, type: 'zip', state: zipSt!, restricted: false }); };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(Math.min(hiC + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hiC - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (open && hits[hiC]) pick(hits[hiC]); }
    else if (e.key === 'Escape') setOpen(false);
  };
  return (
    <div>
      <label style={label}>Location preferences * · city, county, whole state or ZIP</label>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <select aria-label="Location type" value={kind} onChange={(e) => { setKind(e.target.value as LocationType); reset(); }} style={{ ...field, width: 'auto' }}><option value="city">City</option><option value="county">County</option><option value="state">Whole state</option><option value="zip">ZIP</option></select>
        {kind !== 'zip' ? <select aria-label="State" value={st} onChange={(e) => { setSt(e.target.value); reset(); }} style={{ ...field, width: 'auto', maxWidth: '100%' }}>{STATES.map((x) => <option key={x} value={x}>{STATE_NAMES[x]}</option>)}</select> : null}
        {kind === 'city' || kind === 'county' ? (
          <div style={{ position: 'relative', flex: 1, minWidth: '180px' }}>
            <input
              role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && hits[hiC] ? `${listId}-${hiC}` : undefined}
              value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); setNote(null); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey}
              placeholder={`Search ${kind === 'county' ? 'counties' : 'cities'} in ${STATE_NAMES[st]}…`} style={field}
            />
            {open ? (
              <div id={listId} role="listbox" style={{ position: 'absolute', top: '38px', left: 0, right: 0, zIndex: 5, background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', boxShadow: '0 12px 30px -10px rgba(18,22,45,.25)', maxHeight: '260px', overflowY: 'auto', padding: '4px' }}>
                {hits.length ? hits.map((p, i) => (
                  <div key={p.name} id={`${listId}-${i}`} role="option" aria-selected={i === hiC} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} onMouseEnter={() => setHi(i)} style={{ padding: '7px 8px', borderRadius: '7px', fontSize: '13px', cursor: 'pointer', background: i === hiC ? 'var(--surface-2, #f4f4f5)' : 'transparent' }}>
                    {p.name} <span style={{ color: 'var(--subtle, #a1a1aa)', fontSize: '12px' }}>· {formatPop(p.pop)}</span>
                  </div>
                )) : <div style={{ padding: '7px 8px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>{kind === 'city' ? `No city of 5,000+ in ${STATE_NAMES[st]} matches. Smaller towns: add their county.` : `No county in ${STATE_NAMES[st]} matches.`}</div>}
              </div>
            ) : null}
          </div>
        ) : null}
        {kind === 'state' ? <button type="button" onClick={() => push({ name: st, type: 'state', restricted: false })} style={btn(false)}>+ Add {STATE_NAMES[st]}</button> : null}
        {kind === 'zip' ? (
          <>
            <input aria-label="ZIP code" inputMode="numeric" maxLength={5} value={zip} onChange={(e) => { setQ(e.target.value); setNote(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addZip(); } }} placeholder="75001" style={{ ...field, width: '110px' }} />
            <button type="button" onClick={addZip} disabled={!zipOk} style={btn(false, !zipOk)}>+ Add{zipOk ? ` · ${STATE_NAMES[zipSt!]}` : ''}</button>
          </>
        ) : null}
      </div>
      {note || (kind === 'zip' && zip.length === 5 && !zipOk) ? <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--tx-amber, #b45309)' }}>{note ?? `${zip} is not a ZIP in the 50 states or DC.`}</p> : null}
      {prefs.length ? (
        <div style={{ marginTop: '8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 40px', gap: '8px', padding: '6px 10px', fontSize: '11.5px', color: 'var(--meta, #71717a)', background: 'var(--canvas, #fafafa)' }}><span>Name</span><span style={{ color: 'var(--tx-hot, #dc2626)' }}>Restricted</span><span>Type</span><span /></div>
          {prefs.map((p, i) => (
            <div key={`${p.type}-${p.name}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 40px', gap: '8px', alignItems: 'center', padding: '6px 10px', borderTop: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px' }}>
              <span>{p.type === 'state' ? STATE_NAMES[p.name] ?? p.name : p.name}{p.state && p.type !== 'state' ? <span style={{ color: 'var(--meta, #71717a)' }}> ({p.state})</span> : null}</span>
              <Toggle l="" v={!!p.restricted} on={(v) => on(prefs.map((x, j) => (j === i ? { ...x, restricted: v } : x)))} red />
              <span style={{ color: 'var(--meta, #71717a)', textTransform: 'capitalize' }}>{p.type}</span>
              <button type="button" onClick={() => on(prefs.filter((_, j) => j !== i))} aria-label="Remove this location" title="Remove" style={{ border: 0, background: 'none', color: 'var(--meta, #71717a)', cursor: 'pointer', width: '24px', height: '24px', display: 'grid', placeItems: 'center' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
            </div>
          ))}
          <div style={{ padding: '6px 10px', borderTop: '1px solid var(--divider-2, #f0f0f1)', textAlign: 'right' }}><button type="button" onClick={() => on([])} style={{ border: 0, background: 'none', color: 'var(--tx-hot, #dc2626)', fontSize: '11.5px', cursor: 'pointer' }}>Remove all locations</button></div>
        </div>
      ) : <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--tx-amber, #b45309)' }}>Without a location this buyer only matches on price and type.</p>}
    </div>
  );
}
