// Settings — the workspace, the team, and what CLOZR is connected to.
//
// Two kinds of setting live here and the screen says which is which. The
// workspace name is a real Supabase row. The display preference below it is
// per browser (it is about this screen, not the workspace) and is labelled
// that way. Toggles with nothing behind them were removed rather than shown:
// a switch that quietly does nothing is worse than no switch.
'use client';

import { DataHistory } from '@/components/DataHistory';
import { useConfirm } from '@/components/ds/Confirm';
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { COMPR, DEAL_MACHINE, TALKR } from '@/app/clozr/brand';
import { INGEST_SOURCES, type IngestKey, type MintedKey, ingestUrl, issueKey, listKeys, setKeyActive, setSigningSecret, talkrWebhookUrl } from '@/lib/ingest';
import { displayName, useSession } from '@/lib/session';
import { useViewAs } from '@/lib/view-as';
import { ASSIGNABLE_ROLES, ROLE_LABEL, type Role, type Teammate, addTeammate, isAdmin, listTeam, removeTeammate, resendTeammateInvite, setRole } from '@/lib/team';
import { STATES } from '@/lib/us-states';
import { pandadocWebhookUrl } from '@/lib/contracts';
import { ContractSettings } from '@/components/ContractSettings';
import { PodioCard } from '@/components/PodioImport';
import { ZapierWebhooks } from '@/components/ZapierWebhooks';
import { IvueitCard } from '@/components/IvueitCard';
import { InvestorBaseCard } from '@/components/InvestorBaseCard';
import { RoundRobinSettings } from '@/components/RoundRobinSettings';
import { ensureOnTalkr, syncTeamToTalkr } from '@/app/components/phone/TeammatePhone';
import { ReadOnlyNote, ViewAsButton } from '@/components/ViewAs';
import { seg, segWrap, trayBtn } from '@/components/ds/chrome';
import { READ_ONLY_TITLE, useCanWrite } from '@/lib/read-only-context';
import { TalkrSettings } from './TalkrSettings';
import { OutboundOsSettings } from './OutboundOsSettings';
import { lastSettingsTab, onSettingsTab, rememberSettingsTab, takeSettingsTab, type OutboundSettingsTab, type SettingsMain, type SettingsTarget, type TalkrSettingsTab } from './settingsTab';
import { UserAvatar } from '@/components/UserAvatar';
import { TalkrMark } from '@/app/components/brand/TalkrMark';
import { PlanBuilder } from '@/app/components/plans/PlanBuilder';
import { TemplatesManager } from '@/app/components/templates/TemplatesManager';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { Mark } from '@/components/ds/mark';
import { FloorShowSettings } from './FloorShowSettings';
import { readPrefs, serverPrefs, subscribePrefs, writePrefs, type Prefs } from '../prefs';
import { CompanyFacts } from '@/app/components/phone/CompanyFacts';
import { VoiceAgentSettings } from '@/app/components/voice-agent/VoiceAgentSettings';
import { AutopilotPanel } from '@/app/components/ai-agent/AutopilotPanel';
import { ArchiveSettings } from '@/components/ArchiveSettings';

const DISPLAY: [keyof Prefs, string, string][] = [
  ['compactRows', 'Compact table rows', 'Shorter rows and smaller type on People, Deals and Tasks — more records per screen'],
];

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '11.5px',
  color: '#71717a',
  fontWeight: 500,
  marginBottom: '6px',
};

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e4e4e7',
  borderRadius: '12px',
  padding: '16px 18px',
  marginBottom: '12px',
};


/**
 * The sections, grouped the way the rep thinks about them. The side nav on a
 * desktop and the chip rows on a phone are both drawn from this; the hint is
 * the one line under each pane's title, replacing the intro cards that used
 * to push the controls down the page.
 */
type NavItem = { tab: string; label: string; hint: string };
const NAV: { main: SettingsMain; label: string; items: NavItem[] }[] = [
  { main: 'workspace', label: 'Workspace', items: [
    { tab: 'general', label: 'General', hint: 'The workspace name, how tables display in this browser, and what this deployment is wired to.' },
    { tab: 'company', label: 'Company & 10DLC', hint: 'Legal name, EIN, address and the texting campaign — typed once, filed by CLOZR: the 10DLC brand and campaign, the Telnyx enterprise, and Free Caller Registry.' },
    { tab: 'team', label: 'Team', hint: 'Who is in the workspace and what each role can see. The database enforces the role, not just the menu.' },
    { tab: 'roundrobin', label: 'Round robin', hint: 'Who new leads and new deals are dealt to: an acquisitions rotation per lead source (yourcompany.com, Jotform), a dispositions rotation for novations. Take anyone out of a rotation and put them back.' },
    { tab: 'integrations', label: 'Integrations', hint: 'Contracts through PandaDoc, the Podio import, Zapier webhooks, and the ingest keys other systems post with.' },
    { tab: 'agent', label: 'AI Agent', hint: 'The phone agent that answers sellers and buyers with what the record already knows: connect it to ElevenLabs, choose its voice, and test it before it takes a call.' },
    { tab: 'keys', label: 'Server keys', hint: 'Project secrets the edge functions read, named here so nothing has to be guessed — the values are never entered or shown.' },
    { tab: 'archive', label: 'Archive', hint: 'Every archived seller and buyer. Search them and put anyone back on every list.' },
    { tab: 'history', label: 'Skip trace & import history', hint: 'Every skip trace and import: who ran it, how many records, what came back, and the skip-trace credits it used.' },
    { tab: 'floor', label: 'Floor show', hint: 'Turn off leaderboard or badge notifications for yourself. Admins also preview the sounds and set the spin-the-wheel prize.' },
  ] },
  { main: 'outbound', label: 'Outbound OS', items: [
    { tab: 'email', label: 'Email deliverability', hint: 'Resend on a sending subdomain for dispo blasts: domain authentication, the daily ramp, suppressions, and the checklist that refuses a blast that would burn reputation.' },
    { tab: 'google', label: 'Google', hint: 'Gmail for one-to-one email and campaign replies, Calendar sync, and the Google Drive deals folder. CLOZR never adds open-tracking pixels to one-to-one email.' },
    { tab: 'keys', label: 'Email keys', hint: 'The Resend and Google secrets on the project, and the Resend webhook that lands bounces and complaints on the suppression list.' },
  ] },
  { main: 'talkr', label: 'Talkr', items: [
    { tab: 'account', label: 'Account', hint: 'Your connection to the phone, caller ID, working zone, and the Talkr API origin for a self-hosted Talkr.' },
    { tab: 'numbers', label: 'Numbers', hint: 'Each person’s numbers and caller ID, call and SMS flows, company lines.' },
    { tab: 'audio', label: 'Audio & sounds', hint: 'Microphone, speaker, processing, ringtone, your voicemail greeting and notification sounds.' },
    { tab: 'scripts', label: 'Scripts', hint: 'Call scripts and rebuttals. Managers edit; reps read them during a call.' },
    { tab: 'templates', label: 'SMS templates', hint: 'What a rep can insert into a text thread, with merge fields filled in when the text is sent.' },
    { tab: 'calling', label: 'Calling', hint: 'Hold music, AI calling, and the dialing windows in each lead’s local time.' },
  ] },
  { main: 'sequences', label: 'Sequences', items: [
    { tab: 'plans', label: 'Action plans', hint: 'Follow-up sequences sellers and buyers can be enrolled in — texts, calls, emails and waits with a builder and AI draft.' },
    { tab: 'templates', label: 'Templates', hint: 'SMS and email templates for People, Inbox and bulk sends. Build once, insert anywhere, share with the team.' },
  ] },
];

