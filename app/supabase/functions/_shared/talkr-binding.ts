/**
 * Which Clozr workspace may receive a Talkr org's calls, texts and numbers.
 *
 * Talkr scopes /v1/history, /v1/team and /v1/numbers to the org of the user
 * on the partner token, not to a Clozr workspace. A cron that walked every
 * workspace of that owner copied the org into each one. talkr_connections is
 * the binding: one Talkr org, one workspace. This module decides; it does not
 * talk to Postgres or mint tokens.
 */

export const TALKR_NOT_CONNECTED = 'Talkr not connected to this workspace';

/** settings.talkr_url set to this origin is the manual pause (workspace 13). */
export const TALKR_DISABLED_URL = 'https://talkr-disabled.invalid';

export type TalkrConnection = {
  workspace_id: number;
  talkr_org_id: string;
  enabled: boolean;
};

export type WorkspaceTalkrInput = {
  id: number;
  owner_id?: string | null;
  settings?: unknown;
};

export type TalkrBinding = { orgId: string };

export type TalkrGate =
  | { ok: true; orgId: string }
  | { ok: false; error: typeof TALKR_NOT_CONNECTED };

export type TalkrEffect = 'communications' | 'number_health' | 'caller_lines' | 'notifications' | 'talkr_patch';

const EFFECT_KINDS: TalkrEffect[] = ['communications', 'number_health', 'caller_lines', 'notifications', 'talkr_patch'];

const BARE_SCOPE = new Set(['org', 'user', 'team', 'mine', 'organization']);

function settingsOf(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
}

/** The disabled-origin pause. Trailing slash and surrounding space do not defeat it. */
export function talkrUrlDisabled(settings: unknown): boolean {
  const url = String(settingsOf(settings).talkr_url ?? '').trim().replace(/\/+$/, '');
  return url === TALKR_DISABLED_URL;
}

/**
 * settings.talkr.enabled === false, or the disabled origin, pauses Talkr for
 * this workspace. A missing talkr object is not a pause.
 */
export function talkrFlagEnabled(settings: unknown): boolean {
  if (talkrUrlDisabled(settings)) return false;
  const talkr = settingsOf(settings).talkr;
  if (talkr && typeof talkr === 'object' && (talkr as { enabled?: unknown }).enabled === false) return false;
  return true;
}

/** The binding the cron and the writers may act on, or null. */
export function activeTalkrBinding(ws: WorkspaceTalkrInput, connection: TalkrConnection | null | undefined): TalkrBinding | null {
  if (!connection) return null;
  if (connection.workspace_id !== ws.id) return null;
  if (connection.enabled === false) return null;
  if (!talkrFlagEnabled(ws.settings)) return null;
  const orgId = String(connection.talkr_org_id ?? '').trim();
  if (!orgId) return null;
  return { orgId };
}

export function workspacesForTalkrCron<T extends WorkspaceTalkrInput>(workspaces: readonly T[], connections: readonly TalkrConnection[]): T[] {
  const byWs = new Map(connections.map((c) => [c.workspace_id, c]));
  return workspaces.filter((ws) => activeTalkrBinding(ws, byWs.get(ws.id) ?? null) !== null);
}

function idString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || BARE_SCOPE.has(s.toLowerCase())) return null;
  return s;
}

function idFrom(value: unknown): string | null {
  const direct = idString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  return idString(o.id) ?? idString(o.org_id) ?? idString(o.organization_id);
}

/**
 * Org id from a Talkr JSON body: history `scope`, or /v1/team.
 * A scope that is only the word "org" (or user/team/mine) is not an id.
 */
export function talkrOrgFromPayload(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const scope = b.scope;
  if (typeof scope === 'string') {
    const id = idString(scope);
    if (id) return id;
  } else if (scope && typeof scope === 'object') {
    const s = scope as Record<string, unknown>;
    const id = idString(s.org_id) ?? idString(s.organization_id) ?? idFrom(s.org) ?? idFrom(s.organization);
    if (id) return id;
  }
  return idString(b.org_id) ?? idString(b.organization_id) ?? idFrom(b.org) ?? idFrom(b.organization);
}

export function orgMatchesBinding(boundOrgId: string, observedOrgId: string | null | undefined): boolean {
  const bound = boundOrgId.trim();
  const observed = String(observedOrgId ?? '').trim();
  return bound.length > 0 && observed.length > 0 && bound === observed;
}

