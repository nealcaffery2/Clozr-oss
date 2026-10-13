// Contract webhook payloads.  Run:  npx tsx tools/contract-webhooks.test.ts
import assert from 'node:assert/strict';
import { CONTRACT_EVENTS, contractWebhookPayload } from '../supabase/functions/_shared/contract-webhooks';
import { WEBHOOK_EVENTS } from '../lib/webhooks';

const row = { id: 42, workspace_id: 1, ref_number: 'CLZ-8K2P1Q', name: 'PSA - 912 Cordial Rd', kind: 'psa', status: 'sent', provider: 'clozr', deal_id: '7', seller_id: 812, buyer_id: null, body_md: 'long text', tokens: [{ name: 'x', value: 'y' }] };

const signed = contractWebhookPayload(row, 'contract.signed', { signer: { name: 'Sam Seller', email: 'sam@example.com', role: 'seller', label: 'Seller' } }, 'https://app.example/');
assert.deepEqual(signed, {
  record_type: 'contract', record_id: 42, id: 42, contract_id: 42, ref_number: 'CLZ-8K2P1Q',
  name: 'PSA - 912 Cordial Rd', contract_name: 'PSA - 912 Cordial Rd', kind: 'psa', status: 'sent', provider: 'clozr',
  deal_id: 7, seller_id: 812, buyer_id: null,
  signer: { name: 'Sam Seller', email: 'sam@example.com', role: 'Seller' },
  reason: null, fields: null, url: 'https://app.example/app?deal=7',
});
// Nothing private rides along: no body, no filled values, no signing tokens.
assert.ok(!('body_md' in signed) && !('tokens' in signed));

// The status is what the event made it, even when the row was read before the update.
assert.equal(contractWebhookPayload(row, 'contract.completed').status, 'completed');
assert.equal(contractWebhookPayload(row, 'contract.voided', { reason: 'wrong price' }).reason, 'wrong price');
assert.equal(contractWebhookPayload({ ...row, status: 'draft' }, 'contract.sent').status, 'sent');
assert.equal(contractWebhookPayload(row, 'contract.viewed').status, 'viewed');
assert.equal(contractWebhookPayload({ ...row, status: 'completed' }, 'contract.viewed').status, 'completed');
assert.equal(contractWebhookPayload(row, 'contract.expired').status, 'expired');

// No signer without a name or email; no url without a deal.
const bare = contractWebhookPayload({ ...row, deal_id: null }, 'contract.declined', { signer: { role: 'seller' } });
assert.equal(bare.signer, null);
assert.equal(bare.url, null);
assert.equal(bare.status, 'declined');

// contract.extracted lists what was read; occurred_at only when given.
const ex = contractWebhookPayload(row, 'contract.extracted', { fields: ['close_date', 'purchase_price'], occurredAt: '2026-09-30T15:00:00Z' });
assert.deepEqual(ex.fields, ['close_date', 'purchase_price']);
assert.equal(ex.occurred_at, '2026-09-30T15:00:00Z');
assert.ok(!('occurred_at' in signed));

// Every contract event can be picked in Settings.
for (const ev of CONTRACT_EVENTS) assert.ok(WEBHOOK_EVENTS.some((w) => w.name === ev), `${ev} is selectable`);

console.log('contract-webhooks ok');
