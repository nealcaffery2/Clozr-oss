'use client';

/**
 * The live-call surface (design 1c centre column, and the same control set the
 * extension shows). In CLOZR it wears the iPhone Phone app's in-call look.
 *
 * Every control here is a real conference operation against the server
 * (docs/telephony-events.md §9); none of it is local-only state.
 *
 * "Add call" and "Transfer" open two different panels on purpose. They look
 * alike but they are opposite intents — adding brings a third party in while
 * the caller waits on hold, transferring hands the caller away and lets the
 * rep leave — and one shared panel meant a warm/blind toggle sat above an
 * "Add" button it never applied to, with nowhere at all to type a number that
 * is not a teammate. The API has taken `to_number` since day one; only this
 * surface never offered it.
 *
 * CLOZR seam (copied from Talkr apps/web/components/ActiveCall.tsx):
 * `useSoftphone` is softphoneAdapter.tsx, and the seller-lead badge and avatar
 * also read the CLOZR record on the line.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, HangupIcon } from './Icon';
import { Avatar, Eyebrow } from './ui';
import { IosSegmented, PhoneSheet } from './ios';
import { ProspectTime } from './ProspectTime';
import { useSoftphone } from './softphoneAdapter';
import { api, type ContactDto, type ParticipantDto, type TeamMemberDto } from '@/lib/talkr-web/api';
import { duration, formatPhone, toE164, tzTime, zoneForNumber } from '@/lib/talkr-web/time';
import { isIOSDevice } from '@/lib/phone-audio';
import { Keys, formatDialed } from './DialerParts';
import { VmDropButton } from './VmDropButton';

const PILL: React.CSSProperties = {
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--text)',
  borderRadius: 999,
  font: '600 12px/1 var(--sans)',
  padding: '11px 15px',
  cursor: 'pointer',
};

const ON: React.CSSProperties = { background: 'var(--accent)', color: '#fff', borderColor: 'transparent' };

/** The one text-field look inside the call surface. */
const FIELD_LIGHT: React.CSSProperties = {
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--text)',
  borderRadius: 999,
  padding: '11px 13px',
  font: '500 13px/1 var(--sans)',
  outline: 'none',
};

const PANEL: React.CSSProperties = {
  background: 'var(--bg)',
  borderRadius: 'var(--r-card)',
};

const ROW_LINE = '1px solid var(--line-soft)';

/**
 * The server refuses a control with a machine code, never a sentence
 * (`ControlRefusal` in packages/core, plus the route's own 400/403/404s). A
 * rep mid-call should not have to read `nothing_to_merge`, so every code the
 * API can return is spelled out here and anything unrecognised falls back to
 * a plain apology rather than leaking the identifier onto the screen.
 */
const REFUSAL_SENTENCES: Record<string, string> = {
  call_not_active: 'That call already ended.',
  no_agent: 'You are not on this call any more.',
  no_customer: 'The caller has already dropped off.',
  nothing_to_merge: 'Nobody to merge yet — add someone first.',
  already_merged: 'Everyone is already in the same conversation.',
  already_held: 'That caller is already on hold.',
  not_held: 'Nobody is on hold right now.',
  participant_not_found: 'That person has already left the call.',
  cannot_remove_agent: 'You cannot drop yourself — use End call.',
  invalid_body: 'That does not look like a phone number. Check it and try again.',
  not_found: 'That call is no longer on the server.',
  forbidden: 'That call belongs to someone else.',
  backend_unreachable: 'Cannot reach Talkr right now — check your connection.',
};

