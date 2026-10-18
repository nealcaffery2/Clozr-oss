// Leads | Submissions on the People rail. Run: npx tsx tools/people-side.test.ts
import { DEFAULT_PEOPLE_SIDE, noteSide, peopleSideFor, readPeopleSide, sideLanding } from '../lib/people-side';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// The half shown.
eq('Partnerships sees submissions whatever the list', peopleSideFor({ sellerLists: false, listSide: 'leads', remembered: 'leads' }), 'submissions');
eq('a submission list shows submissions', peopleSideFor({ sellerLists: true, listSide: 'submissions', remembered: 'leads' }), 'submissions');
eq('a lead list shows leads', peopleSideFor({ sellerLists: true, listSide: 'leads', remembered: 'submissions' }), 'leads');
eq('a vendor list keeps the half last picked', peopleSideFor({ sellerLists: true, listSide: null, remembered: 'submissions' }), 'submissions');

// Where a switch lands.
const mem = { side: 'leads' as const, last: { submissions: 'Underwriting', leads: 'Hot Leads' } };
eq('the list last open on that half', sideLanding('submissions', mem, ['New Submissions', 'Underwriting']), 'Underwriting');
eq('a list that is gone falls back to the first', sideLanding('leads', mem, ['My Leads', 'New Leads']), 'My Leads');
eq('nothing remembered lands on the first', sideLanding('submissions', DEFAULT_PEOPLE_SIDE, ['New Submissions']), 'New Submissions');
eq('an empty half lands nowhere', sideLanding('leads', DEFAULT_PEOPLE_SIDE, []), null);

// Noting the open list.
const same = noteSide(mem, 'leads', 'Hot Leads');
eq('no change hands back the same memory', same === mem, true);
eq('a new list is kept for its half', noteSide(mem, 'submissions', 'Offer Made'), { side: 'submissions', last: { submissions: 'Offer Made', leads: 'Hot Leads' } });

// Stored blobs.
eq('nothing stored is leads', readPeopleSide(null), DEFAULT_PEOPLE_SIDE);
eq('a bad blob is leads', readPeopleSide('{not json'), DEFAULT_PEOPLE_SIDE);
eq('a stored half reads back', readPeopleSide(JSON.stringify({ side: 'submissions', last: { submissions: 'Underwriting' } })), { side: 'submissions', last: { submissions: 'Underwriting' } });
eq('an unknown half and bad lists are dropped', readPeopleSide(JSON.stringify({ side: 'map', last: { map: 'x', leads: 7, submissions: '' } })), { side: 'leads', last: {} });

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
