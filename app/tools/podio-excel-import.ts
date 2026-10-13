// Podio Excel exports → CLOZR. Dry run by default; --apply writes.
//
//   npx tsx tools/podio-excel-import.ts                       plan + summary into tools/out/
//   npx tsx tools/podio-excel-import.ts --apply --workspace 11
//
// Options: --submissions <xlsx> --deal-stage <xlsx> --active-deals <xlsx> (default: the three files in ~/Downloads).
// --apply reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment only. It refuses to start unless
// migrations 40 (vendors.source, deal_parties) and 44 (the submission stages) are applied, and unless every
// planned address_key matches what public.address_key() computes. Re-running updates what the last run wrote
// (matched on source='podio' + source_id); records CLOZR already had are only filled where empty.
//
// The xlsx files are read with python + openpyxl (no xlsx package in this app).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NEW_SELLER_STAGES, buildPlan, entityKey, personKey, phoneKey, type Lead, type Plan, type Sheets } from '../lib/podio-excel';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const APPLY = args.includes('--apply');
const dl = join(homedir(), 'Downloads');
const FILES = {
  submissions: opt('submissions', join(dl, 'Submssions - All Submssions.xlsx'))!,
  dealStage: opt('deal-stage', join(dl, 'Deals - Deal Stage.xlsx'))!,
  activeDeals: opt('active-deals', join(dl, 'Deals - Active Deals.xlsx'))!,
};
const OUT = join(import.meta.dirname, 'out');

// ------------------------------------------------------------------ read

