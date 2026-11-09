// Import a folder of Markdown docs into a workspace's Lane resources
// (migration 400): the TC Bible, scripts, checklists, templates.
//
//   node --experimental-strip-types scripts/import-resources.ts <folder> --workspace <id> [--dry-run] [--map map.json]
//
// Every *.md in the folder becomes one doc. A file collected from Google Drive
// starts with a "Source: Google Drive file id `…`" / "Link: …" header and a
// "---" rule (parseImported in _shared/resource-text.ts): the link is kept as
// the doc's source and the header is left out of the text. Each doc is filed
// on the category guessCategory picks from its title, unless --map names one:
// a JSON object of file name (or title) → category name. Categories that do
// not exist yet are created. Docs filed under "TC Bible" (TC Training and the
// Acme Homes TC Handbook) are pinned to the top of Resources.
//
// Re-running is safe: a doc with the same Drive link (or, without one, the
// same title) in the workspace is updated in place and its sections re-cut.
//
// --dry-run prints what would be imported and touches nothing (no env needed).
// Otherwise it needs SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_URL when the
// project is not CLOZR's (your-project-ref).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_CATEGORIES, PINNED_CATEGORY, chunkText, guessCategory, parseImported } from '../supabase/functions/_shared/resource-text.ts';

type Plan = { file: string; title: string; category: string; pinned: boolean; driveUrl: string | null; body: string; chunks: number };

function args(argv: string[]) {
  const out: { folder: string | null; workspace: number | null; dryRun: boolean; map: string | null } = { folder: null, workspace: null, dryRun: false, map: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--workspace') out.workspace = Number(argv[++i]);
    else if (a === '--map') out.map = argv[++i];
    else if (!a.startsWith('--')) out.folder = a;
  }
  return out;
}

/** What the folder holds, filed and cut, without touching anything. */
export function planFolder(folder: string, map: Record<string, string> = {}, categories: readonly string[] = DEFAULT_CATEGORIES): Plan[] {
  const files = readdirSync(folder).filter((f) => /\.(md|markdown)$/i.test(f) && statSync(join(folder, f)).isFile()).sort();
  return files.map((f) => {
    const doc = parseImported(f, readFileSync(join(folder, f), 'utf8'));
    const mapped = map[f] ?? map[basename(f).replace(/\.(md|markdown)$/i, '')] ?? map[doc.title];
    const category = mapped ?? guessCategory(doc.title, doc.body, categories);
    return { file: f, title: doc.title, category, pinned: category === PINNED_CATEGORY, driveUrl: doc.driveUrl, body: doc.body, chunks: chunkText(doc.title, doc.body).length };
  });
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.folder) {
    console.error('usage: node --experimental-strip-types scripts/import-resources.ts <folder> --workspace <id> [--dry-run] [--map map.json]');
    process.exit(2);
  }
  const map = a.map ? JSON.parse(readFileSync(a.map, 'utf8')) as Record<string, string> : {};
  const plan = planFolder(a.folder, map);
  if (!plan.length) { console.error(`No .md files in ${a.folder}.`); process.exit(1); }
  for (const p of plan) console.log(`${(p.category + (p.pinned ? ' (pinned)' : '')).padEnd(22)} ${p.title}  (${p.body.length.toLocaleString()} chars, ${p.chunks} sections)${p.driveUrl ? `\n${' '.repeat(23)}${p.driveUrl}` : ''}`);
  if (a.dryRun) { console.log(`\nDry run: ${plan.length} docs, nothing written.`); return; }

  const ws = a.workspace;
  if (!ws || !Number.isInteger(ws)) { console.error('--workspace <id> is required.'); process.exit(2); }
  const url = (process.env.SUPABASE_URL || 'https://your-project-ref.supabase.co').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { console.error('SUPABASE_SERVICE_ROLE_KEY is not set.'); process.exit(2); }
  const rest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  // Categories: the defaults plus whatever the plan names.
  let cats = await rest<{ id: number; name: string }[]>(`resource_categories?workspace_id=eq.${ws}&select=id,name`);
  const want = [...new Set([...(cats.length ? [] : DEFAULT_CATEGORIES), ...plan.map((p) => p.category)])];
  const missing = want.filter((n) => !cats.some((c) => c.name.toLowerCase() === n.toLowerCase()));
  if (missing.length) {
    await rest('resource_categories', { method: 'POST', body: JSON.stringify(missing.map((name, i) => ({ workspace_id: ws, name, position: cats.length + i }))) });
    cats = await rest<{ id: number; name: string }[]>(`resource_categories?workspace_id=eq.${ws}&select=id,name`);
  }
  const catId = (n: string) => cats.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id ?? null;

  const existing = await rest<{ id: number; title: string; drive_url: string | null }[]>(`resources?workspace_id=eq.${ws}&select=id,title,drive_url`);
  let added = 0; let updated = 0;
  for (const p of plan) {
    const hit = existing.find((e) => (p.driveUrl && e.drive_url === p.driveUrl) || (!p.driveUrl && e.title.toLowerCase() === p.title.toLowerCase()));
    const row = { workspace_id: ws, title: p.title, category_id: catId(p.category), pinned: p.pinned, source: 'import', drive_url: p.driveUrl, file_name: p.file, mime_type: 'text/markdown', body: p.body };
    let id: number;
    if (hit) {
      await rest(`resources?id=eq.${hit.id}`, { method: 'PATCH', body: JSON.stringify(row) });
      id = hit.id; updated++;
    } else {
      const [ins] = await rest<{ id: number }[]>('resources', { method: 'POST', body: JSON.stringify(row) });
      id = ins.id; added++;
    }
    await rest(`resource_chunks?resource_id=eq.${id}`, { method: 'DELETE' });
    const chunks = chunkText(p.title, p.body).map((c) => ({ resource_id: id, workspace_id: ws, ord: c.ord, heading: c.heading, body: c.body }));
    for (let i = 0; i < chunks.length; i += 200) await rest('resource_chunks', { method: 'POST', body: JSON.stringify(chunks.slice(i, i + 200)) });
    console.log(`${hit ? 'updated' : 'added  '} #${id} ${p.title}`);
  }
  console.log(`\n${added} added, ${updated} updated in workspace ${ws}.`);
}

if (process.argv[1] && /import-resources\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
