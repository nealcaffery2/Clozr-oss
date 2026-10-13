// Ingest seller matching: an archived or merged seller is never the attachment.
// Run: npx tsx tools/seller-match.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergedIntoId, pickLiveSeller, resolveLiveSeller, type SellerMatchRow } from '../lib/seller-match';

const lib = readFileSync(new URL('../lib/seller-match.ts', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../supabase/functions/_shared/seller-match.ts', import.meta.url), 'utf8');
assert.equal(shared, lib, 'supabase/functions/_shared/seller-match.ts has drifted from lib/seller-match.ts');

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log('PASS', name);
};

const row = (id: number, more: Partial<SellerMatchRow> = {}): SellerMatchRow => ({ id, archived_at: null, tags: [], ...more });
const mapOf = (...rows: SellerMatchRow[]) => new Map(rows.map((r) => [r.id, r]));

// The Jotform case: deal landed on archived seller 1790, tagged merged-into-2358.
const archived = row(1790, {
  archived_at: '2026-10-01T00:00:00Z',
  tags: ['Podio deal', 'merged-into-2358', 'Wholesaler', 'Podio submission'],
  lead_stage: 'Offer Made',
  notes: 'Podio submission · Mirville Real Estate, LLC',
});
const live = row(2358, { lead_stage: 'Underwrite Declined', tags: ['Podio deal', 'Podio submission'] });

test('archived seller tagged merged-into-2358 resolves to the live seller', () => {
  assert.equal(resolveLiveSeller(1790, mapOf(archived, live)), 2358);
});

test('the archived seller itself is not a match', () => {
  const got = resolveLiveSeller(1790, mapOf(archived, live));
  assert.notEqual(got, 1790);
  assert.equal(pickLiveSeller([1790], mapOf(archived)), null);
});

test('an archived seller with no pointer is no match', () => {
  const bare = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['Podio deal'], lead_stage: 'Offer Made' });
  assert.equal(resolveLiveSeller(1790, mapOf(bare, live)), null);
});

test('a merged-into pointer in notes resolves the same way', () => {
  const noted = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['Podio deal'], notes: 'status merged-into-2358 after the partner merge' });
  assert.equal(mergedIntoId(noted), 2358);
  assert.equal(resolveLiveSeller(1790, mapOf(noted, live)), 2358);
});

test('a merged-into pointer in the status resolves the same way', () => {
  const staged = row(1790, { archived_at: '2026-10-01T00:00:00Z', lead_stage: 'merged-into-2358' });
  assert.equal(resolveLiveSeller(1790, mapOf(staged, live)), 2358);
});

test('a merge chain resolves to the live end', () => {
  const mid = row(1800, { archived_at: '2026-09-01T00:00:00Z', tags: ['merged-into-2358'] });
  const start = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['merged-into-1800'] });
  assert.equal(resolveLiveSeller(1790, mapOf(start, mid, live)), 2358);
});

test('a cycle is no match', () => {
  const a = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['merged-into-2358'] });
  const b = row(2358, { archived_at: '2026-10-02T00:00:00Z', tags: ['merged-into-1790'] });
  assert.equal(resolveLiveSeller(1790, mapOf(a, b)), null);
});

test('a pointer at itself is no match', () => {
  const a = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['merged-into-1790'] });
  assert.equal(resolveLiveSeller(1790, mapOf(a)), null);
});

test('a pointer at a seller that is not loaded is no match', () => {
  assert.equal(resolveLiveSeller(1790, mapOf(archived)), null);
});

test('a live seller with no pointer is the match', () => {
  assert.equal(resolveLiveSeller(2358, mapOf(archived, live)), 2358);
});

test('a seller that still carries a pointer is not the match, even when not archived', () => {
  const pointed = row(1790, { archived_at: null, tags: ['merged-into-2358'] });
  assert.equal(resolveLiveSeller(1790, mapOf(pointed, live)), 2358);
});

test('the tag wins when notes name a different seller', () => {
  const mixed = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['merged-into-2358'], notes: 'merged-into-999' });
  assert.equal(mergedIntoId(mixed), 2358);
});

test('the pointer tag is case insensitive', () => {
  const tagged = row(1790, { archived_at: '2026-10-01T00:00:00Z', tags: ['Merged-Into-2358'] });
  assert.equal(resolveLiveSeller(1790, mapOf(tagged, live)), 2358);
});

test('a chain longer than the hop limit is no match, not an archived middle', () => {
  const rows: SellerMatchRow[] = [];
  for (let id = 1; id <= 9; id++) {
    rows.push(row(id, id === 9 ? {} : { archived_at: '2026-01-01', tags: [`merged-into-${id + 1}`] }));
  }
  assert.equal(resolveLiveSeller(1, mapOf(...rows)), null);
});

test('a chain of eight that ends on a live seller resolves', () => {
  const rows: SellerMatchRow[] = [];
  for (let id = 1; id <= 8; id++) {
    rows.push(row(id, id === 8 ? {} : { archived_at: '2026-01-01', tags: [`merged-into-${id + 1}`] }));
  }
  assert.equal(resolveLiveSeller(1, mapOf(...rows)), 8);
});

test('among candidates, the first one that resolves wins, and an archived-only list follows the pointer', () => {
  const other = row(50, {});
  assert.equal(pickLiveSeller([50, 1790], mapOf(archived, live, other)), 50);
  assert.equal(pickLiveSeller([1790], mapOf(archived, live)), 2358);
  assert.equal(pickLiveSeller([1790], mapOf(row(1790, { archived_at: '2026-01-01' }))), null);
});

console.log(`${passed} passed`);