function readSheets(): Sheets {
  const py = `
import json, sys, datetime, openpyxl
def rows(p):
    ws = openpyxl.load_workbook(p, read_only=True, data_only=True).worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = [str(h).strip() if h is not None else '' for h in next(it)]
    out = []
    for r in it:
        d = {}
        for h, v in zip(hdr, r):
            if v is None or h in d: continue
            d[h] = v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v
        if d: out.append(d)
    return out
f = json.loads(sys.argv[1])
json.dump({k: rows(v) for k, v in f.items()}, open(sys.argv[2], 'w', encoding='utf-8'), default=str)
`;
  mkdirSync(OUT, { recursive: true });
  const json = join(OUT, 'podio-source.json');
  const r = spawnSync('python', ['-c', py, JSON.stringify(FILES), json], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Reading the xlsx files failed (python + openpyxl):\n' + (r.stderr || r.error));
  return JSON.parse(readFileSync(json, 'utf8'));
}

// --------------------------------------------------------------- summary

function summary(plan: Plan, sheets: Sheets, db: string[]): string {
  const P = plan.partners; const L = plan.leads;
  const count = <T,>(xs: T[], f: (x: T) => string) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const table = (head: string[], rows: (string | number)[][]) =>
    [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
  const parties = L.flatMap((l) => l.parties);
  const deals = L.filter((l) => l.stage_from_deal);
  const aliasRows = P.filter((p) => Object.keys(p.spellings).length > 1 || p.resolvedByContact).map((p) => [
    p.business_name, p.key, p.service_type, p.submissions, p.leads, p.resolvedByContact,
    Object.entries(p.spellings).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join('; '),
  ]);
  return [
    '# Podio Excel import — dry run',
    '',
    `Generated ${new Date().toISOString()}. Nothing was written. Files: ${Object.values(FILES).join(' · ')}`,
    '',
    '## Source rows',
    table(['file', 'rows'], [['Submissions', sheets.submissions.length], ['Deal Stage', sheets.dealStage.length], ['Active Deals', sheets.activeDeals.length]]),
    '',
    '## What the import would write',
    table(['table', 'records', 'note'], [
      ['vendors (partners)', P.length, `${P.filter((p) => p.service_type === 'Wholesaler').length} wholesalers · ${P.filter((p) => p.service_type === 'Institutional seller').length} institutional sellers · ${P.filter((p) => p.service_type === 'Realtor').length} brokerage · ${P.filter((p) => p.fromDeals).length} only named in Deals`],
      ['buyers (funds)', plan.funds.length, plan.funds.join(', ')],
      ['properties', plan.properties.length, `${plan.review.addressVariants.length} address spellings folded into another`],
      ['sellers (leads)', L.length, `${L.filter((l) => l.tags.includes('Multiple sources')).length} on multi-source properties · ${L.filter((l) => l.rows > 1).length} carry folded resubmissions · ${L.filter((l) => l.tags.includes('Dead')).length} tagged Dead`],
      ['deals', L.length, `${L.length - deals.length} Prospect (underwriting numbers) · ${deals.length} from the Deals files`],
      ['deal_parties', parties.length, count(parties, (p) => p.role).map(([r, c]) => `${r} ${c}`).join(' · ')],
      ['transactions (TC files)', L.filter((l) => l.tc).length, 'Active Deals rows'],
    ]),
    '',
    '### Against the database',
    ...(db.length ? db : ['Not checked: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. At the time of writing the workspace held 0 vendors, 1 buyer, 1 property, 2 sellers and no source=podio rows, so every record above is new.']),
    '',
    '## Stage mapping (Submissions → seller stage)',
    table(['Podio stage', 'CLOZR seller stage', 'leads'], plan.review.stageCounts.map((s) => [s.podio, s.clozr + (NEW_SELLER_STAGES.includes(s.clozr) ? ' (new, migration 44)' : ''), s.rows])),
    '',
    'Leads matched to a Deals row end on the stage the deal implies:',
    table(['deal stage', 'seller stage', 'leads'], count(deals, (l) => `${l.deal.stage}|${l.final_stage}`).map(([k, c]) => [...k.split('|'), c])),
    '',
    '## Partner alias table (partners with more than one spelling, or rows attributed by contact)',
    `${P.length} partners from ${new Set(sheets.submissions.map((r) => String(r['Entity Name'] ?? '').trim())).size} distinct Entity Name strings. Key = normalized entity; edit ALIASES in lib/podio-excel.ts to fold or split.`,
    '',
    table(['partner', 'key', 'type', 'submissions', 'leads', 'by contact', 'Podio spellings'], aliasRows),
    '',
    '## Top partners',
    table(['partner', 'type', 'submissions', 'leads', 'markets', 'contact', 'phone', 'email'], P.slice(0, 40).map((p) => [p.business_name, p.service_type, p.submissions, p.leads, p.markets.join(' '), p.contact_name ?? '', p.phone ?? '', p.email ?? ''])),
    '',
    '## Person-name entities folded into a company',
    table(['entity key', 'folded into', 'because this person submits for it'], plan.review.foldedByPerson.map((f) => [f.from, f.into, f.person])),
    '',
    '## For review: different companies sharing a phone or email (kept apart)',
    'Same person, different company names. Add an ALIASES entry to merge any that are one company.',
    '',
    table(['phone / email', 'partners (rows)'], plan.review.sharedContacts.map((s) => [s.contact, s.partners.join('; ')])),
    '',
    '## Rows without a usable Entity Name, attributed by contact',
    table(['row', 'entity cell', 'matched by', 'partner'], plan.review.contactResolutions.map((c) => [c.row, c.entity, c.by, c.partner])),
    '',
    `## Multi-source properties (${plan.review.multiSource.length})`,
    table(['property', 'submitted by'], plan.review.multiSource.map((m) => [m.address, m.partners.join('; ')])),
    '',
    `## Address spellings folded (${plan.review.addressVariants.length})`,
    table(['from key', 'into key'], plan.review.addressVariants.map((a) => [a.from, a.into])),
    '',
    '## Deals files → leads',
    table(['file', 'address', 'matched by', 'lead', 'deal stage'], plan.review.dealLinks.map((d) => [d.file, d.address, d.how, d.lead ?? '', d.stage ?? '(unknown)'])),
    '',
    `## Rows skipped or folded (${plan.skipped.length})`,
    table(['reason', 'rows'], count(plan.skipped, (s) => `${s.file}: ${s.reason}`)),
    '',
    table(['file', 'row', 'reason', 'detail'], plan.skipped.filter((s) => !s.reason.startsWith('resubmission')).map((s) => [s.file, s.row, s.reason, s.detail])),
    '',
  ].join('\n');
}

// ----------------------------------------------------------------- apply

type Sb = SupabaseClient;
const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const must = <T,>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
};
async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await q(from, from + 999), what);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const blank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);
const fillOnly = (cur: Record<string, unknown>, inc: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(inc).filter(([k, v]) => !blank(v) && blank(cur[k])));

