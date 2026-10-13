// Round robins (migration 121): who new leads and new deals are dealt to.
//
// An acquisitions rotation deals inbound leads — every ingest key (the
// yourcompany.com form, Jotform, Zapier, Deal Machine) names the rotation
// its new leads go to. A dispositions rotation deals deals of one type
// (novation by default) to a dispo rep the moment the deal type is set.
//
// The pick itself is in Postgres (round_robin_pick) so two webhooks landing
// together cannot hand out the same turn. This module only edits who is in
// which rotation; RLS lets every member read and only owner/admin write.

import type { RoundRobinMemberRow, RoundRobinRow } from './database.types';
import { supabase } from './supabase';

export type RoundRobin = RoundRobinRow & { members: RoundRobinMemberRow[] };
export type RoundRobinTeam = RoundRobinRow['team'];
export type RoundRobinDealType = NonNullable<RoundRobinRow['deal_type']>;

export const DEAL_TYPE_OPTIONS: { value: RoundRobinDealType; label: string }[] = [
  { value: 'novation', label: 'Novations' },
  { value: 'assignment', label: 'Assignments' },
  { value: 'jv', label: 'JVs' },
  { value: 'double_close', label: 'Double closes' },
  { value: 'any', label: 'Every deal type' },
];

type Result = { ok: true } | { ok: false; message: string };
const done = (error: { message: string } | null): Result => (error ? { ok: false, message: error.message } : { ok: true });
const NOT_CONFIGURED: Result = { ok: false, message: 'Supabase is not configured.' };

/**
 * Every rotation with its members. A database without migration 121 answers
 * with an error, which comes back as `missing` so Settings can say so instead
 * of showing an empty list that looks like nobody set one up.
 */
export async function listRoundRobins(workspaceId: number): Promise<{ rows: RoundRobin[]; missing: boolean }> {
  if (!supabase) return { rows: [], missing: false };
  const [rr, mm] = await Promise.all([
    supabase.from('round_robins').select('*').eq('workspace_id', workspaceId).order('team').order('id'),
    supabase.from('round_robin_members').select('*').eq('workspace_id', workspaceId).order('added_at'),
  ]);
  if (rr.error) return { rows: [], missing: true };
  const members = (mm.data ?? []) as RoundRobinMemberRow[];
  const rows = ((rr.data ?? []) as RoundRobinRow[]).map((r) => ({ ...r, members: members.filter((m) => m.round_robin_id === r.id) }));
  return { rows, missing: false };
}

export async function createRoundRobin(
  workspaceId: number,
  team: RoundRobinTeam,
  name: string,
): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  if (!supabase) return NOT_CONFIGURED as { ok: false; message: string };
  const { data, error } = await supabase.from('round_robins')
    .insert({ workspace_id: workspaceId, team, name: name.trim(), deal_type: team === 'dispositions' ? 'novation' : null })
    .select('id').single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: (data as { id: number }).id };
}

export async function updateRoundRobin(
  id: number,
  patch: Partial<Pick<RoundRobinRow, 'name' | 'active' | 'deal_type' | 'underwriter'>>,
): Promise<Result> {
  if (!supabase) return NOT_CONFIGURED;
  const { error } = await supabase.from('round_robins').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  return done(error);
}

/** Deleting a rotation also turns it off on every key that named it (they then assign nobody). */
export async function deleteRoundRobin(id: number): Promise<Result> {
  if (!supabase) return NOT_CONFIGURED;
  const { error } = await supabase.from('round_robins').delete().eq('id', id);
  return done(error);
}

export async function addRoundRobinMember(workspaceId: number, roundRobinId: number, userId: string): Promise<Result> {
  if (!supabase) return NOT_CONFIGURED;
  const { error } = await supabase.from('round_robin_members')
    .insert({ workspace_id: workspaceId, round_robin_id: roundRobinId, user_id: userId });
  return done(error);
}

/** Out of the rotation (vacation, a full pipeline) without losing their place in the list. */
export async function setRoundRobinMemberActive(roundRobinId: number, userId: string, active: boolean): Promise<Result> {
  if (!supabase) return NOT_CONFIGURED;
  const { error } = await supabase.from('round_robin_members').update({ active })
    .eq('round_robin_id', roundRobinId).eq('user_id', userId);
  return done(error);
}

export async function removeRoundRobinMember(roundRobinId: number, userId: string): Promise<Result> {
  if (!supabase) return NOT_CONFIGURED;
  const { error } = await supabase.from('round_robin_members').delete()
    .eq('round_robin_id', roundRobinId).eq('user_id', userId);
  return done(error);
}

/**
 * Who is up next, as round_robin_pick would choose: the active member dealt
 * a lead longest ago, never-dealt first, then the order they were added.
 * Display only — the database makes the real pick under a lock.
 */
export function nextUp(r: RoundRobin): RoundRobinMemberRow | null {
  const live = r.members.filter((m) => m.active);
  if (!live.length) return null;
  return [...live].sort((a, b) => {
    if (!a.last_assigned_at !== !b.last_assigned_at) return a.last_assigned_at ? 1 : -1;
    if (a.last_assigned_at && b.last_assigned_at && a.last_assigned_at !== b.last_assigned_at) {
      return a.last_assigned_at < b.last_assigned_at ? -1 : 1;
    }
    return a.added_at < b.added_at ? -1 : a.added_at > b.added_at ? 1 : a.user_id < b.user_id ? -1 : 1;
  })[0];
}
