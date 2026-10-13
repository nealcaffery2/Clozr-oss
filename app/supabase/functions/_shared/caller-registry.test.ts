// Free Caller Registry mail + what a new line is allowed to do.
// Run:  npx tsx supabase/functions/_shared/caller-registry.test.ts
import {
  authorizerName,
  cnamFrom,
  cnamTargets,
  dirGaps,
  displayName,
  enterpriseGaps,
  enterprisePayload,
  extractFcrMail,
  fcrAgentPrompt,
  isFcrSender,
  fcrFiled,
  normalizeIndustry,
  planLine,
  registryLines,
  reputationRows,
} from './caller-registry.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

eq('Hiya is a registry sender', isFcrSender('Free Caller Registry <freecallerregistry@hiya.com>'), true);
eq('a random vendor is not', isFcrSender('deals@example.com'), false);

eq('pulls the code next to the label', extractFcrMail({
  from: 'noreply@freecallerregistry.com',
  subject: 'Verify your email',
  text: 'Your verification code is 482193. It expires in 10 minutes.',
}), { code: '482193', url: null });

eq('keeps a confirm link on a registry host only', extractFcrMail({
  from: 'FCRsupport@firstorion.com',
  subject: 'Confirm',
  text: 'Open https://freecallerregistry.com/verify?token=abc and ignore https://evil.example/verify',
})?.url, 'https://freecallerregistry.com/verify?token=abc');

eq('ignores mail that is not from the registry', extractFcrMail({
  from: 'boss@example.com', subject: 'code 123456', text: 'verification code 999999',
}), null);

eq('display name is capped at 35', displayName('Acme Homes of San Antonio and the Hill Country LLC'), 'Acme Homes of San Antonio and the H');

const legal = {
  legal_name: 'Acme Holdings LLC', ein: '12-3456789', website: 'https://yourcompany.com',
  street: '1 Main', city: 'San Antonio', state: 'TX', postal_code: '78205', email: 'ops@yourcompany.com', phone: '+12105550161',
};
eq('enterprise is complete when the contact names are present', enterpriseGaps(legal, { contact_first: 'Sam', contact_last: 'Owner' }), []);
eq('enterprise names the missing contact', enterpriseGaps(legal, {}).map((p) => p.field), ['contact_first', 'contact_last']);

eq('DIR wants an authorizer and a call reason', dirGaps({}, legal).map((p) => p.field), ['authorizer_name', 'call_reasons']);
eq('authorizer falls back to the enterprise contact', authorizerName({ contact_first: 'Sam', contact_last: 'Owner' }), 'Sam Owner');
eq('authorizer prefers the explicit name', authorizerName({ authorizer_name: 'Pat Boss', contact_first: 'Sam', contact_last: 'Owner' }), 'Pat Boss');

eq('Telnyx industry uses a space, not an underscore', normalizeIndustry('real_estate'), 'real estate');
eq('TCR REAL_ESTATE maps to Telnyx real estate', normalizeIndustry(null, 'REAL_ESTATE'), 'real estate');
eq('blank industry defaults to real estate', normalizeIndustry(null, null), 'real estate');
eq('an already-valid value is kept', normalizeIndustry('property'), 'property');
eq('enterprise payload industry is Telnyx-shaped', enterprisePayload(legal, { contact_first: 'Sam', contact_last: 'Owner', industry: 'real_estate' }).industry, 'real estate');
eq('enterprise payload takes the 10DLC vertical when industry is blank', enterprisePayload(legal, { contact_first: 'Sam', contact_last: 'Owner' }, 'PRIVATE_PROFIT', 'REAL_ESTATE').industry, 'real estate');
{
  const ent = enterprisePayload(legal, { contact_first: 'Sam', contact_last: 'Owner', contact_title: 'Broker' }) as Record<string, Record<string, unknown>>;
  eq('the organization contact carries a job title', ent.organization_contact.job_title, 'Broker');
  eq('the billing contact has no job title (Telnyx refuses it there)', 'job_title' in ent.billing_contact, false);
}
eq('DIR is complete when the contact doubles as authorizer', dirGaps({ contact_first: 'Sam', contact_last: 'Owner', call_reasons: ['Follow-Up Calls'] }, legal), []);

