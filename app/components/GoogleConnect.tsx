// Settings → Google. One button, Google's consent screen, done.
//
// The old card here handed out a secret ICS URL to paste into Google Calendar:
// one-way, calendar-only, and a code to chase. That feed still exists for
// Apple Calendar and Outlook and is tucked in at the bottom, but the headline
// is now a normal OAuth connection — the calendar syncs both ways and mail
// goes out from the member's own address.
'use client';

import React, { useEffect, useState } from 'react';
import {
  GOOGLE_SCOPE, type DriveTreeStatus, type GoogleStatus, type SyncSummary,
  connectGoogle, disconnectGoogle, driveTreeLine, driveTreeRun, driveTreeSave, driveTreeStatus, googleStatus, granted, setGoogleSync, syncGoogle, testGoogleMail,
} from '@/lib/google';
import { calendarFeedUrl } from '@/lib/integrations';

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const ghost: React.CSSProperties = { height: '32px', padding: '0 12px', borderRadius: '9px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: '#18181b' };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', padding: '8px 10px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fafafa', wordBreak: 'break-all', display: 'block' };

/** Google's own mark, so the button looks like every other Sign in with Google. */
function GMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden style={{ flex: 'none' }}>
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 1.9-1.6 4.9-4.5 6.9l-.1.3 6.5 5 .5.1c4.1-3.8 6.6-9.4 6.6-15.6" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-1.9 14.5-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-.3.1-6.7 5.2-.1.3C8 41.2 15.4 46 24 46" />
      <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5v-.3l-6.8-5.3-.2.1C2.9 17 2 20.4 2 24s.9 7 2.5 10z" />
      <path fill="#EA4335" d="M24 10.1c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4 29.9 2 24 2 15.4 2 8 6.8 4.5 14l7 5.4C13.3 14 18.2 10.1 24 10.1" />
    </svg>
  );
}

const Dot = ({ on }: { on: boolean }) => (
  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: on ? '#16a34a' : '#a1a1aa', display: 'inline-block', flex: 'none' }} />
);

function Toggle({ on, onChange, title, sub, disabled }: { on: boolean; onChange: (v: boolean) => void; title: string; sub: string; disabled?: boolean }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '9px 0', borderTop: '1px solid #f0f0f1', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: '2px', width: '15px', height: '15px', accentColor: '#0A8560', flex: 'none' }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#18181b' }}>{title}</span>
        <span style={{ display: 'block', fontSize: '12px', color: '#71717a', marginTop: '1px', lineHeight: 1.45 }}>{sub}</span>
      </span>
    </label>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return 'not yet';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
};

const counted = (s: SyncSummary): string => {
  const bits: string[] = [];
  if (s.calendar) {
    const { created, updated, removed, applied, added, deleted, invited } = s.calendar;
    const out = created + updated + removed;
    const back = (applied ?? 0) + (added ?? 0) + (deleted ?? 0);
    bits.push(out ? `${out} event${out === 1 ? '' : 's'} to Google` : 'calendar up to date');
    if (back) bits.push(`${back} change${back === 1 ? '' : 's'} back from Google`);
    if (invited) bits.push(`${invited} invitation${invited === 1 ? '' : 's'} sent`);
  }
  if (s.gmail?.logged) bits.push(`${s.gmail.logged} email${s.gmail.logged === 1 ? '' : 's'} on records`);
  return bits.length ? `Synced — ${bits.join(', ')}.` : 'Synced. Nothing had changed.';
};

