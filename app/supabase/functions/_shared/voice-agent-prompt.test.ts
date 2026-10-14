// assemblePrompt and its warnings: the locked compliance block, tool gating,
// slider sentences, rules, offer authority, transfer, knowledge, the two built-in
// templates. Run:  npx tsx supabase/functions/_shared/voice-agent-prompt.test.ts
//   or: deno run supabase/functions/_shared/voice-agent-prompt.test.ts
import { DYNAMIC_VARIABLES } from './voice-agent.ts';
import { TOOL_AVAILABLE, TOOL_KEYS, defaultSettings, normalizeSettings, toolOn, type AgentSettings, type ToolKey } from './voice-agent-settings.ts';
import { TEMPLATES } from './voice-agent-templates.ts';
import { assemblePrompt, estimateTokens, lockedBlock, promptWarnings, resolveConditionals, transferTriggers } from './voice-agent-prompt.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; } else console.log(`PASS  ${name}`);
}
function ok(name: string, cond: boolean, detail?: unknown) { eq(name, cond ? true : { failed: detail ?? null }, true); }

const D = defaultSettings();
const mk = (patch: Record<string, unknown>, base: AgentSettings = D) => {
  const r = normalizeSettings(patch, base);
  if (r.errors.length) throw new Error(r.errors.join('; '));
  return r.settings;
};
const P = (s: AgentSettings) => assemblePrompt(s, TEMPLATES);
const vars = (p: string) => [...p.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
const withTemplate = (id: string) => {
  const t = TEMPLATES[id];
  return mk({ ...t.settings, script: { ...(t.settings.script as object), sections: t.sections } });
};
const TOOL_NAMES: Record<ToolKey, string> = {
  lead_context: 'lead_context', book_appointment: 'book_appointment', save_qualification: 'save_qualification', mark_do_not_contact: 'mark_do_not_contact',
  get_compr_offer: 'get_compr_offer', request_agreement: 'request_agreement', transfer: 'transfer_to_number', end_call: 'end_call',
};

// ---- determinism, structure ----
eq('the same settings give the same prompt', P(D), P(structuredClone(D)));
ok('the prompt has no em dash', !P(withTemplate('lead_manager')).includes('\u2014') && !P(withTemplate('acquisitions')).includes('\u2014'));
ok('no unresolved conditional or TODO in either template', ['lead_manager', 'acquisitions'].every((id) => { const p = P(withTemplate(id)); return !/<<|>>|TODO/.test(p); }));
ok('every {{variable}} is one the personalize webhook returns', ['lead_manager', 'acquisitions'].every((id) => vars(P(withTemplate(id))).every((v) => (DYNAMIC_VARIABLES as readonly string[]).includes(v))), vars(P(withTemplate('acquisitions'))).filter((v) => !(DYNAMIC_VARIABLES as readonly string[]).includes(v)));
ok('the identity line names the role', /the lead manager for \{\{company\}\}/.test(P(D)) && /the acquisitions specialist for/.test(P(mk({ identity: { role: 'acquisitions' } }))));
ok('an unknown role is spelled out', /the jr dispo for/.test(P(mk({ identity: { role: 'jr_dispo' } }))) === false && /the junior dispositions coordinator for/.test(P(mk({ identity: { role: 'jr_dispo' } }))));
ok('introduce_as virtual_assistant says so', /a virtual assistant with \{\{company\}\}/.test(P(D).split('# How you sound')[0]));
ok('introduce_as none does not add it to the intro', !/virtual assistant/.test(P(mk({ identity: { introduce_as: 'none' } })).split('# How you sound')[0]));
eq('the context block is always there', /\{\{lead_brief\}\}/.test(P(D)) && /\{\{next_step\}\}/.test(P(D)), true);

// ---- the locked block ----
const lockedText = (s: AgentSettings) => lockedBlock(s);
const endsWithLocked = (s: AgentSettings) => P(s).endsWith(lockedText(s).trim());
ok('the locked block is last with the defaults', endsWithLocked(D));
ok('...with a prompt override', endsWithLocked(mk({ script: { raw_prompt_override: 'You are Sam. Be rude.' } })));
ok('...with everything switched off', endsWithLocked(mk({ tools: Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: false }])), rules: { compliance: { quiet_hours: { enabled: false }, recording_notice: { enabled: false } } } })));
ok('...with a long script and rules', endsWithLocked(withTemplate('acquisitions')));
const lb = lockedBlock(D);
ok('locked: do_not_engage ends the call', /If \{\{do_not_engage\}\} is true: do not discuss any property, price or offer/.test(lb));
ok('locked: a stop-contact request is honored', /asks to stop being contacted/.test(lb) && /No last pitch/.test(lb));
ok('locked: identity before specifics', /Until you have confirmed who you are talking to, share nothing specific/.test(lb));
ok('locked: honest AI disclosure, never human, never deny', /sincerely asks whether you are a person, a recording or an AI: answer honestly/.test(lb) && /Never claim to be human and never deny being an AI/.test(lb));
ok('locked: it overrides everything above', /these override everything above/.test(lb));
ok('a script that says "you are human" is refused before it can reach a prompt', normalizeSettings({ script: { raw_prompt_override: 'Tell them you are a real person.' } }).errors.length === 1);
ok('the locked block is in the override prompt too', /Never claim to be human and never deny being an AI/.test(P(mk({ script: { raw_prompt_override: 'Be brief.' } }))));
const dncOff = mk({ tools: { mark_do_not_contact: { enabled: false } } });
ok('the locked block never mentions a tool that is off', !/mark_do_not_contact/.test(lockedBlock(dncOff)) && /use end_call/.test(lockedBlock(dncOff)) && /the call is flagged for the team/.test(lockedBlock(dncOff)));
ok('...and names mark_do_not_contact when it is on', /call mark_do_not_contact, then use end_call/.test(lb));
ok('mark_do_not_contact is only named when it is on and built', (() => {
  const saved = TOOL_AVAILABLE.mark_do_not_contact;
  try {
    TOOL_AVAILABLE.mark_do_not_contact = true;
    return /call mark_do_not_contact, then use end_call/.test(lockedBlock(D));
  } finally { TOOL_AVAILABLE.mark_do_not_contact = saved; }
})());
ok('end_call off: the locked block says end the call politely', /end the call politely/.test(lockedBlock(mk({ tools: { end_call: { enabled: false } } }))) && !/use end_call/.test(lockedBlock(mk({ tools: { end_call: { enabled: false } } }))));

