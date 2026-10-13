// One agent's console: its header and connection checks, the tab list, the
// active pane, and the bar that saves, previews and publishes. The settings
// draft itself lives in useAgentForms (in the screen root) so switching agents
// keeps each one's unsaved edits; everything here reads it through `form`.
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, ChevronDown, Minus, RefreshCw } from 'lucide-react';
import { READ_ONLY_TITLE } from '@/lib/read-only-context';
import type { Api } from '@/lib/voice-agent-client';
import {
  CHECK_ROWS, agentStatus, enabledNote, hasErrors, roleLabel, serverErrorsToFields, STATUS_LABEL, timeAgo, type AgentDetail, type AgentSummary,
} from '@/lib/voice-agent';
import { agentTitle, dirtyTabs, errorsByTab, pathCandidates, pathTab, fieldId, type TabId } from '@/lib/voice-agent-console';
import { Badge, Banner, CopyButton, GREEN, INK, LINE, MUTED, Skeleton, Switch, card, ghost, h2, linkBtn, mono, sub } from './kit';
import { ConsoleBar, type Note } from './ConsoleBar';
import { PreviewDrawer } from './PreviewDrawer';
import { PublishDialog } from './PublishDialog';
import { SectionNav } from './SectionNav';
import { SECTIONS } from './sections';
import type { TabCtx } from './types';
import type { FormView } from './useAgentForm';

type Load = { at: 'loading' } | { at: 'ready' } | { at: 'error'; error: string };

const STATUS_TONE = { draft: 'grey', live: 'green', unpublished: 'amber' } as const;

