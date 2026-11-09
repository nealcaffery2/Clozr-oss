/**
 * Google sync writes follow the connected account, not the person.
 *
 * google_accounts.workspace_id is the workspace that connection belongs to.
 * Two accounts for one user in two workspaces stay on their own workspace.
 */

export function googleSyncWorkspace(account: { workspace_id: number }): number {
  return account.workspace_id;
}

export type GoogleSyncWrite = { accountId: number; workspaceId: number };

export function planGoogleSyncWrites(
  accounts: readonly { id: number; user_id?: string | null; workspace_id: number }[],
): GoogleSyncWrite[] {
  return accounts.map((account) => ({ accountId: account.id, workspaceId: googleSyncWorkspace(account) }));
}

/** Every planned write lands on that account's workspace_id. */
export function googleWritesStayOnAccount(
  accounts: readonly { id: number; workspace_id: number }[],
  writes: readonly GoogleSyncWrite[],
): boolean {
  const workspaceOf = new Map(accounts.map((account) => [account.id, account.workspace_id]));
  return writes.every((write) => workspaceOf.get(write.accountId) === write.workspaceId);
}

/** The scopes a connect asks Google for. Same strings as SCOPE in google.ts, kept here so this stays pure. */
export const CONNECT_SCOPE = {
  id: ['openid', 'email', 'profile'],
  calendar: 'https://www.googleapis.com/auth/calendar',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
} as const;

/**
 * What one connect asks for (migration 441).
 *   own           the member's mailbox: who they are, Gmail send and read,
 *                 and the calendar unless calendar is false ("Gmail only").
 *   shared        a mailbox linked for the workspace (deals@): read only, it
 *                 never sends; the calendar only when asked.
 *   add_calendar  the calendar alone; Google's include_granted_scopes keeps
 *                 the Gmail grant, so nothing is asked twice.
 */
export function connectScopes(kind: 'own' | 'shared' | 'add_calendar', o: { calendar?: boolean; read?: boolean } = {}): string[] {
  const S = CONNECT_SCOPE;
  if (kind === 'add_calendar') return [...S.id, S.calendar];
  const calendar = o.calendar !== false;
  if (kind === 'shared') return [...S.id, S.gmailRead, ...(calendar ? [S.calendar] : [])];
  return [...S.id, ...(calendar ? [S.calendar] : []), S.gmailSend, ...(o.read !== false ? [S.gmailRead] : [])];
}
