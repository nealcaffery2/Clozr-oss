import { useCallback, useMemo } from 'react';
import { useTeam } from '@/app/components/inbox/gmail/mail-extras';

type TalkrMember = { id: string; display_name: string; email?: string | null };

/**
 * Each teammate's name and photo by their Talkr user id, matched on the
 * sign-in address, so a text thread can say who sent each text
 * (MessagesScreen `senders`). The roster is small; one read per workspace.
 */
export function useSenders(workspaceId: number | null, enabled: boolean, members: readonly object[] | null | undefined) {
  const roster = useTeam(workspaceId, enabled);
  const faces = useMemo(() => {
    const byEmail = new Map(roster.filter((t) => t.email).map((t) => [t.email!.trim().toLowerCase(), t]));
    const m = new Map<string, { name: string; avatar: string | null }>();
    for (const t of (members ?? []) as TalkrMember[]) {
      const mate = t.email ? byEmail.get(t.email.trim().toLowerCase()) : undefined;
      m.set(t.id, { name: mate?.full_name || t.display_name || 'Teammate', avatar: mate?.avatar_url ?? null });
    }
    return m;
  }, [roster, members]);
  return useCallback((id: string) => faces.get(id) ?? null, [faces]);
}
