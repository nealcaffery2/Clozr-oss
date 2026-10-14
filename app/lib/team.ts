// The team: who is in the workspace, what they can do, and adding someone.
//
// Roles are enforced by RLS (migration 17). This module is the client's view
// of the same rule, so the nav and the screens can reflect what the database
// will allow rather than discovering it as empty lists.

import { renderNotaryStamp, stampGaps } from '../supabase/functions/_shared/notary-stamp';
import { supabase } from './supabase';
import { PODIO_NEW_SUBMISSIONS, PODIO_TOTAL_SUBMISSIONS } from './stages';

export type Role = 'owner' | 'admin' | 'acquisitions' | 'dispositions' | 'tc' | 'member' | 'notary' | 'partnerships' | 'sdr';

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  acquisitions: 'Acquisitions',
  dispositions: 'Dispositions',
  tc: 'Transaction coordinator',
  member: 'Member',
  notary: 'Notary',
  partnerships: 'Partnerships',
  sdr: 'SDR',
};

/** Roles an admin can assign. Owner is the workspace creator and is not assignable. */
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'acquisitions', 'dispositions', 'sdr', 'tc', 'partnerships', 'notary', 'member'];

/**
 * Which screens a role may open. The key is the shell's screen id.
 *
 * Acquisitions runs leads through contract and never sees dispo, Genius, or
 * any buyers surface (nav, lists, match UI, buyer PII on deals). Dispositions
 * see everything — including TC and notary flows — so they can work a deal
 * end to end. TC sees the closing file and the Inbox. Owner and admin see
 * everything; `member` is a read-mostly baseline for anyone who does not fit.
 */
const SCREENS: Record<Role, ReadonlySet<string> | 'all'> = {
  owner: 'all',
  admin: 'all',
  member: 'all',
  // Full access: TC files, notary, buyers, people, dispo — same as owner/admin.
  dispositions: 'all',
  acquisitions: new Set([
    // Today is where they land: the list they call, and the call loop.
    'today', 'home', 'people', 'person', 'import', 'inbox', 'tasks', 'calendar', 'deals', 'dealSheet', 'reporting',
    'talkr', 'dialer', 'plans', 'automations', 'leaderboard', 'settings', 'account', 'liveLists',
    // Coaching: their own graded calls, scorecard and roleplay practice.
    'coaching',
    // Purchase agreements go out from acquisitions.
    'contracts',
    // Deal Machine is where their raw leads come from.
    'dealMachine',
    // Buyr snipes aged Deal Machine deals; buyer records stay behind RLS.
    'buyr',
  ]),
  tc: new Set([
    'home', 'inbox', 'tasks', 'calendar', 'deals', 'dealSheet', 'tc', 'reporting', 'settings', 'account', 'liveLists',
    'person',
    // The closing file runs on the signed contracts.
    'contracts',
  ]),
  // A notary stamps documents. They do not work the pipeline or the buyer list.
  // Contracts is visible to every role: the server still decides who may send.
  notary: new Set(['home', 'inbox', 'deals', 'dealSheet', 'person', 'tasks', 'calendar', 'settings', 'account', 'contracts']),
  // Partner submissions and vendors, nothing else: no buyers, dispo or the
  // acquisitions seller lists. People stays for the Submissions and Vendors
  // rails (seesSellerLists hides the rest of it), and the record for COMPR.
  // Calls (the dialer), texts and email (Inbox, the record) to partners.
  partnerships: new Set(['home', 'people', 'person', 'import', 'inbox', 'talkr', 'dialer', 'tasks', 'calendar', 'deals', 'dealSheet', 'settings', 'account', 'contracts']),
  // An SDR works a contacts list (Buyers) by phone, text, email and RVM: their
  // records, the dialer and texts on their own Talkr lines, the action plans
  // and their own numbers. No sellers, deals, contracts or wholesaling tools
  // (migration 263).
  sdr: new Set([
    'buyers', 'buyer', 'import', 'inbox', 'talkr', 'dialer', 'tasks', 'calendar', 'plans', 'automations',
    'reporting', 'leaderboard', 'coaching', 'settings', 'account',
  ]),
};

