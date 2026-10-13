// Account — the signed-in person: who they are, and how they get in.
//
// Everything here writes to Supabase through the session provider, so it is
// real even while the rest of the CRM still renders the mock graph. In demo
// mode the fields render but say plainly that nothing will save, rather than
// accepting input and silently dropping it.
'use client';

import React, { useEffect, useState } from 'react';
import { useConfirm } from '@/components/ds/Confirm';
import { type MfaFactor, displayName, useSession } from '@/lib/session';
import { UserAvatar } from '@/components/UserAvatar';
import { avatarOf, uploadAvatar } from '@/lib/avatar';
import { READ_ONLY_TITLE, useCanWrite } from '@/lib/read-only-context';
import { ReadOnlyNote } from '@/components/ViewAs';
import { secretListCsv } from '@/lib/secret-list';
import { loadBlacklistReasons, reasonFor, reasonKindOf } from '@/lib/blacklist-reasons';
import { Mark } from '@/components/ds/mark';

export type SecretListRow = {
  id: string; kind: 'Person' | 'Buyer'; name: string; phone: string; email: string; detail: string;
};

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '11.5px',
  color: '#71717a',
  fontWeight: 500,
  marginBottom: '6px',
};

const field: React.CSSProperties = {
  width: '100%',
  height: '36px',
  padding: '0 10px',
  border: '1px solid #e4e4e7',
  borderRadius: '9px',
  fontSize: '13px',
  outline: 0,
  background: '#fafafa',
  color: '#18181b',
};

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e4e4e7',
  borderRadius: '12px',
  padding: '16px 18px',
  marginBottom: '12px',
};

