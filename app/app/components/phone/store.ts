// Settings → phone admin state, shared by the Phone numbers card and the Team
// rows so both show the same lines and a change in one repaints the other.
'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { TalkrError, talkr, type MeDto, type PhoneNumberDto, type TalkrMemberDto } from '@/lib/talkr';
import { assignmentBlock } from '@/lib/talkr-assign';
import { invokeFn } from './ui';

export type PhoneAdmin = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  message: string | null;
  me: MeDto | null;
  numbers: PhoneNumberDto[];
  members: TalkrMemberDto[];
};

let state: PhoneAdmin = { status: 'idle', message: null, me: null, numbers: [], members: [] };
const listeners = new Set<() => void>();
const set = (next: Partial<PhoneAdmin>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export async function refreshPhoneAdmin(): Promise<void> {
  if (state.status === 'idle') set({ status: 'loading' });
  try {
    const me = await talkr.me();
    const admin = me.role === 'owner' || me.role === 'admin';
    const [n, m] = await Promise.all([
      talkr.numbers(),
      admin ? talkr.teamMembers() : Promise.resolve({ members: [] as TalkrMemberDto[] }),
    ]);
    set({ status: 'ready', message: null, me, numbers: n.numbers, members: m.members });
  } catch (err) {
    set({ status: 'unavailable', message: err instanceof TalkrError || err instanceof Error ? err.message : String(err) });
  }
}

export function usePhoneAdmin(enabled = true): PhoneAdmin {
  const snap = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (enabled && state.status === 'idle') void refreshPhoneAdmin();
  }, [enabled]);
  return snap;
}

/**
 * Put lines on the workspace's 10DLC campaign. Runs after a line is bought,
 * imported or handed to a teammate, so nobody has to remember the 10DLC page.
 * Returns a sentence to append to the toast; never throws, because the line
 * itself is already done and the morning number check tries again.
 */
export async function attachToCampaign(workspaceId: number | null | undefined, phones: string[]): Promise<string> {
  if (!workspaceId || !phones.length) return '';
  const { data, error } = await invokeFn<{ ok?: boolean; waiting?: string; attached?: string[]; already?: string[]; error?: string }>(
    'ten-dlc-register', { action: 'attach', workspace_id: workspaceId, phones },
  );
  if (data?.waiting) return ' It joins the 10DLC campaign as soon as the campaign is approved.';
  if (error || data?.ok === false) return ` It is not on the 10DLC campaign yet (${error ?? data?.error ?? 'refused'}); the morning number check tries again.`;
  if (data?.attached?.length) return ' Added to the 10DLC campaign.';
  if (data?.already?.length) return ' Already on the 10DLC campaign.';
  return '';
}

export const isPhoneAdmin = (me: MeDto | null) => me?.role === 'owner' || me?.role === 'admin';

/**
 * Talkr only assigns a line to an active member. Seats CLOZR just created are
 * `invited` until that person signs in, and the buy then fails with
 * "assigned_user_id is not an active member of this org". An admin can mark
 * the seat active; a disabled seat is left alone.
 */
export async function ensureAssignable(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { members } = await talkr.teamMembers();
  const m = members.find((x) => x.id === userId);
  const block = assignmentBlock(m?.status);
  if (!m || block === 'missing') {
    throw new TalkrError(400, 'not_on_talkr', 'That person is not on the Talkr team yet. Open Settings → Team so CLOZR adds them, then buy the number again.');
  }
  if (block === 'disabled') {
    throw new TalkrError(400, 'disabled', `${m.display_name} is disabled on Talkr, so a line cannot be assigned to them.`);
  }
  if (block === 'activate') {
    try {
      await talkr.updateTeamMember(m.id, { status: 'active' });
    } catch (err) {
      const why = err instanceof Error ? err.message : 'Talkr refused.';
      throw new TalkrError(400, 'not_active', `${m.display_name} is on the team as ${m.status}, and Talkr will not assign a number until the seat is active. Ask them to sign in to CLOZR once, then try again. ${why}`);
    }
    await refreshPhoneAdmin();
  }
  return m.id;
}
