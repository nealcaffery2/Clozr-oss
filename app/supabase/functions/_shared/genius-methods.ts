/**
 * Genius discovery methods, the rules with no I/O.
 *
 * A Genius run finds owners who bought near a house. This file is the second
 * layer: every buyer the run keeps is labelled with the METHOD that found
 * them and the EVIDENCE behind the label, so the dispo rep reads "Homefull:
 * flipped 4412 Oak St, photos confirm a renovation, resold +31%" instead of a
 * bare name. The methods:
 *
 *   genius            bought nearby, from the records (the base run)
 *   homefull          a completed flip nearby whose listing photos a vision
 *                     model confirms was renovated: the flipper, never the
 *                     retail buyer who lives there now
 *   reverse_llc       an entity that bought for cash and owns several houses
 *   wholesale_snipe   a deed chain that double closed (A→B and B→C within
 *                     days, B marked up): B is the wholesaler, C the end buyer
 *   landlord          an absentee owner who rents what they bought
 *   wholesaler_buyers the buyers a known wholesaler (and its LLC aliases)
 *                     has sold to, from the deed index and from our own
 *                     assignment contracts
 *   dealmachine       Deal Machine's captures (the Chrome extension or the
 *                     cloud runner)
 *   buyr / facebook   Buyr's older finds and Facebook comment captures
 *   contract          named on a contract in the Dispositions Drive
 *
 * genius-discover runs the I/O (RealEstateAPI, the deed portals, the vision
 * check) and hands the answers here; app/tools/genius-methods.test.ts runs
 * this with `npx tsx`.
 */
import { type Any, type Candidate, type Hit, type Purchase, addressKey, daysBetween, isEntity, isNonBuyer, miles, ownerFrom, ownerKey } from './genius-core.ts';

const str = (v: unknown) => (v == null ? '' : String(v).trim());

export type Method = 'genius' | 'homefull' | 'reverse_llc' | 'wholesale_snipe' | 'landlord' | 'wholesaler_buyers' | 'dealmachine' | 'buyr' | 'facebook' | 'contract';

/** The methods a run can ask for, in the order the filter bar shows them. */
export const RUN_METHODS: Method[] = ['homefull', 'reverse_llc', 'wholesale_snipe', 'landlord', 'wholesaler_buyers'];

export const METHOD_LABEL: Record<Method, string> = {
  genius: 'Genius', homefull: 'Homefull', reverse_llc: 'Reverse LLC', wholesale_snipe: 'Wholesale snipe', landlord: 'Landlord',
  wholesaler_buyers: 'Wholesaler buyers', dealmachine: 'Deal Machine', buyr: 'Buyr', facebook: 'Facebook', contract: 'Contract',
};

export const METHOD_BLURB: Record<Method, string> = {
  genius: 'Bought near this house, from the county records.',
  homefull: 'Flipped a house nearby and the listing photos confirm a renovation. The flipper, never the retail buyer.',
  reverse_llc: 'An LLC that paid cash and owns several houses around here.',
  wholesale_snipe: 'Bought from a wholesaler: the deed chain double closed within days and the wholesaler marked it up.',
  landlord: 'Owns rentals nearby: absentee, and the house went up for rent after they bought it.',
  wholesaler_buyers: 'Who the wholesalers in this market sell to, from their deeds and our own assignment contracts.',
  dealmachine: 'Captured by Deal Machine.',
  buyr: 'Found by Buyr.',
  facebook: 'Left a comment on a Facebook deal post.',
  contract: 'Named on an assignment in the Dispositions Drive.',
};

export const METHOD_TAG: Record<Method, string> = {
  genius: 'genius', homefull: 'genius-homefull', reverse_llc: 'genius-reverse-llc', wholesale_snipe: 'genius-wholesale-snipe', landlord: 'genius-landlord',
  wholesaler_buyers: 'genius-wholesaler-buyers', dealmachine: 'deal-machine', buyr: 'buyr', facebook: 'fb-comment', contract: 'contract-buyer',
};

export const isMethod = (v: unknown): v is Method => typeof v === 'string' && v in METHOD_LABEL;

/** Request body → the run methods asked for, unknown ones dropped, each once. */
export function parseMethods(v: unknown): Method[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: Method[] = [];
  for (const x of list) { const m = str(x); if (isMethod(m) && RUN_METHODS.includes(m) && !out.includes(m)) out.push(m); }
  return out;
}

/** One piece of proof on a buyer: which method, what it saw, and the fields a card can show. */
export type Evidence = {
  method: Method;
  summary: string;
  detail?: Record<string, unknown>;
  /** 0 to 1: how sure the method is. A vision verdict carries the model's confidence; a deed chain is 1. */
  confidence?: number;
};

export type Labelled = Candidate & { method?: Method; methods?: Method[]; evidence?: Evidence[] };

/** Put a method and its proof on a candidate (keeps earlier proof; the first method stays the headline). */
export function label(c: Labelled, e: Evidence): Labelled {
  const methods = [...(c.methods ?? (c.method ? [c.method] : []))];
  if (!methods.includes(e.method)) methods.push(e.method);
  const evidence = [...(c.evidence ?? [])];
  if (!evidence.some((x) => x.method === e.method && x.summary === e.summary)) evidence.push(e);
  return { ...c, method: c.method ?? e.method, methods, evidence };
}

/** The headline for a buyer row: the strongest method's label and its summary. */
export function headline(c: Labelled): { method: Method; label: string; summary: string } | null {
  const order: Method[] = ['wholesale_snipe', 'homefull', 'wholesaler_buyers', 'reverse_llc', 'landlord', 'contract', 'dealmachine', 'facebook', 'buyr', 'genius'];
  const ev = c.evidence ?? [];
  for (const m of order) { const e = ev.find((x) => x.method === m); if (e) return { method: m, label: METHOD_LABEL[m], summary: e.summary }; }
  if (c.method) return { method: c.method, label: METHOD_LABEL[c.method], summary: METHOD_BLURB[c.method] };
  return null;
}

