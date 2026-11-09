'use client';

/**
 * The Dialer, built around the call. Left: the phone (keypad, caller ID,
 * record and AI switches, dial modes, the Recent / Queue / Voicemail lists),
 * and the call's own controls once one is up. Centre, one pane at a time: the
 * Inbox (the default between calls), the script that fills itself in from the
 * record (ScriptPanel, the default on a call, with the live transcript and the
 * Say next card beside it, LiveCoach, and the call notes), or Campaigns
 * (between calls only). Right (wide desks): the record of whoever is on the line
 * (RecordRail: contact, Smart Summary, property or buy box), then their whole
 * text / email thread (DialerTexts); the profile to create when there is no
 * record. Narrower desks stack the right column under the notes. Bottom: the
 * teammates' live calls strip, for anyone allowed to monitor.
 *
 * Scripts come from the workspace's scripts table (Talkr /v1/scripts, the
 * same rows Settings → Talkr → Scripts edits); the Acme Homes playbook in
 * lib/acme-homes-playbook.ts is the fallback where there is no table (the
 * sample-data demo, a sign-in without Talkr). Merge fields fill from the
 * CLOZR record behind the number and Talkr's own merge map.
 *
 * CLOZR seam: the softphone is softphoneAdapter.tsx; a call goes out through
 * CLOZR (`V`) so it carries the record, transcript, intelligence and wrap-up;
 * the sample-data demo renders the same screen on V's scripted call.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { everyWhileVisible } from '@/lib/visible-timer';
import { api, type CallContextDto, type CallContextParams, type ScriptDto } from '@/lib/talkr-web/api';
import { fetchCallContext } from '@/lib/talkr-web/callContext';
import { formatPhone, tzTime, toE164, zoneForNumber } from '@/lib/talkr-web/time';
import { EXAMPLE_SCRIPTS } from '@/lib/example-playbook';
import { mergeFieldsFor, rebuttalsFor, scriptsFor } from '@/lib/script-doc';
import { useSoftphone } from './softphoneAdapter';
import { TopBar } from './TopBar';
import { ActiveCall } from './ActiveCall';
import { DialerViewToggle } from './PowerDialer';
import { LiveCallsStrip, MonitorCard } from './Supervision';
import { Icon } from './Icon';
import { Button, Card, EmptyState } from './ui';
import { IosSegmented } from './ios';
import type { ClozrRecord } from './CallContext';
import { CallProfileCard } from './CallProfileCard';
import { DialerTexts } from './DialerTexts';
import { CampaignsPanel } from './Campaigns';
import { CallerIdPicker, callerIdLabel } from './CallerIdPicker';
import { ScriptPanel, type PanelScript } from './ScriptPanel';
import { LiveCoach } from './LiveCoach';
import { RecordRail } from './RecordRail';
import { OutcomePicker } from './OutcomePicker';
import type { OutcomeKey } from '@/lib/call-outcomes';
import type { ClozrRecord as CallRecord } from './CallContext';
import { openReach } from '@/app/components/record/reach';
import { Inbox } from '@/app/clozr/screens/Inbox';
import { RequestContractButton } from '@/components/contract-request/RequestContractButton';
import { ComprIcon } from '@/components/ds/ComprIcon';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import {
  DialBlock,
  LiveCallCard,
  NotesCard,
  QueueList,
  RecentList,
  TalkrNotSignedIn,
  VoicemailList,
  WrapUpCard,
  ScriptedCall,
} from './DialerParts';

/** CLOZR: the list under the dial column. */
type DialList = 'recent' | 'queue' | 'voicemail';
/** CLOZR: what the middle column shows. */
type Centre = 'inbox' | 'script' | 'campaigns';

