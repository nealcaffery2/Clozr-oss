// Power / predictive pacing and the smart RVM rules.
// Run: npx tsx tools/dial-rvm.test.ts
import { abandonmentPercent, advancesAfterSave, afterVmDrop, autoAdvances, overAbandonmentCap, paceLines, winnerLine } from '../lib/power-dialer';
import { decideRvm, hasDnc, inWindow, localMidnightIso, nextWindowOpen, pickRecording, areaCodeOf, reputationE164, spinCallerId, zoneForRvm, zoneForState, zonedClock, DEFAULT_RVM_WINDOW, type RvmFacts } from '../lib/rvm';
import { countsFromHistory, liveCallerBlock, mergeLineProviders, nextCallerId, NoLiveCallerError, PIN_SKIPPED_NOTICE, resetCallerSpin, sessionLines, spinOrgCallerId } from '../lib/caller-spin';
import { audioKind, dropCowboyPayload, receiptOutcome, slybroadcastFields } from '../lib/rvm-carriers';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('power does not auto-advance', autoAdvances('power'), false);
eq('predictive auto-advances', autoAdvances('predictive'), true);
eq('progressive auto-advances', autoAdvances('progressive'), true);
eq('parallel auto-advances', autoAdvances('parallel'), true);
eq('blank mode does not', autoAdvances(null), false);
eq('power waits for Next after Save', advancesAfterSave('power'), false);
eq('progressive goes on after Save', advancesAfterSave('progressive'), true);
eq('no session mode, no next call', advancesAfterSave(null), false);

eq('abandonment with no sample', abandonmentPercent(0, 0), 0);
eq('one abandon of four is 25', abandonmentPercent(3, 1), 25);
eq('a new session is not over the cap', overAbandonmentCap(1, 1, 3), false);
eq('a real sample over 3% is over the cap', overAbandonmentCap(90, 10, 3), true);
eq('under the cap stays open', overAbandonmentCap(97, 2, 3), false);

eq('a drop advances predictive', afterVmDrop('predictive').advance, true);
eq('a drop does not advance power: the rep presses Next', afterVmDrop('power').advance, false);
eq('a drop with no session does not dial', afterVmDrop(null).advance, false);
eq('the answered line is the one the browser takes', winnerLine([
  { call: { status: 'ringing' }, id: 'a' },
  { call: { status: 'answered' }, id: 'b' },
])?.id, 'b');
eq('nobody answered yet means the first line', winnerLine([{ call: { status: 'ringing' }, id: 'a' }])?.id, 'a');
eq('no lines means nobody to answer', winnerLine<{ call: { status: string }; id: string }>([]), null);

eq('dnc tag', hasDnc(['Hot', 'Do Not Call']), true);
eq('ordinary tags are not dnc', hasDnc(['follow-up']), false);

eq('houston is central', zoneForRvm('+17135550100'), 'America/Chicago');
eq('miami is eastern', zoneForRvm('+13055550100'), 'America/New_York');
eq('unknown code is central', zoneForRvm('+19995550100'), 'America/Chicago');
eq('greenville with no state is eastern', zoneForRvm('+18645550100'), 'America/New_York');
eq('san antonio with no state is central', zoneForRvm('2105550100'), 'America/Chicago');
eq('flagstaff with no state is arizona', zoneForRvm('(928) 555-0100'), 'America/Phoenix');

const noon = new Date('2026-09-28T17:00:00.000Z'); // Monday 12:00 Chicago
const clock = zonedClock(noon, 'America/Chicago');
eq('monday noon is in the window', inWindow(clock, DEFAULT_RVM_WINDOW), true);
const late = new Date('2026-09-29T02:30:00.000Z'); // Monday 21:30 Chicago
eq('9:30pm is outside', inWindow(zonedClock(late, 'America/Chicago'), DEFAULT_RVM_WINDOW), false);
const sunday = new Date('2026-09-27T17:00:00.000Z');
eq('sunday is closed', inWindow(zonedClock(sunday, 'America/Chicago'), DEFAULT_RVM_WINDOW), false);