type Id = { id: number; source_id: string | null };

async function apply(plan: Plan, ws: number) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  const sb: Sb = createClient(url, key, { auth: { persistSession: false } });
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

  // ---- preflight: migrations 40 and 44, the workspace, and address keys
  must(await sb.from('workspaces').select('id').eq('id', ws).single(), `workspace ${ws}`);
  must(await sb.from('vendors').select('source, source_id').limit(1), 'migration 40 (vendors.source) is not applied');
  must(await sb.from('deal_parties').select('id').limit(1), 'migration 40 (deal_parties) is not applied');
  const stages = must(await sb.from('seller_stages').select('label'), 'seller_stages').map((s: { label: string }) => s.label);
  const missing = NEW_SELLER_STAGES.filter((s) => !stages.includes(s));
  if (missing.length) throw new Error(`migration 44 is not applied — seller_stages lacks: ${missing.join(', ')}`);
  log(`verifying ${plan.properties.length} address keys against public.address_key()`);
  const bad: string[] = [];
  await pool(plan.properties, 12, async (p) => {
    const k = must(await sb.rpc('address_key', { p_line1: p.line1, p_city: p.city ?? '', p_state: p.state ?? '', p_zip: p.zip ?? '' }), 'address_key');
    if (k !== p.key) bad.push(`${p.key} ≠ ${k}`);
  });
  if (bad.length) throw new Error(`address_key mismatch on ${bad.length} properties, nothing written:\n${bad.slice(0, 20).join('\n')}`);

  // ---- teammates
  const roster = must(await sb.from('workspace_roster').select('user_id, full_name, email').eq('workspace_id', ws), 'roster') as { user_id: string; full_name: string | null; email: string | null }[];
  const teammate = (name: string | null, email: string | null) =>
    roster.find((m) => (email && m.email?.toLowerCase() === email) || (name && m.full_name && personKey(m.full_name) === personKey(name)))?.user_id ?? null;

  // ---- vendors: podio rows by source_id; otherwise an existing vendor with the same name, phone or email
  type V = { id: number; business_name: string; contact_name: string | null; phone: string | null; email: string | null; service_type: string | null; markets: string[] | null; notes: string | null; source: string | null; source_id: string | null };
  const vendors = await readAll<V>((a, b) => sb.from('vendors').select('id, business_name, contact_name, phone, email, service_type, markets, notes, source, source_id').eq('workspace_id', ws).order('id').range(a, b), 'vendors');
  const vendorId = new Map<string, number>();
  const newVendors: Record<string, unknown>[] = []; let vFilled = 0; let vUpdated = 0;
  for (const p of plan.partners) {
    const row = { business_name: p.business_name, contact_name: p.contact_name, phone: p.phone, email: p.email, service_type: p.service_type, markets: p.markets, notes: p.notes };
    // A vendor CLOZR already had is claimed by one partner at most: two companies sharing an owner's phone must not collapse into it.
    const free = (v: V) => v.source !== 'podio' && ![...vendorId.values()].includes(v.id);
    const hit = vendors.find((v) => v.source === 'podio' && v.source_id === p.source_id)
      ?? vendors.find((v) => free(v) && entityKey(v.business_name) === p.key)
      ?? vendors.find((v) => free(v) && ((p.phone && phoneKey(v.phone) === phoneKey(p.phone)) || (p.email && v.email?.toLowerCase() === p.email)));
    if (!hit) { newVendors.push({ workspace_id: ws, ...row, source: 'podio', source_id: p.source_id }); continue; }
    vendorId.set(p.key, hit.id);
    const patch = hit.source === 'podio' ? row : fillOnly(hit, row);
    if (Object.keys(patch).length) {
      must(await sb.from('vendors').update(patch).eq('id', hit.id), 'vendor update');
      if (hit.source === 'podio') vUpdated++; else vFilled++;
    }
  }
  for (const c of chunk(newVendors, 500)) for (const v of must(await sb.from('vendors').insert(c, { defaultToNull: false }).select('id, source_id'), 'vendor insert') as Id[]) vendorId.set(v.source_id!.slice('partner:'.length), v.id);
  log(`vendors: ${newVendors.length} created · ${vUpdated} updated · ${vFilled} existing filled`);

  // ---- buyers: the funds, once
  const buyers = await readAll<{ id: number; name: string; company: string | null; source_id: string | null }>((a, b) => sb.from('buyers').select('id, name, company, source_id').eq('workspace_id', ws).order('id').range(a, b), 'buyers');
  const fundId = new Map<string, number>();
  for (const f of plan.funds) {
    const sid = 'fund:' + f.toLowerCase();
    const hit = buyers.find((b) => b.source_id === sid || entityKey(b.name) === entityKey(f) || (b.company && entityKey(b.company) === entityKey(f)));
    if (hit) { fundId.set(f, hit.id); continue; }
    const row = must(await sb.from('buyers').insert({ workspace_id: ws, name: f, company: f, buyer_type: 'fund', entity_type: 'fund', source: 'podio', source_id: sid, notes: 'Fund from Podio (Funds Sent To / Targeted Fund).' }).select('id').single(), 'buyer insert') as { id: number };
    fundId.set(f, row.id);
  }
  log(`buyers: ${plan.funds.length} funds resolved`);

  // ---- properties: by address_key; existing ones only get empty facts filled
  type PR = { id: number; address_key: string; beds: number | null; baths: number | null; sqft: number | null; year_built: number | null; property_type: string | null };
  const props = await readAll<PR>((a, b) => sb.from('properties').select('id, address_key, beds, baths, sqft, year_built, property_type').eq('workspace_id', ws).order('id').range(a, b), 'properties');
  const propId = new Map(props.map((p) => [p.address_key, p.id]));
  const newProps = plan.properties.filter((p) => !propId.has(p.key));
  for (const c of chunk(newProps, 500)) {
    const got = must(await sb.from('properties').insert(c.map((p) => ({ workspace_id: ws, line1: p.line1, city: p.city, state: p.state, zip: p.zip, ...p.facts, source: 'podio' })), { defaultToNull: false }).select('id, address_key'), 'property insert') as PR[];
    got.forEach((p) => propId.set(p.address_key, p.id));
  }
  let pFilled = 0;
  for (const p of plan.properties.filter((x) => props.some((e) => e.address_key === x.key))) {
    const patch = fillOnly(props.find((e) => e.address_key === p.key)!, p.facts);
    if (Object.keys(patch).length) { must(await sb.from('properties').update(patch).eq('id', propId.get(p.key)!), 'property fill'); pFilled++; }
  }
  log(`properties: ${newProps.length} created · ${pFilled} existing filled`);

  // ---- sellers
  const sellers = await readAll<Id>((a, b) => sb.from('sellers').select('id, source_id').eq('workspace_id', ws).eq('source', 'podio').order('id').range(a, b), 'sellers');
  const sellerId = new Map(sellers.map((s) => [s.source_id!, s.id]));
  const sellerRow = (l: Lead) => {
    const p = plan.properties.find((x) => x.key === l.property)!;
    const underwriter = l.underwriters.map((u) => teammate(u.name, u.email)).find(Boolean) ?? null;
    return { workspace_id: ws, name: l.name, property_id: propId.get(l.property)!, property_address: [p.line1, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      asking_price: l.asking_price, motivation: l.motivation, notes: l.notes, tags: l.tags, source: 'podio', source_id: l.source_id,
      ...(underwriter ? { assigned_to: underwriter } : {}) };
  };
  const toInsert = plan.leads.filter((l) => !sellerId.has(l.source_id));
  for (const c of chunk(toInsert, 500)) {
    const got = must(await sb.from('sellers').insert(c.map((l) => ({ ...sellerRow(l), lead_stage: l.lead_stage })), { defaultToNull: false }).select('id, source_id'), 'seller insert') as Id[];
    got.forEach((s) => sellerId.set(s.source_id!, s.id));
  }
  // Updates: lead_stage only where no Deals row owns it (the deal trigger does).
  const toUpdate = plan.leads.filter((l) => !toInsert.includes(l));
  await pool(toUpdate, 8, async (l) => {
    must(await sb.from('sellers').update({ ...sellerRow(l), ...(l.stage_from_deal ? {} : { lead_stage: l.lead_stage }) }).eq('id', sellerId.get(l.source_id)!), 'seller update');
  });
  log(`sellers: ${toInsert.length} created · ${toUpdate.length} updated`);

  // ---- deals: one per lead
  const deals = await readAll<Id>((a, b) => sb.from('deals').select('id, source_id').eq('workspace_id', ws).eq('source', 'podio').order('id').range(a, b), 'deals');
  const dealId = new Map(deals.map((d) => [d.source_id!, d.id]));
  const dealRow = (l: Lead) => {
    const owner = l.parties.filter((p) => p.role === 'acquisitions').map((p) => teammate(p.name, p.email)).find(Boolean);
    const dispo = l.parties.filter((p) => p.role === 'dispositions').map((p) => teammate(p.name, p.email)).filter(Boolean);
    const tc = l.parties.filter((p) => p.role === 'tc').map((p) => teammate(p.name, p.email)).find(Boolean);
    const clean = Object.fromEntries(Object.entries(l.deal).filter(([, v]) => v != null));
    return { workspace_id: ws, seller_id: sellerId.get(l.source_id)!, property_id: propId.get(l.property)!, source: 'podio', source_id: l.source_id, ...clean,
      ...(owner ? { owner_id: owner } : {}), ...(dispo[0] ? { dispo_rep_id: dispo[0] } : {}), ...(dispo[1] ? { dispo_rep2_id: dispo[1] } : {}), ...(tc ? { tc_rep_id: tc } : {}) };
  };
  const dNew = plan.leads.filter((l) => !dealId.has(l.source_id));
  for (const c of chunk(dNew, 250)) {
    const got = must(await sb.from('deals').insert(c.map(dealRow), { defaultToNull: false }).select('id, source_id'), 'deal insert') as Id[];
    got.forEach((d) => dealId.set(d.source_id!, d.id));
  }
  await pool(plan.leads.filter((l) => !dNew.includes(l)), 8, async (l) => {
    // A Prospect deal someone has since moved on in CLOZR keeps its stage.
    const { stage, ...rest } = dealRow(l) as Record<string, unknown>;
    must(await sb.from('deals').update({ ...rest, ...(stage !== 'Prospect' ? { stage } : {}), updated_at: new Date().toISOString() }).eq('id', dealId.get(l.source_id)!), 'deal update');
  });
  log(`deals: ${dNew.length} created · ${plan.leads.length - dNew.length} updated`);

  // ---- TC files for the active deals
  let tcs = 0;
  for (const l of plan.leads.filter((x) => x.tc)) {
    const id = dealId.get(l.source_id)!;
    const fields = Object.fromEntries(Object.entries(l.tc!).filter(([, v]) => v != null));
    const cur = must(await sb.from('transactions').select('id').eq('deal_id', id).limit(1), 'transactions') as { id: number }[];
    if (cur.length) must(await sb.from('transactions').update(fields).eq('id', cur[0].id), 'transaction update');
    else must(await sb.from('transactions').insert({ workspace_id: ws, deal_id: id, property_id: propId.get(l.property), seller_id: sellerId.get(l.source_id), status: 'open', ...fields }), 'transaction insert');
    tcs++;
  }
  log(`transactions: ${tcs} TC files written`);

  // ---- deal parties: one per deal + role + source_id
  const ids = [...dealId.values()];
  const existing: { id: number; deal_id: number; role: string; source_id: string | null }[] = [];
  for (const c of chunk(ids, 200)) existing.push(...(must(await sb.from('deal_parties').select('id, deal_id, role, source_id').in('deal_id', c).eq('source', 'podio'), 'deal_parties') as typeof existing));
  const have = new Map(existing.map((e) => [`${e.deal_id}|${e.role}|${e.source_id}`, e.id]));
  const partyRows = plan.leads.flatMap((l) => l.parties.map((p) => ({
    workspace_id: ws, deal_id: dealId.get(l.source_id)!, role: p.role, name: p.name, company: p.company, email: p.email, phone: p.phone, source: 'podio', source_id: p.source_id,
    vendor_id: p.partner ? vendorId.get(p.partner) ?? null : null, buyer_id: p.fund ? fundId.get(p.fund) ?? null : null,
    user_id: p.team ? teammate(p.name, p.email) : null,
  })));
  const pNew = partyRows.filter((p) => !have.has(`${p.deal_id}|${p.role}|${p.source_id}`));
  for (const c of chunk(pNew, 500)) must(await sb.from('deal_parties').insert(c, { defaultToNull: false }), 'deal_parties insert');
  const pUpd = partyRows.filter((p) => have.has(`${p.deal_id}|${p.role}|${p.source_id}`));
  await pool(pUpd, 8, async (p) => { must(await sb.from('deal_parties').update(p).eq('id', have.get(`${p.deal_id}|${p.role}|${p.source_id}`)!), 'deal_parties update'); });
  log(`deal_parties: ${pNew.length} created · ${pUpd.length} updated`);

  writeFileSync(join(OUT, 'podio-import-applied.json'), JSON.stringify({ at: new Date().toISOString(), workspace: ws, vendors: Object.fromEntries(vendorId), sellers: Object.fromEntries(sellerId), deals: Object.fromEntries(dealId) }, null, 1));
}

