// The browser side of AI agents on records: who the bulk bar keeps off an
// agent (VIPs and funds), the time and action wording the popup shows, the
// avatar fallback, and the read-only preview's view of the ai-agent function.
// Run: npx tsx tools/ai-agent.test.ts
import assert from 'node:assert/strict';
import { ACTION_TEXT, actionText, agoLabel, avatarFallback, isProtectedBuyer, whenLabel } from '../lib/ai-agent-client';
import { isSupabaseWrite } from '../lib/read-only';
import { AI_AGENTS_TAB, REPORT_TABS } from '../lib/reporting';
import { normalizeSummary } from '../lib/voice-agent';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
};

// ---- VIPs and funds ----
test('a VIP is protected', () => assert.equal(isProtectedBuyer({ vip: true }), true));
test('a fund or institutional buyer is protected, by raw column or by the list label', () => {
  assert.equal(isProtectedBuyer({ buyerType: 'fund' }), true);
  assert.equal(isProtectedBuyer({ entityType: 'Institutional' }), true);
  assert.equal(isProtectedBuyer({ buyer_type: 'institutional' }), true);
  assert.equal(isProtectedBuyer({ type: 'Fund · Flip + Rental' }), true);
  assert.equal(isProtectedBuyer({ type: 'Institutional · SFR Rental' }), true);
});
test('an ordinary buyer is not', () => {
  assert.equal(isProtectedBuyer({ vip: false, buyerType: 'flipper', type: 'Flipper · Rental' }), false);
  assert.equal(isProtectedBuyer({ type: 'Landlord, not a fund' }), false);
});

// ---- wording ----
const NOW = Date.parse('2026-10-06T15:00:00Z');
test('when the next step is', () => {
  assert.equal(whenLabel(null, NOW), '');
  assert.equal(whenLabel('nope', NOW), '');
  assert.equal(whenLabel(new Date(NOW + 30_000).toISOString(), NOW), 'any minute now');
  assert.equal(whenLabel(new Date(NOW + 20 * 60_000).toISOString(), NOW), 'in 20 min');
  assert.equal(whenLabel(new Date(NOW + 5 * 3_600_000).toISOString(), NOW), 'in 5 hours');
  assert.match(whenLabel(new Date(NOW + 26 * 3_600_000).toISOString(), NOW), /^tomorrow /);
});
test('how long ago', () => {
  assert.equal(agoLabel(new Date(NOW - 20_000).toISOString(), NOW), 'just now');
  assert.equal(agoLabel(new Date(NOW - 5 * 60_000).toISOString(), NOW), '5m ago');
  assert.equal(agoLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), '3h ago');
  assert.equal(agoLabel(new Date(NOW - 2 * 86_400_000).toISOString(), NOW), '2d ago');
});
test('action wording, with failed and skipped said out loud', () => {
  assert.equal(actionText({ action: 'sms_sent', status: 'done' }), 'Sent a text');
  assert.equal(actionText({ action: 'sms_sent', status: 'failed' }), 'Sent a text (failed)');
  assert.equal(actionText({ action: 'email_sent', status: 'skipped' }), 'Sent an email (skipped)');
  assert.equal(actionText({ action: 'brand_new_thing', status: 'done' }), 'brand new thing');
  for (const k of ['started', 'stopped', 'auto_stopped', 'sms_sent', 'email_sent', 'call_placed', 'handoff', 'relayed', 'took_over', 'marked_dnc', 'appointment_booked', 'qualification_saved']) assert.ok(ACTION_TEXT[k], k);
});
test('avatar fallback: initials and a stable gradient', () => {
  const a = avatarFallback('Riley Stone');
  assert.equal(a.initials, 'RS');
  assert.deepEqual(avatarFallback('Riley Stone'), a);
  assert.equal(avatarFallback('').initials, 'A');
});

// ---- the console reads the face and audience ----
test('an agent summary carries its avatar and audience, with the role deciding when the server does not say', () => {
  assert.equal(normalizeSummary({ agent_key: 'a', avatar_url: 'https://x.supabase.co/storage/v1/object/public/avatars/agents/1/a.png' }).avatar_url, 'https://x.supabase.co/storage/v1/object/public/avatars/agents/1/a.png');
  assert.equal(normalizeSummary({ agent_key: 'a', avatar_url: 'data:image/svg+xml;base64,PHN2Zz4=' }).avatar_url, 'data:image/svg+xml;base64,PHN2Zz4=');
  assert.equal(normalizeSummary({ agent_key: 'a', avatar_url: 'javascript:alert(1)' }).avatar_url, null);
  assert.equal(normalizeSummary({ agent_key: 'a', role: 'buyer_assistant' }).audience, 'buyers');
  assert.equal(normalizeSummary({ agent_key: 'a', role: 'lead_manager' }).audience, 'sellers');
  assert.equal(normalizeSummary({ agent_key: 'a', role: 'lead_manager', audience: 'both' }).audience, 'both');
});

// ---- the read-only preview ----
const fn = 'https://p.supabase.co/functions/v1/ai-agent';
test('a preview may read the agents, a record, its log and the report', () => {
  for (const action of ['agents', 'status', 'log', 'report']) assert.equal(isSupabaseWrite(fn, 'POST', JSON.stringify({ action })), false, action);
});
test('...but chatting, switching, bulk and avatars are writes', () => {
  for (const action of ['chat', 'start', 'stop', 'bulk_start', 'bulk_stop', 'generate_avatar', 'set_audience', 'handoff', 'set_handoff', 'tick']) assert.equal(isSupabaseWrite(fn, 'POST', JSON.stringify({ action })), true, action);
});

// ---- reporting ----
test('the AI Agents tab is on the report, before the builder', () => {
  assert.ok(REPORT_TABS.includes(AI_AGENTS_TAB));
  assert.equal(REPORT_TABS.indexOf(AI_AGENTS_TAB), REPORT_TABS.indexOf('Custom reports') - 1);
});

console.log(`ai-agent: ${passed} passed`);
