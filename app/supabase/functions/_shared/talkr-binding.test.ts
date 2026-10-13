// Talkr is bound to one workspace, and Google sync stays on the account's workspace.
// Run: npx tsx supabase/functions/_shared/talkr-binding.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TALKR_DISABLED_URL,
  TALKR_NOT_CONNECTED,
  activeTalkrBinding,
  claimTalkrOrg,
  gateTalkrWrite,
  planTalkrCron,
  readTalkrOrg,
  talkrFlagEnabled,
  talkrOrgFromPayload,
  talkrUrlDisabled,
  workspacesForTalkrCron,
  type TalkrConnection,
  type TalkrEffect,
  type WorkspaceTalkrInput,
} from './talkr-binding.ts';
import { googleSyncWorkspace, googleWritesStayOnAccount, planGoogleSyncWrites } from './google-scope.ts';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};
const ok = (label: string, pass: boolean) => eq(label, pass, true);

const HOME_ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER = '22222222-2222-4222-8222-222222222222';

const ws11: WorkspaceTalkrInput = { id: 11, owner_id: OWNER, settings: {} };
const ws13: WorkspaceTalkrInput = {
  id: 13,
  owner_id: OWNER,
  settings: { talkr_url: TALKR_DISABLED_URL, number_guard: { enabled: false } },
};
const ws14: WorkspaceTalkrInput = { id: 14, owner_id: OWNER, settings: {} };
const bound11: TalkrConnection = { workspace_id: 11, talkr_org_id: HOME_ORG, enabled: true };
const KINDS: TalkrEffect[] = ['communications', 'number_health', 'caller_lines', 'notifications', 'talkr_patch'];

const count = (effects: { workspaceId: number; kind: TalkrEffect }[], ws: number, kind: TalkrEffect) =>
  effects.filter((e) => e.workspaceId === ws && e.kind === kind).length;

const cron = planTalkrCron({
  workspaces: [ws11, ws13, ws14],
  connections: [bound11],
  tokenOrgByWorkspace: { 11: HOME_ORG, 13: HOME_ORG, 14: HOME_ORG },
  onlyWorkspace: null,
});
eq('cron selects only the bound workspace', cron.selected, [11]);
eq('cron does not record a skip for unbound workspaces', cron.skipped, []);
for (const kind of KINDS) {
  eq(`cron writes ${kind} only on workspace 11`, [count(cron.effects, 11, kind), count(cron.effects, 13, kind), count(cron.effects, 14, kind)], [1, 0, 0]);
}
ok('same owner, unbound workspace gets zero writes and no Talkr PATCH', KINDS.every((kind) => count(cron.effects, 13, kind) === 0));

const explicit13 = planTalkrCron({
  workspaces: [ws11, ws13],
  connections: [bound11],
  tokenOrgByWorkspace: { 13: HOME_ORG },
  onlyWorkspace: 13,
});
eq('explicit unbound workspace is skipped and recorded', explicit13.skipped, [{ workspaceId: 13, error: TALKR_NOT_CONNECTED, record: true }]);
eq('explicit unbound workspace has no effects', explicit13.effects, []);

const mismatch = planTalkrCron({
  workspaces: [ws11],
  connections: [bound11],
  tokenOrgByWorkspace: { 11: OTHER_ORG },
});
eq('token org that is not the binding is skipped', mismatch.skipped, [{ workspaceId: 11, error: TALKR_NOT_CONNECTED, record: true }]);
eq('org mismatch writes nothing', mismatch.effects, []);
eq('missing observed org is a skip', gateTalkrWrite({ binding: { orgId: HOME_ORG }, observedOrgId: null }), { ok: false, error: TALKR_NOT_CONNECTED });
eq('matching org is allowed', gateTalkrWrite({ binding: { orgId: HOME_ORG }, observedOrgId: HOME_ORG }), { ok: true, orgId: HOME_ORG });

eq('a second workspace cannot bind the same Talkr org', claimTalkrOrg(
  [{ workspaceId: 11, orgId: HOME_ORG }],
  { workspaceId: 13, orgId: HOME_ORG },
).ok, false);
ok('the same workspace may keep its org', claimTalkrOrg([{ workspaceId: 11, orgId: HOME_ORG }], { workspaceId: 11, orgId: HOME_ORG }).ok);
eq('workspacesForTalkrCron drops the unbound twin', workspacesForTalkrCron([ws11, ws13, ws14], [bound11]).map((w) => w.id), [11]);

