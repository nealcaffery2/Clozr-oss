// InvestorBase → the buyer list.
//
// The key stays in workspace_integration_secrets. This file only asks whether
// one is saved, and asks the edge function to search an address and write the
// buyers. Settings → Integrations is where an owner pastes the key.

import { supabase } from './supabase';

export async function investorbaseConnected(workspaceId: number): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('investorbase_connected', { p_workspace_id: workspaceId });
  if (error) return false;
  return data === true;
}

export async function saveInvestorbaseKey(workspaceId: number, key: string): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.rpc('set_investorbase_key', { p_workspace_id: workspaceId, p_key: key });
  return error ? { ok: false, message: error.message } : { ok: true };
}

export type InvestorBaseImport = {
  created: number;
  existing: number;
  buyers: number[];
  address: string | null;
  scanned: number;
};

export async function importInvestorBase(
  workspaceId: number,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: InvestorBaseImport } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('investorbase-import', {
    body: { workspace_id: workspaceId, ...body },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const payload = data as { error?: string } & Partial<InvestorBaseImport>;
  if (payload?.error) return { ok: false, message: payload.error };
  return {
    ok: true,
    data: {
      created: payload.created ?? 0,
      existing: payload.existing ?? 0,
      buyers: payload.buyers ?? [],
      address: payload.address ?? null,
      scanned: payload.scanned ?? 0,
    },
  };
}