export function AgentEditor({ api, workspaceId, summary, form, seeded, admin, canWrite, isMobile, onOpenRecord, onChanged, switching, switchError, onToggle }: {
  api: Api; workspaceId: number | null; summary: AgentSummary; form: FormView; seeded: boolean; admin: boolean; canWrite: boolean; isMobile: boolean;
  /** The on/off request is in flight, the last refusal, and the request itself (screen root owns it, so the card and this header agree). */
  switching: boolean; switchError?: string; onToggle: (enabled: boolean) => void;
  onOpenRecord?: (kind: 'seller' | 'buyer', id: number) => void;
  /** After anything that changes the agent's row (save, publish, rollback), so the list can read it again. */
  onChanged: () => void;
}) {
  const key = summary.agent_key;
  const { reseed } = form;
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<TabId>('identity');
  const [visited, setVisited] = useState<Partial<Record<TabId, boolean>>>({ identity: true });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [checksOpen, setChecksOpen] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Read the agent. A first read seeds the form; a draft the person is already editing is left alone.
  useEffect(() => {
    let live = true;
    void api.getAgent(key).then((r) => {
      if (!live) return;
      if (!r.ok) return setLoad({ at: 'error', error: r.error });
      setDetail(r.data);
      if (!seeded || nonce > 0) reseed(r.data.settings);
      setLoad({ at: 'ready' });
      setNow(Date.now());
    });
    return () => { live = false; };
    // `seeded` is read once per read: flipping it after the seed must not read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, nonce, reseed]);

  // A success note is a receipt, not a state: let it go on its own.
  useEffect(() => {
    if (note?.tone !== 'ok') return;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  const go = useCallback((t: TabId) => { setTab(t); setVisited((v) => ({ ...v, [t]: true })); }, []);

  const jump = useCallback((path: string) => {
    const t = pathTab(path);
    if (t) go(t);
    // The pane may not be mounted yet (tabs render on first visit), so look after the next paint.
    setTimeout(() => {
      for (const c of pathCandidates(path)) {
        const el = document.getElementById(fieldId(c));
        if (!el) continue;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const target = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName) ? el : el.querySelector<HTMLElement>('input, textarea, select, button');
        target?.focus({ preventScroll: true });
        el.style.transition = 'box-shadow .3s';
        el.style.boxShadow = '0 0 0 3px rgba(10,133,96,.35)';
        setTimeout(() => { el.style.boxShadow = ''; }, 1600);
        return;
      }
    }, 90);
  }, [go]);

  const reload = useCallback(() => { setNonce((n) => n + 1); setEpoch((e) => e + 1); onChanged(); }, [onChanged]);

  const canEdit = admin && canWrite && (detail?.can_edit ?? true);
  const published = !!detail && detail.status === 'live' && detail.live_version > 0;

  /** Save the draft; true when the server has it. A refusal puts each error on its field. */
  const save = useCallback(async (): Promise<boolean> => {
    if (saving || form.invalid) return false;
    setSaving(true); setNote(null);
    const r = await api.saveDraft(key, form.draft);
    setSaving(false);
    if (!r.ok) {
      if (r.errors?.length) {
        const fields = serverErrorsToFields(r.errors, form.draft);
        form.setServerErrors(fields);
        const first = Object.keys(fields).find((k) => k !== '_general');
        setNote({ tone: 'error', text: fields._general ? fields._general : `The server refused ${Object.keys(fields).length === 1 ? 'a field' : `${Object.keys(fields).length} fields`}. They are marked.` });
        if (first) jump(first);
      } else setNote({ tone: 'error', text: r.error });
      return false;
    }
    reseed(r.data.settings);
    setDetail((d) => (d ? { ...d, settings: r.data.settings, has_unpublished_changes: r.data.has_unpublished_changes, name: r.data.settings.identity.name || d.name, role: r.data.settings.identity.role || d.role } : d));
    onChanged();
    setNote(r.data.warnings.length ? { tone: 'warn', text: `Draft saved. ${r.data.warnings.join(' ')}` } : { tone: 'ok', text: 'Draft saved. It is not live until you publish.' });
    return true;
  }, [api, form, jump, key, onChanged, reseed, saving]);

  const startPublish = async () => {
    if (form.dirty && !(await save())) return;
    setPublishing(true);
  };

  const verify = async () => {
    setVerifying(true);
    const r = await api.getAgent(key, true);
    setVerifying(false);
    if (r.ok) setDetail((d) => (d ? { ...d, checks: r.data.checks, live_check: r.data.live_check } : d));
  };

  const dirty = useMemo(() => (detail ? dirtyTabs(form.saved, form.draft) : new Set<TabId>()), [detail, form.saved, form.draft]);
  const tabErrors = useMemo(() => errorsByTab(form.errors), [form.errors]);

  if (load.at === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading the agent">
        <div style={card}><div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><Skeleton h={40} w={40} style={{ borderRadius: 999 }} /><div style={{ flex: 1 }}><Skeleton h={14} w="40%" /><Skeleton h={12} w="65%" style={{ marginTop: 8 }} /></div></div></div>
        <div style={card}><Skeleton h={14} w="25%" /><div style={{ display: 'grid', gap: 12, marginTop: 16 }}><Skeleton h={36} /><Skeleton h={36} /><Skeleton h={80} /></div></div>
      </div>
    );
  }
  if (load.at === 'error' || !detail) {
    return (
      <div style={card}>
        <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }}>Try again</button>}>
          Could not load this agent. {load.at === 'error' ? load.error : ''}
        </Banner>
      </div>
    );
  }

  const status = agentStatus(detail);
  const okCount = CHECK_ROWS.filter((c) => detail.checks[c.key]).length;
  const showChecks = checksOpen ?? okCount < CHECK_ROWS.length;
  const roTitle = canEdit ? undefined : admin ? READ_ONLY_TITLE : 'Only owners and admins can change this';
  const ctx: TabCtx = {
    agentKey: key, workspaceId, api, demo: api.demo, admin, canEdit, detail, form, published, epoch, goTo: go, jump, onOpenRecord,
    onRolledBack: reload,
  };
  const unpublished = published && (detail.has_unpublished_changes || form.dirty);

  return (
    <div>
      <section style={card} aria-labelledby="va-agent-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 999, flex: 'none', display: 'grid', placeItems: 'center', background: published ? 'var(--chip-ok)' : 'var(--chip-warn)', boxShadow: `inset 0 0 0 1px ${published ? 'var(--ok-line)' : 'var(--warn-line)'}`, color: published ? 'var(--ok-ink)' : 'var(--warn-ink)' }}><Bot size={20} /></span>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 id="va-agent-head" style={h2}>{agentTitle({ name: form.draft.identity.name || detail.name, agent_key: key })}</h2>
              <Badge tone="indigo">{roleLabel(form.draft.identity.role || detail.role)}</Badge>
              <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
              {api.demo ? <Badge tone="grey">Demo</Badge> : null}
            </div>
            <p style={sub}>
              {published
                ? <>Live v{detail.live_version}{detail.connected_at ? `, published ${timeAgo(detail.connected_at, now)}` : ''}. ElevenLabs agent <span style={mono}>{detail.agent_id ?? 'unknown'}</span>. {summary.enabled ? 'Answering calls.' : 'Switched off.'}</>
                : 'Not published yet. Publishing creates the agent in ElevenLabs and connects its webhooks.'}
            </p>
          </div>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            {canEdit ? <Switch on={summary.enabled} busy={switching} disabled={!published} onChange={onToggle} label={`${agentTitle({ name: form.draft.identity.name || detail.name, agent_key: key })} answers calls`} /> : (
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: published && summary.enabled ? '#10b981' : '#d4d4d8' }} />
            )}
            <span style={{ fontSize: 12.5, fontWeight: 600, color: published && summary.enabled ? GREEN : MUTED }}>{!published ? 'Not live yet' : summary.enabled ? 'Answering' : 'Switched off'}</span>
          </div>
        </div>
        <p style={{ ...sub, marginTop: 10 }}>{enabledNote({ enabled: summary.enabled, live_version: published ? detail.live_version : 0 })}{!canEdit && published ? ' Only owners and admins can change this.' : ''}</p>
        {switchError ? <div style={{ marginTop: 10 }}><Banner tone="error">{switchError}</Banner></div> : null}

        {!admin ? <div style={{ marginTop: 14 }}><Banner tone="info">You can see how this agent is set up, preview its prompt and read its calls. Only owners and admins can change it, hear voices or start a test call.</Banner></div> : null}
        {admin && !canEdit ? <div style={{ marginTop: 14 }}><Banner tone="info">{roTitle}.</Banner></div> : null}

        <div style={{ marginTop: 14, borderTop: '1px solid #f0f0f1' }}>
          <button type="button" className="va-btn" aria-expanded={showChecks} aria-controls="va-checks" onClick={() => setChecksOpen(!showChecks)}
            style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '11px 0 9px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
            <span style={{ flex: 1, fontSize: 11.5, color: MUTED, fontWeight: 600 }}>Connection</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: okCount === CHECK_ROWS.length ? GREEN : '#92400e', fontVariantNumeric: 'tabular-nums' }}>{okCount} of {CHECK_ROWS.length} ready</span>
            <ChevronDown size={15} aria-hidden="true" style={{ color: MUTED, transform: showChecks ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
          </button>
          {showChecks ? (
            <div id="va-checks" className="va-in">
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {CHECK_ROWS.map((c) => {
                  const ok = detail.checks[c.key];
                  return (
                    <li key={c.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderTop: '1px solid #f0f0f1' }}>
                      <span aria-hidden="true" style={{ width: 20, height: 20, marginTop: 1, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 999, background: ok ? GREEN : '#f4f4f5', color: ok ? '#fff' : '#a1a1aa', border: ok ? 0 : `1px solid ${LINE}` }}>
                        {ok ? <Check size={13} strokeWidth={3} /> : <Minus size={13} strokeWidth={3} />}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: INK }}>{c.label}</span>
                        <span style={{ display: 'block', fontSize: 12, color: MUTED, lineHeight: 1.45 }}>{c.hint}</span>
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: ok ? GREEN : '#92400e', flex: 'none', paddingTop: 2 }}>{ok ? 'Ready' : 'Not yet'}</span>
                    </li>
                  );
                })}
              </ul>
              {detail.live_check ? <div style={{ marginTop: 8 }}><Banner tone="warn">{detail.live_check}</Banner></div> : null}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                <button type="button" className="va-btn va-ghost" style={ghost} disabled={verifying || !published} onClick={() => void verify()} title={published ? 'Ask ElevenLabs what the agent looks like right now' : 'Publish first'}>
                  <RefreshCw size={14} aria-hidden="true" className={verifying ? 'va-spin' : undefined} /> {verifying ? 'Checking…' : 'Check with ElevenLabs'}
                </button>
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                {([['Caller lookup', detail.webhook_urls.personalize], ['Lead context tool', detail.webhook_urls.tool], ['Call log', detail.webhook_urls.post_call]] as const).map(([label, url]) => (
                  <div key={label}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: INK, marginBottom: 3 }}>{label} URL</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ ...mono, flex: '1 1 220px', minWidth: 0, padding: '7px 10px', border: `1px solid ${LINE}`, borderRadius: 8, background: '#fafafa' }}>{url || 'Not provided'}</span>
                      {url ? <CopyButton value={url} /> : null}
                    </div>
                  </div>
                ))}
                <p style={{ margin: 0, fontSize: 12, color: MUTED }}>Shared by every agent in the workspace. Publishing sets them up; you only need these to check by hand.</p>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {unpublished ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="warn" action={<button type="button" className="va-btn" style={linkBtn} onClick={() => go('history')}>Review the changes</button>}>
            <strong>Unpublished changes.</strong> {form.dirty ? 'You have edits that are not saved, and the ' : 'The '}draft differs from live v{detail.live_version}. Callers still get v{detail.live_version} until you publish.
          </Banner>
        </div>
      ) : null}

      <div style={{ display: isMobile ? 'block' : 'grid', gridTemplateColumns: '176px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={isMobile ? { marginBottom: 12 } : { position: 'sticky', top: 12 }}>
          <SectionNav sections={SECTIONS} active={tab} onSelect={go} dirty={dirty} errors={tabErrors} vertical={!isMobile} />
        </div>
        <div style={{ minWidth: 0 }}>
          {hasErrors(form.errors) && form.errors._general ? <div style={{ marginBottom: 12 }}><Banner tone="error">{form.errors._general}</Banner></div> : null}
          {SECTIONS.map((x) => (
            <div key={x.id} role="tabpanel" id={`va-pane-${x.id}`} aria-labelledby={`va-tab-${x.id}`} hidden={tab !== x.id}>
              {visited[x.id] ? x.render(ctx) : null}
            </div>
          ))}
        </div>
      </div>

      <ConsoleBar canEdit={canEdit} dirty={form.dirty} invalid={form.invalid} saving={saving} published={published} unpublished={detail.has_unpublished_changes} liveVersion={detail.live_version} note={note}
        onSave={() => void save()} onDiscard={() => { form.discard(); setNote(null); }} onPreview={() => setPreview(true)} onPublish={() => void startPublish()} onDismiss={() => setNote(null)} />

      {preview ? <PreviewDrawer api={api} agentKey={key} settings={form.draft} sendDraft={form.dirty} onClose={() => setPreview(false)} onJump={jump} /> : null}
      {publishing ? (
        <PublishDialog api={api} agentKey={key} liveVersion={published ? detail.live_version : 0} templateId={detail.settings.script.template_id} chosenModel={detail.settings.voice.tts_model}
          onClose={() => setPublishing(false)} onDone={reload} onOpenPreview={() => { setPublishing(false); setPreview(true); }} />
      ) : null}
    </div>
  );
}

