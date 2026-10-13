// Buyer lists → CLOZR buyers. Dry run by default: it writes the plan, a summary and idempotent SQL into
// tools/out/ (gitignored, partner data) and touches nothing.
//
//   npx tsx tools/buyers-excel-import.ts [--xlsx <workbook>] [--podio <xlsx>] [--dispogenius <csv>] [--locations <xlsx>] [--workspace 11]
//   npx tsx tools/buyers-excel-import.ts --xlsx ~/Downloads/Vetted\ Buyers.xlsx --apply --workspace 11
//
// --apply writes through supabase-js with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment only,
// using the same rules as the SQL (findTarget / patchFor / insertRow in lib/buyers-excel.ts), and records what it
// did in tools/out/buyers-import-applied.json.
//
// Sources: pass `--xlsx` for a DispoGenius workbook with "Vetted Buyers" + "Buy Box"
// sheets, or the older trio in ~/Downloads (Podio Buyers List, DispoGenius CSV,
// Buyer Locations). Missing files are skipped.
// Apply by running tools/out/buyers-import-001.sql, -002.sql … in order through a SQL tool. Each
// statement matches on this import's source ids first, then phone / email / name + company, so a
// re-run updates instead of duplicating and buyers CLOZR already had are only filled where empty.
// Files are read with python (openpyxl / csv); there is no xlsx package in this app.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { EXISTING_COLUMNS, buildPlan, findTarget, insertRow, patchFor, sqlFiles, type ExistingBuyer, type Plan, type Row } from '../lib/buyers-excel';

const args = process.argv.slice(2);
const opt = (name: string, dflt = '') => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const dl = join(homedir(), 'Downloads');
const COMBINED = opt('xlsx') || opt('file');
const FILES = {
  xlsx: COMBINED,
  podio: opt('podio', COMBINED ? '' : join(dl, 'Buyers List - Locations.xlsx')),
  dispogenius: opt('dispogenius', COMBINED ? '' : join(dl, 'Acme Homes Buyers Data - Buyers Data.csv')),
  locations: opt('locations', COMBINED ? '' : join(dl, 'Buyer  Locations.xlsx')),
};
const APPLY = args.includes('--apply');
const WORKSPACE = Number(opt('workspace', '11'));
const OUT = join(import.meta.dirname, 'out');

