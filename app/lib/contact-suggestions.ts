'use client';

// Agents, escrow officers and title reps the Gmail sync found on the team's
// mail who are not in CLOZR yet (migration 259, _shared/contact-suggest.ts).
// Reads degrade to an empty list before the migration is applied.

import { supabase } from '@/lib/supabase';

export type SuggestionKind = 'agent' | 'title' | 'other';

export type ContactSuggestion = {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  kind: SuggestionKind;
  deal_id: number | null;
  user_id: string | null;
  subject: string | null;
  seen_count: number;
  last_seen_at: string;
};

export const KIND_LABEL: Record<SuggestionKind, string> = { agent: 'Agent', title: 'Title or escrow', other: 'Other' };

/** Open suggestions, newest sighting first. `mine` limits them to mail in that teammate's mailbox. */
export async function loadSuggestions(workspaceId: number, mine?: string | null): Promise<{ rows: ContactSuggestion[]; error: string | null }> {
  if (!supabase) return { rows: [], error: null };
  let q = supabase.from('contact_suggestions')
    .select('id, email, name, company, kind, deal_id, user_id, subject, seen_count, last_seen_at')
    .eq('workspace_id', workspaceId).eq('status', 'open')
    .order('last_seen_at', { ascending: false }).limit(200);
  if (mine) q = q.eq('user_id', mine);
  const { data, error } = await q;
  if (error) {
    // Not migrated yet: nothing to suggest, not an error to show.
    if (/contact_suggestions|schema cache|does not exist/i.test(error.message)) return { rows: [], error: null };
    return { rows: [], error: 'Could not load the new contacts. Reload to try again.' };
  }
  return { rows: (data ?? []) as ContactSuggestion[], error: null };
}

/** Add as a contact (a vendor, and onto the deal the mail was on) or dismiss for good. Null on success, else the message to show. */
export async function resolveSuggestion(
  id: number, action: 'add' | 'dismiss', fields?: { kind: SuggestionKind; name: string; company: string },
): Promise<string | null> {
  if (!supabase) return 'Not connected.';
  const { error } = await supabase.rpc('contact_suggestion_resolve', {
    p_id: id, p_action: action, p_kind: fields?.kind ?? null, p_name: fields?.name ?? null, p_company: fields?.company ?? null,
  });
  return error ? (action === 'add' ? 'Could not add that contact. Try again.' : 'Could not dismiss that one. Try again.') : null;
}