export function DialerScreen({ V }: { V: ClozrView }) {
  const { callState, authed, active, incoming, team, me, setMe, monitor } = useSoftphone();
  const [digits, setDigits] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [list, setList] = useState<DialList>('recent');
  const wide = useWideDesk();

  // A phone has no dialer screen: the full-screen phone (PhoneScreen.tsx) is
  // the one phone there, so landing here on a phone opens it instead.
  const isMobile = V.isMobile;
  const openPhone = useRef(V.openPhone);
  useEffect(() => { openPhone.current = V.openPhone; });
  useEffect(() => { if (isMobile) openPhone.current(); }, [isMobile]);

  const inCall = callState !== 'idle';
  const wrap = callState === 'wrapup';

  // Client-side only: the server cannot know the rep's zone.
  useEffect(() => {
    setNow(Date.now());
    return everyWhileVisible(() => setNow(Date.now()), 30_000);
  }, []);

  // A call placed from here clears the field.
  useEffect(() => { if (inCall) setDigits(''); }, [inCall]);

  const dialZone = useMemo(() => (digits.length >= 3 ? zoneForNumber(toE164(digits)) : null), [digits]);

  // Ten digits is a whole number: that is when the party's record loads.
  const contextPhone = useMemo(() => (digits.replace(/\D/g, '').replace(/^1/, '').length === 10 ? toE164(digits) : null), [digits]);
  const incomingPhone = incoming && /^\+\d{7,}$/.test(incoming.from) ? incoming.from : null;

  const activeCallId = authed && active && active.record.id && active.record.id !== 'unknown' && active.record.id !== 'demo' ? active.record.id : undefined;
  const callUp = inCall || wrap || V.callState !== 'idle';
  const wrapping = wrap || V.callState === 'wrap';
  // Between calls the middle is the inbox; a call brings up the script, and hanging up goes back.
  const onCall = callUp && !wrapping;
  const [centre, setCentre] = useState<Centre>('inbox');
  const [centreFor, setCentreFor] = useState(onCall);
  if (centreFor !== onCall) { setCentreFor(onCall); setCentre(onCall ? 'script' : 'inbox'); }

  // The outcome picked while the call is live, held for the wrap-up so Enter
  // there saves it. The live picker reports it; a new call's picker clears it.
  const [held, setHeld] = useState<OutcomeKey | null>(null);
  useEffect(() => { if (!callUp) setHeld(null); }, [callUp]);
  const liveTarget = onCall ? V.outcomeTarget : null;
  const livePicker = liveTarget && (
    <Card key={liveTarget.key}>
      <OutcomePicker V={V} target={liveTarget} variant="card" armed={false} canPick heading="Outcome" saveLabel="Save" onPick={setHeld} />
    </Card>
  );

  // The number on screen: the live call's other party, the number called
  // (demo, wrap-up), the caller ringing in, or the one typed.
  const callPhone = active
    ? (active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number)
    : callUp ? (toE164(V.callTarget?.phone ?? '') || null) : null;
  const phone = callPhone || incomingPhone || contextPhone;
  const record: ClozrRecord | null = callUp ? V.callRecord : phone ? V.dialerRecordFor(phone) : null;

  const { scripts, rebuttals, values, pinned, makeDefault, openRebuttal, setOpenRebuttal, rebuttalShown, used } = useCallScripts(V, { authed, activeCallId, phone, record });

  const hint = dialZone && now !== null ? `${tzTime(dialZone, now)} their time` : callerIdLabel(me) || V.callerIdLabel || 'No number assigned to you yet';
  // The thread is on screen for the number up: Text jumps to its composer; any other number opens Quick Reach.
  const openText = (p?: unknown) => {
    const box = document.querySelector<HTMLTextAreaElement>('.dial-texts .composer-pill textarea, #dial-text-draft');
    if (box && typeof p === 'string' && phone && toE164(p) === phone) return box.focus();
    return typeof p === 'string' && p ? openReach('text', { name: '', phone: p }) : V.goInbox();
  };
  const pickRecent = (p: string) => setDigits(p.replace(/\D/g, '').slice(-10));

  const lists = (
    <Card className="flex flex-col gap-0.5">
      <div className="pb-1.5">
        <IosSegmented
          value={list}
          onChange={setList}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'queue', label: 'Queue' },
            { value: 'voicemail', label: 'Voicemail' },
          ]}
        />
      </div>
      {list === 'recent' && <RecentList V={V} big={false} onPick={pickRecent} />}
      {list === 'queue' && <QueueList V={V} />}
      {list === 'voicemail' && <VoicemailList V={V} />}
    </Card>
  );

  // Open COMPR beside Open record: the seller's report in the COMPR window (it underwrites the house first when it never ran).
  const compr = phone ? V.dialerComprFor(phone) : null;
  const contract = (
    <>
      {compr && (
        <button type="button" className="rr-btn" onClick={compr.open}
          title={compr.linked ? 'The COMPR report in its own window' : 'COMPR has not run this house: this underwrites it, then opens the report in its own window'}>
          <ComprIcon size={13} /> Open COMPR
        </button>
      )}
      <RequestContractButton V={V} phone={callUp ? null : phone} />
    </>
  );
  // Narrow desks: one stacked column, the thread under the Smart Summary.
  const rail = (
    <>
      {callUp && <CallProfileCard V={V} />}
      {livePicker}
      {record ? (
        <RecordRail V={V} record={record} onText={openText} actions={contract} between={phone ? <DialerTexts V={V} phone={phone} /> : null} />
      ) : (
        <>
          <CreateProfileCard V={V} phone={phone ?? ''} />
          {phone && <DialerTexts V={V} phone={phone} />}
        </>
      )}
    </>
  );
  // Wide desks: who it is on top (its own scroll, as tall as it needs while the
  // thread keeps at least 380px), the conversation filling the rest so the
  // composer is always on screen.
  const rightColumn = (
    <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
      <div className={`flex min-h-0 flex-col gap-3 overflow-auto ${phone ? 'max-h-[calc(100%-392px)] shrink-0' : 'flex-1'}`}>
        {callUp && <CallProfileCard V={V} />}
        {livePicker}
        {record ? <RecordRail V={V} record={record} onText={openText} actions={contract} /> : <CreateProfileCard V={V} phone={phone ?? ''} />}
      </div>
      {phone && <DialerTexts V={V} phone={phone} fill />}
    </div>
  );

  return (
    <>
      <TopBar title="Dialer" subtitle={wrap ? 'Wrapping up' : inCall ? 'One live call' : incomingPhone ? `Calling in from ${formatPhone(incomingPhone)}` : 'Ready to dial'} titleSlot={<DialerViewToggle />} />
      <TalkrNotSignedIn V={V} />

      {V.isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <Card className="flex w-full max-w-sm flex-col items-center gap-3" style={{ padding: '22px 18px' }}>
            <Icon name="phone" size={22} style={{ color: 'var(--accent)' }} />
            <span style={{ font: '600 15px/1.3 var(--sans)' }}>The phone opens full screen</span>
            <span style={{ font: '400 13px/1.45 var(--sans)', color: 'var(--muted)' }}>Keypad, recents, your queue and voicemail, and the call itself.</span>
            <button type="button" onClick={() => V.openPhone()} className="w-full" style={{ height: 50, borderRadius: 14, border: 0, background: 'var(--accent)', color: '#fff', font: '600 17px/1 var(--sans)', cursor: 'pointer' }}>
              Open phone
            </button>
          </Card>
        </div>
      ) : (
        <div className="dial-desk flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className={`grid min-h-0 flex-1 gap-3 overflow-hidden p-3 ${wide ? 'grid-cols-[320px_minmax(0,1fr)_minmax(400px,1fr)]' : 'grid-cols-[300px_minmax(0,1fr)]'}`}>
            {/* ── Phone, or the call once one is up ───────────────────── */}
            <div className="flex min-h-0 flex-col gap-3 overflow-auto">
              {callUp ? (
                wrapping ? <WrapUpCard V={V} held={held} /> : monitor ? <MonitorCard /> : active ? <ActiveCall team={team} onText={openText} recording={V.rec} /> : <ScriptedCall V={V} />
              ) : (
                <Card className="dial-phone flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 className="dial-h">Phone</h2>
                    <p className="dial-hint">{hint}</p>
                  </div>
                  <DialBlock V={V} digits={digits} setDigits={setDigits} error={null} keyboard />
                  {me && me.org_numbers.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="dial-label">Caller ID</span>
                      <CallerIdPicker me={me} onChange={setMe} compact />
                    </div>
                  )}
                </Card>
              )}
              {lists}
            </div>

            {/* ── Middle: the inbox, the script (with the coach and notes on a call) or campaigns, one at a time ── */}
            <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
              <IosSegmented
                value={centre}
                onChange={setCentre}
                options={[
                  { value: 'inbox', label: 'Inbox' },
                  { value: 'script', label: 'Script' },
                  ...(onCall ? [] : [{ value: 'campaigns' as const, label: 'Campaigns' }]),
                ]}
              />
              {centre === 'inbox' ? (
                <Card padded={false} className="dial-inbox flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <Inbox V={V} compact />
                </Card>
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto">
                  {centre === 'campaigns' ? (
                    <Card className="min-w-0"><CampaignsPanel V={V} /></Card>
                  ) : onCall ? (
                    <div className="dial-centre grid gap-3">
                      <Card padded={false} className="min-w-0">
                        <ScriptPanel scripts={scripts} rebuttals={rebuttals} values={values} openRebuttalId={openRebuttal} onRebuttalShown={rebuttalShown} onUsed={used} defaultId={pinned?.id ?? null} onDefault={makeDefault} />
                      </Card>
                      <LiveCoach V={V} rebuttals={rebuttals} values={values} onOpenRebuttal={setOpenRebuttal} />
                    </div>
                  ) : (
                    <Card padded={false} className="min-w-0">
                      <ScriptPanel scripts={scripts} rebuttals={rebuttals} values={values} onUsed={used} defaultId={pinned?.id ?? null} onDefault={makeDefault} />
                    </Card>
                  )}
                  {centre === 'script' && onCall && <LiveCallCard V={V} part="intel" />}
                  {centre === 'script' && <NotesCard V={V} />}
                  {!wide && rail}
                </div>
              )}
            </div>

            {/* ── Right: who is on the line, their Smart Summary, then the whole text / email thread ── */}
            {wide && rightColumn}
          </div>
          <LiveCallsStrip />
        </div>
      )}
    </>
  );
}

