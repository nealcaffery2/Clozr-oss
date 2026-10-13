'use client';

/**
 * SMS inbox (design 1c): conversation list, thread, templates and attachments.
 * The thread is iMessage-accurate — bubbles with tails, delivery receipts,
 * typing dots — because that is the vocabulary every seller already reads.
 *
 * The list is not just a list of numbers any more. Every row carries who the
 * person is (seller, buyer, title, vendor), how hot they are, what the contact
 * status is, their tags and the rep who owns them, in the same colours the
 * Contacts table uses — a rep should be able to tell a hot seller from a title
 * company without opening the thread. The filter bar above it is URL-backed,
 * so a view survives a refresh and can be handed to a teammate.
 *
 * The composer picks which org number the text goes out from, renders merge
 * fields before anything leaves (docs/sms.md §6 merge grammar), counts segments
 * the way a carrier does — an emoji makes it UCS-2 at 70 characters — and can
 * insert emoji without pulling in a picker dependency.
 *
 * Endpoints, SSE stream, suppression and quiet-hours refusals are unchanged.
 *
 * CLOZR port of A:\talkr\apps\web\app\(app)\messages\page.tsx. Verbatim,
 * except the seams: the filters and the open thread live in component state
 * instead of the URL (CLOZR is one shell that does not route per screen),
 * `authed` / `placeCall` come in as props instead of from Talkr's softphone
 * context, and Talkr's `next/link` contact links are plain anchors into the
 * Talkr web app.
 */

import { lineText, useLineNames } from '@/lib/line-names';
import { useSession } from '@/lib/session';
import { replyLine, textsAsSelf } from '@/lib/thread-line';
import { type InboxState, isCleared, pinnedFirst, smsKey } from '@/lib/inbox-state';
import { draftFor, keepDraft } from '@/lib/compose-drafts';
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  CONVERSATION_SORTS,
  TEMPERATURES,
  type ContactDto,
  type ContactStatus,
  type ContactType,
  type ConversationDto,
  type ConversationListDto,
  type ConversationListQuery,
  type ConversationSort,
  type MeDto,
  type MessageDto,
  type MessagePreviewInput,
  type MessageTemplateDto,
  type TeamMemberDto,
  type Temperature,
  talkrWebUrl,
} from '@/lib/talkr-web/api';
import { TopBar } from './TopBar';
import { Icon } from './Icon';
import { Avatar, Button, Eyebrow, FIELD, Select } from './ui';
import { AddContactButton, useIsKnownNumber } from './AddContact';
import { Bubble, TimeSeparator, TypingBubble, needsStamp } from './Bubble';
import { SmsSuggestions } from '@/app/components/record/SmsSuggestions';
import type { Recipient } from '@/lib/sms';
import {
  FilterChip,
  STATUS_LABEL,
  StatusMark,
  TEMP_LABEL,
  TYPE_LABEL,
  TagChip,
  TempDot,
  TemperatureBadge,
  TypeBadge,
  firstNonGsmChar,
  smsSegments,
} from './contacts';
import {
  MESSAGE_MERGE_FIELDS,
  MergeChips,
  MergePreview,
  TemplateManager,
  canManageTemplates,
  hasMergeFields,
  isActive,
  useMessagePreview,
} from './MessageTemplates';
import { MergeFieldHelp, MergeTextArea } from './MergeField';
import { EmojiButton, insertAtCaret } from './EmojiPicker';
import { formatPhone, toE164, tzTime, zoneForNumber } from '@/lib/talkr-web/time';
import { UserAvatar } from '@/components/UserAvatar';
import { type TalkrEvent, eventFacts, useTalkrEvents } from '@/lib/talkr-events';
import { loadTeamPhotos } from '@/lib/avatar';
import { TalkrMark } from '@/app/components/brand/TalkrMark';

/** The assigned teammate's photo (initials when they have none), inline beside their name. */
function RepFace({ name }: { name: string }) {
  const [photos, setPhotos] = useState<Map<string, string> | null>(null);
  useEffect(() => { let on = true; void loadTeamPhotos().then((m) => { if (on) setPhotos(m); }); return () => { on = false; }; }, []);
  return <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}><UserAvatar name={name} src={photos?.get(name.trim().toLowerCase()) ?? null} size={14} /></span>;
}

/** What the carrier actually reported. SMS has no read receipts, so there is no "Read". */
const RECEIPT: Record<string, string> = {
  queued: 'Sending…',
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  undelivered: 'Not delivered',
  failed: 'Not delivered',
};

/** Still on its way: the bubble is drawn faded until the carrier takes it. */
const PENDING_STATUSES = new Set(['queued', 'sending']);

/** Nothing reached the handset: the one thing a row must never hide. */
const FAILED_STATUSES = new Set(['failed', 'undelivered']);

/** One screen of threads; "Load more" widens the window rather than paging. */
const PAGE_SIZE = 40;

/**
 * The inbox row's second line: what was last said. An MMS with no text still
 * has to say something, or the row reads as an empty conversation.
 */
function preview(last: ConversationDto['last_message']): string {
  if (!last) return 'No messages yet';
  const body = last.body.trim();
  if (body) return body;
  if (last.media_count > 0) {
    return last.media_count === 1 ? 'Photo' : `${last.media_count} photos`;
  }
  return '';
}

/**
 * An MMS attachment. The design shows the photo, so we show the photo — but a
 * carrier media URL can be short-lived or need credentials we deliberately do
 * not put in the browser, and a broken image icon in a seller thread is worse
 * than no image. So it falls back to the labelled placeholder the moment the
 * load fails, and the thread never renders as damaged.
 */
type AttachmentKind = 'image' | 'video' | 'file';

/** A file the rep picked, already uploaded and waiting on the composer. */
interface PendingAttachment {
  url: string;
  previewUrl: string | null;
  name: string;
  kind: AttachmentKind;
}

/** Carrier MMS ceiling is ~5 MB per message; 3 MB per file matches the API. */
const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
/** Phone photos are 3–12 MB; carriers downscale anyway, so shrink client-side. */
const IMAGE_MAX_EDGE = 1600;

function kindFromType(contentType: string): AttachmentKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Inbound carrier URLs carry no extension and are always images in practice,
 * so only a telling extension moves a URL off the image path.
 */
function kindFromUrl(url: string): AttachmentKind {
  const path = url.split('?')[0]!.toLowerCase();
  if (/\.(mp4|3gp|3gpp|mov|m4v)$/.test(path)) return 'video';
  if (/\.(pdf|vcf|txt|csv|docx?|xlsx?)$/.test(path)) return 'file';
  return 'image';
}

async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 800 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ?? file;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function MmsImage({ url, mine }: { url: string; mine: boolean }) {
  const [failed, setFailed] = useState(false);
  const kind = kindFromUrl(url);
  const box = {
    width: 230,
    maxWidth: '100%',
    borderRadius: 14,
    background: mine ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.06)',
  } as const;

  if (kind === 'video') {
    return (
      <video controls preload="metadata" src={url} style={{ ...box, display: 'block', maxHeight: 260 }} />
    );
  }
  if (kind === 'file') {
    const name = decodeURIComponent(url.split('?')[0]!.split('/').pop() ?? 'file');
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2"
        style={{ ...box, width: 'auto', padding: '8px 12px', font: '600 11px/1 var(--sans)', color: 'inherit', textDecoration: 'none' }}
      >
        <Icon name="image" size={14} />
        {name}
      </a>
    );
  }

  if (failed) {
    return (
      <span
        className="flex items-center justify-center gap-2"
        style={{
          ...box,
          height: 138,
          font: '600 10px/1 var(--sans)',
        }}
      >
        <Icon name="image" size={18} />
        Image
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- carrier-hosted, not ours to optimize
    <img
      src={url}
      alt="Attachment"
      onError={() => setFailed(true)}
      style={{ ...box, display: 'block', maxHeight: 260, objectFit: 'cover' }}
    />
  );
}