export function GoogleConnect({ workspaceId, demo, userId, onChange }: { workspaceId: number | null; demo: boolean; userId: string | null; /** Told after a connect, sync or disconnect settles — the inbox re-reads Gmail. */ onChange?: () => void }) {
  const [loaded, setLoaded] = useState<{ key: number | null; v: GoogleStatus } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [noteFor, setNoteFor] = useState(workspaceId);
  if (noteFor !== workspaceId) {
    setNoteFor(workspaceId);
    setNote(null);
  }
  const [busy, setBusy] = useState<string | null>(null);
  const [wantMail, setWantMail] = useState(true);

  useEffect(() => {
    if (!workspaceId || demo) return;
    let live = true;
    void googleStatus(workspaceId).then((r) => {
      if (!live || !r.ok) return;
      setLoaded({ key: workspaceId, v: r.data });
      // Connected already: bring the calendar level with Google while the
      // page is open, quietly. Nothing here waits on it.
      if (r.data.account?.status === 'active') void syncGoogle(workspaceId);
    });
    return () => { live = false; };
  }, [workspaceId, demo]);

  const status = loaded && loaded.key === workspaceId ? loaded.v : null;
  const account = status?.account ?? null;
  const others = (status?.team ?? []).filter((t) => t.user_id !== userId);

  const refresh = async () => {
    if (!workspaceId) return;
    const r = await googleStatus(workspaceId);
    if (r.ok) setLoaded({ key: workspaceId, v: r.data });
    onChange?.();
  };

  async function connect() {
    if (!workspaceId) return;
    setBusy('connect'); setNote(null);
    const r = await connectGoogle(workspaceId, { gmailRead: wantMail });
    setNote({ ok: r.ok, text: r.ok ? r.detail : r.message });
    await refresh();
    if (r.ok) {
      const s = await syncGoogle(workspaceId);
      if (s.ok && s.data.connected) setNote({ ok: true, text: `Connected. ${counted(s.data)}` });
      await refresh();
    }
    setBusy(null);
  }

  async function sync() {
    if (!workspaceId) return;
    setBusy('sync'); setNote(null);
    const r = await syncGoogle(workspaceId);
    setNote(r.ok ? { ok: r.data.ok !== false, text: r.data.message ?? counted(r.data) } : { ok: false, text: r.message });
    await refresh();
    setBusy(null);
  }

  async function test() {
    if (!workspaceId) return;
    setBusy('test'); setNote(null);
    const r = await testGoogleMail(workspaceId);
    setNote(r.ok ? { ok: r.data.ok, text: r.data.message } : { ok: false, text: r.message });
    setBusy(null);
  }

  async function drop() {
    if (!workspaceId || !window.confirm('Disconnect Google? CLOZR stops syncing and Google is told to forget the permission. The CLOZR calendar stays in your Google account until you delete it there.')) return;
    setBusy('disconnect'); setNote(null);
    const r = await disconnectGoogle(workspaceId);
    setNote({ ok: r.ok, text: r.ok ? 'Disconnected.' : r.message });
    await refresh();
    setBusy(null);
  }

  async function toggle(patch: { calendar_sync?: boolean; gmail_send?: boolean; gmail_read?: boolean }) {
    if (!account) return;
    const r = await setGoogleSync(account.id, patch);
    if (!r.ok) setNote({ ok: false, text: r.message });
    await refresh();
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Google Calendar and Gmail</h2>
        {account ? <Dot on={account.status === 'active'} /> : null}
      </div>
      <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 }}>
        Appointments land on a CLOZR calendar in your Google account and sync both ways: move, rename, invite or delete on either side and the other follows.
        Invitations to sellers, buyers and vendors go out from Google Calendar with Yes / No / Maybe, and their answers show on the appointment.
        Contracts and offers go out from your own address instead of a no-reply one, and replies from people in the CRM show on their record.
      </p>

      {demo ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: '#a1a1aa' }}>Sign in to connect a Google account.</p>
      ) : !status ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: '#71717a' }}>Checking…</p>
      ) : !status.configured ? (
        <Setup redirect={status.redirect_uri} />
      ) : account ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 12px', borderRadius: '10px', background: '#f6fbf9', border: '1px solid #d6ece4' }}>
            <GMark />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#18181b', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.email}</span>
            <span style={{ fontSize: '12px', color: account.status === 'active' ? '#0A8560' : '#b45309' }}>
              {account.status === 'active' ? `calendar ${ago(account.last_calendar_sync_at)}` : 'needs approving again'}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => void sync()} disabled={busy !== null} style={ghost}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
            {account.status === 'active' ? null : (
              <button type="button" onClick={() => void connect()} disabled={busy !== null} style={{ ...ghost, borderColor: '#0A8560', color: '#0A8560' }}>Reconnect</button>
            )}
          </div>

          <div style={{ marginTop: '10px' }}>
            <Toggle
              on={account.calendar_sync} disabled={!granted(account, GOOGLE_SCOPE.calendar)}
              onChange={(v) => void toggle({ calendar_sync: v })}
              title="Calendar, both ways"
              sub={granted(account, GOOGLE_SCOPE.calendar)
                ? 'Appointments sync both ways — including ones made on the CLOZR calendar in Google — and open dated tasks become reminders.'
                : 'Not granted. Reconnect and approve calendar access to switch this on.'}
            />
            <Toggle
              on={account.gmail_send} disabled={!granted(account, GOOGLE_SCOPE.gmailSend)}
              onChange={(v) => void toggle({ gmail_send: v })}
              title="Send from this address"
              sub={granted(account, GOOGLE_SCOPE.gmailSend)
                ? 'Signing links and offer letters come from you, and sit in your Sent folder.'
                : 'Not granted. Reconnect and approve sending to switch this on.'}
            />
            <Toggle
              on={account.gmail_read} disabled={!granted(account, GOOGLE_SCOPE.gmailRead)}
              onChange={(v) => void toggle({ gmail_read: v })}
              title="Replies on the record"
              sub={granted(account, GOOGLE_SCOPE.gmailRead)
                ? `Mail to and from people already in the CRM is logged on their timeline — subject and preview only. Last run ${ago(account.last_gmail_sync_at)}.`
                : 'Not granted. Reconnect and approve reading to switch this on.'}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
            <button type="button" onClick={() => void test()} disabled={busy !== null || !account.gmail_send} style={ghost}>{busy === 'test' ? 'Sending…' : 'Send test email'}</button>
            <button type="button" onClick={() => void drop()} disabled={busy !== null} style={{ ...ghost, color: '#b91c1c', borderColor: '#fecaca' }}>Disconnect</button>
          </div>
          {account.last_error ? <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#b45309' }}>{account.last_error}</p> : null}
        </>
      ) : (
        <>
          <button type="button" onClick={() => void connect()} disabled={busy !== null} style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', height: '40px', padding: '0 16px', borderRadius: '10px', border: '1px solid #dadce0', background: '#fff', fontSize: '13.5px', fontWeight: 600, color: '#3c4043', cursor: busy ? 'wait' : 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,.05)' }}>
            <GMark />
            {busy === 'connect' ? 'Waiting for Google…' : 'Connect Google'}
          </button>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', marginTop: '12px', fontSize: '12.5px', color: '#52525b', cursor: 'pointer' }}>
            <input type="checkbox" checked={wantMail} onChange={(e) => setWantMail(e.target.checked)} style={{ marginTop: '2px', width: '15px', height: '15px', accentColor: '#0A8560', flex: 'none' }} />
            <span>Also read replies from people already in the CRM onto their record. Untick to ask Google for sending only.</span>
          </label>
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#a1a1aa', lineHeight: 1.5 }}>
            Google asks you once, on its own screen. You can untick anything there and CLOZR uses whatever you approve — nothing to paste back here.
          </p>
        </>
      )}

      {note ? <p style={{ margin: '12px 0 0', fontSize: '12.5px', color: note.ok ? '#15803d' : '#b91c1c' }}>{note.text}</p> : null}

      {others.length ? (
        <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #f0f0f1' }}>
          <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, marginBottom: '6px' }}>Also connected</div>
          {others.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: '#52525b', padding: '3px 0' }}>
              <Dot on={t.status === 'active'} /><span>{t.email}</span>
              <span style={{ color: '#a1a1aa' }}>{t.status === 'active' ? `synced ${ago(t.last_calendar_sync_at)}` : 'needs approving again'}</span>
            </div>
          ))}
        </div>
      ) : null}

      <OtherCalendars workspaceId={workspaceId} demo={demo} />
    </div>
  );
}

