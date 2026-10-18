'use client';

/**
 * The in-call panel: who is on the line, what has happened with them, the
 * script to read and the rebuttals to reach for. One request —
 * GET /v1/call-context — feeds every tab, so the panel is ready the moment a
 * number is typed, a call rings, or a call connects. It never waits to be
 * clicked open: the dialer mounts it beside the live call.
 *
 * Three tabs — Lead | Script | Objections — either owned here (a Segmented
 * at the top) or handed in by the phone layout, where the same four-way
 * control also carries the call itself.
 *
 * CLOZR seam (copied from Talkr apps/web/components/CallContext.tsx): the
 * panel also takes the CLOZR record on the line (`record`) — name, stage,
 * address, asking, last touch, open tasks and an Open record button — so it
 * is useful before, or without, Talkr knowing the number; `liveSlot` adds a
 * Live tab (transcript and seller intelligence) for the slide-out dialer;
 * links to Talkr-only pages open talkr.example.com.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { everyWhileVisible } from '@/lib/visible-timer';
import {
  ApiError,
  api,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  TEMPERATURES,
  talkrWebUrl,
  type CallContextActivityDto,
  type CallContextDto,
  type CallContextParams,
  type ContactDto,
  type ContactType,
  type ScriptDto,
  type UpdateContactInput,
} from '@/lib/talkr-web/api';
import { Icon, type IconName } from './Icon';
import { Mark } from '@/components/ds/mark';
import { Button, Card, EmptyState, Eyebrow, FIELD, Input, Labeled, Notice, Select, StatusMarker } from './ui';
import { IosSegmented } from './ios';
import {
  BAND_COLOR,
  FilterChip,
  STATUS_COLOR,
  STATUS_LABEL,
  StatusMark,
  TEMP_LABEL,
  TYPE_LABEL,
  TagChip,
  TagsField,
  TempDot,
  TemperatureBadge,
  TypeBadge,
  degrees,
  errorMessage,
  oneLineAddress,
  tempBand,
} from './contacts';
import { ProspectTime } from './ProspectTime';
import { useSoftphone } from './softphoneAdapter';
import { useSession } from '@/lib/session';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { openReach } from '@/app/components/record/reach';
import { renderMerge } from '@/lib/sms';
import { SearchSelect } from '@/components/SearchSelect';
import { duration, formatPhone, timeAgo, toE164 } from '@/lib/talkr-web/time';
import {
  callContextKey,
  fetchCallContext,
  inlineRuns,
  invalidateCallContext,
  parseScript,
  renderScriptMerge,
  type ScriptBlock,
} from '@/lib/talkr-web/callContext';

export type CallContextMode = 'precall' | 'incall' | 'incoming';
export type CallContextTab = 'lead' | 'script' | 'objections' | 'live';

/** What CLOZR knows about the party: the seller or buyer record behind the number. */
export interface ClozrRecord {
  kind: 'seller' | 'buyer';
  name: string;
  stage: string;
  phone: string;
  address: string;
  /** Asking, last touch, motivation… — label, value. */
  facts: Array<[string, string]>;
  openTasks: Array<{ title: string; due: string }>;
  open: () => void;
  /** Database ids and email, for the in-call meeting invite. Absent on the sample graph. */
  sellerId?: number | null;
  buyerId?: number | null;
  email?: string;
}

export const CALL_CONTEXT_TABS: Array<{ value: CallContextTab; label: string }> = [
  { value: 'lead', label: 'Lead' },
  { value: 'script', label: 'Script' },
  { value: 'objections', label: 'Objections' },
];

// Session memory, module scope: the tab a rep last chose per mode, and the
// type size they read scripts at. Lost on reload on purpose — nothing here is
// worth a storage key.
const lastTab: Partial<Record<CallContextMode, CallContextTab>> = {};
let largeType = false;

/** Lead before a call and on inbound; the script the moment an outbound call is placed. */
export function defaultCallContextTab(mode: CallContextMode, direction?: 'inbound' | 'outbound'): CallContextTab {
  return lastTab[mode] ?? (mode === 'incall' && direction === 'outbound' ? 'script' : 'lead');
}

export interface CallContextProps {
  /** Who to show. Null renders nothing but the empty frame. */
  params: CallContextParams | null;
  /** The live call, so "used" tallies land on it. */
  callId?: string;
  mode: CallContextMode;
  /** Which way the live call went; picks the opening tab in a call. */
  direction?: 'inbound' | 'outbound';
  /** Controlled tab (the phone layout owns the segmented control); omit and the panel shows its own. */
  tab?: CallContextTab;
  onTabChange?: (tab: CallContextTab) => void;
  onCall?: (input: { to_number: string; lead_id?: string; contact_id?: string }) => void;
  /** False greys the Call button (softphone not ready, a call already up). */
  canCall?: boolean;
  onText?: (phone: string) => void;
  /** After a contact is created or edited from the panel. */
  onUpdated?: (ctx: CallContextDto) => void;
  /** CLOZR: the seller or buyer record behind the number. */
  record?: ClozrRecord | null;
  /** CLOZR: content for a fourth "Live" tab (transcript + seller intelligence). */
  liveSlot?: ReactNode;
  /** CLOZR: one more action beside Text and Open record (Request contract). */
  extraAction?: ReactNode;
}

const MODE_LABEL: Record<CallContextMode, string> = {
  precall: 'For this number',
  incall: 'On this call',
  incoming: 'Calling in',
};

