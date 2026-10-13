// The TC SOP rules: Friday closes, the 10-minute contract cap, title routing,
// the Ready To Market gate, wholesaler terms, Schedule C lights.
// Run: npx tsx tools/deal-close.test.ts
import {
  contractSla, fridayCloseWarning, isFridayIso, localIsoDay, plusBusinessDays, plusIsoDays, readScheduleC,
  readyToMarketChecks, scheduleCOverall, tcFileBlockers, titleRoute, wholesalerTerms,
} from '../lib/deal-close';
import { tcChecklists } from '../supabase/functions/_shared/tc-checklists';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Fridays: the two live ones from the audit, and the days around them.
eq('2026-10-30 is a Friday (deal 5068)', isFridayIso('2026-10-30'), true);
eq('2026-10-23 is a Friday (deal 245)', isFridayIso('2026-10-23'), true);
eq('2026-10-29 is a Thursday', isFridayIso('2026-10-29'), false);
eq('a timestamp reads by its date', isFridayIso('2026-10-30T23:30:00Z'), true);
eq('blank is not a Friday', isFridayIso(''), false);
eq('junk is not a Friday', isFridayIso('next friday'), false);
eq('no warning on a Monday', fridayCloseWarning('2026-10-26'), null);
eq('the warning names the day', /Friday, Oct 30/.test(fridayCloseWarning('2026-10-30') ?? ''), true);

// Local days, not UTC.
eq('8pm local on the 10th is the 10th', localIsoDay(new Date(2026, 9, 10, 20, 0)), '2026-10-10');
eq('just after local midnight is the new day', localIsoDay(new Date(2026, 9, 11, 0, 5)), '2026-10-11');
eq('plus days crosses a month', plusIsoDays('2026-10-30', 3), '2026-11-02');
eq('plus days over the DST change', plusIsoDays('2026-10-31', 2), '2026-11-02');
eq('5 business days from a Monday', plusBusinessDays('2026-10-12', 5), '2026-10-19');
eq('5 business days from a Friday skip the weekend', plusBusinessDays('2026-10-16', 5), '2026-10-23');

// The 10-minute contract cap.
const created = '2026-10-10T15:00:00Z';
eq('sent in 8 minutes is on time', contractSla(created, '2026-10-10T15:08:00Z')?.late, false);
eq('sent in 25 minutes is late', contractSla(created, '2026-10-10T15:25:00Z')?.late, true);
eq('late minutes are counted', contractSla(created, '2026-10-10T15:25:00Z')?.minutes, 25);
eq('not sent yet, 4 minutes in: waiting, not late', (({ late, waiting }) => ({ late, waiting }))(contractSla(created, null, new Date('2026-10-10T15:04:00Z'))!), { late: false, waiting: true });
eq('not sent yet, an hour in: late', contractSla(created, null, new Date('2026-10-10T16:00:00Z'))?.late, true);
eq('no created time, no clock', contractSla(null, null), null);

// Title routing.
eq('TX goes to its routed company', titleRoute('tx'), { kind: 'vendor', company: 'Northvale Title', contact: 'Dana Fields', why: 'TX files go to Northvale Title' });
eq('Texas spelled out routes the same', (titleRoute('Texas') as { company: string }).company, 'Northvale Title');
eq('NY is the TC\'s call', titleRoute('NY').kind, 'decide');
eq('OR is the TC\'s call', titleRoute('OR').kind, 'decide');
eq('TC decides, nothing picked', titleRoute('OR').kind === 'decide' && (titleRoute('OR') as { who: string }).who, 'TC');
eq('FL goes to the fallback', (titleRoute('FL') as { company: string }).company, 'Summit Title');
eq('no state goes to the fallback', (titleRoute(null) as { contact: string }).contact, 'Pat Morgan');

// Ready To Market.
const rtm = readyToMarketChecks({ photos: 0, access: true, titleVendor: false, executedContract: true });
eq('missing photo and title are flagged', rtm.filter((c) => !c.ok).map((c) => c.key), ['photo', 'title']);
eq('all four present pass', readyToMarketChecks({ photos: 3, access: true, titleVendor: true, executedContract: true }).every((c) => c.ok), true);

