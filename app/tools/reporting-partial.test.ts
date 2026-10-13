// The first load's reporting rows carry no offers, money columns or full call
// history. Until the full read lands (or if it fails) Overview and Home say so
// instead of showing those figures as zero. Run: npx tsx tools/reporting-partial.test.ts
import assert from 'node:assert/strict';
import { buildReport, homeKpis, type ReportRaw } from '../lib/reporting';

const NOW = new Date(2026, 9, 10, 12, 0, 0);
const raw: ReportRaw = {
  members: [{ id: 'u1', name: 'Sam', role: 'owner' }],
  sellers: [{ id: 1, name: 'A', created_at: new Date(NOW.getTime() - 86_400_000).toISOString(), source: 'PPC', assigned_to: 'u1', stage: 'New Lead', address: '1 Main' }],
  deals: [], comms: [], commsCapped: false, offers: [], contracts: [], matches: [], buyers: [], transactions: [],
} as unknown as ReportRaw;

const tile = (blocks: ReturnType<typeof buildReport>, k: string) => {
  const kpis = blocks.find((b) => b.kind === 'kpis');
  return kpis && kpis.kind === 'kpis' ? kpis.items.find((i) => i.k === k)?.v : undefined;
};

// Complete: no note, real zeros.
let b = buildReport('Overview', '30 Days', raw, { admin: true, now: NOW });
assert.notEqual(b[0].kind, 'note');
assert.equal(tile(b, 'Offers sent'), '0');
assert.equal(tile(b, 'New leads'), '1');

// Loading: a note first, the held tiles read '…', the rest stay real.
b = buildReport('Overview', '30 Days', { ...raw, partial: 'loading' }, { admin: true, now: NOW });
assert.equal(b[0].kind, 'note');
assert.equal(tile(b, 'Offers sent'), '…');
assert.equal(tile(b, 'Leads contacted'), '…');
assert.equal(tile(b, 'Net profit'), '…');
assert.equal(tile(b, 'New leads'), '1');

// Failed: a note saying so, and '—' rather than zero.
b = buildReport('Overview', '30 Days', { ...raw, partial: 'failed' }, { admin: true, now: NOW });
assert.ok(b[0].kind === 'note' && /did not load/.test(b[0].title));
assert.equal(tile(b, 'Offers sent'), '—');

// Every tab gets the note while loading.
for (const tab of ['Acquisitions', 'Calls', 'Closings']) {
  assert.equal(buildReport(tab, '30 Days', { ...raw, partial: 'loading' }, { admin: true, now: NOW })[0].kind, 'note', tab);
}

// Home: offers today held, not zero.
assert.equal(homeKpis({ ...raw, partial: 'loading' }, undefined, NOW).find((k) => k.k === 'Offers sent today')?.v, '…');
assert.equal(homeKpis(raw, undefined, NOW).find((k) => k.k === 'Offers sent today')?.v, '0');

console.log('reporting-partial: ok');
