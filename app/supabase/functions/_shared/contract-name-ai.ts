// Renames a signed amendment from what it changed. The filled fields (closing
// date, price, option, waiver, repairs, financing) are read by rule in
// lib/contract-name.ts; Haiku reads only the free-text "Other modifications"
// box and turns it into a few words ("lender credit $750"). A name a person
// typed (name_auto false) is never touched.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import {
  amendmentChanges, amendmentName, cleanPhrase, otherModifications, streetOf, tokenFields, uniqueName, type NameField,
} from '../../../lib/contract-name.ts';
import { CLAUDE_HAIKU_MODEL, cachedSystem } from './models.ts';
import { recordUsage } from './ai-usage.ts';
import { UNTRUSTED_RULE, fence } from './security.ts';
import { WRITING_RULE } from './no-ai-slop.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

const RENAMED_KINDS = new Set(['amendment', 'addendum']);

const SYSTEM = `You name real estate contract amendments for a transaction coordinator's file list. You get the free-text "Other modifications" a party wrote on an amendment. Reply with what it changes in 2 to 6 words, lowercase except names and acronyms, with the key number or date when there is one. Examples: "option extension to 10/27", "lender credit $750", "buyer name change", "seller leaseback 30 days", "HOA fee split". Use only what the text says. If it says nothing that changes the deal, reply with an empty phrase.${UNTRUSTED_RULE}${WRITING_RULE}`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['phrase'],
  properties: { phrase: { type: 'string', description: '2 to 6 words, or empty' } },
};

/** "Lender is to pay Acme holdings $750..." → "lender credit $750". Null without a key, on a failure or an unusable reply. */
export async function freeTextPhrase(text: string, ws: number | null): Promise<string | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey || !text.trim()) return null;
  const wsHeader = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
  try {
    const client = new Anthropic({ apiKey, ...(wsHeader ? { defaultHeaders: { 'anthropic-workspace-id': wsHeader } } : {}) });
    const res = await client.messages.create({
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: 1000,
      system: cachedSystem(SYSTEM),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: fence('other_modifications', text, 1500) }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    await recordUsage(null, { ws, feature: 'contract_name', model: res.model, usage: res.usage });
    if (res.stop_reason === 'refusal') return null;
    const body = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    return cleanPhrase(JSON.parse(body)?.phrase);
  } catch (e) {
    console.error('contract-name phrase', String(e));
    return null;
  }
}

/**
 * Everyone signed an amendment or addendum whose name CLOZR made: name it
 * from what it changed and save. Returns the row with its new name (or the
 * same row). Never throws; a naming failure must not fail the completion.
 */
export async function nameSignedAmendment(admin: SupabaseClient, row: Record<string, Any>, signedOn: string | null): Promise<Record<string, Any>> {
  try {
    if (!row.name_auto || !RENAMED_KINDS.has(String(row.kind ?? ''))) return row;
    const { data: fieldRows } = await admin.from('contract_fields').select('label, variable_key, type, value').eq('contract_id', row.id);
    const fields: NameField[] = [
      ...((fieldRows ?? []) as Any[]).map((f) => ({ label: f.label, key: f.variable_key, type: f.type, value: f.value })),
      ...tokenFields(Array.isArray(row.tokens) ? row.tokens : []),
    ];
    let street = streetOf(fields.find((f) => /property\.address|property address/i.test(`${f.key ?? ''} ${f.label ?? ''}`))?.value);
    if (!street && row.deal_id) {
      const { data: deal } = await admin.from('deals').select('property_id').eq('id', row.deal_id).maybeSingle();
      const { data: prop } = deal?.property_id ? await admin.from('properties').select('line1').eq('id', deal.property_id).maybeSingle() : { data: null };
      street = streetOf((prop as Any)?.line1);
    }
    const other = otherModifications(fields);
    const phrase = other ? await freeTextPhrase(other, Number(row.workspace_id) || null) : null;
    let name = amendmentName(street, amendmentChanges(fields), phrase, String(row.kind));
    if (row.deal_id) {
      const { data: others } = await admin.from('contracts').select('name').eq('deal_id', row.deal_id).neq('id', row.id);
      name = uniqueName(name, ((others ?? []) as Any[]).map((o) => String(o.name ?? '')), signedOn);
    }
    if (!name || name === row.name) return row;
    const { error } = await admin.from('contracts').update({ name, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) { console.error('contract-name save', error.message); return row; }
    return { ...row, name };
  } catch (e) {
    console.error('contract-name', String(e));
    return row;
  }
}
