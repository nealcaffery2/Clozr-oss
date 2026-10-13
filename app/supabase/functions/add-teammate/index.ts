/**
 * POST /add-teammate — an admin adds a person to their workspace, or resends
 * their invite.
 *
 * Why a function and not a client insert: creating an auth user needs the
 * service role. The account is created already confirmed with a one-time
 * password; a CLOZR-branded invite email (Resend) carries that password and a
 * sign-in link. The admin still sees the password once in Settings as a
 * backup. The signup trigger (public.handle_new_user) sees the waiting invite
 * and joins them to this workspace with the intended role rather than minting
 * them a workspace of their own.
 *
 * Authorisation is the caller's own JWT: they must hold owner or admin in the
 * workspace named in the body. The service role is used only after that check.
 *
 * Body:    { workspace_id, email, full_name?, role, resend?, origin?,
 *            notary_state?, notary_expires?, notary_commission_number?, notary_county? }
 *          resend: true → reset password for an existing member and re-mail.
 *          origin: live Clozr browser origin for the invite sign-in link
 *          (preferred over APP_URL; Talkr hosts are rejected).
 * Returns: { ok, user_id, email, temp_password?, existing, emailed, error? }
 *          temp_password is present when a password was minted for them.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient, type User } from 'jsr:@supabase/supabase-js@2';
import { clozrLoginUrl } from '../_shared/app-url.ts';
import { sendTeammateInvite } from '../_shared/invite-send.ts';
import { renderNotaryStamp, stampGaps } from '../_shared/notary-stamp.ts';
import { corsFor, jsonWith, rateLimit, serverError, tooMany } from '../_shared/security.ts';

const ROLES = new Set(['admin', 'acquisitions', 'dispositions', 'tc', 'member', 'notary', 'partnerships']);

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  acquisitions: 'Acquisitions',
  dispositions: 'Dispositions',
  tc: 'Transaction coordinator',
  member: 'Member',
  notary: 'Notary',
  partnerships: 'Partnerships',
};

/** 14 characters, unambiguous alphabet, from the platform CSPRNG. */
function tempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function findUserByEmail(admin: SupabaseClient, email: string): Promise<User | null> {
  // listUsers is paginated; a workspace roster is small, but search across pages
  // so a later teammate is not missed once the project grows past 1,000 users.
  for (let page = 1; page <= 10; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data?.users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (hit) return hit;
    if (!data?.users.length || data.users.length < 200) break;
  }
  return null;
}