/** A remembered section, if Settings still has it (a stale or hand-edited one opens General instead). */
const onNav = (t: SettingsTarget | null): SettingsTarget | null => {
  const g = t ? NAV.find((x) => x.main === t.main) : undefined;
  return t && g && (!('tab' in t) || !t.tab || g.items.some((i) => i.tab === t.tab)) ? t : null;
};

/**
 * The role Settings acts on: during an admin's View as, the teammate's, so the
 * preview shows what they would see rather than the admin's own sections.
 */
function useShownRole(): Role | null {
  const s = useSession();
  const viewAs = useViewAs();
  const realRole = (s.workspace?.role as Role | undefined) ?? null;
  return viewAs && isAdmin(realRole) && viewAs.userId !== s.user?.id ? viewAs.role : realRole;
}

export function Settings({ isMobile, openPerson, openBuyer, onImported, onViewAs, onToast, talkrAuthed }: {
  isMobile: boolean;
  openPerson?: (id: string) => void;
  openBuyer?: (id: string) => void;
  onImported?: () => void;
  onViewAs?: () => void;
  onToast?: (msg: string) => void;
  talkrAuthed?: boolean;
}) {
  const s = useSession();
  const canWrite = useCanWrite();
  const role = useShownRole();
  const prefs = useSyncExternalStore(subscribePrefs, readPrefs, serverPrefs);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Keyed to the workspace row it was seeded from, so the field fills in when
  // the workspace loads without an effect copying it into state.
  const seed = s.workspace?.id ?? null;
  const [edit, setEdit] = useState<{ key: number | null; name: string } | null>(null);
  const [noteFor, setNoteFor] = useState(seed);
  if (noteFor !== seed) {
    setNoteFor(seed);
    setNote(null);
  }
  const ws = edit && edit.key === seed ? edit.name : s.workspace?.name ?? '';
  const setWs = (v: string) => setEdit({ key: seed, name: v });

  const toggle = useCallback((k: keyof Prefs) => {
    writePrefs({ ...readPrefs(), [k]: !readPrefs()[k] });
  }, []);

  async function saveWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const r = await s.updateWorkspace(ws);
    setBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Workspace saved.' : r.message ?? 'Could not save.' });
  }

  const owner = role === 'owner';
  const admin = isAdmin(role);

  // Where we are: a group and a section in it. Seeded from a hand-off ("Manage
  // scripts" in a call), else the section last open in this tab, and followed
  // while open.
  const [target, setTarget] = useState<SettingsTarget>(() => takeSettingsTab() ?? onNav(lastSettingsTab()) ?? { main: 'workspace' });
  useEffect(() => onSettingsTab(setTarget), []);
  useEffect(() => rememberSettingsTab(target), [target]);
  const group = NAV.find((g) => g.main === target.main) ?? NAV[0];
  const tab = ('tab' in target && target.tab) || group.items[0].tab;
  const section = group.items.find((i) => i.tab === tab) ?? group.items[0];
  const open = (main: SettingsMain, t?: string) => {
    const g = NAV.find((x) => x.main === main) ?? NAV[0];
    setTarget({ main: g.main, tab: t && g.items.some((i) => i.tab === t) ? t : g.items[0].tab } as SettingsTarget);
  };
  const openTalkr = (t: TalkrSettingsTab) => open('talkr', t);
  const link: React.CSSProperties = { padding: 0, border: 0, background: 'none', color: '#0A8560', fontWeight: 600, fontSize: 'inherit', cursor: 'pointer' };

  let pane: React.ReactNode;
  if (target.main === 'talkr') {
    pane = <TalkrSettings tab={tab as TalkrSettingsTab} onTab={openTalkr} isMobile={isMobile} nav={false} />;
  } else if (target.main === 'outbound') {
    pane = <OutboundOsSettings section={tab as OutboundSettingsTab} isMobile={isMobile} />;
  } else if (target.main === 'sequences') {
    pane = tab === 'templates'
      ? <SettingsTemplates isMobile={isMobile} onToast={onToast} talkrAuthed={!!talkrAuthed} />
      : (
        <div style={{ margin: isMobile ? '-4px -14px 0' : '-8px -20px 0', minHeight: '70vh' }}>
          <PlanBuilder
            isMobile={isMobile}
            notify={onToast}
            onChanged={onImported}
            onOpenPerson={openPerson ? (id) => openPerson('s' + id) : undefined}
          />
        </div>
      );
  } else if (tab === 'team') {
    pane = (
      <Team onChanged={onImported}
        workspaceId={s.workspace?.id ?? null}
        myId={s.user?.id ?? null}
        myRole={role}
        demo={s.demo}
        demoName={displayName(s)}
        demoEmail={s.user?.email ?? 'demo user'}
        isMobile={isMobile}
        onPhones={() => openTalkr('numbers')}
        onViewAs={onViewAs}
      />
    );
  } else if (tab === 'roundrobin') {
    pane = <RoundRobinSettings workspaceId={s.workspace?.id ?? null} admin={admin} demo={s.demo} isMobile={isMobile} />;
  } else if (tab === 'company') {
    pane = <CompanyFacts isMobile={isMobile} />;
  } else if (tab === 'floor') {
    pane = <FloorShowSettings isMobile={isMobile} />;
  } else if (tab === 'agent') {
    pane = (
      <>
      <AutopilotPanel isMobile={isMobile} />
      <VoiceAgentSettings
        isMobile={isMobile}
        onOpenRecord={(kind, id) => (kind === 'buyer' ? openBuyer?.('b' + id) : openPerson?.('s' + id))}
      />
      </>
    );
  } else if (tab === 'integrations') {
    pane = (
      <>
        <ContractSettings workspaceId={s.workspace?.id ?? null} admin={admin} demo={s.demo} isMobile={isMobile} />
        <PodioCard workspaceId={s.workspace?.id ?? null} admin={admin} demo={s.demo} isMobile={isMobile} onOpenSeller={openPerson ? (id) => openPerson('s' + id) : undefined} onImported={onImported} />
        <ZapierWebhooks workspaceId={s.workspace?.id ?? null} admin={admin} demo={s.demo} />
        <InvestorBaseCard workspaceId={s.workspace?.id ?? null} admin={admin} demo={s.demo} />
        <IvueitCard workspaceId={s.workspace?.id ?? null} admin={admin} demo={s.demo} />
        <IngestKeys workspaceId={s.workspace?.id ?? null} demo={s.demo} isMobile={isMobile} />
      </>
    );
  } else if (tab === 'keys') {
    pane = <ServerSecrets isMobile={isMobile} />;
  } else if (tab === 'archive') {
    pane = (
      <ArchiveSettings
        workspaceId={s.workspace?.id ?? null}
        canWrite={!s.demo && canWrite}
        onRestored={onImported}
        onOpen={(kind, id) => (kind === 'buyer' ? openBuyer?.('b' + id) : openPerson?.('s' + id))}
      />
    );
  } else if (tab === 'history') {
    pane = <DataHistory workspaceId={s.workspace?.id ?? null} isMobile={isMobile} />;
  } else {
    pane = (
      <>
        {note ? (
          <div role="status" style={{ ...card, padding: '11px 13px', background: note.ok ? '#dcfce7' : '#fee2e2', borderColor: note.ok ? '#bbf7d0' : '#fecaca', color: note.ok ? '#15803d' : '#b91c1c', fontSize: '12.5px' }}>
            {note.text}
          </div>
        ) : null}

        {/* Two small cards share a row on a desktop rather than each taking a full-width strip. */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: '0 12px', alignItems: 'stretch' }}>
          <form onSubmit={saveWorkspace} style={{ ...card, display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Workspace</h2>
            <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#71717a' }}>
              {owner ? 'You own this workspace.' : 'Only an owner can rename the workspace.'}
            </p>
            <label>
              <span style={label}>Workspace name</span>
              <input value={ws} onChange={(e) => setWs(e.target.value)} disabled={!owner || s.demo} placeholder="Acme Homes" style={{ width: '100%', height: '36px', padding: '0 10px', border: '1px solid #e4e4e7', borderRadius: '9px', fontSize: '13px', outline: 0, background: '#fafafa', color: owner && !s.demo ? '#18181b' : '#a1a1aa' }} />
            </label>
            <div style={{ marginTop: 'auto', paddingTop: '14px' }}>
              <button type="submit" disabled={busy || !owner || s.demo || !canWrite} title={canWrite ? undefined : READ_ONLY_TITLE} className="dc3" style={{ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: busy || !owner || s.demo || !canWrite ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || !owner || s.demo || !canWrite ? 'not-allowed' : 'pointer' }}>
                Save workspace
              </button>
            </div>
          </form>

          <div style={card}>
            <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Display</h2>
            <p style={{ margin: '0 0 6px', fontSize: '12.5px', color: '#71717a' }}>
              Remembered in this browser.
            </p>
            {DISPLAY.map(([k, title, sub]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '11px 0 2px', borderTop: '1px solid #f0f0f1', cursor: 'pointer' }}>
                <input type="checkbox" checked={prefs[k]} onChange={() => toggle(k)} style={{ marginTop: '2px', width: '15px', height: '15px', accentColor: '#0A8560', flex: 'none', cursor: 'pointer' }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#18181b' }}>{title}</span>
                  <span style={{ display: 'block', fontSize: '12px', color: '#71717a', marginTop: '1px' }}>{sub}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div style={card}>
          <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Connections</h2>
          <p style={{ margin: '0 0 6px', fontSize: '12.5px', color: '#71717a' }}>
            What this deployment is wired to right now.
          </p>
          <Connection
            dot={s.demo ? '#a1a1aa' : '#16a34a'}
            name="Supabase"
            detail={s.demo ? 'Not configured — the CRM is running on sample data' : 'Connected · auth and the live database'}
          />
          <Connection dot={COMPR} name="COMPR" detail="Underwriting · ARV, rehab and MAO on the property record" />
          <Connection dot="#0A8560" name="Outbound OS" detail={<>Campaign email, sending domain, Gmail 1:1 and suppressions — <button type="button" onClick={() => open('outbound', 'email')} style={link}>Outbound OS</button></>} />
          <Connection dot={TALKR} mark={<TalkrMark size={14} />} name="Talkr" detail={<>The phone: calls, texts, recordings and the live coach — <button type="button" onClick={() => openTalkr('account')} style={link}>Talkr settings</button></>} />
          <Connection dot="#16a34a" name="Contracts" detail={<>Acme Homes PandaDoc templates · webhook (no API) · TC proofs and sends — <button type="button" onClick={() => open('workspace', 'integrations')} style={link}>Integrations</button></>} />
          <Connection dot="#0A8560" name="Genius Mode" detail="Nearby cash buyers from RealEstateAPI sales records, skip tracing split by owner: individuals on RealEstateAPI, LLCs on BatchData (billed per hit) · find it on Dispo → a property → Genius Mode, or Buyers → Find cash buyers" />
          <Connection dot={DEAL_MACHINE} name="Deal Machine" detail="The scraper extension: InvestorLift, Facebook groups and RealEstateBees, posted in through its ingest key · find it on the Deal Machine button in the top bar, or ⌘K" />
          <Connection dot="#db2777" name="Lane" detail="TC assistant · live on Claude with the TC playbook · open it with the Lane button on Deals, a deal, the TC file, the top bar, ⌘K or the L key" last />
        </div>
      </>
    );
  }

  return (
    <section data-screen-label="Settings" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div data-head style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', background: '#fff', borderBottom: '1px solid #e4e4e7', flex: 'none', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Settings</h1>
        <span style={{ fontSize: '12.5px', color: '#71717a' }}>{group.label} · {section.label}</span>
      </div>

      {isMobile ? (
        <div style={{ background: '#fff', borderBottom: '1px solid #e4e4e7', padding: '8px 12px 10px', display: 'flex', flexDirection: 'column', gap: '8px', flex: 'none' }}>
          <div role="tablist" aria-label="Settings" style={{ ...segWrap, width: '100%', display: 'flex' }}>
            {NAV.map((g) => (
              <button key={g.main} type="button" role="tab" aria-selected={group.main === g.main} onClick={() => open(g.main)} style={{ ...seg(group.main === g.main), flex: 1, justifyContent: 'center', height: 30 }}>
                {g.main === 'talkr' ? <TalkrMark size={13} /> : null}{g.label}
              </button>
            ))}
          </div>
          <div role="tablist" aria-label={group.label + ' sections'} style={{ display: 'flex', gap: '6px', overflowX: 'auto', scrollbarWidth: 'none' }}>
            {group.items.map((it) => {
              const on = it.tab === tab;
              return (
                <button key={it.tab} type="button" role="tab" aria-selected={on} onClick={() => open(group.main, it.tab)} style={{ ...trayBtn(on) }}>
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!isMobile ? (
          <nav aria-label="Settings" style={{ width: '220px', flex: 'none', borderRight: '1px solid #e4e4e7', background: '#fff', overflow: 'auto', padding: '12px 10px' }}>
            {NAV.map((g) => (
              <div key={g.main} style={{ marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', fontWeight: 500, color: '#71717a', padding: '4px 8px 6px' }}>{g.main === 'talkr' ? <TalkrMark size={12} /> : null}{g.label}</div>
                {g.items.map((it) => {
                  const on = g.main === group.main && it.tab === tab;
                  return (
                    <button key={it.tab} type="button" aria-current={on ? 'page' : undefined} onClick={() => open(g.main, it.tab)} className={on ? undefined : 'dc2'} style={{ display: 'flex', alignItems: 'center', width: '100%', height: '32px', padding: '0 10px', borderRadius: '8px', border: 0, background: on ? '#E7F8F1' : 'transparent', color: on ? '#0A8560' : '#27272a', fontSize: '13px', fontWeight: on ? 600 : 500, cursor: 'pointer', textAlign: 'left' }}>
                      {it.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        ) : null}

        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: isMobile ? '12px 14px 28px' : '18px 24px 40px', background: '#fafafa' }}>
          <div style={{ width: '100%' }}>
            <div style={{ marginBottom: '12px' }}>
              <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em' }}>{section.label}</h2>
              <p className="cz-info" style={{ margin: '8px 0 0', maxWidth: '720px' }}>{section.hint}</p>
            </div>
            <ReadOnlyNote />
            {pane}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The team, and adding to it.
 *
 * Adding a teammate creates their account on the spot with a one-time
 * password and emails a CLOZR-branded invite (password + sign-in link). The
 * password is also shown once here as a backup; the database holds only the
 * hash. Roles are enforced by RLS, so the select below is the real control,
 * not a label.
 */
const STATE_CODES = [...new Set(Object.values(STATES))].sort();

function NotaryFields({ state, expires, number, county, field, onState, onExpires, onNumber, onCounty, onSave }: {
  state: string; expires: string; number: string; county: string; field: React.CSSProperties;
  onState: (v: string) => void; onExpires: (v: string) => void; onNumber: (v: string) => void; onCounty: (v: string) => void;
  onSave?: () => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 8 }}>
      <select value={state} onChange={(e) => onState(e.target.value)} aria-label="Commission state" style={field}>
        {STATE_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input value={expires} onChange={(e) => onExpires(e.target.value)} type="date" aria-label="Commission expiration" required style={field} />
      <input value={number} onChange={(e) => onNumber(e.target.value)} placeholder="Commission number" style={field} />
      <input value={county} onChange={(e) => onCounty(e.target.value)} placeholder="County (California)" style={field} />
      {onSave ? <button type="button" onClick={onSave} style={{ ...field, cursor: 'pointer', fontWeight: 650 }}>Save seal</button> : null}
    </div>
  );
}

function Team({ workspaceId, myId, myRole, demo, demoName, demoEmail, isMobile, onChanged, onPhones, onViewAs }: {
  workspaceId: number | null; myId: string | null; myRole: Role | null;
  demo: boolean; demoName: string; demoEmail: string; isMobile: boolean; onChanged?: () => void; onPhones: () => void;
  /** After "View as" starts: go somewhere that teammate can see. */
  onViewAs?: () => void;
}) {
  const { confirm: ask } = useConfirm();
  const [team, setTeam] = useState<{ key: number | null; rows: Teammate[]; n: number }>({ key: null, rows: [], n: 0 });
  const [nonce, setNonce] = useState(0);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRoleField] = useState<Role>('acquisitions');
  const [nState, setNState] = useState('TX');
  const [nExp, setNExp] = useState('');
  const [nNum, setNNum] = useState('');
  const [nCounty, setNCounty] = useState('');
  const [sealFor, setSealFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [minted, setMinted] = useState<{ email: string; password: string } | null>(null);
  const canWrite = useCanWrite();
  const roTitle = canWrite ? undefined : READ_ONLY_TITLE;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void listTeam(workspaceId).then((rows) => {
      if (!live) return;
      setTeam({ key: workspaceId, rows, n: nonce });
      // CLOZR is the roster: an admin opening Team puts anyone missing onto Talkr.
      if (isAdmin(myRole)) void syncTeamToTalkr(rows).catch(() => undefined);
    });
    return () => { live = false; };
  }, [workspaceId, nonce, myRole]);
  const rows = team.key === workspaceId ? team.rows : [];
  const admin = isAdmin(myRole);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setBusy(true); setNote(null); setMinted(null);
    const r = await addTeammate(workspaceId, email.trim(), name.trim(), role, role === 'notary' ? { state: nState, expires: nExp, commissionNumber: nNum, county: nCounty } : undefined);
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setNonce((n) => n + 1);
    if (r.tempPassword) setMinted({ email: r.email, password: r.tempPassword });
    // Same person on Talkr straight away, so lines can be given without a second trip.
    const onTalkr = await ensureOnTalkr(r.email, name.trim(), role).then(() => ' and on Talkr', () => ' (not added to Talkr — use Add to Talkr below)');
    const mailBit = r.emailed ? ' Invite email sent with their temporary password.' : (r.warning ? ` ${r.warning}` : ' Invite email did not send — share the password below.');
    setNote({ ok: true, text: (r.existing ? `${r.email} already had an account — added to this workspace as ${ROLE_LABEL[role]}` : `${r.email} added as ${ROLE_LABEL[role]}`) + onTalkr + '.' + mailBit });
    setName(''); setEmail('');
    onChanged?.();
  }

  async function resend(m: Teammate) {
    if (!workspaceId || !m.email) return;
    setResending(m.user_id); setNote(null); setMinted(null);
    const r = await resendTeammateInvite(workspaceId, m.email, m.full_name);
    setResending(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    if (r.tempPassword) setMinted({ email: r.email, password: r.tempPassword });
    setNote({
      ok: true,
      text: r.emailed
        ? `Invite re-sent to ${r.email} with a new temporary password.`
        : (r.warning ?? `Password reset for ${r.email}, but the email did not send — share the password below.`),
    });
  }

  async function changeRole(userId: string, next: Role) {
    if (!workspaceId) return;
    if (next === 'notary') { setSealFor(userId); return; }
    const r = await setRole(workspaceId, userId, next);
    setNote({ ok: r.ok, text: r.ok ? 'Role updated.' : r.message ?? 'Could not change that role.' });
    if (r.ok) { setSealFor(null); setNonce((n) => n + 1); }
  }

  async function saveSeal(userId: string, who: string) {
    if (!workspaceId) return;
    const r = await setRole(workspaceId, userId, 'notary', { name: who, state: nState, expires: nExp, commissionNumber: nNum, county: nCounty });
    setNote({ ok: r.ok, text: r.ok ? 'Notary seal saved.' : r.message ?? 'Could not draw that seal.' });
    if (r.ok) { setSealFor(null); setNonce((n) => n + 1); }
  }

  async function remove(userId: string, who: string) {
    if (!workspaceId) return;
    if (!(await ask({ title: `Remove ${who} from the workspace?`, body: 'Their account stays; they lose access to this CRM.', confirmLabel: 'Remove from workspace', tone: 'danger' }))) return;
    const r = await removeTeammate(workspaceId, userId);
    setNote({ ok: r.ok, text: r.ok ? `${who} removed.` : r.message ?? 'Could not remove them.' });
    if (r.ok) setNonce((n) => n + 1);
  }

  const field: React.CSSProperties = { height: '34px', padding: '0 11px', border: 0, borderRadius: '10px', fontSize: '13px', outline: 0, background: '#fff', color: '#18181b', minWidth: 0, boxShadow: 'var(--shadow-ring)' };
  const roleTag: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#0A8560', whiteSpace: 'nowrap' };

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Team</h2>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 }}>
        Acquisitions works leads through contract and never sees buyers or dispo — only a buyer&rsquo;s offer when one comes in.
        Dispositions starts at Under Contract. TC has the closing file. The database enforces this, not just the menu.
        {admin && !demo ? <> Lines, caller ID and greetings for each teammate are in <button type="button" onClick={onPhones} style={{ padding: 0, border: 0, background: 'none', color: '#0A8560', fontWeight: 600, fontSize: 'inherit', cursor: 'pointer' }}>Talkr, Numbers</button>.</> : null}
      </p>

      {demo ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1px solid #f0f0f1' }}>
          <span style={{ width: '30px', height: '30px', borderRadius: '9px', background: '#E7F8F1', color: '#0A8560', display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700, flex: 'none' }}>{demoName.slice(0, 2).toUpperCase()}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: '13px', fontWeight: 500 }}>{demoName}</span>
            <span style={{ display: 'block', fontSize: '12px', color: '#71717a' }}>{demoEmail}</span>
          </span>
          <span style={roleTag}>demo</span>
        </div>
      ) : rows.map((m) => {
        const who = m.full_name || m.email || m.user_id.slice(0, 8);
        const self = m.user_id === myId;
        return (
          <React.Fragment key={m.user_id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1px solid #f0f0f1', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
            <UserAvatar name={who} src={m.avatar_url} size={30} radius="9px" />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 500 }}>{who}{self ? ' (you)' : ''}</span>
              <span style={{ display: 'block', fontSize: '12px', color: '#71717a' }}>{m.email ?? '—'}</span>
            </span>
            {admin && !self && !demo ? <ViewAsButton userId={m.user_id} role={m.role} name={who} onStart={onViewAs} /> : null}
            {admin && m.role !== 'owner' && !self ? (
              <>
                <select value={sealFor === m.user_id ? 'notary' : m.role} disabled={!canWrite} title={roTitle} onChange={(e) => void changeRole(m.user_id, e.target.value as Role)} style={{ ...field, height: '30px', fontSize: '12px' }}>
                  {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                {m.email ? (
                  <button type="button" disabled={!canWrite || resending === m.user_id} title={roTitle ?? 'Email a fresh temporary password'} onClick={() => void resend(m)} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12px', color: '#0A8560', cursor: !canWrite || resending === m.user_id ? 'not-allowed' : 'pointer' }}>
                    {resending === m.user_id ? 'Sending…' : 'Resend invite'}
                  </button>
                ) : null}
                <button type="button" disabled={!canWrite} title={roTitle} onClick={() => void remove(m.user_id, who)} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12px', color: '#b91c1c', cursor: 'pointer' }}>Remove</button>
              </>
            ) : <span style={roleTag}>{ROLE_LABEL[m.role] ?? m.role}</span>}
          </div>
          {sealFor === m.user_id ? (
            <NotaryFields state={nState} expires={nExp} number={nNum} county={nCounty} field={field}
              onState={setNState} onExpires={setNExp} onNumber={setNNum} onCounty={setNCounty}
              onSave={() => void saveSeal(m.user_id, who)} />
          ) : null}
          </React.Fragment>
        );
      })}

      {!demo && admin ? (
        <form onSubmit={add} style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #f0f0f1' }}>
          <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 500, marginBottom: '8px' }}>Add a teammate</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.3fr 1fr auto', gap: '8px' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoComplete="off" style={field} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="taylor@yourcompany.com" type="email" required autoComplete="off" style={field} />
            <select value={role} onChange={(e) => setRoleField(e.target.value as Role)} style={field}>
              {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <button type="submit" disabled={busy || !email.trim() || !canWrite || (role === 'notary' && !nExp)} title={roTitle} className="dc3" style={{ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: busy || !canWrite ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || !canWrite ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
          {role === 'notary' ? (
            <NotaryFields state={nState} expires={nExp} number={nNum} county={nCounty} field={field}
              onState={setNState} onExpires={setNExp} onNumber={setNNum} onCounty={setNCounty} />
          ) : null}
          {note ? (
            <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? '#dcfce7' : '#fee2e2', border: `1px solid ${note.ok ? '#bbf7d0' : '#fecaca'}`, color: note.ok ? '#15803d' : '#b91c1c' }}>{note.text}</div>
          ) : null}
          {minted ? (
            <div style={{ marginTop: '10px', padding: '12px', borderRadius: '10px', background: '#fef3c7', border: '1px solid #fde68a' }}>
              <div style={{ fontSize: '12.5px', color: '#92400e', fontWeight: 600 }}>Temporary password for {minted.email} — also in their invite email; shown here once as a backup.</div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
                <code style={{ fontSize: '14px', fontWeight: 700, letterSpacing: '.04em', background: '#fff', padding: '6px 10px', borderRadius: '8px', border: '1px solid #fde68a' }}>{minted.password}</code>
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(minted.password).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} style={{ height: '30px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12px', cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div style={{ fontSize: '12px', color: '#92400e', marginTop: '6px' }}>They sign in at /login and change it under Account.</div>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

/**
 * The vendor keys that live on the server. They are Supabase project secrets
 * (Dashboard → Edge Functions → Secrets), never entered or shown here; this
 * card only says which names the functions read and where PandaDoc posts.
 */
function ServerSecrets({ isMobile }: { isMobile: boolean }) {
  const hook = pandadocWebhookUrl();
  const [copied, setCopied] = useState(false);
  // Two columns need ~420px. On a phone the second one fell to 124px and the
  // explanations stacked eight lines tall, so the phone puts them one above
  // the other.
  const row: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 190px) 1fr',
    gap: isMobile ? '3px' : '10px', padding: '8px 0',
    borderTop: '1px solid #f0f0f1', fontSize: '12.5px',
  };
  const code: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', color: '#18181b', wordBreak: 'break-all' };
  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Server keys (optional)</h2>
      <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.5 }}>
        Project secrets on the Supabase project (Edge Functions → Secrets), read only by the server. Offers and contracts use Acme Homes PandaDoc templates through the webhook — the API key is optional and unused if you only have webhooks.
        The webhook URL below is what PandaDoc posts to so status and signing links land on the record. Resend, Gmail and the blast domain live under Settings → Outbound OS.
      </p>
      <div style={row}><span style={code}>PANDADOC_API_KEY</span><span style={{ color: '#52525b' }}>Optional. Only if PandaDoc later gives you a REST key. Not needed for Casey to send from the PandaDoc UI.</span></div>
      <div style={row}><span style={code}>PANDADOC_WEBHOOK_KEY</span><span style={{ color: '#52525b' }}>The shared key on the PandaDoc webhook. Required. Verifies each delivery before a signed document moves a stage.</span></div>
      <div style={row}><span style={code}>COMPANY_NAME</span><span style={{ color: '#52525b' }}>Optional. Fills the [Company.Name] token on templates (defaults to Acme Homes).</span></div>
      <div style={row}><span style={code}>REAL_ESTATE_API_API_KEY</span><span style={{ color: '#52525b' }}>RealEstateAPI · nearby sales and owners for Genius Mode, and skip tracing individual owners ($0.05 a hit, only on click).</span></div>
      <div style={row}><span style={code}>BATCHDATA_API_KEY</span><span style={{ color: '#52525b' }}>BatchData · skip tracing LLCs and other entity owners in Genius Mode, People and Buyers, and individuals too whenever RealEstateAPI is out of credits (billed per match, only on click).</span></div>
      <div style={row}><span style={code}>ATTOM_API_KEY</span><span style={{ color: '#52525b' }}>ATTOM Property API · optional. Genius Mode&apos;s &ldquo;Compare with ATTOM&rdquo; searches ATTOM&apos;s sales and owners beside RealEstateAPI&apos;s and merges them without duplicates (billed by ATTOM per property returned, only when Compare is on).</span></div>
      <div style={row}><span style={code}>TELNYX_API_KEY</span><span style={{ color: '#52525b' }}>Telnyx API v2 key. Required for Register under Company &amp; 10DLC: CLOZR files the 10DLC brand and campaign, attaches your lines, and runs Number Reputation and branded calling with it. Optional as a secret: the functions fall back to Vault telnyx_api_key, a copy of the key Talkr runs on.</span></div>
      <div style={row}><span style={code}>TELNYX_PUBLIC_KEY</span><span style={{ color: '#52525b' }}>The public key from Telnyx → Account → Keys &amp; credentials. Verifies the 10DLC webhooks, so brand and campaign decisions land within minutes instead of on the next morning check.</span></div>
      <div style={row}><span style={code}>AGENTMAIL_API_KEY</span><span style={{ color: '#52525b' }}>Reads the Free Caller Registry verification email from the AgentMail inbox set under Company &amp; 10DLC.</span></div>
      <div style={row}><span style={code}>FIRECRAWL_API_KEY</span><span style={{ color: '#52525b' }}>Optional. Submits new numbers on the Free Caller Registry form (falls back to the Vault secret firecrawl_api_key).</span></div>
      <div style={row}><span style={code}>DISPOGENIUS_API_KEY</span><span style={{ color: '#52525b' }}>Dispo Genius · importing deals and the buyers working them. Location-scoped, so one key per location.</span></div>
      <div style={{ marginTop: '12px' }}>
        <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 500, marginBottom: '5px' }}>PandaDoc webhook URL</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...code, flex: 1, minWidth: '200px', padding: '8px 10px', border: '1px solid #e4e4e7', borderRadius: '9px', background: '#fafafa' }}>{hook || 'Supabase is not configured'}</span>
          <button type="button" disabled={!hook} onClick={() => { void navigator.clipboard?.writeText(hook).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} style={{ height: '34px', padding: '0 12px', borderRadius: '9px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#71717a', lineHeight: 1.5 }}>
          Subscribe it to Document state changed, Recipient completed, Document updated and Document deleted. On the subscription, tick Tokens and Fields — that is what we can store without an API: document id, name, status, template name, grand total, recipients (email, role, signed?, signing link), and the filled tokens. We cannot list templates, create or send from Clozr, or download the PDF. Signed purchase agreements move the seller to Under Contract - Seller; signed assignments move the deal to Buyer Under Contract; terminations terminate it.
        </p>
      </div>
    </div>
  );
}

function Connection({ dot, mark, name, detail, last }: { dot: string; /** The product's logo, drawn instead of its dot. */ mark?: React.ReactNode; name: string; detail: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 0', borderTop: '1px solid #f0f0f1', borderBottom: last ? 0 : undefined }}>
      {mark ?? <span style={{ width: '14px', display: 'grid', placeItems: 'center', flex: 'none' }}><span style={{ color: dot, display: 'inline-flex' }}><Mark label={name} /></span></span>}
      <span style={{ fontSize: '13px', fontWeight: 600, width: '86px', flex: 'none' }}>{name}</span>
      <span style={{ fontSize: '12.5px', color: '#71717a', minWidth: 0 }}>{detail}</span>
    </div>
  );
}

/**
 * Ingest keys — how the other systems get data in.
 *
 * A minted key is shown once and never again: the database holds a SHA-256 and
 * a prefix, so this is the only moment it can be copied. The panel says so
 * plainly rather than letting someone navigate away and lose it.
 */
function IngestKeys({
  workspaceId,
  demo,
  isMobile,
}: {
  workspaceId: number | null;
  demo: boolean;
  isMobile: boolean;
}) {
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [source, setSource] = useState<string>(INGEST_SOURCES[0].name);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keysFor, setKeysFor] = useState(workspaceId);
  if (keysFor !== workspaceId) {
    setKeysFor(workspaceId);
    setKeys([]);
    setMinted(null);
    setErr(null);
    setCopied(false);
  }

  // A counter rather than calling a shared `refresh()` from the effect: the
  // React lint rule cannot see that the setState is inside a promise, and
  // bumping a nonce keeps the fetch itself in one place.
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void listKeys(workspaceId).then((rows) => {
      if (live) setKeys(rows);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, nonce]);

  async function mint() {
    if (!workspaceId) return;
    setBusy(true);
    setErr(null);
    const spec = INGEST_SOURCES.find((x) => x.name === source);
    const r = await issueKey(workspaceId, source, spec?.label ?? source);
    setBusy(false);
    if (!r.ok) {
      setErr(r.message ?? 'Could not issue a key.');
      return;
    }
    setMinted(r.key ?? null);
    setCopied(false);
    refresh();
  }

  async function toggle(k: IngestKey) {
    setBusy(true);
    await setKeyActive(k.id, !k.active);
    setBusy(false);
    refresh();
  }

  const url = ingestUrl();

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Ingest keys</h2>
      <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#71717a', lineHeight: 1.55 }}>
        One key per system. Each one posts to{' '}
        {url ? <code style={{ fontSize: '11.5px', background: '#f4f4f5', padding: '1px 5px', borderRadius: '4px' }}>{url}</code> : 'the ingest endpoint'}{' '}
        and can only write into this workspace.
      </p>

      {demo ? (
        <div style={{ padding: '11px 12px', borderRadius: '9px', background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e', fontSize: '12.5px' }}>
          Supabase isn&rsquo;t configured for this deployment, so there are no keys to issue.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <select
              id="ingest-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              style={{ height: '34px', padding: '0 9px', border: '1px solid #e4e4e7', borderRadius: '8px', fontSize: '13px', background: '#fafafa', color: '#18181b', outline: 0, fontFamily: 'inherit', flex: isMobile ? '1 1 100%' : '0 1 auto' }}
            >
              {INGEST_SOURCES.map((x) => (
                <option key={x.name} value={x.name}>{x.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="dc3"
              onClick={() => void mint()}
              disabled={busy || !workspaceId}
              style={{ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: busy || !workspaceId ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || !workspaceId ? 'not-allowed' : 'pointer' }}
            >
              Issue key
            </button>
            <span style={{ fontSize: '12px', color: '#a1a1aa' }}>
              {INGEST_SOURCES.find((x) => x.name === source)?.hint}
            </span>
          </div>

          {err ? (
            <div role="status" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '9px', background: '#fee2e2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '12.5px' }}>
              {err}
            </div>
          ) : null}

          {minted ? (
            <div style={{ marginTop: '12px', padding: '13px 14px', borderRadius: '10px', background: '#E7F8F1', border: '1px solid #A8ECD2' }}>
              <div style={{ fontSize: '11px', color: '#0A8560', fontWeight: 600 }}>
                Copy this now — it isn&rsquo;t shown again
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '9px', flexWrap: 'wrap' }}>
                <code style={{ flex: '1 1 240px', minWidth: 0, fontSize: '12px', background: '#fff', border: '1px solid #A8ECD2', borderRadius: '7px', padding: '8px 10px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
                  {minted.key}
                </code>
                <button
                  type="button"
                  className="dc2"
                  onClick={() => {
                    void navigator.clipboard?.writeText(minted.key).then(() => setCopied(true));
                  }}
                  style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid #A8ECD2', background: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: '#0A8560', flex: 'none' }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="dc2"
                  onClick={() => setMinted(null)}
                  style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12.5px', cursor: 'pointer', color: '#52525b', flex: 'none' }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : null}

          {keys.length ? (
            <div style={{ marginTop: '14px' }}>
              {keys.map((k, i) => (
                <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 0', borderTop: i === 0 ? '1px solid #f0f0f1' : '1px solid #f0f0f1' }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: k.active ? '#18181b' : '#a1a1aa' }}>
                      {k.label || k.name}
                    </span>
                    <span style={{ display: 'block', fontSize: '11.5px', color: '#a1a1aa', fontFamily: 'ui-monospace, monospace' }}>
                      {k.key_prefix}… · {k.last_used_at ? `used ${new Date(k.last_used_at).toLocaleDateString()}` : 'never used'}
                    </span>
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: k.active ? '#0A8560' : '#a1a1aa', whiteSpace: 'nowrap' }}>
                    {k.active ? 'Active' : 'Disabled'}
                  </span>
                  <button
                    type="button"
                    className="dc2"
                    onClick={() => void toggle(k)}
                    disabled={busy}
                    style={{ height: '28px', padding: '0 10px', borderRadius: '7px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '11.5px', cursor: busy ? 'not-allowed' : 'pointer', color: '#52525b', flex: 'none' }}
                  >
                    {k.active ? 'Disable' : 'Enable'}
                  </button>
                </div>
              ))}
              {keys.some((k) => k.name === 'talkr') ? (
                <TalkrSecret
                  row={keys.find((k) => k.name === 'talkr')!}
                  onSaved={refresh}
                />
              ) : (
                <p style={{ marginTop: '12px', padding: '11px 13px', borderRadius: '10px', background: '#fafafa', border: '1px solid #e4e4e7', fontSize: '12px', color: '#71717a', lineHeight: 1.55 }}>
                  Texting is not connected. Issue a <strong style={{ color: '#18181b', fontWeight: 600 }}>Talkr</strong> key above:
                  CLOZR keeps the sending connection with it, and sends texts through Talkr&rsquo;s numbers.
                </p>
              )}
            </div>
          ) : (
            <p style={{ marginTop: '14px', fontSize: '12.5px', color: '#a1a1aa' }}>
              No keys yet. Issue one to connect a system.
            </p>
          )}
        </>
      )}
    </div>
  );
}


/**
 * Talkr signs every webhook delivery, so verifying one needs the secret Talkr
 * issued when the subscription was created. It is write-only from here: the
 * value is never read back, only whether one is stored.
 */
function TalkrSecret({ row, onSaved }: { row: IngestKey; onSaved: () => void }) {
  const canWrite = useCanWrite();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const url = talkrWebhookUrl();

  async function save() {
    setBusy(true);
    const r = await setSigningSecret(row.id, secret.trim());
    setBusy(false);
    setNote(r.ok ? 'Signing secret saved.' : r.message ?? 'Could not save.');
    if (r.ok) {
      setSecret('');
      onSaved();
    }
  }

  return (
    <div style={{ marginTop: '12px', padding: '13px 14px', borderRadius: '10px', background: '#fafafa', border: '1px solid #e4e4e7' }}>
      <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '4px' }}>
        Talkr webhook
      </div>
      <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#71717a', lineHeight: 1.55 }}>
        In Talkr, create a webhook subscription pointing at{' '}
        {url ? <code style={{ fontSize: '11px', background: '#fff', border: '1px solid #e4e4e7', padding: '1px 5px', borderRadius: '4px' }}>{url}</code> : 'the CLOZR webhook URL'}{' '}
        and paste the signing secret it gives you here. Talkr needs no other changes.
      </p>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          id="talkr-secret"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={row.has_signing_secret ? 'A secret is stored — paste a new one to replace it' : 'whsec_…'}
          style={{ flex: '1 1 220px', minWidth: 0, height: '32px', padding: '0 10px', border: '1px solid #e4e4e7', borderRadius: '8px', fontSize: '12.5px', background: '#fff', color: '#18181b', outline: 0 }}
        />
        <button
          type="button"
          className="dc2"
          onClick={() => void save()}
          disabled={busy || secret.trim().length < 8 || !canWrite}
          title={canWrite ? undefined : READ_ONLY_TITLE}
          style={{ height: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: busy || secret.trim().length < 8 || !canWrite ? 'not-allowed' : 'pointer', color: secret.trim().length < 8 ? '#a1a1aa' : '#18181b', flex: 'none' }}
        >
          Save secret
        </button>
        <span style={{ fontSize: '11px', fontWeight: 600, color: row.has_signing_secret ? '#0A8560' : '#a1a1aa', whiteSpace: 'nowrap' }}>
          {row.has_signing_secret ? 'Verified' : 'Not set'}
        </span>
      </div>
      {note ? <p style={{ margin: '9px 0 0', fontSize: '12px', color: '#52525b' }}>{note}</p> : null}
    </div>
  );
}

/** Settings → Sequences → Templates: the CLOZR SMS/email builder, embedded in the pane. */
function SettingsTemplates({ isMobile, onToast, talkrAuthed }: { isMobile: boolean; onToast?: (msg: string) => void; talkrAuthed: boolean }) {
  const s = useSession();
  const role = useShownRole();
  const workspaceId = s.workspace?.id ?? null;
  const templates = useTemplates(workspaceId);
  const toast = onToast ?? (() => undefined);
  if (!workspaceId) {
    return (
      <div style={{ ...card, textAlign: 'center', padding: '28px 18px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600 }}>Sign in to manage templates</div>
        <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: '#71717a' }}>SMS and email templates run on a workspace.</p>
      </div>
    );
  }
  return (
    <div style={{ margin: isMobile ? '-4px -14px 0' : '-8px -20px 0', minHeight: '70vh' }}>
      <TemplatesManager
        embedded
        data={templates}
        userId={s.user?.id ?? null}
        isAdmin={isAdmin(role)}
        talkrAuthed={talkrAuthed}
        ctx={{
          workspaceId,
          toast,
          testTo: s.user?.email ?? null,
          rep: Object.fromEntries(Object.entries({
            rep_name: s.profile?.full_name || displayName(s),
            rep_phone: s.profile?.phone ?? '',
            rep_email: s.user?.email ?? '',
            company: s.workspace?.name ?? '',
          }).filter(([, v]) => v)),
        }}
        onClose={() => undefined}
      />
    </div>
  );
}
