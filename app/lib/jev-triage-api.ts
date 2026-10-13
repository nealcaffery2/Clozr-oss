// Browser → jev-triage edge function. Nothing is written on the other side.

import { supabase } from './supabase';
import type { JevResponse, LeadTriageState } from './jev-triage';

export async function evaluateLiveJev(state: LeadTriageState): Promise<
  { ok: true; response: JevResponse } | { ok: false; message: string; status?: number }
> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('jev-triage', { body: { state } });
  if (error) {
    let message = error.message;
    let status: number | undefined;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) {
        status = ctx.status;
        const body = (await ctx.json()) as { error?: string };
        if (body.error) message = body.error;
      }
    } catch { /* keep the transport message */ }
    return { ok: false, message, status };
  }
  const r = data as { ok?: boolean; model?: string; answers?: JevResponse['answers']; usage?: JevResponse['usage']; error?: string };
  if (!r?.ok || !r.answers) return { ok: false, message: r?.error ?? 'Jev returned no answers.' };
  return {
    ok: true,
    response: {
      model: r.model ?? 'jev-latest',
      answers: r.answers,
      usage: r.usage ?? { input_tokens: 0, output_tokens: 0 },
    },
  };
}