const gates = { reputation_approved: true, dir_verified: true, loa_document_id: 'doc', messaging_profile_id: 'mp', campaign_approved: true };
eq('a new flagged line is enrolled and queued, and remediation waits until it is enrolled', planLine(
  { phone_e164: '+12105550100', spam_risk: 'high', ten_dlc_assigned: false },
  null,
  gates,
), {
  phone_e164: '+12105550100',
  enroll_reputation: true,
  attach_branded: true,
  remediate: false,
  assign_messaging_profile: true,
  queue_fcr: true,
});
eq('remediation waits until the number is enrolled', planLine(
  { phone_e164: '+12105550100', spam_risk: 'high', ten_dlc_assigned: true },
  { phone_e164: '+12105550100', reputation_enrolled: true, branded_attached: true, fcr_status: 'registered', remediation_open: false },
  gates,
).remediate, true);
eq('an open remediation is not filed twice', planLine(
  { phone_e164: '+12105550100', spam_risk: 'high', ten_dlc_assigned: true },
  { phone_e164: '+12105550100', reputation_enrolled: true, branded_attached: true, fcr_status: 'registered', remediation_open: true },
  gates,
).remediate, false);
eq('nothing carrier-side runs before the gates open', planLine(
  { phone_e164: '+12105550100', spam_risk: 'low', ten_dlc_assigned: false },
  null,
  { reputation_approved: false, dir_verified: false, loa_document_id: null, messaging_profile_id: null, campaign_approved: false },
), {
  phone_e164: '+12105550100',
  enroll_reputation: false,
  attach_branded: false,
  remediate: false,
  assign_messaging_profile: false,
  queue_fcr: true,
});

const prompt = fcrAgentPrompt({ business: 'Acme Homes', email: 'ops@yourcompany.com', phones: ['+12105550100'], code: null });
eq('the prompt refuses to invent a code', prompt.includes('NEEDS_CODE'), true);
eq('the prompt names the number', prompt.includes('+12105550100'), true);

// ---- RVM pool parity (migration 195)
{
  const plan = registryLines(
    [{ id: 't1', phone_e164: '+12105550100', spam: { spam_risk: 'low' }, ten_dlc: { assigned: true } }],
    ['+18035550111'],
    [
      { phone_e164: '+12105550100', pool: 'dialer' },
      { phone_e164: '+18035550111' },
      { phone_e164: '+18035550122', pool: 'rvm', spam_risk: 'medium' },
      { phone_e164: '+18035550133', pool: 'rvm', retired_at: '2026-10-01T00:00:00Z' },
      { phone_e164: '+442079460123', pool: 'rvm' },
    ],
    { '+18035550122': { ten_dlc_assigned: false } },
  );
  eq('Talkr lines, hinted lines and live RVM pool lines are all planned', plan.map((l) => l.phone_e164), ['+12105550100', '+18035550111', '+18035550122']);
  eq('a pool line Talkr does not list carries its own spam risk and 10DLC flag', plan[2], { phone_e164: '+18035550122', spam_risk: 'medium', ten_dlc_assigned: false, pool: 'rvm' });
  eq('a Talkr line keeps its pool', plan[0].pool, 'dialer');
}
eq('a finished job files the lines it was handed', fcrFiled([
  { phone_e164: '+1a', fcr_status: 'submitting' }, { phone_e164: '+1b', fcr_status: 'queued' }, { phone_e164: '+1c', fcr_status: 'code_ready' },
]), ['+1a']);
eq('reputation rows: verdicts lower-cased, unchecked numbers left out', reputationRows({ data: [
  { phone_number: '+18035550122', reputation_data: { spam_risk: 'HIGH', spam_category: 'Telemarketing', last_refreshed_at: '2026-10-08T00:00:00Z' } },
  { phone_number: '+18035550133', reputation_data: null },
  { phone_number: 'nope', reputation_data: { spam_risk: 'low' } },
] }), [{ phone_e164: '+18035550122', spam_risk: 'high', spam_category: 'Telemarketing', checked_at: '2026-10-08T00:00:00Z' }]);
eq('CNAM goes on live pool lines Talkr does not hold and that have none', cnamTargets([
  { phone_e164: '+18035550122', pool: 'rvm' },
  { phone_e164: '+18035550133', pool: 'rvm', talkr_number_id: 't' },
  { phone_e164: '+18035550144', pool: 'rvm', cnam_listed: true },
  { phone_e164: '+18035550155', pool: 'rvm', retired_at: 'x' },
  { phone_e164: '+18035550166', pool: null },
]), ['+18035550122']);
eq('CNAM name is 15 characters, cut at a word', cnamFrom('Acme Homes Of Springfield, LLC'), 'Acme Homes Of');
eq('a short name is kept', cnamFrom('Acme Homes'), 'Acme Homes');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
