// The voice agent's write tools: open times, booking checks, the appointment
// row, what a qualification fills and keeps, the DNC tag, and the ElevenLabs
// tool configs. Run:  npx tsx supabase/functions/_shared/voice-agent-tools.test.ts
//   or: deno run supabase/functions/_shared/voice-agent-tools.test.ts
import {
  APPOINTMENT_KINDS, DNC_TAG, LEAD_MINUTES, appointmentRow, bookingProblem, localDate, moneyOf, openSlots, parseBooking, parseQualification,
  qualificationWrite, slotFree, withDncTag, writeToolBody,
} from './voice-agent-tools.ts';
import { hasDnc } from '../../../lib/rvm.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; } else console.log(`PASS  ${name}`);
}
function ok(name: string, cond: boolean, detail?: unknown) { eq(name, cond ? true : { failed: detail ?? null }, true); }

const CT = 'America/Chicago';
const HOURS = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00', tz: CT };
// Tuesday 2026-10-06 08:10 Central (13:10Z).
const NOW = Date.parse('2026-10-06T13:10:00Z');
const at = (iso: string) => Date.parse(iso);

// ---- open times ----
const slots = openSlots({ nowMs: NOW, hours: HOURS, busy: [] });
ok('slots are returned', slots.length > 0);
ok('every slot is at least the lead time out', slots.every((s) => Date.parse(s.starts_at) >= NOW + LEAD_MINUTES * 60_000));
ok('every slot is on the half hour', slots.every((s) => new Date(s.starts_at).getUTCMinutes() % 30 === 0));
ok('every slot fits the window', slots.every((s) => slotFree(Date.parse(s.starts_at), 30, HOURS, [])));
eq('the first slot is 9:30 Central, read out in Central', [slots[0].starts_at, /Tue, Oct 6, 9:30\s?AM CDT/.test(slots[0].label)], ['2026-10-06T14:30:00.000Z', true]);
ok('at most two a day', Object.values(slots.reduce((m, s) => ({ ...m, [localDate(Date.parse(s.starts_at), CT)]: (m[localDate(Date.parse(s.starts_at), CT)] ?? 0) + 1 }), {} as Record<string, number>)).every((n) => n <= 2));
ok('no weekend slots', slots.every((s) => !/Sat|Sun/.test(s.label)));
eq('at most six', slots.length <= 6, true);
const busy = [{ start: at('2026-10-06T14:30:00Z'), end: at('2026-10-06T15:30:00Z') }];
eq('a busy block is skipped', openSlots({ nowMs: NOW, hours: HOURS, busy })[0].starts_at, '2026-10-06T15:30:00.000Z');
const oneDay = openSlots({ nowMs: NOW, hours: HOURS, busy: [], day: '2026-10-07', count: 50 });
eq('a day narrows to every open time that day', [oneDay.length, oneDay.every((s) => localDate(Date.parse(s.starts_at), CT) === '2026-10-07')], [16, true]);
eq('a closed day has nothing', openSlots({ nowMs: NOW, hours: HOURS, busy: [], day: '2026-10-10' }), []);
eq('the last slot of a day ends at closing', slotFree(at('2026-10-06T21:30:00Z'), 30, HOURS, []), true);
eq('...and one that would run past it is not free', slotFree(at('2026-10-06T21:45:00Z'), 30, HOURS, []), false);

// ---- booking input and checks ----
eq('no starts_at asks for open times', parseBooking({}), { ok: true, input: { starts_at: null, kind: 'call', day: null, notes: '', best_phone: '' } });
eq('a starts_at that is not a time is refused with what to do', parseBooking({ starts_at: 'tomorrow at ten' }).ok, false);
eq('kind and day are validated', [parseBooking({ kind: 'Walkthrough', day: '2026-10-07' }), parseBooking({ kind: 'party', day: 'Tuesday' })].map((r) => r.ok ? [r.input.kind, r.input.day] : null), [['walkthrough', '2026-10-07'], ['call', null]]);
eq('a free slot books', bookingProblem(at('2026-10-06T15:00:00Z'), NOW, HOURS, []), null);
ok('too soon', /too soon/.test(bookingProblem(NOW + 5 * 60_000, NOW, HOURS, []) ?? ''));
ok('too far', /days out/.test(bookingProblem(NOW + 40 * 86_400_000, NOW, HOURS, []) ?? ''));
ok('outside hours', /outside our hours/.test(bookingProblem(at('2026-10-06T23:00:00Z'), NOW, HOURS, []) ?? ''));
ok('taken', /just taken/.test(bookingProblem(at('2026-10-06T14:30:00Z'), NOW, HOURS, busy) ?? ''));
const row = appointmentRow({ startMs: at('2026-10-06T15:00:00Z'), kind: 'walkthrough', name: 'Ann Smith', agentName: 'Riley', notes: 'Wants to see the roof first.', best_phone: '512 555 0199' });
eq('the appointment row', [row.title, row.kind, row.starts_at, row.ends_at, row.source], ['Walkthrough with Ann Smith', APPOINTMENT_KINDS.walkthrough, '2026-10-06T15:00:00.000Z', '2026-10-06T15:30:00.000Z', 'clozr']);
ok('its notes say the AI booked it, with the number and notes', /Booked by the AI agent Riley/.test(row.notes) && /512 555 0199/.test(row.notes) && /roof/.test(row.notes));