/* ── Scripts and context ──────────────────────────────────────────────────── */

/**
 * The script, rebuttals and merge values for whoever is on screen: the rep's
 * default script first, then Talkr's match for the party, then the playbook.
 * Shared by the dialer and the power dialer so both read the same script.
 */
export function useCallScripts(V: ClozrView, input: { authed: boolean; activeCallId: string | undefined; phone: string | null; record: CallRecord | null }) {
  const { authed, activeCallId, phone, record } = input;
  const { me } = useSoftphone();
  // Talkr's view of the party (its merge map, the script it matched), for a
  // signed-in rep it knows. The demo and an unlinked rep get CLOZR's record alone.
  const params = useMemo<CallContextParams | null>(() => {
    if (!authed) return null;
    if (activeCallId) return { call_id: activeCallId };
    return phone ? { phone } : null;
  }, [authed, activeCallId, phone]);
  const ctx = useTalkrContext(params);
  const library = useScriptLibrary(authed);

  const kind: 'seller' | 'buyer' = record?.kind ?? (ctx?.contact?.type === 'buyer' ? 'buyer' : 'seller');
  const repName = me?.display_name ?? V.requestTeam.find((t) => t.id === V.requestMe)?.name ?? null;
  const values = useMemo(
    () => mergeFieldsFor(record, { name: repName, company: V.workspaceName }, ctx?.merge_fields ?? {}),
    [record, repName, V.workspaceName, ctx],
  );
  // The rep's default script (profiles.default_script, migration 389) leads, whatever the contact's kind,
  // with its category's rebuttals: Alex dials Compr prospects on the Compr script.
  const [defaultTitle, setDefaultTitle, role] = useDefaultScript();
  // No pin in this workspace: the rep's role picks (dispositions dial buyers on the Dispo script).
  const roleCategory = role ? ROLE_SCRIPT_CATEGORY[role] : undefined;
  const pinned = library.find((s) => s.kind === 'script' && s.title === defaultTitle)
    ?? (roleCategory ? library.find((s) => s.kind === 'script' && s.category === roleCategory) : undefined)
    ?? null;
  const scripts = useMemo(() => {
    const list = scriptsFor(library, kind, ctx?.scripts.primary?.title);
    return asPanel(pinned ? [pinned, ...list.filter((s) => s.id !== pinned.id)] : list);
  }, [library, kind, ctx, pinned]);
  const rebuttals = useMemo(() => {
    const list = rebuttalsFor(library, kind);
    const extra = pinned?.category ? library.filter((s) => s.kind === 'rebuttal' && s.category === pinned.category && !list.includes(s)) : [];
    return asPanel([...extra, ...list]);
  }, [library, kind, pinned]);
  const makeDefault = useCallback((id: string) => { const t = library.find((s) => s.id === id)?.title; if (t) setDefaultTitle(t); }, [library, setDefaultTitle]);
  const [openRebuttal, setOpenRebuttal] = useState<string | null>(null);
  const rebuttalShown = useCallback(() => setOpenRebuttal(null), []);
  const used = authed
    ? (id: string) => { if (!id.startsWith('hp:')) void api.scriptUsed(id, { ...(activeCallId ? { call_id: activeCallId } : {}), ...(ctx?.contact?.id ? { contact_id: ctx.contact.id } : {}) }).catch(() => {}); }
    : undefined;
  return { scripts, rebuttals, values, pinned, kind, makeDefault, openRebuttal, setOpenRebuttal, rebuttalShown, used };
}

