'use client';

// Each connected mailbox: today's sends against its cap, the warm-up ramp,
// 7-day bounce rate, active or paused (and why), and the limits an admin sets.
// The limits are enforced by google-sync on every send, not by this screen.
//
// In plain words: each rep's own Gmail, the inbox they write to sellers and
// buyers from one at a time. CLOZR caps how many emails each one sends a day
// (starting low and growing, the "ramp") so Google never decides the account
// is spamming, and pauses it by itself if too many emails bounce.

import React, { useState } from 'react';
import { type MailboxRow, type MailboxSettings, dailyAllowance, deliverability, textValue } from '@/lib/deliverability';
import { requestSettingsTab } from '@/app/clozr/screens/settingsTab';
import { Badge, Note, NotSetUp, Section, fieldLabel, ghost, input, pct, primary, row } from './ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Mailboxes({ workspaceId, mailboxes, admin, onChange }: { workspaceId: number; mailboxes: MailboxRow[]; admin: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = async (m: MailboxRow) => {
    const pause = !m.settings.paused;
    if (pause && !window.confirm(`Pause ${textValue(m.email)}? One-to-one and bulk email from it will be refused until resumed. Signing links still go out.`)) return;
    if (!pause && m.settings.paused_auto && !window.confirm(`${textValue(m.email)} was paused automatically: ${textValue(m.settings.paused_reason)}\n\nResume only after fixing the cause (clean the list, remove bad addresses). Resume now?`)) return;
    const r = await deliverability(workspaceId, pause ? 'pause_mailbox' : 'resume_mailbox', { account_id: m.account_id });
    setNote(r.ok ? { ok: true, text: pause ? `${textValue(m.email)} paused.` : `${textValue(m.email)} resumed.` } : { ok: false, text: r.message });
    onChange();
  };

  const how = (
    <>
      Every email CLOZR sends from a rep&apos;s Gmail is counted here and refused past these limits; the task stays open with the reason. A mailbox starts at 50 a day and climbs 20% each day until it reaches its cap. Buyer campaigns on Resend use that rep&apos;s own 10 blast addresses; Gmail here is the real inbox replies land in. Caps and the ramp apply to all sends; the window and spacing apply to bulk and plan email.
      {' '}Contract signing links skip the caps but still count. Bounces are read from the mailbox on each Gmail sync; a mailbox pauses itself at 3 hard bounces in its last 50 sends, a bounce rate over 5%, or unsubscribes over 4%.
      {' '}Spam complaints are not visible from a mailbox. Gmail reports them only through Postmaster.
    </>
  );
  const why = "Each rep's own Gmail, used for one-to-one email. CLOZR counts every send and stops at a safe daily limit so Google never flags the account.";

  if (mailboxes.length === 0) {
    return <NotSetUp title="Gmail inboxes (one-to-one)" why={`${why} No one has connected Google yet.`} how={how} action={<button type="button" style={ghost} onClick={() => requestSettingsTab({ main: 'outbound', tab: 'google' })}>Connect Google</button>} />;
  }

  return (
    <Section title={`Gmail inboxes (${mailboxes.length})`} why={why} how={how}>
      {mailboxes.map((m) => {
        const s = m.settings;
        const bounce = m.sent_7d ? m.bounced_7d / m.sent_7d : null;
        const used = m.allowance ? Math.min(1, m.sent_today / m.allowance) : 1;
        return (
          <div key={m.account_id} style={row}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>{textValue(m.email)}</span>
              {textValue(m.owner) ? <span style={{ fontSize: '12px', color: '#71717a' }}>{textValue(m.owner)}</span> : null}
              {s.paused ? <Badge tone="bad" title={textValue(s.paused_reason)}>paused</Badge> : m.status !== 'active' ? <Badge tone="warn">needs reconnect</Badge> : <Badge tone="good">active</Badge>}
              {s.ramp_enabled && m.allowance < s.daily_cap && <Badge tone="warn">warm-up day {m.ramp_day}</Badge>}
              {!m.gmail_read && <Badge tone="warn" title="Without Gmail read access CLOZR cannot see bounce notices">bounces unseen</Badge>}
              <span style={{ flex: 1 }} />
              {admin && <button type="button" style={ghost} onClick={() => setEditing(editing === m.account_id ? null : m.account_id)}>{editing === m.account_id ? 'Close' : 'Limits'}</button>}
              {admin && <button type="button" style={s.paused ? primary : ghost} onClick={() => void toggle(m)}>{s.paused ? 'Resume' : 'Pause'}</button>}
            </div>
            {s.paused && <div style={{ fontSize: '12px', color: '#b91c1c', marginTop: '4px' }}>{textValue(s.paused_reason)}{s.paused_at ? ` · ${new Date(s.paused_at).toLocaleString()}` : ''}</div>}
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px', fontSize: '12px', color: '#52525b' }}>
              <span style={{ minWidth: '160px' }}>
                Today {m.sent_today} / {m.allowance}
                <span style={{ display: 'block', height: '5px', borderRadius: '3px', background: '#f4f4f5', marginTop: '3px', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${used * 100}%`, background: used >= 1 ? '#b91c1c' : used > 0.8 ? '#d97706' : '#0A8560' }} />
                </span>
              </span>
              <span>Bounced, last 7 days <strong style={{ color: bounce != null && bounce > 0.05 ? '#b91c1c' : '#18181b' }}>{pct(bounce)}</strong> <span style={{ color: '#71717a' }}>({m.bounced_7d}/{m.sent_7d})</span></span>
              <span>Hourly cap {s.hourly_cap}</span>
              <span>Window {s.window_start}:00–{s.window_end}:00 {s.window_days.map((d) => DAYS[d]).join(' ')} · {textValue(s.timezone)}</span>
            </div>
            {editing === m.account_id && <Limits workspaceId={workspaceId} m={m} onSaved={() => { setEditing(null); onChange(); }} />}
          </div>
        );
      })}
      <Note note={note} />
    </Section>
  );
}

function Limits({ workspaceId, m, onSaved }: { workspaceId: number; m: MailboxRow; onSaved: () => void }) {
  const [s, setS] = useState<MailboxSettings>(m.settings);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const num = (k: keyof MailboxSettings, label: string, hint?: string) => (
    <label><span style={fieldLabel}>{label}</span>
      <input type="number" style={{ ...input, width: '100%' }} value={String(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
      {hint && <span style={{ fontSize: '11px', color: '#71717a' }}>{hint}</span>}
    </label>
  );
  const today = new Date().toISOString().slice(0, 10);
  const preview = [0, 3, 7, 14].map((d) => {
    const day = new Date(Date.parse(`${s.ramp_started_on}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    return `day ${d + 1}: ${dailyAllowance(s, day)}`;
  }).join(' · ');

  const save = async () => {
    setBusy(true); setNote(null);
    const r = await deliverability(workspaceId, 'save_mailbox', { account_id: m.account_id, settings: s });
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    onSaved();
  };

  return (
    <div style={{ marginTop: '10px', padding: '12px', border: '1px solid #e4e4e7', borderRadius: '10px', background: '#fafafa' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
        {num('daily_cap', 'Daily cap', 'Workspace max 2,000')}
        {num('hourly_cap', 'Hourly cap')}
        {num('min_gap_seconds', 'Seconds between bulk sends')}
        {num('window_start', 'Window opens (hour)')}
        {num('window_end', 'Window closes (hour)')}
        <label><span style={fieldLabel}>Time zone</span><input style={{ ...input, width: '100%' }} value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} placeholder="America/Chicago" /></label>
      </div>
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', margin: '8px 0' }}>
        {DAYS.map((d, i) => {
          const on = s.window_days.includes(i);
          return <button key={d} type="button" onClick={() => setS({ ...s, window_days: on ? s.window_days.filter((x) => x !== i) : [...s.window_days, i].sort() })} style={{ ...ghost, height: '26px', background: on ? '#E7F8F1' : '#fff', borderColor: on ? '#A8ECD2' : '#e4e4e7', color: on ? '#0A8560' : '#71717a' }}>{d}</button>;
        })}
        <span style={{ fontSize: '11.5px', color: '#71717a', alignSelf: 'center' }}>The mailbox&apos;s time zone stands in for the recipient&apos;s, which CLOZR does not know.</span>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 600, margin: '10px 0 6px' }}>
        <input type="checkbox" checked={s.ramp_enabled} onChange={(e) => setS({ ...s, ramp_enabled: e.target.checked })} style={{ accentColor: '#0A8560' }} /> Warm-up ramp
      </label>
      {s.ramp_enabled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
            {num('ramp_start', 'Start volume / day')}
            {num('ramp_increase_pct', 'Daily increase %')}
            {num('ramp_target', 'Target volume / day')}
            <label><span style={fieldLabel}>Started on</span><input type="date" max={today} style={{ ...input, width: '100%' }} value={s.ramp_started_on} onChange={(e) => setS({ ...s, ramp_started_on: e.target.value })} /></label>
          </div>
          <p style={{ fontSize: '11.5px', color: '#71717a', margin: '6px 0 0' }}>{preview}. A new mailbox or domain should start low; a mailbox with months of normal sending can switch the ramp off.</p>
        </>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <button type="button" style={primary} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save limits'}</button>
      </div>
      <Note note={note} />
    </div>
  );
}