const base: RvmFacts = {
  phone: '+17135550100', dnc: false, now: noon, timeZone: 'America/Chicago',
  window: DEFAULT_RVM_WINDOW, lastLiveTalkAt: null, lastDropAt: null,
  minDaysSinceTalk: 7, minDaysSinceDrop: 3, sentToday: 0, dailyCap: 200,
  recordings: [{ id: 'a', name: 'Intro' }, { id: 'b', name: 'Follow up' }],
  heardIds: [],
};
eq('a fresh number gets the first recording', decideRvm(base), { action: 'send', recordingId: 'a' });
eq('a heard recording is skipped', decideRvm({ ...base, heardIds: ['a'] }), { action: 'send', recordingId: 'b' });
eq('both heard falls back to the first', pickRecording(base.recordings, ['a', 'b'])?.id, 'a');
eq('no phone is skipped', decideRvm({ ...base, phone: null }).action === 'skip' && (decideRvm({ ...base, phone: null }) as { reason: string }).reason, 'no_phone');
eq('dnc is skipped', (decideRvm({ ...base, dnc: true }) as { reason: string }).reason, 'do_not_call');
eq('a talk yesterday is skipped', (decideRvm({ ...base, lastLiveTalkAt: '2026-09-27T17:00:00.000Z' }) as { reason: string }).reason, 'recent_talk');
eq('a talk eight days ago sends', decideRvm({ ...base, lastLiveTalkAt: '2026-09-20T17:00:00.000Z' }).action, 'send');
eq('a drop yesterday is skipped', (decideRvm({ ...base, lastDropAt: '2026-09-27T17:00:00.000Z' }) as { reason: string }).reason, 'recent_drop');
eq('after hours waits', decideRvm({ ...base, now: late }).action, 'wait');
eq('a full day waits when a cap is set', decideRvm({ ...base, sentToday: 200, dailyCap: 200 }).action, 'wait');
eq('no daily cap still sends', decideRvm({ ...base, sentToday: 5000, dailyCap: null }).action, 'send');
eq('the quiet number gets the next drop', spinCallerId(['+12105550100', '+12105550101'], { '+12105550100': 40, '+12105550101': 3 }, 0), '+12105550101');
eq('a tie rotates', spinCallerId(['+12105550100', '+12105550101'], { '+12105550100': 1, '+12105550101': 1 }, 1), '+12105550101');
eq('no lines means no caller id', spinCallerId([], {}, 0), null);
eq('no recordings skips', (decideRvm({ ...base, recordings: [] }) as { reason: string }).reason, 'no_recording');

const opened = nextWindowOpen(late, 'America/Chicago', DEFAULT_RVM_WINDOW);
eq('next window is after the late call', opened.getTime() > late.getTime(), true);
eq('next window lands inside the window', inWindow(zonedClock(opened, 'America/Chicago'), DEFAULT_RVM_WINDOW), true);

eq('warmup rings what the rep asked for', paceLines({ answered: 1, abandoned: 0, currentLines: 2, maxLines: 2 }).lines, 2);
eq('warmup never opens more than the rep asked', paceLines({ answered: 1, abandoned: 0, currentLines: 10, maxLines: 3 }).lines, 3);
eq('ten lines is the most, whatever was asked', paceLines({ answered: 1, abandoned: 0, currentLines: 2, maxLines: 25 }).lines, 10);
eq("a low connect rate still stops at the rep's number", paceLines({ answered: 20, abandoned: 0, machines: 180, currentLines: 2, maxLines: 2 }).lines, 2);
eq('over the cap pauses', paceLines({ answered: 90, abandoned: 10, currentLines: 3 }).pause, true);
eq('near the cap drops to one line', paceLines({ answered: 40, abandoned: 1, currentLines: 3 }), { lines: 1, pause: false, reason: 'near_cap' });
eq('a low connect rate steps up one line', paceLines({ answered: 20, abandoned: 0, machines: 180, currentLines: 2 }).lines, 3);
eq('a high connect rate steps down one line', paceLines({ answered: 80, abandoned: 0, machines: 10, currentLines: 3 }).lines, 2);

eq('texas house beats a new york area code', zoneForRvm('+12125550100', 'America/Chicago', 'TX'), 'America/Chicago');
eq('california by name', zoneForState('California'), 'America/Los_Angeles');
eq('chicago midnight on that monday', localMidnightIso(noon, 'America/Chicago'), '2026-09-28T05:00:00.000Z');