const FALLBACK: ScriptDto[] = EXAMPLE_SCRIPTS.map((s, i) => ({
  id: `hp:${i}`, kind: s.kind, title: s.title, category: s.category, tags: s.tags, contact_types: s.contact_types,
  campaign_id: null, body: s.body, sort_order: i, enabled: true, created_at: '', updated_at: '',
}));

let libraryCache: { at: number; scripts: ScriptDto[] } | null = null;

/** The workspace's scripts and rebuttals, read once a minute; the playbook where there are none. */
function useScriptLibrary(authed: boolean): ScriptDto[] {
  const [lib, setLib] = useState<ScriptDto[]>(() => libraryCache?.scripts ?? FALLBACK);
  useEffect(() => {
    if (!authed) { setLib(FALLBACK); return; }
    if (libraryCache && Date.now() - libraryCache.at < 60_000) { setLib(libraryCache.scripts); return; }
    let alive = true;
    api.listScripts()
      .then((r) => {
        const enabled = r.scripts.filter((s) => s.enabled).sort((a, b) => a.sort_order - b.sort_order);
        libraryCache = { at: Date.now(), scripts: enabled.length ? enabled : FALLBACK };
        if (alive) setLib(libraryCache.scripts);
      })
      .catch(() => { if (alive) setLib(FALLBACK); });
    return () => { alive = false; };
  }, [authed]);
  return lib;
}