/**
 * The role the sample-data demo runs as when no `?as=` is given: everything,
 * the way an owner sees it. A signed-in workspace never uses it.
 */
export const DEMO_ROLE: Role = 'owner';

export function canSee(role: Role | null | undefined, screen: string): boolean {
  // No role is a membership that didn't load or doesn't exist: show nothing
  // rather than everything. The demo passes DEMO_ROLE.
  if (!role) return false;
  const allowed = SCREENS[role] ?? 'all';
  return allowed === 'all' || allowed.has(screen);
}

/** Buyer list, buyer records, Genius match UI, and buyer PII on deals. */
export const canSeeBuyers = (role: Role | null | undefined) => canSee(role, 'buyers');

/** The seller smart lists and the Sellers, Agents and Buyers lists on People. Partnerships sees only submissions and vendors. */
export const seesSellerLists = (role: Role | null | undefined) => role !== 'partnerships';

/** The People lists Partnerships works: the Podio submission views and the vendor lists. */
const PARTNER_LISTS = new Set<string>([
  'New Submissions', 'Total Submissions', ...PODIO_NEW_SUBMISSIONS, ...PODIO_TOTAL_SUBMISSIONS,
  'Vendors', 'Lenders', 'Title Companies', 'Photographers / Notaries', 'Wholesalers', 'Partners', 'Last import',
]);
/** Where Partnerships opens People. */
export const PARTNER_START_LIST = 'New Submissions';
/** True when this role may sit on this People list (a saved list is always theirs to open). */
export const peopleListOk = (role: Role | null | undefined, list: string, saved = false) => seesSellerLists(role) || saved || PARTNER_LISTS.has(list);

export const isAdmin = (role: Role | null | undefined) => role === 'owner' || role === 'admin';
/** Who reads every teammate's mailbox; everyone else reads their own (migration 106 enforces it). */
export const seesAllMail = (role: Role | null | undefined) => isAdmin(role) || role === 'tc';

/**
 * Where a role lands when the address names no screen. Acquisitions starts
 * the day on Today, the list they call; Partnerships on People (its
 * Submissions); an SDR on Buyers, their contacts; everyone else on Home.
 */
export const landingFor = (role: Role | null | undefined): 'today' | 'home' | 'people' | 'buyers' =>
  (role === 'acquisitions' ? 'today' : role === 'partnerships' ? 'people' : role === 'sdr' ? 'buyers' : 'home');

/** The transaction coordinator on this roster — never a hardcoded name. */
export function teamTc<T extends { id: string; name: string; role: string; dept?: string }>(team: Record<string, T>): T | null {
  const all = Object.values(team);
  return all.find((r) => r.dept === 'TC' || /^tc$/i.test(r.role) || /transaction coord/i.test(r.role))
    ?? all.find((r) => /casey/i.test(r.name))
    ?? null;
}

export type Teammate = {
  user_id: string;
  role: Role;
  full_name: string | null;
  title: string | null;
  email: string | null;
  avatar_url?: string | null;
  joined_at: string;
};

export async function listTeam(workspaceId: number): Promise<Teammate[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from('workspace_roster')
    .select('user_id, role, full_name, title, email, avatar_url, joined_at')
    .eq('workspace_id', workspaceId)
    .order('joined_at');
  return (data as Teammate[]) ?? [];
}

export type AddResult =
  | { ok: true; email: string; tempPassword: string | null; existing: boolean; emailed: boolean; warning?: string }
  | { ok: false; message: string };

async function invokeAddTeammate(body: Record<string, unknown>): Promise<AddResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  // Prefer the live Clozr origin so invite CTAs never inherit a Talkr APP_URL.
  const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
  const { data, error } = await supabase.functions.invoke('add-teammate', {
    body: origin ? { ...body, origin } : body,
  });
  if (error) {
    // The function's own JSON error is more useful than the transport wrapper.
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as {
    ok: boolean; email: string; temp_password?: string; existing: boolean;
    emailed?: boolean; warning?: string; error?: string;
  };
  if (!r?.ok) return { ok: false, message: r?.error ?? 'Could not add that teammate.' };
  return {
    ok: true,
    email: r.email,
    tempPassword: r.temp_password ?? null,
    existing: r.existing,
    emailed: r.emailed === true,
    warning: r.warning,
  };
}