// Clocks change at 2:00 on 2026-03-08 (forward) and 2026-11-01 (back) in Chicago. The day's
// midnight and the window's start are the calendar's, not "now minus the clock's minutes".
const everyDay = { ...DEFAULT_RVM_WINDOW, days: [0, 1, 2, 3, 4, 5, 6] };
const springTen = new Date('2026-03-08T15:00:00.000Z'); // Sunday 10:00 CDT
eq('spring-forward day: midnight is still 6:00Z (CST)', localMidnightIso(springTen, 'America/Chicago'), '2026-03-08T06:00:00.000Z');
const springEarly = new Date('2026-03-08T12:30:00.000Z'); // Sunday 06:30 CST, 90 minutes before the window
eq('spring-forward day: the window opens at 8:00 CDT', nextWindowOpen(springEarly, 'America/Chicago', everyDay).toISOString(), '2026-03-08T13:00:00.000Z');
const fallTen = new Date('2026-11-01T16:00:00.000Z'); // Sunday 10:00 CST
eq('fall-back day: midnight is still 5:00Z (CDT)', localMidnightIso(fallTen, 'America/Chicago'), '2026-11-01T05:00:00.000Z');
const fallEarly = new Date('2026-11-01T05:30:00.000Z'); // Sunday 00:30 CDT
eq('fall-back day: the window opens at 8:00 CST', nextWindowOpen(fallEarly, 'America/Chicago', everyDay).toISOString(), '2026-11-01T14:00:00.000Z');
const satLate = new Date('2026-03-08T05:30:00.000Z'); // Saturday 23:30 CST, the night before the clocks move
eq('the 23-hour day is not skipped', nextWindowOpen(satLate, 'America/Chicago', everyDay).toISOString(), '2026-03-08T13:00:00.000Z');
eq('an ordinary late night opens the next morning', nextWindowOpen(late, 'America/Chicago', DEFAULT_RVM_WINDOW).toISOString(), '2026-09-29T13:00:00.000Z');
eq('saturday night waits for monday', nextWindowOpen(satLate, 'America/Chicago', DEFAULT_RVM_WINDOW).toISOString(), '2026-03-09T13:00:00.000Z');

const clips = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
eq('the older recording plays again', pickRecording(clips, ['a', 'b'], { a: '2026-09-01T00:00:00.000Z', b: '2026-09-20T00:00:00.000Z' })?.id, 'a');

eq('webm is not a ringless file', audioKind('w/1/clip.webm'), null);
eq('mp3 is', audioKind('w/1/clip.mp3'), 'mp3');
const cowboy = dropCowboyPayload({
  teamId: 'team', secret: 'sec', brandId: 'brand', phone: '+17135550100', dropId: 9,
  callbackUrl: 'https://example.com/rvm', script: 'Call me back', voiceId: 'voice',
});
eq('drop cowboy speaks the script', cowboy?.tts_body, 'Call me back');
eq('drop cowboy keeps the drop id', cowboy?.foreign_id, '9');
eq('webm does not become a cowboy audio url', dropCowboyPayload({
  teamId: 'team', secret: 'sec', brandId: 'brand', phone: '7135550100', dropId: 1,
  callbackUrl: 'https://example.com', audioUrl: 'https://example.com/a.webm', audioType: null,
}), null);
const sly = slybroadcastFields({
  uid: 'a@b.com', password: 'pw', phone: '+17135550100', callerId: '2105550100',
  audioUrl: 'https://example.com/a.mp3', audioType: 'mp3',
});
eq('slybroadcast uses ten digits', sly?.c_phone, '7135550100');
eq('slybroadcast can post the disposition back', slybroadcastFields({
  uid: 'a@b.com', password: 'pw', phone: '7135550100', callerId: '2105550100',
  audioUrl: 'https://example.com/a.mp3', audioType: 'mp3', callbackUrl: 'https://example.com/ok',
})?.c_dispo_url, 'https://example.com/ok');
eq('a delivered receipt closes the drop', receiptOutcome({ status: 'delivered' }), 'dropped');
eq('a failed receipt does not', receiptOutcome({ status: 'failed' }), 'failed');
eq('an accepted job is not a delivery yet', receiptOutcome({ status: 'queued' }), 'pending');
eq('a callback event can close the drop', receiptOutcome({ event: 'rvm.delivered' }), 'dropped');
eq('not sent is a failure', receiptOutcome({ status: 'not_sent' }), 'failed');

eq('area code of a houston number', areaCodeOf('+17135550100'), '713');
eq('area code of a ten-digit number', areaCodeOf('2105550100'), '210');
eq('a short number has no area code', areaCodeOf('555'), null);

