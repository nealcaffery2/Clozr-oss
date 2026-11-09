// pickBlastLine: a dispo blast uses the sender's picked number first, spreads
// past 50 a day across the other lines, keeps a buyer on their line, and skips
// a line Talkr held.
// Run with:  npx tsx tools/blast-lines.test.ts
import assert from 'node:assert/strict';
import { LINE_DAILY_CAP, ROTATE_OVER, isMainLine, pickBlastLine, type Line } from '../supabase/functions/plan-tick/line-pick';

const lines = (): Line[] => [
  { id: 'mine', e164: '+12105551674', sent: 0 },
  { id: 'shared-sa', e164: '+12105550101', sent: 0 },
  { id: 'shared-ga', e164: '+14045550102', sent: 0 },
];

// The picked number goes first.
assert.equal(pickBlastLine(lines(), 'mine', null, '+12105559999')?.id, 'mine');

// Past 50 today, the rest go out on the other lines, local first.
const busy = lines();
busy[0].sent = ROTATE_OVER;
assert.equal(pickBlastLine(busy, 'mine', null, '+12105559999')?.id, 'shared-sa');
assert.equal(pickBlastLine(busy, 'mine', null, '+14045559999')?.id, 'shared-ga');

// Every other line full: the picked number keeps going up to its own cap.
const full = lines();
full[0].sent = ROTATE_OVER;
full[1].sent = LINE_DAILY_CAP;
full[2].sent = LINE_DAILY_CAP;
assert.equal(pickBlastLine(full, 'mine', null, null)?.id, 'mine');
full[0].sent = LINE_DAILY_CAP;
assert.equal(pickBlastLine(full, 'mine', null, null), null);

// A buyer who already hears from a line stays on it, even before the picked number.
assert.equal(pickBlastLine(lines(), 'mine', '(404) 555-0102', null)?.id, 'shared-ga');

// A line Talkr held this tick (not on the 10DLC campaign) is skipped.
assert.equal(pickBlastLine(lines(), 'mine', null, '+12105559999', new Set(['mine']))?.id, 'shared-sa');
assert.equal(pickBlastLine(lines(), 'mine', null, null, new Set(['mine', 'shared-sa', 'shared-ga'])), null);

// A main line (loadLines gives it cap 0 on a blast) is never used, even when picked.
const mainPicked = lines();
mainPicked[0].cap = 0;
assert.equal(pickBlastLine(mainPicked, 'mine', null, '+12105559999')?.id, 'shared-sa');
assert.equal(isMainLine('Sam Main'), true);
assert.equal(isMainLine('Company Main'), true);
assert.equal(isMainLine('Acme Homes main'), true);
assert.equal(isMainLine('Acme Homes bulk · San Antonio 1'), false);
assert.equal(isMainLine('Maintenance line'), false);

// No number picked: least used, local first.
assert.equal(pickBlastLine(lines(), null, null, '+14045559999')?.id, 'shared-ga');

console.log('blast-lines: ok');
