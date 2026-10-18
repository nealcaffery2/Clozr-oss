// The demo's email history for the dialer's Email tab. Run: npx tsx tools/sample-mail.test.ts
import assert from 'node:assert/strict';
import { sampleEmailRows, sampleStampIso } from '../lib/sample-mail';
import { CLOZR_DATA } from '../lib/clozr-data';
import type { Communication, TimelineEntry } from '../lib/clozr-types';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  try { assert.deepEqual(got, want); console.log('ok  ', name); } catch { failed++; console.log('FAIL', name, '\n  got ', got, '\n  want', want); }
};

const now = new Date(2026, 9, 14, 11, 0); // Oct 14 2026, 11:00 local
const local = (iso: string) => { const d = new Date(iso); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };

// ---- sample stamps ----
eq('Today', local(sampleStampIso('Today 9:42 AM', now)), [10, 14, 9, 42]);
eq('Yesterday PM', local(sampleStampIso('Yesterday 3:52 PM', now)), [10, 13, 15, 52]);
eq('12 PM is noon', local(sampleStampIso('Today 12:05 PM', now)), [10, 14, 12, 5]);
eq('12 AM is midnight', local(sampleStampIso('Today 12:05 AM', now)), [10, 14, 0, 5]);
eq('Month day', local(sampleStampIso('Aug 23 · 10:04 AM', now)), [8, 23, 10, 4]);
eq('Sept spelled out', local(sampleStampIso('Sept 2 · 9:15 AM', now)), [9, 2, 9, 15]);
eq('a later month-day is last year', new Date(sampleStampIso('Dec 2 · 9:15 AM', now)).getFullYear(), 2025);
eq('unreadable falls back to now', sampleStampIso('whenever', now), now.toISOString());

// ---- Kara Mitchell's email, from the sample timeline ----
const timeline = (CLOZR_DATA as unknown as { timeline: TimelineEntry[] }).timeline;
const comms = (CLOZR_DATA as unknown as { communications: Communication[] }).communications;
const kara = sampleEmailRows({ email: 'kara.mitchell@gmail.com', sellerId: 1, mine: 'taylor@yourcompany.com' }, timeline, comms.filter((c) => c.personId === 'p1'), now);
eq('three emails with Kara', kara.length, 3);
eq('newest first', kara.map((r) => r.subject), ['Re: Your cash offer for 1803 Cypress Lane', 'Your cash offer for 1803 Cypress Lane', 'How our process works']);
eq('her reply is inbound from her address', [kara[0]!.direction, kara[0]!.from_email], ['inbound', 'kara.mitchell@gmail.com']);
eq('ours are outbound to her', [kara[1]!.direction, kara[1]!.to_email], ['outbound', 'kara.mitchell@gmail.com']);
eq('filed on her seller record', kara.every((r) => r.seller_id === 1), true);
eq('bodies carried, so the reader needs no read', kara.every((r) => !!r.body), true);

// ---- someone with only one-line email entries ----
const derek = sampleEmailRows({ email: 'derek@example.com', sellerId: 4 }, [], comms.filter((c) => c.personId === 'p4'), now);
eq('two entries for Derek', derek.length, 2);
eq('the reply keeps its Re: subject', derek[0]!.subject, 'Re: Repair breakdown');
eq('his reply is inbound', [derek[0]!.direction, derek[0]!.from_email], ['inbound', 'derek@example.com']);
eq('entries become rows ordered by minutes ago', Date.parse(derek[0]!.occurred_at) > Date.parse(derek[1]!.occurred_at), true);

// ---- nobody else's mail ----
eq('a timeline for someone else adds nothing', sampleEmailRows({ email: 'nobody@example.com' }, timeline, [], now), []);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