// ---- qualification ----
const q = parseQualification({ motivation: 'Inherited it, lives out of state', timeline: 'within 60 days', asking_price: 'about 210 thousand', tenant_status: 'n/a', email: 'not an email', outcome: 'Not Interested', bogus: 'x', notes: '  wants   it in writing ' });
eq('parse keeps real answers, drops n/a, a bad email and unknown keys', q, { values: { motivation: 'Inherited it, lives out of state', timeline: 'within 60 days', asking_price: 'about 210 thousand', notes: 'wants it in writing' }, outcome: 'not_interested' });
eq('an unknown outcome is dropped', parseQualification({ outcome: 'maybe' }).outcome, null);
eq('a warm transfer is an outcome', parseQualification({ outcome: 'Transferred' }).outcome, 'transferred');
eq('moneyOf', ['$210,000', '210k', 'about 210 thousand', '1.2 million', 'twelve', '150'].map(moneyOf), [210000, 210000, 210000, 1200000, null, null]);
const w = qualificationWrite('seller', q, { motivation: null, timeline: 'ASAP', asking_price: null, intake: { other: 1 } }, 'Riley');
eq('blank columns are filled, a different one is kept and listed', [w.patch, w.kept], [{ motivation: 'Inherited it, lives out of state', asking_price: 210000 }, [{ label: 'Timeline', on_file: 'ASAP', heard: 'within 60 days' }]]);
ok('the activity line has every answer and what was kept', /Motivation: Inherited/.test(w.body) && /Timeline: on file "ASAP", heard "within 60 days"/.test(w.body) && /qualification saved · not interested/.test(w.title));
const same = qualificationWrite('seller', parseQualification({ timeline: 'asap' }), { timeline: 'ASAP' }, 'Riley');
eq('the same answer in other case is neither written nor listed', [same.patch, same.kept], [{}, []]);
const intake = qualificationWrite('seller', parseQualification({ tenant_status: 'month to month', major_repairs: 'roof' }), { intake: { major_repairs: 'foundation' } }, 'Riley');
eq('answers without a column go into intake, only when blank', intake.patch, { intake: { major_repairs: 'foundation', tenant_status: 'month to month' } });
eq('a buyer gets the activity line only', qualificationWrite('buyer', q, {}, 'Riley').patch, {});
eq('nothing learned still says so', qualificationWrite('seller', parseQualification({}), {}, 'Riley').body, 'Nothing new was learned.');

// ---- DNC ----
eq('DNC is added', withDncTag(['hot'], hasDnc), ['hot', DNC_TAG]);
eq('a tag that already says do not call is left alone', [withDncTag(['do not call'], hasDnc), withDncTag(['DND'], hasDnc)], [null, null]);
eq('no tags', withDncTag(null, hasDnc), [DNC_TAG]);

// ---- tool configs ----
// deno-lint-ignore no-explicit-any
const tb = writeToolBody('book_appointment', 'https://p.supabase.co/functions/v1/voice-agent/', 'X-Voice-Agent-Secret', 's3cret') as any;
eq('book_appointment posts to its route with the secret', [tb.tool_config.name, tb.tool_config.api_schema.url, tb.tool_config.api_schema.request_headers], ['book_appointment', 'https://p.supabase.co/functions/v1/voice-agent/tool/book-appointment', { 'X-Voice-Agent-Secret': 's3cret' }]);
eq('kind is an enum the LLM picks from', tb.tool_config.api_schema.request_body_schema.properties.kind.enum, ['call', 'walkthrough', 'appointment']);
// deno-lint-ignore no-explicit-any
const cb = writeToolBody('get_compr_offer', 'https://p.supabase.co/functions/v1/voice-agent', 'X', 's') as any; // deno-lint-ignore no-explicit-any
eq('get_compr_offer posts to its route and says to wait for ready: true', [cb.tool_config.name, cb.tool_config.api_schema.url, /ready: true/.test(cb.tool_config.description)], ['get_compr_offer', 'https://p.supabase.co/functions/v1/voice-agent/tool/get-compr-offer', true]);
const qb = writeToolBody('save_qualification', 'https://p.supabase.co/functions/v1/voice-agent', 'X', 's') as any;
eq('save_qualification takes every field and the outcome enum', [Object.keys(qb.tool_config.api_schema.request_body_schema.properties).length, qb.tool_config.api_schema.request_body_schema.properties.outcome.enum.includes('do_not_contact')], [26, true]);
eq('book_appointment and save_qualification take a new caller\'s property address', [!!tb.tool_config.api_schema.request_body_schema.properties.property_address, !!qb.tool_config.api_schema.request_body_schema.properties.property_address], [true, true]);
ok('the timeout is inside the allowed 5 to 300 seconds', tb.tool_config.response_timeout_secs >= 5 && tb.tool_config.response_timeout_secs <= 300);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
