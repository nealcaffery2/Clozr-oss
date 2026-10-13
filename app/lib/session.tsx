// Who is signed in, which workspace they are in, and how to change either.
//
// Auth used to live inside the "Live database" screen, which meant the rest of
// the app had no idea a user existed. It lives here now so the shell, the
// route guard, Account and Settings all read the same session.
//
// Demo mode: when Supabase is not configured (no env vars), `supabase` is null
// and the whole app still runs against the mock entity graph. That is
// deliberate — a missing key should degrade the app to the prototype it was,
// not blank the screen. `demo` says which mode you are in so the UI can be
// honest about it rather than pretending a save persisted.
//
// Two-factor: Supabase MFA (TOTP). A session that signs in with a password is
// "aal1"; when the account has a verified authenticator, Supabase reports the
// next level as "aal2" and the app owes a code before it opens (the login page
// asks, the /app guard enforces). Enrolment and removal live on Account.
'use client';

import type { Session, User } from '@supabase/supabase-js';
import { DEMO_ROLE, type Role } from './team';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  browserWorkspaceStore,
  commitWorkspaceSwitch,
  membershipsFromRows,
  noteActiveWorkspace,
  pickActiveWorkspace,
  readSavedWorkspaceId,
  writeSavedWorkspaceId,
  type MembershipRow,
} from './active-workspace';
import { supabase } from './supabase';
import { setSenderRole } from './thread-line';
import { installWorkspaceResets } from './workspace-resets';

export type Profile = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  title: string | null;
  /** Real estate license number, printed in the agent block of TREC forms ({{rep.acq_license}}, migration 179). */
  license_number?: string | null;
};

export type Workspace = { id: number; name: string; owner_id: string; role: string };

type AuthResult = { ok: boolean; message?: string };

/** Extra sign-in options: a captcha token when the project requires one. */
export type AuthOpts = { captchaToken?: string };

export type MfaFactor = { id: string; friendly_name: string | null; status: 'verified' | 'unverified'; created_at: string };

export type MfaLevel = {
  current: string | null;
  next: string | null;
  /** True when a verified factor exists and this session has not passed it yet. */
  stepUp: boolean;
  /** The factor to challenge when stepUp is true. */
  factorId: string | null;
};

export type MfaApi = {
  factors: () => Promise<MfaFactor[]>;
  level: () => Promise<MfaLevel>;
  enroll: (friendlyName: string) => Promise<{ ok: boolean; message?: string; id?: string; qr?: string; secret?: string }>;
  /** Challenge and verify in one step; also completes enrolment of a new factor. */
  verify: (factorId: string, code: string) => Promise<AuthResult>;
  unenroll: (factorId: string) => Promise<AuthResult>;
};

type SessionValue = {
  /** True when Supabase has no credentials: the app runs on mock data. */
  demo: boolean;
  /** False until the first session lookup settles, so guards don't flash. */
  ready: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** The workspace on screen. Null until memberships load, or when there are none. */
  workspace: Workspace | null;
  /** Every workspace this user belongs to, oldest (lowest id) first. */
  workspaces: Workspace[];
  /**
   * Where the membership read is: 'loading' until it answers, 'ready' with a
   * workspace on screen, 'none' when this user belongs to no workspace (never
   * invited, or removed), 'failed' when the read itself failed. The app shows
   * a screen for the last two instead of waiting forever.
   */
  memberships: 'loading' | 'ready' | 'none' | 'failed';
  /** Read the memberships again (the no-workspace screen's Retry). */
  retryMemberships: () => void;
  /** Make `id` the workspace on screen. No-op when it is not one of theirs. */
  switchWorkspace: (id: number) => void;
  signIn: (email: string, password: string, opts?: AuthOpts) => Promise<AuthResult>;
  signUp: (email: string, password: string, fullName: string, opts?: AuthOpts) => Promise<AuthResult>;
  sendMagicLink: (email: string, opts?: AuthOpts) => Promise<AuthResult>;
  sendReset: (email: string, opts?: AuthOpts) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<AuthResult>;
  updateWorkspace: (name: string) => Promise<AuthResult>;
  changePassword: (password: string) => Promise<AuthResult>;
  mfa: MfaApi;
};

const Ctx = createContext<SessionValue | null>(null);

/** Where magic links and password resets come back to. Never Talkr. */
function siteUrl() {
  const fromWindow = typeof window !== 'undefined' ? window.location.origin : '';
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  for (const raw of [fromWindow, fromEnv]) {
    const s = raw.trim().replace(/\/$/, '');
    if (!s) continue;
    try {
      const host = new URL(s).hostname.toLowerCase();
      if (host === 'talkr.example.com' || host.endsWith('.talkr.example.com')) continue;
      if (host.includes('talkr-platform') || /(^|\.)talkr.*\.vercel\.app$/i.test(host)) continue;
      return s;
    } catch { /* try next */ }
  }
  return '';
}

/** Supabase errors are objects; surface the message and nothing else. */
function fail(error: { message: string } | null): AuthResult {
  return error ? { ok: false, message: error.message } : { ok: true };
}

