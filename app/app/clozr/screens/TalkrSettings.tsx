// Settings → Talkr: the phone's settings in one place, section for section
// with talkr.example.com's Settings (apps/web/app/(app)/settings/page.tsx) and
// Scripts page, plus the CLOZR-only phone admin that used to be scattered down
// the Settings page (numbers and routing, caller reputation, per-teammate lines,
// the Talkr API origin).
//
//   Account     connection · caller ID · working zone · Talkr API origin (admin)
//   Numbers     people and their numbers, call and SMS flows, company lines, pools
//   Audio       mic and speaker · ringtones · voicemail drop · your voicemail greeting · notification sounds
//   Scripts     scripts and rebuttals (manager+ edits, reps read)
//   Templates   SMS templates (manager+ edits)
//   Calling     hold music (owner/admin) · dialing windows
//
// Every read and write is a Talkr call through lib/talkr-web/api.ts or
// lib/talkr.ts, authorised with the CLOZR sign-in; the audio tab is per user in
// this browser (lib/phone-audio.ts). Roles are Talkr's, from /v1/me.
'use client';

import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type AiAgentDto, type HoldMusicDto, type MeDto, type MessageTemplateDto } from '@/lib/talkr-web/api';
import { SAFE_WINDOW, callWindow, localZone, tzTime } from '@/lib/talkr-web/time';
import { displayName, useSession } from '@/lib/session';
import { everyWhileVisible } from '@/lib/visible-timer';
import { type Role, isAdmin } from '@/lib/team';
import { type WorkspaceSettings, loadSettings, saveSettings } from '@/lib/integrations';
import { useSoftphone } from '@/app/components/talkr/softphoneAdapter';
import { Icon, type IconName } from '@/app/components/talkr/Icon';
import { Mark } from '@/components/ds/mark';
import { Button, Card, Eyebrow, FIELD, Notice, StatusMarker } from '@/app/components/talkr/ui';
import { TemplateManager, canManageTemplates } from '@/app/components/talkr/MessageTemplates';
import { ScriptsManager } from '@/app/components/talkr/ScriptsManager';
import { AudioSettings } from '@/app/components/talkr/AudioSettings';
import { NumbersPage } from '@/app/components/phone/NumbersPage';
import { TalkrPhone } from './TalkrPhone';
import type { TalkrSettingsTab } from './settingsTab';
import '@/app/clozr/talkr-dialer.css';

const TABS: Array<{ id: TalkrSettingsTab; label: string; icon: IconName }> = [
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'numbers', label: 'Numbers', icon: 'phone' },
  { id: 'audio', label: 'Audio & sounds', icon: 'speaker' },
  { id: 'scripts', label: 'Scripts', icon: 'mic' },
  { id: 'templates', label: 'SMS templates', icon: 'template' },
  { id: 'calling', label: 'Calling', icon: 'clock' },
];

const HELP: React.CSSProperties = { font: '400 11px/1.45 var(--sans)', color: 'var(--muted-2)' };
const BODY: React.CSSProperties = { font: '400 12.5px/1.5 var(--sans)', color: 'var(--muted)' };

