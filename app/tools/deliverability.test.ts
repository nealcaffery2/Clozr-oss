// Deliverability rules: SPF lookup counting, DMARC parsing, the health score,
// spam-risk scoring, the warm-up ramp and bounce parsing.
// Run with:  npx tsx tools/deliverability.test.ts
import assert from 'node:assert/strict';
import {
  type MailboxSettings, WARMUP_START, autoPauseReason, cycleOrder, dailyAllowance, dayStartUtc, dkimKeyBits, evaluateDkim, evaluateDmarc, evaluateSpf, placeDnsFixes, postmasterDaysV2, zoneOf, POSTMASTER_V2_METRICS,
  healthScore, joinTxt, limitsFor, nextWindowStart, parseBounce, parseDmarc, preflight, rampDay, refusal, repBlastAddress, repBlastAddresses, repSenderPool, spamRisk, spfLookups, withInclude,
} from '../supabase/functions/_shared/deliverability-rules';
import { type Book, linkFor, repFor } from '../supabase/functions/_shared/gmail-match';

async function main() {
  // ---- SPF lookup counting (a fake DNS)
  const zone: Record<string, string[]> = {
    'acme.com': ['google-site-verification=x', 'v=spf1 ip4:203.0.113.7 include:_spf.google.com include:mail.zendesk.com mx a ~all'],
    '_spf.google.com': ['v=spf1 include:_netblocks.google.com include:_netblocks2.google.com include:_netblocks3.google.com ~all'],
    '_netblocks.google.com': ['v=spf1 ip4:35.190.247.0/24 ~all'],
    '_netblocks2.google.com': ['v=spf1 ip6:2001:4860:4000::/36 ~all'],
    '_netblocks3.google.com': ['v=spf1 ip4:172.217.0.0/19 ~all'],
    'mail.zendesk.com': ['v=spf1 include:loop.com ~all'],
    'loop.com': ['v=spf1 include:mail.zendesk.com -all'],
  };
  const txt = async (n: string) => zone[n] ?? [];
  const l = await spfLookups('acme.com', txt);
  // include google(1) + its 3, include zendesk(1) + loop.com(1) + loop back (1, error), mx, a = 9
  assert.equal(l.count, 9, 'SPF lookups are counted recursively');
  assert.deepEqual(l.ips, ['203.0.113.7'], 'only top-level literal ip4s are "our" IPs');
  assert.ok(l.errors.some((e) => e.includes('loops')), 'include loops are reported');

  const spf = evaluateSpf('acme.com', zone['acme.com'], l, ['_spf.google.com']);
  assert.equal(spf.find((c) => c.key === 'spf')!.status, 'pass');
  assert.equal(spf.find((c) => c.key === 'spf_lookups')!.status, 'warn', '9 of 10 is a warning');
  const missing = evaluateSpf('b.com', ['v=spf1 include:sendgrid.net ?all'], { count: 1, errors: [] }, ['_spf.google.com']);
  assert.equal(missing[0].status, 'fail');
  assert.equal(missing[0].fix!.value, 'v=spf1 include:sendgrid.net include:_spf.google.com ~all', 'the fix merges into the existing record');
  assert.equal(evaluateSpf('c.com', ['v=spf1 a ~all', 'v=spf1 mx ~all'], { count: 2, errors: [] }, [])[0].status, 'fail', 'two SPF records fail');
  assert.equal(evaluateSpf('d.com', [], { count: 0, errors: [] }, ['_spf.google.com'])[0].fix!.value, 'v=spf1 include:_spf.google.com ~all');
  assert.equal(withInclude('v=spf1 mx -all', '_spf.google.com'), 'v=spf1 mx include:_spf.google.com -all');
  assert.equal(joinTxt('"v=spf1 include:a" " -all"'), 'v=spf1 include:a -all', 'split TXT strings join');
  // ---- Postmaster v2 domainStats:query rows fold into one day each (v1 trafficStats is retired)
  const pmDays = postmasterDaysV2([
    { metric: 'spam', value: { doubleValue: 0.0012 }, date: { year: 2026, month: 10, day: 12 } },
    { metric: 'spf', value: { doubleValue: 1 }, date: { year: 2026, month: 10, day: 12 } },
    { metric: 'dkim', value: { floatValue: 0.99 }, date: { year: 2026, month: 10, day: 12 } },
    { metric: 'dmarc', value: { doubleValue: 98.5 }, date: { year: 2026, month: 10, day: 12 } },
    { metric: 'errors', value: { doubleValue: 0.02 }, date: { year: 2026, month: 10, day: 12 } },
    { metric: 'spam', value: { doubleValue: 0 }, date: { year: 2026, month: 10, day: 3 } },
    { metric: 'spam', value: {}, date: { year: 2026, month: 10, day: 4 } },
    { metric: 'spam', value: { doubleValue: 0.5 } },
  ]);
  assert.deepEqual(pmDays.map((d) => d.date), ['2026-10-03', '2026-10-04', '2026-10-12'], 'one row per date, oldest first; rows without a date are dropped');
  assert.deepEqual(pmDays[2], { date: '2026-10-12', reputation: null, spam: 0.0012, spf: 1, dkim: 0.99, dmarc: 0.985, errors: 0.02, error_types: [] }, 'a rate over 1 is read as a percent');
  assert.equal(pmDays[0].spam, 0, 'a zero spam rate is kept');
  assert.equal(pmDays[1].spam, null, 'an empty value is no data');
  assert.equal(postmasterDaysV2([]).length, 0);
  assert.deepEqual(POSTMASTER_V2_METRICS.map((m) => m.name), ['spam', 'spf', 'dkim', 'dmarc', 'errors']);

  // ---- Fix cards say exactly what to type (the Compr blast domain went to the root via "@")
  assert.equal(evaluateSpf('f.com', [], { count: 0, errors: [] }, [])[0].fix, undefined, 'no v=spf1 ~all that authorises nobody');
  assert.match(evaluateSpf('g.com', ['v=spf1 a ~all'], { count: 1, errors: [] }, ['amazonses.com'])[0].fix!.note!, /Do not add a second/);
  assert.equal(zoneOf('deals.thecompr.ai'), 'thecompr.ai');
  assert.equal(zoneOf('mail.acme.co.uk'), 'acme.co.uk');
  const placed = placeDnsFixes([
    ...evaluateSpf('deals.thecompr.ai', [], { count: 0, errors: [] }, ['amazonses.com']),
    { ...evaluateSpf('send.deals.thecompr.ai', [], { count: 0, errors: [] }, ['amazonses.com'])[0], key: 'spf_resend', fix: { type: 'TXT', host: 'send', value: 'v=spf1 include:amazonses.com ~all' } },
    ...evaluateDkim('deals.thecompr.ai', [{ selector: 'resend', txts: [] }], { google: false, resend: true }),
    ...evaluateDmarc('deals.thecompr.ai', []),
  ], 'deals.thecompr.ai');
  const at = (k: string) => placed.find((c) => c.key === k)!.fix!;
  assert.deepEqual([at('spf').host, at('spf').fqdn], ['deals', 'deals.thecompr.ai'], 'subdomain SPF is "deals", not "@"');
  assert.equal(at('spf_resend').host, 'send.deals');
  assert.equal(at('dkim_resend').host, 'resend._domainkey.deals');
  assert.equal(at('dkim_resend').paste, false, 'the Resend DKIM card is an instruction, not a value to paste');
  assert.doesNotMatch(at('dkim_resend').value, /[<>]/);
  assert.match(at('dkim_resend').note!, /not your Resend API key/);
  assert.equal(at('dmarc').host, '_dmarc.deals');
  assert.equal(placeDnsFixes(evaluateSpf('acme.com', [], { count: 0, errors: [] }, ['_spf.google.com']), 'acme.com')[0].fix!.host, '@', 'the zone itself stays "@"');

  const tooMany = evaluateSpf('e.com', ['v=spf1 include:_spf.google.com ~all'], { count: 12, errors: [] }, ['_spf.google.com']);
  assert.ok(tooMany.find((c) => c.key === 'spf_lookups')!.blocking, 'over 10 lookups blocks');

  // ---- DMARC parsing
  const d = parseDmarc('v=DMARC1; p=quarantine; rua=mailto:a@x.com, mailto:b@y.com; pct=50; adkim=s');
  assert.deepEqual(d, { p: 'quarantine', sp: null, pct: 50, rua: ['mailto:a@x.com', 'mailto:b@y.com'], ruf: [], adkim: 's', aspf: 'r' });
  assert.equal(parseDmarc('p=reject; v=DMARC1'), null, 'v=DMARC1 must come first');
  assert.equal(parseDmarc('v=DMARC1; p=bogus')!.p, null);
  assert.equal(evaluateDmarc('x.com', [])[0].blocking, true);
  assert.equal(evaluateDmarc('x.com', ['v=DMARC1; p=none'])[0].status, 'warn');
  assert.equal(evaluateDmarc('x.com', ['v=DMARC1; p=none']).find((c) => c.key === 'dmarc_rua')!.status, 'warn', 'no rua warns');

  // ---- DKIM key length
  const rsa2048 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'A'.repeat(348) + 'IDAQAB';
  assert.equal(dkimKeyBits(`v=DKIM1; k=rsa; p=${rsa2048}`), 2048);
  assert.equal(dkimKeyBits('v=DKIM1; k=rsa; p=' + 'A'.repeat(216)), 1024);
  assert.equal(dkimKeyBits('v=DKIM1; p='), 0, 'empty p is revoked');
  assert.equal(dkimKeyBits('k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='), 'ed25519');
  const dk = evaluateDkim('acme.com', [{ selector: 'google', txts: [] }], { google: true, resend: false });
  assert.equal(dk[0].status, 'fail');
  assert.ok(dk.find((c) => c.key === 'dkim_google')!.fix!.note!.includes('Google Admin'));

  // ---- health score
  const allGood = [...evaluateSpf('acme.com', ['v=spf1 include:_spf.google.com -all'], { count: 4, errors: [] }, ['_spf.google.com']),
    ...evaluateDkim('acme.com', [{ selector: 'google', txts: [`v=DKIM1; k=rsa; p=${rsa2048}`] }], { google: true, resend: false }),
    ...evaluateDmarc('acme.com', ['v=DMARC1; p=reject; rua=mailto:d@acme.com'])];
  assert.deepEqual(healthScore(allGood), { score: 100, blocking: [] });
  const noAuth = healthScore([...evaluateSpf('z.com', [], { count: 0, errors: [] }, ['_spf.google.com']), ...evaluateDmarc('z.com', [])]);
  assert.equal(noAuth.score, 55);
  assert.ok(noAuth.blocking.some((b) => b.startsWith('SPF')) && noAuth.blocking.some((b) => b.includes('below 70')), 'missing SPF and a low score both block');

  // ---- ramp math
  const m: MailboxSettings = {
    daily_cap: 150, hourly_cap: 30, min_gap_seconds: 60, window_start: 8, window_end: 18, window_days: [1, 2, 3, 4, 5], timezone: 'America/Chicago',
    ramp_enabled: true, ramp_start: 20, ramp_increase_pct: 20, ramp_target: 120, ramp_started_on: '2026-09-01', paused: false, paused_reason: null,
  };
  assert.equal(rampDay(m, '2026-09-01'), 0);
  assert.equal(dailyAllowance(m, '2026-09-01'), 20, 'day 0 is the start volume');
  assert.equal(dailyAllowance(m, '2026-09-04'), 34, '20 × 1.2³ = 34.56 → 34');
  assert.equal(dailyAllowance(m, '2026-10-30'), 120, 'never above the target');
  assert.equal(dailyAllowance({ ...m, ramp_enabled: false }, '2026-09-01'), 150, 'no ramp → the daily cap');
  assert.equal(dailyAllowance({ ...m, daily_cap: 25 }, '2026-09-10'), 25, 'never above the daily cap');
  assert.equal(dailyAllowance(m, '2026-08-01'), 20, 'a start date in the future counts as day 0');
  assert.equal(WARMUP_START, 50);
  const fresh = { ...m, ramp_start: WARMUP_START, ramp_target: 150, daily_cap: 150 };
  assert.equal(dailyAllowance(fresh, '2026-09-01'), 50, 'day one of a new mailbox is 50');
  assert.equal(dailyAllowance(fresh, '2026-09-02'), 60, 'day two is 50 × 1.2');
  assert.equal(dailyAllowance(fresh, '2026-09-04'), 86, '50 × 1.2³ = 86.4 → 86');

  // ---- rotation across blast addresses
  assert.equal(repBlastAddress('Jamie@yourcompany.com', 'deals.yourcompany.com'), 'jamie@deals.yourcompany.com');
  assert.equal(repBlastAddress('not an email', 'deals.yourcompany.com'), null);
  assert.equal(repBlastAddress('jamie@yourcompany.com', 'not a domain'), null);
  const morgan = repBlastAddresses('Morgan@yourcompany.com', 'deals.yourcompany.com');
  assert.equal(morgan.length, 10);
  assert.equal(morgan[0], 'morgan1@deals.yourcompany.com');
  assert.equal(morgan[9], 'morgan10@deals.yourcompany.com');
  assert.deepEqual(repBlastAddresses('a@x.com', 'deals.yourcompany.com'), []);
  assert.deepEqual(repBlastAddresses('morgan@yourcompany.com', 'not a domain'), []);
  const owned = [
    { id: 1, user_id: 'morgan' },
    { id: 2, user_id: 'morgan' },
    { id: 3, user_id: 'jamie' },
    { id: 4, user_id: null },
  ];
  assert.deepEqual(repSenderPool(owned, 'morgan').map((x) => x.id), [1, 2]);
  assert.deepEqual(repSenderPool(owned, 'casey').map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(repSenderPool(owned, null).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(repSenderPool([{ id: 9, user_id: null }], 'morgan').map((x) => x.id), [9]);
  const morganBook: Book = {
    sellers: new Map(), buyers: new Map([['morgan3@deals.yourcompany.com', 9], ['bo@buyer.com', 200]]), vendors: new Map(),
    parties: new Map(), dealsBySeller: new Map(), dealsByBuyer: new Map([[200, [{ id: 3, property_id: 30, seller_id: null, street: '55 elm dr' }]]]), dealsByVendor: new Map(),
    deals: new Map([[3, { id: 3, property_id: 30, seller_id: null, street: '55 elm dr' }]]),
    ours: new Set(['morgan3@deals.yourcompany.com', 'morgan@yourcompany.com']),
    reps: new Map([['morgan3@deals.yourcompany.com', 'morgan'], ['morgan@yourcompany.com', 'morgan']]),
  };
  assert.equal(linkFor(morganBook, ['bo@buyer.com', 'morgan3@deals.yourcompany.com'], 'offer').buyer_id, 200);
  assert.equal(repFor(morganBook, 'bo@buyer.com', ['morgan3@deals.yourcompany.com']), 'morgan');
  assert.equal(repFor(morganBook, 'morgan3@deals.yourcompany.com', ['bo@buyer.com']), 'morgan');
  assert.equal(repFor(morganBook, 'bo@buyer.com', ['morgan@yourcompany.com']), 'morgan');
  const pool = [{ id: 1 }, { id: 2, paused: true }, { id: 3 }, { id: 4 }];
  assert.deepEqual(cycleOrder(pool, 0).map((x) => x.id), [1, 3, 4]);
  assert.deepEqual(cycleOrder(pool, 1).map((x) => x.id), [3, 4, 1]);
  assert.deepEqual(cycleOrder(pool, 2).map((x) => x.id), [4, 1, 3]);
  assert.deepEqual(cycleOrder(pool, 3).map((x) => x.id), [1, 3, 4]);
  assert.deepEqual(cycleOrder([{ id: 7, paused: true }], 0), []);

  // ---- time windows (Chicago is UTC-5 in September)
  assert.equal(dayStartUtc(new Date('2026-09-15T03:00:00Z'), 'America/Chicago').toISOString(), '2026-09-14T05:00:00.000Z', 'local midnight');
  const tue10pm = new Date('2026-09-16T03:00:00Z'); // Tue 22:00 CDT
  assert.equal(nextWindowStart(m, tue10pm)!.toISOString(), '2026-09-16T13:00:00.000Z', 'next window is Wed 08:00 CDT');
  const fri4pm = new Date('2026-09-18T21:00:00Z');
  assert.equal(nextWindowStart(m, fri4pm, true)!.toISOString(), '2026-09-21T13:00:00.000Z', 'after a daily cap on Friday: Monday 08:00');
  assert.equal(preflight(m, 'bulk', tue10pm)!.code, 'window');
  assert.equal(preflight(m, 'one_to_one', tue10pm), null, '1:1 mail is not held to the window');
  assert.equal(preflight({ ...m, paused: true, paused_reason: 'bounces' }, 'transactional', tue10pm), null, 'signing links still go out');
  assert.equal(limitsFor(m, 'one_to_one', fri4pm).gap, 0);
  const r = refusal(m, 'one_to_one', { today: 34, last_hour: 3, hour_oldest: null, last_sent_at: null }, 1, new Date('2026-09-04T20:00:00Z'));
  assert.equal(r.code, 'daily_cap');
  assert.ok(r.message.includes('34 of 34') && r.message.includes('warm-up day 4'), r.message);

  // ---- auto-pause
  assert.equal(autoPauseReason({ sent7d: 10, bounced7d: 2, hardInLast50: 2, bulk30d: 0, unsub30d: 0 }), null, 'small samples do not pause on rate');
  assert.ok(autoPauseReason({ sent7d: 40, bounced7d: 3, hardInLast50: 2, bulk30d: 0, unsub30d: 0 })!.includes('7.5%'));
  assert.ok(autoPauseReason({ sent7d: 100, bounced7d: 3, hardInLast50: 3, bulk30d: 0, unsub30d: 0 })!.includes('3 hard bounces'));
  assert.ok(autoPauseReason({ sent7d: 100, bounced7d: 0, hardInLast50: 0, bulk30d: 50, unsub30d: 3 })!.includes('unsubscribe'));

  // ---- bounces
  assert.deepEqual(parseBounce('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', { 'x-failed-recipients': 'Nobody@Example.com' }, 'Address not found\nStatus: 5.1.1'), { recipient: 'nobody@example.com', hard: true, status: '5.1.1' });
  assert.equal(parseBounce('mailer-daemon@googlemail.com', {}, 'Final-Recipient: rfc822; a@b.com\nStatus: 4.2.2\nAction: delayed')!.hard, false);
  assert.equal(parseBounce('Kara <kara@x.com>', {}, 'Status: 5.1.1'), null, 'only from a mailer-daemon');
  assert.equal(parseBounce('mailer-daemon@googlemail.com', {}, "Your message wasn't delivered to seller@gone.com because the address couldn't be found.")!.hard, true);

  // ---- spam risk
  const clean = spamRisk({ subject: 'Your house on Oak Hollow', text: 'Hi Kara,\n\nThanks for talking today. I will send the written offer by 2pm.\n\nTaylor' });
  assert.equal(clean.score, 0);
  assert.equal(clean.level, 'low');
  const spammy = spamRisk({
    subject: 'URGENT CASH OFFER!!!',
    html: '<p>ACT NOW, GUARANTEED CASH, CLICK HERE!!!</p><a href="https://bit.ly/x">www.zillow.com</a><img src="https://t.example.com/open.gif" width="1" height="1"><p>Hi {{first_name}}</p>',
    recipients: 8,
  });
  const keys = spammy.findings.map((x) => x.key);
  for (const k of ['triggers', 'caps', 'exclaim', 'mismatch', 'shortener', 'pixel', 'plaintext', 'merge', 'recipients']) assert.ok(keys.includes(k), `flags ${k}`);
  assert.equal(spammy.level, 'high');
  assert.equal(spammy.score, 100, 'capped at 100');
  assert.ok(spamRisk({ subject: 'Photos', html: '<img src="https://x.com/a.jpg"><img src="https://x.com/b.jpg">', text: 'See' }).findings.some((x) => x.key === 'images'), 'image-only mail');
  assert.ok(spamRisk({ subject: 'x', text: 'a https://a.com b https://b.com c https://c.com d https://d.com' }).findings.some((x) => x.key === 'links'), 'bare links count');

  console.log('deliverability: ok');
}

void main().catch((err) => { console.error(err); process.exit(1); });