/** The script category a role dials on when the rep has not picked a default in this workspace. */
const ROLE_SCRIPT_CATEGORY: Record<string, string> = { dispositions: 'Dispo', sdr: 'Compr' };

/**
 * The rep's default script title in the open workspace, plus their role there.
 * profiles.default_script holds a JSON map {workspaceId: title}; a plain title
 * (the first version) counts for every workspace until one is picked here.
 */
function useDefaultScript(): [string | null, (title: string) => void, string | null] {
  const s = useSession();
  const uid = s.user?.id ?? null;
  const ws = s.workspace?.id ?? null;
  const [raw, setRaw] = useState<string | null>(null);
  useEffect(() => {
    if (!supabase || !uid) return;
    let alive = true;
    void supabase.from('profiles').select('default_script' as 'id').eq('id', uid).maybeSingle()
      .then(({ data }) => { if (alive) setRaw((data as { default_script?: string | null } | null)?.default_script ?? null); });
    return () => { alive = false; };
  }, [uid]);
  const map = parseDefaults(raw);
  const title = (ws !== null ? map[String(ws)] : undefined) ?? map['*'] ?? null;
  const save = useCallback((t: string) => {
    const next = JSON.stringify({ ...parseDefaults(raw), [ws === null ? '*' : String(ws)]: t });
    setRaw(next);
    if (supabase && uid) void supabase.from('profiles').update({ default_script: next } as never).eq('id', uid).then(({ error }) => { if (error) console.warn('default script', error.message); });
  }, [uid, ws, raw]);
  return [title, save, s.workspace?.role ?? null];
}

