// Buyers at one company: colleague detection and org-chart ranks.  Run:  npx tsx tools/buyer-company.test.ts
import assert from 'node:assert/strict';
import { companyDomain, companyKey, pickDuplicate } from '../lib/quick-add-dupes';
import { seniority } from '../app/components/buyer/CompanyChart';

assert.equal(companyDomain('abrooks@SummitBuyers.com'), 'summitbuyers.com');
assert.equal(companyDomain('someone@gmail.com'), null, 'personal mail is not a company');
assert.equal(companyKey('Summit Buyers, LLC'), companyKey('summit buyers'));

const jon = { id: 539, name: 'Jonathan Miller', phone: '+13035557195', email: 'jmiller@summitbuyers.com', company: 'Summit Buyers' };
// Andrea at the same company, matched only by company: a colleague, offered as her own contact.
const byCo = pickDuplicate('buyer', 'Andrea Brooks', { phone: [], email: [], address: [], company: [jon] });
assert.ok(byCo && byCo.by === 'company' && byCo.colleague && byCo.company === 'Summit Buyers');
// Same office phone, different person: still a colleague, and the shared phone is reported.
const byPhone = pickDuplicate('buyer', 'Andrea Brooks', { phone: [jon], email: [], address: [] });
assert.ok(byPhone && byPhone.by === 'phone' && byPhone.colleague && byPhone.phone === jon.phone);
// Jonathan typed again: a real duplicate, not a colleague.
const same = pickDuplicate('buyer', 'Jonathan Miller', { phone: [], email: [jon], address: [] });
assert.ok(same && !same.colleague);
assert.equal(pickDuplicate('buyer', 'Nobody', { phone: [], email: [], address: [], company: [] }), null);

assert.equal(seniority('CEO'), 0);
assert.equal(seniority('Director of Acquisitions'), 1);
assert.equal(seniority('Acquisitions Manager'), 2);
assert.equal(seniority('Acquisitions'), 3);
assert.equal(seniority(null), 3);
console.log('buyer-company ok');