/** The clock, read after mount (the prerender has no "now") and every 30 seconds. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const stop = everyWhileVisible(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      stop();
    };
  }, []);
  return now;
}

function Head({ icon, title, right }: { icon: IconName; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon name={icon} size={16} style={{ color: 'var(--accent)' }} />
      <span className="mr-auto" style={{ font: '700 13.5px/1 var(--sans)' }}>{title}</span>
      {right}
    </div>
  );
}

export function TalkrSettings({ tab, onTab, isMobile, nav = true }: { tab: TalkrSettingsTab; onTab: (t: TalkrSettingsTab) => void; isMobile: boolean; /** False when Settings' own nav already picks the tab. */ nav?: boolean }) {
  const s = useSession();
  const { authed } = useSoftphone();
  const [me, setMe] = useState<MeDto | null>(null);
  const [talkrUrl, setTalkrUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!authed) return;
    let live = true;
    api.getMe().then((m) => live && setMe(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [authed, talkrUrl]);

  const role = me?.role ?? null;
  const talkrAdmin = role === 'owner' || role === 'admin';
  const clozrAdmin = isAdmin((s.workspace?.role as Role | undefined) ?? null);
  const offline = s.demo || !s.user ? 'The demo has no phone. Sign in to a workspace to manage Talkr.' : !authed ? 'Talkr is not connected for this sign-in yet — see Account for why.' : null;

  return (
    <div className="talkr-dialer" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {nav ? <nav role="tablist" aria-label="Talkr settings" style={{ display: 'flex', gap: '4px', overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: '2px' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className="inline-flex shrink-0 items-center gap-1.5"
            style={{ height: 32, padding: '0 11px', borderRadius: 8, border: `1px solid ${tab === t.id ? 'var(--text)' : 'var(--line)'}`, background: tab === t.id ? 'var(--text)' : 'var(--panel)', color: tab === t.id ? '#fff' : 'var(--muted)', font: '600 12.5px/1 var(--sans)', cursor: 'pointer' }}
          >
            <Icon name={t.icon} size={13} />
            {t.label}
          </button>
        ))}
      </nav> : null}

      {tab === 'account' && (
        <>
          <TalkrPhone demo={s.demo} isMobile={isMobile} talkrUrl={talkrUrl} />
          {offline ? null : <WorkingZone me={me} onChange={setMe} />}
          {clozrAdmin || s.demo ? <TalkrOrigin workspaceId={s.workspace?.id ?? null} admin={clozrAdmin} demo={s.demo} onSaved={(v) => setTalkrUrl(v.talkr_url ?? null)} /> : null}
        </>
      )}

      {tab === 'numbers' && <NumbersPage isMobile={isMobile} />}

      {tab === 'audio' && <AudioSettings who={s.user ? displayName(s) : null} workspaceId={s.workspace?.id ?? null} userId={s.user?.id ?? null} />}

      {tab === 'scripts' && (offline ? <Notice>{offline}</Notice> : <ScriptsManager authed={authed} role={role} repName={me?.display_name ?? null} />)}

      {tab === 'templates' && (offline ? <Notice>{offline}</Notice> : <Templates role={role} />)}

      {tab === 'calling' && (offline ? <Notice>{offline}</Notice> : (
        <>
          {talkrAdmin ? <HoldMusic /> : null}
          {talkrAdmin ? <AiAgentSettings /> : null}
          <DialingWindows />
        </>
      ))}
    </div>
  );
}

// ── Account ──────────────────────────────────────────────────────────────────

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/Lisbon', 'Europe/London', 'Asia/Manila'];

