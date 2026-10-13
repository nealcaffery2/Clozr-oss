// The 10DLC filing rules.  Run:  deno run supabase/functions/_shared/tendlc.test.ts
//
// These are the checks that run before a cent is spent: TCR charges for every
// submission and will not let a rejected campaign be edited, so anything we can
// catch here is a fee and a week we do not lose.
import {
  type CampaignFacts,
  attachPlan,
  type EntityFacts,
  brandOk,
  brandPayload,
  campaignOk,
  campaignPayload,
  explainReasons,
  fundsMessage,
  needsFunds,
  keywords,
  normalizeEin,
  qualifies,
  normalizePhone,
  terminal,
  validateCampaign,
  validateEntity,
} from './tendlc.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}
/** The field names a validator complained about, sorted, for stable compares. */
const fields = (problems: { field: string }[]) => [...new Set(problems.map((p) => p.field))].sort();

// ---- EIN ----
eq('EIN accepts nine bare digits', normalizeEin('123456789'), '12-3456789');
eq('EIN accepts the dashed form', normalizeEin('12-3456789'), '12-3456789');
eq('EIN strips whatever punctuation was pasted in', normalizeEin(' 12 345 6789 '), '12-3456789');
eq('eight digits is not an EIN', normalizeEin('12345678'), null);
eq('ten digits is not an EIN', normalizeEin('1234567890'), null);
eq('an empty EIN is not an EIN', normalizeEin(''), null);

// ---- phone ----
eq('a ten-digit US number gets +1', normalizePhone('2105550161'), '+12105550161');
eq('a leading 1 is kept once', normalizePhone('12105550161'), '+12105550161');
eq('a formatted number is read', normalizePhone('(210) 555-0161'), '+12105550161');
eq('E.164 passes through', normalizePhone('+442079460123'), '+442079460123');
eq('a short number is refused', normalizePhone('5551234'), null);

// ---- the brand ----
const entity: EntityFacts = {
  legal_name: 'Acme Holdings LLC',
  display_name: 'Acme Homes',
  ein: '12-3456789',
  entity_type: 'PRIVATE_PROFIT',
  vertical: 'REAL_ESTATE',
  street: '1 Example Plaza',
  city: 'San Antonio',
  state: 'TX',
  postal_code: '78205',
  country: 'US',
  email: 'support@yourcompany.com',
  phone: '+12105550161',
  website: 'https://yourcompany.com',
};

eq('a complete entity has nothing to fix', validateEntity(entity), []);
eq('an empty entity names every required field',
  fields(validateEntity({})),
  ['city', 'ein', 'email', 'entity_type', 'legal_name', 'phone', 'postal_code', 'state', 'street', 'vertical', 'website']);
eq('a bad EIN is caught', fields(validateEntity({ ...entity, ein: '1234' })), ['ein']);
eq('a three-letter state is caught', fields(validateEntity({ ...entity, state: 'TEX' })), ['state']);
eq('a UK-style postcode is caught', fields(validateEntity({ ...entity, postal_code: 'SW1A 1AA' })), ['postal_code']);
// The reviewer opens the website looking for a privacy policy; http:// and bare
// hostnames are the two ways that goes wrong.
eq('http is refused — the reviewer opens this URL', fields(validateEntity({ ...entity, website: 'http://yourcompany.com' })), ['website']);
eq('a bare hostname is refused', fields(validateEntity({ ...entity, website: 'yourcompany.com' })), ['website']);
eq('an entity type TCR does not know is caught', fields(validateEntity({ ...entity, entity_type: 'LLC' })), ['entity_type']);

eq('the brand payload is what Telnyx asks for', brandPayload(entity), {
  entityType: 'PRIVATE_PROFIT',
  companyName: 'Acme Holdings LLC',
  displayName: 'Acme Homes',
  ein: '123456789',
  einIssuingCountry: 'US',
  phone: '+12105550161',
  street: '1 Example Plaza',
  city: 'San Antonio',
  state: 'TX',
  postalCode: '78205',
  country: 'US',
  email: 'support@yourcompany.com',
  website: 'https://yourcompany.com',
  vertical: 'REAL_ESTATE',
});
// The DBA is what people see, but TCR matches companyName against the IRS, so
// a missing display name must fall back to the legal name and never the other
// way round.
eq('no DBA falls back to the legal name',
  brandPayload({ ...entity, display_name: null }).displayName, 'Acme Holdings LLC');
eq('a webhook URL is included when we have one',
  brandPayload(entity, 'https://x.example/hook').webhookURL, 'https://x.example/hook');

