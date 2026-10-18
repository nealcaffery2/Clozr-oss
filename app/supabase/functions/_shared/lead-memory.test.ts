// Lead memory: cleaning model output, the no-model fallback, the prompt text.
// Run:  npx tsx supabase/functions/_shared/lead-memory.test.ts
import {
  BRIEF_MAX, briefForPrompt, clampBrief, fallbackMemory, historyText, normalizeFacts, ourSide, parseModelMemory, rowToMemory,
  type LeadHistory,
} from '../../../lib/lead-memory.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

const h: LeadHistory = {
  kind: 'seller', id: 7, name: 'ann smith',
  record: { name: 'ann smith', lead_stage: 'Offer Made', property_address: '12 Oak St', asking_price: 160000, motivation: 'Inherited, lives out of state', timeline: 'Before winter', next_task: 'Email the written offer' },
  items: [
    { at: '2026-09-01T15:00:00Z', kind: 'call', direction: 'outbound', text: 'Summary: first call, she inherited the house.' },
    { at: '2026-09-20T15:00:00Z', kind: 'sms', direction: 'inbound', text: 'Can you send the offer in writing?' },
    { at: '2099-01-01T15:00:00Z', kind: 'appointment', direction: null, text: 'Walkthrough' },
  ],
  deals: [{ stage: 'Offer Made', offer_amount: 140000 }],
  offers: [{ amount: 140000, status: 'sent', direction: 'outbound', at: '2026-09-15T00:00:00Z' }],
};

const fb = fallbackMemory(h);
eq('fallback first name', fb.facts.first_name, 'Ann');
eq('fallback numbers', [fb.facts.asking_price, fb.facts.offer_made], [160000, 140000]);
eq('fallback last contact is the newest real touch, not a future appointment', fb.facts.last_contact_at, '2026-09-20T15:00:00Z');
eq('fallback last contact summary', fb.facts.last_contact_summary, 'text (they): Can you send the offer in writing?');
eq('fallback next step from the open task', fb.facts.next_step, 'Email the written offer');
eq('fallback brief names the property and price', fb.brief.includes('12 Oak St') && fb.brief.includes('$160,000') && fb.brief.includes('$140,000'), true);
eq('fallback on an empty record says so', fallbackMemory({ ...h, record: {}, items: [], offers: [] }).brief, 'No conversations on file yet.');

eq('history is oldest first', historyText(h).indexOf('first call') < historyText(h).indexOf('in writing'), true);

const model = JSON.stringify({
  brief: 'Ann inherited 12 Oak St \u2014 wants out before winter.',
  facts: { first_name: 'Ann', asking_price: '$160,000', objections: ['price', 7, ''], sentiment: 'warm', do_not_mention: ['her late father'], extra: 1 },
});
const parsed = parseModelMemory(model)!;
eq('no em dash survives', parsed.brief.includes('\u2014'), false);
eq('money strings become numbers', parsed.facts.asking_price, 160000);
eq('non-string list items are dropped', parsed.facts.objections, ['price']);
eq('unknown sentiment becomes unknown', parsed.facts.sentiment, 'unknown');
eq('unknown keys are dropped', 'extra' in parsed.facts, false);
eq('bad JSON is null', parseModelMemory('not json'), null);
eq('an empty brief is null', parseModelMemory('{"brief":"","facts":{}}'), null);
eq('brief is clamped', clampBrief('x. '.repeat(1000)).length <= BRIEF_MAX, true);
eq('facts default to empty lists', normalizeFacts(null).promises_made, []);
eq('prompt brief carries do-not-mention', briefForPrompt(parsed), 'Ann inherited 12 Oak St, wants out before winter.\nDo not mention: her late father');
eq('no memory, no prompt text', briefForPrompt(null), '');
eq('a stored row reads back', rowToMemory({ workspace_id: 1, record_kind: 'buyer', record_id: 3, brief: 'b', facts: {}, updated_at: 'x' })?.record_kind, 'buyer');
eq('a row of the wrong kind is null', rowToMemory({ record_kind: 'deal' }), null);

const names = { riley: 'Riley', cody: 'Cody' };
eq('an AI call names the agent who made it', ourSide({ call_origin: 'ai_agent', ai_agent_key: 'riley' }, names), '(Call by the AI agent Riley; "Rep" in the transcript is Riley.)');
eq('an AI call by an agent since deleted still says it was an AI agent', ourSide({ call_origin: 'ai_agent', ai_agent_key: 'gone' }, names), '(Call by one of our AI agents; "Rep" in the transcript is that agent.)');
eq('a text an agent sent names it', ourSide({ ai_agent_key: 'cody', direction: 'outbound' }, names), '(Sent by the AI agent Cody.)');
eq('a rep call or their reply is not labelled', [ourSide({ direction: 'outbound' }, names), ourSide({ ai_agent_key: 'cody', direction: 'inbound' }, names)], ['', '']);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