export function Account({ isMobile, blacklist }: { isMobile: boolean; blacklist?: { rows: SecretListRow[]; restore: (id: string) => void } }) {
  const s = useSession();
  // In a View-as preview this is still the admin's own account; nothing on it
  // changes from the preview, so the save buttons behave as they do in demo.
  const canWrite = useCanWrite();
  const locked = s.demo || !canWrite;
  const roTitle = canWrite ? undefined : READ_ONLY_TITLE;
  const [pw, setPw] = useState('');
  // Why each person is on the blacklist (migration 106). Empty when the table is not there yet.
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());
  const wsId = s.workspace?.id ?? null;
  const listKey = (blacklist?.rows ?? []).map((r) => r.id).join(',');
  useEffect(() => {
    let live = true;
    void loadBlacklistReasons(wsId).then((m) => { if (live) setReasons(m); });
    return () => { live = false; };
  }, [wsId, listKey]);
  const reasonOf = (r: SecretListRow) => reasonFor(reasons, reasonKindOf(r.kind), r.id);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // The profile arrives asynchronously, so the form is keyed to the row it was
  // seeded from and falls back to that row until someone types. Copying it in
  // with an effect would be a synchronous setState during render.
  const seed = s.profile?.id ?? null;
  const [edit, setEdit] = useState<{ key: string | null; full_name: string; phone: string; title: string; license_number: string } | null>(null);
  const live = edit && edit.key === seed ? edit : null;
  const fullName = live ? live.full_name : s.profile?.full_name ?? '';
  const phone = live ? live.phone : s.profile?.phone ?? '';
  const title = live ? live.title : s.profile?.title ?? '';
  const license = live ? live.license_number : s.profile?.license_number ?? '';
  const patch = (k: 'full_name' | 'phone' | 'title' | 'license_number', v: string) =>
    setEdit({ key: seed, full_name: fullName, phone, title, license_number: license, [k]: v });

  const name = displayName(s);
  const photo = avatarOf(s.profile?.avatar_url, s.user?.user_metadata);
  const [photoBusy, setPhotoBusy] = useState(false);

  async function setPhoto(file: File) {
    if (!s.user) return;
    setPhotoBusy(true); setNote(null);
    const up = await uploadAvatar(s.user.id, file);
    const r = up.ok ? await s.updateProfile({ avatar_url: up.url }) : { ok: false, message: up.message };
    setPhotoBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Photo saved — your team sees it on activity, the inbox and team lists.' : r.message ?? 'Could not save that photo.' });
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const r = await s.updateProfile({ full_name: fullName, phone, title, license_number: license.trim() || null });
    setBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Profile saved.' : r.message ?? 'Could not save.' });
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const r = await s.changePassword(pw);
    setBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Password updated.' : r.message ?? 'Could not update.' });
    if (r.ok) setPw('');
  }

  return (
    <section data-screen-label="Account" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div data-head style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', background: '#fff', borderBottom: '1px solid #e4e4e7', flex: 'none' }}>
        <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Account</h1>
        <span style={{ fontSize: '12.5px', color: '#71717a' }}>your profile and sign-in</span>
        <div style={{ flex: 1 }} />
        {s.demo ? (
          <a href="/login" className="dc2" style={{ height: '32px', lineHeight: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12.5px', color: '#18181b', textDecoration: 'none' }}>
            Sign in
          </a>
        ) : (
          <button className="dc2" onClick={() => void s.signOut()} style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', cursor: 'pointer', color: '#18181b' }}>
            Sign out
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '12px 14px 28px' : '16px 20px 40px', background: '#fafafa' }}>
        <div style={{ maxWidth: '640px' }}>
          <ReadOnlyNote />
          {s.demo ? (
            <div style={{ ...card, background: '#fef3c7', borderColor: '#fde68a', color: '#92400e', fontSize: '12.5px', lineHeight: 1.55 }}>
              <strong style={{ fontWeight: 700 }}>Demo mode.</strong> Supabase isn&rsquo;t configured for this
              deployment, so there is no account to edit and nothing here will save. The CRM is running on
              sample data.
            </div>
          ) : null}

          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '14px' }}>
            <span style={{ display: 'grid', justifyItems: 'center', gap: '6px', flex: 'none' }}>
              <UserAvatar name={name} src={photo} size={64} radius="16px" />
              {!locked && s.user ? (
                <label style={{ fontSize: '11.5px', fontWeight: 600, color: '#0A8560', cursor: photoBusy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
                  {photoBusy ? 'Uploading…' : photo ? 'Change photo' : 'Add photo'}
                  <input type="file" accept="image/*" hidden disabled={photoBusy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void setPhoto(f); }} />
                </label>
              ) : null}
              {!locked && s.profile?.avatar_url ? (
                <button type="button" onClick={() => void s.updateProfile({ avatar_url: null }).then((r) => setNote({ ok: r.ok, text: r.ok ? 'Photo removed.' : r.message ?? 'Could not remove.' }))}
                  style={{ border: 0, background: 'none', padding: 0, fontSize: '11px', color: '#a1a1aa', cursor: 'pointer' }}>Remove</button>
              ) : null}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>{name}</span>
              <span style={{ display: 'block', fontSize: '12.5px', color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.user?.email ?? 'not signed in'}
              </span>
              {s.workspace ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '5px', fontSize: '11px', fontWeight: 600, color: '#0A8560' }}>
                  <Mark label={s.workspace.role} />
                  {s.workspace.role}
                </span>
              ) : null}
            </span>
          </div>

          {note ? (
            <div role="status" style={{ ...card, padding: '11px 13px', background: note.ok ? '#dcfce7' : '#fee2e2', borderColor: note.ok ? '#bbf7d0' : '#fecaca', color: note.ok ? '#15803d' : '#b91c1c', fontSize: '12.5px' }}>
              {note.text}
            </div>
          ) : null}

          <form onSubmit={saveProfile} style={card}>
            <h2 style={{ margin: '0 0 14px', fontSize: '14px', fontWeight: 600 }}>Profile</h2>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : '1fr 1fr', gap: '12px' }}>
              <label>
                <span style={label}>Full name</span>
                <input value={fullName} onChange={(e) => patch('full_name', e.target.value)} placeholder="Full name" style={field} />
              </label>
              <label>
                <span style={label}>Title</span>
                <input value={title} onChange={(e) => patch('title', e.target.value)} placeholder="Owner" style={field} />
              </label>
              <label>
                <span style={label}>Phone</span>
                <input value={phone} onChange={(e) => patch('phone', e.target.value)} placeholder="(210) 555-0100" style={field} />
              </label>
              <label>
                <span style={label}>Real estate license (printed on TREC forms)</span>
                <input value={license} onChange={(e) => patch('license_number', e.target.value)} placeholder="License number, if you hold one" style={field} />
              </label>
              <label>
                <span style={label}>Email</span>
                <input value={s.user?.email ?? ''} disabled style={{ ...field, color: '#a1a1aa', cursor: 'not-allowed' }} />
              </label>
            </div>
            <button type="submit" disabled={busy || locked} title={roTitle} className="dc3" style={{ marginTop: '14px', height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: busy || locked ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || locked ? 'not-allowed' : 'pointer' }}>
              Save profile
            </button>
          </form>

          <form onSubmit={savePassword} style={card}>
            <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Password</h2>
            <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#71717a' }}>
              Sets a new password for {s.user?.email ?? 'your account'}.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : '1fr 1fr', gap: '12px' }}>
              <label>
                <span style={label}>New password</span>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" minLength={8} autoComplete="new-password" style={field} />
              </label>
            </div>
            <button type="submit" disabled={busy || locked || pw.length < 8} title={roTitle} className="dc2" style={{ marginTop: '14px', height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', fontWeight: 600, cursor: busy || locked || pw.length < 8 ? 'not-allowed' : 'pointer', color: pw.length < 8 ? '#a1a1aa' : '#18181b' }}>
              Update password
            </button>
          </form>

          <TwoFactor demo={s.demo} isMobile={isMobile} />

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#b91c1c', display: 'inline-flex' }}><Mark label="blacklist" /></span>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Blacklist</h2>
              <span style={{ flex: 1 }} />
              <button type="button" className="dc2" disabled={!blacklist?.rows.length} onClick={() => {
                const csv = secretListCsv((blacklist?.rows ?? []).map((r) => ({ ...r, reason: reasonOf(r) })));
                const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'blacklist.csv';
                a.click();
                URL.revokeObjectURL(url);
              }} style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #e4e4e7', background: '#fff', fontSize: 12.5, fontWeight: 600, cursor: blacklist?.rows.length ? 'pointer' : 'not-allowed', color: '#18181b' }}>
                Export
              </button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 12.5, color: '#71717a', lineHeight: 1.5 }}>
              People and buyers moved here are off those lists. This is the only place the list shows.
            </p>
            {blacklist?.rows.length ? (
              <div style={{ marginTop: 12 }}>
                {blacklist.rows.map((r) => (
                  <div key={r.kind + r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid #f0f0f1', fontSize: 12.5 }}>
                    <span style={{ fontWeight: 650, minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block' }}>{r.name}</span>
                      <span style={{ display: 'block', color: '#71717a', fontSize: 11.5 }}>{r.kind}{r.detail ? ` · ${r.detail}` : ''}{r.phone ? ` · ${r.phone}` : ''}{r.email ? ` · ${r.email}` : ''}</span>
                      <span style={{ display: 'block', color: reasonOf(r) ? '#3f3f46' : '#71717a', fontSize: 11.5, fontWeight: 500, marginTop: 2 }}>
                        {reasonOf(r) ? `Reason: ${reasonOf(r)}` : 'No reason recorded'}
                      </span>
                    </span>
                    <button type="button" className="dc2" onClick={() => blacklist.restore(r.id)} style={{ height: 28, padding: '0 10px', borderRadius: 7, border: '1px solid #e4e4e7', background: '#fff', fontSize: 12, cursor: 'pointer' }}>Restore</button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: '12px 0 0', fontSize: 12.5, color: '#a1a1aa' }}>No one is on this list.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Two-factor authentication (TOTP) ─────────────────────────────────────────
//
// Any authenticator app (1Password, Google Authenticator, Authy). Enrolment is
// three steps — scan, type the code, done — and from then on sign-in asks for
// a code. Removing the factor needs a session that has passed it, which every
// in-app session has, because the /app guard insists.

type Enrolling = { id: string; qr: string; secret: string };

function TwoFactor({ demo, isMobile }: { demo: boolean; isMobile: boolean }) {
  const { confirm: ask } = useConfirm();
  const s = useSession();
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  const uid = s.user?.id ?? null;
  useEffect(() => {
    if (demo || !uid) return;
    let live = true;
    void s.mfa.factors().then((f) => { if (live) setFactors(f); });
    return () => { live = false; };
  }, [demo, uid, nonce, s.mfa]);

  const verified = (factors ?? []).filter((f) => f.status === 'verified');
  const stale = (factors ?? []).filter((f) => f.status === 'unverified' && f.id !== enrolling?.id);

  async function start() {
    setBusy(true); setNote(null);
    // A half-finished enrolment from earlier would block a new one with the
    // same name; clear those first.
    for (const f of stale) await s.mfa.unenroll(f.id);
    const r = await s.mfa.enroll('CLOZR');
    setBusy(false);
    if (!r.ok || !r.id || !r.qr || !r.secret) { setNote({ ok: false, text: r.message ?? 'Could not start enrolment.' }); return; }
    setEnrolling({ id: r.id, qr: r.qr, secret: r.secret });
    setCode('');
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    setBusy(true); setNote(null);
    const r = await s.mfa.verify(enrolling.id, code);
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.message ?? 'That code did not verify. Try the next one.' }); setCode(''); return; }
    setEnrolling(null);
    setCode('');
    setNote({ ok: true, text: 'Two-factor authentication is on. Sign-in will ask for a code from now on.' });
    setNonce((n) => n + 1);
  }

  async function cancel() {
    if (enrolling) await s.mfa.unenroll(enrolling.id);
    setEnrolling(null);
    setCode('');
  }

  async function remove(id: string) {
    if (!(await ask({ title: 'Turn off two-factor authentication?', body: 'Signing in to this account will only need the password again.', confirmLabel: 'Turn off two-factor', tone: 'danger' }))) return;
    setBusy(true); setNote(null);
    const r = await s.mfa.unenroll(id);
    setBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Two-factor authentication is off.' : r.message ?? 'Could not remove the authenticator.' });
    setNonce((n) => n + 1);
  }

  const on = verified.length > 0;

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Two-factor authentication</h2>
        <span style={{ fontSize: '11px', fontWeight: 600, color: on ? '#0A8560' : '#71717a', background: on ? '#E7F8F1' : '#f4f4f5', padding: '2px 7px', borderRadius: '6px' }}>
          {demo ? 'demo' : factors === null ? 'checking' : on ? 'on' : 'off'}
        </span>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 }}>
        A code from an authenticator app is asked for at every sign-in, so a leaked or guessed password is not enough to get in.
        Seller phone numbers, addresses and deal economics live behind this account; turn it on.
      </p>

      {note ? (
        <div role="status" style={{ marginBottom: '12px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? '#dcfce7' : '#fee2e2', border: `1px solid ${note.ok ? '#bbf7d0' : '#fecaca'}`, color: note.ok ? '#15803d' : '#b91c1c' }}>
          {note.text}
        </div>
      ) : null}

      {enrolling ? (
        <form onSubmit={confirm} style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : '168px 1fr', gap: '16px', alignItems: 'start' }}>
          {/* Supabase returns the QR as an SVG data URL; it never leaves the browser,
              and next/image cannot optimise a data URL in a static export. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrolling.qr} alt="Scan this QR code with your authenticator app" width={168} height={168} style={{ borderRadius: '10px', border: '1px solid #e4e4e7', background: '#fff' }} />
          <div>
            <p style={{ margin: '0 0 8px', fontSize: '12.5px', color: '#3f3f46', lineHeight: 1.5 }}>
              1. Scan the code with 1Password, Google Authenticator or Authy.<br />
              2. Type the 6-digit code the app shows.
            </p>
            <details style={{ marginBottom: '10px', fontSize: '12px', color: '#71717a' }}>
              <summary style={{ cursor: 'pointer' }}>Can&rsquo;t scan? Enter the key by hand</summary>
              <code style={{ display: 'block', marginTop: '6px', padding: '8px 10px', background: '#f4f4f5', borderRadius: '8px', fontSize: '12px', wordBreak: 'break-all', userSelect: 'all' }}>{enrolling.secret}</code>
            </details>
            <label>
              <span style={label}>Code</span>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" autoFocus style={{ ...field, maxWidth: '200px', letterSpacing: '.2em' }} />
            </label>
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button type="submit" disabled={busy || code.length < 6} className="dc3" style={{ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: busy || code.length < 6 ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || code.length < 6 ? 'not-allowed' : 'pointer' }}>
                Turn on
              </button>
              <button type="button" onClick={() => void cancel()} disabled={busy} className="dc2" style={{ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: '#18181b' }}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      ) : on ? (
        <div>
          {verified.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px', border: '1px solid #e4e4e7', borderRadius: '9px', marginBottom: '8px', fontSize: '12.5px' }}>
              <span style={{ fontWeight: 600 }}>{f.friendly_name || 'Authenticator app'}</span>
              <span style={{ color: '#71717a' }}>since {new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => void remove(f.id)} disabled={busy} className="dc2" style={{ height: '28px', padding: '0 10px', borderRadius: '7px', border: '1px solid #fecaca', background: '#fff', color: '#b91c1c', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                Turn off
              </button>
            </div>
          ))}
        </div>
      ) : (
        <button type="button" onClick={() => void start()} disabled={busy || demo || factors === null} className="dc3" style={{ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: busy || demo || factors === null ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || demo || factors === null ? 'not-allowed' : 'pointer' }}>
          Set up an authenticator app
        </button>
      )}
    </div>
  );
}