export function CallContext({
  params,
  callId,
  mode,
  direction,
  tab: controlledTab,
  onTabChange,
  onCall,
  canCall = true,
  onText,
  onUpdated,
  record = null,
  liveSlot,
  extraAction,
}: CallContextProps) {
  const key = callContextKey(params);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [ctx, setCtx] = useState<CallContextDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [innerTab, setInnerTab] = useState<CallContextTab>(() => (liveSlot ? 'live' : !params && record ? 'lead' : defaultCallContextTab(mode, direction)));
  const [now, setNow] = useState<number | null>(null);
  const picked = controlledTab ?? innerTab;
  const tab = picked === 'live' && !liveSlot ? 'lead' : picked;
  const tabs = liveSlot ? [{ value: 'live' as const, label: 'Live' }, ...CALL_CONTEXT_TABS] : CALL_CONTEXT_TABS;

  useEffect(() => {
    setNow(Date.now());
    return everyWhileVisible(() => setNow(Date.now()), 30_000);
  }, []);

  // Load on every change of party. A typed number settles for 300ms first
  // (the tenth digit lands and the rep keeps typing a country code, or
  // backspaces); ids fetch at once. A stale party never sits under a new one.
  useEffect(() => {
    setCtx(null);
    setError(null);
    if (!key) {
      setLoading(false);
      return;
    }
    const p = paramsRef.current;
    if (!p) return;
    let alive = true;
    setLoading(true);
    const run = () => {
      fetchCallContext(p)
        .then((c) => {
          if (!alive) return;
          setCtx(c);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(errorMessage(e));
          setLoading(false);
        });
    };
    const t = setTimeout(run, key.startsWith('phone:') ? 300 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);

  const pickTab = (next: CallContextTab) => {
    lastTab[mode] = next;
    onTabChange?.(next);
    if (controlledTab === undefined) setInnerTab(next);
  };

  /** Re-read after an edit: the same party, fresh. */
  const reload = useCallback(async () => {
    const p = paramsRef.current;
    if (!p) return;
    try {
      const c = await fetchCallContext(p, true);
      setCtx(c);
      setError(null);
      onUpdated?.(c);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [onUpdated]);

  /**
   * A contact was just created for this number. Re-read the party; if the
   * server has not linked the new contact to the call yet, read the contact
   * directly so the rep is never left looking at "Unknown number".
   */
  const onCreated = useCallback(
    async (contactId: string) => {
      invalidateCallContext();
      const p = paramsRef.current;
      let c: CallContextDto | null = null;
      if (p) {
        try {
          c = await fetchCallContext(p, true);
        } catch {
          c = null;
        }
      }
      if (!c?.contact) {
        try {
          c = await fetchCallContext({ contact_id: contactId }, true);
        } catch (e) {
          setError(errorMessage(e));
          return;
        }
      }
      setCtx(c);
      setError(null);
      onUpdated?.(c);
    },
    [onUpdated],
  );

  /** PATCH the contact; the response replaces the contact in place, nothing else re-fetches. */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const patchContact = useCallback(
    async (input: UpdateContactInput) => {
      const id = ctx?.contact?.id;
      if (!id) return;
      setSaveState('saving');
      try {
        const r = await api.updateContact(id, input);
        invalidateCallContext();
        setCtx((cur) => (cur ? { ...cur, contact: r.contact } : cur));
        setSaveState('saved');
        onUpdated?.({ ...(ctx as CallContextDto), contact: r.contact });
      } catch (e) {
        setSaveState('error');
        setError(errorMessage(e));
      }
    },
    [ctx, onUpdated],
  );
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = setTimeout(() => setSaveState('idle'), 2000);
    return () => clearTimeout(t);
  }, [saveState]);

  const phone = ctx?.phone_e164 ?? params?.phone ?? ctx?.contact?.primary_phone ?? (record ? toE164(record.phone) || null : null);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <HeaderCard
        ctx={ctx}
        phone={phone}
        loading={loading}
        now={now}
        mode={mode}
        onCall={onCall}
        canCall={canCall}
        onText={onText}
        onCreated={onCreated}
        record={record}
        dealFacts={!!record && tab !== 'lead' && mode !== 'precall'}
        extraAction={extraAction}
      />

      {controlledTab === undefined && (
        <div className="flex items-center justify-between gap-2">
          <IosSegmented value={tab} onChange={pickTab} options={tabs} />
          <span className="truncate" style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted-2)' }}>
            {MODE_LABEL[mode]}
          </span>
        </div>
      )}

      {error && (
        <Notice
          tone="error"
          action={
            <Button tone="quiet" onClick={() => void reload()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {tab === 'live' && liveSlot}
      {tab === 'lead' && record && <RecordCard record={record} />}
      {tab === 'lead' && (!record || ctx || loading) && (
        <LeadTab ctx={ctx} loading={loading} now={now} saveState={saveState} onPatch={(input) => void patchContact(input)} />
      )}
      {tab === 'script' && <ScriptTab ctx={ctx} loading={loading} callId={callId} />}
      {tab === 'objections' && <ObjectionsTab ctx={ctx} loading={loading} callId={callId} />}
    </div>
  );
}

/* ── Header ───────────────────────────────────────────────────────────────── */

function propertyLine(p: { line1: string | null; city: string | null; state: string | null; postal_code: string | null }): string {
  return oneLineAddress(p);
}

/** "resumes Tue" / "resumes Sep 14" / "resumes 3:00 PM" — the grain a rep on a call needs. */
function resumesLabel(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const d = new Date(t);
  if (diff < 86_400_000 && d.getDate() === new Date(now).getDate()) {
    return `resumes ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diff < 7 * 86_400_000) return `resumes ${d.toLocaleDateString([], { weekday: 'short' })}`;
  return `resumes ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function Chip({ icon, children, title }: { icon: IconName; children: ReactNode; title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={title}
      style={{
        padding: '3px 8px',
        borderRadius: 6,
        background: 'var(--panel-2)',
        font: '600 10.5px/1 var(--sans)',
        color: 'var(--muted)',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon name={icon} size={11} style={{ color: 'var(--accent)' }} />
      {children}
    </span>
  );
}

function HeaderCard({
  ctx,
  phone,
  loading,
  now,
  mode,
  onCall,
  canCall,
  onText,
  onCreated,
  record,
  dealFacts = false,
  extraAction,
}: {
  ctx: CallContextDto | null;
  phone: string | null;
  loading: boolean;
  now: number | null;
  mode: CallContextMode;
  onCall?: CallContextProps['onCall'];
  canCall: boolean;
  onText?: (phone: string) => void;
  onCreated: (contactId: string) => void;
  record: ClozrRecord | null;
  /** On a call, off the Lead tab: the record's deal facts under the name, so they are up without a click. */
  dealFacts?: boolean;
  extraAction?: ReactNode;
}) {
  const c = ctx?.contact ?? null;
  const lead = ctx?.lead ?? null;
  const name = c?.display_name ?? record?.name ?? (loading || (!ctx && phone) ? 'Looking up…' : 'Unknown number');
  const address = ctx?.property ? propertyLine(ctx.property) : c?.address ? oneLineAddress(c.address) : record?.address ?? '';
  const rep = lead?.assigned_user_name ?? c?.assigned_user_name ?? null;
  const dnc = c?.status === 'dnc';

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate" style={{ font: '700 15px/1.1 var(--sans)', letterSpacing: '-0.01em', maxWidth: '100%' }}>
              {name}
            </span>
            {c && <TypeBadge type={c.type} />}
            {c && <StatusMark status={c.status} />}
            {c && <TemperatureBadge temperature={c.temperature} score={c.temperature_score} locked={c.temperature_locked} />}
          </div>

          <span
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}
          >
            <span>
              {phone ? formatPhone(phone) || phone : 'No number on file'}
              {c?.company ? ` · ${c.company}` : ''}
            </span>
            {/* Their clock, in the same words as the call hero and the call bar. */}
            <ProspectTime e164={phone} now={now} size={11.5} />
          </span>

          {(address || lead || record) && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>
              {address && (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="pin" size={12} style={{ color: 'var(--accent)' }} />
                  {address}
                </span>
              )}
              {record && <StatusMarker color={record.kind === 'buyer' ? '#1d4ed8' : '#15803d'} label={`${record.kind === 'buyer' ? 'Buyer' : 'Seller'} · ${record.stage}`} />}
              {lead && <StatusMarker color="var(--accent)" label={`Lead · ${lead.status.replace(/_/g, ' ')}`} />}
              {lead?.source && <span style={{ color: 'var(--muted-2)' }}>via {lead.source}</span>}
            </span>
          )}

          {(rep || (ctx && ctx.sequences.length > 0) || ctx?.campaign || lead?.crm_url || (c && c.tags.length > 0)) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {rep && <Chip icon="user">{rep}</Chip>}
              {ctx?.sequences.map((s) => (
                <Chip key={s.id} icon="forward" title={`${s.name} · ${s.run_status}`}>
                  {s.name} · Step {s.step}/{s.step_count}
                  {s.resume_at && now !== null ? ` · ${resumesLabel(s.resume_at, now)}` : ''}
                </Chip>
              ))}
              {ctx?.campaign && <Chip icon="transfer">{ctx.campaign.name}</Chip>}
              {lead?.crm_url && (
                // CLOZR is the CRM: with the record known it opens in place,
                // so the call and the dialer stay up, instead of a second CLOZR
                // in a new tab (which registered a second softphone mid-call).
                // Without one, a new tab still beats unloading this page.
                <a
                  href={lead.crm_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    if (record && inThisApp(lead.crm_url!)) { e.preventDefault(); record.open(); }
                  }}
                  className="inline-flex items-center gap-1"
                  style={{ font: '600 10.5px/1 var(--sans)', color: 'var(--accent)', padding: '3px 2px' }}
                >
                  Open in CRM
                  <Icon name="forward" size={11} />
                </a>
              )}
              {c?.tags.map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {onCall && phone && mode !== 'incall' && (
            <Button
              tone="green"
              disabled={!canCall || dnc}
              title={dnc ? 'Do not call' : canCall ? `Call ${formatPhone(phone)}` : 'Softphone not ready, or a call is in progress'}
              onClick={() =>
                onCall({
                  to_number: phone,
                  ...(ctx?.lead?.id ? { lead_id: ctx.lead.id } : {}),
                  ...(c?.id ? { contact_id: c.id } : {}),
                })
              }
            >
              <Icon name="phone" size={14} />
              Call
            </Button>
          )}
          {extraAction}
          {onText && phone && (
            <Button tone="ghost" onClick={() => onText(phone)} style={{ padding: '7px 10px', font: '600 11.5px/1 var(--sans)' }}>
              <Icon name="msg" size={13} />
              Text
            </Button>
          )}
          {record && (
            <Button tone="ghost" onClick={record.open} style={{ padding: '7px 10px', font: '600 11.5px/1 var(--sans)' }}>
              Open record
              <Icon name="chevron-right" size={12} />
            </Button>
          )}
          {c && (
            <a
              href={talkrWebUrl(`/contacts/${encodeURIComponent(c.id)}`)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1"
              style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted)', padding: '4px 2px' }}
            >
              Open contact
              <Icon name="chevron-right" size={12} />
            </a>
          )}
        </div>
      </div>

      {dealFacts && record && <DealFacts record={record} />}

      {ctx && !c && !loading && <QuickAdd phone={ctx.suggest_create?.phone_e164 ?? phone} onCreated={onCreated} />}
    </Card>
  );
}

/**
 * CLOZR: the deal at a glance on a live call (asking, ARV, offer, last touch
 * for a seller; buy box, latest offer, the deal they are on for a buyer)
 * with the notes and the open tasks. It sits in the header, so it is on
 * screen whichever tab (Live, Script, Objections) the call opened on, and
 * changes with the person when a session moves on. The Lead tab has it all.
 */
function DealFacts({ record }: { record: ClozrRecord }) {
  const notes = record.facts.find(([k]) => k === 'Notes')?.[1] ?? '';
  const facts = record.facts.filter(([k]) => k !== 'Notes').slice(0, 6);
  if (!facts.length && !notes && !record.openTasks.length) return null;
  return (
    <div data-testid="call-deal-facts" className="flex flex-col gap-2 pt-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
      {facts.length > 0 && (
        <div className="grid gap-x-3 gap-y-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
          {facts.map(([k, v]) => (
            <span key={k} className="flex min-w-0 flex-col gap-0.5">
              <span style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted-2)' }}>{k}</span>
              <span className="truncate" title={v} style={{ font: '600 12.5px/1.3 var(--sans)' }}>{v}</span>
            </span>
          ))}
        </div>
      )}
      {notes && (
        <p title={notes} style={{ margin: 0, font: '400 11.5px/1.45 var(--sans)', color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          <b style={{ fontWeight: 600, color: 'var(--text)' }}>Notes </b>{notes}
        </p>
      )}
      {record.openTasks.length > 0 && (
        <span className="truncate" style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>
          <Icon name="check" size={11} style={{ color: 'var(--amber)', verticalAlign: '-1px', marginRight: 4 }} />
          {record.openTasks.length} open task{record.openTasks.length === 1 ? '' : 's'} · {record.openTasks[0]!.title} ({record.openTasks[0]!.due})
        </span>
      )}
    </div>
  );
}

/** Name + type + Save: a contact exists before the greeting is over. */
function QuickAdd({ phone, onCreated }: { phone: string | null; onCreated: (contactId: string) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ContactType>('seller');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const display_name = name.trim();
    if (!display_name || !phone || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createContact({ display_name, type, phone });
      onCreated(r.contact.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const existing = typeof e.body?.contact_id === 'string' ? e.body.contact_id : null;
        if (existing) {
          onCreated(existing);
          return;
        }
        setErr('A contact already has this number.');
      } else {
        setErr(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 pt-3"
      style={{ borderTop: '1px solid var(--line)' }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Eyebrow>New contact for this number</Eyebrow>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Their name"
          aria-label="Contact name"
          className="flex-1"
          style={{ minWidth: 150 }}
          disabled={busy || !phone}
        />
        <div className="max-w-full overflow-x-auto">
          <IosSegmented value={type} onChange={setType} options={CONTACT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </div>
        <Button type="submit" tone="accent" disabled={!name.trim() || !phone || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {err && <span style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--red)' }}>{err}</span>}
    </form>
  );
}

/* ── Lead tab ─────────────────────────────────────────────────────────────── */

/** CLOZR: the record's facts and open tasks, in the Lead tab's own card style. */
function RecordCard({ record }: { record: ClozrRecord }) {
  return (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between pb-1">
        <Eyebrow>{record.kind === 'buyer' ? 'Buyer record' : 'Seller record'}</Eyebrow>
        <button
          type="button"
          onClick={record.open}
          className="inline-flex items-center gap-1"
          style={{ font: '600 11px/1 var(--sans)', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Open record
          <Icon name="chevron-right" size={12} />
        </button>
      </div>
      {[['Stage', record.stage] as [string, string], ...record.facts].map(([k, v]) => (
        <div key={k} className="grid gap-2 py-1.5" style={{ gridTemplateColumns: '96px 1fr', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ font: '500 11.5px/1.35 var(--sans)', color: 'var(--muted)' }}>{k}</span>
          <span style={{ font: '600 12px/1.35 var(--sans)' }}>{v}</span>
        </div>
      ))}
      {record.openTasks.length > 0 && (
        <div className="flex flex-col pt-2">
          <Eyebrow className="pb-1.5">Open tasks</Eyebrow>
          {record.openTasks.map((t, i) => (
            <div key={`${t.title}-${i}`} className="flex items-center gap-2.5 py-1.5">
              <span
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
                style={{ borderRadius: 8, background: 'var(--panel-2)', color: 'var(--amber)' }}
              >
                <Icon name="check" size={12} />
              </span>
              <span className="mr-auto min-w-0 truncate" style={{ font: '600 12px/1 var(--sans)' }}>
                {t.title}
              </span>
              <span className="shrink-0" style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>
                {t.due}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function LeadTab({
  ctx,
  loading,
  now,
  saveState,
  onPatch,
}: {
  ctx: CallContextDto | null;
  loading: boolean;
  now: number | null;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onPatch: (input: UpdateContactInput) => void;
}) {
  if (!ctx) {
    return (
      <Card>
        <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>{loading ? 'Loading…' : 'Type or pick a number to see who it is.'}</p>
      </Card>
    );
  }
  const c = ctx.contact;
  const summary = ctx.last_call_summary;
  const rows = ctx.activity.slice(0, 10);

  return (
    <>
      {c ? (
        <NotesCard contact={c} saveState={saveState} onPatch={onPatch} />
      ) : (
        <Card>
          <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>Save the contact above to keep notes, status, temperature and tags on this number.</p>
        </Card>
      )}

      {summary && (
        <Card className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <Eyebrow>Last call</Eyebrow>
            <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>{now === null ? '' : timeAgo(summary.at, now)}</span>
          </div>
          <p style={{ font: '400 12.5px/1.55 var(--sans)' }}>{summary.summary}</p>
          {summary.next_steps.length > 0 && (
            <div className="flex flex-col gap-1">
              <Eyebrow>Next steps</Eyebrow>
              <ul className="flex flex-col gap-1 pl-4" style={{ listStyle: 'disc' }}>
                {summary.next_steps.map((s, i) => (
                  <li key={i} style={{ font: '400 12px/1.45 var(--sans)' }}>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary.objections.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Eyebrow>Objections heard</Eyebrow>
              {summary.objections.map((o, i) => (
                <TagChip key={`${o}-${i}`}>{o}</TagChip>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-1.5">
        {ctx.open_tasks.length > 0 && (
          <div className="flex flex-col pb-2" style={{ borderBottom: '1px solid var(--line)' }}>
            <Eyebrow className="pb-1.5">Open tasks</Eyebrow>
            {ctx.open_tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 py-1.5">
                <span
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
                  style={{ borderRadius: 8, background: 'var(--panel-2)', color: 'var(--amber)' }}
                >
                  <Icon name="check" size={12} />
                </span>
                <span className="mr-auto min-w-0 truncate" style={{ font: '600 12px/1 var(--sans)' }}>
                  {t.title}
                </span>
                <span className="shrink-0" style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>
                  {[
                    t.due_at ? `due ${new Date(t.due_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : null,
                    t.assigned_user_name,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pb-1">
          <Eyebrow>Recent activity</Eyebrow>
          <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>
            {ctx.activity.length === 0 ? '' : `last ${rows.length}`}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState compact icon="clock" title="Nothing yet" hint="The first call or text with this number shows up here." />
        ) : (
          <ul>
            {rows.map((a) => (
              <ActivityRow key={`${a.kind}-${a.id}`} a={a} now={now} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function pick<T extends string>(list: readonly T[], value: string): T | null {
  return list.find((x) => x === value) ?? null;
}

/** Contact notes, status, temperature and tags — every field saves in place. */
function NotesCard({
  contact: c,
  saveState,
  onPatch,
}: {
  contact: ContactDto;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onPatch: (input: UpdateContactInput) => void;
}) {
  const busy = saveState === 'saving';
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <Eyebrow>Notes</Eyebrow>
        <span
          aria-live="polite"
          style={{
            font: '600 10px/1 var(--sans)',
            color: saveState === 'error' ? 'var(--red)' : saveState === 'saved' ? 'var(--green)' : 'var(--muted-2)',
            minHeight: 10,
          }}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
        </span>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Labeled label="Status">
          <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 0 0 11px' }}>
            <span style={{ color: STATUS_COLOR[c.status], display: 'inline-flex', flexShrink: 0 }}><Mark label={c.status} /></span>
            <select
              value={c.status}
              disabled={busy}
              aria-label="Status"
              onChange={(e) => {
                const next = pick(CONTACT_STATUSES, e.target.value);
                if (next && next !== c.status) onPatch({ status: next });
              }}
              className="min-w-0 flex-1"
              style={{ border: 'none', background: 'transparent', padding: '9px 8px 9px 0', font: '500 12.5px/1 var(--sans)', color: 'var(--text)', outline: 'none' }}
            >
              {CONTACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </span>
        </Labeled>
        <Labeled label={c.temperature_locked ? 'Temperature · set by hand' : 'Temperature'}>
          <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 6px 0 11px' }}>
            <TempDot temperature={c.temperature} score={c.temperature_score} />
            <select
              value={c.temperature}
              disabled={busy}
              aria-label="Temperature"
              title="Choosing a temperature locks it; the score stops moving it until unlocked on the contact page."
              onChange={(e) => {
                const next = pick(TEMPERATURES, e.target.value);
                if (next && next !== c.temperature) onPatch({ temperature: next });
              }}
              className="min-w-0 flex-1"
              style={{
                border: 'none',
                background: 'transparent',
                padding: '9px 4px 9px 0',
                font: '600 12.5px/1 var(--sans)',
                color: BAND_COLOR[tempBand(c.temperature, c.temperature_score)],
                outline: 'none',
              }}
            >
              {TEMPERATURES.map((t) => (
                <option key={t} value={t}>
                  {TEMP_LABEL[t]}
                </option>
              ))}
            </select>
            <span className="pl-2" style={{ borderLeft: '1px solid var(--line)', font: '600 11px/1 var(--sans)', color: 'var(--muted)' }} title="Engagement score, 0–100°">
              {degrees(c.temperature_score)}
            </span>
          </span>
        </Labeled>
      </div>

      <TagsField tags={c.tags} disabled={busy} onChange={(tags) => onPatch({ tags })} placeholder="Add a tag" />

      <textarea
        key={c.notes ?? ''}
        defaultValue={c.notes ?? ''}
        placeholder="Anything the next rep should know — saved when you click away"
        rows={4}
        disabled={busy}
        aria-label="Contact notes"
        onBlur={(e) => {
          const next = e.target.value.trim() || null;
          if (next !== c.notes) onPatch({ notes: next });
        }}
        className="min-w-0"
        style={{ ...FIELD, lineHeight: 1.45, resize: 'vertical' }}
      />
    </Card>
  );
}

const KIND_ICON: Record<CallContextActivityDto['kind'], IconName> = { call: 'phone', sms: 'msg', task: 'check' };

function ActivityRow({ a, now }: { a: CallContextActivityDto; now: number | null }) {
  const inbound = a.direction === 'inbound';
  const missed = a.kind === 'call' && (a.status === 'no_answer' || a.status === 'busy' || a.status === 'failed');
  const color = missed ? 'var(--red)' : a.kind === 'task' ? 'var(--amber)' : inbound ? 'var(--green)' : 'var(--accent)';
  const title =
    a.kind === 'task'
      ? 'Task'
      : `${a.direction === 'inbound' ? 'Inbound' : a.direction === 'outbound' ? 'Outbound' : ''} ${a.kind === 'call' ? 'call' : 'text'}`.trim();
  const facts = [
    a.kind === 'call' && a.duration_seconds !== null && a.duration_seconds > 0 ? duration(a.duration_seconds) : null,
    a.status ? a.status.replace(/_/g, ' ') : null,
    a.disposition_label,
    a.user_name,
  ].filter(Boolean);
  const text = a.note ?? a.body;
  return (
    <li className="flex gap-3 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
        style={{ borderRadius: 8, background: 'var(--panel-2)', color }}
        aria-hidden
      >
        <Icon name={KIND_ICON[a.kind]} size={12} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="mr-auto truncate" style={{ font: '600 12px/1 var(--sans)' }}>
            {title}
          </span>
          <span className="shrink-0" style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>
            {now === null ? '' : timeAgo(a.at, now)}
          </span>
        </span>
        {facts.length > 0 && (
          <span
            className="truncate"
            style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}
          >
            {facts.join(' · ')}
          </span>
        )}
        {text && (
          <span style={{ font: '400 11.5px/1.45 var(--sans)', color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
        )}
      </span>
    </li>
  );
}

/* ── Script tab ───────────────────────────────────────────────────────────── */

function ScriptTab({ ctx, loading, callId }: { ctx: CallContextDto | null; loading: boolean; callId?: string }) {
  const primary = ctx?.scripts.primary ?? null;
  const alternatives = useMemo(() => ctx?.scripts.alternatives ?? [], [ctx]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Alternatives arrive as id + title only; their bodies are fetched one at a
  // time and kept, so flipping back to one already read costs nothing.
  const [fetched, setFetched] = useState<Record<string, ScriptDto>>({});
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [large, setLarge] = useState(largeType);
  const [used, setUsed] = useState<'idle' | 'busy' | 'done'>('idle');
  const [library, setLibrary] = useState<Array<{ id: string; title: string; category: string | null }>>([]);
  const session = useSession();
  const templates = useTemplates(session.workspace?.id ?? null);
  const smsTemplates = useMemo(
    () => templates.templates.filter((t) => t.channel === 'sms' && !t.archived_at),
    [templates.templates],
  );
  const [smsId, setSmsId] = useState('');

  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;

  // A new party starts on its own primary script.
  useEffect(() => {
    setSelectedId(null);
    setUsed('idle');
    setFetchError(null);
  }, [primary?.id, ctx?.contact?.id]);

  // Call context only sends the matched script plus a few alternatives. The
  // power dialer needs every script, so the rep can switch mid-list.
  useEffect(() => {
    let alive = true;
    api.listScripts({ kind: 'script' })
      .then((r) => {
        if (!alive) return;
        setLibrary(r.scripts.filter((s) => s.enabled).map((s) => ({ id: s.id, title: s.title, category: s.category })));
      })
      .catch(() => { /* Talkr offline: the matched script still shows */ });
    return () => { alive = false; };
  }, []);

  /**
   * The picked alternative's body: GET /v1/scripts/:id, merged in the browser
   * with this party's merge_fields — the same grammar the server renders
   * `rendered_body` with. A body already read is not asked for again.
   */
  useEffect(() => {
    const id = selectedId;
    if (!id || fetchedRef.current[id]) return;
    let alive = true;
    setFetchError(null);
    api
      .getScript(id)
      .then((r) => {
        if (alive) setFetched((cur) => ({ ...cur, [id]: r.script }));
      })
      .catch((e: unknown) => {
        if (alive) setFetchError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [selectedId, retry]);

  const choose = (id: string) => {
    setSelectedId(id === primary?.id ? null : id);
    setUsed('idle');
  };

  const current: { id: string; title: string; category: string | null; body: string } | null = useMemo(() => {
    if (!ctx) return null;
    if (selectedId === null) return primary ? { id: primary.id, title: primary.title, category: primary.category, body: primary.rendered_body } : null;
    const s = fetched[selectedId];
    if (!s) return null;
    return { id: s.id, title: s.title, category: s.category, body: renderScriptMerge(s.body, ctx.merge_fields) };
  }, [ctx, selectedId, primary, fetched]);

  const markUsed = async () => {
    if (!current || used !== 'idle') return;
    setUsed('busy');
    try {
      await api.scriptUsed(current.id, {
        ...(callId ? { call_id: callId } : {}),
        ...(ctx?.contact?.id ? { contact_id: ctx.contact.id } : {}),
      });
      setUsed('done');
    } catch {
      setUsed('idle');
    }
  };

  const options = useMemo(() => {
    const base = [
      ...(primary ? [{ id: primary.id, title: primary.title, category: primary.category }] : []),
      ...alternatives.filter((a) => a.id !== primary?.id),
    ];
    const seen = new Set(base.map((o) => o.id));
    return [...base, ...library.filter((s) => !seen.has(s.id))];
  }, [primary, alternatives, library]);

  const applySms = (id: string) => {
    setSmsId(id);
    const tp = smsTemplates.find((t) => String(t.id) === id);
    if (!tp || !ctx) return;
    const phone = ctx.phone_e164 || ctx.contact?.primary_phone || '';
    openReach('text', {
      name: ctx.contact?.display_name || '',
      phone,
      body: renderMerge(tp.body_text, ctx.merge_fields),
      audience: ctx.contact?.type === 'buyer' ? 'buyer' : 'seller',
    });
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {options.length > 10 ? (
          <div className="min-w-0 flex-1" style={{ minWidth: 160 }}>
            <SearchSelect
              value={selectedId ?? primary?.id ?? ''}
              ariaLabel="Script"
              placeholder="Search scripts"
              options={options.map((o) => ({ v: o.id, label: o.category ? `${o.title} · ${o.category}` : o.title }))}
              onChange={choose}
            />
          </div>
        ) : options.length > 0 ? (
          <Select
            value={selectedId ?? primary?.id ?? options[0]?.id ?? ''}
            onChange={(e) => choose(e.target.value)}
            aria-label="Script"
            className="min-w-0 flex-1"
            style={{ minWidth: 160 }}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
                {o.category ? ` · ${o.category}` : ''}
              </option>
            ))}
          </Select>
        ) : (
          <span className="mr-auto min-w-0 truncate" style={{ font: '700 13px/1 var(--sans)' }}>
            {current?.title ?? 'Script'}
            {current?.category && <span style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted)' }}> · {current.category}</span>}
          </span>
        )}
        <IosSegmented
          value={large ? 'large' : 'normal'}
          onChange={(v) => {
            const next = v === 'large';
            setLarge(next);
            largeType = next;
          }}
          options={[
            { value: 'normal', label: 'A' },
            { value: 'large', label: 'A+' },
          ]}
        />
        {current && (
          <Button tone="ghost" onClick={() => void markUsed()} disabled={used !== 'idle'} style={{ padding: '7px 10px', font: '600 11px/1 var(--sans)' }}>
            <Icon name="check" size={12} />
            {used === 'done' ? 'Logged' : used === 'busy' ? '…' : 'Mark used'}
          </Button>
        )}
      </div>
      {smsTemplates.length > 0 && (
        <label className="flex flex-col gap-1">
          <Eyebrow>SMS template</Eyebrow>
          {smsTemplates.length > 10 ? (
            <SearchSelect
              value={smsId}
              ariaLabel="SMS template"
              placeholder="Switch text template"
              options={smsTemplates.map((t) => ({ v: String(t.id), label: t.name, at: Date.parse(t.updated_at) || 0 }))}
              onChange={applySms}
            />
          ) : (
            <Select aria-label="SMS template" value={smsId} onChange={(e) => applySms(e.target.value)} className="min-w-0">
              <option value="">Switch text template…</option>
              {smsTemplates.map((t) => (
                <option key={t.id} value={String(t.id)}>{t.name}</option>
              ))}
            </Select>
          )}
        </label>
      )}

      {!ctx ? (
        <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>{loading ? 'Loading…' : 'Type or pick a number to load its script.'}</p>
      ) : fetchError && selectedId !== null ? (
        <Notice
          tone="error"
          action={
            <Button tone="quiet" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </Button>
          }
        >
          {fetchError}
        </Notice>
      ) : selectedId !== null && !current ? (
        <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>Loading script…</p>
      ) : !current ? (
        <EmptyState
          title="No script for this contact yet"
          hint="Scripts are matched by contact type and campaign. Add one, or import the Acme Homes playbook."
          action={
            <ManageScriptsLink />
          }
        />
      ) : (
        <ScriptBody body={current.body} large={large} collapsible />
      )}
    </Card>
  );
}

/* ── Objections tab ───────────────────────────────────────────────────────── */

function ObjectionsTab({ ctx, loading, callId }: { ctx: CallContextDto | null; loading: boolean; callId?: string }) {
  const rebuttals = useMemo(() => ctx?.scripts.rebuttals ?? [], [ctx]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rebuttals) {
      if (r.category) seen.add(r.category);
      for (const t of r.tags) seen.add(t);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [rebuttals]);

  const needle = q.trim().toLowerCase();
  const shown = rebuttals.filter(
    (r) =>
      (!tag || r.category === tag || r.tags.includes(tag)) &&
      (!needle || `${r.title} ${r.rendered_body}`.toLowerCase().includes(needle)),
  );

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const used = async (id: string) => {
    setErr(null);
    try {
      await api.scriptUsed(id, {
        ...(callId ? { call_id: callId } : {}),
        ...(ctx?.contact?.id ? { contact_id: ctx.contact.id } : {}),
      });
      setFlash(id);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-3 py-2" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--bg)' }}>
        <Icon name="search" size={14} style={{ color: 'var(--muted-2)' }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What did they say? “too low”, “not selling”, “agent”…"
          aria-label="Search rebuttals"
          className="min-w-0 flex-1 bg-transparent outline-none"
          style={{ font: '400 12.5px/1 var(--sans)' }}
        />
        {q && (
          <button type="button" onClick={() => setQ('')} aria-label="Clear search" style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={tag === null} onClick={() => setTag(null)}>
            All
          </FilterChip>
          {tags.map((t) => (
            <FilterChip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </FilterChip>
          ))}
        </div>
      )}

      {err && <Notice tone="error">{err}</Notice>}

      {!ctx ? (
        <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>{loading ? 'Loading…' : 'Type or pick a number to load rebuttals.'}</p>
      ) : rebuttals.length === 0 ? (
        <EmptyState
          title="No rebuttals yet"
          hint="Add objection rebuttals under Scripts, or import the Acme Homes playbook."
          action={
            <ManageScriptsLink />
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState compact icon="search" title="Nothing matches" hint="Try another word, or clear the filter above." />
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => {
            const isOpen = open === r.id;
            return (
              <li key={r.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  aria-expanded={isOpen}
                  className="lift-row flex w-full items-center gap-2.5 py-2.5 text-left"
                  // No inline `background`: it would outrank the .lift-row hover.
                  style={{ border: '1px solid transparent', borderRadius: 8, cursor: 'pointer', padding: '10px 6px' }}
                >
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
                  <span className="mr-auto min-w-0 truncate" style={{ font: '600 12.5px/1 var(--sans)' }}>
                    {r.title}
                  </span>
                  {r.category && (
                    <span className="shrink-0" style={{ font: '600 11px/1 var(--sans)', color: 'var(--muted-2)' }}>
                      {r.category}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="flex flex-col gap-2.5 pb-3 pl-6">
                    <ScriptBody body={r.rendered_body} large={largeType} />
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        tone={flash === r.id ? 'green' : 'ghost'}
                        onClick={() => void used(r.id)}
                        style={{ padding: '7px 10px', font: '600 11px/1 var(--sans)' }}
                      >
                        <Icon name="check" size={12} />
                        {flash === r.id ? 'Logged' : 'Used'}
                      </Button>
                      {r.tags.map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ── Script body ──────────────────────────────────────────────────────────── */

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineRuns(text).map((run, i) =>
        run.kind === 'bold' ? (
          <strong key={i} style={{ fontWeight: 700 }}>
            {run.text}
          </strong>
        ) : run.kind === 'token' ? (
          <span key={i} title="No value for this field" style={{ color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 4, padding: '0 3px' }}>
            {run.text}
          </span>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

function Block({ block, size, lh }: { block: ScriptBlock; size: number; lh: number }) {
  if (block.type === 'ul') {
    return (
      <ul className="flex flex-col gap-1 pl-5" style={{ listStyle: 'disc' }}>
        {block.items.map((item, i) => (
          <li key={i} style={{ font: `400 ${size}px/${lh} var(--sans)` }}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === 'note') {
    return (
      <p style={{ margin: 0, borderLeft: '2px solid var(--accent)', paddingLeft: 10, color: 'var(--muted)', font: `500 ${size - 1}px/${lh} var(--sans)` }}>
        <Inline text={block.text} />
      </p>
    );
  }
  return (
    <p style={{ margin: 0, font: `400 ${size}px/${lh} var(--sans)` }}>
      <Inline text={block.text} />
    </p>
  );
}

/**
 * Markdown-lite renderer for script bodies: `## ` sections (collapsible when
 * asked), `- ` bullets, `**bold**`, `> ` notes, and `{merge}` tokens that were
 * left unfilled shown in the accent so the rep knows to improvise a word.
 */
/** Scripts and rebuttals are managed in CLOZR: Settings → Talkr → Scripts. */
function ManageScriptsLink() {
  const { openTalkrSettings } = useSoftphone();
  return (
    <button type="button" onClick={() => openTalkrSettings('scripts')} style={{ font: '600 12px/1 var(--sans)', color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
      Manage scripts
    </button>
  );
}

export function ScriptBody({ body, large = false, collapsible = false }: { body: string; large?: boolean; collapsible?: boolean }) {
  const sections = useMemo(() => parseScript(body), [body]);
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  useEffect(() => setClosed({}), [body]);
  const size = large ? 16.5 : 13.5;
  const lh = large ? 1.6 : 1.55;

  if (sections.length === 0) {
    return <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>Empty script.</p>;
  }

  return (
    <div className="flex flex-col gap-3.5">
      {sections.map((s, i) => {
        const isClosed = collapsible && Boolean(closed[i]);
        const titleStyle = { font: `700 ${large ? 14 : 12.5}px/1.2 var(--sans)`, letterSpacing: '-0.01em' } as const;
        return (
          <section key={i} className="flex flex-col gap-2">
            {s.title !== null &&
              (collapsible ? (
                <button
                  type="button"
                  onClick={() => setClosed((c) => ({ ...c, [i]: !c[i] }))}
                  aria-expanded={!isClosed}
                  className="flex items-center gap-1.5 text-left"
                  style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}
                >
                  <Icon name={isClosed ? 'chevron-right' : 'chevron-down'} size={13} style={{ color: 'var(--muted-2)' }} />
                  <span style={titleStyle}>{s.title}</span>
                </button>
              ) : (
                <span style={titleStyle}>{s.title}</span>
              ))}
            {!isClosed && s.blocks.map((b, j) => <Block key={j} block={b} size={size} lh={lh} />)}
          </section>
        );
      })}
    </div>
  );
}

/** A link into this same CLOZR, which opens in place rather than in another tab. */
function inThisApp(url: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