function parseDefaults(raw: string | null): Record<string, string> {
  if (!raw) return {};
  if (raw.startsWith('{')) { try { return JSON.parse(raw) as Record<string, string>; } catch { return {}; } }
  return { '*': raw };
}

/** Talkr's call context for the party, debounced by the shared cache in lib/talkr-web/callContext. */
function useTalkrContext(params: CallContextParams | null): CallContextDto | null {
  const [ctx, setCtx] = useState<CallContextDto | null>(null);
  const key = params ? JSON.stringify(params) : null;
  useEffect(() => {
    if (!key) { setCtx(null); return; }
    let alive = true;
    const id = setTimeout(() => {
      fetchCallContext(JSON.parse(key) as CallContextParams).then((c) => { if (alive) setCtx(c); }, () => { if (alive) setCtx(null); });
    }, 250);
    return () => { alive = false; clearTimeout(id); };
  }, [key]);
  return ctx;
}

const asPanel = (list: ScriptDto[]): PanelScript[] => list.map((s) => ({ id: s.id, title: s.title, category: s.category, tags: s.tags, body: s.body }));

/* ── Create profile ───────────────────────────────────────────────────────── */

const PROFILE_KINDS: { value: 'seller' | 'buyer' | 'agent' | 'wholesaler' | 'vendor'; label: string; hint: string }[] = [
  { value: 'seller', label: 'Seller', hint: 'A lead with a property. Lands in People.' },
  { value: 'buyer', label: 'Buyer', hint: 'A cash buyer. Needs a phone and an email.' },
  { value: 'agent', label: 'Agent', hint: 'A realtor, saved with your vendors.' },
  { value: 'wholesaler', label: 'Wholesaler', hint: 'Another wholesaler, saved with your vendors.' },
  { value: 'vendor', label: 'Vendor', hint: 'Title, lender, contractor and the rest.' },
];

/** The number on screen becomes a profile without leaving the dialer; the full form opens filled in. */
export function CreateProfileCard({ V, phone }: { V: ClozrView; phone: string }) {
  const [kind, setKind] = useState<(typeof PROFILE_KINDS)[number]['value']>('seller');
  const picked = PROFILE_KINDS.find((k) => k.value === kind)!;
  if (!phone) {
    return (
      <Card>
        <EmptyState compact icon="user" title="No one on the line" hint="Dial a number or pick a recent call and the record shows here: who they are, the property, the numbers and the open tasks." />
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="dial-h">No record for {formatPhone(phone)}</h2>
        <p className="dial-hint">Create one and the call lands on it. The number is filled in for you.</p>
      </div>
      <div role="radiogroup" aria-label="Profile type" className="flex flex-wrap gap-1.5">
        {PROFILE_KINDS.map((k) => (
          <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} onClick={() => setKind(k.value)} className="dial-chip">
            {k.label}
          </button>
        ))}
      </div>
      <p className="dial-hint">{picked.hint}</p>
      <Button tone="accent" onClick={() => V.addProfile(kind, phone)} style={{ justifyContent: 'center' }}>
        <Icon name="user" size={14} />
        Create {picked.label.toLowerCase()} profile
      </Button>
    </Card>
  );
}

/** The desk is wide enough for the record column (1280px). */
export function useWideDesk(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia('(min-width: 1280px)');
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    () => window.matchMedia('(min-width: 1280px)').matches,
    () => true,
  );
}