function readSources(): { podio: Row[]; dispogenius: Row[]; locations: Row[] } {
  const py = `
import json, sys, csv, datetime, os, openpyxl
def cell(v):
    return v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v
def sheet_rows(ws):
    it = ws.iter_rows(values_only=True)
    hdr = [str(h).strip() if h is not None else '' for h in next(it, [])]
    out = []
    for r in it:
        d = {}
        for h, v in zip(hdr, r):
            if v is None or not h or h in d: continue
            d[h] = cell(v)
        if d: out.append(d)
    return hdr, out
def classify(hdr, title):
    keys = {h.lower() for h in hdr if h}
    t = (title or '').lower()
    if 'customer_id' in keys or ('full_name' in keys and 'min_year_build' in keys):
        return 'dispogenius'
    if 'buyer name' in keys:
        return 'podio'
    if 'full_name' in keys and 'address' in keys and ('county' in keys or 'type' in keys):
        return 'locations'
    if 'buy box' in t or 'location' in t: return 'locations'
    if 'vetted' in t or 'buyers' in t: return 'dispogenius'
    return None
def xlsx_first(p):
    return sheet_rows(openpyxl.load_workbook(p, read_only=True, data_only=True).worksheets[0])[1]
f = json.loads(sys.argv[1])
data = {'podio': [], 'dispogenius': [], 'locations': []}
if f.get('xlsx') and os.path.isfile(f['xlsx']):
    wb = openpyxl.load_workbook(f['xlsx'], read_only=True, data_only=True)
    for ws in wb.worksheets:
        hdr, rows = sheet_rows(ws)
        kind = classify(hdr, ws.title)
        if kind: data[kind].extend(rows)
if f.get('podio') and os.path.isfile(f['podio']): data['podio'] = xlsx_first(f['podio'])
if f.get('locations') and os.path.isfile(f['locations']): data['locations'] = xlsx_first(f['locations'])
if f.get('dispogenius') and os.path.isfile(f['dispogenius']):
    data['dispogenius'] = list(csv.DictReader(open(f['dispogenius'], encoding='utf-8-sig', newline='')))
json.dump(data, open(sys.argv[2], 'w', encoding='utf-8'), default=str)
`;
  mkdirSync(OUT, { recursive: true });
  const json = join(OUT, 'buyers-source.json');
  const r = spawnSync('python3', ['-c', py, JSON.stringify(FILES), json], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Reading the source files failed (python + openpyxl):\n' + (r.stderr || r.error));
  return JSON.parse(readFileSync(json, 'utf8'));
}

function summary(plan: Plan, files: string[]): string {
  const B = plan.buyers; const L = plan.locations;
  const cell = (c: unknown) => String(c ?? '').replace(/\|/g, '/').replace(/\n+/g, ' ');
  const table = (head: string[], rows: unknown[][]) =>
    [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
  const count = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const has = (b: (typeof B)[number], s: string) => b.rows.some((r) => r.startsWith(s));
  const skippedBy = (s: string) => plan.skipped.filter((x) => x.source === s).length;
  const podioOnly = B.filter((b) => has(b, 'podio') && !has(b, 'dispogenius')).length;
  const dgOnly = B.filter((b) => has(b, 'dispogenius') && !has(b, 'podio')).length;
  const both = B.filter((b) => has(b, 'podio') && has(b, 'dispogenius')).length;
  const crossMerges = plan.merges.filter((m) => m.row.split(' ')[0] !== m.intoRow.split(' ')[0]).length;
  return [
    '# Buyer lists import — dry run',
    '',
    `Generated ${new Date().toISOString()}. Nothing was written. Workspace ${WORKSPACE}.`,
    '',
    ...Object.entries(FILES).map(([k, f]) => `- ${k}: ${f}`),
    '',
    '## Per source',
    table(['source', 'rows', 'skipped', 'buyers it appears in'], [
      ['DispoGenius buyers CSV', plan.rows.dispogenius, skippedBy('dispogenius'), B.filter((b) => has(b, 'dispogenius')).length],
      ['Podio Buyers List xlsx', plan.rows.podio, skippedBy('podio'), B.filter((b) => has(b, 'podio')).length],
      ['DispoGenius Buyer Locations xlsx', L.rows, `${L.unmatched.length} unmatched`, `${L.byPhone + L.byName} rows attached (${L.byPhone} by phone, ${L.byName} by name)`],
    ]),
    '',
    '## Result',
    table(['', 'count'], [
      ['unique buyers', B.length],
      ['in both DispoGenius and Podio', both],
      ['DispoGenius only', dgOnly],
      ['Podio only', podioOnly],
      ['rows folded into another row', `${plan.merges.length} (${crossMerges} across sources)`],
      ['rows skipped', plan.skipped.length],
      ['with phone / email / neither', `${B.filter((b) => b.phone).length} / ${B.filter((b) => b.email).length} / ${B.filter((b) => !b.phone && !b.email).length}`],
      ['with at least one market', B.filter((b) => b.criteria.location_prefs.length).length],
      ['VIP', B.filter((b) => b.vip).length],
      ['vetted (DispoGenius vetted/vip buyer)', B.filter((b) => b.vetted_at).length],
      ['do-not-call / no follow-ups / blacklisted / inactive', `${B.filter((b) => !b.wants_calls).length} / ${B.filter((b) => !b.wants_follow_ups).length} / ${B.filter((b) => b.blacklisted).length} / ${B.filter((b) => b.status === 'inactive').length}`],
      ['Podio creator is a workspace member (Morgan / Alex / Jamie → created_by)', B.filter((b) => /^(morgan|alex|jamie)@/.test(b.created_by_email ?? '')).length],
    ]),
    '',
    `SQL: ${files.join(', ')} (run in order).`,
    '',
    '## Buyer type and tags',
    table(['buyer_type', 'buyers'], count(B.map((b) => b.buyer_type ?? '(none)'))),
    '',
    table(['tag', 'buyers'], count(B.flatMap((b) => b.tags))),
    '',
    '## Form defaults dropped from the buy box',
    table(['value', 'rows'], Object.entries(plan.review.defaultsDropped)),
    '',
    '## Merges',
    table(['reason', 'rows'], count(plan.merges.map((m) => m.by.replace(/ .*@.*| \+\d+/, '')))),
    '',
    table(['row', 'name in that row', 'folded into', 'because'], plan.merges.map((m) => [m.row, m.name, `${m.into} (${m.intoRow})`, m.by])),
    '',
    '## For review: shared phone / email, names disagree (kept apart)',
    table(['contact', 'rows'], plan.review.keptApart.map((k) => [k.contact, k.rows.join('; ')])),
    '',
    '## Buyer Locations rows not attached',
    table(['reason', 'rows'], count(L.unmatched.map((u) => u.reason))),
    '',
    L.unmatched.length ? table(['row', 'name', 'phone', 'location', 'reason'], L.unmatched.map((u) => [u.row, u.name, u.phone, u.location, u.reason])) : 'None.',
    '',
    '## Test records excluded',
    plan.excluded.length ? table(['name', 'rows'], plan.excluded.map((x) => [x.name, x.rows.join('; ')])) : 'None.',
    '',
    '## Possible test records (kept; exclude by adding the name to TEST_NAMES in lib/buyers-excel.ts)',
    plan.review.possibleTests.length ? table(['name', 'looks like a test because of', 'rows'], plan.review.possibleTests.map((x) => [x.name, x.why, x.rows.join('; ')])) : 'None.',
    '',
    '## Rows skipped',
    plan.skipped.length ? table(['source', 'row', 'reason', 'detail'], plan.skipped.map((s) => [s.source, s.row, s.reason, s.detail])) : 'None.',
    '',
    '## Sample of 10 mapped buyers',
    ...[...B.filter((b) => has(b, 'podio') && has(b, 'dispogenius')).slice(0, 4), ...B.filter((b) => b.rows.length > 2).slice(0, 2),
      ...B.filter((b) => !has(b, 'podio')).slice(0, 2), ...B.filter((b) => !has(b, 'dispogenius')).slice(0, 2)].map((b) =>
      ['', `### ${b.name} (${b.rows.join(', ')})`, '```json', JSON.stringify({ ...b, criteria: { ...b.criteria, locations: undefined, restricted: undefined } }, null, 2), '```'].join('\n')),
    '',
  ].join('\n');
}

// ----------------------------------------------------------------- apply

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const must = <T,>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
};

async function apply(plan: Plan, ws: number) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('--apply needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set in the environment. Nothing was written.');
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const now = new Date().toISOString();

  must(await sb.from('workspaces').select('id').eq('id', ws).single(), `workspace ${ws}`);
  const existing: ExistingBuyer[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await sb.from('buyers').select(EXISTING_COLUMNS).eq('workspace_id', ws).order('id').range(from, from + 999), 'buyers') as unknown as ExistingBuyer[];
    existing.push(...page);
    if (page.length < 1000) break;
  }
  const roster = must(await sb.from('workspace_roster').select('user_id, email').eq('workspace_id', ws), 'workspace_roster') as { user_id: string; email: string | null }[];
  const member = (email: string | null) => (email ? roster.find((m) => m.email?.toLowerCase() === email)?.user_id ?? null : null);
  log(`workspace ${ws}: ${existing.length} buyers already there; applying ${plan.buyers.length} planned buyers`);

  // Decide everything against one snapshot first (later buyers never fill a row an earlier one inserts, same as the SQL).
  const inserts: { b: Plan['buyers'][number]; row: Record<string, unknown> }[] = [];
  const updates: { id: number; ours: boolean; name: string; patch: Record<string, unknown> }[] = [];
  let unchanged = 0;
  for (const b of plan.buyers) {
    const hit = findTarget(existing, b);
    if (!hit) { inserts.push({ b, row: insertRow(b, ws, member(b.created_by_email), now) }); continue; }
    const patch = patchFor(hit.row, b, hit.ours, now);
    Object.assign(hit.row, patch); // a second planned buyer matching the same existing row sees the filled values
    if (Object.keys(patch).length) updates.push({ id: hit.row.id, ours: hit.ours, name: b.name, patch }); else unchanged++;
  }
  log(`${inserts.length} to insert · ${updates.length} to update (${updates.filter((u) => u.ours).length} from an earlier run, ${updates.filter((u) => !u.ours).length} existing buyers filled) · ${unchanged} unchanged`);

  const inserted: Record<string, number> = {}; let n = 0;
  for (const part of chunk(inserts, 100)) {
    const rows = must(await sb.from('buyers').insert(part.map((x) => x.row) as never).select('id, source_id'), 'insert buyers') as { id: number; source_id: string }[];
    for (const r of rows) inserted[r.source_id] = r.id;
    log(`inserted ${(n += part.length)}/${inserts.length}`);
  }
  n = 0;
  for (const part of chunk(updates, 25)) {
    await Promise.all(part.map(async (u) => {
      must(await sb.from('buyers').update({ ...u.patch, updated_at: now } as never).eq('id', u.id).eq('workspace_id', ws).select('id'), `update buyer ${u.id}`);
    }));
    log(`updated ${(n += part.length)}/${updates.length}`);
  }

  const applied = {
    at: now, workspace: ws, planned: plan.buyers.length, inserted: Object.keys(inserted).length, updated: updates.length, unchanged,
    excluded: plan.excluded, insertedIds: inserted,
    updates: updates.map((u) => ({ id: u.id, name: u.name, matched: u.ours ? 'earlier run' : 'existing buyer (filled)', columns: Object.keys(u.patch) })),
  };
  writeFileSync(join(OUT, 'buyers-import-applied.json'), JSON.stringify(applied, null, 1));
  log(`done: ${applied.inserted} inserted · ${applied.updated} updated · ${unchanged} unchanged → ${join(OUT, 'buyers-import-applied.json')}`);
  log(`optional: score them against active inventory in SQL — select public.match_buyer(id) from public.buyers where workspace_id = ${ws} and tags && array['podio-buyers', 'dispogenius'];`);
}

