// Picking up for reps on no answer (docs/voice-agent.md, "Picking up for reps"):
// who an agent covers, what publish tells Talkr, the covering opener and
// prompt block, and the dispo agent's deal_lookup lane.
// Run:  deno run -A supabase/functions/_shared/voice-agent-overflow.test.ts
import { coversTitle, overflowLinePatches, teamOfRole, teamOfTitle } from './voice-agent-overflow.ts';
import { askingPrice, dealStatus, dealsForBuyer, type DealRow } from './voice-agent-tools.ts';
import { DYNAMIC_VARIABLES, NO_EXTRAS, buildInitiation } from './voice-agent.ts';
import { defaultSettings, normalizeSettings, toolOn, type AgentSettings } from './voice-agent-settings.ts';
import { assemblePrompt, coveringBlock, estimateTokens, lockedBlock } from './voice-agent-prompt.ts';
const coveringBlockTokens = (s: AgentSettings) => estimateTokens(coveringBlock(s));
import { TEMPLATES } from './voice-agent-templates.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; } else console.log(`PASS  ${name}`);
}
const ok = (name: string, cond: boolean) => eq(name, cond, true);

// ---- who an agent covers ----------------------------------------------------------
eq('title: Dispositions', teamOfTitle('Dispositions'), 'dispositions');
eq('title: Dispo Manager', teamOfTitle('Dispo Manager'), 'dispositions');
eq('title: Acquisitions', teamOfTitle('Acquisitions'), 'acquisitions');
eq('title: Lead Manager', teamOfTitle('Lead Manager'), 'lead_manager');
eq('title: CEO is another job', teamOfTitle('CEO'), 'other');
eq('title: blank is no team', teamOfTitle('  '), null);
eq('title: null is no team', teamOfTitle(null), null);
eq('role: buyer_assistant covers dispo', teamOfRole('buyer_assistant'), 'dispositions');
eq('role: compr demo covers nobody', teamOfRole('compr_demo_setter'), null);
ok('Avery covers Morgan (Dispositions)', coversTitle('buyer_assistant', 'Dispositions'));
ok('Avery does not cover an acquisitions rep', !coversTitle('buyer_assistant', 'Acquisitions'));
ok('Jordan covers an acquisitions rep', coversTitle('acquisitions', 'Acquisitions Specialist'));
ok('Jordan does not cover a dispo rep', !coversTitle('acquisitions', 'Dispositions'));
ok('Riley covers a rep with no title', coversTitle('lead_manager', null));
ok('Riley does not cover the TC', !coversTitle('lead_manager', 'Transaction Coordinator'));
ok('Riley does not cover a dispo rep', !coversTitle('lead_manager', 'Dispositions'));

// ---- what publish tells Talkr ------------------------------------------------------
const on = { enabled: true, ring_seconds: 20 };
eq('switch on: every covered line points at the agent, once', overflowLinePatches(on, '+12145559557', [
  { phone_e164: '+15125555917', label: 'Morgan · Austin 1' }, { phone_e164: '+15125555917', label: 'dupe' }, { phone_e164: '+12105558722', label: 'Riley Main' },
], []), [
  { phone_e164: '+15125555917', overflow_to_e164: '+12145559557', ring_timeout_seconds: 20 },
  { phone_e164: '+12105558722', overflow_to_e164: '+12145559557', ring_timeout_seconds: 20 },
]);
eq('an AI line is never a target', overflowLinePatches(on, '+12145559557', [{ phone_e164: '+17265555755', label: 'AI · Riley' }], []), []);
eq('switch off: the lines it held are cleared', overflowLinePatches({ enabled: false, ring_seconds: 20 }, '+12145559557', [{ phone_e164: '+15125555917' }], ['+15125555917', '+12105558722']), [
  { phone_e164: '+15125555917', overflow_to_e164: '', ring_timeout_seconds: null },
  { phone_e164: '+12105558722', overflow_to_e164: '', ring_timeout_seconds: null },
]);
eq('a line still covered is set, one no longer covered is cleared', overflowLinePatches(on, '+12145559557', [{ phone_e164: '+15125555917' }], ['+15125555917', '+12105558722']), [
  { phone_e164: '+15125555917', overflow_to_e164: '+12145559557', ring_timeout_seconds: 20 },
  { phone_e164: '+12105558722', overflow_to_e164: '', ring_timeout_seconds: null },
]);
eq('no agent number: nothing is set', overflowLinePatches(on, null, [{ phone_e164: '+15125555917' }], []), []);