// ---- the campaign ----
const campaign: CampaignFacts = {
  usecase: 'LOW_VOLUME',
  description: 'Acme Homes is a real estate investment company in San Antonio, TX. We text cash investors on our buyers list about off-market properties, and property owners who contacted us about selling.',
  message_flow: 'Investors tick an unchecked box on our property pages at https://yourcompany.com reading "Text me matching deals. Msg & data rates may apply. Reply STOP to opt out." Consent and timestamp are stored in our CRM.',
  samples: [
    "Hi Mark, it's Morgan with Acme Homes. We picked up a 3/2 off-market in Converse, near the Lakeshore place you bought. Want the numbers? Reply STOP to opt out.",
    'Hi Dana, Jamie at Acme Homes. Following up on the Schertz duplex I sent Tuesday, still available if you want details.',
  ],
  help_message: 'Acme Homes (Acme Holdings LLC). Help: (210) 555-0161. Msg & data rates may apply. Reply STOP to unsubscribe.',
  sub_usecases: ['CUSTOMER_CARE', 'MARKETING'],
  privacy_policy_url: 'https://yourcompany.com/privacy',
  optin_message: 'Acme Homes: you are subscribed to deal alerts. Msg & data rates may apply. Reply HELP for help, STOP to opt out.',
};

eq('a complete campaign has nothing to fix', validateCampaign(campaign, 'Acme Homes'), []);
eq('an empty campaign names the required fields',
  fields(validateCampaign({})),
  ['description', 'help_message', 'message_flow', 'optin_message', 'privacy_policy_url', 'samples', 'usecase']);
eq('LOW_VOLUME without sub use cases is caught',
  fields(validateCampaign({ ...campaign, sub_usecases: [] }, 'Acme Homes')), ['sub_usecases']);
eq('a sub use case TCR does not know is caught',
  fields(validateCampaign({ ...campaign, sub_usecases: ['CUSTOMER_CARE', 'COLD_CALLING'] }, 'Acme Homes')), ['sub_usecases']);
eq('a single-purpose use case needs no sub use cases',
  fields(validateCampaign({ ...campaign, usecase: 'CUSTOMER_CARE', sub_usecases: [] }, 'Acme Homes')), []);
eq('an http privacy policy is refused',
  fields(validateCampaign({ ...campaign, privacy_policy_url: 'http://yourcompany.com/privacy' }, 'Acme Homes')), ['privacy_policy_url']);
eq('links in texts need a sample link',
  fields(validateCampaign({ ...campaign, embedded_link: true }, 'Acme Homes')), ['embedded_link_sample']);
eq('an opt-in confirmation that never says STOP is caught',
  fields(validateCampaign({ ...campaign, optin_message: 'Acme Homes: you are subscribed.' }, 'Acme Homes')), ['optin_message']);
eq('the use case qualifies when the count fits', qualifies({ minSubUsecases: 2, maxSubUsecases: 5 }, 2), null);
eq('too few sub use cases for the brand is named', qualifies({ minSubUsecases: 2, maxSubUsecases: 5 }, 1), 'This use case needs at least 2 sub use cases for your brand.');
eq('a one-line description is refused',
  fields(validateCampaign({ ...campaign, description: 'We text people.' }, 'Acme Homes')), ['description']);
eq('a vague opt-in story is refused',
  fields(validateCampaign({ ...campaign, message_flow: 'They opted in.' }, 'Acme Homes')), ['message_flow']);
eq('one sample is not enough',
  fields(validateCampaign({ ...campaign, samples: [campaign.samples[0]] }, 'Acme Homes')), ['samples']);
// The whole point of the sender change that ships with this: what goes out has
// to match what was filed.
eq('the first sample must carry the opt-out line',
  fields(validateCampaign({ ...campaign, samples: ['Hi Mark, it is Morgan with Acme Homes, we have an off-market deal in Converse.', campaign.samples[1]] }, 'Acme Homes')),
  ['samples.0']);
eq('a link shortener in a sample is caught',
  fields(validateCampaign({ ...campaign, samples: ['Hi Mark, deal in Converse: https://bit.ly/abc Reply STOP to opt out.', campaign.samples[1]] }, 'Acme Homes')),
  ['samples.0']);
eq('a HELP reply that does not name the business is caught',
  fields(validateCampaign({ ...campaign, help_message: 'Call 210-555-0161 for help. Reply STOP to unsubscribe.' }, 'Acme Homes')),
  ['help_message']);
eq('a HELP reply that never says STOP is caught',
  fields(validateCampaign({ ...campaign, help_message: 'Acme Homes. Call (210) 555-0161 for help.' }, 'Acme Homes')),
  ['help_message']);
eq('opt-out keywords without STOP are caught',
  fields(validateCampaign({ ...campaign, optout_keywords: 'CANCEL, END' }, 'Acme Homes')), ['optout_keywords']);
