// The side panel: one event, read and edited in place, or a new one drafted
// from a slot on the grid or a seller's record.
//
// Attendees are stored on the row; Google emails the invitations when the
// sync pushes the event (sendUpdates=all), and their Yes / No / Maybe comes
// back on the next pull. "Send invite" therefore saves the list and nudges the
// sync — it never sends mail from the browser.
'use client';

import React, { useEffect, useState } from 'react';
import type { Attendee } from '@/lib/database.types';
import {
  type CalEvent, type EventDraft, type Rep, EVENT_TYPES, HOUR, MIRROR_NOTE, createCalendarEvent, deleteCalendarEvent,
  fmtDay, fmtSpan, fromLocalInput, requestInvites, toLocalInput, typeColor, typeOfKind, updateCalendarEvent,
} from '@/lib/calendar';
import { Avatar, Field, INK, LINE, MINT, MUTED, SOFT, SyncDot, ghost, input, primary } from './ui';

export type PanelDraft = Partial<EventDraft> & {
  start?: Date; end?: Date;
  sellerName?: string | null;
  /** Suggested invitees (the seller, the buyer) — shown ticked, editable. */
  suggest?: Attendee[];
};

export type EventPanelProps = {
  workspaceId: number | null;
  userId: string | null;
  reps: Rep[];
  canWrite: boolean;
  /** An existing event to show, or null with `draft` set to create one. */
  event: CalEvent | null;
  draft?: PanelDraft | null;
  onClose: () => void;
  onChanged: () => void;
  onToast?: (msg: string) => void;
  /** Open the linked seller's record, when the host can. */
  onOpenSeller?: (sellerId: number) => void;
  /** Hosted inline (the record) rather than as a side sheet. */
  inline?: boolean;
  /** Told whether the form holds changes not yet saved, so the host can ask before throwing them away. */
  onDirty?: (dirty: boolean) => void;
};

type Form = {
  title: string; kind: string; start: string; end: string; allDay: boolean;
  location: string; notes: string; assigned: string; attendees: Attendee[];
};

const ROLE_LABEL: Record<NonNullable<Attendee['role']>, string> = { seller: 'Seller', buyer: 'Buyer', vendor: 'Vendor', rep: 'Rep', other: 'Guest' };
const ANSWER: Record<NonNullable<Attendee['status']>, { text: string; color: string }> = {
  accepted: { text: 'Yes', color: '#16a34a' }, declined: { text: 'No', color: '#b91c1c' },
  tentative: { text: 'Maybe', color: '#d97706' }, needsAction: { text: 'Invited', color: '#a1a1aa' },
};

function formFrom(ev: CalEvent | null, d: PanelDraft | null | undefined, userId: string | null): Form {
  if (ev) {
    return {
      title: ev.title, kind: ev.kind, start: toLocalInput(ev.start), end: toLocalInput(ev.end), allDay: ev.allDay,
      location: ev.address ?? '', notes: ev.notes ?? '', assigned: ev.repId ?? userId ?? '', attendees: ev.attendees,
    };
  }
  const start = d?.start ?? (d?.starts_at ? new Date(d.starts_at) : roundUp(new Date()));
  const end = d?.end ?? (d?.ends_at ? new Date(d.ends_at) : new Date(start.getTime() + HOUR));
  return {
    title: d?.title ?? '', kind: d?.kind ?? 'Appointment', start: toLocalInput(start), end: toLocalInput(end), allDay: !!d?.all_day,
    location: d?.location ?? '', notes: d?.notes ?? '', assigned: d?.assigned_to ?? userId ?? '',
    attendees: d?.attendees ?? d?.suggest ?? [],
  };
}

function roundUp(d: Date): Date {
  const x = new Date(d); x.setSeconds(0, 0);
  x.setMinutes(Math.ceil(x.getMinutes() / 30) * 30);
  return x;
}