async function sendInvite(admin: SupabaseClient, workspaceId: number, opts: {
  email: string;
  fullName: string | null;
  workspaceName: string;
  role: string;
  invitedByName: string | null;
  password: string | null;
  resend: boolean;
  /** Browser origin from the admin who invited; wins over a mis-set APP_URL. */
  origin?: string | null;
}): Promise<boolean> {
  const r = await sendTeammateInvite(admin, workspaceId, {
    toName: opts.fullName,
    email: opts.email,
    workspaceName: opts.workspaceName,
    roleLabel: ROLE_LABEL[opts.role] ?? opts.role,
    invitedByName: opts.invitedByName,
    tempPassword: opts.password,
    // Never Talkr: clozrLoginUrl rejects Talkr hosts and falls back.
    loginUrl: clozrLoginUrl(opts.origin),
    resend: opts.resend,
  });
  return r.emailed;
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = jsonWith(CORS);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'sign in first' }, 401);

  // Who is asking — resolved from their own token, never from the body.
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  if (whoErr || !who.user) return json({ error: 'sign in first' }, 401);

  let body: {
    workspace_id?: number; email?: string; full_name?: string; role?: string; resend?: boolean;
    /** Live Clozr origin from the admin's browser (preferred over APP_URL). */
    origin?: string;
    notary_state?: string; notary_expires?: string; notary_commission_number?: string; notary_county?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  const workspaceId = Number(body.workspace_id);
  const email = (body.email ?? '').trim().toLowerCase();
  const resend = body.resend === true;
  const fullName = (body.full_name ?? '').trim();
  const inviteOrigin = typeof body.origin === 'string' ? body.origin.trim() : '';
  if (!Number.isFinite(workspaceId)) return json({ error: 'workspace_id is required' }, 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'a valid email is required' }, 422);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // Creating / resetting accounts is privileged: a modest per-admin ceiling.
  const rl = await rateLimit(admin, `add-teammate:${who.user.id}`, 20, 3600);
  if (!rl.allowed) return tooMany(CORS, rl);

  const { data: me } = await admin
    .from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', who.user.id).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) {
    return json({ error: 'only an owner or admin can add teammates' }, 403);
  }

  const { data: ws } = await admin.from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
  const workspaceName = (ws?.name as string | undefined)?.trim() || 'your workspace';
  const { data: inviter } = await admin.from('profiles').select('full_name').eq('id', who.user.id).maybeSingle();
  const invitedByName = (inviter?.full_name as string | undefined)?.trim()
    || (who.user.user_metadata?.full_name as string | undefined)?.trim()
    || who.user.email
    || 'Your teammate';

  // ---- resend invite for someone already on the roster --------------------
  if (resend) {
    const existing = await findUserByEmail(admin, email);
    if (!existing) return json({ error: 'no account for that email' }, 404);
    const { data: mem } = await admin.from('workspace_members').select('role')
      .eq('workspace_id', workspaceId).eq('user_id', existing.id).maybeSingle();
    if (!mem) return json({ error: 'that person is not on this workspace' }, 404);
    if (mem.role === 'owner') return json({ error: 'cannot reset the owner this way' }, 422);

    const password = tempPassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, { password });
    if (updErr) return serverError(CORS, 'add-teammate resend updateUser', updErr);

    const role = mem.role as string;
    const name = fullName
      || (existing.user_metadata?.full_name as string | undefined)?.trim()
      || email.split('@')[0];
    await admin.from('workspace_invites').upsert(
      { workspace_id: workspaceId, email, role, full_name: name, invited_by: who.user.id, accepted_at: new Date().toISOString() },
      { onConflict: 'workspace_id,email' },
    );
    const emailed = await sendInvite(admin, workspaceId, {
      email, fullName: name, workspaceName, role, invitedByName, password, resend: true,
      origin: inviteOrigin,
    });
    return json({
      ok: true, user_id: existing.id, email, temp_password: password,
      existing: true, emailed, resend: true,
      ...(emailed ? {} : { warning: 'Account password was reset, but the invite email did not send. Share the password manually.' }),
    });
  }

  // ---- add (or join) ------------------------------------------------------
  const role = (body.role ?? '').trim();
  if (!ROLES.has(role)) return json({ error: `role must be one of ${[...ROLES].join(', ')}` }, 422);

  let notaryPatch: Record<string, string | null> = {};
  if (role === 'notary') {
    const commission = {
      name: fullName || email.split('@')[0],
      state: String(body.notary_state ?? '').trim().toUpperCase(),
      expires: String(body.notary_expires ?? '').slice(0, 10),
      commissionNumber: body.notary_commission_number ?? null,
      county: body.notary_county ?? null,
    };
    const gaps = stampGaps(commission);
    if (gaps.length) return json({ error: `Notary seal needs: ${gaps.join(', ')}` }, 422);
    notaryPatch = {
      notary_state: commission.state,
      notary_commission_expires: commission.expires,
      notary_commission_number: String(commission.commissionNumber ?? '').trim() || null,
      notary_county: String(commission.county ?? '').trim() || null,
      notary_stamp_svg: renderNotaryStamp(commission),
    };
  }

  // Record the invite first: the signup trigger reads it when the auth row is
  // inserted, so it has to exist before createUser.
  const { error: invErr } = await admin.from('workspace_invites').upsert(
    { workspace_id: workspaceId, email, role, full_name: fullName || null, invited_by: who.user.id, accepted_at: null },
    { onConflict: 'workspace_id,email' },
  );
  if (invErr) {
    if (/role_check|workspace_invites_role_check/i.test(invErr.message ?? '')) {
      return json({ error: 'That role is not allowed yet. The notary role migration needs to be applied.' }, 422);
    }
    return serverError(CORS, 'add-teammate invite upsert', invErr);
  }

  const existing = await findUserByEmail(admin, email);
  if (existing) {
    const { error: memErr } = await admin.from('workspace_members').upsert(
      { workspace_id: workspaceId, user_id: existing.id, role, ...notaryPatch },
      { onConflict: 'workspace_id,user_id' },
    );
    if (memErr) {
      if (/role_check|workspace_members_role_check/i.test(memErr.message ?? '')) {
        return json({ error: 'That role is not allowed yet. The notary role migration needs to be applied.' }, 422);
      }
      return serverError(CORS, 'add-teammate membership upsert', memErr);
    }
    await admin.from('workspace_invites').update({ accepted_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId).eq('email', email);

    // Never signed in → mint a password and email it so they can get in.
    // Already signed in → email them that they were added; keep their password.
    const neverSignedIn = !existing.last_sign_in_at;
    let password: string | null = null;
    if (neverSignedIn) {
      password = tempPassword();
      const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, { password });
      if (updErr) return serverError(CORS, 'add-teammate existing updateUser', updErr);
    }
    const name = fullName
      || (existing.user_metadata?.full_name as string | undefined)?.trim()
      || email.split('@')[0];
    const emailed = await sendInvite(admin, workspaceId, {
      email, fullName: name, workspaceName, role, invitedByName, password, resend: false,
      origin: inviteOrigin,
    });
    return json({
      ok: true, user_id: existing.id, email, existing: true, emailed,
      ...(password ? { temp_password: password } : {}),
      ...(emailed ? {} : { warning: 'Added to the workspace, but the invite email did not send.' }),
    });
  }

  const password = tempPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName || email.split('@')[0] },
  });
  if (createErr || !created.user) return serverError(CORS, 'add-teammate createUser', createErr ?? 'no user returned');

  // Belt and braces: the trigger should have joined them via the invite. If a
  // trigger edit ever regresses that, the membership is still written here.
  await admin.from('workspace_members').upsert(
    { workspace_id: workspaceId, user_id: created.user.id, role, ...notaryPatch },
    { onConflict: 'workspace_id,user_id' },
  );
  await admin.from('workspace_invites').update({ accepted_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('email', email);

  const emailed = await sendInvite(admin, workspaceId, {
    email,
    fullName: fullName || email.split('@')[0],
    workspaceName,
    role,
    invitedByName,
    password,
    resend: false,
    origin: inviteOrigin,
  });

  return json({
    ok: true, user_id: created.user.id, email, temp_password: password,
    existing: false, emailed,
    ...(emailed ? {} : { warning: 'Account created, but the invite email did not send. Share the password manually.' }),
  });
});