/** Commission facts the seal is drawn from. The state statute decides which are required. */
export type NotaryOnboard = {
  state: string;
  expires: string;
  commissionNumber?: string;
  county?: string;
};

/**
 * Add a teammate. Goes through the add-teammate edge function because creating
 * an auth user needs the service role. A CLOZR-branded invite email carries
 * their one-time password; the password also comes back once for the admin.
 * A notary also sends the commission, and the function stores their seal.
 */
export async function addTeammate(
  workspaceId: number, email: string, fullName: string, role: Role, notary?: NotaryOnboard,
): Promise<AddResult> {
  return invokeAddTeammate({
    workspace_id: workspaceId, email, full_name: fullName, role,
    ...(role === 'notary' && notary ? {
      notary_state: notary.state,
      notary_expires: notary.expires,
      notary_commission_number: notary.commissionNumber ?? null,
      notary_county: notary.county ?? null,
    } : {}),
  });
}

/**
 * Re-mail a teammate their invite with a fresh temporary password. Resets the
 * auth password so the emailed one is the one that works.
 */
export async function resendTeammateInvite(
  workspaceId: number, email: string, fullName?: string | null,
): Promise<AddResult> {
  return invokeAddTeammate({
    workspace_id: workspaceId,
    email,
    full_name: fullName ?? '',
    resend: true,
  });
}

export async function setRole(
  workspaceId: number, userId: string, role: Role, notary?: NotaryOnboard & { name: string },
): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const patch: {
    role: Role;
    notary_state?: string | null; notary_commission_expires?: string | null;
    notary_commission_number?: string | null; notary_county?: string | null; notary_stamp_svg?: string | null;
  } = { role };
  if (role === 'notary') {
    if (!notary) return { ok: false, message: 'A notary needs a state and a commission expiration before the seal can be drawn.' };
    const commission = {
      name: notary.name, state: notary.state, expires: notary.expires.slice(0, 10),
      commissionNumber: notary.commissionNumber ?? null, county: notary.county ?? null,
    };
    const gaps = stampGaps(commission);
    if (gaps.length) return { ok: false, message: `Notary seal needs: ${gaps.join(', ')}` };
    patch.notary_state = commission.state.trim().toUpperCase();
    patch.notary_commission_expires = commission.expires;
    patch.notary_commission_number = commission.commissionNumber || null;
    patch.notary_county = commission.county || null;
    patch.notary_stamp_svg = renderNotaryStamp(commission);
  }
  const { error } = await supabase.from('workspace_members').update(patch)
    .eq('workspace_id', workspaceId).eq('user_id', userId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

export async function removeTeammate(workspaceId: number, userId: string): Promise<{ ok: boolean; message?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { error } = await supabase.from('workspace_members').delete()
    .eq('workspace_id', workspaceId).eq('user_id', userId);
  return error ? { ok: false, message: error.message } : { ok: true };
}

// ---- AI drafting ------------------------------------------------------------

export type DraftedPlan = {
  name: string; trigger: string; description: string;
  steps: { channel: string; delay: string; title: string; content: string }[];
};

/**
 * Ask Claude for a follow-up sequence — from a goal, or from one seller's
 * whole history. Goes through the draft-action-plan edge function, which
 * holds the API key. The draft lands in the builder; nothing is saved by this.
 */
export async function draftPlan(
  workspaceId: number,
  req: { mode: 'goal'; goal: string; trigger?: string } | { mode: 'lead'; sellerId: number },
): Promise<{ ok: true; plan: DraftedPlan } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const body = req.mode === 'goal'
    ? { mode: 'goal', workspace_id: workspaceId, goal: req.goal, trigger: req.trigger }
    : { mode: 'lead', workspace_id: workspaceId, seller_id: req.sellerId };
  const { data, error } = await supabase.functions.invoke('draft-action-plan', { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { ok?: boolean; plan?: DraftedPlan; error?: string };
  if (!r?.ok || !r.plan) return { ok: false, message: r?.error ?? 'No plan came back.' };
  return { ok: true, plan: r.plan };
}