const NOT_CONFIGURED: AuthResult = { ok: false, message: 'Supabase is not configured.' };

type Loaded = {
  uid: string | null;
  profile: Profile | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  /** The membership read failed (network, RLS), as opposed to answering with none. */
  failed?: boolean;
};

const EMPTY_LOADED: Loaded = { uid: null, profile: null, workspaces: [], workspace: null };
const NO_WORKSPACES: Workspace[] = [];

export function SessionProvider({ children }: { children: React.ReactNode }) {
  installWorkspaceResets();
  const demo = !supabase;
  const [ready, setReady] = useState(demo);
  const [session, setSession] = useState<Session | null>(null);
  // Keyed by the user they were loaded for, so switching accounts (or signing
  // out) reads as null immediately rather than needing an effect to clear it —
  // clearing synchronously inside an effect is exactly what React warns about.
  const [loaded, setLoaded] = useState<Loaded>(EMPTY_LOADED);

  // One subscription for the life of the app. onAuthStateChange also fires for
  // token refreshes and for the redirect back from a magic link.
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'PASSWORD_RECOVERY') {
        try { sessionStorage.setItem('clozr.recovery', '1'); } catch { /* private mode */ }
      }
      setSession(next);
      setReady(true);
    });
    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const uid = session?.user.id ?? null;
  const mine = loaded.uid === uid ? loaded : null;
  const profile = mine?.profile ?? null;
  const workspace = mine?.workspace ?? null;
  const workspaces = mine?.workspaces ?? NO_WORKSPACES;
  const memberships: SessionValue['memberships'] = !uid ? 'loading' : !mine ? 'loading' : mine.failed ? 'failed' : mine.workspace ? 'ready' : 'none';
  const [membershipTry, setMembershipTry] = useState(0);
  const retryMemberships = useCallback(() => {
    // Back to "not loaded" for this user, so the screen shows the wait again.
    setLoaded(EMPTY_LOADED);
    setMembershipTry((n) => n + 1);
  }, []);
  // Before children render, so a cache a switch just cleared reloads this id.
  noteActiveWorkspace(workspace?.id ?? null);

  // Profile and every membership follow the user. The active workspace is the
  // one this browser saved, when they still belong to it, otherwise the oldest
  // (lowest id). A failed read leaves them empty and the UI falls back to the
  // auth email.
  useEffect(() => {
    if (!supabase || !uid) return;
    let live = true;
    void (async () => {
      const [p, m] = await Promise.all([
        supabase!.from('profiles').select('id, full_name, avatar_url, phone, title, license_number' as 'id, full_name, avatar_url, phone, title').eq('id', uid).maybeSingle(),
        supabase!.from('workspace_members').select('role, workspaces(id, name, owner_id)').eq('user_id', uid).order('workspace_id', { ascending: true }),
      ]);
      if (!live) return;
      if (m.error) {
        setLoaded({ uid, profile: (p.data as Profile) ?? null, workspaces: [], workspace: null, failed: true });
        return;
      }
      const memberships = membershipsFromRows(m.data as unknown as MembershipRow[] | null);
      const store = browserWorkspaceStore();
      const saved = readSavedWorkspaceId(store);
      const active = pickActiveWorkspace(memberships, saved);
      // A stale saved id is replaced so the next load does not have to guess again.
      if (active && saved !== active.id) writeSavedWorkspaceId(store, active.id);
      setSenderRole(active?.role);
      setLoaded({
        uid,
        profile: (p.data as Profile) ?? null,
        workspaces: memberships,
        workspace: active,
      });
    })();
    return () => {
      live = false;
    };
  }, [uid, membershipTry]);

  const signIn = useCallback(async (email: string, password: string, opts?: AuthOpts) => {
    if (!supabase) return NOT_CONFIGURED;
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: opts?.captchaToken ? { captchaToken: opts.captchaToken } : undefined,
    });
    return fail(error);
  }, []);

  const signUp = useCallback(async (email: string, password: string, fullName: string, opts?: AuthOpts) => {
    if (!supabase) return NOT_CONFIGURED;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${siteUrl()}/auth/callback`,
        ...(opts?.captchaToken ? { captchaToken: opts.captchaToken } : {}),
      },
    });
    if (error) return fail(error);
    // With email confirmation on, there is a user but no session yet.
    if (!data.session) return { ok: true, message: 'Check your email to confirm your account.' };
    return { ok: true };
  }, []);

  const sendMagicLink = useCallback(async (email: string, opts?: AuthOpts) => {
    if (!supabase) return NOT_CONFIGURED;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${siteUrl()}/auth/callback`,
        ...(opts?.captchaToken ? { captchaToken: opts.captchaToken } : {}),
      },
    });
    if (error) return fail(error);
    return { ok: true, message: 'Magic link sent — check your email.' };
  }, []);

  const sendReset = useCallback(async (email: string, opts?: AuthOpts) => {
    if (!supabase) return NOT_CONFIGURED;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl()}/auth/callback`,
      ...(opts?.captchaToken ? { captchaToken: opts.captchaToken } : {}),
    });
    if (error) return fail(error);
    try { sessionStorage.setItem('clozr.recovery', '1'); } catch { /* private mode */ }
    return { ok: true, message: 'Reset link sent — check your email. It opens a page to choose a new password.' };
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
  }, []);

  const updateProfile = useCallback(
    async (patch: Partial<Profile>) => {
      if (!supabase || !uid) return { ok: false, message: 'Not signed in.' };
      // `id` is not a patchable column; the table type rejects it outright.
      const cols = { full_name: patch.full_name, avatar_url: patch.avatar_url, phone: patch.phone, title: patch.title, license_number: patch.license_number };
      // license_number is migration 179; the generated table type predates it.
      const { error } = await supabase.from('profiles').update(cols as never).eq('id', uid);
      if (error) return fail(error);
      setLoaded((l) => (l.profile ? { ...l, profile: { ...l.profile, ...patch } } : l));
      return { ok: true };
    },
    [uid],
  );

  const updateWorkspace = useCallback(
    async (name: string) => {
      if (!supabase || !workspace) return { ok: false, message: 'No workspace.' };
      const { error } = await supabase.from('workspaces').update({ name }).eq('id', workspace.id);
      if (error) return fail(error);
      setLoaded((l) => (l.workspace ? {
        ...l,
        workspace: { ...l.workspace, name },
        workspaces: l.workspaces.map((w) => (w.id === l.workspace!.id ? { ...w, name } : w)),
      } : l));
      return { ok: true };
    },
    [workspace],
  );

  const switchWorkspace = useCallback((id: number) => {
    if (!uid || loaded.uid !== uid) return;
    if (loaded.workspace?.id === id) return;
    const next = commitWorkspaceSwitch(loaded.workspaces, id, browserWorkspaceStore());
    if (!next) return;
    noteActiveWorkspace(next.id);
    setSenderRole(next.role);
    setLoaded((l) => (l.uid === uid ? { ...l, workspace: next } : l));
  }, [uid, loaded]);

  const changePassword = useCallback(async (password: string) => {
    if (!supabase) return NOT_CONFIGURED;
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return fail(error);
    return { ok: true, message: 'Password updated.' };
  }, []);

  // ── Two-factor (TOTP) ─────────────────────────────────────────────────────
  const mfa = useMemo<MfaApi>(() => ({
    factors: async () => {
      if (!supabase) return [];
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error || !data) return [];
      return data.totp.map((f) => ({
        id: f.id,
        friendly_name: f.friendly_name ?? null,
        status: f.status,
        created_at: f.created_at,
      }));
    },
    level: async () => {
      if (!supabase) return { current: null, next: null, stepUp: false, factorId: null };
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error || !data) return { current: null, next: null, stepUp: false, factorId: null };
      const stepUp = data.currentLevel === 'aal1' && data.nextLevel === 'aal2';
      let factorId: string | null = null;
      if (stepUp) {
        const { data: f } = await supabase.auth.mfa.listFactors();
        factorId = f?.totp.find((x) => x.status === 'verified')?.id ?? null;
      }
      return { current: data.currentLevel, next: data.nextLevel, stepUp: stepUp && !!factorId, factorId };
    },
    enroll: async (friendlyName: string) => {
      if (!supabase) return NOT_CONFIGURED;
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
      if (error || !data) return fail(error ?? { message: 'Could not start enrolment.' });
      return { ok: true, id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    },
    verify: async (factorId: string, code: string) => {
      if (!supabase) return NOT_CONFIGURED;
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\D/g, '') });
      return fail(error);
    },
    unenroll: async (factorId: string) => {
      if (!supabase) return NOT_CONFIGURED;
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      return fail(error);
    },
  }), []);

  const value = useMemo<SessionValue>(
    () => ({
      demo,
      ready,
      session,
      user: session?.user ?? null,
      profile,
      workspace,
      workspaces,
      memberships,
      retryMemberships,
      switchWorkspace,
      signIn,
      signUp,
      sendMagicLink,
      sendReset,
      signOut,
      updateProfile,
      updateWorkspace,
      changePassword,
      mfa,
    }),
    [demo, ready, session, profile, workspace, workspaces, memberships, retryMemberships, switchWorkspace, signIn, signUp, sendMagicLink, sendReset, signOut, updateProfile, updateWorkspace, changePassword, mfa],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

/**
 * The role to gate screens by, for components that read the session rather
 * than the view-model: the workspace role, or DEMO_ROLE when nobody is signed
 * in (the sample-data demo, where there is no workspace and no data to guard).
 * Signed in with no membership stays null, which canSee denies.
 */
export function sessionRole(s: Pick<SessionValue, 'workspace' | 'session'>): Role | null {
  return (s.workspace?.role as Role | undefined) ?? (s.session ? null : DEMO_ROLE);
}

/** Display name for the signed-in user, falling back through what we have. */
export function displayName(s: SessionValue): string {
  return s.profile?.full_name || s.user?.email?.split('@')[0] || 'You';
}

/** Two-letter avatar initials from whatever name we can resolve. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
