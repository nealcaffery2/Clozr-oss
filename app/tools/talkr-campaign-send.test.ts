// CLOZR sellers → Talkr import rows (lib/talkr-campaign-send.ts).
// Run: npx tsx tools/talkr-campaign-send.test.ts
import assert from 'node:assert/strict';
import { importRows, type SendSeller } from '../lib/talkr-campaign-send';
import type { OtherPhone } from '../lib/seller-phones';

const s = (dbId: number, phone: string, more: Partial<SendSeller> = {}): SendSeller => ({ dbId, name: 'Pat Seller', phone, ...more });
const ph = (id: number, phone: string, position: number, more: Partial<OtherPhone> = {}): OtherPhone => ({ id, phone, position, ...more });

// Every good number, the first paired with each extra so the rows merge into one contact.
const others = new Map<number, OtherPhone[]>([[1, [ph(1, '(512) 555-0102', 2), ph(2, '512-555-0103', 3), ph(3, '5125550104', 4, { is_dnc: true }), ph(4, '5125550105', 5)]]]);
const a = importRows([s(1, '512-555-0101', { fields: { address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' } })], others);
assert.deepEqual(a.rows.map((r) => [r.phone, r.phone2]), [
  ['+15125550101', '+15125550102'],
  ['+15125550101', '+15125550103'],
  ['+15125550101', '+15125550105'],
]);
assert.equal(a.rows[0]!.address, '1 Main St');
assert.equal(a.rows[1]!.address, '', 'extra rows carry no address, so they cannot rewrite the property');

// DNC / blacklisted sellers and sellers with no good number are counted, not sent.
const b = importRows([s(2, '512-555-0199', { dnc: true }), s(3, '512-555-0198', { blacklisted: true }), s(4, ''), s(5, '512-555-0197')], new Map([[4, [ph(9, '5125550196', 2, { is_wrong: true })]]]));
assert.equal(b.dnc, 2);
assert.equal(b.noNumber, 1);
assert.deepEqual(b.rows.map((r) => [r.phone, r.phone2]), [['+15125550197', '']]);

// A blank primary: the first good other number leads.
const c = importRows([s(6, '')], new Map([[6, [ph(1, '5125550190', 2)]]]));
assert.deepEqual(c.rows.map((r) => r.phone), ['+15125550190']);

console.log('talkr-campaign-send: ok');
