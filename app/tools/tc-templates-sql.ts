// Writes migration 401 from lib/tc-templates.ts, so the SQL never drifts from
// the copy tools/tc-templates.test.ts checks.
// Run: npx tsx tools/tc-templates-sql.ts > supabase/migrations/401_tc_templates.sql

import { pathToFileURL } from 'node:url';
import { tcTemplateRows } from '../lib/tc-templates';

const q = (s: string | null | undefined) => {
  if (s == null) return 'null';
  if (s.includes('$t$')) throw new Error('template text holds the $t$ quote');
  return `$t$${s}$t$`;
};
const arr = (xs: string[]) => `array[${xs.map((f) => `'${f}'`).join(', ')}]::text[]`;

const rows = () => tcTemplateRows().map((t) => `  (${q(t.name)}, '${t.channel}', '${t.audience}', ${q(t.category)}, ${q(t.subject)}, ${q(t.body_text)}, ${q(t.body_html)}, ${t.blocks ? `${q(JSON.stringify(t.blocks))}::jsonb` : 'null::jsonb'}, ${arr(t.merge_fields)})`);

export const tcTemplatesSql = () => `-- 401 · The transaction coordinator's texts and emails as shared templates.
--
-- Casey's (TC) SMS and email templates, approved by the owner on
-- 2026-10-21. Generated from lib/tc-templates.ts by tools/tc-templates-sql.ts;
-- edit the copy there and regenerate. Category 'TC'; seller texts are
-- audience seller, the buyer thank-you buyer, and the title-company emails
-- general (named "(title company)") so they show in a seller record's email
-- composer. Loaded into the workspace sam@yourcompany.com owns (not the
-- Compr workspace), owned by him and shared. No such workspace: nothing
-- happens. A name already in the workspace is left alone, so a re-run or an
-- edited template is never overwritten. Safe to re-run.

insert into public.message_templates
  (workspace_id, owner_id, shared, name, channel, audience, category, subject, body_text, body_html, blocks, merge_fields)
select w.id, w.owner_id, true, v.name, v.channel, v.audience, v.category, v.subject, v.body_text, v.body_html, v.blocks, v.merge_fields
  from public.workspaces w
  join auth.users u on u.id = w.owner_id
 cross join (values
${rows().join(',\n')}
 ) as v(name, channel, audience, category, subject, body_text, body_html, blocks, merge_fields)
 where lower(u.email) = 'sam@yourcompany.com'
   and coalesce(w.settings->>'buyer_profile', '') <> 'compr'
   and not exists (select 1 from public.message_templates m where m.workspace_id = w.id and m.name = v.name);`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(tcTemplatesSql());