const plan = buildPlan(readSources());
for (const f of readdirSync(OUT)) if (/^buyers-import(-\d{3})?\.sql$/.test(f)) rmSync(join(OUT, f));
const sql = sqlFiles(plan.buyers, WORKSPACE);
const files = sql.length === 1 ? ['buyers-import.sql'] : sql.map((_, i) => `buyers-import-${String(i + 1).padStart(3, '0')}.sql`);
sql.forEach((s, i) => writeFileSync(join(OUT, files[i]), s));
writeFileSync(join(OUT, 'buyers-import-plan.json'), JSON.stringify(plan, null, 2));
writeFileSync(join(OUT, 'buyers-import-summary.md'), summary(plan, files));
console.log(`rows: ${plan.rows.dispogenius} DispoGenius + ${plan.rows.podio} Podio + ${plan.locations.rows} locations`);
console.log(`→ ${plan.buyers.length} buyers · ${plan.merges.length} folded · ${plan.skipped.length} skipped · locations attached ${plan.locations.byPhone + plan.locations.byName}, unmatched ${plan.locations.unmatched.length}`);
console.log(`Wrote ${files.join(', ')}, buyers-import-plan.json, buyers-import-summary.md in ${OUT}`);
if (APPLY) {
  if (!args.includes('--workspace')) { console.error('--apply needs --workspace <id>'); process.exit(1); }
  apply(plan, WORKSPACE).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