const pool = ['+12105550100', '+17135550101', '+13055550102'];
const used = { '+12105550100': 2, '+17135550101': 9, '+13055550102': 2 };
eq('a houston drop uses the houston line even when it is busier', reputationE164(pool, used, '+17135550999'), '+17135550101');
eq('no local match uses the quietest line', reputationE164(pool, { ...used, '+13055550102': 1 }, '+15125550999'), '+13055550102');
eq('a local tie rotates', reputationE164(['+17135550101', '+17135550109'], { '+17135550101': 1, '+17135550109': 1 }, '+17135550000', 1), '+17135550109');
eq('one line is that line', reputationE164(['+12105550100'], {}, '+13055550000'), '+12105550100');

const org = [
  { id: 'hou', phone_e164: '+17135550101', area_code: '713', provider: 'telnyx' },
  { id: 'sa', phone_e164: '+12105550100', area_code: '210', provider: 'telnyx' },
];
eq('history counts the line that placed the call', countsFromHistory(org, ['+1 210-555-0100', '2105550100']), { hou: 0, sa: 2 });
eq('a click prefers the local line', nextCallerId(org, { hou: 4, sa: 0 }, '+17135550000')?.id, 'hou');
eq('a session with no destination takes the quieter line', nextCallerId(org, { hou: 4, sa: 0 }, null)?.id, 'sa');
eq('one org line does not rotate', nextCallerId([org[0]!], {}, '+12105550000')?.id, 'hou');