// ---- the settings field ------------------------------------------------------------
const D = defaultSettings();
eq('overflow default: off, 20 s', D.call_handling.overflow, { enabled: false, ring_seconds: 20 });
const n = normalizeSettings({ call_handling: { overflow: { enabled: true, ring_seconds: 200 } } }, D);
eq('ring window clamps to 60', n.settings.call_handling.overflow, { enabled: true, ring_seconds: 60 });
ok('DYNAMIC_VARIABLES has covering_for', (DYNAMIC_VARIABLES as readonly string[]).includes('covering_for'));

// ---- the opener ---------------------------------------------------------------------
const persona = { agentName: 'Avery', company: 'Acme Homes', repName: 'Morgan', introduceAs: 'virtual_assistant' as const };
const known = buildInitiation({ status: 'one', match: { kind: 'buyer', id: 7, name: 'Dana Buyer', tags: [] } }, { direction: 'inbound', ours: '2145559557', theirs: '5125550199' }, null, persona, { ...NO_EXTRAS, rep_phone: '+15125555917', rep_available: 'yes', covering_for: 'Morgan' });
eq('known caller, covering: the opener names the rep first', known.conversation_config_override.agent.first_message, 'Hey Dana, Morgan is on another call right now, this is Avery, a virtual assistant with Acme Homes. I can help, or take a message for Morgan.');
eq('known caller, covering: the variable is set', known.dynamic_variables.covering_for, 'Morgan');
const unknown = buildInitiation({ status: 'none' }, { direction: 'inbound', ours: '2145559557', theirs: '5125550199' }, null, persona, { ...NO_EXTRAS, covering_for: 'Morgan' });
eq('unknown caller, covering: asks who is calling', unknown.conversation_config_override.agent.first_message, 'Thanks for calling, Morgan is on another call right now, this is Avery, a virtual assistant with Acme Homes. I can help, or take a message for Morgan. Who am I speaking with?');
const blocked = buildInitiation({ status: 'blocked', matches: [] }, { direction: 'inbound', ours: '2145559557', theirs: '5125550199' }, null, persona, { ...NO_EXTRAS, covering_for: 'Morgan' });
eq('blocked caller: no covering line, no variable', [blocked.conversation_config_override.agent.first_message.includes('Morgan'), blocked.dynamic_variables.covering_for], [false, '']);
const plain = buildInitiation({ status: 'one', match: { kind: 'buyer', id: 7, name: 'Dana Buyer', tags: [] } }, { direction: 'inbound', ours: '2145559557', theirs: '5125550199' }, null, persona, NO_EXTRAS);
ok('no overflow: the opener is unchanged', plain.conversation_config_override.agent.first_message === 'Hey Dana, thanks for calling back, this is Avery, a virtual assistant with Acme Homes.');