/** Capitalise and full-stop a server sentence so it reads like everything else. */
function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const head = `${t[0]!.toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/** A refusal in the rep's words. Never returns a code, however odd the input. */
function controlSentence(code: string | null, raw: string | null): string | null {
  if (!code && !raw) return null;
  const mapped = code ? REFUSAL_SENTENCES[code] : undefined;
  if (mapped) return mapped;
  // `invalid_target` is the one refusal whose message the server already wrote
  // for a person ("Dana Reyes has not enabled their softphone yet").
  if (code === 'invalid_target' && raw) return asSentence(raw);
  return 'That did not go through. Try again in a moment.';
}

/** True for the North American shapes `formatPhone` is actually written for. */
function isNanp(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/**
 * Format for display, leaving anything non-NANP exactly as it came —
 * `formatPhone` groups 3-3-4, which silently truncates a longer country's
 * number rather than showing it wrong-but-whole.
 */
function displayNumber(raw: string): string {
  return isNanp(raw) ? formatPhone(raw) : raw;
}

/**
 * Format the dial field as the rep types (DialerParts' formatDialed, shared
 * with the phone's keypad). Letters mean they are searching for a contact by
 * name, and an explicit `+` means they know their own country code; both are
 * left exactly as typed.
 */
const formatAsTyped = formatDialed;

/** The number to dial for a contact, primary first. */
function contactNumber(c: ContactDto): string | null {
  return (
    c.primary_phone ??
    c.phones.find((p) => p.is_primary)?.phone_e164 ??
    c.phones[0]?.phone_e164 ??
    null
  );
}

/** A party's name, or their number formatted when the label *is* a number. */
function partyName(p: ParticipantDto): string {
  const raw = p.label ?? p.address ?? '';
  return displayNumber(raw) || 'Unknown';
}

const ROLE_LABELS: Record<ParticipantDto['role'], string> = {
  agent: 'You',
  customer: 'Caller',
  teammate: 'Teammate',
  external: 'Added number',
  supervisor: 'Supervisor',
};

const STATE_LABELS: Record<ParticipantDto['state'], string> = {
  ringing: 'Ringing',
  joined: 'Connected',
  on_hold: 'On hold',
  left: 'Left',
};

const STATE_COLORS: Record<ParticipantDto['state'], string> = {
  ringing: 'var(--amber)',
  joined: 'var(--green)',
  on_hold: 'var(--amber)',
  left: 'var(--muted-2)',
};

function presenceColor(presence: string): string {
  if (presence === 'available') return 'var(--green)';
  if (presence === 'away') return 'var(--amber)';
  return 'var(--muted-2)';
}

/** A ring that turns while a leg is still dialling. Global CSS stills it under prefers-reduced-motion. */
function RingingSpinner({ size = 11 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: '2px solid rgba(0,0,0,.12)',
        borderTopColor: 'var(--amber)',
      }}
      aria-hidden
    />
  );
}

function ControlButton({
  icon,
  label,
  active,
  onClick,
  disabled,
  disabledReason,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Why the control is unavailable. Shown on hover — never a silent dead button. */
  disabledReason?: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={Boolean(active)}
      title={disabled ? disabledReason : undefined}
      className="ios-ctl"
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
  // A disabled button swallows its own pointer events in several browsers, so
  // the reason hangs on a wrapper the cursor can still reach.
  return disabled && disabledReason ? (
    <span className="inline-flex justify-center" title={disabledReason}>
      {button}
    </span>
  ) : (
    button
  );
}

/** One teammate, with whatever action the surrounding panel offers. */
function TeammateRow({
  member,
  now,
  children,
}: {
  member: TeamMemberDto;
  now: number | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 py-2"
      style={{ borderBottom: '1px solid var(--line)' }}
    >
      <Avatar name={member.display_name} size={28}  />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate" style={{ font: '600 12px/1 var(--sans)', color: 'var(--text)' }}>
          {member.display_name}
        </span>
        <span className="truncate" style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted)' }}>
          {member.role}
          {member.city ? ` · ${member.city}` : ''}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <span style={{ font: '600 11px/1 var(--sans)', color: 'var(--text)' }}>
          {member.timezone && now !== null ? tzTime(member.timezone, now) : '—'}
        </span>
        <span
          className="inline-flex items-center gap-1"
          style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted)' }}
        >
          <span
            style={{ width: 5, height: 5, background: presenceColor(member.presence) }}
            aria-hidden
          />
          {member.presence}
        </span>
      </span>
      {children}
    </div>
  );
}

/** Hairline rule with a caption, splitting the two ways to pick someone. */
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-1" style={{ height: 1, background: 'var(--line)' }} aria-hidden />
      <Eyebrow>{label}</Eyebrow>
      <span className="flex-1" style={{ height: 1, background: 'var(--line)' }} aria-hidden />
    </div>
  );
}

/**
 * The mics or the speakers, the live one ticked. A label is only "Default" or
 * blank until the browser has been allowed the mic once, so the empty case
 * says what to do rather than showing an empty box.
 */
function DeviceList({ title, devices, activeId, empty, onPick }: {
  title: string;
  devices: { deviceId: string; label: string }[];
  activeId: string | null;
  empty: string;
  onPick: (deviceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{title}</Eyebrow>
      {devices.length === 0 ? (
        <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>{empty}</p>
      ) : (
        devices.map((d) => {
          const on = d.deviceId === activeId || (!activeId && d.deviceId === 'default');
          return (
            <button
              key={d.deviceId}
              type="button"
              onClick={() => onPick(d.deviceId)}
              className="flex items-center gap-2 px-3 py-2 text-left"
              style={{
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                background: on ? 'var(--accent-soft)' : 'var(--panel)',
                borderRadius: 'var(--r-btn)', cursor: 'pointer',
              }}
            >
              <span className="mr-auto truncate" style={{ font: '500 12px/1.3 var(--sans)' }}>{d.label}</span>
              {on && <Icon name="check" size={13} style={{ color: 'var(--accent)', flex: 'none' }} />}
            </button>
          );
        })
      )}
    </div>
  );
}

type Panel = 'none' | 'add' | 'transfer' | 'audio' | 'more';

export function ActiveCall({
  team,
  onText,
  recording,
  variant = 'card',
  peek,
  onContext,
  onOpenRecord,
  callerId,
  sessionRows,
}: {
  team: TeamMemberDto[];
  /**
   * Open the thread with the party on the line. Optional: the Dialer screen
   * has the inbox a click away, the slide-out panel does not.
   */
  onText?: (e164: string) => void;
  /** True when this org records calls, so the rep can see that it is happening. */
  recording?: boolean;
  /**
   * 'card' (the default) is the desk's in-call card. 'phone' is the
   * full-screen phone's call screen (PhoneScreen.tsx): six round controls,
   * End always on screen, and every panel in a sheet instead of below.
   */
  variant?: 'card' | 'phone';
  /** Phone: the glass card between the caller and the controls (the next question, the last line said). */
  peek?: ReactNode;
  /** Phone: open the call's context sheet, on a tab ('notes' for the notes). */
  onContext?: (tab?: 'notes') => void;
  /** Phone: More → Open lead record (the host minimises first). */
  onOpenRecord?: () => void;
  /** Phone: the caller ID the call went out on, for the meta line. */
  callerId?: string;
  /** Phone: the power dialer's Pause / End session rows, for More. */
  sessionRows?: ReactNode;
}) {
  const {
    active,
    callState,
    serverStatus,
    participants,
    onHold,
    merged,
    controlError,
    controlErrorCode,
    hangup,
    toggleMute,
    toggleHold,
    sendDigit,
    addParticipant,
    merge,
    dropParticipant,
    transfer,
    completeTransfer,
    audioDevices,
    activeAudioDeviceId,
    selectAudioDevice,
    inputDevices,
    activeInputDeviceId,
    selectInputDevice,
    speakerOn,
    toggleSpeaker,
    record,
    openTalkrSettings,
  } = useSoftphone();

  const [elapsed, setElapsed] = useState(0);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [dtmf, setDtmf] = useState('');
  const [panel, setPanel] = useState<Panel>('none');
  const [mode, setMode] = useState<'warm' | 'blind'>('warm');
  /** A live (warm) transfer is under way: the rep is talking to the target, the caller is on hold. */
  const [warmPending, setWarmPending] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  /** Phone: why a control did nothing, shown inline for 3s (touch has no hover title). */
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(t);
  }, [hint]);

  // ── The Add-call number field ─────────────────────────────────────────────
  const [target, setTarget] = useState('');
  const [matches, setMatches] = useState<ContactDto[]>([]);
  /** The value a contact row just filled in, so the search does not re-open on it. */
  const [picked, setPicked] = useState<string | null>(null);
  const [dialing, setDialing] = useState(false);
  const targetRef = useRef<HTMLInputElement>(null);

  const startedAt = active?.startedAt ?? null;
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      // A held call is still connected; the timer keeps running, as it does on
      // every phone the rep has ever used.
      if (startedAt) setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  /**
   * Contact lookup for the number field. Debounced, and deliberately
   * best-effort: a failed search leaves `matches` empty so plain number entry
   * still works, which is the whole point of the field.
   */
  useEffect(() => {
    const q = target.trim();
    if (panel !== 'add' || q.length < 3 || q === picked) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .listContacts({ q, limit: 6, has_phone: true })
        .then((res) => {
          if (!cancelled) setMatches(res.contacts.filter((c) => contactNumber(c) !== null));
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [target, panel, picked]);

  const live = useMemo(() => participants.filter((p) => p.state !== 'left'), [participants]);
  const guests = useMemo(
    () => live.filter((p) => p.role === 'teammate' || p.role === 'external'),
    [live],
  );

  const looksLikeName = /[A-Za-z]/.test(target);
  const e164 = looksLikeName ? '' : toE164(target);
  const targetValid = /^\+\d{8,15}$/.test(e164);
  const alreadyOnCall = targetValid && live.some((p) => p.address === e164);

  const addExternal = useCallback(async () => {
    if (!targetValid || dialing || alreadyOnCall) return;
    setDialing(true);
    try {
      // consult: true is what "add call" means — the caller goes on hold while
      // the new leg rings, and Merge brings everyone together afterwards.
      await addParticipant({ to_number: e164, consult: true });
    } finally {
      setDialing(false);
    }
  }, [targetValid, dialing, alreadyOnCall, addParticipant, e164]);

  const startTransfer = useCallback(
    (to: { user_id?: string; to_number?: string }) => {
      void transfer({ mode, ...to });
      setWarmPending(mode === 'warm');
      setPanel('none');
      setTarget('');
    },
    [transfer, mode],
  );

  const fillFromContact = useCallback((number: string) => {
    const filled = isNanp(number) ? formatPhone(number) : number;
    setTarget(filled);
    setPicked(filled);
    setMatches([]);
    targetRef.current?.focus();
  }, []);

  if (!active) return null;

  const counterparty =
    active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
  const hasZone = zoneForNumber(counterparty) !== null;
  const inCall = callState === 'in_call';
  const transferPending = guests.length > 0 && live.some((p) => p.role === 'agent');
  const canMergeNow = !merged && guests.some((p) => p.state === 'joined');
  const message = controlSentence(controlErrorCode, controlError);
  const teammates = team.filter((m) => !m.is_self);

  const notInCallReason =
    callState === 'connecting' || callState === 'ringing'
      ? 'Wait until the call connects.'
      : 'Only while a call is in progress.';
  const mergeReason = !inCall
    ? notInCallReason
    : guests.length === 0
      ? 'Add someone first — there is nobody to merge yet.'
      : merged
        ? 'Everyone is already together.'
        : undefined;
  const addReason = alreadyOnCall
    ? 'That number is already on this call.'
    : looksLikeName
      ? 'Pick a contact below, or type their number.'
      : !targetValid
        ? 'Enter a full phone number first.'
        : undefined;

  const named = active.record.contact_name;
  const KEYS: Array<[string, string]> = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', ''],
  ];

  // The panels under the controls, as render functions: the card shows them
  // inline in this order; the phone (variant="phone") opens each in a sheet.
  const audioPanel = () => (
        <div className="relative mt-4 flex w-full flex-col gap-3 p-3.5" style={PANEL}>
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>Microphone and speaker</Eyebrow>
            <button type="button" onClick={() => setPanel('none')} aria-label="Close" style={{ ...PILL, padding: 7 }}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <DeviceList
            title="Microphone"
            devices={inputDevices}
            activeId={activeInputDeviceId}
            empty="No microphone the browser will name — allow the mic and reopen this."
            onPick={(id) => void selectInputDevice(id)}
          />
          {isIOSDevice() ? (
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Speaker</Eyebrow>
              <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>
                On a phone the call starts in the earpiece. Speaker switches it to the loudspeaker.
                Headphones and Bluetooth take over on their own the moment they are connected.
              </p>
            </div>
          ) : (
            <DeviceList
              title="Speaker"
              devices={audioDevices}
              activeId={activeAudioDeviceId}
              empty="This browser does not let a page choose the speaker; the system's own output device is used."
              onPick={(id) => void selectAudioDevice(id)}
            />
          )}
          <p style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
            Switching takes effect on this call and is remembered for the next one.
          </p>
        </div>
  );

  const addPanel = () => (
        <div className="relative mt-4 flex w-full flex-col gap-3 p-3.5" style={PANEL}>
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>Add someone to this call</Eyebrow>
            <button
              type="button"
              onClick={() => setPanel('none')}
              aria-label="Close"
              style={{ ...PILL, padding: 7 }}
            >
              <Icon name="x" size={13} />
            </button>
          </div>

          <p style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
            The caller goes on hold while we ring whoever you pick. Merge when you want everyone to
            hear each other.
          </p>

          {message && (
            <p role="status" style={{ font: '500 11px/1.4 var(--sans)', color: 'var(--red)' }}>
              {message}
            </p>
          )}

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addExternal();
            }}
          >
            <input
              ref={targetRef}
              value={target}
              onChange={(e) => setTarget(formatAsTyped(e.target.value))}
              onKeyDown={(e) => {
                // Explicit rather than the form's implicit submission, which a
                // browser suppresses whenever the submit button is disabled.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addExternal();
                }
              }}
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              placeholder="Type a number, or search a contact"
              aria-label="Number to add to this call"
              className="min-w-0 flex-1"
              style={{ ...FIELD_LIGHT, flexBasis: 170 }}
            />
            <button
              type="submit"
              disabled={!targetValid || dialing || alreadyOnCall}
              title={addReason}
              className="inline-flex items-center gap-2 disabled:opacity-40"
              style={{ ...PILL, ...(targetValid && !alreadyOnCall ? ON : {}) }}
            >
              {dialing ? <RingingSpinner /> : <Icon name="plus" size={14} />}
              {dialing ? 'Dialling' : 'Add'}
            </button>
          </form>

          {matches.length > 0 && (
            <div className="flex flex-col overflow-hidden" style={{ border: '1px solid var(--line)', borderRadius: 11 }}>
              {matches.map((c, i) => {
                const number = contactNumber(c)!;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => fillFromContact(number)}
                    className="lift-row flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
                    // No inline `background` here: an inline value would beat
                    // the .lift-row hover rule, and the row would never light up.
                    style={{
                      border: 'none',
                      borderBottom: i === matches.length - 1 ? 'none' : ROW_LINE,
                      cursor: 'pointer',
                    }}
                  >
                    <Avatar name={c.display_name} size={22}  />
                    <span className="min-w-0 flex-1 truncate" style={{ font: '600 11.5px/1 var(--sans)', color: 'var(--text)' }}>
                      {c.display_name}
                    </span>
                    <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>
                      {displayNumber(number)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <Divider label="or a teammate" />

          {teammates.length === 0 ? (
            /* Deliberately plain text, not the shared EmptyState: this sits on
               the near-black call hero, where that component's light panel-2
               glyph tile would read as a hole punched in the card. */
            <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>
              No teammates yet — type a number above instead.
            </p>
          ) : (
            <div className="max-h-56 overflow-auto">
              {teammates.map((m) => {
                const on = live.some((p) => p.user_id === m.id);
                return (
                  <TeammateRow key={m.id} member={m} now={now}>
                    <button
                      type="button"
                      onClick={() => void addParticipant({ user_id: m.id, consult: true })}
                      disabled={on}
                      title={on ? 'They are already on this call.' : undefined}
                      className="disabled:opacity-40"
                      style={{ ...PILL, ...(on ? {} : ON), padding: '7px 12px', font: '600 10.5px/1 var(--sans)' }}
                    >
                      {on ? 'On the call' : 'Add'}
                    </button>
                  </TeammateRow>
                );
              })}
            </div>
          )}
        </div>
  );

  const transferPanel = () => (
        <div className="relative mt-4 flex w-full flex-col gap-2.5 p-3.5" style={PANEL}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>Transfer this call</Eyebrow>
            <div className="flex items-center gap-2">
              <IosSegmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'warm', label: 'Live transfer' },
                  { value: 'blind', label: 'Transfer & hang up' },
                ]}
              />
              <button
                type="button"
                onClick={() => setPanel('none')}
                aria-label="Close"
                style={{ ...PILL, padding: 7 }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          </div>

          <p style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
            {mode === 'warm'
              ? 'The caller waits on hold while you talk to them first. Then complete the transfer and leave, or stay on as a conference.'
              : 'The caller goes straight to them and you hang up.'}
          </p>

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (targetValid && !alreadyOnCall) startTransfer({ to_number: e164 });
            }}
          >
            <input
              value={target}
              onChange={(e) => setTarget(formatAsTyped(e.target.value))}
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              placeholder="Transfer to a number"
              aria-label="Number to transfer this call to"
              className="min-w-0 flex-1"
              style={{ ...FIELD_LIGHT, flexBasis: 170 }}
            />
            <button
              type="submit"
              disabled={!targetValid || alreadyOnCall}
              title={addReason}
              className="inline-flex items-center gap-2 disabled:opacity-40"
              style={{ ...PILL, ...(targetValid && !alreadyOnCall ? ON : {}) }}
            >
              <Icon name="transfer" size={14} />
              Transfer
            </button>
          </form>

          <Divider label="or a teammate" />

          {message && (
            <p role="status" style={{ font: '500 11px/1.4 var(--sans)', color: 'var(--red)' }}>
              {message}
            </p>
          )}

          {teammates.length === 0 && (
            <p style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>No teammates to transfer to.</p>
          )}

          <div className="max-h-56 overflow-auto">
            {teammates.map((m) => (
              <TeammateRow key={m.id} member={m} now={now}>
                <button
                  type="button"
                  onClick={() => startTransfer({ user_id: m.id })}
                  style={{ ...PILL, ...ON, padding: '7px 12px', font: '600 10.5px/1 var(--sans)' }}
                >
                  Transfer
                </button>
              </TeammateRow>
            ))}
          </div>

        </div>
  );

  const warmPanel = () => (
        <div className="relative mt-4 flex w-full flex-col gap-2.5 p-3.5" style={PANEL}>
          <Eyebrow>Live transfer</Eyebrow>
          <p style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
            The caller is on hold. When you are ready, hand them over, or bring everyone together.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void completeTransfer();
                setWarmPending(false);
              }}
              className="inline-flex items-center gap-2"
              style={{ ...PILL, ...ON }}
            >
              <Icon name="check" size={14} />
              Complete transfer and leave
            </button>
            <button
              type="button"
              onClick={() => {
                void merge();
                setWarmPending(false);
              }}
              className="inline-flex items-center gap-2"
              style={PILL}
            >
              <Icon name="users" size={14} />
              Stay on as conference
            </button>
          </div>
        </div>
  );

  const rosterPanel = () => (
        <div className="relative mt-4 w-full overflow-hidden" style={PANEL}>
          <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
            <Eyebrow>On the line · {live.length}</Eyebrow>
          </div>
          {live.map((p) => {
            const ringing = p.state === 'ringing';
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-2.5 px-3 py-2" style={{ borderBottom: ROW_LINE }}>
                <Avatar name={partyName(p)} size={24}  />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate" style={{ font: '600 12px/1 var(--sans)', color: 'var(--text)' }}>
                    {partyName(p)}
                  </span>
                  <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted)' }}>{ROLE_LABELS[p.role]}</span>
                </span>
                <span
                  className="inline-flex items-center gap-1.5"
                  style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted)' }}
                >
                  {ringing ? (
                    <RingingSpinner />
                  ) : (
                    <span style={{ width: 5, height: 5, background: STATE_COLORS[p.state] }} aria-hidden />
                  )}
                  {STATE_LABELS[p.state]}
                </span>
                {p.role !== 'agent' &&
                  (ringing ? (
                    <button
                      type="button"
                      onClick={() => void dropParticipant(p.provider_participant_id)}
                      title={`Stop ringing ${partyName(p)}`}
                      style={{ ...PILL, padding: '6px 10px', font: '600 10.5px/1 var(--sans)' }}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void dropParticipant(p.provider_participant_id)}
                      aria-label={`Hang up on ${partyName(p)}`}
                      title={`Hang up on ${partyName(p)} — everyone else stays on`}
                      className="inline-flex items-center justify-center"
                      style={{ ...PILL, padding: 0, width: 28, height: 28, background: 'var(--red)', color: '#fff', borderColor: 'transparent' }}
                    >
                      <HangupIcon size={14} />
                    </button>
                  ))}
              </div>
            );
          })}

          {canMergeNow && (
            <div
              className="flex flex-wrap items-center gap-2.5 px-3 py-2.5"
              style={{ background: 'var(--panel-2)' }}
            >
              <span
                className="min-w-0"
                style={{ flex: '1 1 190px', font: '500 11px/1.4 var(--sans)', color: 'var(--muted-2)' }}
              >
                {onHold
                  ? 'The caller is on hold and cannot hear you yet.'
                  : 'They are connected but not in the same room as the caller.'}
              </span>
              <button
                type="button"
                onClick={() => void merge()}
                className="inline-flex items-center gap-2"
                style={{ ...PILL, ...ON }}
              >
                <Icon name="users" size={14} />
                Bring everyone together
              </button>
            </div>
          )}
        </div>
  );

  // ── The full-screen phone's call screen ──────────────────────────────────
  // Same state and handlers as the card; only the layout differs. It never
  // scrolls: the tone pad and every panel open in place (the pad) or in a
  // sheet (the rest), so End stays where the thumb left it.
  if (variant === 'phone') {
    const demo = active.record.id === 'demo';
    // Reopened from its pill, the screen shows the running time at once, not 0:00 until the next tick.
    const sinceStart = Math.max(elapsed, startedAt && now !== null ? Math.floor((now - startedAt) / 1000) : 0);
    const who = named ?? displayNumber(counterparty);
    const connecting = callState === 'connecting' || callState === 'ringing';
    const waitReason = 'Available once the call connects';
    const statusLine =
      callState === 'connecting' ? 'Calling…' : callState === 'ringing' ? 'Ringing…' : `${onHold ? 'On hold · ' : ''}${duration(sinceStart)}`;
    const audioReason = demo ? 'No audio devices in the demo' : undefined;
    const initials = who
      .split(/\s+/)
      .filter((w) => /[A-Za-z]/.test(w))
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
    const ctl = (
      id: string,
      icon: React.ReactNode,
      label: string,
      onPress: () => void,
      opts: { pressed?: boolean; reason?: string } = {},
    ) => (
      <button
        key={id}
        type="button"
        className="phone-ctl"
        data-testid={`call-ctl-${id}`}
        aria-pressed={opts.pressed ? true : id === 'more' || id === 'add' ? undefined : false}
        aria-disabled={opts.reason ? true : undefined}
        onClick={() => (opts.reason ? setHint(opts.reason) : onPress())}
      >
        <span>{icon}</span>
        <span>{label}</span>
      </button>
    );
    const rows = (children: ReactNode) => <div className="flex flex-col">{children}</div>;
    const moreRow = (label: string, icon: React.ReactNode, onPress: () => void, reason?: string) => (
      <button
        type="button"
        className="phone-row"
        aria-disabled={reason ? true : undefined}
        onClick={() => {
          if (reason) return setHint(reason);
          onPress();
        }}
      >
        <span className="inline-flex w-7 justify-center" style={{ color: 'var(--muted)' }}>{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {reason && <span style={{ font: '400 13px/1.2 var(--sans)', color: 'var(--muted)' }}>{reason}</span>}
      </button>
    );

    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Active call">
        {/* Who, and how long. */}
        <div className="flex flex-none flex-col items-center px-6 text-center" style={{ marginTop: 8 }}>
          {!keypadOpen && (
            <span
              className="phone-tall-only mb-3 inline-flex items-center justify-center"
              aria-hidden
              style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,255,255,.14)', font: '600 28px/1 var(--sans)', color: '#fff' }}
            >
              {initials || <Icon name="user" size={30} />}
            </span>
          )}
          <span
            data-testid="call-name"
            style={{
              maxWidth: '100%', color: '#fff', overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical',
              WebkitLineClamp: keypadOpen ? 1 : 2, font: keypadOpen ? '600 22px/1.2 var(--sans)' : '600 34px/1.12 var(--sans)',
              letterSpacing: '-0.01em', wordBreak: 'break-word',
            }}
          >
            {who}
          </span>
          {keypadOpen ? (
            <span style={{ marginTop: 6, minHeight: 34, font: '400 28px/1.2 var(--sans)', letterSpacing: '0.08em', color: '#fff' }}>{dtmf}</span>
          ) : (
            <>
              {who !== displayNumber(counterparty) && (
                <span style={{ marginTop: 4, font: '400 17px/1.3 var(--sans)', color: 'rgba(255,255,255,.72)' }}>{displayNumber(counterparty)}</span>
              )}
              <span data-testid="call-status" style={{ marginTop: 2, font: '400 17px/1.3 var(--sans)', color: 'rgba(255,255,255,.72)', fontVariantNumeric: 'tabular-nums' }}>
                {statusLine}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1" style={{ font: '400 13px/1.3 var(--sans)', color: 'rgba(255,255,255,.6)' }}>
                {hasZone && <ProspectTime e164={counterparty} now={now} size={13} tone="dark" />}
                {hasZone && <span aria-hidden>·</span>}
                <span>
                  {active.record.direction === 'outbound' ? `from ${callerId ?? displayNumber(active.record.from_number)}` : 'Incoming call'}
                </span>
                {recording && inCall && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1.5" style={{ color: '#FF6961' }}>
                      <span aria-hidden className="talkr-rec-dot" style={{ width: 8, height: 8, borderRadius: 999, background: '#FF3B30' }} />
                      REC
                    </span>
                  </>
                )}
              </span>
            </>
          )}
        </div>

        {/* The glass peek, or the tone pad in its place. */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-3">
          {keypadOpen ? (
            <Keys
              variant="phone"
              tones
              onKey={(d) => {
                sendDigit(d);
                setDtmf((v) => (v + d).slice(-12));
              }}
            />
          ) : (
            peek && (
              <button
                type="button"
                data-testid="call-peek"
                onClick={() => onContext?.()}
                className="w-full text-left"
                style={{ maxWidth: 358, border: 0, borderRadius: 16, padding: '12px 14px', background: 'rgba(255,255,255,.08)', color: '#fff' }}
              >
                <span className="block" style={{ font: '400 15px/1.4 var(--sans)', overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>
                  {peek}
                </span>
                <span className="mt-1 block" style={{ font: '400 12px/1.2 var(--sans)', color: 'rgba(255,255,255,.55)' }}>Lead · Script · Notes</span>
              </button>
            )
          )}
        </div>

        {/* A live transfer finishes here; merge sits above the grid once someone else is on. */}
        {!keypadOpen && warmPending && transferPending && (
          <div className="flex flex-none gap-2 px-5 pb-3">
            <button
              type="button"
              onClick={() => {
                void completeTransfer();
                setWarmPending(false);
              }}
              style={{ flex: 1, height: 50, borderRadius: 14, border: 0, background: '#0A8560', color: '#fff', font: '600 17px/1 var(--sans)' }}
            >
              Complete transfer
            </button>
            <button
              type="button"
              onClick={() => {
                void merge();
                setWarmPending(false);
              }}
              style={{ flex: 1, height: 50, borderRadius: 14, border: 0, background: 'rgba(255,255,255,.16)', color: '#fff', font: '600 17px/1 var(--sans)' }}
            >
              Stay on (merge)
            </button>
          </div>
        )}
        {!keypadOpen && guests.length > 0 && !warmPending && (
          <div className="flex flex-none justify-center pb-3">
            <button
              type="button"
              className="phone-pill"
              aria-disabled={mergeReason ? true : undefined}
              onClick={() => (mergeReason ? setHint(mergeReason) : void merge())}
            >
              <Icon name="users" size={16} />
              {merged ? 'Merged' : 'Merge calls'}
            </button>
          </div>
        )}
        {(hint || (message && panel === 'none')) && (
          <p role="status" className="flex-none px-6 pb-3 text-center" style={{ font: '400 13px/1.35 var(--sans)', color: hint ? 'rgba(255,255,255,.72)' : '#FF6961' }}>
            {hint ?? message}
          </p>
        )}

        {!keypadOpen && (
          <div className="phone-ctls">
            {ctl('mute', <Icon name={active.muted ? 'mic-off' : 'mic'} size={30} />, active.muted ? 'Unmute' : 'Mute', toggleMute, { pressed: active.muted })}
            {ctl('keypad', <Icon name="grid" size={30} strokeWidth={3} />, 'Keypad', () => {
              setKeypadOpen(true);
              setDtmf('');
            }, { reason: inCall ? undefined : waitReason })}
            {ctl('audio', <Icon name="speaker" size={30} />, 'Speaker', () => toggleSpeaker(), {
              pressed: speakerOn,
              reason: audioReason,
            })}
            {ctl('hold', <Icon name="pause" size={30} />, onHold ? 'Resume' : 'Hold', () => void toggleHold(), {
              pressed: onHold,
              reason: inCall ? undefined : waitReason,
            })}
            {ctl('add', <Icon name="plus" size={30} />, 'Add call', () => setPanel('add'), { reason: inCall ? undefined : waitReason })}
            {ctl('more', <Icon name="more" size={30} strokeWidth={3} />, 'More', () => setPanel('more'))}
          </div>
        )}

        {/* End, centred and always on screen. */}
        <div
          className="phone-endrow grid flex-none items-center"
          style={{ gridTemplateColumns: '1fr auto 1fr', marginTop: 24, paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 20px)' }}
        >
          <span />
          <button type="button" className="phone-end" data-testid="call-end" aria-label="End call" onClick={hangup}>
            <HangupIcon size={34} />
          </button>
          <span className="flex justify-center">
            {keypadOpen && (
              <button
                type="button"
                className="phone-textbtn"
                onClick={() => {
                  setKeypadOpen(false);
                  setDtmf('');
                }}
              >
                Hide
              </button>
            )}
          </span>
        </div>

        {/* The sheets. Each is the card's own panel, unchanged underneath. */}
        <PhoneSheet open={panel === 'audio'} onClose={() => setPanel('none')} title="Audio" tone="light">
          {audioPanel()}
        </PhoneSheet>
        <PhoneSheet open={panel === 'add'} onClose={() => setPanel('none')} title="Add call" tone="light" height="88%">
          {addPanel()}
        </PhoneSheet>
        <PhoneSheet open={panel === 'transfer'} onClose={() => setPanel('none')} title="Transfer" tone="light" height="88%">
          {transferPanel()}
        </PhoneSheet>
        <PhoneSheet open={panel === 'more'} onClose={() => setPanel('none')} title="More" testId="call-more-sheet">
          {rows(
            <>
              {moreRow('Transfer', <Icon name="transfer" size={20} />, () => setPanel('transfer'), connecting || !inCall ? waitReason : undefined)}
              {onText && moreRow('Message', <Icon name="msg" size={20} />, () => {
                setPanel('none');
                onText(counterparty);
              }, counterparty ? undefined : 'No number to text')}
              {guests.length > 0 && moreRow(merged ? 'Merged' : 'Merge calls', <Icon name="users" size={20} />, () => {
                setPanel('none');
                void merge();
              }, mergeReason)}
              {onContext && moreRow('Notes', <Icon name="edit" size={20} />, () => {
                setPanel('none');
                onContext('notes');
              })}
              {onOpenRecord && moreRow('Open lead record', <Icon name="user" size={20} />, () => {
                setPanel('none');
                onOpenRecord();
              })}
              <div className="phone-row" style={{ cursor: 'default' }}>
                <span className="inline-flex w-7 justify-center" style={{ color: recording ? '#FF453A' : 'var(--muted)' }}>
                  <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: 'currentColor' }} />
                </span>
                <span className="min-w-0 flex-1">{recording ? 'This call is recorded' : 'Not recorded'}</span>
              </div>
              {sessionRows}
              <div className="px-3 py-2">
                <VmDropButton variant="phone" />
              </div>
              {!demo && moreRow('Talkr audio settings', <Icon name="settings" size={20} />, () => {
                setPanel('none');
                openTalkrSettings('audio');
              })}
            </>,
          )}
          {live.length > 0 && (
            <div className="mt-4">
              <div style={{ font: '600 13px/1.2 var(--sans)', color: 'var(--muted)', padding: '0 4px 6px' }}>
                On the line
              </div>
              <div className="phone-light" style={{ borderRadius: 12, overflow: 'hidden' }}>
                {rosterPanel()}
              </div>
            </div>
          )}
        </PhoneSheet>
      </section>
    );
  }

  // CLOZR: the iPhone Phone app's in-call screen — who and how long, centred;
  // six round controls in a 3-col grid; the round red End. Merge, the panels
  // and the roster keep Talkr's behaviour underneath.
  return (
    <section
      className="relative flex flex-col items-center px-4 pb-5 pt-6"
      style={{ borderRadius: 'var(--r-lg)', background: 'var(--panel)' }}
      aria-label="Active call"
    >
      <Avatar name={named ?? (active.record.lead_id ? 'Seller Lead' : formatPhone(counterparty))} size={72} />
      <div className="mt-3 flex max-w-full flex-col items-center gap-1 text-center">
        <span className="display max-w-full truncate" style={{ font: '600 26px/1.1 var(--sans)' }}>
          {named ?? formatPhone(counterparty)}
        </span>
        {named && (
          <span style={{ font: '400 14px/1.2 var(--sans)', color: 'var(--muted)' }}>{formatPhone(counterparty)}</span>
        )}
        <span className="flex items-center gap-2" style={{ font: '500 14px/1.2 var(--sans)', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
          {inCall ? `${onHold ? 'On hold · ' : ''}${duration(elapsed)}` : (serverStatus ?? callState).replace(/_/g, ' ')}
          {(record || active.record.lead_id) && (
            <span
              style={{
                padding: '3px 7px',
                borderRadius: 6,
                background: record?.kind === 'buyer' ? '#1d4ed8' : '#15803d',
                color: '#fff',
                font: '700 9px/1 var(--sans)',
              }}
            >
              {record?.kind === 'buyer' ? 'Buyer' : 'Seller lead'}
            </span>
          )}
        </span>
        <span
          className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1"
          style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted-2)' }}
        >
          {/* The seller's clock, not ours — the single most useful thing on
              this surface after the number itself. Nothing renders when the
              area code does not map to a zone. */}
          {hasZone && (
            <>
              <ProspectTime e164={counterparty} now={now} size={11.5} />
              <span>·</span>
            </>
          )}
          <span className="inline-flex items-center gap-1">
            <Icon name="pin" size={11} style={{ color: 'var(--accent)' }} />
            from {formatPhone(active.record.from_number)}
          </span>
          <span>·</span>
          <span>{audioDevices.find((d) => d.deviceId === activeAudioDeviceId)?.label ?? 'Default audio'}</span>
          {/* A rep on a recorded line should be able to see that it is
              recorded without opening settings — it changes what they say,
              and in a two-party state it is what they have to disclose. */}
          {recording && inCall && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--red)' }}>
                <span
                  aria-hidden
                  className="talkr-rec-dot"
                  style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--red)' }}
                />
                Recording
              </span>
            </>
          )}
        </span>
      </div>

      <div className="mt-6 grid w-full max-w-[300px] grid-cols-3 justify-items-center gap-4">
        <ControlButton
          icon={<Icon name={active.muted ? 'mic-off' : 'mic'} size={24} />}
          label={active.muted ? 'Unmute' : 'Mute'}
          active={active.muted}
          onClick={toggleMute}
        />
        <ControlButton
          icon={<Icon name="grid" size={24} />}
          label="Keypad"
          active={keypadOpen}
          onClick={() => {
            setKeypadOpen((v) => !v);
            setDtmf('');
          }}
        />
        <ControlButton
          icon={<Icon name="speaker" size={24} />}
          label="Audio"
          active={panel === 'audio'}
          // This used to cycle blind through the speakers — fine under a thumb,
          // useless at a desk, where you cannot see what you landed on and the
          // mic could not be changed from here at all.
          onClick={() => setPanel((x) => (x === 'audio' ? 'none' : 'audio'))}
          disabled={audioDevices.length === 0 && inputDevices.length === 0}
          disabledReason="No headset to switch to — allow the mic, then reopen this."
        />
        <ControlButton
          icon={<Icon name="plus" size={24} />}
          label="Add call"
          active={panel === 'add'}
          onClick={() => setPanel((p) => (p === 'add' ? 'none' : 'add'))}
          disabled={!inCall}
          disabledReason={notInCallReason}
        />
        <ControlButton
          icon={<Icon name="pause" size={24} />}
          label={onHold ? 'Resume' : 'Hold'}
          active={onHold}
          onClick={() => void toggleHold()}
        />
        <ControlButton
          icon={<Icon name="transfer" size={24} />}
          label="Transfer"
          active={panel === 'transfer'}
          onClick={() => setPanel((p) => (p === 'transfer' ? 'none' : 'transfer'))}
          disabled={!inCall}
          disabledReason={notInCallReason}
        />
        {/* Texting mid-call is how a rep sends the address, the offer or the
            calendar link while the seller is still on the phone. It was two
            screens away; it belongs on the call. */}
        {onText && (
          // Alone on its row, so it sits under the middle column rather than
          // hanging off the left edge of a three-across grid.
          <div style={{ gridColumn: 2 }}>
            <ControlButton
              icon={<Icon name="msg" size={24} />}
              label="Text"
              onClick={() => onText(counterparty)}
              disabled={!counterparty}
              disabledReason="No number to text on this call."
            />
          </div>
        )}
      </div>

      {/* Merge only means something once a second party is in; it sits under the grid then. */}
      {guests.length > 0 && (
        <button
          type="button"
          onClick={() => void merge()}
          disabled={Boolean(mergeReason)}
          title={mergeReason}
          className="mt-4 inline-flex items-center gap-2 disabled:opacity-40"
          style={{ ...PILL, ...(merged ? ON : {}) }}
        >
          <Icon name="users" size={14} />
          {merged ? 'Merged' : 'Merge calls'}
        </button>
      )}

      <VmDropButton />

      <button
        type="button"
        onClick={hangup}
        aria-label="End call"
        title="End call"
        className="ios-round mt-6"
        style={{ background: 'var(--red)' }}
      >
        <HangupIcon size={30} />
      </button>

      {/* When a panel is open the refusal belongs next to the control that caused it. */}
      {message && panel === 'none' && (
        <p className="relative pt-3 text-center" role="status" style={{ font: '500 11px/1.4 var(--sans)', color: 'var(--red)' }}>
          {message}
        </p>
      )}

      {keypadOpen && (
        <div className="relative mt-5 flex w-full flex-col items-center gap-3 p-3.5" style={PANEL}>
          {/* Named, because it looks exactly like the dial pad next to it and
              is not one: these keys press buttons in whatever menu answered. */}
          <Eyebrow>Tone pad — presses keys on this call</Eyebrow>
          <span className="display" style={{ font: '500 24px/1 var(--sans)', letterSpacing: '0.08em', minHeight: 24 }}>
            {dtmf || <span style={{ color: 'var(--muted-2)', font: '400 12px/1.6 var(--sans)', letterSpacing: 0 }}>Nothing sent yet</span>}
          </span>
          <div className="grid grid-cols-3 gap-x-3.5 gap-y-3">
            {KEYS.map(([d, letters]) => (
              <button
                key={d}
                type="button"
                className="ios-key"
                onClick={() => {
                  sendDigit(d);
                  setDtmf((v) => (v + d).slice(-8));
                }}
              >
                <span style={{ font: '400 30px/1 var(--sans)' }}>{d}</span>
                <span style={{ font: '600 9px/1 var(--sans)', letterSpacing: '0.14em', color: 'var(--muted)', minHeight: 9 }}>{letters}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === 'audio' && audioPanel()}

      {panel === 'add' && addPanel()}

      {panel === 'transfer' && transferPanel()}

      {/* A live transfer stays open after its panel closes: this is where it finishes. */}
      {warmPending && transferPending && warmPanel()}

      {live.length > 0 && rosterPanel()}
    </section>
  );
}