await (async () => {
  resetCallerSpin();
  const first = await spinOrgCallerId({ lines: org, dest: '+17135550000', load: async () => [] });
  const second = await spinOrgCallerId({ lines: org, dest: null, load: async () => ['+17135550101', '+17135550101'] });
  eq('the first click takes houston', first?.id, 'hou');
  eq('the next session call takes the other line', second?.id, 'sa');
  const pinned = await spinOrgCallerId({ lines: org, dest: '+17135550000', pinId: 'sa', load: async () => [] });
  eq('a dedicated pin stays on that line', pinned?.id, 'sa');
  eq('a live pin does not ask for another number', pinned?.notice, undefined);

  const mixed = [
    { id: 'tw', phone_e164: '+12105550161', provider: 'twilio' },
    { id: 'tx', phone_e164: '+17135550101', provider: 'Telnyx' },
  ];
  resetCallerSpin();
  const fell = await spinOrgCallerId({ lines: mixed, dest: '+17135550000', pinId: 'tw', load: async () => [] });
  eq('a twilio pin falls back to telnyx', fell?.id, 'tx');
  eq('a skipped pin says to pick another caller id', fell?.notice, PIN_SKIPPED_NOTICE);

  const rvmLines = [
    { id: 'rvm', phone_e164: '+12105550161', provider: 'telnyx' },
    { id: 'tx', phone_e164: '+17135550101', provider: 'telnyx' },
  ];
  const rvmPools = {
    '+12105550161': { pool: 'rvm', state: 'TX' },
    '+17135550101': { pool: 'dialer', state: 'TX' },
  };
  resetCallerSpin();
  const skippedPool = await spinOrgCallerId({
    lines: rvmLines, dest: null, pinId: 'rvm', load: async () => [], linePools: async () => rvmPools,
  });
  eq('an rvm pin is not the live caller id', skippedPool?.id, 'tx');
  eq('an rvm pin asks for a different caller id', skippedPool?.notice, PIN_SKIPPED_NOTICE);
  resetCallerSpin();
  const rotated = await spinOrgCallerId({
    lines: rvmLines, dest: null, load: async () => [], linePools: async () => rvmPools,
  });
  eq('rotation skips the rvm pool', rotated?.id, 'tx');
  eq('a pool skip without a pin stays quiet', rotated?.notice, undefined);

  resetCallerSpin();
  let threw = false;
  try {
    await spinOrgCallerId({
      lines: [
        { id: 'tw', phone_e164: '+12105550161', provider: 'twilio' },
        { id: 'blank', phone_e164: '+12105550100' },
      ],
      load: async () => [],
    });
  } catch (err) {
    threw = err instanceof NoLiveCallerError;
  }
  eq('no telnyx line fails loudly', threw, true);

  // A dial session shows only lines whose callback reaches the rep who dialled.
  const me = 'rep-david';
  const office = [
    { id: 'ai', phone_e164: '+18325550056', provider: 'telnyx', label: 'AI · Jordan (acquisitions)', assigned_user_id: null },
    { id: 'sam', phone_e164: '+12105551674', provider: 'telnyx', label: 'Sam Main', assigned_user_id: 'rep-sam' },
    { id: 'own', phone_e164: '+12105556170', provider: 'telnyx', label: 'David Main', assigned_user_id: me },
    { id: 'bulk', phone_e164: '+12105554199', provider: 'telnyx', label: 'Acme Homes bulk · San Antonio 1', assigned_user_id: 'rep-sam' },
    { id: 'company', phone_e164: '+18305551597', provider: 'telnyx', label: 'Company Main', assigned_user_id: null },
  ];
  const officePools = { '+12105554199': { pool: 'dialer', state: 'TX' } };
  eq('a session keeps own, pool and unassigned lines only',
    sessionLines(office, me, officePools).map((l) => l.id), ['own', 'bulk', 'company']);
  eq('an AI line is out even with no pools loaded', sessionLines(office, me, null).map((l) => l.id), ['own', 'company']);
  const picks = new Set<string>();
  resetCallerSpin();
  for (let i = 0; i < 12; i++) {
    const pick = await spinOrgCallerId({ lines: office, dest: null, load: async () => [], linePools: async () => officePools, sessionUserId: me });
    if (pick) picks.add(pick.id);
  }
  eq('a session never leaves from the AI agent or a teammate', [...picks].sort(), ['bulk', 'company', 'own']);
  resetCallerSpin();
  const click = await spinOrgCallerId({ lines: office, dest: null, pinId: 'sam', load: async () => [], linePools: async () => officePools });
  eq('a click-to-call still honours the pinned line', click?.id, 'sam');

  eq('unknown carrier is blocked', liveCallerBlock({ phone_e164: '+12105550100', provider: null }, {}), 'Carrier unknown, not for live calls');
  eq('twilio and rvm name both reasons', liveCallerBlock(
    { phone_e164: '+12105550161', provider: 'Twilio' },
    { '+12105550161': { pool: 'rvm', state: null } },
  ), 'Twilio line, RVM only, not for live calls');
  eq('a telnyx dialer line is live', liveCallerBlock(
    { phone_e164: '+17135550101', provider: 'telnyx' },
    { '+17135550101': { pool: 'dialer', state: 'TX' } },
  ), null);
  const bare: { id: string; phone_e164: string; provider?: string | null }[] = [
    { id: 'a', phone_e164: '+1' },
    { id: 'b', phone_e164: '+2' },
  ];
  eq('providers copy onto the matching line', mergeLineProviders(bare, [{ id: 'a', provider: 'telnyx' }]).map((line) => line.provider ?? null), ['telnyx', null]);
})();

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');

// ---- the session's numbers (lib/power-dialer.ts sessionStats) and the page's keys
import { clock as pdClock, hotkeyFor, sessionStats } from '../lib/power-dialer';
const st = sessionStats({ dialed: 40, connected: 10, abandoned: 1, machines: 12, talkSeconds: 600, calls: 10, startedAt: 0, now: 30 * 60_000, remaining: 60 });
eq('contact rate is connects over dials', st.contactRate, 25);
eq('abandon rate is the FTC measure', st.abandonRate, 9.1);
eq('average talk per call', st.avgTalkSeconds, 60);
eq('pace is dials per hour', st.dialsPerHour, 80);
eq('elapsed in seconds', st.elapsedSeconds, 1800);
eq('nothing dialed, no rate', sessionStats({ dialed: 0, connected: 0, abandoned: 0, machines: 0, talkSeconds: 0, calls: 0, startedAt: null, now: 0, remaining: null }).contactRate, null);
eq('a clock under an hour', pdClock(249), '4:09');
eq('a clock over an hour', pdClock(3849), '1:04:09');
const key = (k: string, tag = 'DIV', mod = false) => hotkeyFor({ key: k, metaKey: mod, ctrlKey: false, altKey: false, target: { tagName: tag } });
eq('n is Next', key('n'), 'next');
eq('N is Next too', key('N'), 'next');
eq('not while typing', key('n', 'INPUT'), null);
eq('not with a modifier', key('n', 'DIV', true), null);
eq('digits are not the page\'s', key('1'), null);
