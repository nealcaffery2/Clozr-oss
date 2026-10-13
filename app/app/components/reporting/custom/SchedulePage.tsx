'use client';

// Send or schedule: when the report goes out, over what range, to whom. The
// mailer (supabase/functions/report-mail) renders the same widgets from the
// same engine and sends through Resend; "Send test email" goes to you now.

import React, { useEffect, useState } from 'react';
import { DATE_PRESETS } from '@/lib/report-engine';
import { SCHEDULE_DEFAULT_RANGE, saveSchedule, sendTestReport, type ReportRow, type ScheduleInput } from '@/lib/report-store';
import { listTeam, type Teammate } from '@/lib/team';
import { ACCENT, INK, LINE, MUTED, SOFT, Toggle, btn, card, eyebrow, field } from './ui';

const FREQ: { v: ScheduleInput['frequency']; label: string }[] = [
  { v: 'none', label: 'Not scheduled' }, { v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly (Mondays)' }, { v: 'monthly', label: 'Monthly (the 1st)' }, { v: 'quarterly', label: 'Quarterly' }, { v: 'annually', label: 'Annually' },
];
const ZONES = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
const COMPARE = [{ v: 'none', label: 'No comparison' }, { v: 'previous', label: 'Previous period' }, { v: 'year', label: 'Year before' }];

export function SchedulePage({ report, workspaceId, userId, myEmail, onBack, onSaved, toast }: {
  report: ReportRow; workspaceId: number | null; userId: string | null; myEmail: string | null; onBack: () => void; onSaved: (r: ReportRow) => void; toast: (m: string) => void;
}) {
  const s0 = report.schedule;
  const [form, setForm] = useState<ScheduleInput>({
    frequency: (s0?.frequency as ScheduleInput['frequency']) ?? 'none', at_time: s0?.at_time ?? '10:00', tz: s0?.tz ?? 'America/Chicago',
    date_preset: s0?.date_preset ?? SCHEDULE_DEFAULT_RANGE.none, comparison: s0?.comparison ?? 'previous', use_widget_dates: s0?.use_widget_dates ?? true,
    from_email: s0?.from_email ?? null, subject: s0?.subject ?? report.name, recipients: s0?.recipients ?? (myEmail ? [myEmail] : []), message: s0?.message ?? null,
  });
  const [team, setTeam] = useState<Teammate[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void listTeam(workspaceId).then((rows) => live && setTeam(rows));
    return () => { live = false; };
  }, [workspaceId]);

  const set = (patch: Partial<ScheduleInput>) => setForm((f) => ({ ...f, ...patch }));
  const setFreq = (frequency: ScheduleInput['frequency']) => set({ frequency, date_preset: SCHEDULE_DEFAULT_RANGE[frequency], comparison: frequency === 'none' ? form.comparison : 'previous' });
  const addTyped = () => { const e = typed.trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !form.recipients.includes(e)) set({ recipients: [...form.recipients, e] }); setTyped(''); };

  async function save() {
    setBusy('save'); setNote(null);
    const r = await saveSchedule(report.id, workspaceId, userId, form);
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setNote({ ok: true, text: form.frequency === 'none' ? 'Schedule removed.' : `Scheduled ${FREQ.find((f) => f.v === form.frequency)?.label.toLowerCase()} at ${form.at_time} ${form.tz.split('/')[1]?.replace('_', ' ')} · the first email goes out at the next scheduled time.` });
    onSaved({ ...report, schedule: r.data });
  }
  async function test() {
    setBusy('test'); setNote(null);
    const r = await sendTestReport(report.id, workspaceId, form.date_preset, form.comparison);
    setBusy(null);
    setNote(r.ok ? { ok: true, text: `Test sent to ${r.data.to}.` } : { ok: false, text: r.message });
    if (r.ok) toast('Test email sent');
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', background: '#fff', borderBottom: `1px solid ${LINE}` }}>
        <button type="button" onClick={onBack} style={btn.ghost}>← Back</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>Send or schedule</div>
          <div style={{ fontSize: '12px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{report.name}</div>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => void test()} disabled={busy !== null || !workspaceId} style={btn.ghost}>{busy === 'test' ? 'Sending…' : 'Send test email'}</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 20px 40px' }}>
        <div style={{ maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {note ? <div role="status" style={{ padding: '10px 12px', borderRadius: '9px', fontSize: '12.5px', background: note.ok ? '#dcfce7' : '#fee2e2', border: `1px solid ${note.ok ? '#bbf7d0' : '#fecaca'}`, color: note.ok ? ACCENT : '#b91c1c' }}>{note.text}</div> : null}
          <div style={{ ...card, padding: '16px 18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
              <label><span style={eyebrow}>Schedule frequency</span><select value={form.frequency} onChange={(e) => setFreq(e.target.value as ScheduleInput['frequency'])} style={field}>{FREQ.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}</select></label>
              <label><span style={eyebrow}>Choose a time</span><input type="time" value={form.at_time} onChange={(e) => set({ at_time: e.target.value || '10:00' })} disabled={form.frequency === 'none'} style={field} /></label>
              <label><span style={eyebrow}>Time zone</span><select value={form.tz} onChange={(e) => set({ tz: e.target.value })} disabled={form.frequency === 'none'} style={field}>{ZONES.map((z) => <option key={z} value={z}>{z.replace('_', ' ')}</option>)}</select></label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginTop: '12px' }}>
              <label><span style={eyebrow}>Date range</span><select value={form.date_preset} onChange={(e) => set({ date_preset: e.target.value })} style={field}>{DATE_PRESETS.filter((p) => p !== 'Custom').map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
              <label><span style={eyebrow}>Comparison date range</span><select value={form.comparison} onChange={(e) => set({ comparison: e.target.value })} style={field}>{COMPARE.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}</select></label>
            </div>
            <div style={{ marginTop: '8px' }}>
              <Toggle on={form.use_widget_dates} onChange={(v) => set({ use_widget_dates: v })} label="Use widget-level date settings" sub="When enabled, widgets with their own date range and comparison keep them in the email. Every other widget uses the range and comparison above." />
            </div>
          </div>

          <div style={{ ...card, padding: '16px 18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
              <label><span style={eyebrow}>From email</span><input value={form.from_email ?? ''} onChange={(e) => set({ from_email: e.target.value || null })} placeholder="Sends from the company address; this becomes Reply-To" style={field} /></label>
              <label><span style={eyebrow}>Subject line</span><input value={form.subject ?? ''} onChange={(e) => set({ subject: e.target.value || null })} placeholder={report.name} style={field} /></label>
            </div>
            <div style={{ marginTop: '12px' }}>
              <span style={eyebrow}>Recipients (to)</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '6px', border: `1px solid ${LINE}`, borderRadius: '9px', minHeight: '40px', alignItems: 'center' }}>
                {form.recipients.map((r) => (
                  <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', height: '26px', padding: '0 4px 0 9px', borderRadius: '7px', background: '#E7F8F1', color: ACCENT, fontSize: '12px', fontWeight: 600 }}>
                    {r}<button type="button" onClick={() => set({ recipients: form.recipients.filter((x) => x !== r) })} aria-label={`Remove ${r}`} style={{ border: 0, background: 'none', color: ACCENT, cursor: 'pointer', fontSize: '14px' }}>×</button>
                  </span>
                ))}
                <input value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTyped(); } }} onBlur={addTyped} placeholder="Type an email and press Enter" aria-label="Add recipient" style={{ ...field, border: 0, flex: 1, minWidth: '180px', height: '26px' }} />
              </div>
              {team.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '8px' }}>
                  {team.filter((m) => m.email).map((m) => {
                    const e = (m.email as string).toLowerCase();
                    const on = form.recipients.includes(e);
                    return <button key={m.user_id} type="button" onClick={() => set({ recipients: on ? form.recipients.filter((x) => x !== e) : [...form.recipients, e] })} style={btn.chip(on)}>{m.full_name || e}</button>;
                  })}
                </div>
              ) : null}
            </div>
            <label style={{ display: 'block', marginTop: '12px' }}><span style={eyebrow}>Message (optional)</span><textarea value={form.message ?? ''} onChange={(e) => set({ message: e.target.value || null })} rows={3} placeholder="A line above the report in the email" style={{ ...field, height: 'auto', padding: '8px 9px', resize: 'vertical' }} /></label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" onClick={onBack} style={btn.ghost}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy !== null} style={btn.accent}>{busy === 'save' ? 'Saving…' : form.frequency === 'none' ? 'Save' : 'Save and schedule'}</button>
          </div>
          <p style={{ fontSize: '11.5px', color: MUTED, lineHeight: 1.5, margin: 0, borderTop: `1px solid ${SOFT}`, paddingTop: '10px' }}>
            The email is sent by CLOZR through Resend from the company address (MAIL_FROM on the project); the From email above is used as Reply-To. The mailer runs hourly, so a report goes out within the hour after its scheduled time. <span style={{ color: INK }}>Private reports</span> are sent too — a schedule is set by someone who can see the report.
          </p>
        </div>
      </div>
    </div>
  );
}
