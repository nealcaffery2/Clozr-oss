'use client';

// Send meeting invite: pick a meeting type, a time, send. The event goes on
// the rep's Google Calendar with a Google Meet link; the person gets our
// designed email (Join Google Meet, add to calendar) and a text with the time
// and link, plus Google's own invitation.
//
// One modal for every way in (a seller record, a buyer or Compr contact, the
// live call): a module store like the quick reach box (../record/reach.ts),
// and one host mounted on the shell. On a call it opens over the call
// surface, so the rep books and sends without hanging up.

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusTrap } from '@/app/components/record/useModal';
import { supabase } from '@/lib/supabase';
import { openReach } from '@/app/components/record/reach';
import { GX_CSS, ICON, INK, INK_2, Icon, LINE, MUTED, HAIR, RED, SHADOW, Field, Pill, Toggle, btn, input } from '@/components/genius/parts';
import {
  DEFAULT_MEETING_TYPES, type InviteRequest, type InviteResult, type MeetingType, browserZone, formatWhen, fromInputs, inviteSms,
  bookingMessage, bookingUrlFor, loadMeetingTypes, quickSlots, sendMeetingInvite, toInputs, zoneForPhone,
} from '@/lib/meeting-invite';

export type MeetingTarget = {
  name: string;
  email?: string | null;
  phone?: string | null;
  sellerId?: number | null;
  buyerId?: number | null;
  /** The property, for a walkthrough or comp analysis title. */
  address?: string | null;
  /** Which type to start on (a call defaults to the first). */
  typeKey?: string;
  onSent?: (r: InviteResult) => void;
};

type State = { target: MeetingTarget; nonce: number } | null;
let state: State = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openMeetingInvite(target: MeetingTarget) {
  state = { target, nonce: (state?.nonce ?? 0) + 1 };
  emit();
}
export function closeMeetingInvite() {
  if (!state) return;
  state = null;
  emit();
}
const useMeetingInvite = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state, () => null);

/** Mounted once on the shell. */
export function MeetingInviteHost({ workspaceId, company, repName, isMobile, canWrite, toast }: {
  workspaceId: number | null; company: string; repName: string; isMobile: boolean; canWrite: boolean;
  toast: (msg: string, tone?: 'success' | 'error') => void;
}) {
  const s = useMeetingInvite();
  // The sent email and text brand with settings.company.name, else the workspace name
  // (meeting-invite), so the preview reads the same value.
  const [brand, setBrand] = useState<{ ws: number; name: string; booking: string | null } | null>(null);
  useEffect(() => {
    if (workspaceId == null || !supabase) return;
    let alive = true;
    void supabase.from('workspaces').select('name, settings').eq('id', workspaceId).maybeSingle().then(({ data }) => {
      const row = data as { name?: string | null; settings?: { company?: { name?: string | null }; buyer_profile?: string; compr_lifecycle?: { booking_url?: string } } | null } | null;
      const name = (row?.settings?.company?.name ?? '').trim() || (row?.name ?? '').trim();
      if (alive) setBrand({ ws: workspaceId, name, booking: bookingUrlFor(row?.settings) });
    });
    return () => { alive = false; };
  }, [workspaceId]);
  if (!s) return null;
  const mine = brand && brand.ws === workspaceId ? brand : null;
  const shownCompany = mine?.name || company;
  return (
    <MeetingInviteModal key={s.nonce} target={s.target} workspaceId={workspaceId} company={shownCompany} repName={repName} bookingUrl={mine?.booking ?? null}
      isMobile={isMobile} canWrite={canWrite} onClose={closeMeetingInvite}
      send={sendMeetingInvite}
      onSent={(r) => { s.target.onSent?.(r); toast(`Invite sent to ${s.target.name || 'them'}`, 'success'); }} />
  );
}

const CAL_ICON = 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
const VIDEO_ICON = 'm16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z';
const ALERT_ICON = 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z';

export const CalendarIcon = ({ size = 14 }: { size?: number }) => <Icon d={CAL_ICON} size={size} />;