const paused = { ...bound11 };
eq('settings.talkr.enabled false drops a connected workspace', activeTalkrBinding(
  { id: 11, settings: { talkr: { enabled: false, org_id: HOME_ORG } } },
  paused,
), null);
eq('the disabled Talkr origin still pauses', activeTalkrBinding(
  { id: 11, settings: { talkr_url: TALKR_DISABLED_URL + '/' } },
  bound11,
), null);
eq('talkr.enabled false is the flag', talkrFlagEnabled({ talkr: { enabled: false } }), false);
eq('a missing talkr object is not a pause', talkrFlagEnabled({}), true);
eq('url sentinel', talkrUrlDisabled({ talkr_url: 'https://talkr-disabled.invalid' }), true);
eq('connection.enabled false is inactive', activeTalkrBinding(ws11, { ...bound11, enabled: false }), null);

eq('scope.org_id', talkrOrgFromPayload({ scope: { org_id: HOME_ORG } }), HOME_ORG);
eq('scope.organization.id', talkrOrgFromPayload({ scope: { organization: { id: HOME_ORG } } }), HOME_ORG);
eq('scope string id', talkrOrgFromPayload({ scope: HOME_ORG }), HOME_ORG);
eq('bare scope word is not an id', talkrOrgFromPayload({ scope: 'org' }), null);
eq('top-level org.id', talkrOrgFromPayload({ org: { id: HOME_ORG, name: 'Acme Homes' } }), HOME_ORG);

// Talkr's real replies: /v1/me names the org; /v1/team lists members only;
// /v1/history says scope "org". Reading only team and history found no org.
const realTalkr = async (path: string) => {
  if (path === '/v1/me') return { ok: true, body: { id: 'u1', email: 'sam@yourcompany.com', org: { id: HOME_ORG, name: 'Acme Homes', slug: 'compr' } } };
  if (path === '/v1/team') return { ok: true, body: { members: [{ id: 'u1', display_name: 'Sam', role: 'owner' }] } };
  return { ok: true, body: { items: [], scope: 'org' } };
};
eq('the org comes from /v1/me', await readTalkrOrg(realTalkr), HOME_ORG);
eq('a members-only team reply has no org', talkrOrgFromPayload((await realTalkr('/v1/team')).body), null);
eq('the bound org passes the gate', gateTalkrWrite({ binding: { orgId: HOME_ORG }, observedOrgId: await readTalkrOrg(realTalkr) }).ok, true);

const fetched: string[] = [];
const seen = await readTalkrOrg(async (path) => {
  fetched.push(path);
  if (path === '/v1/me') return { ok: false, body: {} };
  if (path === '/v1/team') return { ok: true, body: { org_id: HOME_ORG } };
  return { ok: true, body: { scope: { org_id: OTHER_ORG } } };
});
eq('team org wins before history when /v1/me fails', seen, HOME_ORG);
eq('/v1/me is requested first', fetched[0], '/v1/me');

const accounts = [
  { id: 1, user_id: OWNER, workspace_id: 11 },
  { id: 2, user_id: OWNER, workspace_id: 13 },
];
const writes = planGoogleSyncWrites(accounts);
eq('google sync stamps each account workspace', writes, [
  { accountId: 1, workspaceId: 11 },
  { accountId: 2, workspaceId: 13 },
]);
ok('google writes stay on account.workspace_id', googleWritesStayOnAccount(accounts, writes));
eq('a crossed google write is rejected', googleWritesStayOnAccount(accounts, [{ accountId: 2, workspaceId: 11 }]), false);
eq('helper returns the account workspace', googleSyncWorkspace(accounts[1]), 13);

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../migrations/172_talkr_workspace_binding.sql'), 'utf8');
ok('migration unique on talkr_org_id', /unique \(talkr_org_id\)/.test(migration));
ok('migration binds no workspace of its own', !/insert into public\.talkr_connections/i.test(migration));
ok('migration pauses with talkr.enabled false', migration.includes("'enabled', false"));
ok('migration keeps the disabled origin check', migration.includes(TALKR_DISABLED_URL));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