eq('six samples is too many',
  fields(validateCampaign({ ...campaign, samples: [...campaign.samples, ...campaign.samples, ...campaign.samples] }, 'Acme Homes')),
  ['samples']);

const built = campaignPayload('BRAND1', campaign) as Record<string, unknown>;
eq('samples are numbered from one', [built.sample1, built.sample2], campaign.samples);
eq('no sample3 when only two were given', 'sample3' in built, false);
eq('the keyword defaults are filled in',
  [built.optinKeywords, built.optoutKeywords, built.helpKeywords],
  ['START,UNSTOP', 'STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT', 'HELP,INFO']);
eq('typed keywords are sent the way Telnyx wants them', keywords('stop, end  quit'), 'STOP,END,QUIT');
eq('sub use cases, links and the opt-in message are filed',
  [built.subUsecases, built.privacyPolicyLink, built.optinMessage, built.termsAndConditions],
  [campaign.sub_usecases, campaign.privacy_policy_url, campaign.optin_message, true]);
eq('the subscriber flags are all on', [built.subscriberOptin, built.subscriberOptout, built.subscriberHelp], [true, true, true]);
eq('flags we did not set come out false, never undefined',
  [built.embeddedLink, built.embeddedPhone, built.ageGated, built.directLending, built.numberPool],
  [false, false, false, false, false]);
eq('blank samples are dropped rather than sent as empty strings',
  'sample2' in (campaignPayload('B', { ...campaign, samples: [campaign.samples[0], '  '] }) as Record<string, unknown>), false);

// ---- statuses ----
eq('VERIFIED is a good brand', brandOk('VERIFIED'), true);
eq('brand status is read case-insensitively', brandOk('verified'), true);
eq('PENDING is not a good brand', brandOk('PENDING'), false);
eq('a missing brand status is not good', brandOk(null), false);
eq('ACTIVE is a live campaign', campaignOk('ACTIVE'), true);
eq('PENDING is not a live campaign', campaignOk('PENDING'), false);
eq('MNO_PROVISIONED is a live campaign', campaignOk('MNO_PROVISIONED'), true);
eq('an MNO rejection is terminal', terminal('MNO_REJECTED'), true);
eq('a failed brand registration is terminal', terminal('REGISTRATION_FAILED'), true);
eq('REJECTED is terminal', terminal('REJECTED'), true);
eq('UNVERIFIED is terminal — waiting will not fix it', terminal('UNVERIFIED'), true);
eq('PENDING is not terminal', terminal('PENDING'), false);

// ---- rejection reasons ----
// This is the difference between "your brand failed" and something an admin can act on.
eq('a reason names its field',
  explainReasons([{ fields: ['ein'], description: 'Invalid EIN - EIN is a nine-digit number.' }]),
  'ein: Invalid EIN - EIN is a nine-digit number.');
eq('several reasons are joined', explainReasons([
  { fields: ['ein'], description: 'Invalid EIN.' },
  { fields: ['companyName'], description: 'Name does not match IRS records.' },
]), 'ein: Invalid EIN. · companyName: Name does not match IRS records.');
eq('a reason with no field still reads', explainReasons([{ description: 'Brand not found.' }]), 'Brand not found.');
eq('no reasons is an empty string, not "undefined"', explainReasons(undefined), '');
eq('a non-array is an empty string', explainReasons('nope'), '');

// A refusal for want of funds is not a rejection: it retries, and says so.
eq('Telnyx balance refusal needs funds', needsFunds('Your account must have at least $6.00 to perform this operation'), true);
eq('a carrier rejection does not', needsFunds('Invalid EIN — does not match IRS records'), false);
eq('no error does not', needsFunds(null), false);
eq('the funds message names the fee', fundsMessage('Your account must have at least $6.00 to perform this operation').includes('$6.00'), true);
eq('the funds message is saved with its prefix', fundsMessage('x').startsWith('funds:'), true);

// A line bought or reassigned later is attached on its own, exactly once.
eq('a number on no campaign is added', attachPlan(null, 'c1'), 'create');
eq('a number with an empty record is added', attachPlan({}, 'c1'), 'create');
eq('a number already on this campaign is left alone', attachPlan({ campaignId: 'c1', assignmentStatus: 'ASSIGNED' }, 'c1'), 'skip');
eq('a pending assignment is left alone', attachPlan({ telnyxCampaignId: 'c1', assignmentStatus: 'PENDING_ASSIGNMENT' }, 'c1'), 'skip');
eq('a failed assignment is tried again', attachPlan({ campaignId: 'c1', assignmentStatus: 'FAILED_ASSIGNMENT' }, 'c1'), 'replace');
eq('a number on the old rejected campaign is moved', attachPlan({ telnyxCampaignId: 'old', campaignId: 'old' }, 'c1'), 'replace');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