const MI_CSS = `${GX_CSS}
[data-mi] input[type=date],[data-mi] input[type=time],[data-mi] input[type=email],[data-mi] input[type=tel],[data-mi] textarea{font:inherit;font-size:13px;color:${INK};font-variant-numeric:tabular-nums}
[data-mi] ::selection{background:var(--c-action-soft, #e7f5ef);color:${INK}}
@media (max-width:640px){[data-mi] input,[data-mi] textarea{font-size:16px!important}}
@keyframes mi-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
@keyframes mi-up{from{transform:translateY(16px);opacity:.6}to{transform:none;opacity:1}}
[data-mi-card]{animation:mi-in 200ms cubic-bezier(.23,1,.32,1)}
[data-mi-card][data-sheet]{animation:mi-up 240ms cubic-bezier(.23,1,.32,1)}
@media (prefers-reduced-motion:reduce){[data-mi-card]{animation:none!important}}
`;

type Phase = { kind: 'form' } | { kind: 'sending' } | { kind: 'error'; message: string; code?: string } | { kind: 'sent'; result: InviteResult };

/** The modal itself. Props only, so a harness can render every state without the shell. */
export function MeetingInviteModal({ target, workspaceId, company, repName, bookingUrl = null, isMobile, canWrite = true, onClose, send, onSent, initialPhase, now: nowProp, types: typesProp }: {
  target: MeetingTarget; workspaceId: number | null; company: string; repName: string; isMobile: boolean; canWrite?: boolean;
  /** Shows "let them pick the time" with this page. */
  bookingUrl?: string | null;
  onClose: () => void;
  send: (r: InviteRequest) => Promise<{ ok: true; data: InviteResult } | { ok: false; message: string; code?: string }>;
  onSent?: (r: InviteResult) => void;
  /** Harness only. */
  initialPhase?: Phase; now?: Date; types?: MeetingType[];
}) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose, '[data-mi-first]');
  const [types, setTypes] = useState<MeetingType[] | null>(typesProp ?? null);
  useEffect(() => {
    if (typesProp) return;
    let alive = true;
    loadMeetingTypes(workspaceId).then((t) => { if (alive) setTypes(t); }).catch(() => { if (alive) setTypes([...DEFAULT_MEETING_TYPES]); });
    return () => { alive = false; };
  }, [workspaceId, typesProp]);
  const list = types ?? [];
  const [typeKey, setTypeKey] = useState(target.typeKey ?? '');
  const type = list.find((t) => t.key === typeKey) ?? list[0] ?? null;

  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const slots = useMemo(() => quickSlots(now), [now]);
  const [when, setWhen] = useState(() => toInputs(slots[1].at));
  const start = fromInputs(when.date, when.time);
  const [email, setEmail] = useState(target.email && target.email.includes('@') ? target.email : '');
  const [phone, setPhone] = useState(target.phone && target.phone !== '—' ? target.phone : '');
  const [byEmail, setByEmail] = useState(!!(target.email && target.email.includes('@')));
  const [bySms, setBySms] = useState(!!(target.phone && target.phone !== '—'));
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>(initialPhase ?? { kind: 'form' });

  const repTz = browserZone();
  const theirTz = zoneForPhone(phone);
  const minutes = type?.minutes ?? 30;
  const mine = start ? formatWhen(start.toISOString(), minutes, repTz) : null;
  const theirs = start && theirTz && theirTz !== repTz ? formatWhen(start.toISOString(), minutes, theirTz) : null;
  const past = !!start && start.getTime() < now.getTime() - 60_000;
  const emailOk = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/.test(email.trim());
  const blocker = !type ? 'Loading meeting types…'
    : !start ? 'Pick a date and a time.'
    : past ? 'That time has passed. Pick a later one.'
    : !byEmail && !bySms ? 'Turn on email, text or both.'
    : byEmail && !emailOk ? 'Add an email address, or turn email off.'
    : bySms && !phone.trim() ? 'Add a mobile number, or turn the text off.'
    : !canWrite ? 'View only: you can look but not send.'
    : null;
  const smsPreview = type && start ? inviteSms({
    recipientName: target.name, repName, company, type, startIso: start.toISOString(), minutes, tz: theirTz ?? repTz, meetLink: 'meet.google.com/…',
  }) : '';

  const submit = async () => {
    if (blocker || phase.kind === 'sending' || !type || !start) return;
    if (workspaceId == null) { setPhase({ kind: 'error', message: 'This is the sample workspace. Open a live workspace to send real invites.' }); return; }
    setPhase({ kind: 'sending' });
    const r = await send({
      workspace_id: workspaceId, meeting_type: type.key, starts_at: start.toISOString(), minutes,
      seller_id: target.sellerId ?? null, buyer_id: target.buyerId ?? null, name: target.name,
      email: byEmail ? email.trim() : '', phone: bySms ? phone.trim() : '',
      recipient_tz: theirTz, rep_tz: repTz, send_email: byEmail, send_sms: bySms, note: note.trim() || null,
      origin: typeof window !== 'undefined' ? window.location.origin : undefined,
    });
    if (!r.ok) { setPhase({ kind: 'error', message: r.message, code: r.code }); return; }
    setPhase({ kind: 'sent', result: r.data });
    onSent?.(r.data);
  };

  const sending = phase.kind === 'sending';
  const first = (target.name || '').split(' ')[0] || 'them';
  const [copied, setCopied] = useState(false);
  const bookingBody = bookingUrl ? bookingMessage({ first: (target.name || '').split(' ')[0] || 'there', repName, company, url: bookingUrl }) : '';
  const handOff = (channel: 'text' | 'email') => {
    const reach = {
      name: target.name, phone: phone.trim() || null, email: email.trim() || null, sellerId: target.sellerId ?? null, buyerId: target.buyerId ?? null,
      subject: channel === 'email' ? `Pick a time with ${(repName || '').split(' ')[0] || company}` : undefined, body: bookingBody,
    };
    // Close first: the focus trap hands focus back to the opener as this
    // dialog unmounts, so the composer opens after that and keeps its caret.
    onClose();
    requestAnimationFrame(() => openReach(channel, reach));
  };
  const copyBooking = async () => {
    if (!bookingUrl) return;
    try { await navigator.clipboard.writeText(bookingUrl); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the link shows in the title to copy by hand */ }
  };

  return (
    <div data-gx data-mi onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 170, background: 'rgba(24,24,27,.38)', display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : '24px' }}>
      <style>{MI_CSS}</style>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="mi-title" data-mi-card data-sheet={isMobile ? '' : undefined}
        style={{ background: 'var(--surface, #fff)', width: isMobile ? '100%' : 'min(520px, 100%)', maxHeight: isMobile ? '94dvh' : '90vh', borderRadius: isMobile ? '16px 16px 0 0' : '14px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: SHADOW.lg, color: INK }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px 12px', borderBottom: `1px solid ${HAIR}` }}>
          <span aria-hidden style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--c-action-soft, #e7f5ef)', color: 'var(--tx-mint, #0a8560)', display: 'grid', placeItems: 'center', flex: 'none' }}><Icon d={VIDEO_ICON} size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="mi-title" style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.2 }}>Send meeting invite</h2>
            <div style={{ fontSize: '12px', color: MUTED, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={target.name}>
              {target.name ? <>To <b style={{ color: INK_2, fontWeight: 600 }}>{target.name}</b> · </> : null}Google Meet on your calendar
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" disabled={sending}
            style={{ ...btn('ghost', true), width: 32, height: 32, padding: 0, boxShadow: 'none', color: MUTED }}><Icon d={ICON.x} size={16} /></button>
        </div>

        {phase.kind === 'sent' ? (
          <Sent result={phase.result} name={target.name} onClose={onClose} />
        ) : (
          <>
            <div style={{ overflow: 'auto', flex: 1, padding: '14px 16px 4px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div role="group" aria-labelledby="mi-type-label" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span id="mi-type-label" style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>Meeting type</span>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', minHeight: 28 }} aria-busy={!types}>
                  {!types ? [64, 92, 104, 88, 76].map((w, i) => <span key={i} aria-hidden style={{ width: w, height: 28, borderRadius: 8, background: 'var(--surface-2, #f4f4f5)' }} />)
                    : list.map((t) => (
                      <Pill key={t.key} on={type?.key === t.key} onClick={() => setTypeKey(t.key)}>
                        {t.name}<span style={{ color: type?.key === t.key ? 'rgba(255,255,255,.78)' : MUTED, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{t.minutes} min</span>
                      </Pill>
                    ))}
                </div>
                {type ? <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.45, color: INK_2 }}>{type.description.replace(/\{company\}/g, company).replace(/\{\w+\}/g, '').trim()}</p> : null}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: '8px' }}>
                  <Field label="Date">
                    <input data-mi-first type="date" value={when.date} min={toInputs(now).date} onChange={(e) => setWhen((w) => ({ ...w, date: e.target.value }))} style={{ ...input, height: 36 }} />
                  </Field>
                  <Field label="Time">
                    <input type="time" step={900} value={when.time} onChange={(e) => setWhen((w) => ({ ...w, time: e.target.value }))} style={{ ...input, height: 36 }} />
                  </Field>
                </div>
                <div role="group" aria-label="Quick times" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {slots.map((s) => {
                    const v = toInputs(s.at);
                    return <Pill key={s.key} on={v.date === when.date && v.time === when.time} onClick={() => setWhen(v)}>{s.label}</Pill>;
                  })}
                </div>
                <div role="status" style={{ fontSize: '12px', color: MUTED, fontVariantNumeric: 'tabular-nums', lineHeight: 1.45 }}>
                  {mine ? <><span style={{ color: INK_2, fontWeight: 600 }}>{mine.day}, {mine.time}</span>{theirs ? <> · {first} sees {theirs.time}</> : null}</> : 'Pick a date and a time.'}
                </div>
                {bookingUrl ? (
                  <div role="group" aria-label="Booking link" data-mi-book style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', paddingTop: '8px', borderTop: `1px dashed ${HAIR}` }}>
                    <span style={{ fontSize: '12px', color: MUTED, marginRight: 2 }}>Or let {first} pick the time:</span>
                    <button type="button" onClick={() => handOff('text')} disabled={!phone.trim() || sending} aria-describedby={phone.trim() ? undefined : 'mi-book-hint'} style={{ ...btn('ghost', true) }}>Text booking link</button>
                    <button type="button" onClick={() => handOff('email')} disabled={!emailOk || sending} aria-describedby={emailOk ? undefined : 'mi-book-hint'} style={{ ...btn('ghost', true) }}>Email it</button>
                    <button type="button" onClick={() => void copyBooking()} title={bookingUrl} aria-live="polite" style={{ ...btn('ghost', true), color: copied ? 'var(--tx-mint, #0a8560)' : INK }}>{copied ? 'Copied' : 'Copy link'}</button>
                    {!phone.trim() || !emailOk ? (
                      <span id="mi-book-hint" style={{ flexBasis: '100%', fontSize: '11.5px', color: MUTED }}>
                        {!phone.trim() && !emailOk ? 'Add a mobile number or email below to send it.' : !phone.trim() ? 'Add a mobile number below to text it.' : 'Add an email below to email it.'}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: '10px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <Field label="Email">
                    <input type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => { setEmail(e.target.value); if (e.target.value.includes('@')) setByEmail(true); }}
                      aria-invalid={byEmail && !!email && !emailOk} style={{ ...input, height: 36 }} />
                  </Field>
                  <Toggle on={byEmail} onChange={setByEmail}>Email the invite</Toggle>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <Field label="Mobile">
                    <input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => { setPhone(e.target.value); if (e.target.value.trim()) setBySms(true); }} style={{ ...input, height: 36 }} />
                  </Field>
                  <Toggle on={bySms} onChange={setBySms}>Text the time and link</Toggle>
                </div>
              </div>

              <Field label="Note for the email (optional)">
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500}
                  style={{ ...input, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.45 }} />
              </Field>

              {bySms && smsPreview ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>Text preview</span>
                  <p style={{ margin: 0, padding: '8px 10px', borderRadius: 8, background: 'var(--canvas, #fafafa)', border: `1px solid ${HAIR}`, fontSize: '12.5px', lineHeight: 1.45, color: INK_2 }}>{smsPreview}</p>
                </div>
              ) : null}

              {phase.kind === 'error' ? (
                <div role="alert" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: 'var(--tint-red, #fef2f2)', border: '1px solid var(--tint-red-2, #fecaca)', color: RED, fontSize: '12.5px', lineHeight: 1.45 }}>
                  <span style={{ flex: 'none', marginTop: 1 }}><Icon d={ALERT_ICON} size={14} /></span>
                  <span style={{ minWidth: 0 }}>{phase.message}</span>
                </div>
              ) : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', paddingBottom: isMobile ? 'max(12px, env(safe-area-inset-bottom))' : 12, borderTop: `1px solid ${HAIR}`, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 200px', minWidth: 0, fontSize: '12px', lineHeight: 1.4, color: blocker && phase.kind !== 'error' && types ? '#b45309' : MUTED }}>
                {blocker && types ? blocker : 'Google also sends its own calendar invitation for the same meeting.'}
              </span>
              <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
                <button type="button" onClick={onClose} disabled={sending} style={{ ...btn('ghost'), height: 36 }}>Cancel</button>
                <button type="button" onClick={() => void submit()} disabled={!!blocker || sending} aria-disabled={!!blocker || sending}
                  style={{ ...btn('purple'), height: 36, padding: '0 16px', minWidth: 120 }}>
                  {sending ? 'Sending…' : 'Send invite'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Sent({ result, name, onClose }: { result: InviteResult; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!result.meet_link) return;
    try { await navigator.clipboard.writeText(result.meet_link); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the link stays visible to copy by hand */ }
  };
  const lines: { ok: boolean; text: string }[] = [
    { ok: true, text: result.meet_link ? 'On your Google Calendar with a Meet link' : 'On your Google Calendar' },
    ...(result.google_invited ? [{ ok: true, text: 'Google sent its calendar invitation' }] : []),
    ...(result.emailed ? [{ ok: true, text: 'Invite email sent from your Gmail' }] : []),
    ...(result.texted ? [{ ok: true, text: result.meet_link ? 'Text sent with the time and link' : 'Text sent with the time' }] : []),
  ];
  return (
    <>
      <div role="status" style={{ overflow: 'auto', flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <div style={{ fontSize: '13.5px', fontWeight: 650 }}>Invite sent to {name || 'them'}</div>
          <div style={{ fontSize: '12.5px', color: INK_2, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{result.when}</div>
        </div>
        {result.meet_link ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 8px 8px 12px', borderRadius: 8, border: `1px solid ${LINE}` }}>
            <span style={{ color: 'var(--tx-mint, #0a8560)', flex: 'none', display: 'inline-flex' }}><Icon d={VIDEO_ICON} size={15} /></span>
            <a href={result.meet_link} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, fontSize: '13px', color: 'var(--tx-mint, #0a8560)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textUnderlineOffset: 2 }}>
              {result.meet_link.replace(/^https?:\/\//, '')}
            </a>
            <button type="button" onClick={() => void copy()} style={{ ...btn('ghost', true) }} aria-label="Copy the Meet link">
              <Icon d={copied ? ICON.check : 'M8 8h12v12H8zM4 16V4h12'} size={13} />{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : null}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {lines.map((l) => (
            <li key={l.text} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: INK_2 }}>
              <span style={{ color: 'var(--tx-mint, #0a8560)', display: 'inline-flex' }}><Icon d={ICON.check} size={14} /></span>{l.text}
            </li>
          ))}
          {result.warnings.map((w) => (
            <li key={w} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--tx-amber, #b45309)', lineHeight: 1.45 }}>
              <span style={{ display: 'inline-flex', marginTop: 1 }}><Icon d={ALERT_ICON} size={14} /></span>{w}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 16px', borderTop: `1px solid ${HAIR}` }}>
        {result.event_link ? <a href={result.event_link} target="_blank" rel="noreferrer" style={{ ...btn('ghost'), height: 36, textDecoration: 'none' }}>Open in Google Calendar</a> : null}
        <button type="button" onClick={onClose} style={{ ...btn('solid'), height: 36, padding: '0 16px' }}>Done</button>
      </div>
    </>
  );
}
