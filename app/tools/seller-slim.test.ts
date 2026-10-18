// The list read drops null keys and the tail of notes (migration 284).
// A full seller row and that same row after the wire's trim must map to the
// same person, apart from notes. Run: npx tsx tools/seller-slim.test.ts
import assert from 'node:assert/strict';
import { mapSellerRow } from '../lib/crm';

/** First 240 characters, plus any Photos: or Podio stage line that starts later. Mirrors crm_seller_list_notes. */
export function listNotes(notes: string | null | undefined): string | null {
  if (notes == null || notes.trim() === '') return null;
  const head = notes.slice(0, 240);
  const tail = notes.slice(240);
  const extra = [...tail.matchAll(/Photos:[^\n]*/gi), ...tail.matchAll(/Podio stage:[^\n]*/gi)].map((m) => m[0]);
  return extra.length ? `${head}\n${extra.join('\n')}` : head;
}

/** jsonb_strip_nulls, one level of objects, recursive. Arrays keep their nulls. */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue;
      out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
}

/** What crm_sellers sends for one seller after migration 284. */
export function slimSeller(row: Record<string, unknown>): Record<string, unknown> {
  const notes = listNotes(typeof row.notes === 'string' ? row.notes : null);
  const next: Record<string, unknown> = { ...row };
  if (notes == null) delete next.notes;
  else next.notes = notes;
  return stripNulls(next) as Record<string, unknown>;
}

function comparable(row: Record<string, unknown>) {
  const person = mapSellerRow(row as never);
  const rest = { ...person };
  delete rest.notes;
  return rest;
}

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

const full = {
  id: 42, name: 'Ada Seller', email: null, phone: '2105550100', property_address: null,
  asking_price: null, motivation: null, timeline: 'Soon', condition: null, occupancy: null,
  mortgage: null, desired_close: null, decision_makers: null,
  intake: { photos: null, beds: 3, bag: { a: null, b: 'x' } },
  lead_stage: 'New Lead', stage_entered_at: null, source: null,
  created_at: '2026-01-02T00:00:00Z', created_by: null, property_id: 7, assigned_to: null,
  tags: null, updated_at: '2026-02-01T00:00:00Z', underwriter_id: null,
  last_touch_at: null, last_touch_channel: null,
  notes: 'Hello there.\n' + 'x'.repeat(400) + '\nPhotos: https://dropbox.com/scl/fo/album\nPodio stage: US\n',
  properties: {
    id: 7, line1: '1 Main', city: null, state: 'tx', zip: null, beds: null, baths: 2, sqft: null,
    year_built: null, property_type: null, apn: null, lat: null, lng: null,
  },
};

test('a stripped row maps to the same person, apart from notes', () => {
  const a = comparable(full);
  const b = comparable(slimSeller(full));
  assert.deepEqual(b, a);
});

test('the list note keeps the head and the photo and stage lines from the tail', () => {
  const notes = listNotes(full.notes as string)!;
  assert.ok(notes.startsWith('Hello there.'));
  assert.ok(notes.includes('Photos: https://dropbox.com/scl/fo/album'));
  assert.ok(notes.includes('Podio stage: US'));
  assert.ok(!notes.includes('x'.repeat(400)));
});

test('a short note is unchanged and a blank note is omitted', () => {
  assert.equal(listNotes('Just a line'), 'Just a line');
  assert.equal(listNotes('   '), null);
  assert.equal(listNotes(null), null);
});

test('missing property keys match a null embed', () => {
  const withNulls = comparable({ ...full, properties: { id: 7, line1: '1 Main', city: null, state: 'tx', zip: null, beds: null, baths: 2, sqft: null, year_built: null, property_type: null, apn: null, lat: null, lng: null } });
  const stripped = comparable(slimSeller(full));
  assert.deepEqual(stripped.property, withNulls.property);
  assert.equal(stripped.property.lat, undefined);
  assert.equal(stripped.intake && (stripped.intake as { beds?: number }).beds, 3);
  assert.equal('photos' in (stripped.intake as object), false);
});

console.log(`${passed} seller-slim tests passed`);
