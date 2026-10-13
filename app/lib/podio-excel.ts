// Podio Excel exports (Partnerships › Submissions, Deals › Deal Stage, Deals ›
// Active Deals) → one CLOZR import plan. Pure: no IO, no Supabase, so the
// dry run, --apply and the assert check (tools/podio-excel.test.ts) share it.
//
// The whole job is dedupe:
//   partner   one vendor per submitting company. Keyed by the normalized entity
//             name (case, punctuation, LLC/Inc/Group, "- NC" regional suffixes,
//             "Real Estate"/"Off Market"/"Home Buyers" tails, reviewed ALIASES).
//             Phone and email only attribute rows that have no usable entity —
//             they never merge two named companies, because one person runs
//             several (James Phillips: Complete Homes + Ocean Trust). Pairs of
//             companies that share a phone/email are listed for review instead.
//   property  one per address_key (mirrors public.address_key, verified against
//             the database before --apply writes anything).
//   lead      one per partner + property. The same partner resubmitting an
//             address folds into its newest submission; several partners on one
//             address are separate leads on the same property, tagged.

import { clozrStage, sellerStageFor } from '../supabase/functions/_shared/podio-map';
// The keys (address, partner, phone, email, stage) live in _shared/podio-keys.ts so the live sync
// (podio-import `sync`) matches what this import wrote with the same code.
import {
  clean, one, thousands, num, day, money, multi, yes, phoneKey, phoneOut, emailKey, personKey, realPerson, parseAddress, addressKey, looseKey, DISPLAY, INSTITUTIONAL, BROKERAGE, cleanEntity, entityKey, submissionStage, FUNDS, fundsIn, type Address,
} from '../supabase/functions/_shared/podio-keys';
export {
  thousands, num, phoneKey, phoneOut, emailKey, personKey, STATES, parseAddress, normalizeAddress, addressKey, ALIASES, INSTITUTIONAL, cleanEntity, entityKey, NEW_SELLER_STAGES, submissionStage, FUNDS, fundsIn, type Address,
} from '../supabase/functions/_shared/podio-keys';

export type Row = Record<string, string | number>;
export type Sheets = { submissions: Row[]; dealStage: Row[]; activeDeals: Row[] };

// ---------------------------------------------------------------- stages

/** A Deals "Deal Stage" cell → CLOZR deal stage. */
export const dealStage = (v: unknown) => clozrStage(one(v)) ?? (/marketing/i.test(one(v)) ? 'Ready To Market' : null);

// ---------------------------------------------------------------- plan

export type Contact = { name: string | null; phone: string | null; email: string | null };
export type Partner = {
  key: string; source_id: string; business_name: string; service_type: string; markets: string[];
  contact_name: string | null; phone: string | null; email: string | null; notes: string;
  spellings: Record<string, number>; submissions: number; leads: number; resolvedByContact: number; fromDeals: boolean;
};
export type Party = {
  role: 'wholesaler' | 'seller' | 'dispositions' | 'acquisitions' | 'tc' | 'title' | 'listing_agent' | 'other';
  source_id: string; name: string | null; company: string | null; email: string | null; phone: string | null;
  partner?: string; fund?: string; /** a teammate: resolved to workspace_members by email/name at apply time */ team?: boolean;
};
export type PropertyPlan = { key: string; line1: string; city: string | null; state: string | null; zip: string | null;
  facts: { beds?: number; baths?: number; sqft?: number; year_built?: number; property_type?: string } };
export type DealPlan = Record<string, string | number | boolean | null>;
export type TcPlan = Record<string, string | number | null>;
export type Lead = {
  source_id: string; property: string; partner: string | null; name: string; lead_stage: string; podio_stage: string;
  /** A Deals row sets the stage through the deal trigger; a re-run must not write lead_stage back over it. */
  stage_from_deal: boolean; /** the stage the lead ends on (the deal's implied stage when a Deals row matched) */ final_stage: string; asking_price: number | null; motivation: string | null; notes: string; tags: string[];
  submitted_on: string | null; rows: number; underwriters: Contact[];
  deal: DealPlan; parties: Party[]; tc: TcPlan | null; dealMatch?: string;
};
export type Skip = { file: string; row: number; reason: string; detail: string };
export type Plan = {
  partners: Partner[]; funds: string[]; properties: PropertyPlan[]; leads: Lead[]; skipped: Skip[];
  review: {
    sharedContacts: { contact: string; partners: string[] }[];
    contactResolutions: { row: number; entity: string; by: string; partner: string }[];
    multiSource: { address: string; partners: string[] }[];
    foldedByPerson: { from: string; into: string; person: string }[];
    addressVariants: { from: string; into: string }[];
    dealLinks: { file: string; address: string; how: string; lead: string | null; stage: string | null }[];
    stageCounts: { podio: string; clozr: string; rows: number }[];
  };
};

const get = (r: Row, name: string) => r[name] ?? r[name.trim()] ?? Object.entries(r).find(([k]) => k.trim() === name.trim())?.[1];
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|me|comcast)\./;

