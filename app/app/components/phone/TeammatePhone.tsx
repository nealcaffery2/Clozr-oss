// Putting CLOZR teammates on Talkr (matched by email). Their lines, caller ID
// and voicemail greeting are edited on Settings → Numbers (NumbersPage).
'use client';

import { talkr } from '@/lib/talkr';
import { isReadOnly } from '@/lib/read-only';
import { refreshPhoneAdmin } from './store';

/** CLOZR role → Talkr role. Only admins administer the phone system. */
export const talkrRole = (role: string): 'admin' | 'rep' => (role === 'owner' || role === 'admin' ? 'admin' : 'rep');

/** Add a CLOZR teammate to Talkr unless they are already there. Throws on failure.
 * Does not email a Talkr invite — the person signs into CLOZR; Talkr links by email. */
export async function ensureOnTalkr(email: string, name: string, role: string): Promise<boolean> {
  const { members } = await talkr.teamMembers();
  if (members.some((m) => m.email.toLowerCase() === email.toLowerCase())) return false;
  const created = await talkr.createTeamMember({
    email,
    display_name: name || email.split('@')[0],
    role: talkrRole(role),
    send_auth_invite: false,
  });
  if (created.member.status !== 'active') {
    try { await talkr.updateTeamMember(created.member.id, { status: 'active' }); } catch { /* buy will try again and say why */ }
  }
  await refreshPhoneAdmin();
  return true;
}

/**
 * Put every CLOZR teammate with an email on Talkr (one team read, then one create per missing person).
 * Admin-only on Talkr's side; a non-admin gets a rejected create, which is skipped. Returns how many were added.
 * ponytail: create-only — name/role changes and removals in CLOZR are not pushed; add when the team churns.
 */
export async function syncTeamToTalkr(rows: { email: string | null; full_name?: string | null; role: string }[]): Promise<number> {
  // Runs by itself when Team opens; a read-only preview skips it quietly.
  if (isReadOnly()) return 0;
  const { members } = await talkr.teamMembers();
  const have = new Set(members.map((m) => m.email.toLowerCase()));
  let added = 0;
  for (const r of rows) {
    const email = r.email?.trim();
    if (!email || have.has(email.toLowerCase())) continue;
    try {
      const created = await talkr.createTeamMember({
        email,
        display_name: r.full_name?.trim() || email.split('@')[0],
        role: talkrRole(r.role),
        send_auth_invite: false,
      });
      have.add(email.toLowerCase());
      added++;
      // A brand-new seat is invited. Talkr will not put a number on it until it is active.
      if (created.member.status !== 'active') {
        try { await talkr.updateTeamMember(created.member.id, { status: 'active' }); } catch { /* buy will try again and say why */ }
      }
    } catch {
      /* not an admin, or Talkr refused this one: the row keeps its Add to Talkr button */
    }
  }
  const wanted = new Set(rows.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)));
  for (const m of members) {
    if (!wanted.has(m.email.toLowerCase()) || m.status === 'active' || m.status === 'disabled') continue;
    try { await talkr.updateTeamMember(m.id, { status: 'active' }); added++; } catch { /* left invited; buying explains it */ }
  }
  if (added) await refreshPhoneAdmin();
  return added;
}
