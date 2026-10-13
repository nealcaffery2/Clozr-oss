// Resend connect must render a domain's name, status and region, never the
// domain object. React error #31 is that object used as a child.
// Run: npx tsx tools/resend-domain.test.tsx
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResendCard } from '../app/components/deliverability/ResendCard';
import { ChecklistCard } from '../app/components/deliverability/Signals';
import { Domains } from '../app/components/deliverability/Domains';
import type { DomainRow, Overview, ResendStatus } from '../lib/deliverability';
import { resendConnectPayload, textValue } from '../supabase/functions/_shared/resend-rules';

const domainObject = {
  object: 'domain',
  id: '44444444-4444-4444-8444-444444444444',
  name: 'deals.example.com',
  created_at: '2023-04-26T20:21:26.347412+00:00',
  status: 'not_started',
  capabilities: { sending: 'enabled', receiving: 'disabled' },
  records: [
    { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  ],
  region: 'eu-west-1',
};

const shown = textValue(domainObject);
assert.equal(typeof shown, 'string');
assert.equal(Array.isArray(shown), false);
assert.equal(shown, 'deals.example.com · not_started · eu-west-1');
assert.equal(shown.includes('capabilities'), false);
assert.equal(shown.includes(domainObject.id), false);

const listed = textValue([domainObject, ['send'], { capabilities: { sending: 'enabled' } }]);
assert.equal(typeof listed, 'string');
assert.equal(Array.isArray(listed), false);
assert.equal(listed, 'deals.example.com · not_started · eu-west-1, send');

const payload = resendConnectPayload(domainObject, 'fallback.example');
assert.equal(payload.domain, 'deals.example.com');
assert.equal(payload.status, 'not_started');
assert.equal(payload.region, 'eu-west-1');
assert.equal(payload.records.length, 1);
assert.equal(payload.records[0].type, 'MX');
assert.equal(payload.records[0].name, 'send');
assert.equal(payload.records[0].value, 'feedback-smtp.us-east-1.amazonses.com');

const resend = {
  configured: false,
  from: null,
  email: null,
  domain: domainObject,
  own_key: false, own_from: null, key_source: 'project', webhook_url: 'https://example.test/resend',
  webhook_secret_set: false,
  sender: null,
  records: [
    { type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.com' },
    { type: { unexpected: true }, name: ['send', 'extra'], value: domainObject },
  ],
} as unknown as ResendStatus;

const overview: Overview = {
  domains: [],
  mailboxes: [],
  suppressions: [],
  warmup: { instantly: false, instantly_own: false, inboxkit: false, inboxkit_own: false },
  me: { user_id: 'u', admin: true },
  resend,
};

const html = renderToStaticMarkup(
  <ResendCard workspaceId={1} admin overview={overview} onChange={() => {}} />,
);
assert.match(html, /deals\.example\.com/);
assert.match(html, /not_started/);
assert.match(html, /eu-west-1/);
assert.match(html, /feedback-smtp\.us-east-1\.amazonses\.com/);
assert.equal(html.includes(domainObject.id), false);
assert.equal(html.includes('capabilities'), false);
assert.equal(html.includes('[object Object]'), false);
assert.equal(html.includes('created_at'), false);

const checklist = renderToStaticMarkup(
  <ChecklistCard overview={{ ...overview, resend: { ...resend, configured: true } }} postmaster={null} accountId={null} setAccountId={() => {}} />,
);
assert.match(checklist, /deals\.example\.com/);
assert.match(checklist, /not_started/);
assert.equal(checklist.includes(domainObject.id), false);
assert.equal(checklist.includes('[object Object]'), false);

const domainRow = {
  id: 1,
  domain: domainObject,
  source: 'manual',
  dkim_selectors: [],
  tracking_domain: null,
  uses_resend: true,
  score: null,
  blocking: [],
  report: {
    checks: [{
      key: 'spf',
      label: 'SPF',
      status: domainObject,
      detail: domainObject,
      blocking: true,
      points: 0,
      fix: { type: 'TXT', host: '@', value: domainObject, note: domainObject },
    }],
    provider: 'resend',
  },
  checked_at: '2026-10-10T00:00:00.000Z',
} as unknown as DomainRow;

const domains = renderToStaticMarkup(
  <Domains workspaceId={1} domains={[domainRow]} admin={false} onChange={() => {}} />,
);
assert.match(domains, /deals\.example\.com/);
assert.match(domains, /not_started/);
assert.match(domains, /eu-west-1/);
assert.equal(domains.includes(domainObject.id), false);
assert.equal(domains.includes('[object Object]'), false);

console.log('resend domain render: all assertions passed');
