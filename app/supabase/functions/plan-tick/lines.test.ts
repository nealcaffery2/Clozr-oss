// Plan text rotation: when it is on, which line, which version.
// Run:  deno run --allow-env supabase/functions/plan-tick/lines.test.ts
import { LINE_DAILY_CAP, ROTATE_OVER, lineCap, pickLine, pickVersion, rotationOn } from './lines.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FAIL  ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`PASS  ${name}`);
}

eq('off at the threshold', rotationOn(undefined, ROTATE_OVER), false);
eq('on over the threshold', rotationOn(undefined, ROTATE_OVER + 1), true);
eq('forced on for a small plan', rotationOn(true, 3), true);
eq('forced off for a big plan', rotationOn(false, 5000), false);

const lines = [{ id: 'a', e164: '+12105550001', sent: 40 }, { id: 'b', e164: '+12105550002', sent: 12 }, { id: 'c', e164: '+12105550003', sent: LINE_DAILY_CAP }];
eq('least-used line under the cap', pickLine(lines, LINE_DAILY_CAP)?.id, 'b');
eq('stays on the line they already hear from', pickLine(lines, LINE_DAILY_CAP, '(210) 555-0001')?.id, 'a');
eq('their line is full: the least-used one', pickLine(lines, LINE_DAILY_CAP, '+12105550003')?.id, 'b');
eq('not one of ours: the least-used one', pickLine(lines, LINE_DAILY_CAP, '+19995550000')?.id, 'b');
eq('every line full',pickLine(lines.map((l) => ({ ...l, sent: LINE_DAILY_CAP })), LINE_DAILY_CAP), null);

const local = [{ id: 'tx', e164: '+12105550001', sent: 0 }, { id: 'nash', e164: '+16155550002', sent: 50 }, { id: 'mem', e164: '+19015550003', sent: 10 }, { id: 'atl', e164: '+14045550004', sent: 90 }];
eq('a line in their area code', pickLine(local, LINE_DAILY_CAP, null, '(615) 555-1234')?.id, 'nash');
eq('no area code match: a line in their state', pickLine(local, LINE_DAILY_CAP, null, '+14235551234')?.id, 'mem');
eq('their area code line is full: their state', pickLine(local.map((l) => l.id === 'nash' ? { ...l, sent: LINE_DAILY_CAP } : l), LINE_DAILY_CAP, null, '+16155551234')?.id, 'mem');
eq('nothing local: the least-used line', pickLine(local, LINE_DAILY_CAP, null, '+13035551234')?.id, 'tx');
eq('the line they already hear from beats a local one', pickLine(local, LINE_DAILY_CAP, '+14045550004', '+16155551234')?.id, 'atl');

const day = 86_400_000; const t0 = Date.parse('2026-10-20T15:00:00Z');
eq('a line never used starts at 50', lineCap(null, t0), 50);
eq('ramp by age', [1, 4, 10, 20].map((d) => lineCap(new Date(t0 - d * day).toISOString(), t0)), [50, 100, 150, LINE_DAILY_CAP]);
eq('a new line at its ramp cap is skipped', pickLine([{ id: 'new', e164: '+16155550002', sent: 50, cap: 50 }, { id: 'old', e164: '+12105550001', sent: 120, cap: LINE_DAILY_CAP }], LINE_DAILY_CAP, null, '+16155551234')?.id, 'old');
eq('their own line at its ramp cap: another line', pickLine([{ id: 'new', e164: '+16155550002', sent: 50, cap: 50 }, { id: 'old', e164: '+12105550001', sent: 120 }], LINE_DAILY_CAP, '+16155550002')?.id, 'old');

const three = 'Hey {{first_name}}, version one.\n---\nHi {{first_name}}, version two.\n  ---  \n{{first_name}}, version three.';
eq('one body is left alone', pickVersion('Just one text', 7), 'Just one text');
eq('versions by enrolment id', [0, 1, 2, 3].map((id) => pickVersion(three, id)), [
  'Hey {{first_name}}, version one.', 'Hi {{first_name}}, version two.', '{{first_name}}, version three.', 'Hey {{first_name}}, version one.',
]);
eq('at most three versions', pickVersion('a\n---\nb\n---\nc\n---\nd', 3), 'a');
eq('a dash inside a sentence is not a split', pickVersion('Price is 100k---firm', 1), 'Price is 100k---firm');

if (failed) { console.error(`\n${failed} failed`); Deno.exit(1); }
console.log('\nlines: ok');
