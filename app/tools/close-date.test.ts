import assert from 'node:assert/strict';
import { closeBadge, closeDayLabel, closeSortKey, needsCloseDate } from '../lib/close-date';

// Friday Oct 9 2026, mid-afternoon local time.
const now = new Date(2026, 9, 9, 15, 30);

assert.equal(closeDayLabel('2026-10-21', now), 'Wed Oct 21');
assert.equal(closeDayLabel('2027-01-04', now), 'Mon Jan 4, 2027');
assert.equal(closeDayLabel('nope', now), '');

// Open deals: days left, tomorrow, today, late.
assert.deepEqual(closeBadge({ scheduled: '2026-10-21', stage: 'In Escrow' }, now), { tone: 'upcoming', label: 'Closes Wed Oct 21', detail: 'in 12 days', title: 'Scheduled close 2026-10-21' });
assert.equal(closeBadge({ scheduled: '2026-10-12', stage: 'In Escrow' }, now)!.tone, 'soon');
assert.equal(closeBadge({ scheduled: '2026-10-12', stage: 'In Escrow' }, now)!.detail, 'in 3 days');
assert.equal(closeBadge({ scheduled: '2026-10-10', stage: 'In Escrow' }, now)!.detail, 'Tomorrow');
assert.deepEqual(closeBadge({ scheduled: '2026-10-09', stage: 'In Escrow' }, now), { tone: 'today', label: 'Closes today', detail: 'Fri Oct 9', title: 'Scheduled close 2026-10-09' });
const late = closeBadge({ scheduled: '2026-10-06', stage: 'Ready To Market' }, now)!;
assert.equal(late.tone, 'late');
assert.equal(late.label, 'Due Tue Oct 6');
assert.equal(late.detail, '3 days late');
assert.equal(closeBadge({ scheduled: '2026-10-08', stage: 'In Escrow' }, now)!.detail, '1 day late');

// Closed deals show when they closed, not the schedule.
assert.equal(closeBadge({ scheduled: '2026-10-01', closedOn: '2026-10-03', stage: 'Closed' }, now)!.label, 'Closed Sat Oct 3');
assert.equal(closeBadge({ scheduled: '2026-10-01', stage: 'Closed' }, now)!.label, 'Closed Thu Oct 1');
assert.equal(closeBadge({ stage: 'Closed' }, now)!.label, 'Closed');

// Missing: loud on contract stages, silent before contract and on dead deals.
assert.equal(closeBadge({ stage: 'Buyer Under Contract' }, now)!.tone, 'missing');
assert.equal(closeBadge({ stage: 'Ready To Market' }, now)!.tone, 'missing');
assert.equal(closeBadge({ stage: 'Prospect' }, now), null);
assert.equal(closeBadge({ stage: 'Terminated', scheduled: '2026-09-09' }, now), null);
assert.equal(closeBadge({ stage: 'Realtor Referral', scheduled: '2026-08-20' }, now), null);
assert.equal(needsCloseDate('Under Contract Seller'), true);
assert.equal(needsCloseDate('Prospect'), false);

// A timestamp still reads as its calendar day.
assert.equal(closeBadge({ scheduled: '2026-10-21T00:00:00+00:00', stage: 'In Escrow' }, now)!.detail, 'in 12 days');

// Sorting: soonest first, undated last.
assert.ok(closeSortKey('2026-10-12') < closeSortKey('2026-10-21'));
assert.equal(closeSortKey(null), Number.MAX_SAFE_INTEGER);

console.log('close-date ok');