function rowContacts(r: Row) {
  const phones = ['Phone - Mobile', 'Phone - Work', 'Phone - Home', 'Phone - Main', 'Phone - Other'].map((k) => phoneKey(get(r, k))).filter((x): x is string => !!x);
  const emails = ['Email - Work', 'Email - Home', 'Email - Other'].map((k) => emailKey(get(r, k))).filter((x): x is string => !!x);
  const person = [one(get(r, 'First Name')), one(get(r, 'Last Name'))].filter(Boolean).join(' ');
  return { phones: [...new Set(phones)], emails: [...new Set(emails)], person: realPerson(person) ? person : null };
}
const top = <T extends string>(xs: (T | null)[]) => {
  const c = new Map<T, number>();
  xs.forEach((x) => x && c.set(x, (c.get(x) ?? 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
};
const titleCase = (s: string) => s.replace(/\S+/g, (w) => (w === w.toUpperCase() && w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w));
const sub = (r: Row, k: string) => one(get(r, k));

export function buildPlan(sheets: Sheets): Plan {
  const skipped: Skip[] = [];
  const review: Plan['review'] = { sharedContacts: [], contactResolutions: [], multiSource: [], foldedByPerson: [], addressVariants: [], dealLinks: [], stageCounts: [] };

  // ---- 1. every submission row, parsed
  type S = { i: number; r: Row; addr: Address | null; key: string | null; ent: ReturnType<typeof cleanEntity>; ekey: string | null;
    c: ReturnType<typeof rowContacts>; created: string; partner: string | null };
  const rows: S[] = sheets.submissions.map((r, i) => {
    const addr = parseAddress(get(r, 'Property Address'));
    const ent = cleanEntity(get(r, 'Entity Name'));
    const c = rowContacts(r);
    if (ent.email && !c.emails.includes(ent.email)) c.emails.push(ent.email);
    return { i: i + 2, r, addr, key: addr ? addressKey(addr) : null, ent, ekey: entityKey(ent.name), c, created: sub(r, 'Created on'), partner: null };
  });
  const live = rows.filter((s) => {
    const test = s.ekey === 'test' || /\btest\b/i.test(`${one(get(s.r, 'Entity Name'))} ${one(get(s.r, 'First Name'))} ${one(get(s.r, 'Last Name'))}`)
      || /@yourcompany\.com\b/i.test(one(get(s.r, 'Email - Home')) + one(get(s.r, 'Email - Work')));
    if (test) skipped.push({ file: 'Submissions', row: s.i, reason: 'test submission', detail: one(get(s.r, 'Entity Name')) });
    else if (!s.key) skipped.push({ file: 'Submissions', row: s.i, reason: 'no street address (blank, county-only or portfolio)', detail: `${sub(s.r, 'Created on')} ${sub(s.r, 'Entity Name')} ${sub(s.r, 'Property Address')}`.trim() });
    return !test && !!s.key;
  });

  // ---- 2. partners from entity keys; fold person-name entities into the one company that person submits for
  const usesOf = (pick: (s: S) => string[]) => {
    const m = new Map<string, Map<string, number>>();
    for (const s of live) if (s.ekey) for (const v of pick(s)) {
      const inner = m.get(v) ?? new Map<string, number>(); inner.set(s.ekey, (inner.get(s.ekey) ?? 0) + 1); m.set(v, inner);
    }
    return m;
  };
  const byPerson = usesOf((s) => (s.c.person ? [personKey(s.c.person)] : []));
  const keys = new Set(live.map((s) => s.ekey).filter((k): k is string => !!k));
  const fold = new Map<string, string>();
  for (const k of keys) {
    const names = new Set<string>(live.filter((s) => s.ekey === k && s.c.person).map((s) => personKey(s.c.person)));
    const entName = live.find((s) => s.ekey === k)!.ent.name!;
    if (realPerson(entName)) names.add(personKey(entName));
    for (const n of names) {
      const compact = n.replace(/ /g, ''); const last = n.split(' ').pop();
      if (compact !== k && last !== k) continue;
      // Never into the person's own name ("Mirville" stays the company); a bare surname ("Mercer") only when nothing else fits.
      const others = [...(byPerson.get(n)?.keys() ?? [])].filter((x) => x !== k && x !== compact);
      const companies = others.filter((x) => x !== last);
      const into = companies.length === 1 ? companies[0] : others.length === 1 ? others[0] : null;
      if (into) { fold.set(k, into); review.foldedByPerson.push({ from: k, into, person: n }); break; }
    }
  }
  const folded = (k: string) => { for (let n = 0; fold.has(k) && n < 5; n++) k = fold.get(k)!; return k; };
  for (const s of live) if (s.ekey) s.partner = folded(s.ekey);

  // One property per house: "472 N Coral Dr Sarasota, FL 34234" and "472 N Coral Dr, Sarasota, FL" differ only by where
  // the city went. Keys sharing house number + street word + zip fold to the most used spelling.
  const byLoose = new Map<string, Map<string, S[]>>();
  for (const s of live) {
    const lk = looseKey(s.addr); if (!lk) continue;
    const m = byLoose.get(lk) ?? new Map<string, S[]>(); m.set(s.key!, [...(m.get(s.key!) ?? []), s]); byLoose.set(lk, m);
  }
  for (const m of byLoose.values()) if (m.size > 1) {
    const [canon, canonRows] = [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].length - b[0].length)[0];
    for (const [k, rs] of m) if (k !== canon) {
      review.addressVariants.push({ from: k, into: canon });
      rs.forEach((s) => { s.key = canon; s.addr = canonRows[0].addr; });
    }
  }

  // ---- 3. rows without a usable entity: phone → email → person → company email domain
  const partnerUses = (pick: (s: S) => string[]) => {
    const m = new Map<string, Map<string, number>>();
    for (const s of live) if (s.partner) for (const v of pick(s)) {
      const inner = m.get(v) ?? new Map<string, number>(); inner.set(s.partner, (inner.get(s.partner) ?? 0) + 1); m.set(v, inner);
    }
    return m;
  };
  const ph = partnerUses((s) => s.c.phones); const em = partnerUses((s) => s.c.emails);
  const pe = partnerUses((s) => (s.c.person ? [personKey(s.c.person)] : []));
  const named = new Set(live.map((s) => s.partner).filter((k): k is string => !!k));
  const best = (m: Map<string, number> | undefined) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null);
  for (const s of live.filter((x) => !x.partner)) {
    let by = ''; let p: string | null = null;
    for (const v of s.c.phones) if (!p && (p = best(ph.get(v)))) by = 'phone ' + v;
    for (const v of s.c.emails) if (!p && (p = best(em.get(v)))) by = 'email ' + v;
    if (!p && s.c.person) {
      const n = personKey(s.c.person); const users = [...(pe.get(n)?.keys() ?? [])];
      const own = folded(n.replace(/ /g, ''));
      p = named.has(own) ? own : users.length === 1 ? users[0] : null;
      if (p) by = 'contact name ' + s.c.person;
    }
    for (const e of s.c.emails) if (!p && !FREE_MAIL.test(e)) {
      const label = e.split('@')[1].split('.')[0];
      p = named.has(label) ? label : [...named].find((k) => k.length >= 5 && label.startsWith(k)) ?? null;
      if (p) by = 'email domain ' + e;
    }
    if (!p) {
      // "Offerpad Offerpad" / "Offerpad o" — a company typed into the name boxes, never a real person's first name.
      const raw = `${sub(s.r, 'First Name')} ${sub(s.r, 'Last Name')}`;
      const n = personKey(raw).split(' ')[0];
      if (n && !realPerson(raw) && named.has(n)) { p = n; by = 'company in the name field ' + raw.trim(); }
    }
    if (!p && (s.c.phones.length || s.c.emails.length || s.c.person)) {
      // A submitter we've never seen under a company name: their own partner, keyed by who they are.
      p = s.c.person ? personKey(s.c.person).replace(/ /g, '') : 'contact' + (s.c.phones[0] ?? s.c.emails[0]).replace(/[^a-z0-9]/gi, '');
      by = 'new partner from contact';
      named.add(p);
    }
    s.partner = p;
    // The same person on a later row goes to the same partner.
    if (p && s.c.person && !pe.has(personKey(s.c.person))) pe.set(personKey(s.c.person), new Map([[p, 1]]));
    review.contactResolutions.push({ row: s.i, entity: one(get(s.r, 'Entity Name')), by: by || 'unattributed', partner: p ?? '—' });
  }

  // ---- 4. partner records
  const partners = new Map<string, Partner>();
  const pRows = new Map<string, S[]>();
  for (const s of live) if (s.partner) pRows.set(s.partner, [...(pRows.get(s.partner) ?? []), s]);
  for (const [key, rs] of pRows) {
    const spellings: Record<string, number> = {};
    rs.forEach((s) => { const n = one(get(s.r, 'Entity Name')); if (n) spellings[n] = (spellings[n] ?? 0) + 1; });
    // Name from the rows that spell this company, not the person-name or contact-attributed rows folded into it.
    const longest = (xs: (string | null)[]) => top(xs).sort((x, y) => xs.filter((v) => v === y).length - xs.filter((v) => v === x).length || y.length - x.length);
    const names = [...longest(rs.filter((s) => s.ekey === key).map((s) => s.ent.name)), ...longest(rs.filter((s) => s.ekey).map((s) => s.ent.name))];
    const fallback = top(rs.map((s) => s.c.person))[0] ?? top(rs.flatMap((s) => s.c.emails))[0] ?? key;
    const markets = top(rs.flatMap((s) => [s.addr?.state ?? null, s.ent.market]));
    // A one-off name on a big partner ("the muffinman" on Offerpad) is not its contact.
    const often = <T extends string>(xs: T[]) => top(xs).filter((x) => rs.length <= 3 || xs.filter((y) => y === x).length >= 2);
    const people = often(rs.map((s) => s.c.person).filter((x): x is string => !!x && personKey(x).replace(/ /g, '') !== key));
    const phones = often(rs.flatMap((s) => s.c.phones)); const emails = often(rs.flatMap((s) => s.c.emails));
    const extra = [
      people.length > 1 ? 'Other contacts: ' + people.slice(1, 6).join(', ') : '',
      phones.length > 1 ? 'Other phones: ' + phones.slice(1, 6).map((p) => phoneOut(p)).join(', ') : '',
      emails.length > 1 ? 'Other emails: ' + emails.slice(1, 6).join(', ') : '',
      'Podio entity spellings: ' + Object.entries(spellings).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join('; '),
    ].filter(Boolean);
    partners.set(key, {
      key, source_id: 'partner:' + key, business_name: DISPLAY[key] ?? titleCase(names[0] ?? fallback),
      service_type: INSTITUTIONAL.has(key) ? 'Institutional seller' : BROKERAGE.has(key) ? 'Realtor' : 'Wholesaler',
      markets, contact_name: people[0] ?? null, phone: phoneOut(phones[0] ?? null), email: emails[0] ?? null,
      notes: ['Partner from Podio Partnerships › Submissions.', ...extra].join('\n'),
      spellings, submissions: rs.length, leads: 0, resolvedByContact: rs.filter((s) => !s.ekey).length, fromDeals: false,
    });
  }
  // Companies that share a phone or email — kept apart, listed for a person to decide.
  for (const [contact, m] of [...ph.entries(), ...em.entries()]) {
    const ps = [...new Set([...m.keys()].map((k) => k))];
    if (ps.length > 1) review.sharedContacts.push({ contact, partners: ps.map((k) => `${partners.get(k)?.business_name ?? k} (${m.get(k)})`) });
  }

  // ---- 5. properties and leads (partner + address, newest wins)
  const properties = new Map<string, PropertyPlan>();
  const groups = new Map<string, S[]>();
  for (const s of live) {
    const g = `${s.partner ?? '-'}#${s.key}`;
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const leads: Lead[] = [];
  const stageCount = new Map<string, number>();
  for (const rs of groups.values()) {
    rs.sort((a, b) => b.created.localeCompare(a.created) || b.i - a.i);
    const [s] = rs; const r = s.r; const a = s.addr!;
    const prop = properties.get(s.key!) ?? { key: s.key!, line1: titleCase(a.line1), city: a.city ? titleCase(a.city) : null, state: a.state, zip: a.zip, facts: {} };
    properties.set(s.key!, prop);
    // Facts: newest submission that has each one; implausible values (a year in Bedrooms) dropped.
    for (const x of rs) {
      const f = prop.facts; const n = (k: string) => num(get(x.r, k));
      const beds = n('Bedrooms'); const baths = n('Bathrooms'); const sqft = n('Square Footage'); const yr = n('Year Build');
      if (f.beds == null && beds != null && beds > 0 && beds <= 20) f.beds = beds;
      if (f.baths == null && baths != null && baths > 0 && baths <= 20) f.baths = baths;
      if (f.sqft == null && sqft != null && sqft >= 200 && sqft <= 50000) f.sqft = Math.round(sqft);
      if (f.year_built == null && yr != null && yr >= 1800 && yr <= 2027) f.year_built = Math.round(yr);
      const t = sub(x.r, 'Property Type');
      if (!f.property_type && t) f.property_type = /^(sfr|single|single family)$/i.test(t) ? 'Single Family' : /multi/i.test(t) ? 'Multi-Family' : titleCase(t);
    }

    const podioStage = sub(r, 'Stage');
    const stage = submissionStage(podioStage);
    if (!stage) { skipped.push({ file: 'Submissions', row: s.i, reason: 'unknown stage', detail: podioStage }); continue; }
    const sc = `${podioStage || '(blank)'}→${stage}`; stageCount.set(sc, (stageCount.get(sc) ?? 0) + 1);
    const partner = s.partner ? partners.get(s.partner)! : null;
    if (partner) partner.leads++;
    const dead = rs.some((x) => /dead/i.test(sub(x.r, 'Dead')));
    const underwriters = multi(get(r, 'Who is underwriting/dispo? - name')).map((name, k) => ({
      name, phone: null, email: emailKey(multi(get(r, 'Who is underwriting/dispo? - mail'))[k]) ?? multi(get(r, 'Who is underwriting/dispo? - mail'))[k]?.toLowerCase() ?? null,
    }));
    const offer = num(get(r, 'Offer Price - amount'));
    const comprLink = /https?:\/\/[^\s<>]*thecompr\.(?:com|ai)\/r\/[^\s<>]+/.exec(clean(get(r, 'Ai Compr Tool')))?.[0] ?? null;
    const analysis = /https?:\/\/\S+/.exec(clean(get(r, 'Analysis')))?.[0] ?? null;
    const funds = [...new Set(['Funds Sent To', 'Send Email/SMS to funds'].flatMap((k) => fundsIn(get(r, k))))];
    const person = s.c.person;
    const line = (label: string, v: unknown) => (one(v) ? `${label}: ${clean(v)}` : '');
    const notes = [
      `Podio submission · ${partner?.business_name ?? 'unknown submitter'} · submitted ${s.created.slice(0, 10)} (entered by ${sub(r, 'Created by') || '—'})`,
      [person, phoneOut(s.c.phones[0] ?? null), s.c.emails[0]].filter(Boolean).length ? 'Contact: ' + [person, phoneOut(s.c.phones[0] ?? null), s.c.emails[0]].filter(Boolean).join(' · ') : '',
      `Podio stage: ${podioStage || '(blank)'}`,
      [line('Asking', money(num(get(r, 'What price are you asking? (Your contract price including your fee) - amount')))), line('ARV', money(num(get(r, 'ARV in your opinion - amount')))),
        line('Rehab', money(num(get(r, 'Rehab in your opinion - amount')))), line('Closing needed', day(get(r, 'Closing Date Needed - start')))].filter(Boolean).join(' · '),
      [line('Disposition request', sub(r, 'Disposition Request') ? 'yes' : ''), line('Listed on MLS', get(r, 'Listed on MLS?')),
        line('Investorlift', get(r, 'Have you put the property on Investorlift?')), line('Property or portfolio', get(r, 'One Property or Portfolio?'))].filter(Boolean).join(' · '),
      [line('Occupied', get(r, 'Occupied?')), line('Lease', /^\.+$/.test(sub(r, 'If leased, MTM or when is lease end?')) ? '' : get(r, 'If leased, MTM or when is lease end?')),
        line('Lease amount', money(num(get(r, 'If leased, lease amount? - amount'))))].filter(Boolean).join(' · '),
      line('Garage', get(r, 'Garage Info')), line('Reason for selling', get(r, 'Reason for selling if you have it')), line('Location', get(r, 'Location')),
      line('Photos', get(r, 'Photos')), line('Purchase contract', get(r, 'Copy of purchase contract')), line('Data tape', get(r, 'If Portfolio, Please upload data tape or bulk info')),
      [line('Underwriting/dispo', underwriters.map((u) => u.name).join(', ')), line('Finished underwrite', get(r, 'Finished Underwrite')),
        line('Sent to Compr', sub(r, 'Send to Compr') ? 'yes' : ''), line('Pushed', sub(r, 'Push Deal') ? 'yes' : '')].filter(Boolean).join(' · '),
      line('Underwrite decline reason', get(r, 'Underwrite Decline Reason')),
      [line('UW low offer', money(num(get(r, 'UW Suggested Low Offer - amount')))), line('UW high offer', money(num(get(r, 'UW Suggested High Offer - amount')))),
        line('Offer price', money(offer)), line('EMD', money(num(get(r, 'EMD - amount')))),
        line('Suggested dispo price', offer != null ? money(num(get(r, 'Suggested Dispo price'))) : '')].filter(Boolean).join(' · '),
      line('Compr', comprLink ?? (/failed/i.test(sub(r, 'Ai Compr Tool')) ? '' : get(r, 'Ai Compr Tool'))), line('Analysis', get(r, 'Analysis')),
      line('Comps', ['Comp 1', 'Comp 2', 'Comp 3'].map((k) => sub(r, k)).filter(Boolean).join(' , ')),
      line('Funds sent to', funds.join(', ')), line('Funds to email/SMS', get(r, 'Send Email/SMS to funds')), line('Fund notes', get(r, 'Fund Notes')),
      dead ? 'Marked dead in Podio' : '',
      line('Submission notes', get(r, 'Notes')),
      ...rs.slice(1).map((x) => `Earlier submission ${x.created.slice(0, 10)} (stage ${sub(x.r, 'Stage') || 'blank'}, asking ${money(num(get(x.r, 'What price are you asking? (Your contract price including your fee) - amount'))) || '—'}, offer ${money(num(get(x.r, 'Offer Price - amount'))) || '—'})${one(get(x.r, 'Notes')) && one(get(x.r, 'Notes')) !== one(get(r, 'Notes')) ? ': ' + clean(get(x.r, 'Notes')) : ''}`),
    ].filter(Boolean).join('\n');

    const buyerMatch = clean(get(r, 'Ai Buyer Match'));
    const deal: DealPlan = {
      stage: 'Prospect', offer_amount: offer, arv: thousands(num(get(r, 'ARV in your opinion - amount'))) || null, rehab: thousands(num(get(r, 'Rehab in your opinion - amount')), 200),
      mao: num(get(r, 'UW Suggested High Offer - amount')), earnest_money: num(get(r, 'EMD - amount')),
      underwriting_url: comprLink ?? analysis, occupancy_notes: sub(r, 'Occupied?') || null, market: a.state,
      notes: [line('UW low offer', money(num(get(r, 'UW Suggested Low Offer - amount')))), line('Suggested dispo price', offer != null ? money(num(get(r, 'Suggested Dispo price'))) : ''),
        comprLink && analysis ? line('Analysis', analysis) : '', line('Funds sent to', funds.join(', ')), line('Fund notes', get(r, 'Fund Notes')),
        buyerMatch ? 'AI buyer match: ' + (buyerMatch.length > 1500 ? buyerMatch.slice(0, 1500) + '…' : buyerMatch) : ''].filter(Boolean).join('\n') || null,
    };
    const parties: Party[] = [];
    if (partner) parties.push({ role: 'wholesaler', source_id: partner.source_id, partner: partner.key, name: person ?? partner.contact_name, company: partner.business_name,
      email: s.c.emails[0] ?? partner.email, phone: phoneOut(s.c.phones[0] ?? null) ?? partner.phone });
    for (const u of underwriters) parties.push({ role: 'dispositions', source_id: 'team:' + (u.email ?? personKey(u.name)), name: u.name, company: null, email: u.email, phone: null, team: true });
    for (const f of funds) parties.push({ role: 'other', source_id: 'fund:' + f.toLowerCase(), fund: f, name: f, company: 'Fund — deal sent to', email: null, phone: null });

    leads.push({
      source_id: `submission:${s.key}|${s.partner ?? "-"}|${rs[rs.length - 1].created}`, property: s.key!, partner: partner?.key ?? null,
      name: person ?? partner?.business_name ?? 'Unknown submitter', lead_stage: stage, podio_stage: podioStage, stage_from_deal: false, final_stage: stage,
      asking_price: thousands(num(get(r, 'What price are you asking? (Your contract price including your fee) - amount'))), motivation: sub(r, 'Reason for selling if you have it') || null,
      notes, tags: ['Podio submission', ...(partner ? [partner.business_name] : []), ...(dead ? ['Dead'] : [])],
      submitted_on: s.created.slice(0, 10) || null, rows: rs.length, underwriters, deal, parties, tc: null,
    });
    if (rs.length > 1) for (const x of rs.slice(1)) skipped.push({ file: 'Submissions', row: x.i, reason: 'resubmission folded into newest (same partner + address)', detail: `${sub(x.r, 'Property Address')} · ${partner?.business_name ?? '—'}` });
  }
  review.stageCounts = [...stageCount.entries()].map(([k, rows]) => ({ podio: k.split('→')[0], clozr: k.split('→')[1], rows })).sort((a, b) => b.rows - a.rows);

  // Several partners on one address: separate leads, each tagged and told about the others.
  const byProp = new Map<string, Lead[]>();
  leads.forEach((l) => byProp.set(l.property, [...(byProp.get(l.property) ?? []), l]));
  for (const [key, ls] of byProp) if (ls.length > 1) {
    for (const l of ls) {
      l.tags.push('Multiple sources');
      l.notes += '\nAlso submitted by: ' + ls.filter((o) => o !== l).map((o) => `${o.partner ? partners.get(o.partner)!.business_name : o.name} (${o.submitted_on})`).join(', ');
    }
    review.multiSource.push({ address: `${properties.get(key)!.line1}, ${properties.get(key)!.city ?? ''} ${properties.get(key)!.zip ?? ''}`.trim(), partners: ls.map((l) => (l.partner ? partners.get(l.partner)!.business_name : l.name)) });
  }

  // ---- 6. Deals files: merge Deal Stage + Active Deals by address, attach to the submission's lead
  const loose = new Map<string, string>();
  for (const p of properties.values()) { const k = looseKey(p); if (k) loose.set(k, p.key); }
  const findProp = (raw: unknown) => {
    const a = parseAddress(raw); const k = a && addressKey(a);
    if (k && properties.has(k)) return { key: k, how: 'address' };
    const lk = looseKey(a); if (lk && loose.has(lk)) return { key: loose.get(lk)!, how: 'house number + street + zip' };
    return null;
  };
  const resolvePartner = (raw: unknown): Partner | null => {
    const e = cleanEntity(raw); const k0 = entityKey(e.name); if (!k0) return null;
    const k = fold.get(k0) ?? k0;
    if (!partners.has(k)) partners.set(k, { key: k, source_id: 'partner:' + k, business_name: DISPLAY[k] ?? titleCase(e.name!), markets: e.market ? [e.market] : [],
      service_type: INSTITUTIONAL.has(k) ? 'Institutional seller' : 'Wholesaler', contact_name: null, phone: null, email: null,
      notes: 'Partner from Podio Deals (no submission under this name).', spellings: { [one(raw)]: 1 }, submissions: 0, leads: 0, resolvedByContact: 0, fromDeals: true });
    return partners.get(k)!;
  };

  type D = { file: string; i: number; r: Row; addr: string };
  const dealRows = new Map<string, D[]>();
  const push = (file: string, list: Row[]) => list.forEach((r, i) => {
    const addr = one(get(r, 'Property Address'));
    if (!addr && !one(get(r, 'Deal Stage'))) return;
    const a = parseAddress(addr); const k = a ? addressKey(a) : null;
    if (!k) { skipped.push({ file, row: i + 2, reason: 'no property address', detail: one(get(r, 'Deal Stage')) }); return; }
    dealRows.set(k, [...(dealRows.get(k) ?? []), { file, i: i + 2, r, addr }]);
  });
  push('Deal Stage', sheets.dealStage); push('Active Deals', sheets.activeDeals);

  for (const [key, ds] of dealRows) {
    const ds1 = ds.find((d) => d.file === 'Deal Stage'); const act = ds.find((d) => d.file === 'Active Deals');
    const primary = act ?? ds1!;
    const stageRaw = one(get(primary.r, 'Deal Stage')) || one(get(ds1?.r ?? {}, 'Deal Stage'));
    const stage = dealStage(stageRaw);
    const wholesaler = ds1 ? resolvePartner(get(ds1.r, 'Wholesaler')) : null;

    const hit = findProp(primary.addr) ?? (ds1 ? findProp(get(ds1.r, 'Which submission')) : null);
    let lead: Lead | undefined; let how = 'no submission found — new lead';
    if (hit) {
      const ls = byProp.get(hit.key) ?? [];
      lead = (wholesaler && ls.find((l) => l.partner === wholesaler.key)) || [...ls].sort((x, y) => (y.submitted_on ?? '').localeCompare(x.submitted_on ?? ''))[0];
      how = `${hit.how}${wholesaler && lead?.partner === wholesaler.key ? ' + wholesaler' : ls.length > 1 ? ' (newest of ' + ls.length + ' sources)' : ''}`;
    }
    if (!lead) {
      const a = parseAddress(primary.addr)!;
      if (!properties.has(key)) properties.set(key, { key, line1: titleCase(a.line1), city: a.city ? titleCase(a.city) : null, state: a.state, zip: a.zip, facts: {} });
      const seller = act ? one(get(act.r, 'Seller')) : '';
      lead = { source_id: 'deal:' + key, property: key, partner: wholesaler?.key ?? null, name: seller || wholesaler?.business_name || titleCase(a.line1),
        lead_stage: 'Offer Accepted', podio_stage: '', stage_from_deal: false, final_stage: 'Offer Accepted', asking_price: null, motivation: null, notes: 'Podio deal (no matching submission).',
        tags: ['Podio deal', ...(wholesaler ? [wholesaler.business_name] : [])], submitted_on: null, rows: 0, underwriters: [], deal: { stage: 'Prospect' }, parties: [], tc: null };
      if (wholesaler) lead.parties.push({ role: 'wholesaler', source_id: wholesaler.source_id, partner: wholesaler.key, name: null, company: wholesaler.business_name, email: null, phone: null });
      leads.push(lead);
      byProp.set(key, [...(byProp.get(key) ?? []), lead]);
    }
    review.dealLinks.push({ file: ds.map((d) => d.file).join(' + '), address: primary.addr, how, lead: lead.name, stage });
    if (!stage) { skipped.push({ file: primary.file, row: primary.i, reason: 'unknown deal stage', detail: stageRaw }); continue; }
    lead.dealMatch = how;

    // The seller stage follows from the deal trigger once the deal is written; lead_stage stays the submission's for the insert.
    lead.stage_from_deal = true;
    lead.final_stage = sellerStageFor(stage);
    if (!lead.tags.includes('Podio deal')) lead.tags.push('Podio deal');
    if (wholesaler && !lead.parties.some((p) => p.role === 'wholesaler' && p.partner === wholesaler.key)) {
      lead.parties.push({ role: 'wholesaler', source_id: wholesaler.source_id, partner: wholesaler.key, name: null, company: wholesaler.business_name, email: null, phone: null });
    }

    const d = lead.deal; const nts: string[] = [`Podio deal stage: ${stageRaw}`];
    const set = (k: string, v: string | number | boolean | null) => { if (v != null && v !== '') d[k] = v; };
    const L = (label: string, v: unknown) => { if (one(v)) nts.push(`${label}: ${clean(v)}`); };
    d.stage = stage;
    if (ds1) {
      const r = ds1.r;
      set('offer_amount', num(get(r, 'Purchase Price - amount'))); set('sold_price', num(get(r, 'Disposition Price - amount')));
      set('earnest_money', num(get(r, 'EMD - amount'))); set('contract_date', day(get(r, 'Contract Date - start')));
      set('option_ends_on', day(get(r, 'Option End Date - start'))); set('close_date', day(get(r, 'Closing Date - start')));
      set('terminated_on', day(get(r, 'Termination Date - start'))); set('termination_reason', one(get(r, 'Reason for Termination')) || null);
      if (one(get(r, 'Has our EMD been returned?'))) d.earnest_refunded = yes(get(r, 'Has our EMD been returned?'));
      if (yes(get(r, 'Terminated Contract')) || /terminat/i.test(one(get(r, 'Terminated Contract')))) d.terminated = true;
      set('occupancy_notes', clean(get(r, 'Occupancy Notes')) || null); set('condition_notes', clean(get(r, 'Walkthrough Notes')) || null);
      const titlePeople = multi(get(r, 'Title Company')).filter((t) => !/^(title company|attorney)$/i.test(t));
      if (titlePeople.length) set('title_contact', [...new Set(titlePeople)].join(', '));
      L('Podio wholesale fee', get(r, 'Wholesale Fee')); L('Buyer type', get(r, 'Buyer')); L('Photos', get(r, 'Photos'));
      L('Inspection date', day(get(r, 'Inspection Date - start'))); L('Targeted fund', get(r, 'Targeted Fund'));
      L('Title company (Podio)', multi(get(r, 'Title Company')).join(', ')); L('TC fee', get(r, 'TC Fee')); L('Memo', get(r, 'Memo'));
      L('Acme Homes EMD', get(r, 'Acme Homes EMD')); L("Buyer's EMD", get(r, 'Buyers EMD')); L('Transaction coordination', get(r, 'Transaction Coordination Information'));
      L('Seller next contact', day(get(r, 'Seller Next Contact - start'))); L('Title next contact', day(get(r, 'Title Next Contact - start')));
      L('Notes', get(r, 'Notes')); L('AI assistant notes', get(r, 'Ai Assistant Notes')); L('Seller notes', get(r, 'Seller Notes')); L('Title notes', get(r, 'Title Notes'));
      const names = multi(get(r, 'DIsposition Agent - name')); const mails = multi(get(r, 'DIsposition Agent - mail'));
      names.forEach((n, k) => lead!.parties.push({ role: 'dispositions', source_id: 'team:' + (mails[k]?.toLowerCase() ?? personKey(n)), name: n, company: null, email: mails[k]?.toLowerCase() ?? null, phone: null, team: true }));
      multi(get(r, 'Transactional Coordinator Name')).forEach((n) => lead!.parties.push({ role: 'tc', source_id: 'team:' + personKey(n), name: n, company: null, email: null, phone: null, team: true }));
      titlePeople.forEach((n) => lead!.parties.push({ role: 'title', source_id: 'text:' + personKey(n), name: n, company: null, email: null, phone: null }));
      multi(get(r, 'Other Contacts - name')).forEach((n, k) => lead!.parties.push({ role: 'other', source_id: 'text:' + personKey(n), name: n,
        company: multi(get(r, 'Other Contacts - organization'))[k] ?? null, email: multi(get(r, 'Other Contacts - mail'))[k]?.toLowerCase() ?? null, phone: multi(get(r, 'Other Contacts - phone'))[k] ?? null }));
      fundsIn(get(r, 'Targeted Fund')).forEach((f) => { if (!lead!.parties.some((p) => p.fund === f)) lead!.parties.push({ role: 'other', source_id: 'fund:' + f.toLowerCase(), fund: f, name: f, company: 'Fund — targeted', email: null, phone: null }); });
    }
    if (act) {
      const r = act.r; const c = (k: string) => num(get(r, k));
      set('contract_date', day(get(r, 'Date of Contract - start'))); set('close_date', day(get(r, 'Closing Date - start')));
      set('sold_price', c('Sold Price - amount')); set('assignment_fee', c('Marketed Wholesale Fee')); set('lac_pct', c('LAC %')); set('bac_pct', c('BAC %'));
      const cogs: [string, string][] = [['cogs_photos', 'Photos Cost - amount'], ['cogs_lockbox', 'Lockbox Cost - amount'], ['cogs_lead', 'Lead Cost - amount'],
        ['team_commissions_paid', 'Team Commissions Paid - amount'], ['cogs_flat_fee', 'Flat Fee Cost - amount'], ['cogs_realtor', 'Realtor Commissions (If Any) - amount'],
        ['cogs_title_fees', 'Title Fees (If Any) - amount'], ['cogs_concessions', 'Concessions - amount'], ['cogs_notary', 'Notary Fees (If Any) - amount'],
        ['cogs_transactional', 'Transactional Funding (If Any) - amount'], ['cogs_bonuses', 'Bonuses (If Any) - amount'], ['cogs_contractor', 'Contractor Costs (If any) - amount'],
        ['cogs_earnest_lost', 'Earnest Money (If Lost) - amount']];
      cogs.forEach(([col, k]) => set(col, c(k)));
      if (yes(get(r, 'Terminated Contract'))) d.terminated = true;
      L('Marketed price', money(c('Marketed Price - amount'))); L('Deal type', get(r, 'Deal Type')); L('Offer contingencies', get(r, 'Offer Contingencies/Notes'));
      L('Acquisition information', get(r, 'Acquisition Information')); L('Seller risk', [sub(r, 'Seller Risk Score'), clean(get(r, 'Seller Risk Notes'))].filter(Boolean).join(' — '));
      L('TC fee', get(r, 'TC Fee'));
      L('Podio totals (CLOZR recomputes)', [`wholesale fee ${one(get(r, 'Wholesale Fee'))}`, `total COGS ${one(get(r, 'Total COGS'))}`, `deal net ${one(get(r, 'Deal Net Profit'))}`, `company net ${one(get(r, 'Company Net Profit'))}`].join(', '));
      const seller = one(get(r, 'Seller'));
      if (seller) lead.parties.push({ role: 'seller', source_id: 'text:' + personKey(seller), name: seller, company: null, email: null, phone: null });
      multi(get(r, 'Deals Manager Agent')).forEach((n) => lead!.parties.push({ role: 'acquisitions', source_id: 'team:' + personKey(n), name: n, company: null, email: null, phone: null, team: true }));
      const names = multi(get(r, 'Disposition Agent - name')); const mails = multi(get(r, 'Disposition Agent - mail'));
      names.forEach((n, k) => { const sid = 'team:' + (mails[k]?.toLowerCase() ?? personKey(n)); if (!lead!.parties.some((p) => p.role === 'dispositions' && p.source_id === sid)) lead!.parties.push({ role: 'dispositions', source_id: sid, name: n, company: null, email: mails[k]?.toLowerCase() ?? null, phone: null, team: true }); });
      const la = one(get(r, 'Listing Agent (If Any)'));
      if (la) lead.parties.push({ role: 'listing_agent', source_id: 'text:' + personKey(la), name: la, company: null, email: null, phone: null });
      const type = one(get(r, 'Deal Type')).toLowerCase();
      lead.tc = { contract_date: (d.contract_date as string) ?? null, close_date: (d.close_date as string) ?? null, option_ends_on: (d.option_ends_on as string) ?? null,
        emd_amount: (d.earnest_money as number) ?? null, deal_type: type === 'assignment' || type === 'novation' ? type : null,
        escrow_officer: (d.title_contact as string) ?? null };
    }
    if (stage === 'Closed' && !d.closed_on) set('closed_on', (d.close_date as string) ?? null);
    d.notes = [nts.join('\n'), d.notes].filter(Boolean).join('\n\n');
    // One party per role + source per deal (the unique index would refuse a second).
    lead.parties = lead.parties.filter((p, k, all) => all.findIndex((q) => q.role === p.role && q.source_id === p.source_id) === k);
  }

  const partnerList = [...partners.values()].filter((p) => p.leads > 0 || p.fromDeals).sort((a, b) => b.submissions - a.submissions);
  review.sharedContacts.sort((a, b) => b.partners.length - a.partners.length);
  return { partners: partnerList, funds: FUNDS, properties: [...properties.values()], leads, skipped, review };
}