/** Talkr's "Your working zone": what teammates see before transferring you a call. PATCH /v1/me. */
function WorkingZone({ me, onChange }: { me: MeDto | null; onChange: (m: MeDto) => void }) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const now = useNow();

  async function save(patch: { timezone?: string | null; city?: string | null; title?: string | null }) {
    if (!me) return;
    setNote(null);
    try {
      const next = await api.updateMe(patch);
      onChange({ ...me, ...patch, timezone: next.timezone, city: next.city, title: next.title });
      setNote({ ok: true, text: 'Profile saved' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save' });
    }
  }

  return (
    <Card className="flex flex-col gap-3.5">
      <Head icon="globe" title="Your working zone" right={note ? <StatusMarker color={note.ok ? 'var(--green)' : 'var(--red)'} label={note.text} /> : null} />
      <p style={BODY}>
        Teammates see this as your local time before they transfer you a call. Your browser is in <strong>{now === null ? '…' : localZone()}</strong>.
      </p>
      {!me ? (
        <span style={HELP}>Loading…</span>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>Time zone</Eyebrow>
            <select value={me.timezone ?? ''} onChange={(e) => void save({ timezone: e.target.value || null })} className="outline-none" style={FIELD}>
              <option value="">Not set</option>
              {[...new Set(now === null ? ZONES : [localZone(), ...ZONES])].map((z) => (
                <option key={z} value={z}>{z}{now !== null ? ` — ${tzTime(z, now)}` : ''}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>City label</Eyebrow>
            <input defaultValue={me.city ?? ''} onBlur={(e) => e.target.value !== (me.city ?? '') && void save({ city: e.target.value || null })} placeholder="Austin, TX" className="outline-none" style={FIELD} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>Job title</Eyebrow>
            <input defaultValue={me.title ?? ''} onBlur={(e) => e.target.value !== (me.title ?? '') && void save({ title: e.target.value || null })} placeholder="Acquisitions" className="outline-none" style={FIELD} />
          </label>
        </div>
      )}
      <span style={HELP}>Your title is what teammates see on your card; your role is a permission only a Talkr admin changes.</span>
    </Card>
  );
}

/** The Talkr API origin, moved from Settings → Integrations. Only for a self-hosted Talkr. */
function TalkrOrigin({ workspaceId, admin, demo, onSaved }: { workspaceId: number | null; admin: boolean; demo: boolean; onSaved: (v: WorkspaceSettings) => void }) {
  const [loaded, setLoaded] = useState<{ key: number | null; v: WorkspaceSettings } | null>(null);
  const [draft, setDraft] = useState<WorkspaceSettings | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void loadSettings(workspaceId).then((v) => live && setLoaded({ key: workspaceId, v }));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const v: WorkspaceSettings = draft ?? (loaded && loaded.key === workspaceId ? loaded.v : {});
  const locked = !admin || demo;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !draft) return;
    setBusy(true);
    setNote(null);
    const r = await saveSettings(workspaceId, draft);
    setBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Saved' : r.message ?? 'Could not save' });
    if (r.ok) {
      setLoaded({ key: workspaceId, v: draft });
      setDraft(null);
      onSaved(draft);
    }
  }

  return (
    <form onSubmit={save}>
      <Card className="flex flex-col gap-3">
        <Head icon="settings" title="Talkr API" right={note ? <StatusMarker color={note.ok ? 'var(--green)' : 'var(--red)'} label={note.text} /> : null} />
        <p style={BODY}>Talkr needs no key — it trusts this workspace&rsquo;s sign-in. Set an origin only if you run your own Talkr; leave it empty for Talkr&rsquo;s production API.</p>
        <input value={v.talkr_url ?? ''} onChange={(e) => setDraft({ ...v, talkr_url: e.target.value })} disabled={locked} placeholder="https://talkr.example.com" autoComplete="off" aria-label="Talkr API origin" className="outline-none disabled:opacity-60" style={FIELD} />
        {!locked && (
          <div>
            <Button tone="accent" type="submit" disabled={busy || !draft}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        )}
      </Card>
    </form>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

function Templates({ role }: { role: string | null }) {
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const manage = canManageTemplates(role);
  useEffect(() => {
    let live = true;
    api
      .listMessageTemplates({ include_inactive: manage })
      .then((r) => live && setTemplates(r.templates))
      .catch(() => undefined)
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [manage, nonce]);
  const load = useCallback(() => {
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  return (
    <Card className="flex flex-col gap-3.5">
      <Head icon="template" title="SMS templates" right={<span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted-2)' }}>{templates.length} template{templates.length === 1 ? '' : 's'}</span>} />
      <p style={BODY}>
        What a rep can insert into a thread. Merge fields like <code style={{ font: '600 11.5px/1 ui-monospace, monospace' }}>{'{first_name}'}</code> are filled in when the text is sent, and the editor shows exactly what the seller reads.
      </p>
      <TemplateManager templates={templates} loading={loading} canManage={manage} reload={load} />
    </Card>
  );
}

// ── Calling ──────────────────────────────────────────────────────────────────

const HOLD_CHOICES: Array<{ mode: HoldMusicDto['mode']; label: string; help: string }> = [
  { mode: 'default', label: 'Default', help: "The carrier's own hold music." },
  { mode: 'silence', label: 'Silence', help: 'Nothing at all until the seller picks up.' },
  { mode: 'url', label: 'Custom URL', help: 'Your own audio file (MP3 or WAV) or TwiML.' },
];

/** Talkr's Hold music card (owner/admin; /v1/org/settings is admin.users-gated). */
function HoldMusic() {
  const [setting, setSetting] = useState<HoldMusicDto | null>(null);
  const [mode, setMode] = useState<HoldMusicDto['mode']>('default');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api
      .getOrgSettings()
      .then((r) => {
        setSetting(r.hold_music);
        setMode(r.hold_music.mode);
        setUrl(r.hold_music.url ?? '');
      })
      .catch((e) => setNote({ ok: false, text: (e as Error).message }));
  }, []);

  const dirty = setting !== null && (mode !== setting.mode || (mode === 'url' && url !== (setting.url ?? '')));

  async function save() {
    setNote(null);
    setSaving(true);
    try {
      const r = await api.updateOrgSettings({ hold_music: mode === 'url' ? { mode, url: url.trim() } : { mode } });
      setSetting(r.hold_music);
      setMode(r.hold_music.mode);
      setUrl(r.hold_music.url ?? '');
      setNote({ ok: true, text: 'Saved' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save hold music' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3.5">
      <Head icon="speaker" title="Hold music" right={note?.ok ? <StatusMarker color="var(--green)" label="Saved" /> : null} />
      <p style={BODY}>What plays to whoever is alone in the call — you for the moment before the seller answers, and the seller while you have them on hold. Applies to the whole org.</p>
      {setting === null && !note ? (
        <span style={HELP}>Loading…</span>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {HOLD_CHOICES.map((c) => (
              <label key={c.mode} className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="hold-music-mode" checked={mode === c.mode} onChange={() => setMode(c.mode)} className="mt-0.5" style={{ accentColor: 'var(--accent)' }} />
                <span className="flex flex-col gap-0.5">
                  <span style={{ font: '600 12.5px/1 var(--sans)' }}>{c.label}</span>
                  <span style={HELP}>{c.help}</span>
                </span>
              </label>
            ))}
          </div>
          {mode === 'url' && (
            <label className="flex flex-col gap-1.5">
              <Eyebrow>Audio URL</Eyebrow>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hold.mp3" inputMode="url" aria-label="Hold music URL" className="outline-none" style={FIELD} />
              <span style={HELP}>A public https link the carrier can fetch. Local and private addresses are rejected.</span>
            </label>
          )}
          <div>
            <Button tone="accent" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save hold music'}</Button>
          </div>
        </>
      )}
      {note && !note.ok && <p style={{ ...HELP, color: 'var(--red)' }}>{note.text}</p>}
    </Card>
  );
}

/**
 * Telnyx Voice AI Assistant + ElevenLabs voice. Configure the Assistant
 * (ElevenLabs TTS) in Telnyx Mission Control, then paste the assistant id here.
 */
function AiAgentSettings() {
  const [draft, setDraft] = useState<AiAgentDto>({ enabled: false, assistant_id: '' });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [telnyxOk, setTelnyxOk] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.getOrgSettings(), api.getAiCallConfig().catch(() => null)])
      .then(([org, cfg]) => {
        if (!live) return;
        const a = org.ai_agent ?? { enabled: false, assistant_id: '' };
        setDraft({
          enabled: a.enabled,
          assistant_id: a.assistant_id ?? '',
          elevenlabs_voice_id: a.elevenlabs_voice_id ?? '',
          consent_intro: a.consent_intro ?? '',
          takeover_e164: a.takeover_e164 ?? '',
        });
        setTelnyxOk(cfg?.telnyx_configured ?? null);
        setLoaded(true);
      })
      .catch((e) => live && setNote({ ok: false, text: (e as Error).message }));
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      const payload: AiAgentDto = {
        enabled: draft.enabled,
        assistant_id: draft.assistant_id.trim(),
        ...(draft.elevenlabs_voice_id?.trim() ? { elevenlabs_voice_id: draft.elevenlabs_voice_id.trim() } : {}),
        ...(draft.consent_intro?.trim() ? { consent_intro: draft.consent_intro.trim() } : {}),
        ...(draft.takeover_e164?.trim() ? { takeover_e164: draft.takeover_e164.trim() } : {}),
      };
      const r = await api.updateOrgSettings({ ai_agent: payload });
      const a = r.ai_agent ?? payload;
      setDraft({
        enabled: a.enabled,
        assistant_id: a.assistant_id ?? '',
        elevenlabs_voice_id: a.elevenlabs_voice_id ?? '',
        consent_intro: a.consent_intro ?? '',
        takeover_e164: a.takeover_e164 ?? '',
      });
      setNote({ ok: true, text: 'Saved' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3.5">
      <Head icon="phone" title="AI calling (Telnyx + ElevenLabs)" right={note?.ok ? <StatusMarker color="var(--green)" label="Saved" /> : null} />
      <p style={BODY}>
        Outbound AI calls use a Telnyx Voice AI Assistant. Attach an ElevenLabs voice on the assistant in Telnyx Mission Control (integration secret for your ElevenLabs API key), then enable it here. Suppression / DNC and caller ID still apply.
      </p>
      {!loaded ? (
        <span style={HELP}>Loading…</span>
      ) : (
        <>
          {telnyxOk === false && (
            <p style={{ ...HELP, color: 'var(--amber)' }}>Talkr is missing TELNYX_API_KEY or TELNYX_TEXML_APP_ID — AI dials will fail until those are set.</p>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} style={{ accentColor: 'var(--accent)' }} />
            <span style={{ font: '600 12.5px/1 var(--sans)' }}>Enable AI outbound calls</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>Telnyx Assistant id</Eyebrow>
            <input value={draft.assistant_id} onChange={(e) => setDraft({ ...draft, assistant_id: e.target.value })} placeholder="assistant-…" className="outline-none" style={FIELD} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>ElevenLabs voice id (optional, for display)</Eyebrow>
            <input value={draft.elevenlabs_voice_id ?? ''} onChange={(e) => setDraft({ ...draft, elevenlabs_voice_id: e.target.value })} placeholder="21m00Tcm4TlvDq8ikWAM" className="outline-none" style={FIELD} />
            <span style={HELP}>Voice must also be selected on the Telnyx assistant. Cloning happens in ElevenLabs.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>Consent / recording intro</Eyebrow>
            <textarea value={draft.consent_intro ?? ''} onChange={(e) => setDraft({ ...draft, consent_intro: e.target.value })} rows={2} placeholder="This call may be recorded…" className="outline-none" style={{ ...FIELD, resize: 'vertical' }} />
          </label>
          <label className="flex flex-col gap-1.5">
            <Eyebrow>Human takeover number (E.164)</Eyebrow>
            <input value={draft.takeover_e164 ?? ''} onChange={(e) => setDraft({ ...draft, takeover_e164: e.target.value })} placeholder="+12105550100" className="outline-none" style={FIELD} />
            <span style={HELP}>Passed to the assistant as takeover_e164 so it can transfer to a human.</span>
          </label>
          <div>
            <Button tone="accent" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save AI calling'}</Button>
          </div>
        </>
      )}
      {note && !note.ok && <p style={{ ...HELP, color: 'var(--red)' }}>{note.text}</p>}
    </Card>
  );
}

const WINDOW_ZONES: Array<[string, string]> = [['Eastern', 'America/New_York'], ['Central', 'America/Chicago'], ['Mountain', 'America/Denver'], ['Pacific', 'America/Los_Angeles']];

/** Talkr's "Dialing windows": advisory in the UI; SMS quiet hours are enforced by Talkr's server. */
function DialingWindows() {
  const now = useNow();
  return (
    <Card className="flex flex-col gap-2">
      <Head icon="clock" title="Dialing windows" right={<span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted-2)' }}>Lead&apos;s local time</span>} />
      {WINDOW_ZONES.map(([label, tz]) => {
        const w = now === null ? null : callWindow(tz, now);
        return (
          <div key={tz} className="flex items-center gap-2.5 py-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <span style={{ color: w ? w.color : 'var(--muted-2)', display: 'inline-flex' }}><Mark label="clock" /></span>
            <span className="mr-auto flex flex-col gap-1">
              <span style={{ font: '600 12px/1 var(--sans)' }}>{label}</span>
              <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted)' }}>{SAFE_WINDOW.startHour}:00 AM — {SAFE_WINDOW.endHour - 12}:00 PM local</span>
            </span>
            <span style={{ font: '600 12px/1 var(--sans)' }}>{now === null ? '—' : tzTime(tz, now)}</span>
            <span style={{ font: '600 11px/1 var(--sans)', color: w ? w.color : 'var(--muted-2)', width: 74, textAlign: 'right' }}>{w ? (w.safe ? 'Open' : 'Quiet hours') : '—'}</span>
          </div>
        );
      })}
      <p style={HELP}>The window is advisory — it warns the rep, it does not block the dial. SMS quiet hours are enforced by Talkr&rsquo;s server.</p>
    </Card>
  );
}
