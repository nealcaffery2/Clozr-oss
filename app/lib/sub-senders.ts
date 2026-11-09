// A Submissions row ('sub:<deal>') is a deal, not a person. Messaging it means
// messaging whoever sent it, once per sender however many deals they sent.

/** Selected row ids → person ids to message, in order, deduped; submissions with no sender on file drop out. */
export function messageTargets(selected: readonly string[], senderOf: (subId: string) => string | null | undefined): { ids: string[]; noSender: number } {
  const ids: string[] = [];
  const seen = new Set<string>();
  let noSender = 0;
  for (const id of selected) {
    const pid = id.startsWith('sub:') ? senderOf(id) : id;
    if (!pid) { noSender++; continue; }
    if (seen.has(pid)) continue;
    seen.add(pid);
    ids.push(pid);
  }
  return { ids, noSender };
}
