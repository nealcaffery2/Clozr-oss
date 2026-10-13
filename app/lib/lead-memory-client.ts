// The record card's side of lead memory (migration 110): read the stored row,
// ask the lead-memory function to rewrite it, and a sample memory for /demo.
// Reads fail open: no table yet reads as "no memory", never as an error.

import { supabase } from './supabase';
import { emptyFacts, firstNameOf, rowToMemory, type LeadMemory, type RecordKind } from './lead-memory';

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''));

export async function loadLeadMemory(workspaceId: number, kind: RecordKind, recordId: number): Promise<{ memory: LeadMemory | null; error?: string }> {
  if (!supabase) return { memory: null };
  const { data, error } = await supabase.from('lead_memory').select('*')
    .eq('workspace_id', workspaceId).eq('record_kind', kind).eq('record_id', recordId).maybeSingle();
  if (error) return missing(error) ? { memory: null } : { memory: null, error: `Could not read the memory: ${error.message}` };
  return { memory: rowToMemory(data) };
}

export async function refreshLeadMemoryNow(workspaceId: number, kind: RecordKind, recordId: number): Promise<{ memory: LeadMemory | null; message?: string; error?: string }> {
  if (!supabase) return { memory: null, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('lead-memory', {
    body: { action: 'refresh', workspace_id: workspaceId, record_kind: kind, record_id: recordId },
  });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) msg = ((await ctx.json()) as { error?: string }).error ?? msg;
    } catch { /* keep the transport message */ }
    if (/failed to send|not found|404/i.test(msg)) msg = 'The lead-memory function is not deployed on the Supabase project.';
    return { memory: null, error: msg };
  }
  const res = data as { memory?: unknown; message?: string };
  return { memory: rowToMemory(res.memory), message: res.message };
}

const money = (s: string | undefined) => {
  const n = Number(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** A believable memory built from the sample record, so /demo shows the card filled in. */
export function demoLeadMemory(kind: RecordKind, seed: { id: string | number; name: string; address?: string; fields?: { k: string; v: string }[]; company?: string }): LeadMemory {
  const f = (label: RegExp) => seed.fields?.find((x) => label.test(x.k) && x.v && x.v !== '\u2014')?.v;
  const first = firstNameOf(seed.name) ?? seed.name;
  const updated = new Date(Date.now() - 6 * 60_000).toISOString();
  if (kind === 'buyer') {
    return {
      workspace_id: 0, record_kind: 'buyer', record_id: Number(String(seed.id).replace(/\D/g, '')) || 0, model: 'demo', updated_at: updated,
      source_count: 23, last_source_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      brief: `${first}${seed.company ? ` buys for ${seed.company}` : ''}: flips in the north side, wants 3 bed ranches under $180K that need cosmetic work only. Answers texts within the hour, never picks up unknown numbers. Offered on two of our last five sends and closed one in June. Asked us to stop sending anything with foundation issues. We promised first look on the next Oak Park deal.`,
      facts: {
        ...emptyFacts(), first_name: first, motivation: 'Flips, cosmetic rehabs only', timeline: 'Closes in 10 days with cash',
        objections: ['Foundation work'], promises_made: ['First look on the next Oak Park deal'], next_step: 'Send the next Oak Park deal before the blast',
        do_not_mention: ['The deal that fell through in March'], sentiment: 'positive',
        last_contact_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), last_contact_summary: 'Texted back asking for photos of the kitchen.',
        open_questions: ['Proof of funds on file is from last year'],
      },
    };
  }
  const asking = money(f(/asking/i));
  const motivation = f(/motivation/i) ?? 'Inherited the house and lives out of state';
  const timeline = f(/timeline/i) ?? 'Wants it sold before the holidays';
  return {
    workspace_id: 0, record_kind: 'seller', record_id: Number(String(seed.id).replace(/\D/g, '')) || 0, model: 'demo', updated_at: updated,
    source_count: 14, last_source_at: new Date(Date.now() - 86_400_000).toISOString(),
    brief: `${first} owns ${seed.address || 'the property'}. ${motivation}. ${timeline}.${asking ? ` Asking $${asking.toLocaleString('en-US')}.` : ''} Roof is original and the HVAC was replaced in 2021. Worried an investor will lowball, so lead with the comps. We promised to send the written offer by Friday. Prefers texts after 5pm; a sibling is on the deed.`,
    facts: {
      ...emptyFacts(), first_name: first, property_address: seed.address || null, motivation, asking_price: asking, timeline,
      condition_notes: 'Original roof, HVAC 2021', objections: ['Afraid of a lowball offer'],
      promises_made: ['Send the written offer by Friday'], next_step: 'Email the written offer and call Friday after 5pm',
      do_not_mention: ['The late parent, unless they bring it up'], sentiment: 'neutral',
      last_contact_at: new Date(Date.now() - 86_400_000).toISOString(), last_contact_summary: 'Asked for the offer in writing before talking it over with their sibling.',
      open_questions: ['Is there a mortgage balance?'],
    },
  };
}
