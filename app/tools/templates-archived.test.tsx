// The Templates manager keeps deleted templates behind Show archived, each
// with Restore, and never lists them among the live ones.
// Run: npx tsx tools/templates-archived.test.tsx
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplatesManager } from '../app/components/templates/TemplatesManager';
import type { MessageTemplate } from '../lib/message-templates';

const row = (id: number, name: string, archived_at: string | null): MessageTemplate => ({
  id, workspace_id: 1, owner_id: 'u1', shared: true, channel: 'sms', audience: 'seller', category: 'follow-up', name,
  subject: null, body_text: 'Hi {{first_name}}', body_html: null, blocks: null, merge_fields: [], archived_at,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});
const live = row(1, 'Day-2 follow-up', null);
const gone = row(2, 'Old voicemail follow-up', '2026-10-20T15:00:00Z');

const html = renderToStaticMarkup(
  <TemplatesManager embedded data={{ templates: [live], archived: [gone], team: [], loading: false, error: null, reload: () => {} }}
    userId="u1" isAdmin talkrAuthed={false} ctx={{ workspaceId: 1, toast: () => {}, testTo: null, rep: {} }} onClose={() => {}} />,
);

assert.ok(html.includes('Show archived'), 'the rail offers Show archived');
assert.ok(/Show archived<\/span><span[^>]*>1<\/span>/.test(html), 'the toggle counts the archived templates');
assert.ok(html.includes('Day-2 follow-up'), 'the live template is listed');
assert.ok(!html.includes('Old voicemail follow-up'), 'the archived template is not among the live ones');
assert.ok(!html.includes('>Restore<'), 'Restore only shows under Show archived');
console.log('templates-archived: 5 passed');
