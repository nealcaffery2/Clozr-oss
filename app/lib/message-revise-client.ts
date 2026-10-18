// The browser side of message-revise: ask the AI to change one part of a
// campaign message, the way the rep described it.

import { supabase } from './supabase';
import type { CarrierFinding } from './carrier-safe';

export type Revised = {
  text: string;
  subject: string | null;
  html: string | null;
  carrier: { text: string; blocked: boolean; findings: CarrierFinding[] };
  slop: { pattern: string; quote: string; fix: string }[];
};

export async function reviseMessage(
  workspaceId: number,
  input: { channel: 'sms' | 'email'; instruction: string; text: string; subject?: string | null; html?: string | null; section?: string | null },
): Promise<{ ok: true; data: Revised } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('message-revise', { body: { workspace_id: workspaceId, ...input } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const d = data as Partial<Revised>;
  return {
    ok: true,
    data: {
      text: String(d.text ?? ''), subject: d.subject ?? null, html: d.html ?? null,
      carrier: d.carrier ?? { text: String(d.text ?? ''), blocked: false, findings: [] },
      slop: Array.isArray(d.slop) ? d.slop : [],
    },
  };
}
