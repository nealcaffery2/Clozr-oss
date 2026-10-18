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
export type SyncTeamResult = { added: number; activated: number; errors: string[] };

function memberOnTalkr(members: { email: string; display_name?: string }[], row: { email: string | null; full_name?: string | null }): boolean {
  const email = row.email?.trim().toLowerCase();
  if (email && members.some((m) => m.email.toLowerCase() === email)) return true;
  const name = row.full_name?.trim().toLowerCase();
  return !!name && members.some((m) => m.display_name?.trim().toLowerCase() === name);
}

export async function syncTeamToTalkr(rows: { email: string | null; full_name?: string | null; role: string }[]): Promise<SyncTeamResult> {
  // Runs by itself when Team opens; a read-only preview skips it quietly.
  if (isReadOnly()) return { added: 0, activated: 0, errors: [] };
  const { members } = await talkr.teamMembers();
  let added = 0;
  let activated = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const email = r.email?.trim();
    if (!email || memberOnTalkr(members, r)) continue;
    try {
      const created = await talkr.createTeamMember({
        email,
        display_name: r.full_name?.trim() || email.split('@')[0],
        role: talkrRole(r.role),
        send_auth_invite: false,
      });
      members.push(created.member);
      added++;
      if (created.member.status !== 'active') {
        try {
          await talkr.updateTeamMember(created.member.id, { status: 'active' });
          activated++;
        } catch (err) {
          errors.push(`${email}: created but not activated (${err instanceof Error ? err.message : 'Talkr refused'})`);
        }
      }
    } catch (err) {
      errors.push(`${email || r.full_name || 'teammate'}: ${err instanceof Error ? err.message : 'Talkr refused'}`);
    }
  }
  const wanted = rows.filter((r) => r.email?.trim() || r.full_name?.trim());
  for (const r of wanted) {
    const email = r.email?.trim().toLowerCase();
    const name = r.full_name?.trim().toLowerCase();
    const m = members.find((x) => (email && x.email.toLowerCase() === email) || (name && x.display_name?.trim().toLowerCase() === name));
    if (!m || m.status === 'active' || m.status === 'disabled') continue;
    try {
      await talkr.updateTeamMember(m.id, { status: 'active' });
      activated++;
    } catch (err) {
      errors.push(`${m.email}: still ${m.status} (${err instanceof Error ? err.message : 'Talkr refused'})`);
    }
  }
  if (added || activated) await refreshPhoneAdmin();
  return { added, activated, errors };
}