// ---- the prompt ---------------------------------------------------------------------
const mk = (patch: Record<string, unknown>, base: AgentSettings = D) => { const r = normalizeSettings(patch, base); if (r.errors.length) throw new Error(r.errors.join('; ')); return r.settings; };
const avery = mk({ ...TEMPLATES.buyer_assistant.settings, identity: { ...TEMPLATES.buyer_assistant.settings.identity, name: 'Avery', company: 'Acme Homes' } });
const jordan = mk({ ...TEMPLATES.acquisitions.settings, identity: { ...TEMPLATES.acquisitions.settings.identity, name: 'Jordan', company: 'Acme Homes' }, tools: { ...TEMPLATES.acquisitions.settings.tools, deal_lookup: { enabled: true } } });
ok('buyer assistant template has deal_lookup on', toolOn(avery, 'deal_lookup'));
ok('an acquisitions agent never gets deal_lookup, even switched on', !toolOn(jordan, 'deal_lookup'));
const pa = assemblePrompt(mk({ call_handling: { overflow: { enabled: true } } }, avery), TEMPLATES);
const pj = assemblePrompt(jordan, TEMPLATES);
ok('the covering block rides on an agent with the switch on', pa.includes('# Picking up for a teammate'));
ok('and not on one with it off', !pj.includes('# Picking up for a teammate'));
ok('the dispo lane is on the buyer agent only', pa.includes('# Our deals for sale') && !pj.includes('# Our deals for sale'));
ok('deal_lookup is in the buyer agent tools, not the acquisitions agent', pa.includes('deal_lookup:') && !pj.includes('deal_lookup:'));
ok('the locked block is still last', pa.trimEnd().endsWith(lockedBlock(avery).trimEnd()) && pj.trimEnd().endsWith(lockedBlock(jordan).trimEnd()));
ok('the covering block is short (every covered agent carries it)', coveringBlockTokens(mk({ call_handling: { overflow: { enabled: true } } }, avery)) < 170);

// ---- deal_lookup --------------------------------------------------------------------
const deal = (over: Partial<DealRow>): DealRow => ({
  id: 1, stage: 'Ready To Market', contract_status: null, arv: 421823, offer_amount: 192245, assignment_fee: null, target_assignment: null, marketed_price: null, bin_price: null, marketing_headline: null, buyer_id: null,
  properties: { line1: '2666 Quail Run Rd', city: 'Jacksonville', state: 'FL', zip: '32218', beds: 4, baths: 2, sqft: 2114, year_built: 1942 }, ...over,
});
eq('asking price: the marketed price first', askingPrice(deal({ marketed_price: 375000, bin_price: 380000 })), 375000);
eq('asking price: contract plus the target assignment', askingPrice(deal({ target_assignment: 35000 })), 227245);
eq('asking price: contract plus the assignment fee', askingPrice(deal({ assignment_fee: 20000 })), 212245);
eq('asking price: none when nothing says what we ask', askingPrice(deal({})), null);
eq('status: ready to market is available', dealStatus(deal({})), 'available');
eq('status: a buyer on it means backups', dealStatus(deal({ stage: 'Buyer Under Contract' })), 'under contract with a buyer, taking backup offers');
const rows = [deal({ marketed_price: 215000 }), deal({ id: 2, properties: { line1: '5323 Sage Hill Road', city: 'Columbia', state: 'SC', zip: null, beds: 3, baths: 2, sqft: 1872, year_built: 1961 }, marketed_price: 375000 }), deal({ id: 3, properties: null })];
eq('the list: address, ask, ARV, beds, baths; no address is left out', dealsForBuyer(rows).map((d) => [d.deal_id, d.address, d.asking_price, d.arv, d.beds, d.baths, d.status]), [
  [1, '2666 Quail Run Rd, Jacksonville, FL, 32218', '$215,000', '$421,823', '4', '2', 'available'],
  [2, '5323 Sage Hill Road, Columbia, SC', '$375,000', '$421,823', '3', '2', 'available'],
]);
eq('query narrows by street', dealsForBuyer(rows, 'quail run').map((d) => d.deal_id), [1]);
eq('query narrows by city', dealsForBuyer(rows, 'Columbia').map((d) => d.deal_id), [2]);
eq('no ask yet reads empty, never a guess', dealsForBuyer([deal({})])[0].asking_price, '');

if (failed) { console.log(`\n${failed} failed`); Deno.exit(1); } else console.log('\nall passed');