/** Read-only: how many planned records already exist, when credentials are present. */
async function dbCheck(plan: Plan, ws: number | null): Promise<string[]> {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !ws) return [];
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const vendors = await readAll<{ business_name: string; phone: string | null; email: string | null }>((a, b) => sb.from('vendors').select('business_name, phone, email').eq('workspace_id', ws).order('id').range(a, b), 'vendors');
  const props = new Set((await readAll<{ address_key: string }>((a, b) => sb.from('properties').select('address_key').eq('workspace_id', ws).order('id').range(a, b), 'properties')).map((p) => p.address_key));
  const podio = await readAll<{ source_id: string }>((a, b) => sb.from('sellers').select('source_id').eq('workspace_id', ws).eq('source', 'podio').order('id').range(a, b), 'sellers');
  const vm = plan.partners.filter((p) => vendors.some((v) => entityKey(v.business_name) === p.key || (p.phone && phoneKey(v.phone) === phoneKey(p.phone)) || (p.email && v.email?.toLowerCase() === p.email))).length;
  const pm = plan.properties.filter((p) => props.has(p.key)).length;
  const sm = plan.leads.filter((l) => podio.some((s) => s.source_id === l.source_id)).length;
  return [`Workspace ${ws}: vendors ${plan.partners.length - vm} new / ${vm} matched · properties ${plan.properties.length - pm} new / ${pm} matched · leads ${plan.leads.length - sm} new / ${sm} already imported.`];
}

async function main() {
  const sheets = readSheets();
  const plan = buildPlan(sheets);
  const ws = opt('workspace') ? Number(opt('workspace')) : null;
  writeFileSync(join(OUT, 'podio-import-plan.json'), JSON.stringify(plan, null, 1));
  writeFileSync(join(OUT, 'podio-import-summary.md'), summary(plan, sheets, await dbCheck(plan, ws)));
  console.log(`plan: ${plan.partners.length} partners · ${plan.properties.length} properties · ${plan.leads.length} leads · ${plan.leads.filter((l) => l.stage_from_deal).length} deals from Deals files · ${plan.skipped.length} rows skipped/folded`);
  console.log(`wrote ${join(OUT, 'podio-import-plan.json')} and podio-import-summary.md`);
  if (!APPLY) return;
  if (!ws) throw new Error('--apply needs --workspace <id>');
  await apply(plan, ws);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