/** Same number, one key: "+15125550134", "15125550134" and "(512) 555-0134" all match. */
function numberKey(n: string): string {
  return n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

/**
 * Who is the number in the "To" field of a brand-new thread? There is no
 * conversation row to read a name off yet, so it is looked up — and when
 * nobody owns it, saving it is one click away.
 */
function NewNumberIdentity({ number }: { number: string }) {
  const [settled, setSettled] = useState(number);
  useEffect(() => {
    const t = setTimeout(() => setSettled(number), 400);
    return () => clearTimeout(t);
  }, [number]);
  const { contact, loading, remember } = useIsKnownNumber(settled);

  if (settled.replace(/\D/g, '').length < 10 || loading) return null;
  if (contact) {
    return (
      <a
        href={talkrWebUrl(`/contacts/${contact.id}`)}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 truncate"
        style={{ font: '600 11.5px/1 var(--sans)', color: 'var(--accent)' }}
      >
        {contact.display_name}
      </a>
    );
  }
  return (
    <AddContactButton phone={settled} labelClassName="max-sm:sr-only" onCreated={(c) => remember(c)} />
  );
}

function timeShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ── URL filters ──────────────────────────────────────────────────────────── */

const SORT_LABEL: Record<ConversationSort, string> = {
  recent: 'Newest first',
  oldest: 'Oldest first',
  unread: 'Unread first',
  temperature: 'Hottest first',
};

type RangePreset = 'all' | 'today' | '7d' | '30d' | 'custom';

interface Filters {
  q: string;
  type: ContactType | null;
  temp: Temperature | null;
  status: ContactStatus | null;
  tag: string;
  /** CLOZR only: matched record's address or Talkr's lead city/state. Never sent to Talkr. */
  address: string;
  user: string;
  unread: boolean;
  /**
   * YYYY-MM-DD, inclusive, in the rep's own day. The end of the range rides in
   * the URL as `until`, not `to`: `?to=<E.164>` is how Contacts' "Text" action
   * has always addressed a new thread, and a date filter must not eat it.
   */
  from: string;
  to: string;
  sort: ConversationSort;
}

function pick<T extends string>(list: readonly T[], value: string | null): T | null {
  return list.find((x) => x === value) ?? null;
}

function readFilters(p: URLSearchParams): Filters {
  return {
    q: p.get('q')?.trim() ?? '',
    type: pick(CONTACT_TYPES, p.get('type')),
    temp: pick(TEMPERATURES, p.get('temp')),
    status: pick(CONTACT_STATUSES, p.get('status')),
    tag: p.get('tag')?.trim() ?? '',
    address: p.get('address')?.trim() ?? '',
    user: p.get('user')?.trim() ?? '',
    unread: p.get('unread') === 'true',
    from: p.get('from')?.trim() ?? '',
    to: p.get('until')?.trim() ?? '',
    sort: pick(CONVERSATION_SORTS, p.get('sort')) ?? 'recent',
  };
}

function toQuery(f: Filters): ConversationListQuery {
  return {
    q: f.q || undefined,
    type: f.type ?? undefined,
    temperature: f.temp ?? undefined,
    status: f.status ?? undefined,
    tag: f.tag || undefined,
    user_id: f.user || undefined,
    unread: f.unread || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    sort: f.sort,
  };
}

/** How many filters are on — the count on the "Filters" toggle. Sort is not one. */
function filterCount(f: Filters): number {
  return [f.q, f.type, f.temp, f.status, f.tag, f.address, f.user, f.unread || null, f.from || f.to ? 'range' : null].filter(
    Boolean,
  ).length;
}

/** YYYY-MM-DD, `back` days ago, in the rep's own zone (not UTC). */
function dayString(back = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const RANGES: Array<{ value: RangePreset; label: string; back: number | null }> = [
  { value: 'all', label: 'Any time', back: null },
  { value: 'today', label: 'Today', back: 0 },
  { value: '7d', label: 'Last 7 days', back: 6 },
  { value: '30d', label: 'Last 30 days', back: 29 },
];

function presetFor(f: Filters): RangePreset {
  if (!f.from && !f.to) return 'all';
  const today = dayString(0);
  for (const r of RANGES) {
    if (r.back === null) continue;
    if (f.from === dayString(r.back) && f.to === today) return r.value;
  }
  return 'custom';
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export interface MessagesScreenProps {
  /** Talkr knows this rep — in CLOZR, the phone's status is `ok`. */
  authed: boolean;
  /** Dial an E.164 number; CLOZR routes it through its floating dialer. */
  placeCall: (e164: string) => void;
  /** The header's "New call" button; CLOZR opens the dialer. */
  onNewCall?: () => void;
  /**
   * Open this E.164 on mount — what `?to=` did on talkrdialer.com when a
   * Contacts "Text" action landed here. Its thread when one exists, otherwise
   * a fresh composer addressed to it.
   */
  to?: string | null;
  /** CLOZR: the seller or buyer record behind an E.164, when there is one. */
  recordFor?: (e164: string) => ClozrRecord | null;
  /** CLOZR: this rep's pins and clears (lib/inbox-state, migration 154). */
  inbox?: InboxState;
  /** CLOZR: bumped by the Inbox's "New text": open a blank composer (a known number then opens its thread). */
  startNew?: number;
  /** CLOZR: the thread to open on mount when no `to` is given — the one open when the rep last left the Inbox. */
  conversation?: string | null;
  /** CLOZR: told which thread is open (and its number) whenever that changes, so the Inbox can remember it. */
  onOpen?: (id: string | null, theirNumber: string | null) => void;
  /**
   * CLOZR: the rep opened a thread to read it (a click, a hand-off from the
   * bell). Landing on the newest thread or coming back to the last one is not
   * reading it, so it stays unread here, on Talkr and in the bell.
   */
  onRead?: (theirNumber: string) => void;
  /** CLOZR: rendered in the header bar — the inbox's channel tabs and buttons. */
  headerSlot?: ReactNode;
  /** CLOZR: a signed-in workspace, for the record suggestions under a seller's thread. Null in the demo. */
  live?: { workspaceId: number; canWrite: boolean; me: string | null; toast: (msg: string) => void; reload: () => void } | null;
  /** CLOZR: its own template picker, opened from the composer's tray; `insert` replaces the draft with the rendered text. */
  /**
   * The other party is typing: the left-side dots. Nothing sets it today —
   * SMS carries no typing signal.
   * ponytail: always false until RCS typing events exist; wire them here.
   */
  typing?: boolean;
  clozrTemplates?: (ctx: { record: ClozrRecord | null; name: string | null; phone: string | null; insert: (text: string) => void; close: () => void }) => ReactNode;
}

export interface ClozrRecord {
  kind: 'seller' | 'buyer';
  name: string;
  address: string;
  stage: string;
  open: () => void;
  /** The database id, when the resolver knows it. */
  id?: number;
  /** Merge-field values for this person (lib/sms fieldsFor). */
  recipient?: Recipient;
}

export function MessagesScreen({ authed, placeCall, onNewCall, to: initialTo = null, recordFor, headerSlot, live = null, typing = false, clozrTemplates, inbox, startNew = 0, conversation: initialConversation = null, onOpen, onRead }: MessagesScreenProps) {
  // On talkrdialer.com the filters and the open thread ride in the URL so a
  // view survives a refresh and can be handed to a teammate. CLOZR is one
  // shell that does not route per screen, so the same query string lives in
  // state here and everything below reads and writes it exactly as before.
  // CLOZR: coming back to the Inbox reopens the thread that was open (a `to` wins).
  const [paramsString, setParamsString] = useState(() => (!initialTo && initialConversation ? new URLSearchParams({ conversation: initialConversation }).toString() : ''));
  const searchParams = useMemo(() => new URLSearchParams(paramsString), [paramsString]);

  const filters = useMemo(() => readFilters(new URLSearchParams(paramsString)), [paramsString]);
  // Serialized so that selecting a thread (which also lives in the URL) does
  // not look like a new query and re-fetch the whole list.
  const queryKey = useMemo(() => JSON.stringify(toQuery(filters)), [filters]);
  const query = useMemo(() => JSON.parse(queryKey) as ConversationListQuery, [queryKey]);

  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<ConversationListDto['counts'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateId, setTemplateId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newNumber, setNewNumber] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  // Whose each line is, for the From picker (lib/line-names).
  useLineNames();
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [fromId, setFromId] = useState('');
  // A phone shows the list or the thread, never both; a desk shows both and
  // ignores this. Opening a thread flips it, the back arrow flips it back.
  const [listOpen, setListOpen] = useState(true);
  // Templates live in a third column on a wide screen; below that, a sheet
  // above the composer.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // The composer's "+" tray (attach, emoji, merge fields, templates) and CLOZR's picker above it.
  const [trayOpen, setTrayOpen] = useState(false);
  const [clozrPickerOpen, setClozrPickerOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(() => filterCount(filters) > 0);
  // "Custom…" is a mode, not a range: a hand-picked week can happen to be the
  // last seven days, and the two date fields must not vanish when it does.
  const [customRange, setCustomRange] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Numbers saved as contacts from this page, by number. The conversation list
  // is re-fetched on every inbound event and the server may not have re-linked
  // the thread yet, so the name we just gave a number is kept here as well.
  const [namedNumbers, setNamedNumbers] = useState<Record<string, string>>({});

  const selectedId = searchParams.get('conversation');
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  // CLOZR: a draft per thread (lib/compose-drafts). One shared box sent what
  // was typed to Kara — or a template merged with Kara's fields — to Ronald
  // the moment his thread was opened. Each thread now shows its own, empty
  // when it has none, and keeps it while the rep is elsewhere. `key` lets a
  // send that finishes after the rep moved on clear the thread it went to.
  const draftKeyRef = useRef('');
  draftKeyRef.current = 'sms:' + (selectedId ?? 'new');
  const [, bumpDraft] = useState(0);
  const draft = draftFor(draftKeyRef.current).text;
  const setDraft = useCallback((text: string, key?: string) => {
    keepDraft(key ?? draftKeyRef.current, { text });
    bumpDraft((n) => n + 1);
  }, []);
  // The open thread, cached: a filter (or marking it read under `unread=true`)
  // can drop its row from the list while the rep is still reading it.
  const [openThread, setOpenThread] = useState<ConversationDto | null>(null);

  const queryRef = useRef(query);
  queryRef.current = query;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── URL state ───────────────────────────────────────────────────────────
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(paramsString);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      setParamsString(next.toString());
    },
    [paramsString],
  );

  const openConversation = useCallback(
    (id: string | null) => {
      // `?to=` is a one-shot address from Contacts' "Text" action; the moment a
      // thread is open it is spent, and leaving it in the URL only confuses a
      // link that gets shared.
      setParams({ conversation: id, to: null });
      setListOpen(false);
      setError(null);
      // A template or CLOZR's picker was chosen for the thread being left.
      setTemplateId('');
      setClozrPickerOpen(false);
    },
    [setParams],
  );

  // Search is typed locally and pushed to the URL 300 ms after the last key.
  // The URL only flows back into the field when it changed elsewhere (back
  // button), so a slow router never clobbers what the rep is still typing.
  const [qInput, setQInput] = useState(filters.q);
  const pushedQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== pushedQ.current) {
      pushedQ.current = filters.q;
      setQInput(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    const value = qInput.trim();
    if (value === pushedQ.current) return;
    const t = setTimeout(() => {
      pushedQ.current = value;
      setParams({ q: value || null });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, setParams]);

  // ── Data ────────────────────────────────────────────────────────────────
  /**
   * One loader for both paths. A background refresh (SSE, a send, a read
   * receipt) is `silent`: it keeps the spinner off, keeps whatever the rep has
   * scrolled to, and — because it reads the filters from a ref — never fights
   * the filter state it was queued behind.
   */
  const loadConversations = useCallback((silent = false) => {
    const el = listRef.current;
    const scroll = el?.scrollTop ?? 0;
    if (!silent) setLoading(true);
    return api
      .listConversations({ ...queryRef.current, limit: PAGE_SIZE * pagesRef.current })
      .then((r) => {
        setConversations(r.conversations);
        setTotal(r.total);
        setCounts(r.counts);
        setListError(null);
        if (silent && el) requestAnimationFrame(() => { el.scrollTop = scroll; });
      })
      .catch((e: unknown) => {
        if (!silent) setListError(e instanceof Error ? e.message : 'Could not load conversations');
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, []);

  const reloadTemplates = useCallback(() => {
    setTemplatesLoading(true);
    // Managers need the retired ones too; a rep only ever sees the live list.
    api
      .listMessageTemplates({ include_inactive: canManageTemplates(me?.role) })
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined)
      .finally(() => setTemplatesLoading(false));
  }, [me?.role]);

  const refreshThread = useCallback((id: string) => {
    api
      .listConversationMessages(id)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]));
  }, []);

  /** The name a thread shows: the server's, else one saved here a moment ago. */
  const contactNameFor = useCallback(
    (c: ConversationDto): string | null => c.contact_name ?? namedNumbers[numberKey(c.their_number)] ?? null,
    [namedNumbers],
  );

  /** A number just became somebody: name it everywhere it appears, immediately. */
  const rememberContact = useCallback(
    (number: string, contact: ContactDto) => {
      setNamedNumbers((prev) => ({ ...prev, [numberKey(number)]: contact.display_name }));
      void loadConversations(true);
    },
    [loadConversations],
  );

  useEffect(() => {
    if (!authed) return;
    void loadConversations(false);
  }, [authed, query, pages, loadConversations]);

  useEffect(() => {
    if (!authed) return;
    api.getMe().then(setMe).catch(() => undefined);
    api.listTeam().then((r) => setTeam(r.members)).catch(() => setTeam([]));
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    reloadTemplates();
  }, [authed, reloadTemplates]);

  // A new filter view starts at the first page again.
  useEffect(() => setPages(1), [query]);

  // Live updates: the softphone's one stream (lib/talkr-events, docs/sms.md
  // §7), not a socket of this page's own. A burst is one silent re-read.
  const onMessageEvents = useCallback((events: TalkrEvent[]) => {
    void loadConversations(true);
    const current = selectedIdRef.current;
    if (current && events.some((e) => eventFacts(e).conversationId === current)) refreshThread(current);
  }, [loadConversations, refreshThread]);
  useTalkrEvents(authed, ['message.received', 'message.updated', 'conversation.updated'], onMessageEvents);

  // Read means the rep opened it on purpose. Clears Talkr's count, this
  // list's dot and (through onRead) the bell.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const readThread = useCallback((c: ConversationDto) => {
    onReadRef.current?.(c.their_number);
    if (!c.unread_count) return;
    setConversations((cs) => cs.map((x) => (x.id === c.id ? { ...x, unread_count: 0 } : x)));
    void api.markConversationRead(c.id).then(() => loadConversations(true)).catch(() => undefined);
  }, [loadConversations]);

  // The design never shows an empty centre pane — landing on the inbox opens
  // the newest thread. Only on first load, so hitting "New" still clears it.
  const autoSelected = useRef(false);

  // Arriving with ?to=<E.164> (Contacts' "Text" action) opens that number:
  // its thread when one exists, otherwise a fresh composer addressed to it.
  const [pendingTo, setPendingTo] = useState<string | null>(null);
  useEffect(() => {
    const to = initialTo?.trim();
    if (!to) return;
    autoSelected.current = true;
    setPendingTo(to);
    setNewNumber(to);
    setListOpen(false);
  }, [initialTo]);
  useEffect(() => {
    if (!pendingTo || conversations.length === 0) return;
    const existing = conversations.find((c) => c.their_number === pendingTo);
    if (existing) {
      openConversation(existing.id);
      readThread(existing);
      setNewNumber('');
    } else {
      setParams({ to: null });
    }
    setPendingTo(null);
  }, [pendingTo, conversations, openConversation, setParams, readThread]);

  useEffect(() => {
    if (!startNew) return;
    autoSelected.current = true;
    openConversation(null);
    setMessages([]);
    setDraft('', 'sms:new');
    setListOpen(false);
  }, [startNew, openConversation, setDraft]);

  // A new text to a number that already has a thread (on this page or not,
  // cleared or not) opens that thread, so the history is right there.
  useEffect(() => {
    if (selectedId || !authed) return;
    const e164 = toE164(newNumber);
    if (!e164 || e164.replace(/\D/g, '').length < 11) return;
    const here = conversations.find((c) => c.their_number === e164);
    if (here) { openConversation(here.id); setNewNumber(''); return; }
    let live = true;
    const t = setTimeout(() => {
      void api.listConversations({ q: e164.slice(-10), limit: 10 }).then((r) => {
        const hit = r.conversations.find((c) => c.their_number === e164);
        if (live && hit) { openConversation(hit.id); setNewNumber(''); }
      }).catch(() => undefined);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [newNumber, selectedId, authed, conversations, openConversation]);

  useEffect(() => {
    if (autoSelected.current || selectedId || conversations.length === 0 || filterCount(filters) > 0) return;
    autoSelected.current = true;
    openConversation(conversations[0]!.id);
    setListOpen(true);
  }, [conversations, selectedId, filters, openConversation]);

  useEffect(() => {
    if (selectedId) autoSelected.current = true;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setOpenThread(null);
      return;
    }
    refreshThread(selectedId);
  }, [selectedId, refreshThread]);

  // Keep the open thread's header alive even when its row leaves the filtered
  // list. A deep link (/messages?conversation=…) into a filtered view has
  // nothing to read it off, so that one case asks the server unfiltered.
  useEffect(() => {
    if (!selectedId) return;
    const found = conversations.find((c) => c.id === selectedId);
    if (found) {
      setOpenThread(found);
      return;
    }
    if (openThread?.id === selectedId) return;
    let cancelled = false;
    api
      .listConversations({ limit: 200 })
      .then((r) => {
        const match = r.conversations.find((c) => c.id === selectedId) ?? null;
        if (!cancelled && match) setOpenThread(match);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, conversations, openThread?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // The composer grows with the draft (a template is three lines) and stops at
  // five, so a long one scrolls instead of eating the thread.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  const selected = openThread && openThread.id === selectedId ? openThread : null;
  const selectedName = selected ? contactNameFor(selected) : null;
  const selectedNumber = selected?.their_number ?? null;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => { onOpenRef.current?.(selectedId, selectedNumber); }, [selectedId, selectedNumber]);
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const theirZone = selected ? zoneForNumber(selected.their_number) : null;
  const canManage = canManageTemplates(me?.role);
  const pickerTemplates = useMemo(
    () => (canManage ? templates : templates.filter(isActive)),
    [templates, canManage],
  );

  // The from-number follows the thread: whichever org line is already carrying
  // it, or the rep's default on a brand-new one. The TC is the exception and
  // texts on her own line (lib/thread-line). A manual pick stands until they
  // open a different thread.
  const ourNumber = selected?.our_number ?? null;
  const asSelf = textsAsSelf(useSession().workspace?.role);
  useEffect(() => {
    if (!me) return;
    setFromId(replyLine(me, ourNumber, asSelf) ?? '');
  }, [me, selectedId, ourNumber, asSelf]);

  const fromNumber = me?.org_numbers.find((n) => n.id === fromId) ?? null;

  // ── Composer ────────────────────────────────────────────────────────────
  // A template chosen and left untouched goes by id, so its use count moves;
  // edit a character and it becomes an ordinary body.
  const templateIntact = selectedTemplate !== null && selectedTemplate.body === draft;
  const previewInput = useMemo<MessagePreviewInput>(() => {
    const target = selectedId
      ? { conversation_id: selectedId }
      : newNumber.replace(/\D/g, '').length >= 10
        ? { to_number: toE164(newNumber) }
        : {};
    return templateIntact && selectedTemplate
      ? { template_id: selectedTemplate.id, ...target }
      : { body: draft, ...target };
  }, [draft, newNumber, selectedId, selectedTemplate, templateIntact]);
  // Only ask when there is something to render: plain prose needs no round trip.
  const previewState = useMessagePreview(previewInput, hasMergeFields(draft));
  const outgoing = previewState.preview?.body ?? draft;
  const seg = smsSegments(outgoing);
  // A GSM message of this length would have fitted in one part, so the extra
  // part is the emoji's doing (or a smart dash's) — worth saying, because it
  // doubles what the carrier charges for the same sentence.
  const split = seg.encoding === 'ucs2' && seg.segments > 1 && seg.chars <= 160;
  const culprit = seg.encoding === 'ucs2' ? firstNonGsmChar(outgoing) : null;
  const culpritLabel = culprit === null ? '' : /\p{Extended_Pictographic}/u.test(culprit) ? 'an emoji' : `“${culprit}”`;

  /**
   * What the `/` picker and the "?" guide show beside each field: the real
   * seller, not a stand-in. The server's own render is the answer wherever it
   * has one — it is the same map the send will use — and until it replies (it
   * is only asked once a body has braces in it) the row and the session fill
   * in what they already know. A field the server returns empty keeps the
   * page's value rather than blanking it, because `rep_name` and `org_name`
   * do not depend on who is being written to.
   */
  const composerValues = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    const put = (field: string, value: string | null | undefined) => {
      const v = value?.trim();
      if (v) out[field] = v;
    };
    put('first_name', selectedName?.split(/\s+/)[0]);
    put('name', selectedName);
    put('contact_name', selectedName);
    put('city', selected?.lead_city);
    put('state', selected?.lead_state);
    put('phone', selected ? formatPhone(selected.their_number) : null);
    put('company', me?.org?.name);
    put('org_name', me?.org?.name);
    put('rep_name', me?.display_name);
    put('rep_first_name', me?.display_name?.split(/\s+/)[0]);
    for (const [field, value] of Object.entries(previewState.preview?.merge_fields ?? {})) put(field, value);
    return out;
  }, [selectedName, selected, me, previewState.preview]);

  const insertIntoDraft = (text: string) => {
    const next = insertAtCaret(composerRef.current, draft, text);
    setDraft(next);
    if (selectedTemplate && next !== selectedTemplate.body) setTemplateId('');
  };

  async function send() {
    if (sending) return;
    setError(null);
    setSending(true);
    const sentFrom = draftKeyRef.current;
    try {
      const input = selectedId ? { conversation_id: selectedId } : { to_number: newNumber.trim() };
      const mediaUrls = attachments.map((a) => a.url);
      const result = await api.sendMessage({
        ...input,
        ...(templateIntact && selectedTemplate
          ? { template_id: selectedTemplate.id, lead_id: selected?.lead_id ?? undefined }
          : { body: draft }),
        ...(mediaUrls.length > 0 ? { media_urls: mediaUrls } : {}),
        ...(fromId ? { from_phone_number_id: fromId } : {}),
      });
      setDraft('', sentFrom);
      setTemplateId('');
      setNewNumber('');
      clearAttachments();
      openConversation(result.conversation_id);
      refreshThread(result.conversation_id);
      void loadConversations(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'suppressed') {
        setError('This number has opted out of SMS. Sending is blocked.');
      } else if (err instanceof ApiError && err.code === 'quiet_hours') {
        setError('Outside your organization’s texting window (quiet hours).');
      } else if (err instanceof ApiError && err.code === 'invalid_caller_id') {
        setError('That number can’t send for this org any more. Pick another line above.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSending(false);
    }
  }

  /** A text the carrier refused, sent again as it was. */
  async function retry(m: MessageDto) {
    if (!selectedId || sending) return;
    setError(null);
    setSending(true);
    try {
      await api.sendMessage({
        conversation_id: selectedId,
        body: m.body,
        ...(m.media_urls.length > 0 ? { media_urls: m.media_urls } : {}),
        ...(fromId ? { from_phone_number_id: fromId } : {}),
      });
      refreshThread(selectedId);
      void loadConversations(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function addFiles(files: FileList) {
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, Math.max(0, 10 - attachments.length))) {
        const kind = kindFromType(file.type);
        let blob: Blob = file;
        if (kind === 'image') {
          try {
            blob = await shrinkImage(file);
          } catch {
            throw new Error(`Couldn't read ${file.name}. Use a JPEG or PNG (HEIC is not supported here).`);
          }
        }
        if (blob.size > ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.name} is over 3 MB. Carriers reject larger MMS attachments.`);
        }
        const uploaded = await api.uploadMedia({
          content_type: blob.type || file.type,
          data_base64: await blobToBase64(blob),
          filename: file.name,
        });
        setAttachments((cur) => [
          ...cur,
          {
            url: uploaded.url,
            previewUrl: kind === 'image' ? URL.createObjectURL(blob) : null,
            name: file.name,
            kind,
          },
        ]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(url: string) {
    setAttachments((cur) => {
      const gone = cur.find((a) => a.url === url);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return cur.filter((a) => a.url !== url);
    });
  }

  function clearAttachments() {
    setAttachments((cur) => {
      for (const a of cur) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }

  if (!authed) {
    // Talkr's page says "Not signed in — open Account"; in CLOZR the sign-in
    // is the rep's own, and what can be missing is Talkr recognising it.
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 var(--sans)', color: 'var(--muted)' }}>
        Talkr isn’t connected to this sign-in yet — check the dialer, or Settings → Integrations.
      </p>
    );
  }

  const destinationOk = Boolean(selectedId || newNumber.trim());
  const canSend = !uploading && destinationOk && (draft.trim().length > 0 || attachments.length > 0);
  const active = filterCount(filters);
  const rangePreset: RangePreset = customRange && (filters.from || filters.to) ? 'custom' : presetFor(filters);
  const unreadTotal = counts?.unread ?? conversations.reduce((sum, c) => sum + c.unread_count, 0);
  // "All" carries the real row count only while no type is chosen: the type
  // buckets leave out threads with no contact behind them, so summing them
  // would quietly disagree with the list underneath.
  const allCount = filters.type ? undefined : total;
  // ponytail: filters the loaded page only; move server-side when Talkr's API takes an address param.
  const needle = filters.address.toLowerCase();
  const matched = needle
    ? conversations.filter((c) =>
        [recordFor?.(c.their_number)?.address, c.lead_city, c.lead_state].some((v) => v?.toLowerCase().includes(needle)),
      )
    : conversations;
  // CLOZR: a cleared thread stays off the list until a newer message; pinned ones lead.
  const shown = inbox
    ? pinnedFirst(matched.filter((c) => c.id === selectedId || !isCleared(c.last_message_at, inbox.state.get(smsKey(c.their_number)))), (c) => smsKey(c.their_number), inbox.state)
    : matched;
  const selectedPinned = !!(inbox && selected && inbox.state.get(smsKey(selected.their_number))?.pinned_at);
  const selectedRecord = selected && recordFor ? recordFor(selected.their_number) : null;
  const lastOutbound = messages.map((m) => m.direction).lastIndexOf('outbound');
  const clearFilters = () => {
    setQInput('');
    pushedQ.current = '';
    setParams({ q: null, type: null, temp: null, status: null, tag: null, address: null, user: null, unread: null, from: null, until: null, sort: null });
  };

  const templatePanel = (
    <TemplateManager
      templates={pickerTemplates}
      loading={templatesLoading}
      canManage={canManage}
      reload={reloadTemplates}
      selectedId={templateId || null}
      target={selectedId ? { conversation_id: selectedId } : undefined}
      onUse={(t) => {
        setTemplateId(t.id);
        setDraft(t.body);
        setTemplatesOpen(false);
        requestAnimationFrame(() => composerRef.current?.focus());
      }}
    />
  );

  return (
    <>
      <TopBar
        title="Messages"
        subtitle={`${total.toLocaleString()} conversation${total === 1 ? '' : 's'}${active ? ' matching' : ''}${unreadTotal ? ` · ${unreadTotal} unread` : ''}`}
        onNewCall={onNewCall}
      >
        {headerSlot}
      </TopBar>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr] xl:grid-cols-[340px_1fr_320px]">
        {/* ── Threads ───────────────────────────────────────────────────── */}
        <div
          className={`msg-list ${listOpen ? 'flex' : 'hidden'} min-h-0 flex-col md:flex md:border-r md:border-[var(--line)]`}
          style={{ background: 'var(--panel)' }}
        >
          <div className="flex flex-col gap-2 px-3 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="flex items-center gap-2">
              <Eyebrow className="mr-auto">Conversations</Eyebrow>
              <Button
                tone="ghost"
                style={{ padding: '6px 10px', font: '600 11px/1 var(--sans)' }}
                onClick={() => {
                  openConversation(null);
                  setMessages([]);
                  setDraft('', 'sms:new');
                  setTemplateId('');
                }}
              >
                New
              </Button>
            </div>

            {/* Search + the filter toggle: everything else folds away, because
                this column is 340px on a desk and the whole screen on a phone. */}
            <div className="search-pill flex items-center gap-2">
              <Icon name="search" size={14} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search"
                aria-label="Search conversations"
                className="min-w-0 flex-1 bg-transparent outline-none"
                style={{ font: '400 15px/1 var(--sans)', padding: '7px 0' }}
              />
              {qInput && (
                <button type="button" aria-label="Clear search" onClick={() => setQInput('')} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip active={filtersOpen} onClick={() => setFiltersOpen((v) => !v)} count={active || undefined}>
                <Icon name="filter" size={11} />
                Filters
              </FilterChip>
              <FilterChip active={filters.unread} onClick={() => setParams({ unread: filters.unread ? null : 'true' })} count={counts?.unread}>
                Unread
              </FilterChip>
              {active > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1"
                  style={{ font: '600 11px/1 var(--sans)', color: 'var(--accent)', cursor: 'pointer', padding: '6px 4px' }}
                >
                  <Icon name="x" size={11} strokeWidth={2.5} />
                  Clear all
                </button>
              )}
            </div>

            {filtersOpen && (
              <div className="flex flex-col gap-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <FilterChip active={!filters.type} onClick={() => setParams({ type: null })} count={allCount}>
                    All
                  </FilterChip>
                  {CONTACT_TYPES.map((t) => (
                    <FilterChip
                      key={t}
                      active={filters.type === t}
                      onClick={() => setParams({ type: filters.type === t ? null : t })}
                      count={counts ? (counts.by_type[t] ?? 0) : undefined}
                    >
                      {TYPE_LABEL[t]}
                    </FilterChip>
                  ))}
                </div>

                <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                  <span className="inline-flex min-w-0 items-center gap-2" style={{ ...FIELD, padding: '0 0 0 10px' }}>
                    {filters.temp ? (
                      <TempDot temperature={filters.temp} />
                    ) : (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--muted-2)', display: 'inline-block', flexShrink: 0 }} aria-hidden />
                    )}
                    <select
                      value={filters.temp ?? ''}
                      onChange={(e) => setParams({ temp: e.target.value || null })}
                      aria-label="Temperature"
                      className="min-w-0 flex-1"
                      style={{ border: 'none', background: 'transparent', padding: '8px 6px 8px 0', font: '500 12px/1 var(--sans)', color: 'var(--text)', outline: 'none' }}
                    >
                      <option value="">Any temperature</option>
                      {TEMPERATURES.map((t) => (
                        <option key={t} value={t}>
                          {TEMP_LABEL[t]}
                          {counts?.by_temperature[t] ? ` (${counts.by_temperature[t]})` : ''}
                        </option>
                      ))}
                    </select>
                  </span>

                  <Select
                    value={filters.status ?? ''}
                    onChange={(e) => setParams({ status: e.target.value || null })}
                    aria-label="Contact status"
                    style={{ padding: '8px 10px', font: '500 12px/1 var(--sans)' }}
                  >
                    <option value="">Any status</option>
                    {CONTACT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </Select>

                  <TagFilter value={filters.tag} onChange={(tag) => setParams({ tag: tag || null })} />
                  <TagFilter label="Address" value={filters.address} onChange={(address) => setParams({ address: address || null })} />

                  {team.length > 0 && (
                    <Select
                      value={filters.user}
                      onChange={(e) => setParams({ user: e.target.value || null })}
                      aria-label="Rep"
                      style={{ padding: '8px 10px', font: '500 12px/1 var(--sans)' }}
                    >
                      <option value="">Any rep</option>
                      {team.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                    </Select>
                  )}

                  <Select
                    value={rangePreset}
                    onChange={(e) => {
                      const value = e.target.value as RangePreset;
                      setCustomRange(value === 'custom');
                      if (value === 'custom') {
                        if (!filters.from && !filters.to) setParams({ from: dayString(6), until: dayString(0) });
                        return;
                      }
                      const range = RANGES.find((r) => r.value === value);
                      setParams({
                        from: range && range.back !== null ? dayString(range.back) : null,
                        until: range && range.back !== null ? dayString(0) : null,
                      });
                    }}
                    aria-label="Date range"
                    style={{ padding: '8px 10px', font: '500 12px/1 var(--sans)' }}
                  >
                    {RANGES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </Select>

                  <Select
                    value={filters.sort}
                    onChange={(e) => setParams({ sort: e.target.value === 'recent' ? null : e.target.value })}
                    aria-label="Sort"
                    style={{ padding: '8px 10px', font: '500 12px/1 var(--sans)' }}
                  >
                    {CONVERSATION_SORTS.map((s) => (
                      <option key={s} value={s}>
                        {SORT_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </div>

                {rangePreset === 'custom' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="date"
                      value={filters.from}
                      max={filters.to || undefined}
                      onChange={(e) => setParams({ from: e.target.value || null })}
                      aria-label="From date"
                      style={{ ...FIELD, padding: '7px 9px', font: '500 11.5px/1 var(--sans)' }}
                    />
                    <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>to</span>
                    <input
                      type="date"
                      value={filters.to}
                      min={filters.from || undefined}
                      onChange={(e) => setParams({ until: e.target.value || null })}
                      aria-label="To date"
                      style={{ ...FIELD, padding: '7px 9px', font: '500 11.5px/1 var(--sans)' }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
            {listError && (
              <p className="p-4" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--red)' }}>
                {listError}
              </p>
            )}

            {loading && conversations.length === 0 && (
              <p className="p-4" style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted-2)' }}>
                Loading conversations…
              </p>
            )}

            {!loading && shown.length === 0 && (
              <div className="flex flex-col items-start gap-2 p-4">
                <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>
                  {active ? 'No conversations match these filters.' : 'No conversations yet.'}
                </p>
                {active > 0 && (
                  <Button tone="ghost" style={{ padding: '7px 10px', font: '600 11.5px/1 var(--sans)' }} onClick={clearFilters}>
                    Clear all filters
                  </Button>
                )}
              </div>
            )}

            {shown.map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                record={recordFor ? recordFor(c.their_number) : undefined}
                now={now}
                name={contactNameFor(c)}
                active={c.id === selectedId}
                onOpen={() => { openConversation(c.id); readThread(c); }}
                onNamed={(contact) => rememberContact(c.their_number, contact)}
              />
            ))}

            {conversations.length > 0 && conversations.length < total && (
              <div className="p-3">
                <Button
                  tone="ghost"
                  className="w-full"
                  style={{ padding: '8px 10px', font: '600 11.5px/1 var(--sans)' }}
                  onClick={() => setPages((p) => p + 1)}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - conversations.length)} more`}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ── Thread ────────────────────────────────────────────────────── */}
        {/* One scroller: the glass header and composer are sticky inside it, so
            the thread scrolls under both the way it does on an iPhone. */}
        <div className={`msg-thread ${listOpen ? 'hidden' : 'flex'} min-h-0 flex-col md:flex`} style={{ background: 'var(--thread, var(--panel))' }}>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div className="glass-bar sticky top-0 z-10 flex flex-col gap-1.5 px-3 pb-2 pt-2 md:px-5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Back to conversations"
                onClick={() => setListOpen(true)}
                className="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center md:hidden"
                style={{ color: 'var(--accent)', cursor: 'pointer' }}
              >
                <Icon name="chevron-left" size={22} strokeWidth={2.4} />
              </button>
              {selected ? (
                <>
                  <span className="hidden h-9 w-9 shrink-0 md:block" aria-hidden />
                  <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
                    <Avatar name={selectedName ?? selected.their_number} size={40} />
                    <button
                      type="button"
                      onClick={selectedRecord?.open}
                      disabled={!selectedRecord}
                      title={selectedRecord ? 'Go to record' : recordFor ? 'Not in CLOZR' : undefined}
                      className="inline-flex max-w-full items-center gap-0.5"
                      style={{ font: '500 12.5px/1.2 var(--sans)', color: 'var(--text)', cursor: selectedRecord ? 'pointer' : 'default' }}
                    >
                      <span className="truncate">{selectedName ?? formatPhone(selected.their_number)}</span>
                      {selectedRecord && <Icon name="chevron-right" size={11} style={{ color: 'var(--muted-2)' }} />}
                    </button>
                    <div className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
                      {selected.contact_type && <TypeBadge type={selected.contact_type} />}
                      {selected.temperature && (
                        <TemperatureBadge temperature={selected.temperature} score={selected.temperature_score ?? 0} />
                      )}
                      <span className="truncate" style={{ font: '400 11px/1.2 var(--sans)', color: 'var(--muted-2)' }}>
                        {formatPhone(selected.their_number)}
                        {theirZone && now !== null ? ` · ${tzTime(theirZone, now)} local` : ''}
                        {selected.assigned_user_name ? <> · <RepFace name={selected.assigned_user_name} /> {selected.assigned_user_name}</> : ''}
                        {!selectedRecord && recordFor ? ' · Not in CLOZR' : ''}
                      </span>
                    </div>
                  </div>
                  {!selectedName && (
                    <AddContactButton
                      size="icon"
                      phone={selected.their_number}
                      onCreated={(contact) => rememberContact(selected.their_number, contact)}
                    />
                  )}
                  {inbox && (
                    <>
                      <Button tone="ghost" style={{ padding: '7px 10px', font: '600 11.5px/1 var(--sans)' }} title={selectedPinned ? 'Unpin' : 'Keep this thread at the top'}
                        onClick={() => inbox.pin(smsKey(selected.their_number), !selectedPinned)}>
                        {selectedPinned ? 'Unpin' : 'Pin'}
                      </Button>
                      <Button tone="ghost" style={{ padding: '7px 10px', font: '600 11.5px/1 var(--sans)' }} title="Take it off the list until a new text comes in"
                        onClick={() => { inbox.clear(smsKey(selected.their_number)); openConversation(null); setListOpen(true); }}>
                        Clear
                      </Button>
                    </>
                  )}
                  <button
                    type="button"
                    aria-label="Call"
                    onClick={() => placeCall(selected.their_number)}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                    style={{ color: 'var(--accent)', cursor: 'pointer' }}
                  >
                    <Icon name="phone" size={19} />
                  </button>
                </>
              ) : (
                <div className="flex flex-1 items-center gap-2">
                  <Eyebrow>To</Eyebrow>
                  <input
                    value={newNumber}
                    onChange={(e) => setNewNumber(e.target.value)}
                    placeholder="+15125550134"
                    inputMode="tel"
                    autoComplete="tel"
                    aria-label="New message recipient"
                    className="min-w-0 flex-1 bg-transparent outline-none"
                    style={{ font: '600 15px/1 var(--sans)' }}
                  />
                  <NewNumberIdentity number={newNumber} />
                </div>
              )}
            </div>

            {/* Which of the org's lines the seller sees. It defaults to the one
                already carrying the thread, because switching mid-conversation
                starts a second thread on the seller's phone. */}
            {me && me.org_numbers.length > 0 && (
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                <Eyebrow>From</Eyebrow>
                <select
                  value={fromId}
                  onChange={(e) => setFromId(e.target.value)}
                  aria-label="Send from"
                  className="min-w-0 outline-none"
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 14,
                    padding: '4px 8px',
                    font: '500 11.5px/1 var(--sans)',
                    background: 'rgba(255,255,255,.6)',
                    maxWidth: '100%',
                  }}
                >
                  {me.org_numbers.map((n) => (
                    <option key={n.id} value={n.id}>
                      {lineText(n, me.id)}
                      {ourNumber === n.phone_e164 ? ' · this thread' : ''}
                    </option>
                  ))}
                </select>
                {fromNumber && ourNumber && fromNumber.phone_e164 !== ourNumber && (
                  <span className="basis-full text-center" style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--amber)' }}>
                    {`Changing this changes the number the seller sees — the reply lands in a new thread from ${formatPhone(fromNumber.phone_e164)}.`}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-1 flex-col px-3 pb-2 pt-3 md:px-6">
            {selected && messages.length === 0 && (
              <p className="self-center" style={{ font: '400 11px/1 var(--sans)', color: 'var(--muted-2)' }}>
                No messages in this thread yet.
              </p>
            )}
            {!selected && (
              <p className="self-center" style={{ font: '400 12px/1.6 var(--sans)', color: 'var(--muted)' }}>
                Pick a conversation, or enter a number above to start a new one.
              </p>
            )}

            {messages.map((m, i) => {
              const mine = m.direction === 'outbound';
              const at = m.sent_at ?? m.created_at;
              const prev = messages[i - 1];
              const next = messages[i + 1];
              // A run ends where the side changes or a stamp would break it; only its last bubble has a tail.
              const tail = !next || next.direction !== m.direction || needsStamp(at, next.sent_at ?? next.created_at);
              const last = mine && i === lastOutbound;
              const pending = mine && PENDING_STATUSES.has(m.status);
              const failed = mine && FAILED_STATUSES.has(m.status);
              return (
                <Fragment key={m.id}>
                  {needsStamp(prev ? prev.sent_at ?? prev.created_at : null, at) && <TimeSeparator at={at} />}
                  <Bubble
                    mine={mine}
                    tail={tail}
                    faded={pending}
                    receipt={
                      last ? (
                        failed ? (
                          <button type="button" onClick={() => void retry(m)} disabled={sending} style={{ color: 'var(--red)', cursor: 'pointer', font: 'inherit' }}>
                            Not delivered · Tap to retry
                          </button>
                        ) : (
                          RECEIPT[m.status] ?? m.status
                        )
                      ) : undefined
                    }
                  >
                    {m.media_urls.length > 0 && (
                      <span className="mb-2 flex flex-col gap-1.5">
                        {m.media_urls.map((url) => (
                          <MmsImage key={url} url={url} mine={mine} />
                        ))}
                      </span>
                    )}
                    {m.body}
                  </Bubble>
                </Fragment>
              );
            })}
            {/* No typing signal exists on SMS: the dots hold the outbound side
                only while a send of ours is in flight. */}
            {typing && <TypingBubble inbound />}
            {sending && <TypingBubble />}
            <div ref={bottomRef} />
          </div>

          <div className="glass-bar sticky bottom-0 z-10">
          {error && (
            <p className="px-6 pt-2" style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--red)' }}>
              {error}
            </p>
          )}

          {templatesOpen && (
            <div
              className="flex max-h-64 flex-col overflow-auto px-3 py-3 xl:hidden"
              style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)' }}
            >
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setTemplatesOpen(false)}
                  style={{ font: '600 11px/1 var(--sans)', color: 'var(--accent)', cursor: 'pointer' }}
                >
                  Close
                </button>
              </div>
              {templatePanel}
            </div>
          )}

          {clozrPickerOpen && clozrTemplates?.({
            record: selectedRecord,
            name: selectedName,
            phone: selected?.their_number ?? (newNumber ? toE164(newNumber) : null),
            insert: (text) => {
              setTemplateId('');
              setDraft(text);
              setClozrPickerOpen(false);
              requestAnimationFrame(() => composerRef.current?.focus());
            },
            close: () => setClozrPickerOpen(false),
          })}

          {live && selectedRecord?.kind === 'seller' && selectedRecord.id && messages.length > 0 && (
            <SmsSuggestions
              workspaceId={live.workspaceId}
              sellerId={selectedRecord.id}
              messages={messages.slice(-20).map((m) => ({ direction: m.direction, body: m.body, at: m.sent_at ?? m.created_at }))}
              me={live.me}
              canWrite={live.canWrite}
              onToast={live.toast}
              onChanged={live.reload}
            />
          )}

          <div>
            {(attachments.length > 0 || uploading) && (
              <div className="flex flex-wrap items-center gap-2.5 px-3 pt-3 md:px-6">
                {attachments.map((a) => (
                  <span
                    key={a.url}
                    className="relative inline-flex items-center gap-2"
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      background: 'var(--panel)',
                      padding: a.previewUrl ? 3 : '7px 10px',
                      font: '500 11px/1 var(--sans)',
                    }}
                  >
                    {a.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL
                      <img
                        src={a.previewUrl}
                        alt={a.name}
                        style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, display: 'block' }}
                      />
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name={a.kind === 'video' ? 'play' : 'image'} size={13} />
                        {a.name}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => removeAttachment(a.url)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                      style={{ position: 'absolute', top: -6, right: -6, background: '#1c1c1e', color: '#fff', cursor: 'pointer' }}
                    >
                      <Icon name="x" size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                ))}
                {uploading && (
                  <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>Uploading…</span>
                )}
              </div>
            )}

            {/* What the seller will read, when it differs from what is typed. */}
            {(hasMergeFields(draft) || (previewState.preview?.unknown_fields.length ?? 0) > 0) && (
              <div className="px-3 pt-3 md:px-6">
                <MergePreview state={previewState} raw={draft} />
              </div>
            )}

            {trayOpen && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 md:px-6">
                <MergeChips onInsert={insertIntoDraft} />
                <MergeFieldHelp fields={MESSAGE_MERGE_FIELDS} values={composerValues} />
              </div>
            )}

            {seg.chars > 0 && (
              <div className="flex px-3 pt-2 md:px-6">
                <span
                  className="ml-auto"
                  style={{ font: '500 10.5px/1.4 var(--sans)', color: split || seg.segments > 3 ? 'var(--amber)' : 'var(--muted-2)' }}
                >
                  {seg.chars} chars · {seg.segments} segment{seg.segments === 1 ? '' : 's'}
                  {split
                    ? ` · ${culpritLabel} makes it UCS-2 — 70 per segment instead of 160`
                    : seg.encoding === 'ucs2'
                      ? ` · UCS-2 (${culpritLabel}) — 70 per segment`
                      : ''}
                </span>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/mp4,video/3gpp,application/pdf,text/vcard"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />

            {/* Behind the "+": attach, emoji, merge fields, CLOZR's templates and Talkr's. */}
            {trayOpen && (
              <div className="flex flex-wrap items-center gap-2 px-3 pt-2 md:px-6">
                <button
                  type="button"
                  aria-label="Attach photo or file"
                  title="Attach photo, video or file (MMS)"
                  disabled={uploading || attachments.length >= 10}
                  onClick={() => fileInputRef.current?.click()}
                  className="tray-btn"
                  aria-pressed={attachments.length > 0}
                >
                  <Icon name="camera" size={15} /> Photo
                </button>
                <EmojiButton onPick={insertIntoDraft} />
                {clozrTemplates && (
                  <button type="button" className="tray-btn" aria-pressed={clozrPickerOpen} onClick={() => setClozrPickerOpen((v) => !v)}>
                    <Icon name="template" size={15} /> Templates
                  </button>
                )}
                <button type="button" className="tray-btn xl:hidden" aria-pressed={templatesOpen} onClick={() => setTemplatesOpen((v) => !v)}>
                  <TalkrMark size={15} /> Talkr templates
                </button>
              </div>
            )}

            <div className="flex items-end gap-2 px-3 pb-3 pt-2 md:gap-2.5 md:px-6 md:pb-4">
              <button
                type="button"
                aria-label={trayOpen ? 'Hide attachments, emoji and templates' : 'Attachments, emoji and templates'}
                aria-expanded={trayOpen}
                onClick={() => setTrayOpen((v) => !v)}
                className="plus-btn"
              >
                <Icon name="plus" size={18} strokeWidth={2.4} style={{ transform: trayOpen ? 'rotate(45deg)' : 'none', transition: 'transform .15s ease' }} />
              </button>

              <div className="composer-pill flex flex-1 items-end gap-2">
                {/* MergeTextArea, not a bare textarea: `/` at a word boundary
                    opens the field picker, and while that list is open it keeps
                    Enter and Tab — so Enter still sends, except when the rep is
                    choosing a field, which is exactly the moment it must not.
                    The chips and the emoji picker keep inserting through
                    composerRef, which it fills. */}
                <div className="min-w-0 flex-1">
                  <MergeTextArea
                    textareaRef={composerRef}
                    value={draft}
                    rows={1}
                    onChange={(next) => {
                      setDraft(next);
                      if (selectedTemplate && next !== selectedTemplate.body) setTemplateId('');
                    }}
                    values={composerValues}
                    fields={MESSAGE_MERGE_FIELDS}
                    onKeyDown={(e) => {
                      // Enter sends, Shift+Enter breaks the line — a text is one
                      // paragraph nine times in ten.
                      if (e.key === 'Enter' && !e.shiftKey && canSend) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={attachments.length > 0 ? 'Add a caption (optional)' : 'Text Message · SMS'}
                    aria-label="Message"
                    // The pill draws the border; the field inside it is only text.
                    style={{
                      border: 'none',
                      borderRadius: 0,
                      background: 'transparent',
                      font: '400 16px/1.3 var(--sans)',
                      lineHeight: 1.3,
                      resize: 'none',
                      maxHeight: 120,
                      padding: '5px 0',
                    }}
                  />
                </div>
                {selectedTemplate && (
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateId('');
                      setDraft('');
                    }}
                    aria-label="Clear template"
                    style={{ color: 'var(--muted-2)', cursor: 'pointer', paddingBottom: 6 }}
                  >
                    <Icon name="x" size={15} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Send"
                  disabled={!canSend || sending}
                  onClick={() => void send()}
                  className="send-btn"
                >
                  <Icon name="send" size={15} strokeWidth={2.6} />
                </button>
              </div>
            </div>
          </div>
          </div>
          </div>
        </div>

        {/* ── Templates ─────────────────────────────────────────────────── */}
        <div
          className="msg-side hidden min-h-0 flex-col gap-4 overflow-auto p-4 xl:flex xl:border-l xl:border-[var(--line)]"
          style={{ background: 'var(--panel)' }}
        >
          {templatePanel}
        </div>
      </div>
    </>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────── */

/**
 * An iOS Messages row: the unread dot left of a 44px avatar, the name bold
 * with the time and a chevron at the right, two lines of preview, and a
 * hairline that starts past the avatar. Talkr's vocabulary (type, heat,
 * status, tags, rep) and the CLOZR record ride underneath in small type.
 */
function ConversationRow({
  c,
  record,
  now,
  name,
  active,
  onOpen,
  onNamed,
}: {
  c: ConversationDto;
  /** undefined outside CLOZR; null when no CLOZR record has this number. */
  record?: ClozrRecord | null;
  now: number | null;
  name: string | null;
  active: boolean;
  onOpen: () => void;
  onNamed: (contact: ContactDto) => void;
}) {
  const zone = zoneForNumber(c.their_number);
  const status = pick(CONTACT_STATUSES, c.contact_status);
  const failed = c.last_message !== null && FAILED_STATUSES.has(c.last_message.status);
  const place = [c.lead_city, c.lead_state].filter(Boolean).join(', ');
  const unread = c.unread_count > 0;

  return (
    // The row is a button, so the Add-contact affordance is a sibling rather
    // than a nested button.
    <div className="ios-row group flex items-stretch" data-active={active || undefined} style={{ background: active ? 'var(--accent-soft)' : 'var(--panel)' }}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 py-2.5 pl-1.5 pr-2 text-left"
        style={{ background: 'transparent', cursor: 'pointer' }}
      >
        <span
          aria-label={unread ? `${c.unread_count} unread` : undefined}
          style={{ width: 10, height: 10, borderRadius: '50%', background: unread ? 'var(--accent)' : 'transparent', flexShrink: 0, alignSelf: 'center' }}
        />
        <Avatar name={name ?? c.their_number} size={44} />
        <span className="ios-row-body flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="mr-auto truncate" style={{ font: '600 15px/1.25 var(--sans)', color: 'var(--text)' }}>
              {name ?? formatPhone(c.their_number)}
            </span>
            <span style={{ font: '400 13px/1 var(--sans)', color: 'var(--muted-2)', whiteSpace: 'nowrap' }}>{timeShort(c.last_message_at)}</span>
            <Icon name="chevron-right" size={13} style={{ color: '#c7c7cc' }} />
          </span>

          <span style={{ font: '400 14px/1.3 var(--sans)', color: 'var(--muted-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {c.last_message?.direction === 'outbound' && 'You: '}
            {preview(c.last_message)}
          </span>

          {/* Who this is, at a glance: the Contacts vocabulary, same colours. */}
          {(c.contact_type || c.temperature || status || failed) && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
              {c.contact_type && <TypeBadge type={c.contact_type} />}
              {c.temperature &&
                (c.temperature_score !== null ? (
                  <TemperatureBadge temperature={c.temperature} score={c.temperature_score} />
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <TempDot temperature={c.temperature} />
                    <span style={{ font: '700 11px/1 var(--sans)' }}>{TEMP_LABEL[c.temperature]}</span>
                  </span>
                ))}
              {status && <StatusMark status={status} />}
              {failed && (
                <span className="inline-flex items-center gap-1" style={{ font: '700 8.5px/1 var(--sans)', color: 'var(--red)' }}>
                  <Icon name="x" size={10} strokeWidth={2.6} />
                  Not delivered
                </span>
              )}
            </span>
          )}

          {record !== undefined && (
            <span className="truncate" style={{ font: '600 11px/1.3 var(--sans)', color: record ? (record.kind === 'seller' ? '#15803d' : '#1d4ed8') : 'var(--muted-2)' }}>
              {record ? [record.kind === 'seller' ? 'Seller' : 'Buyer', record.name, record.address].filter(Boolean).join(' · ') : 'Not in CLOZR'}
            </span>
          )}

          {(c.tags.length > 0 || c.assigned_user_name || place || zone) && (
            <span className="flex flex-wrap items-center gap-1" style={{ font: '400 11px/1.2 var(--sans)', color: 'var(--muted-2)' }}>
              {c.tags.slice(0, 2).map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
              {c.tags.length > 2 && <span>+{c.tags.length - 2}</span>}
              {c.assigned_user_name ? <RepFace name={c.assigned_user_name} /> : null}
              <span className="truncate">
                {[c.assigned_user_name, place, zone && now !== null ? `${tzTime(zone, now)} local` : c.lead_status].filter(Boolean).join(' · ')}
              </span>
            </span>
          )}
        </span>
      </button>

      {!name && (
        // Always there on a phone; on a desk it appears on hover or when it
        // takes focus from the keyboard.
        <span className="flex shrink-0 items-center pr-3 transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
          <AddContactButton size="icon" phone={c.their_number} onCreated={onNamed} />
        </span>
      )}
    </div>
  );
}

/** Tag (or address) filter: typed, committed on Enter or blur, cleared with the ×. */
function TagFilter({ value, onChange, label = 'Tag' }: { value: string; onChange: (tag: string) => void; label?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <span className="inline-flex min-w-0 items-center" style={{ ...FIELD, padding: '0 6px 0 10px' }}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== value) onChange(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        placeholder={label}
        aria-label={`Filter by ${label.toLowerCase()}`}
        className="min-w-0 flex-1 bg-transparent outline-none"
        style={{ font: '500 12px/1 var(--sans)', padding: '8px 0' }}
      />
      {value && (
        <button type="button" aria-label={`Clear ${label.toLowerCase()} filter`} onClick={() => onChange('')} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
          <Icon name="x" size={13} />
        </button>
      )}
    </span>
  );
}
