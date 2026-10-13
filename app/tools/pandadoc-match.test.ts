// Run with:  npx tsx tools/pandadoc-match.test.ts
import assert from 'node:assert/strict';
import { addressScore, formatPacket, guessKindFromName, pickPacket, pickPerson, recipientEmails, sharedLinks, webhookFields } from '../lib/pandadoc-match';

assert.equal(guessKindFromName('Acme Homes Cash Offer Letter'), 'offer');
assert.equal(guessKindFromName('TX Residential Purchase Agreement'), 'psa');
assert.equal(guessKindFromName('Assignment of Contract — 123 Oak'), 'assignment');

assert.deepEqual(recipientEmails({
  recipients: [{ email: 'A@Home.com' }, { email: 'a@home.com' }, { email: 'nope' }],
}), ['a@home.com']);

assert.ok(addressScore('Cash Offer $186,000 - 123 Oakview Drive', '123 Oakview Drive, Fort Worth') >= 3);
assert.equal(addressScore('Random PSA', '123 Oakview Drive'), 0);

assert.equal(formatPacket([{ name: 'Seller.Name', value: 'Kara' }, { name: 'Offer.Amount', value: '$186,000' }]), 'Seller.Name: Kara\nOffer.Amount: $186,000');

const packet = pickPacket(
  { name: 'Cash Offer $186,000 - 123 Oakview Drive', recipients: [{ email: 'kara@home.com' }], metadata: { clozr_offer_id: '44' } },
  [
    { id: 1, name: 'Other letter', recipients: [{ email: 'nobody@x.com' }] },
    { id: 2, name: 'Cash Offer $186,000 - 123 Oakview Drive', offer_id: 44, recipients: [{ email: 'kara@home.com' }] },
  ],
);
assert.equal(packet?.id, 2);

assert.equal(pickPacket({ name: 'Unrelated', recipients: [{ email: 'z@z.com' }] }, [{ id: 9, name: 'Cash Offer', recipients: [{ email: 'kara@home.com' }] }]), null);

const person = pickPerson(
  { name: 'Cash Offer - 123 Oakview', recipients: [{ email: 'kara@home.com' }] },
  [
    { kind: 'seller', id: 11, workspace_id: 1, email: 'kara@home.com', address: '123 Oakview Drive' },
    { kind: 'seller', id: 12, workspace_id: 1, email: 'other@home.com', address: '9 Pine' },
  ],
);
assert.equal(person?.id, 11);

assert.equal(pickPerson(
  { name: 'PSA', recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }] },
  [
    { kind: 'seller', id: 1, workspace_id: 1, email: 'a@x.com', address: '1 Main' },
    { kind: 'seller', id: 2, workspace_id: 1, email: 'b@x.com', address: '2 Main' },
  ],
), null);

const fields = webhookFields({
  recipients: [{ email: 'a@x.com', shared_link: 'https://app.pandadoc.com/document/abc' }],
  tokens: [{ name: 'Seller.Name', value: 'Kara' }],
  template: { id: 't1', name: 'Cash Offer' },
});
assert.equal(fields.template_name, 'Cash Offer');
assert.equal(fields.tokens?.[0].name, 'Seller.Name');
assert.equal(sharedLinks(fields.recipients)[0].url, 'https://app.pandadoc.com/document/abc');

console.log('pandadoc-match: ok');