/** Google Drive's own mark. */
function DriveMark() {
  return (
    <svg width="22" height="20" viewBox="0 0 87.3 78" aria-hidden style={{ flex: 'none' }}>
      <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" />
      <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" />
      <path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  );
}

/**
 * Settings → Google → Google Drive. The team's deals folder: every
 * address-named folder's files and photos filed on the deal for that
 * property, kept current every ten minutes (drive-photos `tree`, migration
 * 139). Read-only in Drive; added to the member's existing Google connection.
 */
export function GoogleDriveCard({ workspaceId, demo }: { workspaceId: number | null; demo: boolean }) {
  const [st, setSt] = useState<DriveTreeStatus | null>(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [driveFor, setDriveFor] = useState(workspaceId);
  if (driveFor !== workspaceId) {
    setDriveFor(workspaceId);
    setSt(null);
    setMsg(null);
    setFolder('');
  }
  const load = async () => { if (workspaceId) { const r = await driveTreeStatus(workspaceId); if (r.ok) setSt(r.data); } };
  useEffect(() => {
    if (!workspaceId || demo) return;
    let live = true;
    void driveTreeStatus(workspaceId).then((r) => { if (live && r.ok) setSt(r.data); });
    return () => { live = false; };
  }, [workspaceId, demo]);
  const hasDrive = !!st?.drive_connected;

  async function connect() {
    if (!workspaceId) return;
    setBusy('connect'); setMsg(null);
    const r = await connectGoogle(workspaceId, { drive: true });
    setBusy(null);
    if (!r.ok) setMsg({ ok: false, text: r.message }); else await load();
  }
  async function go(kind: 'save' | 'run') {
    if (!workspaceId) return;
    setBusy(kind); setMsg(null);
    const r = kind === 'save' ? await driveTreeSave(workspaceId, folder) : await driveTreeRun(workspaceId);
    setBusy(null);
    if (!r.ok) setMsg({ ok: false, text: r.message });
    else if (r.data.error) setMsg({ ok: false, text: r.data.error });
    else setMsg({ ok: true, text: driveTreeLine(r.data) });
    await load();
  }
  const cfg = st?.config;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <DriveMark />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Google Drive</h2>
        {st ? <Dot on={hasDrive && !!cfg && !cfg.last_error} /> : null}
      </div>
      <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 }}>
        Point CLOZR at your deals folder. Every folder named for a property — and everything under it, Photos folders included — is filed on that deal: contracts, title work and other documents on its Files, pictures in its photos. New files follow every ten minutes. CLOZR only reads Drive; nothing is moved or deleted.
      </p>
      {demo ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: '#a1a1aa' }}>Sign in to connect Google Drive.</p>
      ) : !st ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: '#71717a' }}>Checking…</p>
      ) : !st.email ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: '#71717a' }}>Connect Google in the card above first; Drive is added to that connection.</p>
      ) : !hasDrive ? (
        <button type="button" onClick={() => void connect()} disabled={busy !== null} style={{ ...ghost, borderColor: '#0A8560', color: '#0A8560' }}>{busy === 'connect' ? 'Waiting for Google…' : `Connect Drive for ${st.email} (read-only)`}</button>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={cfg ? `${cfg.root_name ?? 'Folder'} — paste another link to change` : 'Paste the folder link from Drive'}
              style={{ flex: '1 1 260px', minWidth: 0, height: '32px', padding: '0 10px', borderRadius: '9px', border: '1px solid #e4e4e7', fontSize: '12.5px' }} />
            <button type="button" onClick={() => void go('save')} disabled={busy !== null || !folder.trim()} style={ghost}>{busy === 'save' ? 'Reading Drive…' : 'Use this folder'}</button>
            {cfg ? <button type="button" onClick={() => void go('run')} disabled={busy !== null} style={ghost}>{busy === 'run' ? 'Syncing…' : 'Sync now'}</button> : null}
          </div>
          {cfg ? (
            <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#52525b', lineHeight: 1.5 }}>
              <strong>{cfg.root_name ?? cfg.root_folder_id}</strong> · last run {ago(cfg.last_run_at)}{cfg.running ? ' · running now' : ''}<br />
              {driveTreeLine(cfg.last_notes)}
              {cfg.last_error ? <><br /><span style={{ color: '#b45309' }}>{cfg.last_error}</span></> : null}
              {cfg.last_notes?.unmatched?.length ? <><br /><span style={{ color: '#a1a1aa' }}>No deal yet: {cfg.last_notes.unmatched.slice(0, 8).join(' · ')}</span></> : null}
            </p>
          ) : null}
        </>
      )}
      {msg ? <p style={{ margin: '8px 0 0', fontSize: '12px', color: msg.ok ? '#15803d' : '#b91c1c' }}>{msg.text}</p> : null}
    </div>
  );
}

