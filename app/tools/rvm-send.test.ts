// The bulk RVM pre-send check (lib/rvm-send.ts).
// Run: npx tsx tools/rvm-send.test.ts
import { personKey, previewSend, previewSentence, type PreviewLine, type PreviewPerson } from '../lib/rvm-send';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Thursday 2026-10-08, 15:00 UTC = 11am Eastern, 10am Central, 8am Pacific.
const now = new Date('2026-10-08T15:00:00Z');
const seller = (id: number, extra: Partial<PreviewPerson> = {}): PreviewPerson => ({ kind: 'seller', id, state: 'SC', ...extra });
const phones = (rows: [number, string | null][]) => Object.fromEntries(rows.map(([id, p]) => [personKey('seller', id), p]));

// ---- skips, in rvm-tick's order
{
  const people = [
    seller(1),
    seller(2, { tags: ['DNC'] }),
    seller(3, { blacklisted: true, tags: ['DNC'] }),
    seller(4, { last_drop_at: '2026-10-07T15:00:00Z' }),
    seller(5, { last_talk_at: '2026-10-05T15:00:00Z' }),
    seller(6, { pending: 1 }),
  ];
  const p = previewSend({ phones: phones([[1, '+18035550101'], [2, '+18035550102'], [3, '+18035550103'], [4, '+18035550104'], [5, '+18035550105'], [6, '+18035550106'], [7, null]]), people, lines: [], now });
  eq('one goes now', p.now, 1);
  eq('skips by reason', p.skipped, { do_not_call: 1, blacklisted: 1, recent_drop: 1, recent_talk: 1, already_queued: 1, no_phone: 1 });
  eq('no pool flagged', p.noPool, true);
  eq('sentence', previewSentence(p), '1 goes out now · 6 skipped (1 do not call, 1 blacklisted, 1 dropped on in the last 3 days, 1 spoken with in the last 7 days, 1 a voicemail is already on the way, 1 no phone number)');
}

// ---- a shared phone gets one drop
{
  const p = previewSend({ phones: phones([[1, '+18035550101'], [2, '(803) 555-0101']]), people: [seller(1), seller(2)], lines: [], now });
  eq('shared phone: one now, one skipped', [p.now, p.skipped.already_queued], [1, 1]);
}

// ---- quiet hours by the recipient's zone: 8am Pacific is open, 5am Hawaii is not
{
  const early = new Date('2026-10-08T14:30:00Z'); // 7:30am Pacific, 10:30am Eastern
  const p = previewSend({
    phones: phones([[1, '+18035550101'], [2, '+14155550102']]),
    people: [seller(1, { state: 'SC' }), seller(2, { state: 'CA' })],
    lines: [], now: early,
  });
  eq('SC now, CA waits', [p.now, p.later], [1, 1]);
  eq('CA opens at 8am Pacific', p.laterFrom, '2026-10-08T15:00:00.000Z');
  eq('the waiting one has no line taken', p.people[1], { key: 'seller:2', action: 'later', reason: 'outside_window', until: '2026-10-08T15:00:00.000Z', tier: null });
}

// ---- Sunday holds everyone
{
  const sunday = new Date('2026-10-11T16:00:00Z');
  const p = previewSend({ phones: phones([[1, '+18035550101']]), people: [seller(1)], lines: [], now: sunday });
  eq('Sunday waits for Monday 8am Eastern', [p.later, p.laterFrom], [1, '2026-10-12T12:00:00.000Z']);
}

// ---- the pool: local presence, warm-up caps, retired and flagged lines
{
  const lines: PreviewLine[] = [
    { phone_e164: '+18035550900', market_state: 'SC', ramp_started_at: '2026-10-08', used_today: 24 }, // day 0: cap 25, one left
    { phone_e164: '+14045550900', market_state: 'GA', ramp_started_at: null, used_today: 0 },
    { phone_e164: '+19725550900', market_state: 'TX', retired_at: '2026-10-01T00:00:00Z' },
    { phone_e164: '+12105550900', market_state: 'TX', grade: 'at_risk' },
  ];
  const people = [seller(1, { state: 'SC' }), seller(2, { state: 'SC' }), seller(3, { state: 'TX' })];
  const p = previewSend({ phones: phones([[1, '+18035550101'], [2, '+18035550102'], [3, '+12145550103']]), people, lines, now });
  eq('retired and at-risk lines carry nothing', p.poolLines, 2);
  eq('first SC drop gets the SC line (its own 803), the second a neighbour (GA)', p.people.map((x) => x.action === 'now' ? x.tier : x.action), ['area_code', 'neighbor', 'any']);
  eq('TX has no local line', p.noLocalLine, { TX: 1 });
  eq('all three go now', p.now, 3);
}
{
  const lines: PreviewLine[] = [{ phone_e164: '+18035550900', market_state: 'SC', ramp_started_at: '2026-10-08', used_today: 25 }];
  const p = previewSend({ phones: phones([[1, '+18035550101']]), people: [seller(1)], lines, now });
  eq('a full pool holds the drop for tomorrow', [p.now, p.later, p.overCap], [0, 1, 1]);
  eq('pool sentence', previewSentence(p), "0 go out now · 1 wait for tomorrow: the pool's warm-up caps are full today");
}

// ---- buyers: the first market state picks the zone and the line
{
  const p = previewSend({
    phones: { [personKey('buyer', 9)]: '+12145550109' },
    people: [{ kind: 'buyer', id: 9, markets: ['Columbia, SC'], wants_calls: true }],
    lines: [{ phone_e164: '+18035550900', market_state: 'SC', used_today: 0 }], now,
  });
  eq('buyer in SC markets gets the SC line', p.people[0], { key: 'buyer:9', action: 'now', tier: 'state' });
  const off = previewSend({ phones: { [personKey('buyer', 9)]: '+12145550109' }, people: [{ kind: 'buyer', id: 9, wants_calls: false }], lines: [], now });
  eq('a buyer who asked not to be called is do not call', off.skipped, { do_not_call: 1 });
}

// ---- a pool with no usable line holds every drop, like the tick
{
  const p = previewSend({
    phones: phones([[1, '+18035550101']]), people: [seller(1)],
    lines: [{ phone_e164: '+18035550900', retired_at: '2026-10-01T00:00:00Z' }, { phone_e164: '+18035550901', paused: true }], now,
  });
  eq('all retired or paused: held, not "now", and not "no pool"', [p.now, p.later, p.noLine, p.noPool], [0, 1, 1, false]);
  eq('sentence says why', previewSentence(p), '0 go out now · 1 wait for a healthy pool line: every RVM line is retired, paused or flagged');
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
