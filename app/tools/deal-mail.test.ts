// Deal mail rules: wholesaler blasts and assignment mail to LLC rows. Run: npx tsx tools/deal-mail.test.ts
import { dealMailKind, entityNames, streetAddresses, wholesalerRows } from '../supabase/functions/_shared/deal-mail.ts';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const blast = {
  from: 'dispo@acmehomebuyers.com',
  fromName: 'Jake at Acme',
  subject: 'OFF MARKET: 5607 Pine Ridge Dr, Memphis, TN 38118 | ARV $210k',
  text: [
    'New deal for our cash buyers.',
    '5607 Pine Ridge Dr, Memphis, TN 38118',
    'Asking $89,000. ARV $210,000. Needs a full rehab.',
    '',
    'Thanks,',
    'Jake Miller',
    'Acme Home Holdings LLC',
    '901-555-0100',
  ].join('\n'),
};
eq('blast is a blast', dealMailKind(blast), 'blast');
eq('blast signature LLC', entityNames(blast.text), ['Acme Home Holdings LLC']);
eq('blast address with city, state, zip', streetAddresses(blast.subject), [{ line1: '5607 Pine Ridge Dr', city: 'Memphis', state: 'TN', zip: '38118' }]);

const rows = wholesalerRows(11, { ...blast, at: '2026-10-30T15:00:00Z' });
eq('one row', rows.length, 1);
eq('row name and key', [rows[0].name, rows[0].name_key, rows[0].source, rows[0].kind], ['Acme Home Holdings LLC', 'acmehome', 'gmail', 'wholesaler']);
eq('row carries sender, state, address', [rows[0].email, rows[0].contact_name, rows[0].state, rows[0].meta.addresses[0]], ['dispo@acmehomebuyers.com', 'Jake at Acme', 'TN', '5607 Pine Ridge Dr, Memphis, TN, 38118']);
eq('row dated by the message', [rows[0].first_seen, rows[0].last_seen], ['2026-10-30', '2026-10-30']);

const docusign = {
  from: 'dse_na2@docusign.net',
  fromName: 'Maria Lopez via Docusign',
  subject: 'Completed: Assignment of Contract - 6122 Aspen Glen St',
  text: 'All parties have completed Assignment of Contract.\nAssignor: Bluff City Investments, LLC\nAssignee: Riverstone Capital Group Inc.\nDocuSign, Inc. 221 Main Street, Suite 1550',
};
eq('docusign is an assignment', dealMailKind(docusign), 'assignment');
const dsRows = wholesalerRows(11, docusign);
eq('both parties, not DocuSign', dsRows.map((r) => r.name), ['Bluff City Investments LLC', 'Riverstone Capital Group Inc']);
eq('assignor is the wholesaler, assignee the buyer', dsRows.map((r) => r.kind), ['wholesaler', 'buyer']);
eq('envelope sender is never the contact', dsRows.map((r) => [r.email, r.contact_name]), [[null, null], [null, null]]);

eq('ordinary mail is not deal mail', dealMailKind({ from: 'mom@gmail.com', subject: 'Dinner Sunday?', text: 'Are you coming over at 6?' }), null);
eq('a receipt with one word is not a blast', dealMailKind({ from: 'receipts@stripe.com', subject: 'Your receipt', text: 'Total $120.00 as of today' }), null);
eq('prose "Rental Properties" is not an entity', entityNames('We buy Rental Properties in any condition.'), []);
eq('filler before a name is peeled', entityNames('Regards, The Keystone Group'), ['Keystone Group']);
eq('all caps entity', entityNames('SENT BY SUMMIT PEAK PROPERTIES LLC'), ['SUMMIT PEAK PROPERTIES LLC']);
eq('brands are skipped', entityNames('Google LLC, 1600 Amphitheatre Parkway'), []);
eq('our own LLC is skipped', wholesalerRows(11, blast, new Set(['acmehome'])).length, 0);
eq('directional street', streetAddresses('Address: 77 N Main Street, Collierville TN')[0], { line1: '77 N Main Street', city: 'Collierville', state: 'TN', zip: null });
eq('a price is not an address', streetAddresses('Asking 150000 dollars'), []);
eq('not deal mail gives no rows', wholesalerRows(11, { from: 'a@b.com', subject: 'Hi', text: 'Best, Acme Holdings LLC' }), []);

// Shapes seen in the Acme Homes inbox: a TC's assignment thread and a wholesaler's emoji blast.
const tc = { from: 'tc@closingdesk.example', fromName: 'Dana Ruiz', subject: 'Re: Assignment Contract | 7409 W Gate Blvd, Austin, TX 78745',
  text: 'I will be your dedicated transaction coordinator at Example Home Buying LLC. What about the EMD from the end buyer, Kestrel Holdings LLC?' };
eq('TC thread is assignment mail', dealMailKind(tc), 'assignment');
eq('assignor side and end buyer side', wholesalerRows(11, tc).map((r) => [r.name, r.kind]), [['Example Home Buying LLC', 'wholesaler'], ['Kestrel Holdings LLC', 'buyer']]);
const emoji = { from: 'deals@sunbeltinvestments.example', fromName: 'Sunbelt Investments', subject: '\u{1F525} ATLANTA OFF-MARKET DEAL | $240K Ask | $355K ARV',
  text: 'OFF-MARKET WHOLESALE DEAL\nProperty Address: 1751 N. Olympian Way SW, Atlanta, GA 30310' };
eq('emoji blast is a blast', dealMailKind(emoji), 'blast');
eq('sender display name is the LLC', wholesalerRows(11, emoji).map((r) => [r.name, r.state]), [['Sunbelt Investments', 'GA']]);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
