// Whose line is whose, for every "From" / caller-ID picker: "(210) 555-0163 ·
// Quinn · San Antonio". The owner is the Talkr teammate the number is
// assigned to (org_numbers.assigned_user_id → Talkr's team list), else the
// name CLOZR keeps for that number (rep_phone_numbers, migration 153; the AI
// agents' pool, voice_agent_numbers). Read once per page and shared.
'use client';

import { useSyncExternalStore } from 'react';
import { notedWorkspaceId } from './active-workspace';
import { api } from './talkr-web/api';
import { formatPhone } from './talkr-web/time';
import { supabase } from './supabase';

type Names = { team: Map<string, string>; byNumber: Map<string, string> };
let names: Names | null = null;
let loading: Promise<void> | null = null;
let forWs: number | null = null;
const subs = new Set<() => void>();
const key10 = (e164: string) => String(e164 ?? '').replace(/\D/g, '').slice(-10);

/** Drop the cached names so the next read uses the workspace that is on screen. */
export function forgetLineNames(): void {
  names = null;
  loading = null;
  forWs = null;
  for (const f of subs) f();
}

function load(): Promise<void> {
  const ws = notedWorkspaceId();
  if (ws == null) return Promise.resolve();
  if (loading && forWs === ws) return loading;
  forWs = ws;
  const run = (async () => {
    const team = new Map<string, string>();
    const byNumber = new Map<string, string>();
    const [t, reps, ai] = await Promise.all([
      api.listTeam().catch(() => ({ members: [] as { id: string; display_name?: string; name?: string }[] })),
      supabase ? Promise.resolve(supabase.from('rep_phone_numbers' as never).select('phone_e164, label, user_id').eq('workspace_id', ws)).then((r) => r.data ?? []).catch(() => []) : Promise.resolve([]),
      supabase ? Promise.resolve(supabase.from('voice_agent_numbers' as never).select('phone_number, label').eq('workspace_id', ws)).then((r) => r.data ?? []).catch(() => []) : Promise.resolve([]),
    ]);
    // A switch started a newer read. Don't publish the workspace we left.
    if (forWs !== ws) return;
    for (const m of (t.members ?? []) as { id: string; display_name?: string; name?: string }[]) {
      const n = (m.display_name || m.name || '').trim();
      if (n) team.set(String(m.id), n.split(/\s+/)[0]);
    }
    for (const r of reps as { phone_e164: string; label: string }[]) if (r.phone_e164 && r.label) byNumber.set(key10(r.phone_e164), r.label);
    for (const r of ai as { phone_number: string | null; label: string }[]) if (r.phone_number && r.label) byNumber.set(key10(r.phone_number), r.label);
    names = { team, byNumber };
    for (const f of subs) f();
  })();
  loading = run;
  return run;
}

type Line = { phone_e164: string; label?: string | null; assigned_user_id?: string | null };

/** Who a line belongs to: the assigned teammate's first name, else CLOZR's name for the number, else '' (unassigned). */
export function lineOwner(n: Line, me?: string | null): string {
  if (n.assigned_user_id && me && n.assigned_user_id === me) return 'Yours';
  const team = n.assigned_user_id ? names?.team.get(String(n.assigned_user_id)) : undefined;
  return team ?? names?.byNumber.get(key10(n.phone_e164)) ?? '';
}

/** "(210) 555-0163 · Quinn · San Antonio", or "· Shared" for a line nobody owns. */
export function lineText(n: Line, me?: string | null): string {
  const owner = lineOwner(n, me) || (n.assigned_user_id ? '' : 'Shared');
  const label = (n.label ?? '').trim();
  return [formatPhone(n.phone_e164), owner, label && label.toLowerCase() !== owner.toLowerCase() ? label : ''].filter(Boolean).join(' · ');
}

/** Re-renders a picker once the names are in. */
export function useLineNames(): Names | null {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); void load(); return () => subs.delete(cb); },
    () => names,
    () => null,
  );
}