/**
 * Before a Google OAuth client exists on the project there is nothing to
 * connect to, so the card says what to make and — the part that is easy to get
 * wrong — the exact redirect URI it has to carry.
 */
function Setup({ redirect }: { redirect: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ fontSize: '12.5px', color: '#52525b', lineHeight: 1.6 }}>
      <p style={{ margin: '0 0 8px' }}>
        One setup, once, by whoever owns the Google account — after that everybody here just clicks Connect.
      </p>
      <ol style={{ margin: '0 0 10px', paddingLeft: '18px' }}>
        <li>In <strong>Google Cloud Console → APIs &amp; Services</strong>, enable the <strong>Google Calendar API</strong> and the <strong>Gmail API</strong>.</li>
        <li>On the <strong>OAuth consent screen</strong>, pick <strong>Internal</strong> if Acme Homes is on Google Workspace — internal apps skip Google&apos;s review entirely.</li>
        <li>Create an <strong>OAuth client ID → Web application</strong> and give it this authorised redirect URI:</li>
      </ol>
      <code style={mono}>{redirect}</code>
      <button
        type="button"
        onClick={() => { void navigator.clipboard?.writeText(redirect).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }}
        style={{ ...ghost, marginTop: '8px' }}
      >
        {copied ? 'Copied' : 'Copy redirect URI'}
      </button>
      <p style={{ margin: '10px 0 0' }}>
        Then put the client&apos;s id and secret on the Supabase project as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>
        {' '}(Dashboard → Edge Functions → Secrets). They stay on the server; this page never sees them.
      </p>
    </div>
  );
}