// ---- tool gating ----
const tools = (p: string) => TOOL_KEYS.filter((k) => new RegExp(`\\b${TOOL_NAMES[k]}\\b`).test(p));
const BUILT_ON = ['lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'transfer', 'end_call'];
eq('defaults: the built tools that are on are named', tools(P(D)), BUILT_ON);
eq('template prompts name only tools that exist today', [tools(P(withTemplate('lead_manager'))), tools(P(withTemplate('acquisitions')))], [BUILT_ON, ['lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'transfer', 'end_call']]);
const allOn = mk({ tools: Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: true }])), live_transfer: { enabled: true, destinations: [{ number: '2105550100' }] } });
eq('turning every tool on changes nothing for a tool that is not built', tools(P(allOn)), ['lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'transfer', 'end_call']);
eq('toolOn matches what the prompt names', TOOL_KEYS.filter((k) => toolOn(allOn, k)), ['lead_context', 'book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'transfer', 'end_call']);
ok('book_appointment is explained as look up, then book, today first', /book_appointment: get real open times and book the appointment\. Aim for today: call it without starts_at/.test(P(D)));
ok('the lead manager books and saves out of the box', /call book_appointment to get real open times/.test(P(withTemplate('lead_manager'))) && /call save_qualification with whatever you learned/.test(P(withTemplate('lead_manager'))));
ok('the tools block says there is nothing else', /You have no other tools/.test(P(D)));
ok('lead_context disabled leaves the prompt without it', !/\blead_context\b/.test(P(mk({ tools: { lead_context: { enabled: false } } }))));
// Flip availability as if the tools were built.
function withBuilt(keys: ToolKey[], fn: () => void) {
  const saved = { ...TOOL_AVAILABLE };
  try { for (const k of keys) TOOL_AVAILABLE[k] = true; fn(); } finally { Object.assign(TOOL_AVAILABLE, saved); }
}
withBuilt(['book_appointment', 'save_qualification', 'mark_do_not_contact', 'get_compr_offer', 'request_agreement'], () => {
  const lm = withTemplate('lead_manager'); const acq = withTemplate('acquisitions');
  const full = mk({ tools: Object.fromEntries(TOOL_KEYS.map((k) => [k, { enabled: true }])) }, acq);
  ok('once built, the lead manager books and saves', /call book_appointment to get real open times/.test(P(lm)) && /call save_qualification with whatever you learned/.test(P(lm)) && /call mark_do_not_contact, then use end_call/.test(P(lm)));
  ok('once built, the acquisitions agent can request the agreement and fetch the range', /Call request_agreement/.test(P(full)) && /call get_compr_offer before you quote/.test(P(full)));
  ok('once built, the fallback wording is gone', !/cannot lock in a time yourself/.test(P(lm)) && !/Only a team member sends the agreement/.test(P(full)));
  ok('once built, no unresolved markers', !/<<|>>/.test(P(lm)) && !/<<|>>/.test(P(full)));
});
const lmOff = mk({ tools: { book_appointment: { enabled: false }, save_qualification: { enabled: false }, mark_do_not_contact: { enabled: false } } }, withTemplate('lead_manager'));
ok('switched off: the lead manager falls back to noting the next step', /note the best time for \{\{rep_name\}\}/.test(P(lmOff)) && /cannot lock in a time yourself/.test(P(lmOff)) && /The call is logged for the team/.test(P(lmOff)));
ok('an acquisitions agent with COMPR waits for ready: true before any number', /Until it answers ready: true you have no range/.test(P(withTemplate('acquisitions'))) && /keep qualifying meanwhile/.test(P(withTemplate('acquisitions'))));
ok('switched off: none of the three is named', !/book_appointment|save_qualification|mark_do_not_contact/.test(P(lmOff)));
ok('every agent answers direct questions and handles a second push on price', /answer it in your first sentence/.test(P(lmOff)) && /If they push a second time, do not repeat that line/.test(P(lmOff)));
ok('who they will talk to: the booked name when booking is on, else the rep', /with_name/.test(P(mk({ tools: { book_appointment: { enabled: true } } }, withTemplate('lead_manager')))) && /they ask who they will be speaking with: give \{\{rep_name\}\}/.test(P(lmOff)));
ok('not built: the acquisitions agent leaves the agreement to a person', /Only a team member sends the agreement/.test(P(withTemplate('acquisitions'))));
eq('resolveConditionals picks the branch', [resolveConditionals('a<<if end_call>>B<<else>>C<<end>>d', D), resolveConditionals('a<<if request_agreement>>B<<else>>C<<end>>d', D), resolveConditionals('a<<if request_agreement>>B<<end>>d', D), resolveConditionals('<<if nonsense>>B<<else>>C<<end>>', D)], ['aBd', 'aCd', 'ad', 'C']);
ok('an unknown or unclosed conditional is warned about', promptWarnings(mk({ script: { sections: [{ id: 'a', title: 't', body: 'x <<if unclosed>> y' }] } }), TEMPLATES).some((w) => w.code === 'unresolved_conditional'));

// ---- personality sentences ----
const pers = (patch: Record<string, unknown>) => P(mk({ personality: patch })).split('# What we know')[0];
ok('energy 1 and 5 differ', /Energy: very calm and low-key/.test(pers({ energy: 1 })) && /Energy: high-energy/.test(pers({ energy: 5 })));
ok('warmth, formality and length sentences', /Warmth: very warm and personable/.test(pers({ warmth: 5 })) && /Formality: very casual/.test(pers({ formality: 1 })) && /Length: as brief as possible/.test(pers({ verbosity: 1 })) && /Length: thorough/.test(pers({ verbosity: 5 })));
ok('fillers on and off', /short, casual reaction/.test(pers({ use_fillers: true })) && /Do not use filler words/.test(pers({ use_fillers: false })));
ok('every agent is told not to recap or cheer', [pers({ use_fillers: true }), pers({ use_fillers: false })].every((t) => /Do not repeat or recap what the caller just said/.test(t) && /no "Great!", "Perfect!"/.test(t)));
ok('no stock acknowledgement is suggested anywhere', !/Gotcha|"Got it\."|that is great to hear/i.test(P(withTemplate('lead_manager')) + P(withTemplate('acquisitions')) + P(withTemplate('speed_to_lead')) + P(mk({ personality: { expressiveness: 'expressive' }, voice: { tts_model: 'eleven_v3_conversational' } }))));
ok('mirroring is occasional, not after every answer', /Tactical empathy, used sparingly/.test(P(mk({ personality: { expressiveness: 'natural' } }))));
const V3 = 'eleven_v3_conversational';
const dl = (expressiveness: string, tts_model = V3, use_fillers = true) => P(mk({ personality: { expressiveness, use_fillers }, voice: { tts_model } })).split('# What we know')[0];
ok('delivery off adds nothing', !/Tactical empathy/.test(dl('off')) && !/\[laughs\]/.test(dl('off')));
ok('natural: hesitations, pauses and tactical empathy, no sound tags', /"um"/.test(dl('natural')) && /Tactical empathy/.test(dl('natural')) && !/\[clears throat\]/.test(dl('natural')));
ok('expressive on v3: sound tags including the throat clear', /\[clears throat\]/.test(dl('expressive')) && /\[laughs\]/.test(dl('expressive')) && /Never use coughing, sniffling/.test(dl('expressive')));
ok('expressive on another model teaches no tags (they would be read out)', !/\[laughs\]/.test(dl('expressive', 'eleven_v4_turbo')) && /Tactical empathy/.test(dl('expressive', 'eleven_v4_turbo')));
ok('...and warns', promptWarnings(mk({ personality: { expressiveness: 'expressive' } }), TEMPLATES).some((w) => w.code === 'expressive_needs_v3') && !promptWarnings(mk({ personality: { expressiveness: 'expressive' }, voice: { tts_model: V3 } }), TEMPLATES).some((w) => w.code === 'expressive_needs_v3'));
ok('fillers off drops the "um" line but keeps empathy', !/"um"/.test(dl('natural', V3, false)) && /Tactical empathy/.test(dl('natural', V3, false)));
ok('humor levels', /No jokes/.test(pers({ humor: 0 })) && /playful humor/.test(pers({ humor: 3 })));
ok('tone lines', /direct and efficient/.test(pers({ tone: 'direct' })) && /polished and professional/.test(pers({ tone: 'professional' })) && /warm and unhurried/.test(pers({ tone: 'warm' })));
ok('a prompt override drops the personality block', !/# How you sound/.test(P(mk({ script: { raw_prompt_override: 'Talk like a pirate.' } }))));
ok('...and uses the override text', /Talk like a pirate\./.test(P(mk({ script: { raw_prompt_override: 'Talk like a pirate.' } }))));
ok('...but keeps rules, offers and tools', /# Offers/.test(P(mk({ script: { raw_prompt_override: 'x' } }))) && /# Tools you have/.test(P(mk({ script: { raw_prompt_override: 'x' } }))));

// ---- script sources ----
const conv = (s: AgentSettings) => P(s).split('# The conversation')[1] ?? '';
ok('enabled sections are used, disabled ones are not', (() => {
  const s = mk({ script: { sections: [{ id: 'a', title: 'Open', body: 'Say hello.', enabled: true }, { id: 'b', title: 'Skip', body: 'Never appears.', enabled: false }] } });
  return /## Open\nSay hello\./.test(P(s)) && !/Never appears/.test(P(s));
})());
ok('with no sections the pasted master script is used', /## Master script[\s\S]*Follow this process[\s\S]*Ask about the roof\./.test(P(mk({ script: { master_script_text: 'Ask about the roof.' } }))));
ok('with nothing, the template sections fill in', /## Your job/.test(P(mk({ script: { template_id: 'lead_manager' } }))));
ok('with nothing at all there is no conversation block', !/# The conversation/.test(P(D)));
ok('sections beat the master script', !/Master script/.test(P(mk({ script: { master_script_text: 'M', sections: [{ id: 'a', title: 't', body: 'body' }] } }))));
ok('the override beats sections', !/## Open/.test(P(mk({ script: { raw_prompt_override: 'O', sections: [{ id: 'a', title: 'Open', body: 'body' }] } }))));
ok('section text keeps real variables', /\{\{first_name\}\}/.test(conv(mk({ script: { sections: [{ id: 'a', title: 't', body: 'Hi {{first_name}}' }] } }))));

// ---- rules ----
const r = P(mk({ rules: {
  dos: [{ text: 'Always confirm the address', severity: 'hard' }, { text: 'Use their first name', severity: 'soft' }],
  donts: [{ text: 'Never mention competitors', severity: 'hard' }, { text: 'Do not interrupt', severity: 'soft' }],
  never_mention: ['the divorce'], forbidden_phrases: ['no fees'], required_phrases: [{ when: 'they ask who you are', text: 'We buy houses directly' }],
} }));
ok('hard rules are listed under never break', /Hard rules \(never break these\):\n- Always: Confirm the address\n- Never: Mention competitors/.test(r), r);
ok('soft rules are listed separately', /Soft rules[^\n]*:\n- Always: Use their first name\n- Never: Interrupt/.test(r));
ok('never_mention, forbidden phrases and required wording', /Never bring up, whatever the brief says: the divorce/.test(r) && /Never say these words or phrases: "no fees"/.test(r) && /When they ask who you are, say: "We buy houses directly"/.test(r));
ok('no rules, no rules block', !/# Rules/.test(P(D)));
ok('a rule keeps a real variable', /\{\{rep_name\}\}/.test(P(mk({ rules: { dos: [{ text: 'Mention {{rep_name}}' }] } }))));

// ---- offer authority ----
ok('none: no offers, no range variables', /You do not make offers/.test(P(D)) && !/\{\{offer_low\}\}/.test(P(D)));
const range = P(mk({ offer_authority: { mode: 'range_only', allow_step_ups: true, step_size_pct: 3 } }));
ok('range_only: the range, the ceiling rules and steps', /approved range is \{\{offer_low\}\} to \{\{offer_high\}\}/.test(range) && /never past \{\{offer_high\}\}/.test(range) && /about 3 percent/.test(range) && /quote no number at all/.test(range));
ok('range_only without step-ups: one number, no moving', /State one number inside the range\. Do not move it/.test(P(mk({ offer_authority: { mode: 'range_only', allow_step_ups: false } }))));
ok('range_with_approval: a person approves', /A person on the team approves any agreement/.test(P(mk({ offer_authority: { mode: 'range_with_approval' } }))));
ok('approval required text follows the switch', /needs a person's approval/.test(P(mk({ offer_authority: { mode: 'range_only', agreement_requires_rep_approval: true } }))) && !/needs a person's approval/.test(P(mk({ offer_authority: { mode: 'range_only', agreement_requires_rep_approval: false } }))));
ok('the range never reveals a ceiling', /Do not reveal how the range was calculated or that a ceiling exists/.test(range));
ok('subject to written agreement', /subject to a written agreement, title/.test(range));

// ---- live transfer ----
ok('transfer off: cannot transfer', /You cannot transfer calls/.test(P(mk({ live_transfer: { enabled: false, destinations: [] } }))));
ok('by default a positive call is handed to the rep, or booked today when they are tied up', /A positive conversation goes to a person while it is warm/.test(P(D)) && /If \{\{rep_available\}\} is "no" or \{\{rep_phone\}\} is empty/.test(P(D)) && /book the soonest time today on their calendar/.test(P(D)));
const xfer = mk({ live_transfer: { enabled: true, mode: 'warm', destinations: [{ label: 'Office', number: '2105550100' }], triggers: { asks_for_person: true, hot_lead: true, angry_or_escalating: true, legal_or_complex: true, above_range: true, custom: [{ text: 'They mention a lawyer' }] }, fallback: 'apologize_end' }, offer_authority: { mode: 'range_only' } });
const xp = P(xfer);
ok('transfer on: the tool and every trigger', /transfer_to_number tool, when: the caller asks to speak to a person; the conversation is positive/.test(xp) && /angry/.test(xp) && /legal or too complex/.test(xp) && /above your approved range/.test(xp) && /They mention a lawyer/.test(xp));
ok('warm vs cold wording', /warm hand-off, never a surprise/.test(xp) && /only transfer on a yes/.test(xp) && /Tell the caller in one short sentence that you are transferring them/.test(P(mk({ live_transfer: { mode: 'cold' } }, xfer))));
ok('fallbacks', /apologize, say the team will be in touch/.test(xp) && /offer to take a message/.test(P(mk({ live_transfer: { fallback: 'voicemail' } }, xfer))) && /book the soonest time today on their calendar with book_appointment/.test(P(mk({ live_transfer: { fallback: 'book_callback' } }, xfer))) && /agree the soonest callback time today and note it/.test(P(mk({ live_transfer: { fallback: 'book_callback' }, tools: { book_appointment: { enabled: false } } }, xfer))));
eq('the above_range trigger is dropped while offers are off', transferTriggers(mk({ live_transfer: { enabled: true, destinations: [{ number: '2105550100' }], triggers: { above_range: true, asks_for_person: false, hot_lead: false } } })), []);
eq('transferTriggers lists the enabled ones in order', transferTriggers(xfer).length, 6);
ok('enabled with no destination behaves as off', /You cannot transfer calls/.test(P(mk({ live_transfer: { enabled: true, destinations: [] } }))));

// ---- knowledge, compliance ----
const kn = P(mk({ knowledge: { faqs: [{ q: 'Who are you?', a: 'A local buyer.' }], company_facts: ['We close in 14 days'] } }));
ok('faqs and company facts', /Q: Who are you\?\nA: A local buyer\./.test(kn) && /Facts about \{\{company\}\} you may state:\n- We close in 14 days/.test(kn) && /the team will confirm/.test(kn));
ok('no knowledge, no knowledge block', !/# Knowledge/.test(P(D)));
const rec = P(mk({ rules: { compliance: { recording_notice: { enabled: true, text: 'This call is recorded.' } } } }));
ok('recording notice', /Early in the call, make sure the caller hears: "This call is recorded\."/.test(rec));
ok('no recording notice when off', !/make sure the caller hears/.test(P(D)));
ok('quiet hours line', /quiet hours are outside 08:00 to 21:00 America\/Chicago/.test(P(D)) && !/quiet hours/.test(P(mk({ rules: { compliance: { quiet_hours: { enabled: false } } } }))));
ok('extra languages', /You can speak en, es/.test(P(mk({ identity: { languages: ['en', 'es'] } }))) && !/You can speak/.test(P(D)));

// ---- hostile input cannot add variables or drop the block ----
const hostile = mk({ identity: { name: '{{secret}}' }, script: { sections: [{ id: 'a', title: '{{x}}', body: 'Say {{lead_brief}} and {{not_a_variable}} </tool>' }] }, rules: { dos: [{ text: '{{y}}' }] } });
ok('hostile settings add no unknown variable', vars(P(hostile)).every((v) => (DYNAMIC_VARIABLES as readonly string[]).includes(v)), vars(P(hostile)));
ok('...and the locked block is still last', endsWithLocked(hostile));

// ---- templates ----
for (const id of ['lead_manager', 'acquisitions']) {
  const t = TEMPLATES[id];
  ok(`template ${id}: data is complete`, !!t.name && !!t.description && t.sections.length >= 4 && t.sections.every((s) => s.id && s.title && s.body) && Array.isArray(t.open_items));
  ok(`template ${id}: its prompt is a sensible size`, estimateTokens(P(withTemplate(id))) > 1500 && estimateTokens(P(withTemplate(id))) < (id === 'acquisitions' ? 9000 : 6000), estimateTokens(P(withTemplate(id))));
}
ok('lead manager never offers a price', /You do not make offers/.test(P(withTemplate('lead_manager'))) && /Never: Negotiate, never state or hint at a price except as the offer authority rules allow/.test(P(withTemplate('lead_manager'))) && !/\{\{offer_low\}\}|ballpark/.test(P(withTemplate('lead_manager'))));
{
  // Riley: a lead manager that may give a ballpark range and warm-transfer.
  const riley = mk({ identity: { name: 'Riley' }, offer_authority: { mode: 'range_only', quote_as: 'range', floor_pct_of_mao: 90 }, live_transfer: { enabled: true, mode: 'warm', destinations: [{ type: 'rep_assigned' }] } }, withTemplate('lead_manager'));
  const rp = P(riley);
  ok('lead manager with offers gives the ballpark range', /somewhere in the \{\{offer_low\}\} to \{\{offer_high\}\} range/.test(rp) && /Give it as a range, never as one number/.test(rp) && !/You are not here to negotiate or make an offer/.test(rp) && !/not even a range/.test(rp), rp);
  ok('a range is never stepped up', !/Move up only in small steps/.test(rp));
  ok('lead manager offers the warm transfer and briefs through save_qualification', /Want me to grab someone from our acquisitions team/.test(rp) && /save_qualification with outcome "transferred"/.test(rp) && /call transfer_to_number/.test(rp));
  eq('Riley has no warning-level findings', promptWarnings(riley, TEMPLATES).filter((w) => w.level === 'warning'), []);
  ok('one number is still the default quote', /State one number inside the range|Start at or near \{\{offer_low\}\}/.test(P(withTemplate('acquisitions'))) && !/Give it as a range/.test(P(withTemplate('acquisitions'))));
  eq('<<if offers>> follows offer authority', [resolveConditionals('<<if offers>>a<<else>>b<<end>>', mk({ offer_authority: { mode: 'range_only' } })), resolveConditionals('<<if offers>>a<<else>>b<<end>>', D)], ['a', 'b']);
}
ok('lead manager forbids guarantee wording', /Never say these words or phrases: "no fees", "guaranteed cash", "guaranteed closing", "guaranteed price"/.test(P(withTemplate('lead_manager'))));
ok('acquisitions has an approved range and approval', /approved range is \{\{offer_low\}\} to \{\{offer_high\}\}/.test(P(withTemplate('acquisitions'))) && /A person on the team approves any agreement/.test(P(withTemplate('acquisitions'))));
ok('acquisitions branches on lead_source', /If \{\{lead_source\}\} is "form"/.test(P(withTemplate('acquisitions'))) && /If \{\{lead_source\}\} is "outbound"/.test(P(withTemplate('acquisitions'))));
const acqP = P(withTemplate('acquisitions'));
ok('acquisitions states the company promises exactly as the master script words them', ['no fees, no repairs, no agents, no drama', "we don't change the price on you after we go under contract, and we don't cancel last-minute", 'We either make the number work or we walk away respectfully'].every((t) => acqP.includes(t)));
ok('the only reasons the price would change are undisclosed problems', /only reasons the price would ever change are things the seller did not tell us about, like a cracked foundation or a roof and HVAC that are badly beaten up/.test(acqP) && /cracked foundation or a roof and HVAC that are badly beaten up/.test(acqP));
ok('acquisitions never says guaranteed', /do not say guaranteed about price, closing or approval/.test(acqP) && /Never: Say "guaranteed" about price, closing or approval/.test(acqP) && /Never say these words or phrases: "guaranteed price", "guaranteed closing", "guaranteed approval"/.test(acqP));
ok('the promises are their own section, so the UI can toggle them', (() => {
  const t = TEMPLATES.acquisitions; const frame = t.sections.find((x) => x.id === 'frame');
  const off = mk({ ...t.settings, script: { ...(t.settings.script as object), sections: t.sections.map((x) => (x.id === 'frame' ? { ...x, enabled: false } : x)) } });
  return !!frame && frame.enabled && !P(off).includes('no fees, no repairs') && !P(off).includes("we don't cancel last-minute") && /Call flow: price and close/.test(P(off));
})());
ok('acquisitions is honest: no fake underwriter hold, no invented buyers, the truth about assigning', /Never pretend to check with an underwriter, a finance department, a partner or a manager/.test(acqP) && /Never invent other buyers, other offers, limited funds, deadlines/.test(acqP) && /Sometimes we buy and fix them up ourselves, and sometimes we pass the contract/.test(acqP));
ok('acquisitions asks price early and shows the math net to net', acqP.indexOf('How much are you looking to get for it?') < acqP.indexOf("What's got you wanting to sell?") && /Net to net/.test(acqP) && /If the math didn't change, the offer doesn't change/.test(acqP));
ok('the section order keeps the script in order', (() => { const i = (t: string) => acqP.indexOf(t); return i('## Call flow: open, price, story') < i('## Company promises') && i('## Company promises') < i('## Call flow: price and close') && i('## Call flow: price and close') < i('## Objections'); })());
ok('the acquisitions open items no longer ask about the promises', !TEMPLATES.acquisitions.open_items.some((t) => /no fees|cancel last-minute/.test(t)));

// ---- warnings ----
const codes = (s: AgentSettings) => promptWarnings(s, TEMPLATES).map((w) => w.code);
ok('unbuilt tools switched on are reported as info', promptWarnings(withTemplate('acquisitions'), TEMPLATES).filter((w) => w.code === 'tool_unavailable').map((w) => w.path).join() === 'tools.request_agreement');
ok('the lead manager has none left unbuilt', !promptWarnings(withTemplate('lead_manager'), TEMPLATES).some((w) => w.code === 'tool_unavailable'));
ok('tool_unavailable is info, not a warning', promptWarnings(withTemplate('acquisitions'), TEMPLATES).filter((w) => w.code === 'tool_unavailable').every((w) => w.level === 'info'));
ok('a tool named in text but not on is a warning', promptWarnings(mk({ script: { sections: [{ id: 'a', title: 't', body: 'Then call request_agreement to send it.' }] } }), TEMPLATES).some((w) => w.code === 'tool_referenced_unavailable' && /request_agreement/.test(w.message)));
ok('...also for a built tool that is switched off', promptWarnings(mk({ tools: { book_appointment: { enabled: false } }, script: { sections: [{ id: 'a', title: 't', body: 'Then call book_appointment to book.' }] } }), TEMPLATES).some((w) => w.code === 'tool_referenced_unavailable' && /switched off/.test(w.message)));
ok('...but not when it is wrapped in a conditional that resolves away', !codes(mk({ script: { sections: [{ id: 'a', title: 't', body: '<<if request_agreement>>call request_agreement<<end>>' }] } })).includes('tool_referenced_unavailable'));
ok('...and not for a tool that is on', !codes(mk({ script: { sections: [{ id: 'a', title: 't', body: 'Use lead_context if unsure.' }] } })).includes('tool_referenced_unavailable'));
ok('conflicting rules: the same thing as Always and Never', codes(mk({ rules: { dos: [{ text: 'Always mention the price' }], donts: [{ text: 'Never mention the price' }] } })).includes('conflicting_rules'));
ok('conflicting rules: required wording contains a forbidden phrase', codes(mk({ rules: { forbidden_phrases: ['guaranteed'], required_phrases: [{ when: 'closing', text: 'It is guaranteed to close' }] } })).includes('conflicting_rules'));
ok('conflicting rules: a faq mentions a never-mention topic', codes(mk({ rules: { never_mention: ['the divorce'] }, knowledge: { faqs: [{ q: 'Why sell?', a: 'Many sell after the divorce.' }] } })).includes('conflicting_rules'));
ok('no conflict for unrelated rules', !codes(mk({ rules: { dos: [{ text: 'Ask one question' }], donts: [{ text: 'Never rush' }] } })).includes('conflicting_rules'));
ok('offer text without authority', codes(mk({ script: { sections: [{ id: 'a', title: 't', body: 'Quote the approved range to the seller.' }] } })).includes('offer_text_without_authority'));
ok('transfer on with no destination', codes(mk({ live_transfer: { enabled: true, destinations: [] } })).includes('transfer_no_destination'));
ok('above_range trigger with offers off', codes(mk({ live_transfer: { enabled: true, destinations: [{ number: '2105550100' }], triggers: { above_range: true } } })).includes('trigger_needs_offers'));
ok('a rep-assigned destination is flagged', codes(mk({ live_transfer: { enabled: true, destinations: [{ type: 'rep_assigned' }] } })).includes('rep_line'));
ok('an override hides the sections', codes(mk({ script: { raw_prompt_override: 'x', sections: [{ id: 'a', title: 't', body: 'b' }] } })).includes('override_hides_sections'));
ok('an empty script is warned about', codes(D).includes('empty_script') && !codes(mk({ script: { template_id: 'lead_manager' } })).includes('empty_script'));
ok('call hours outside quiet hours', codes(mk({ call_handling: { call_hours: { start: '06:00', end: '22:00' } } })).includes('hours_outside_quiet') && !codes(D).includes('hours_outside_quiet'));
ok('extra languages are flagged', codes(mk({ identity: { languages: ['en', 'es'] } })).includes('extra_languages'));
ok('a very long prompt is flagged', codes(mk({ script: { sections: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, body: 'word '.repeat(1500) })) } })).includes('long_prompt'));
ok('a nameless agent is warned about', codes(D).includes('missing_name') && !codes(mk({ identity: { name: 'Riley' } })).includes('missing_name'));
eq('a clean, named lead manager has no warning-level findings', promptWarnings(mk({ identity: { name: 'Riley' } }, withTemplate('lead_manager')), TEMPLATES).filter((w) => w.level === 'warning'), []);
eq('estimateTokens', [estimateTokens(''), estimateTokens('abcd'), estimateTokens('abcde')], [0, 1, 2]);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');

// Every agent knows a call screener is not the person.
{
  const p = assemblePrompt(defaultSettings());
  if (!p.includes('# Call screening') || !p.includes("it's {{agent_name}} from {{company}}")) throw new Error('call screening block missing');
  console.log('PASS  call screening block');
}
