// Google Calendar push channels: when to open, renew, stop or wait, the
// token check, and the cron's gate giving way to a push.
// Run: npx tsx tools/calendar-watch.test.ts
import assert from 'node:assert/strict';
import { RENEW_BEFORE_MS, calendarDue, pushWantsSync, sameToken, watchPlan, type WatchFeed } from '../supabase/functions/_shared/calendar-watch';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};
const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const feed = (over: Partial<WatchFeed> = {}): WatchFeed => ({ calendar_id: 'c', enabled: true, watch_channel_id: null, watch_resource_id: null, watch_expires_at: null, ...over });

test('a feed with no channel opens one', () => assert.equal(watchPlan(feed(), NOW), 'renew'));
test('a live channel with days left is kept', () => assert.equal(watchPlan(feed({ watch_channel_id: 'x', watch_expires_at: at(3 * 86_400_000) }), NOW), 'keep'));
test('a channel in its last day is renewed', () => assert.equal(watchPlan(feed({ watch_channel_id: 'x', watch_expires_at: at(RENEW_BEFORE_MS - 60_000) }), NOW), 'renew'));
test('an expired channel is renewed', () => assert.equal(watchPlan(feed({ watch_channel_id: 'x', watch_expires_at: at(-1000) }), NOW), 'renew'));
test('a refusal backs off until its stamp passes', () => {
  assert.equal(watchPlan(feed({ watch_expires_at: at(3_600_000) }), NOW), 'wait');
  assert.equal(watchPlan(feed({ watch_expires_at: at(-1) }), NOW), 'renew');
});
test('a switched-off feed closes its channel', () => {
  assert.equal(watchPlan(feed({ enabled: false, watch_channel_id: 'x' }), NOW), 'stop');
  assert.equal(watchPlan(feed({ enabled: false }), NOW), 'none');
});
test('token compare', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abc', 'abd'), false);
  assert.equal(sameToken('abc', null), false);
  assert.equal(sameToken('', ''), false);
});
test('only real changes start a sync', () => {
  assert.equal(pushWantsSync('sync'), false);
  assert.equal(pushWantsSync('exists'), true);
  assert.equal(pushWantsSync('not_exists'), true);
});
test('the 14-minute gate, and a push skipping it', () => {
  assert.equal(calendarDue({ last_calendar_sync_at: null }, NOW), true);
  assert.equal(calendarDue({ last_calendar_sync_at: at(-20 * 60_000) }, NOW), true);
  assert.equal(calendarDue({ last_calendar_sync_at: at(-2 * 60_000) }, NOW), false);
  assert.equal(calendarDue({ last_calendar_sync_at: at(-2 * 60_000), calendar_push_at: at(-60_000) }, NOW), true);
  assert.equal(calendarDue({ last_calendar_sync_at: at(-2 * 60_000), calendar_push_at: at(-3 * 60_000) }, NOW), false);
});
console.log(`calendar-watch: ${passed} passed`);