// Wholesaler terms.
eq('wholesaler terms from a contract date', wholesalerTerms('2026-10-12', 150000), { closeBy: '2026-11-02', inspectBy: '2026-10-19', emdOnePct: 1500 });
eq('no contract date, no dates', wholesalerTerms(null, null), { closeBy: null, inspectBy: null, emdOnePct: null });

// Schedule C.
const sc = readScheduleC([{ id: 'c1', text: 'Release of lien', status: 'red' }, { id: 'c2', text: 'Probate letters', status: 'green' }, { text: 'no id' }, 'junk']);
eq('Schedule C keeps valid rows only', sc.map((i) => i.id), ['c1', 'c2']);
eq('one red makes it red', scheduleCOverall(sc), 'red');
eq('all green is green', scheduleCOverall([{ id: 'a', text: 'x', status: 'green' }]), 'green');
eq('nothing listed is no light', scheduleCOverall([]), null);
eq('unknown status reads yellow', readScheduleC([{ id: 'a', text: 'x', status: 'blue' }])[0].status, 'yellow');

// TC file blockers.
const levels = (b: { level: string; text: string }[]) => b.map((x) => x.level + ' ' + x.text.split(' ').slice(0, 3).join(' '));
eq('Friday close is critical', tcFileBlockers({ closingIso: '2026-10-30', state: 'TX', titleSet: true })[0].level, 'CRITICAL');
eq('a clean TX file has nothing', tcFileBlockers({ closingIso: '2026-10-29', state: 'TX', titleSet: true }), []);
eq('no title in FL names the fallback', /Summit Title/.test(tcFileBlockers({ state: 'FL', titleSet: false })[0].text), true);
eq('OR with no title waits on the TC', tcFileBlockers({ state: 'OR', titleSet: false })[0].who, 'TC');
eq('reviewed, not signed: waiting on sign-off', levels(tcFileBlockers({ state: 'TX', titleSet: true, tcReview: 'Casey · Oct 10', signoff: null })), ['WARNING Prelim settlement statement']);
eq('signed: nothing', tcFileBlockers({ state: 'TX', titleSet: true, tcReview: 'x', signoff: 'Sam' }), []);
eq('a late contract not sent is critical', tcFileBlockers({ state: 'TX', titleSet: true, contractSla: contractSla(created, null, new Date('2026-10-10T16:00:00Z')) })[0].level, 'CRITICAL');
eq('wholesaler past 21 days warns', tcFileBlockers({ state: 'TX', titleSet: true, wholesaler: true, contractIso: '2026-10-01', closingIso: '2026-10-29' }).map((b) => b.level), ['WARNING', 'NOTE']);
eq('closed files have no blockers', tcFileBlockers({ closingIso: '2026-10-30', state: 'OR', titleSet: false, closed: true }), []);

// The SOP lines on the checklists, with their ids never reused.
const all = Object.values(tcChecklists).flatMap((c) => c.phases.flatMap((p) => p.tasks));
eq('checklist ids are unique', new Set(all.map((t) => t.id)).size, all.length);
const text = all.map((t) => t.t + ' ' + t.note).join('\n');
for (const re of [/owner of record/i, /lockbox/i, /photos.*24 h/i, /Schedule C/i, /Friday/i, /We're Funded/i, /10 min/i, /prelim(inary)? settlement/i, /21 days/i, /EMD.*1%/i, /inspections?.*5 business days/i]) {
  eq('assignment checklist covers ' + re.source, re.test(tcChecklists.assignment.phases.flatMap((p) => p.tasks).map((t) => t.t + ' ' + t.note).join('\n')), true);
}
eq('no Podio left in the checklists', /podio/i.test(text), false);
eq('no hard-coded dispo names', /Morgan|Jamie|Kay\b/.test(text), false);
eq('assignment targets a 21-day close', tcChecklists.assignment.target.includes('D21'), true);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
