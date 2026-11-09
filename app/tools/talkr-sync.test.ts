// lib/talkr-sync.ts: which Talkr messages a mirror pass updates in place and
// which it inserts. Run with:  npx tsx tools/talkr-sync.test.ts
import { movedMessages, threadMark, threadMoved } from '../lib/talkr-sync';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// The cursor saw m1 as queued; m2 (sent from CLOZR, row written on send),
// m3 (typed in Talkr's own UI) and m4 (an inbound reply) are new to it.
const cursor = { m1: 'queued' };
const have = new Set(['msg:m1', 'msg:m2']);
const moved = movedMessages(cursor, ['m1', 'm2', 'm3', 'm4'], have);
eq('a seen message whose status moved is updated', moved.includes('m1'), true);
eq('a first-seen text that already has its row is updated, not re-inserted', moved.includes('m2'), true);
eq('a first-seen text with no row is inserted (a text sent from Talkr itself)', moved.includes('m3'), false);
eq('a first-seen inbound with no row is inserted', moved.includes('m4'), false);
eq('nothing seen and nothing on file means everything is inserted', movedMessages({}, ['a', 'b'], new Set()), []);
eq('the order of the pass is kept', movedMessages({ b: 'sent', a: 'sent' }, ['a', 'b'], new Set()), ['a', 'b']);

// The thread cursor: a delivery receipt moves no time but still re-reads the thread.
const conv = { id: 'c1', last_message_at: '2026-10-14T19:00:00Z', last_message: { status: 'sent' } };
eq('an unseen thread moved', threadMoved({}, conv), true);
eq('a thread at its mark did not move', threadMoved({ c1: threadMark(conv) }, conv), false);
eq('a status change alone moves it', threadMoved({ c1: threadMark(conv) }, { ...conv, last_message: { status: 'delivered' } }), true);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('talkr-sync ok');
