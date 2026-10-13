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
