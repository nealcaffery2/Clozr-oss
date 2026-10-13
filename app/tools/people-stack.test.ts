import assert from 'node:assert/strict';
import { anyInRange, atLeastOf, listStack, moneyRange, parseDollars, shortMoney } from '../lib/people-stack';
import { historyWindow, stageEventEntry } from '../lib/stage-history';

assert.equal(parseDollars('$150,000'), 150000);
assert.equal(parseDollars('150k'), 150000);
assert.equal(parseDollars('1.2m'), 1200000);
assert.equal(parseDollars('abc'), null);
assert.equal(parseDollars(''), null);

assert.deepEqual(moneyRange('$100k–$200k'), [100000, 200000]);
assert.deepEqual(moneyRange('$500k+'), [500000, Infinity]);
assert.equal(moneyRange('Any'), null);
assert.deepEqual(moneyRange('Custom', '150k', '250k'), [150000, 250001], 'custom max is inclusive');
assert.deepEqual(moneyRange('Custom', '', '200k'), [0, 200001]);
assert.equal(moneyRange('Custom', '', ''), null, 'an empty custom range filters nothing');
assert.equal(anyInRange([90000, 180000], [100000, 200000]), true, 'a partner matches when any offer is in range');
assert.equal(anyInRange([], [0, Infinity]), false, 'no figure is outside every range');

assert.equal(atLeastOf('10+'), 10);
assert.equal(atLeastOf('Any'), 0);

assert.equal(listStack(['Pre-foreclosure', 'Probate', 'Tax delinquent'], 'Susy', 'Manual'), 3, 'three lists stack three');
assert.equal(listStack(['Podio submission', 'Multiple sources', 'Offerpad', 'Probate'], 'Offerpad', 'podio'), 1, 'bookkeeping and their own name are not lists');
assert.equal(listStack(['Probate', 'probate '], 'x', 'y'), 1, 'case and spacing do not double count');

assert.equal(shortMoney(185000), '$185k');
assert.equal(shortMoney(1250000), '$1.25m');
assert.equal(shortMoney(null), '—');

const now = new Date('2026-10-02T12:00:00Z');
assert.deepEqual(historyWindow('Ever', '', '', now), { from: null, to: null });
assert.equal(historyWindow('Last 30 days', '', '', now).from, new Date('2026-09-02T12:00:00Z').toISOString());
const custom = historyWindow('Custom', '2026-09-02', '2026-09-02', now);
assert.ok(custom.from && custom.to && Date.parse(custom.to) - Date.parse(custom.from) === 86_400_000, 'a custom day is the whole day');

const rel = (iso: string) => 'rel:' + iso.slice(0, 10);
const live = stageEventEntry({ id: 7, entityType: 'seller', entityId: 1, field: 'lead_stage', from: 'Lead', to: 'Offer Made', at: '2026-08-15T15:02:00Z', by: 'u1', backfill: false, dealLabel: null }, 's1', () => 'Sam Carter', rel);
assert.equal(live.title, 'Stage Lead → Offer Made');
assert.equal(live.who, 'Sam Carter');
assert.ok(live.body?.includes('moved by Sam Carter'));
assert.equal(live.entity, 's1');
assert.equal(live.at, '2026-08-15T15:02:00Z');
const sys = stageEventEntry({ id: 8, entityType: 'deal', entityId: 10, field: 'stage', from: null, to: 'Closed', at: '2026-07-20T00:00:00Z', by: null, backfill: true, dealLabel: '123 Main St' }, 's1', () => 'x', rel);
assert.equal(sys.title, '123 Main St · Pipeline → Closed');
assert.equal(sys.who, 'System');
assert.ok(sys.body?.includes('best one on file'));

console.log('people-stack ok');
