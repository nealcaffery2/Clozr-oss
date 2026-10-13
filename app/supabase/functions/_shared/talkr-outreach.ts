// Posts outreach Talkr cannot see (ringless drops, blast email) to Talkr, so
// a callback can ring the rep who reached out. Best effort: every failure is
// returned as words for the caller to note, and nothing here throws.
// Contract, path and shape: lib/talkr-outreach.ts (TALKR_OUTREACH).

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type OutreachItem, batchRejections, outreachErrorNote, outreachRequests } from '../../../lib/talkr-outreach.ts';
import { activeTalkrBinding, gateTalkrWrite, readTalkrOrg, TALKR_NOT_CONNECTED } from './talkr-binding.ts';
import { loadTalkrConnections } from './talkr-connect.ts';

export const TALKR_DEFAULT_URL = 'https://talkr.example.com';
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A five-minute token for this CLOZR user, signed with the secret Talkr holds
 * as PARTNER_JWT_SECRET. The same token dispo-campaign-tick and number-guard mint.
 */
export async function partnerToken(user: { id: string; email: string | null }): Promise<string | null> {
  const secret = Deno.env.get('TALKR_PARTNER_JWT_SECRET');
  if (!secret || !user.email) return null;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({
    iss: `${Deno.env.get('SUPABASE_URL')}/auth/v1`, sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now + 300,
  })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** A per-run token cache keyed by CLOZR user id (reads the profile's email once). */
export function tokenCache(admin: SupabaseClient): (userId: string | null) => Promise<string | null> {
  const tokens = new Map<string, string | null>();
  return async (userId) => {
    if (!userId) return null;
    if (!tokens.has(userId)) {
      const { data: p } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle();
      tokens.set(userId, await partnerToken({ id: userId, email: (p?.email as string | null) ?? null }));
    }
    return tokens.get(userId) ?? null;
  };
}

export type OutreachResult = { ref: string; ok: boolean; note: string | null };

/**
 * Send these items, grouped per rep with that rep's token. Returns one result
 * per item ref; a missing secret, an unlinked rep or a Talkr error is a note,
 * never a throw.
 */
export async function postOutreach(
  admin: SupabaseClient,
  workspaceId: number,
  items: readonly (OutreachItem | null)[],
  tokenFor: (userId: string | null) => Promise<string | null> = tokenCache(admin),
): Promise<OutreachResult[]> {
  const reqs = outreachRequests(items);
  if (!reqs.length) return [];
  let base = TALKR_DEFAULT_URL;
  let settings: unknown = null;
  try {
    const { data: ws } = await admin.from('workspaces').select('settings').eq('id', workspaceId).maybeSingle();
    settings = ws?.settings ?? null;
    base = String((settings as { talkr_url?: string } | null)?.talkr_url || Deno.env.get('TALKR_API_URL') || TALKR_DEFAULT_URL).replace(/\/$/, '');
  } catch { /* default URL */ }
  const binding = activeTalkrBinding({ id: workspaceId, settings }, (await loadTalkrConnections(admin, [workspaceId]))[0] ?? null);
  if (!binding) {
    return reqs.flatMap((r) => r.refs.map((ref) => ({ ref, ok: false, note: TALKR_NOT_CONNECTED })));
  }
  if (!Deno.env.get('TALKR_PARTNER_JWT_SECRET')) {
    return reqs.flatMap((r) => r.refs.map((ref) => ({ ref, ok: false, note: 'Talkr not told (TALKR_PARTNER_JWT_SECRET is not set), so a callback rings by the number\'s own routing.' })));
  }
  const out: OutreachResult[] = [];
  let orgChecked = false;
  let orgOk = false;
  for (const req of reqs) {
    const done = (ok: boolean, note: string | null, refs = req.refs) => { for (const ref of refs) out.push({ ref, ok, note }); };
    try {
      const token = await tokenFor(req.userId);
      if (!token) { done(false, 'Talkr not told: the rep has no email on their profile.'); continue; }
      if (!orgChecked) {
        orgChecked = true;
        const observed = await readTalkrOrg(async (path) => {
          try {
            const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
            return { ok: res.ok, body: await res.json().catch(() => ({})) };
          } catch {
            return { ok: false, body: {} };
          }
        });
        orgOk = gateTalkrWrite({ binding, observedOrgId: observed }).ok;
      }
      if (!orgOk) { done(false, TALKR_NOT_CONNECTED); continue; }
      const res = await fetch(`${base}${req.path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!res.ok) { done(false, outreachErrorNote(res.status, (body?.error ?? body?.code) as string | undefined)); continue; }
      const rejected = Array.isArray(req.body) ? batchRejections(body) : new Map<string, string>();
      for (const ref of req.refs) {
        const why = rejected.get(ref);
        out.push(why ? { ref, ok: false, note: outreachErrorNote(400, why) } : { ref, ok: true, note: null });
      }
    } catch {
      done(false, 'Talkr did not answer, so the outreach was not recorded there.');
    }
  }
  return out;
}
