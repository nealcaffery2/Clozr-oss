// Jev lead-triage contract. Run: npx tsx tools/jev-triage.test.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyOverride,
  buildLeadTriageState,
  interpretTriage,
  jevRequestBody,
  playgroundFixtures,
  stubEvaluate,
  suggestedStageFor,
} from '../lib/jev-triage';

let failed = 0;
const check = (name: string, pass: boolean, extra: unknown = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!pass) failed++;
};

const fixtures = playgroundFixtures();
const byId = (id: string) => fixtures.find((f) => f.id === id)!;

const john = buildLeadTriageState(byId('p3').input);
check('john: never contacted + phone', john.contact.never_contacted && john.contact.has_phone);
check('john: no street/name/phone in state', !('name' in john.lead) && !('addr' in john.property) && !('phone' in john.contact));
check('john: city/state kept', john.property.city === 'Fort Worth' && john.property.state === 'TX');
check('john: motivation kept', john.lead.motivation === 'Behind on payments');

const johnRes = stubEvaluate(john);
const johnSug = interpretTriage(john, johnRes);
check('john stub → pursue', johnSug.disposition === 'pursue', johnSug.disposition);
check('john stub → call_now', johnSug.nextAction === 'call_now', johnSug.nextAction);
check('john stub urgent ≥ 0.7', johnSug.urgent >= 0.7, johnSug.urgent);
check('john suggested stage is a no-contact lead', johnSug.suggestedStage === 'Lead - No Contact');
check('john queue tag Hot', johnSug.queueTag === 'Hot');

const denise = buildLeadTriageState(byId('p13').input);
const deniseSug = interpretTriage(denise, stubEvaluate(denise));
check('denise stub → nurture', deniseSug.disposition === 'nurture', deniseSug.disposition);
check('denise stub → nurture_sequence', deniseSug.nextAction === 'nurture_sequence');
check('denise suggested long-term nurture', deniseSug.suggestedStage === 'Nurture - Long Term (3+ Months)');

const bruce = buildLeadTriageState(byId('p14').input);
const bruceSug = interpretTriage(bruce, stubEvaluate(bruce));
check('bruce stub → skip', bruceSug.disposition === 'skip', bruceSug.disposition);
check('bruce stub → close_out', bruceSug.nextAction === 'close_out');
check('bruce suggested Dead (AM picks the real dead stage)', bruceSug.suggestedStage === 'Dead');

const thin = buildLeadTriageState(byId('thin').input);
check('thin: no phone, no motivation', !thin.contact.has_phone && thin.lead.motivation === null);
check('thin: still has market/city', thin.property.city === 'San Antonio' && thin.lead.source === 'deal_machine');
const thinSug = interpretTriage(thin, stubEvaluate(thin));
check('thin stub → nurture (not skip — missing facts are not dead)', thinSug.disposition === 'nurture', thinSug.disposition);

const overridden = applyOverride(john, johnSug, { disposition: 'skip', nextAction: 'close_out' });
check('AM override skip does not keep Hot tag', overridden.queueTag === 'Skip');
check('AM override skip suggests Dead', overridden.suggestedStage === 'Dead');
check('model confidence is unchanged by override', overridden.dispositionConfidence === johnSug.dispositionConfidence);

const req = jevRequestBody(john);
check('request model is jev-latest', req.model === 'jev-latest');
check('request asks three questions', Object.keys(req.questions).sort().join() === 'disposition,next_action,urgent');
check('disposition is a choice of pursue/nurture/skip',
  req.questions.disposition.type === 'choice'
  && Object.keys(req.questions.disposition.criteria).sort().join() === 'nurture,pursue,skip');
check('urgent is a noul', req.questions.urgent.type === 'noul');
check('next_action includes call_now and close_out',
  'call_now' in req.questions.next_action.criteria && 'close_out' in req.questions.next_action.criteria);

check('stub answers match question ids',
  Object.keys(johnRes.answers).sort().join() === 'disposition,next_action,urgent');
check('noul has no confidence field', !('confidence' in johnRes.answers.urgent));
check('choice answers carry confidence', johnRes.answers.disposition.confidence > 0);

const sharedPath = join(dirname(fileURLToPath(import.meta.url)), '../supabase/functions/_shared/jev-triage.ts');
const sharedSrc = readFileSync(sharedPath, 'utf8');
for (const key of ['pursue', 'nurture', 'skip', 'call_now', 'close_out'] as const) {
  check(`shared edge questions still name ${key}`, sharedSrc.includes(key));
}
check('shared edge questions match lib instructions (disposition)',
  sharedSrc.includes('Judge from stage, motivation, contactability, timeline and numbers'));

check('suggestedStageFor skip is never a live working stage',
  suggestedStageFor(john, 'skip') === 'Dead');

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