export function EventPanel(p: EventPanelProps) {
  const { workspaceId, userId, reps, canWrite, event, draft, onClose, onChanged, onToast, onOpenSeller, inline, onDirty } = p;
  // A mirror of one of the member's own Google calendars is shown, not edited:
  // CLOZR reads those and never writes to them, so Edit and Delete would either
  // be reverted by the next sync or, on a delete, cancel a real meeting and
  // mail every guest. lib/calendar.ts refuses the write as well; this is what
  // stops it being offered in the first place.
  const mayEdit = canWrite && !event?.readOnly;
  const creating = !event;
  // A task's due time and a deal's close date are shown here, not edited: no invites, no Edit or Delete.
  const isTask = event?.source === 'task' || event?.source === 'deal';
  const isClose = event?.source === 'deal';
  const [editing, setEditing] = useState(creating);
  // The host keys the panel by event id (or the draft's slot), so a different
  // event is a fresh panel rather than a form that has to notice the swap.
  const [form, setForm] = useState<Form>(() => formFrom(event, draft, userId));
  // What the form held when it opened (or was last saved): anything else is unsaved.
  const [opened, setOpened] = useState(form);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const dirty = editing && (!!inviteEmail.trim() || JSON.stringify(form) !== JSON.stringify(opened));
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const rep = reps.find((r) => r.user_id === (event?.repId ?? form.assigned));
  const type = typeOfKind(form.kind);
  const toast = (m: string) => onToast?.(m);

  const draftToWrite = (): EventDraft | null => {
    if (!form.title.trim() && !form.kind) return null;
    const s = fromLocalInput(form.start);
    let e = fromLocalInput(form.end);
    if (!(e > s)) e = new Date(s.getTime() + HOUR);
    return {
      title: form.title.trim() || form.kind, kind: form.kind, starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: form.allDay,
      location: form.location, notes: form.notes, assigned_to: form.assigned || userId, attendees: form.attendees,
      seller_id: event?.sellerId ?? draft?.seller_id ?? null, buyer_id: event?.buyerId ?? draft?.buyer_id ?? null,
    };
  };

  async function save() {
    if (!workspaceId) return toast('Sign in to save appointments.');
    const d = draftToWrite();
    if (!d) return setNote({ ok: false, text: 'Give it a title.' });
    setBusy('save');
    const r = creating ? await createCalendarEvent(workspaceId, d, userId) : await updateCalendarEvent(workspaceId, event!.dbId, d);
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    toast(creating ? (d.attendees?.length ? 'Appointment set · invites go out with the next sync' : 'Appointment set') : 'Saved');
    onChanged();
    setOpened(form);
    if (creating) onClose(); else setEditing(false);
  }

  async function remove() {
    if (!workspaceId || !event || !window.confirm('Delete this appointment? It is removed from Google Calendar too, and anyone invited is told.')) return;
    setBusy('delete');
    const r = await deleteCalendarEvent(workspaceId, event.dbId);
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    toast('Deleted');
    onChanged(); onClose();
  }

  function addAttendee(a?: Attendee) {
    const email = (a?.email ?? inviteEmail).trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setNote({ ok: false, text: 'That is not an email address.' });
    if (form.attendees.some((x) => x.email === email)) { setInviteEmail(''); return; }
    set('attendees', [...form.attendees, { email, name: a?.name ?? null, role: a?.role ?? 'other', status: 'needsAction' }]);
    setInviteEmail(''); setNote(null);
  }

  async function sendInvites() {
    if (!workspaceId) return toast('Sign in to send invites.');
    if (creating) return save();
    setBusy('invite');
    const r = await requestInvites(workspaceId, event!.dbId, form.attendees);
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setNote({ ok: true, text: 'Saved. Google emails the invitations on the next sync — usually within a few seconds.' });
    onChanged();
  }

  const shell: React.CSSProperties = inline
    ? { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', display: 'flex', flexDirection: 'column', minWidth: 0 }
    : { width: '340px', flex: 'none', background: '#fff', borderLeft: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column', minHeight: 0 };

  return (
    <aside style={shell}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 14px', borderBottom: `1px solid ${SOFT}` }}>
        <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: typeColor(type), flex: 'none' }} />
        <span style={{ fontSize: '13px', fontWeight: 700, color: INK, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {creating ? 'New appointment' : isClose ? 'Closing' : isTask ? 'Task due' : editing ? 'Edit appointment' : event!.title}
        </span>
        {!creating && !isTask ? <SyncDot state={event!.syncState} /> : null}
        <button type="button" className="dc2" onClick={onClose} aria-label="Close" style={{ ...ghost, height: '26px', width: '26px', padding: 0, justifyContent: 'center', borderRadius: '7px' }}>×</button>
      </div>

      <div style={{ padding: '12px 14px', overflow: 'auto', flex: 1 }}>
        {editing ? (
          <>
            <Field title="Title">
              <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={form.kind === 'Walkthrough' ? 'Walkthrough with the seller' : 'Appointment'} style={input} autoFocus />
            </Field>
            <Field title="Type">
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {EVENT_TYPES.filter((t) => t.key !== 'task').map((t) => (
                  <button key={t.key} type="button" onClick={() => set('kind', t.kind)} style={{
                    height: '26px', padding: '0 9px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${typeOfKind(form.kind) === t.key ? INK : LINE}`, background: typeOfKind(form.kind) === t.key ? INK : '#fff', color: typeOfKind(form.kind) === t.key ? '#fff' : INK,
                  }}>{t.label}</button>
                ))}
              </div>
            </Field>
            <Field title="Starts"><input type="datetime-local" value={form.start} onChange={(e) => set('start', e.target.value)} style={{ ...input, minWidth: 0 }} /></Field>
            <Field title="Ends"><input type="datetime-local" value={form.end} onChange={(e) => set('end', e.target.value)} style={{ ...input, minWidth: 0 }} /></Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', color: INK, margin: '-4px 0 10px', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} style={{ accentColor: MINT }} /> All day
            </label>
            <Field title="Where">
              <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder={draft?.sellerName ? 'The property address' : 'Address'} style={input} />
            </Field>
            {reps.length > 1 ? (
              <Field title="Whose calendar">
                <select value={form.assigned} onChange={(e) => set('assigned', e.target.value)} style={{ ...input, appearance: 'auto' }}>
                  {reps.map((r) => <option key={r.user_id} value={r.user_id}>{r.full_name}</option>)}
                </select>
              </Field>
            ) : null}
            <Field title="Notes">
              <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} style={{ ...input, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.45 }} />
            </Field>
          </>
        ) : (
          <>
            <Row k="When" v={`${fmtDay(event!.start)} · ${fmtSpan(event!)}`} />
            {event!.address ? <Row k="Where" v={event!.address} /> : null}
            {event!.sellerName ? (
              <Row k="Who" v={event!.sellerId && onOpenSeller ? (
                <button type="button" onClick={() => onOpenSeller(event!.sellerId!)} style={{ background: 'none', border: 0, padding: 0, color: MINT, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>{event!.sellerName} →</button>
              ) : event!.sellerName} />
            ) : null}
            {rep ? <Row k="Calendar" v={<span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Avatar initials={rep.initials} color={rep.color} size={16} />{rep.full_name}</span>} /> : null}
            {event!.notes ? <Row k="Notes" v={<span style={{ whiteSpace: 'pre-wrap' }}>{event!.notes}</span>} /> : null}
            {isClose ? <Row k="Deal" v={event!.kind} /> : isTask ? <Row k="Type" v={`${event!.kind} · ${event!.done ? 'done' : 'open'}`} /> : null}
            {event!.friday ? <p role="alert" style={{ margin: '4px 0 8px', fontSize: '12px', color: '#b91c1c', fontWeight: 600, lineHeight: 1.45 }}>Friday close. Closings are Monday to Thursday.</p> : null}
            {event!.fromGoogle ? <Row k="Source" v="Made in Google Calendar" /> : null}
            {event!.readOnly ? (
              <p style={{ margin: '4px 0 8px', fontSize: '12px', color: MUTED, lineHeight: 1.45 }}>{MIRROR_NOTE}</p>
            ) : null}
            {event!.syncState === 'error' ? <p style={{ margin: '4px 0 8px', fontSize: '12px', color: '#b91c1c' }}>Google refused the last sync. Sync now to retry.</p> : null}
          </>
        )}

        {!isTask ? (
          <div style={{ marginTop: '6px', paddingTop: '10px', borderTop: `1px solid ${SOFT}` }}>
            <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '6px' }}>Invited</span>
            {form.attendees.length ? form.attendees.map((a) => (
              <div key={a.email} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12.5px' }}>
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: INK }}>
                  {a.name ? <>{a.name} <span style={{ color: MUTED }}>{a.email}</span></> : a.email}
                </span>
                <span style={{ fontSize: '11px', color: MUTED }}>{ROLE_LABEL[a.role ?? 'other']}</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: ANSWER[a.status ?? 'needsAction'].color }}>{ANSWER[a.status ?? 'needsAction'].text}</span>
                {mayEdit ? <button type="button" onClick={() => set('attendees', form.attendees.filter((x) => x.email !== a.email))} aria-label="Remove" style={{ background: 'none', border: 0, color: '#a1a1aa', cursor: 'pointer', padding: '0 2px', fontSize: '14px', lineHeight: 1 }}>×</button> : null}
              </div>
            )) : <p style={{ margin: '0 0 6px', fontSize: '12px', color: '#a1a1aa' }}>Nobody yet. Add the seller, a buyer or a vendor by email.</p>}
            {draft?.suggest?.filter((s) => !form.attendees.some((a) => a.email === s.email)).map((s) => (
              <button key={s.email} type="button" className="dc2" onClick={() => addAttendee(s)} style={{ ...ghost, height: '26px', fontSize: '12px', marginRight: '6px', marginTop: '4px' }}>+ {s.name ?? s.email}</button>
            ))}
            {mayEdit ? (
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAttendee(); } }} placeholder="name@example.com" style={{ ...input, height: '30px' }} />
                <button type="button" className="dc2" onClick={() => addAttendee()} style={{ ...ghost, height: '30px' }}>Add</button>
              </div>
            ) : null}
            {!creating && mayEdit ? (
              <button type="button" className="dc3" onClick={() => void sendInvites()} disabled={busy !== null || !form.attendees.length} style={{ ...primary, height: '30px', marginTop: '8px', opacity: form.attendees.length ? 1 : 0.5 }}>
                {busy === 'invite' ? 'Saving…' : 'Send invite'}
              </button>
            ) : null}
            <p style={{ margin: '8px 0 0', fontSize: '11.5px', color: '#a1a1aa', lineHeight: 1.45 }}>Invitations come from your Google Calendar, with Yes / No / Maybe; answers show here.</p>
          </div>
        ) : null}

        {note ? <p style={{ margin: '10px 0 0', fontSize: '12px', color: note.ok ? MINT : '#b91c1c' }}>{note.text}</p> : null}
      </div>

      {mayEdit && !isTask ? (
        <div style={{ display: 'flex', gap: '6px', padding: '10px 14px', borderTop: `1px solid ${SOFT}` }}>
          {editing ? (
            <>
              <button type="button" className="dc3" onClick={() => void save()} disabled={busy !== null} style={primary}>{busy === 'save' ? 'Saving…' : creating ? 'Add to calendar' : 'Save'}</button>
              <button type="button" className="dc2" onClick={() => (creating ? onClose() : setEditing(false))} style={ghost}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="dc2" onClick={() => setEditing(true)} style={ghost}>Edit</button>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => void remove()} disabled={busy !== null} style={{ ...ghost, color: '#b91c1c', borderColor: '#fecaca' }}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: '8px', padding: '5px 0', fontSize: '12.5px', alignItems: 'start' }}>
      <span style={{ color: MUTED }}>{k}</span>
      <span style={{ color: INK, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}