/**
 * The ICS feed, still here for calendars Google does not run. It is one-way and
 * the URL is the credential, which is why it is no longer the headline.
 */
function OtherCalendars({ workspaceId, demo }: { workspaceId: number | null; demo: boolean }) {
  const [url, setUrl] = useState<{ key: number | null; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState(workspaceId);
  if (noteFor !== workspaceId) {
    setNoteFor(workspaceId);
    setNote(null);
  }
  const [copied, setCopied] = useState(false);
  const feed = url && url.key === workspaceId ? url.url : null;

  async function show() {
    if (!workspaceId || feed) return;
    const r = await calendarFeedUrl(workspaceId);
    if (r.ok) setUrl({ key: workspaceId, url: r.url }); else setNote(r.message);
  }

  async function rotate() {
    if (!workspaceId || !window.confirm('Rotate the feed URL? Every calendar subscribed to the current one stops updating until it is re-added.')) return;
    const r = await calendarFeedUrl(workspaceId, true);
    if (r.ok) { setUrl({ key: workspaceId, url: r.url }); setNote('Rotated. Re-add the new URL.'); } else setNote(r.message);
  }

  if (demo || !workspaceId) return null;
  return (
    <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void show(); }} style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #f0f0f1' }}>
      <summary style={{ fontSize: '12.5px', color: '#71717a', cursor: 'pointer' }}>Apple Calendar, Outlook, anything else</summary>
      <p style={{ margin: '8px 0', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 }}>
        A read-only feed of the same appointments and tasks. Subscribe to this URL from the other calendar app — one-way, and the URL is the only credential, so treat it as a password and rotate it if it gets out.
      </p>
      {feed ? (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ ...mono, flex: 1, minWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{feed}</code>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(feed).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }} style={ghost}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" onClick={() => void rotate()} style={{ ...ghost, color: '#71717a' }}>Rotate</button>
        </div>
      ) : <p style={{ margin: 0, fontSize: '12.5px', color: '#71717a' }}>{note ?? 'Minting…'}</p>}
      {note && feed ? <div style={{ marginTop: '8px', fontSize: '12px', color: '#15803d' }}>{note}</div> : null}
    </details>
  );
}