/** No binding, or a token whose org is not the bound one: do not write. */
export function gateTalkrWrite(input: { binding: TalkrBinding | null; observedOrgId: string | null | undefined }): TalkrGate {
  if (!input.binding || !orgMatchesBinding(input.binding.orgId, input.observedOrgId)) {
    return { ok: false, error: TALKR_NOT_CONNECTED };
  }
  return { ok: true, orgId: input.binding.orgId.trim() };
}

export function talkrMutationsAllowed(gate: TalkrGate): boolean {
  return gate.ok;
}

export type OrgClaim = { workspaceId: number; orgId: string };

/** A Talkr org may be claimed by one workspace. */
export function claimTalkrOrg(existing: readonly OrgClaim[], claim: OrgClaim): { ok: true } | { ok: false; error: string } {
  const orgId = claim.orgId.trim();
  if (!orgId) return { ok: false, error: 'Talkr org id is required' };
  const taken = existing.find((row) => row.orgId.trim() === orgId && row.workspaceId !== claim.workspaceId);
  if (taken) return { ok: false, error: `Talkr org ${orgId} is already bound to workspace ${taken.workspaceId}` };
  return { ok: true };
}

/**
 * The org the token is in. Talkr's GET /v1/me carries it (`org: { id, name,
 * slug }`); /v1/team (members only) and /v1/history (`scope: "org"`) do not,
 * so reading only those two found no org and every gated job refused with
 * "not connected" (number guard, call sync, campaign texts). /v1/team and a
 * one-row history stay as fallbacks for a Talkr that adds an id there.
 */
export async function readTalkrOrg(get: (path: string) => Promise<{ ok: boolean; body: unknown }>): Promise<string | null> {
  const me = await get('/v1/me');
  const fromMe = me.ok ? talkrOrgFromPayload(me.body) : null;
  if (fromMe) return fromMe;
  const team = await get('/v1/team');
  const fromTeam = team.ok ? talkrOrgFromPayload(team.body) : null;
  if (fromTeam) return fromTeam;
  const hist = await get('/v1/history?type=calls&limit=1');
  return hist.ok ? talkrOrgFromPayload(hist.body) : null;
}

export type TalkrCronPlan = {
  /** Workspaces the tick may call Talkr for. */
  selected: number[];
  effects: { workspaceId: number; kind: TalkrEffect }[];
  /**
   * Explicit workspace_id that is unbound, paused, or whose token org does
   * not match. `record` is true so the caller stores last_error. A cron tick
   * (onlyWorkspace null) does not list unbound workspaces here.
   */
  skipped: { workspaceId: number; error: typeof TALKR_NOT_CONNECTED; record: boolean }[];
};

/**
 * The cron's selection. `tokenOrgByWorkspace` is what that workspace's Talkr
 * token actually sees. Effects are the writes and Talkr PATCHes allowed.
 */
export function planTalkrCron(input: {
  workspaces: readonly WorkspaceTalkrInput[];
  connections: readonly TalkrConnection[];
  tokenOrgByWorkspace: Readonly<Record<number, string | null | undefined>>;
  onlyWorkspace?: number | null;
}): TalkrCronPlan {
  const only = input.onlyWorkspace ?? null;
  const pool = only == null ? input.workspaces : input.workspaces.filter((ws) => ws.id === only);
  const byWs = new Map(input.connections.map((c) => [c.workspace_id, c]));
  const selected: number[] = [];
  const effects: TalkrCronPlan['effects'] = [];
  const skipped: TalkrCronPlan['skipped'] = [];

  for (const ws of pool) {
    const binding = activeTalkrBinding(ws, byWs.get(ws.id) ?? null);
    if (!binding) {
      if (only != null) skipped.push({ workspaceId: ws.id, error: TALKR_NOT_CONNECTED, record: true });
      continue;
    }
    const gate = gateTalkrWrite({ binding, observedOrgId: input.tokenOrgByWorkspace[ws.id] ?? null });
    if (!gate.ok) {
      skipped.push({ workspaceId: ws.id, error: TALKR_NOT_CONNECTED, record: true });
      continue;
    }
    selected.push(ws.id);
    for (const kind of EFFECT_KINDS) effects.push({ workspaceId: ws.id, kind });
  }
  return { selected, effects, skipped };
}
