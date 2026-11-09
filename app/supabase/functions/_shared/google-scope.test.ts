// Google sync never leaves google_accounts.workspace_id. Run: npx tsx supabase/functions/_shared/google-scope.test.ts
import { connectScopes, googleSyncWorkspace, googleWritesStayOnAccount, planGoogleSyncWrites } from './google-scope.ts';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const owner = '22222222-2222-4222-8222-222222222222';
const accounts = [
  { id: 7, user_id: owner, workspace_id: 11 },
  { id: 8, user_id: owner, workspace_id: 13 },
];
const writes = planGoogleSyncWrites(accounts);
eq('one target per account, on that account workspace', writes, [
  { accountId: 7, workspaceId: 11 },
  { accountId: 8, workspaceId: 13 },
]);
eq('writes stay inside account.workspace_id', googleWritesStayOnAccount(accounts, writes), true);
eq('a write into the other workspace of the same user fails the check', googleWritesStayOnAccount(accounts, [{ accountId: 7, workspaceId: 13 }]), false);
eq('workspace id is the account column', googleSyncWorkspace({ workspace_id: 13 }), 13);

// Connect scopes (migration 441): Gmail only never asks for the calendar.
const CAL = 'https://www.googleapis.com/auth/calendar';
eq('own default asks for everything it did before', connectScopes('own'), ['openid', 'email', 'profile', CAL, 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']);
eq('own Gmail only: no calendar scope', connectScopes('own', { calendar: false }), ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']);
eq('shared Gmail only: read, never send, no calendar', connectScopes('shared', { calendar: false }), ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly']);
eq('shared with calendar', connectScopes('shared'), ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly', CAL]);
eq('add calendar later asks for that one scope', connectScopes('add_calendar'), ['openid', 'email', 'profile', CAL]);
eq('no Gmail-only plan contains any calendar scope', [connectScopes('own', { calendar: false }), connectScopes('shared', { calendar: false })].flat().some((x) => x.includes('calendar')), false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
