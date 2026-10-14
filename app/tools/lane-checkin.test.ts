// Lane's 9am check-in: which TC lines are late or due, what got done since
// yesterday, and the plain-facts note (supabase/functions/_shared/lane-checkin.ts).
import { cleanVerdicts, fallbackCheckin, fileState, fireKeys, fireNote, isLiveDeal, quietKeys, snapshotOf, winsSince } from '../supabase/functions/_shared/lane-checkin';
import { tcChecklists } from '../supabase/functions/_shared/tc-checklists';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); } else console.log(`PASS  ${name}`);
};

const tpl = tcChecklists.assignment;
const d1 = tpl.phases.flatMap((p) => p.tasks).filter((t) => t.day === 'D1');
const file = { id: 7, address: '12 Oak St', seller: 'Ann', contract_date: '2026-10-01', close_date: '2026-10-20', checklist: {} };

const s = fileState(file, tpl, '2026-10-05');
const d8 = fileState(file, tpl, '2026-10-09');
eq('day marker counts from the contract date', s.dayMarker, 'D4');
eq('her D1 lines are late on D4', d1.filter((t) => t.owner === 'TC').every((t) => s.overdue.some((o) => o.id === t.id)), true);
eq('a late line someone else owns is waiting on them, not hers', s.overdue.every((t) => t.owner === 'TC') && s.waitingOn.every((t) => t.owner !== 'TC'), true);
eq('nothing ticked, nothing done', s.doneIds, []);

const ticked = fileState({ ...file, checklist: Object.fromEntries(d1.map((t) => [t.id, true])) }, tpl, '2026-10-05');
eq('a ticked line is not late', d1.some((t) => ticked.overdue.some((o) => o.id === t.id)), false);
eq('wins: lines ticked since the snapshot', winsSince([ticked], snapshotOf([s]), () => tpl).length, d1.length);
eq('no snapshot yet, no wins claimed', winsSince([ticked], null, () => tpl), []);

const close = fileState({ ...file, close_date: '2026-10-07' }, tpl, '2026-10-05');
eq('close week counts back from close', close.dayMarker, 'T-2');

eq('fires are critical late lines only', fireKeys([s]).every((f) => f.task.critical), true);
eq('fire keys name the file and the line', fireKeys([s])[0]?.key.startsWith('7:'), true);

const note = fallbackCheckin('Casey Park', [d8], [{ address: '9 Elm', task: 'Order title' }]);
eq('the note greets the TC by first name', note.includes("Mornin', Casey"), true);
eq('the note compliments what got done', note.includes('Tip of the hat'), true);
eq('the note lists the late file', note.includes('12 Oak St'), true);
eq('the note keeps waiting lines apart from hers', note.includes('Waiting on other folks'), true);
eq('a clean board says so', fallbackCheckin('Casey', [ticked].map((f) => ({ ...f, overdue: [], waitingOn: [], dueToday: [] })), []).includes('on track'), true);
eq('one fire names the address', fireNote('Casey', fireKeys([s]).slice(0, 1)).title.includes('12 Oak St'), true);

// Live deals only.
eq('a deal in escrow is live', isLiveDeal({ stage: 'In Escrow', archived_at: null, closed_on: null }), true);
eq('a terminated deal is not', isLiveDeal({ stage: 'Terminated', archived_at: null, closed_on: null }), false);
eq('an archived deal is not', isLiveDeal({ stage: 'Ready To Market', archived_at: '2026-10-01', closed_on: null }), false);
eq('a closed deal is not', isLiveDeal({ stage: 'Buyer Under Contract', archived_at: null, closed_on: '2026-10-02' }), false);
eq('no deal is not', isLiveDeal(null), false);
eq('a deal marked terminated is not', isLiveDeal({ stage: 'In Escrow', terminated: true }), false);

// Title owns "receive the title commitment": late on D8, it is waiting on title.
eq('title commitment receipt is waiting on title', d8.waitingOn.some((t) => t.owner === 'Title'), true);
eq('waiting lines never fire', fireKeys([d8]).some((f) => f.task.owner !== 'TC'), false);

// The 9am read quiets lines stuck on someone else or already done.
const firstFire = fireKeys([s])[0]!;
const verdicts = cleanVerdicts([
  { key: firstFire.key, verdict: 'waiting', why: 'Emailed title Oct 3, no reply' },
  { key: '999:a1', verdict: 'waiting', why: 'not a file it was shown' },
  { key: firstFire.key, verdict: 'nonsense' },
], [s]);
eq('verdicts keep only known lines and real verdicts', verdicts.length, 1);
eq('a waiting line does not fire', fireKeys([s], quietKeys(verdicts)).some((f) => f.key === firstFire.key), false);
eq('needs_tc still fires', fireKeys([s], quietKeys([{ key: firstFire.key, verdict: 'needs_tc', why: '' }])).some((f) => f.key === firstFire.key), true);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); } else console.log('\nall passed');