// ---- reverse LLC ------------------------------------------------------------------------------

/**
 * An entity that bought for cash and owns more than one house. The base run
 * already knows the portfolio and the financing; this reads them off and
 * writes the proof. min_portfolio 2 keeps the one-house LLC out.
 */
export function reverseLlc(cands: Labelled[], opts: { min_portfolio?: number } = {}): Labelled[] {
  const min = Math.max(1, opts.min_portfolio ?? 2);
  return cands.map((c) => {
    if (!c.corporate || c.institutional) return c;
    const owned = Math.max(c.portfolio_count ?? 0, c.purchase_count);
    const cash = c.cash === true || c.purchases.some((p) => p.financed === false);
    if (owned < min || !cash) return c;
    const last = c.purchases[0];
    return label(c, {
      method: 'reverse_llc',
      summary: `${c.owner_name} paid cash and owns ${owned} propert${owned === 1 ? 'y' : 'ies'}${last ? `, last ${last.address} ${last.date ? `(${last.date.slice(0, 7)})` : ''}`.trimEnd() : ''}.`,
      detail: { owned, cash: true, nearby: c.purchase_count, portfolio_value: c.portfolio_value },
      confidence: 1,
    });
  });
}

// ---- landlord -------------------------------------------------------------------------------------

/**
 * Absentee owners whose houses went up for rent after they bought them (the
 * MLS history says so), or who hold several and never resold. A rental
 * listing after the purchase is the proof; a plain absentee hold is a weaker
 * one and says so.
 */
export function landlords(cands: Labelled[], hits: Map<string, Hit>): Labelled[] {
  return cands.map((c) => {
    if (c.institutional || c.kind !== 'landlord') return c;
    const rented = c.purchases.filter((p) => p.role === 'hold' && hits.get(p.reapi_id)?.rented_after_purchase);
    const holds = c.purchases.filter((p) => p.role === 'hold');
    if (rented.length) {
      return label(c, {
        method: 'landlord',
        summary: `Rents ${rented.length === 1 ? rented[0].address : `${rented.length} houses`} nearby (listed for rent after buying)${c.portfolio_count ? `, owns ${c.portfolio_count}` : ''}.`,
        detail: { rented: rented.map((p) => p.address), holds: holds.length, portfolio: c.portfolio_count }, confidence: 0.9,
      });
    }
    if (c.absentee && holds.length >= 2) {
      return label(c, {
        method: 'landlord',
        summary: `Absentee owner holding ${holds.length} houses nearby${c.portfolio_count ? `, owns ${c.portfolio_count}` : ''}.`,
        detail: { holds: holds.length, portfolio: c.portfolio_count }, confidence: 0.6,
      });
    }
    return c;
  });
}

// ---- Homefull: the photo check ----------------------------------------------------------------

/** A flip to verify: the flipper's purchase, the house, and where its listing photos are. */
export type HomefullTarget = { key: string; reapi_id: string; address: string; city: string; state: string; zip: string; zillow: string; resale_date: string | null; resale_price: number | null; price: number | null; days_held: number | null };

