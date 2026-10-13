// Picking the recording an RVM plays (lib/rvm-pick.ts) and how an action plan
// RVM step stores it. Run: npx tsx tools/rvm-pick.test.ts
import { MAX_RVM_SECONDS, clipClock, droppable, pinnedGroup } from '../lib/rvm-pick';
import { stepFromRow } from '../lib/plans';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const row = (config: unknown) => ({
  id: 9, position: 0, channel: 'rvm', delay_hours: 0, delay_minutes: 0, title: 'Drop', body: 'Hi', subject: null, config: config as never,
});

eq('a pinned group is the clip\'s own', pinnedGroup(42), 'clip-42');
eq('wav, mp3 and m4a can be dropped', ['a.wav', 'b.mp3', 'c.m4a'].map((p) => droppable({ audio_path: p })), [true, true, true]);
eq('webm and script-only cannot', [droppable({ audio_path: 'a.webm' }), droppable({ audio_path: null })], [false, false]);
eq('clock', [clipClock(0), clipClock(32), clipClock(90.4), clipClock(null)], ['0:00', '0:32', '1:30', '0:00']);
eq('takes stop at 90 seconds', MAX_RVM_SECONDS, 90);

const pinned = stepFromRow(row({ library_id: 42, variant_group: 'clip-42' }));
eq('a plan step that picked a recording reads it back', pinned.libraryId, 42);
eq('...and its pinned group is not shown as a rotation group', pinned.variantGroup, undefined);
const rotating = stepFromRow(row({ variant_group: 'sellers' }));
eq('a rotating step keeps its group and has no recording', [rotating.variantGroup, rotating.libraryId], ['sellers', undefined]);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