/** The completed flips worth a photo check, best buyers first, at most `max` (each is a model call). */
export function homefullTargets(cands: Labelled[], max = 25): HomefullTarget[] {
  const out: HomefullTarget[] = [];
  const seen = new Set<string>();
  for (const c of [...cands].sort((a, b) => b.likelihood - a.likelihood)) {
    if (c.institutional) continue;
    for (const p of c.purchases) {
      if (p.role !== 'flip' || !p.resale_date || !p.reapi_id || seen.has(p.reapi_id)) continue;
      seen.add(p.reapi_id);
      out.push({ key: c.key, reapi_id: p.reapi_id, address: p.address, city: p.city, state: p.state, zip: p.zip, zillow: p.zillow, resale_date: p.resale_date, resale_price: p.resale_price, price: p.price, days_held: p.days_held });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** What the vision check says about one house's listing photos. */
export type RenovationVerdict = { renovated: boolean | null; confidence: number; signals: string[]; photos: number; source: string | null };

/**
 * Fold the verdicts back: a confirmed renovation labels the flipper Homefull
 * (and lifts them); a flip the photos say was NOT renovated loses the label
 * and a little likelihood (a wholetail or a relist, not a renovator). No
 * photos or no verdict changes nothing.
 */
export function applyHomefull(cands: Labelled[], verdicts: Map<string, RenovationVerdict>, targets: HomefullTarget[]): Labelled[] {
  const byKey = new Map<string, HomefullTarget[]>();
  for (const t of targets) { const l = byKey.get(t.key) ?? []; l.push(t); byKey.set(t.key, l); }
  return cands.map((c) => {
    const ts = byKey.get(c.key) ?? [];
    let out = c;
    let confirmed = 0; let denied = 0;
    for (const t of ts) {
      const v = verdicts.get(t.reapi_id);
      if (!v || v.renovated === null) continue;
      const margin = t.price && t.resale_price ? Math.round((t.resale_price / t.price - 1) * 100) : null;
      if (v.renovated) {
        confirmed++;
        out = label(out, {
          method: 'homefull',
          summary: `Flipped ${t.address}: photos confirm a renovation (${v.signals.slice(0, 3).join(', ') || 'updated finishes'})${margin !== null ? `, resold ${margin >= 0 ? '+' : ''}${margin}%` : ''}${t.days_held ? ` in ${t.days_held} days` : ''}.`,
          detail: { reapi_id: t.reapi_id, address: t.address, resale_date: t.resale_date, margin, days_held: t.days_held, signals: v.signals, photos: v.photos, source: v.source },
          confidence: v.confidence,
        });
      } else denied++;
    }
    if (confirmed) return { ...out, likelihood: Math.min(100, out.likelihood + 10), reasons: [...out.reasons, 'Renovation confirmed from photos'] };
    if (denied && !confirmed) return { ...out, likelihood: Math.max(0, out.likelihood - 8), reasons: [...out.reasons, 'Resold without a visible renovation'] };
    return out;
  });
}

// ---- wholesale snipe: the deed chain ----------------------------------------------------------

export type SaleRow = { date: string | null; price: number | null; buyer: string | null; seller: string | null; doc_type: string | null; arms_length: boolean | null };

/** PropertyDetail.saleHistory (or a county chain) as plain rows, newest first. */
export function saleRows(history: Any): SaleRow[] {
  const list: Any[] = Array.isArray(history) ? history : [];
  const iso = (v: unknown) => { const s = str(v); const m = /^(\d{4}-\d{2}-\d{2})/.exec(s); if (m) return m[1]; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
  const name = (v: Any): string | null => { const o = ownerFrom(v); return o?.name ?? null; };
  return list.map((s) => ({
    date: iso(s?.saleDate ?? s?.recordingDate ?? s?.date),
    price: Number(s?.saleAmount ?? s?.price ?? s?.sale_price) > 0 ? Number(s?.saleAmount ?? s?.price ?? s?.sale_price) : null,
    buyer: name(s?.buyerNames ?? s?.buyer ?? s?.grantee ?? s?.grantee_name),
    seller: name(s?.sellerNames ?? s?.seller ?? s?.grantor ?? s?.grantor_name),
    doc_type: str(s?.documentType ?? s?.docType ?? s?.doc_type ?? s?.deedType) || null,
    arms_length: typeof s?.armsLength === 'boolean' ? s.armsLength : typeof s?.arms_length === 'boolean' ? s.arms_length : null,
  })).filter((r) => r.date).sort((a, b) => str(b.date).localeCompare(str(a.date)));
}

export type DoubleClose = {
  wholesaler: string; end_buyer: string; seller: string | null;
  a_date: string; b_date: string; gap_days: number;
  a_price: number | null; b_price: number | null; spread: number | null; spread_pct: number | null;
  kind: 'double_close' | 'assignment';
};

/**
 * Two deeds on one house within `maxGapDays` where the buyer on the first is
 * the seller on the second: B bought from A and sold to C. That is a
 * wholesaler double close when B marked the price up (or Texas hid both
 * prices). A deed whose type says "assignment" is the other shape of the
 * same trade. The end buyer C is who the dispo rep wants.
 */
export function detectDoubleClose(rows: SaleRow[], maxGapDays = 45): DoubleClose | null {
  const list = saleRowsSorted(rows);
  for (let i = 0; i < list.length - 1; i++) {
    const later = list[i]; const earlier = list[i + 1];
    if (!later.date || !earlier.date || !later.buyer || !earlier.buyer) continue;
    const gap = daysBetween(earlier.date, later.date);
    if (gap === null || gap < 0 || gap > maxGapDays) continue;
    const bKey = ownerKey(earlier.buyer, isEntity(earlier.buyer));
    const sKey = later.seller ? ownerKey(later.seller, isEntity(later.seller)) : null;
    // The chain has to link: B is the seller on the second deed (or the deed left the seller blank).
    if (sKey && sKey !== bKey) continue;
    if (ownerKey(later.buyer, isEntity(later.buyer)) === bKey) continue;
    if (isNonBuyer(later.buyer) || isNonBuyer(earlier.buyer)) continue;
    const spread = earlier.price && later.price ? later.price - earlier.price : null;
    const pct = spread !== null && earlier.price ? Math.round((spread / earlier.price) * 100) : null;
    // A markup inside a few weeks is the trade; a loss or a wash with prices on record is a relist or a correction.
    if (spread !== null && spread <= 0) continue;
    const assignment = /assign/i.test(str(later.doc_type) + ' ' + str(earlier.doc_type));
    return {
      wholesaler: earlier.buyer, end_buyer: later.buyer, seller: earlier.seller,
      a_date: earlier.date, b_date: later.date, gap_days: gap,
      a_price: earlier.price, b_price: later.price, spread, spread_pct: pct,
      kind: assignment ? 'assignment' : 'double_close',
    };
  }
  return null;
}

const saleRowsSorted = (rows: SaleRow[]) => [...rows].sort((a, b) => str(b.date).localeCompare(str(a.date)));

/** The deed chains a snipe pass should read: the top buyers' purchases that are not yet enriched, or any sale with a prior owner inside the gap. */
export function snipeTargets(cands: Labelled[], hits: Map<string, Hit>, max = 60): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...cands].sort((a, b) => b.likelihood - a.likelihood)) {
    for (const p of c.purchases) {
      if (!p.reapi_id || p.reapi_id.startsWith('attom:') || seen.has(p.reapi_id)) continue;
      const h = hits.get(p.reapi_id);
      // A prior owner who held under two months is a double close until the chain says otherwise.
      const quick = h?.prior_owner_months !== null && h?.prior_owner_months !== undefined && h.prior_owner_months <= 2;
      if (!h || quick || !h.enriched) { seen.add(p.reapi_id); out.push(p.reapi_id); }
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** The buyer a double close made: C as a candidate of their own, labelled, with the house as their purchase. */
export function snipedBuyer(dc: DoubleClose, p: Purchase, base: Labelled | null): Labelled {
  const owner = ownerFrom(dc.end_buyer);
  const name = owner?.name ?? dc.end_buyer;
  const entity = owner?.entity ?? isEntity(name);
  const key = ownerKey(name, entity);
  const c: Labelled = base ?? {
    key, owner_name: name, people: owner?.people ?? [], kind: 'flipper', corporate: entity, institutional: false,
    absentee: null, mailing: null, mail_parts: null,
    purchases: [], purchase_count: 0, flips: 0, holds: 0, builds: 0, last_purchase: null, nearest_mi: null, lat: null, lng: null,
    avg_price: null, min_price: null, max_price: null, avg_ppsf: null, avg_days_held: null, cash: true, non_disclosure: !dc.b_price,
    portfolio_count: null, portfolio_value: null, likelihood: 0, smart_match: false, smart_rank: null, pct_of_arv: null, reasons: [],
    matched_buyer_id: null, match_by: null, contacts: null, contacts_at: null,
  };
  const purchase: Purchase = { ...p, role: 'hold', price: dc.b_price ?? p.price, date: dc.b_date, resale_price: null, resale_date: null, days_held: null, financed: false };
  const have = c.purchases.some((x) => x.reapi_id === purchase.reapi_id);
  const purchases = have ? c.purchases : [purchase, ...c.purchases];
  const spread = dc.spread !== null ? ` (wholesaler made $${Math.round(dc.spread).toLocaleString('en-US')}${dc.spread_pct !== null ? `, ${dc.spread_pct}%` : ''})` : '';
  return label({
    ...c, purchases, purchase_count: purchases.length, holds: purchases.filter((x) => x.role === 'hold').length,
    last_purchase: c.last_purchase ?? dc.b_date, nearest_mi: c.nearest_mi ?? p.distance_mi, lat: c.lat ?? p.lat, lng: c.lng ?? p.lng,
    cash: true, likelihood: Math.max(c.likelihood, 55), reasons: [...c.reasons, 'Bought from a wholesaler'],
  }, {
    method: 'wholesale_snipe',
    summary: `Bought ${p.address} from ${dc.wholesaler} ${dc.gap_days === 0 ? 'the same day' : `${dc.gap_days} day${dc.gap_days === 1 ? '' : 's'} after`} the wholesaler closed${spread}.`,
    detail: { wholesaler: dc.wholesaler, seller: dc.seller, a_date: dc.a_date, b_date: dc.b_date, a_price: dc.a_price, b_price: dc.b_price, spread: dc.spread, kind: dc.kind, reapi_id: p.reapi_id },
    confidence: 1,
  });
}

// ---- wholesaler buyers: the deed index ------------------------------------------------------------

export type DeedTransaction = {
  grantor: string; grantee: string; address: string | null; county: string; state: string;
  date: string | null; price: number | null; doc_type: string | null; instrument: string | null; source_url: string;
};

/** publicsearch.us (GovOS) search JSON → transactions. Grantor defaults to the name searched when the parties block is thin. */
export function parsePublicSearch(json: Any, searched: string, county: string, state: string, base: string): DeedTransaction[] {
  const hits: Any[] = Array.isArray(json?.hits) ? json.hits : Array.isArray(json?.results) ? json.results : Array.isArray(json?.data) ? json.data : [];
  const out: DeedTransaction[] = [];
  for (const d of hits) {
    const parties: Any[] = Array.isArray(d?.parties) ? d.parties : [];
    const of = (t: string) => parties.filter((p) => str(p?.type ?? p?.partyType ?? p?.role).toUpperCase().startsWith(t)).map((p) => str(p?.name ?? p?.partyName)).filter(Boolean);
    const grantors = of('GRANTOR'); const grantees = of('GRANTEE');
    const grantor = grantors[0] ?? str(d?.grantor ?? d?.grantors?.[0]) ?? searched;
    for (const grantee of grantees.length ? grantees : [str(d?.grantee ?? d?.grantees?.[0])]) {
      if (!grantee) continue;
      const price = Number(d?.salePrice ?? d?.docAmount ?? d?.consideration);
      out.push({
        grantor: grantor || searched, grantee, address: str(d?.propertyAddress ?? d?.legalDescription ?? d?.legal) || null,
        county, state, date: str(d?.fileDate ?? d?.recordedDate ?? d?.recordDate).slice(0, 10) || null,
        price: Number.isFinite(price) && price > 0 ? price : null, doc_type: str(d?.docType ?? d?.documentType) || null,
        instrument: str(d?.instrumentNumber ?? d?.docNumber ?? d?.id) || null, source_url: `${base}/doc/${encodeURIComponent(str(d?.id ?? d?.docNumber ?? ''))}`,
      });
    }
  }
  return out;
}

/** True for the deeds that move title, not a lien, release, affidavit or plat. */
export const isConveyance = (docType: string | null | undefined) => {
  const t = str(docType).toLowerCase();
  if (!t) return true;
  if (/release|lien|affidavit|plat|easement|power of attorney|notice|lis pendens|assumed name|ucc|judgment|abstract/.test(t)) return false;
  return /deed|conveyance|assignment|contract/.test(t);
};

export type RankedBuyer = {
  name: string; key: string; entity: boolean; deals: number; last_date: string | null; volume: number | null;
  wholesalers: string[]; counties: string[]; nearest_mi: number | null; sample: DeedTransaction[];
};

/**
 * Who the wholesalers sell to, most often first. `aliasOf` maps every LLC
 * name to its family (Goldline Investments LLC → New Western), so a buyer who
 * bought from three of their shells counts three. Proximity, when the deed
 * carries an address we can place, orders ties.
 */
export function rankGrantees(txs: DeedTransaction[], opts: { aliasOf?: (name: string) => string; locate?: (address: string) => { lat: number; lng: number } | null; subject?: { lat: number; lng: number } | null; minDeals?: number } = {}): RankedBuyer[] {
  const fam = opts.aliasOf ?? ((n: string) => n);
  const groups = new Map<string, RankedBuyer>();
  for (const t of txs) {
    if (!t.grantee || !isConveyance(t.doc_type) || isNonBuyer(t.grantee)) continue;
    const owner = ownerFrom(t.grantee);
    if (!owner) continue;
    // The wholesaler shuffling title between its own shells is not a buyer.
    if (fam(owner.name) === fam(t.grantor) || ownerKey(owner.name, owner.entity) === ownerKey(t.grantor, isEntity(t.grantor))) continue;
    const key = ownerKey(owner.name, owner.entity);
    if (!key) continue;
    const g = groups.get(key) ?? { name: owner.name, key, entity: owner.entity, deals: 0, last_date: null, volume: null, wholesalers: [], counties: [], nearest_mi: null, sample: [] };
    g.deals++;
    if (t.date && (!g.last_date || t.date > g.last_date)) g.last_date = t.date;
    if (t.price) g.volume = (g.volume ?? 0) + t.price;
    const w = fam(t.grantor); if (!g.wholesalers.includes(w)) g.wholesalers.push(w);
    const cty = `${t.county}, ${t.state}`; if (!g.counties.includes(cty)) g.counties.push(cty);
    if (opts.locate && opts.subject && t.address) {
      const at = opts.locate(t.address);
      if (at) { const d = Number(miles(opts.subject, at).toFixed(2)); if (g.nearest_mi === null || d < g.nearest_mi) g.nearest_mi = d; }
    }
    if (g.sample.length < 5) g.sample.push(t);
    groups.set(key, g);
  }
  const min = Math.max(1, opts.minDeals ?? 1);
  return [...groups.values()].filter((g) => g.deals >= min).sort((a, b) =>
    b.deals - a.deals || str(b.last_date).localeCompare(str(a.last_date)) || (a.nearest_mi ?? 999) - (b.nearest_mi ?? 999));
}

/** A ranked grantee as a Genius candidate: the wholesaler's buyer, labelled with who sold to them and how often. */
export function granteeCandidate(g: RankedBuyer, base: Labelled | null, subject: { lat: number; lng: number }): Labelled {
  const key = g.key;
  const c: Labelled = base ?? {
    key, owner_name: g.name, people: g.entity ? [] : ownerFrom(g.name)?.people ?? [], kind: 'flipper', corporate: g.entity, institutional: false,
    absentee: null, mailing: null, mail_parts: null,
    purchases: [], purchase_count: 0, flips: 0, holds: 0, builds: 0, last_purchase: g.last_date, nearest_mi: g.nearest_mi, lat: null, lng: null,
    avg_price: g.volume && g.deals ? Math.round(g.volume / g.deals) : null, min_price: null, max_price: null, avg_ppsf: null, avg_days_held: null,
    cash: true, non_disclosure: !g.volume, portfolio_count: null, portfolio_value: null, likelihood: 0, smart_match: false, smart_rank: null, pct_of_arv: null, reasons: [],
    matched_buyer_id: null, match_by: null, contacts: null, contacts_at: null,
  };
  void subject;
  const who = g.wholesalers.length === 1 ? g.wholesalers[0] : `${g.wholesalers.length} wholesalers (${g.wholesalers.slice(0, 2).join(', ')})`;
  const lk = Math.min(100, 40 + Math.min(40, g.deals * 8) + (g.last_date && daysBetween(g.last_date, new Date().toISOString().slice(0, 10))! < 180 ? 10 : 0));
  return label({ ...c, likelihood: Math.max(c.likelihood, lk), cash: true, reasons: [...c.reasons, `Bought ${g.deals} deal${g.deals === 1 ? '' : 's'} from ${who}`] }, {
    method: 'wholesaler_buyers',
    summary: `Bought ${g.deals} deal${g.deals === 1 ? '' : 's'} from ${who}${g.last_date ? `, last ${g.last_date.slice(0, 7)}` : ''}${g.counties.length ? ` in ${g.counties.slice(0, 2).join('; ')}` : ''}.`,
    detail: { deals: g.deals, last_date: g.last_date, volume: g.volume, wholesalers: g.wholesalers, counties: g.counties, sample: g.sample.slice(0, 3) },
    confidence: 1,
  });
}

// ---- the wholesaler database ----------------------------------------------------------------------

/** "Acme Holdings, LLC", "ACME HOLDINGS LLC" and "Acme Holdings L.L.C." are one entity. */
export const entityKey = (name: string | null | undefined) => ownerKey(name, true);

/**
 * Brands that trade through many LLCs. A name that carries the brand, or a
 * shell on this list, rolls up to the family. Workspace rows (parent_id) add
 * to this; the list is the floor.
 */
export const WHOLESALER_FAMILIES: { family: string; match: RegExp }[] = [
  { family: 'New Western', match: /\bnew western\b|\bnw (?:acquisitions|investments)\b|\bgoldline investments\b|\bsoup to nuts\b|\bnwa (?:investments|holdings)\b/i },
  { family: 'HomeVestors', match: /\bhomevestors?\b|\bwe buy ugly houses\b/i },
  { family: 'Networth Realty', match: /\bnetworth\b/i },
  { family: 'Opendoor', match: /\bopendoor\b/i },
  { family: 'Offerpad', match: /\bofferpad\b/i },
  { family: 'Sundae', match: /\bsundae\b/i },
  { family: 'Fast Track Realty', match: /\bfast ?track (?:realty|investments)\b/i },
];

export function familyOf(name: string | null | undefined): string | null {
  const n = str(name);
  for (const f of WHOLESALER_FAMILIES) if (f.match.test(n)) return f.family;
  return null;
}

/** What one assignment PDF says, as the harvester stores it. */
export type ContractParties = {
  assignor: string | null; assignee: string | null; original_seller: string | null;
  assignor_person: string | null; assignee_person: string | null;
  assignor_email: string | null; assignee_email: string | null; assignor_phone: string | null; assignee_phone: string | null;
  property: string | null; purchase_price: number | null; assignment_fee: number | null; total_price: number | null;
  contract_date: string | null; closing_date: string | null; title_company: string | null;
  template: 'operator' | 'new_western' | 'other';
};

const moneyOf = (s: string | null | undefined): number | null => { const n = Number(str(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n >= 500 ? n : null; };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const dateOf = (s: string | null | undefined): string | null => {
  const t = str(s);
  let m = /(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/.exec(t);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[0];
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(t);
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
};
const SUFFIX = /\b(llc|l\.l\.c\.?|inc\.?|corp\.?|corporation|lp|llp|ltd\.?|pllc)\b/i;
const ENTITY_RE = /\b((?:[A-Za-z][A-Za-z0-9&'.-]*,?\s+){1,5})(llc|l\.l\.c\.?|inc\.?|corp\.?|corporation|lp|llp|ltd\.?|pllc)\b\.?/gi;
/** Words that mean the "entity" is a sentence fragment, not a company. */
const NOT_A_NAME = /\b(estate|agreement|assignment|contract|purchase|sale|page|document|assignor|assignee|buyer|seller|entity|company|the|of|and|for|between|dated|this|is|made|real|property|signature|title|abstract|escrow|associates|western|acme homes|form|clear)\b/i;
const SUFFIX_CASE: Record<string, string> = { llc: 'LLC', 'l.l.c': 'LLC', 'l.l.c.': 'LLC', inc: 'Inc', 'inc.': 'Inc', corp: 'Corp', 'corp.': 'Corp', corporation: 'Corporation', lp: 'LP', llp: 'LLP', ltd: 'Ltd', 'ltd.': 'Ltd', pllc: 'PLLC' };

/** "ACME HOLDINGS, LLC." / "rapid home buyers llc" / "NCNP, Inc." → "Acme Holdings LLC" / "Rapid Home Buyers LLC" / "NCNP Inc". */
export function entityDisplay(raw: string): string {
  const t = str(raw).replace(/[.,\s]+$/, '').replace(/\s+/g, ' ');
  const m = /^(.*?)[,\s]*\s(\S+)$/.exec(t);
  if (!m) return t;
  const body = m[1].replace(/,\s*$/, '').trim();
  const suffix = SUFFIX_CASE[m[2].toLowerCase()] ?? m[2];
  const allCaps = body === body.toUpperCase();
  const allLower = body === body.toLowerCase();
  // An acronym stays one: "NCNP Inc", not "Ncnp Inc".
  const acronym = allCaps && !/\s/.test(body) && body.length <= 5;
  const words = (allCaps || allLower) && !acronym ? body.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : body;
  return `${words} ${suffix}`.replace(/\s+/g, ' ').trim();
}

/** Company names in a block of contract text, in order of appearance, each once (by entityKey). */
export function entitiesIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ENTITY_RE)) {
    // Walk back from the suffix: keep the capitalised run right before it, stop at a fragment word.
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/,$/, ''));
    const keep: string[] = [];
    // One name is set in one case: "DISBURSEMENT AUTHORIZATION Rapid Home Buyers LLC" stops where the capitals start.
    const style = (w: string) => (w === w.toUpperCase() ? 'caps' : w === w.toLowerCase() ? 'lower' : 'title');
    const want = style(words[words.length - 1] ?? '');
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (!w || NOT_A_NAME.test(w) || !/^[A-Za-z0-9&'.-]+$/.test(w)) break;
      if (style(w) !== want && !/^(?:&|of|and|de|la)$/i.test(w) && !/^\d/.test(w)) break;
      keep.unshift(w);
    }
    if (!keep.length) continue;
    const name = entityDisplay(`${keep.join(' ')} ${m[2]}`);
    if (NOT_A_NAME.test(name.replace(SUFFIX, '')) && !/holdings|investments|capital|homes|buyers|properties|group/i.test(name)) continue;
    const k = entityKey(name);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(name);
  }
  return out;
}

const cap = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const personLine = (line: string): string | null => {
  const t = line.trim().replace(/\s+(COO|CEO|CFO|Owner|Manager|Member|Managing Member|President|MGR|as MGR|Dispo|dispo)$/i, '').trim();
  if (!/^[A-Za-z][A-Za-z'.-]+(?:\s+[A-Za-z][A-Za-z'.-]+){1,2}$/.test(t)) return null;
  if (SUFFIX.test(t) || NOT_A_NAME.test(t) || /^(?:Clear Form|Document Ref|Signed with)/i.test(t)) return null;
  return cap(t);
};

/**
 * The parties off an assignment's text, by rule, for the two templates the
 * Drive holds (Acme Homes' own, and New Western's) and a fair guess at any
 * other. Claude reads the PDF for the real pass (dispo-contracts); this is
 * the fallback when the key is missing, and the test of what a parse must
 * carry. Where it reads from:
 *   - the parties: the signature block at the end, where each form prints
 *     the two entities in a fixed order (Acme Homes: assignor then assignee;
 *     New Western: assignee then assignor)
 *   - the people: the line under each entity in that block, or PandaDoc's
 *     signer list (name, EMAIL, PHONE)
 *   - the money: labelled blanks (New Western) or the row of filled blanks
 *     Acme Homes' form prints after page one (price, fee, deposit, total)
 */
export function parseAssignmentText(text: string): ContractParties {
  const t = text.replace(/\\_/g, '_').replace(/_{2,}/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  const lines = t.split('\n').map((l) => l.trim());
  const nw = /New Western/i.test(t);
  const hp = /Acme Homes 100 Commerce|Assignor \(Wholesaler\)|Assignee \(Buyer\)|Assignor \(Seller\)/i.test(t);
  const out: ContractParties = {
    assignor: null, assignee: null, original_seller: null, assignor_person: null, assignee_person: null,
    assignor_email: null, assignee_email: null, assignor_phone: null, assignee_phone: null,
    property: null, purchase_price: null, assignment_fee: null, total_price: null, contract_date: null, closing_date: null, title_company: null,
    template: hp ? 'operator' : nw ? 'new_western' : 'other',
  };

  // The parties, from the signature block.
  const sigAt = Math.max(t.lastIndexOf('IN WITNESS WHEREOF'), t.lastIndexOf('SIGNATURES'), t.lastIndexOf('Signatures on next page'));
  const sig = sigAt >= 0 ? t.slice(sigAt) : t.slice(-3000);
  const sigEntities = entitiesIn(sig);
  const all = entitiesIn(t);
  const ordered = sigEntities.length >= 2 ? sigEntities : all;
  const [first, second] = ordered;
  if (nw) { out.assignee = first ?? null; out.assignor = second ?? null; }
  else { out.assignor = first ?? null; out.assignee = second ?? null; }
  // Acme Homes' AB form names the counterparty "Assignor (Wholesaler)"; when the block order put Acme Homes there, swap.
  const ours = (n: string | null) => !!n && /acme holdings|acme homes/i.test(n);
  if (/Assignor \(Wholesaler\)/i.test(t) && ours(out.assignor) && !ours(out.assignee)) { const a = out.assignor; out.assignor = out.assignee; out.assignee = a; }
  if (/Assignor \(Seller\)/i.test(t) && ours(out.assignee) && !ours(out.assignor)) { const a = out.assignor; out.assignor = out.assignee; out.assignee = a; }

  // The person under each entity in the signature block.
  const sigLines = sig.split('\n').map((l) => l.trim()).filter(Boolean);
  const personUnder = (entity: string | null): string | null => {
    if (!entity) return null;
    const k = entityKey(entity);
    for (let i = 0; i < sigLines.length; i++) {
      if (!entitiesIn(sigLines[i]).some((e) => entityKey(e) === k)) continue;
      for (let j = i + 1; j < Math.min(sigLines.length, i + 4); j++) { const p = personLine(sigLines[j]); if (p) return p; }
    }
    return null;
  };
  out.assignor_person = personUnder(out.assignor);
  out.assignee_person = personUnder(out.assignee);

  // PandaDoc's signer list: NAME / EMAIL x / PHONE y. Acme Homes' own signer is one side; the other signer is the counterparty.
  const signers = Array.from(t.matchAll(/\n([A-Z][A-Z .'-]{3,40})\n+EMAIL ([^\s]+@[^\s]+)\n+(?:PHONE (\+?\d[\d\s()-]{8,}))?/g)).map((m) => ({ name: cap(m[1].trim()), email: m[2].toLowerCase(), phone: m[3]?.replace(/\s+/g, '') ?? null }));
  const isOurs = (s: { email: string }) => /yourcompany\.com|acmehomes/i.test(s.email);
  const them = signers.find((s) => !isOurs(s)) ?? null;
  const us = signers.find(isOurs) ?? null;
  const weAssign = ours(out.assignor);
  const put = (side: 'assignor' | 'assignee', s: { name: string; email: string; phone: string | null }) => {
    if (side === 'assignor') { out.assignor_person = out.assignor_person ?? s.name; out.assignor_email = s.email; out.assignor_phone = s.phone; }
    else { out.assignee_person = out.assignee_person ?? s.name; out.assignee_email = s.email; out.assignee_phone = s.phone; }
  };
  if (them) put(weAssign ? 'assignee' : 'assignor', them);
  if (us) put(weAssign ? 'assignor' : 'assignee', us);

  // The property: the labelled line (New Western), else the first address line that is not Acme Homes' own office.
  const labelled = /(?:regarding the property located at:?)\s*([^\n]{6,120})/i.exec(t)?.[1];
  const addrLine = (l: string) => /^\d{2,6}[A-Za-z]?\s+[A-Za-z0-9]/.test(l) && /\b\d{5}(?:-\d{4})?\b/.test(l) && !/commerce way|suite 200|acme homes/i.test(l) && l.length < 110;
  const line = labelled ?? lines.find(addrLine) ?? null;
  out.property = line ? line.replace(/\s+/g, ' ').replace(/^(\d+[A-Za-z]?)\s*,\s*/, '$1 ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[.,\s]+$/, '').trim() : null;

  // Money: labelled blanks first.
  const grab = (re: RegExp) => moneyOf(re.exec(t)?.[1] ?? null);
  out.purchase_price = grab(/(?:Property Purchase Price\.?\s*\$\s?|for the amount of \$\s?|Purchase Price:?\s*\$\s?)([\d,]+(?:\.\d{2})?)/i);
  out.assignment_fee = grab(/(?:Assignment Fee\.?\s*\$\s?|assignment fee in the amount of \$\s?|Assignment Fee:?\s*\$\s?)([\d,]+(?:\.\d{2})?)/i);
  out.total_price = grab(/(?:Total (?:Purchase )?Price\.?\s*\$\s?|plus the Assignment Fee shall be \$\s?|equals \$\s?)([\d,]+(?:\.\d{2})?)/i);
  if (!out.purchase_price && !out.total_price) {
    // Acme Homes' form prints the filled blanks after page one: price, fee, deposit, total. Phone numbers and refs never carry a comma or cents.
    const row = Array.from(t.matchAll(/(?<![\d+$.])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{3,6}\.\d{2})(?![\d])/g)).map((m) => moneyOf(m[1])).filter((n): n is number => n !== null && n >= 1000);
    const big = Array.from(new Set(row)).sort((a, b) => b - a);
    if (big.length) {
      out.total_price = big[0];
      // A second figure near the total is the purchase price; a small one is the deposit, not a price.
      const price = big.find((n) => n < big[0] && n >= big[0] * 0.5) ?? null;
      out.purchase_price = price;
      if (price) out.assignment_fee = big[0] - price;
    }
  }
  if (out.total_price && out.purchase_price && !out.assignment_fee && out.total_price > out.purchase_price) out.assignment_fee = out.total_price - out.purchase_price;
  if (out.purchase_price && out.assignment_fee && !out.total_price) out.total_price = out.purchase_price + out.assignment_fee;

  // Dates.
  const closeAt = t.search(/Closing (?:Date|shall occur|is to take place)/i);
  const afterClose = closeAt >= 0 ? t.slice(closeAt, closeAt + 400) : '';
  out.closing_date = dateOf(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/.exec(afterClose)?.[1]) ?? dateOf(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i.exec(afterClose)?.[1]);
  out.contract_date = dateOf(/(?:Assignment dated|Agreement dated|is dated|entered into as of)\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i.exec(t)?.[1])
    ?? dateOf(lines.find((l) => /^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/.test(l)) ?? null);

  // The title company: a short line naming one, not a clause about title.
  const titleLine = lines.find((l) => l.length <= 70 && /\b(title|abstract|escrow)\b/i.test(l) && !/\b(shall|must|clear|marketable|insurable|company shall|agent|restriction|commitment|contingent|disclosure|interest|rights|hold|legal|owns|paragraph|following|chosen)\b/i.test(l) && !/^\d/.test(l) && !/\(/.test(l));
  out.title_company = titleLine ? titleLine.split(/\s+-\s+|\s+in\s+/i)[0].replace(/[.,\s]+$/, '').trim() : null;

  // The original seller: labelled (New Western), else the first person line after the property (Acme Homes' value row).
  const nwSeller = /with ([A-Z][A-Za-z ,'.\n-]{2,60}?) as seller/.exec(t)?.[1];
  if (nwSeller) out.original_seller = nwSeller.replace(/[,\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  else if (line) {
    const at = lines.indexOf(line);
    for (let j = at + 1; j < Math.min(lines.length, at + 6); j++) { const p = personLine(lines[j]); if (p && p !== out.assignor_person && p !== out.assignee_person) { out.original_seller = p; break; } }
  }
  return out;
}

/** Which leg of the daisy chain a Acme Homes contract is: AB when Acme Homes buys the contract, BC when it sells it on. */
export function legOf(p: ContractParties, ours = /acme holdings|acme homes/i): 'AB' | 'BC' | 'AA' | 'unknown' {
  const a = ours.test(str(p.assignor)); const b = ours.test(str(p.assignee));
  if (a && b) return 'AA';
  if (a) return 'BC';
  if (b) return 'AB';
  return 'unknown';
}

/** The address pieces a contract's property line gives: "1716 Ashby Pl, Oklahoma City, OK 73111-6230", or "109 N MILL LN NEW BRAUNFELS TX 78130". */
export function splitProperty(line: string | null | undefined): { address: string | null; city: string | null; state: string | null; zip: string | null } {
  const t = str(line).replace(/\s+/g, ' ');
  if (!t) return { address: null, city: null, state: null, zip: null };
  const abbr: Record<string, string> = { texas: 'TX', oklahoma: 'OK', florida: 'FL', georgia: 'GA', 'north carolina': 'NC', 'south carolina': 'SC', tennessee: 'TN', missouri: 'MO', indiana: 'IN', arkansas: 'AR', alabama: 'AL', ohio: 'OH', kentucky: 'KY', 'new york': 'NY', pennsylvania: 'PA', oregon: 'OR', arizona: 'AZ', colorado: 'CO' };
  const STATES = 'Texas|Oklahoma|Florida|Georgia|North Carolina|South Carolina|Tennessee|Missouri|Indiana|Arkansas|Alabama|Ohio|Kentucky|New York|Pennsylvania|Oregon|Arizona|Colorado';
  const st = (s: string) => (s.length === 2 ? s.toUpperCase() : abbr[s.toLowerCase()] ?? null);
  let m = new RegExp(`^(.+?),\\s*([A-Za-z .'-]+?),?\\s*([A-Za-z]{2}|${STATES})\\.?,?\\s*(\\d{5})(?:-\\d{4})?\\s*$`, 'i').exec(t);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: st(m[3]), zip: m[4] };
  // No commas: the street type ends the address.
  m = new RegExp(`^(\\d+[A-Za-z]?\\s+.+?\\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|pl|place|way|cir|circle|trl|trail|pkwy|loop|hwy|ter|terrace|cv|cove|bnd|bend|run|path|pass|xing)\\b\\.?(?:\\s+(?:apt|unit|#)\\s*\\S+)?)\\s+(.+?)\\s+([A-Za-z]{2}|${STATES}),?\\s+(\\d{5})(?:-\\d{4})?\\s*$`, 'i').exec(t);
  if (m) return { address: m[1].trim(), city: m[2].trim(), state: st(m[3]), zip: m[4] };
  const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(t)?.[1] ?? null;
  const state = /\b([A-Z]{2})\b,?\s*\d{5}/.exec(t)?.[1] ?? null;
  return { address: t.split(',')[0]?.trim() || null, city: t.split(',')[1]?.trim() || null, state, zip };
}

/** Same house: the street and the zip, however the two lines spelled the rest. */
export const sameHouse = (a: string | null | undefined, b: string | null | undefined) => {
  const A = splitProperty(a); const B = splitProperty(b);
  return !!A.address && !!B.address && addressKey(A.address) === addressKey(B.address) && (!A.zip || !B.zip || A.zip === B.zip);
};
