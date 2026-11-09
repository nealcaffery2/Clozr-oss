'use client';

// The campaign builder, SmarterContact's review page shape: Details, Message,
// Phone numbers, Schedule, Actions for replies down the left; the summary card
// on the right. Nothing sends until Schedule is pressed: that saves the
// draft, resolves the audience, fills the recipient list with the exclusions
// counted (sms_campaign_fill) and sets the campaign active for the tick.

import React, { useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Pause, Play, Plus, Repeat, X } from 'lucide-react';
import { BackLink } from '@/components/ds/BackLink';
import { useConfirm } from '@/components/ds/Confirm';
import { DISPOSITIONS } from '@/lib/inbox-folders';
import { type MessageTemplate, saveTemplate } from '@/lib/message-templates';
import type { PeoplePageSpec } from '@/lib/people-page';
import {
  DEFAULT_DAILY_CAP, EXCLUSION_LABEL, STATUS_LABEL, WEEKDAYS, audienceCount, audienceLabel, badFields, estimateSpan, fillCampaign, pauseCampaign, patchCampaign, resolveAudience, resumeCampaign, saveCampaign, segments,
  type Draft, type FillCounts, type SmsCampaign,
} from '@/lib/sms-campaigns';
import { useTemplates } from '@/app/components/templates/useTemplates';
import { slopFindings, slopReport } from '../../../supabase/functions/_shared/no-ai-slop';

export type Line = { id: string; phone_e164: string; label: string | null };
const DEMO_LINES: Line[] = [{ id: 'demo-1', phone_e164: '+18175550141', label: 'Fort Worth 1' }, { id: 'demo-2', phone_e164: '+18175550142', label: 'Fort Worth 2' }, { id: 'demo-3', phone_e164: '+12145550177', label: 'Dallas' }];
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'];
const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hour = (h: number) => (h === 24 ? '12:00 AM' : `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`);
const fmtPhone = (p: string) => p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' }) : '–');
const n = (x: number) => x.toLocaleString('en-US');
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export function CampaignEditor({ campaign, draft: initial, workspaceId, isMobile, live, lines, lists, dailyCap = DEFAULT_DAILY_CAP, specForList, toast, onBack, onSaved, onFollowUp }: {
  campaign: SmsCampaign | null;
  draft: Draft;
  workspaceId: number | null;
  isMobile: boolean;
  live: boolean;
  lines: Line[] | null;
  /** Saved smart lists the audience may be swapped to. */
  lists: { label: string; count: number | null }[];
  dailyCap?: number;
  specForList: (list: string) => PeoplePageSpec | null;
  toast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
  onBack: () => void;
  onSaved: (c: SmsCampaign) => void;
  onFollowUp: (c: SmsCampaign) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [row, setRow] = useState<SmsCampaign | null>(campaign);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [counts, setCounts] = useState<FillCounts | null>(campaign?.excluded && Object.keys(campaign.excluded).length ? { ...campaign.excluded, added: campaign.total_count } : null);
  const [adding, setAdding] = useState(false);
  const [newTpl, setNewTpl] = useState({ name: '', body: '' });
  const { templates, reload: reloadTemplates } = useTemplates(workspaceId);
  const { confirm } = useConfirm();
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const buyers = d.contact_kind === 'buyer';
  const status = row?.status ?? 'draft';
  const locked = status === 'completed';
  const running = status === 'active' || status === 'scheduled';
  const avail = lines ?? (live ? [] : DEMO_LINES);
  const smsTemplates = useMemo(() => templates.filter((t) => t.channel === 'sms' && !t.archived_at), [templates]);
  const picked = d.template_ids.map((id) => smsTemplates.find((t) => t.id === id)).filter((t): t is MessageTemplate => !!t);
  const total = row?.total_count || audienceCount(d.audience);

  // What stops Schedule, in the order the page shows it.
  const problems = useMemo(() => {
    const p: string[] = [];
    if (!d.name.trim()) p.push('Give the campaign a name.');
    if (d.audience.kind === 'none' || !total) p.push('Pick who gets the text.');
    if (!picked.length) p.push('Pick at least one message template.');
    for (const t of picked) {
      const bad = badFields(t.body_text);
      if (bad.length) p.push(`${t.name}: no campaign value for ${bad.map((b) => `{{${b}}}`).join(', ')}.`);
      const slop = slopFindings(t.body_text);
      if (slop.length) p.push(`${t.name}: reword it. ${slopReport(slop)}`);
    }
    if (!d.from_numbers.length) p.push('Pick at least one line to send from.');
    if (d.window_end <= d.window_start) p.push('The delivery window ends before it starts.');
    if (!d.window_days.length) p.push('Pick at least one weekday.');
    return p;
  }, [d, picked, total]);

  const perDay = d.from_numbers.length * dailyCap;
  const endEstimate = useMemo(() => {
    if (!total) return '–';
    const days = perDay ? Math.ceil(total / perDay) : 0;
    const span = estimateSpan(total, d);
    return days > 1 ? `${span}, at most ${n(perDay)} a day` : span;
  }, [total, perDay, d]);


  const save = async (): Promise<SmsCampaign | null> => {
    if (!live) { toast('Sign in to a workspace to save campaigns.', 'error'); return null; }
    setBusy('Saving…'); setErr(null);
    try {
      const saved = await saveCampaign(workspaceId, d, row?.id);
      setRow(saved); onSaved(saved);
      return saved;
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); return null; } finally { setBusy(null); }
  };

  const checkList = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy('Checking the list…');
    try {
      const ids = await resolveAudience(workspaceId, d.audience, specForList);
      const c = await fillCampaign(saved.id, ids, true, d.contact_kind);
      setCounts(c);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the list'); } finally { setBusy(null); }
  };

  const schedule = async () => {
    if (problems.length) { setErr(problems[0]); return; }
    const saved = await save();
    if (!saved) return;
    setBusy('Building the list…');
    try {
      const ids = await resolveAudience(workspaceId, d.audience, specForList);
      const c = await fillCampaign(saved.id, ids, false, d.contact_kind);
      setCounts(c);
      const added = c.added ?? 0;
      if (!added) { setErr('Nobody is left to text after the exclusions.'); return; }
      const left = Object.entries(c).filter(([k, v]) => k !== 'added' && v).map(([k, v]) => `${n(v!)} ${EXCLUSION_LABEL[k as keyof typeof EXCLUSION_LABEL]}`).join(', ');
      const starts = d.start_at && Date.parse(d.start_at) > Date.now() ? `starting ${fmt(d.start_at)}` : 'starting now';
      const ok = await confirm({
        title: `Schedule ${n(added)} texts?`,
        body: `${d.send_all_at_once ? 'All at once' : `${n(d.batch_size)} every ${d.batch_every_minutes} minutes`}, ${hour(d.window_start)} to ${hour(d.window_end)} in each person's own time, ${starts}, from ${d.from_numbers.length} ${d.from_numbers.length === 1 ? 'line' : 'lines'} (at most ${n(dailyCap)} a day each).${left ? ` Left out: ${left}.` : ''} Anyone who replies is taken off the rest of the campaign.`,
        confirmLabel: `Schedule ${n(added)} texts`,
      });
      if (!ok) return;
      const future = d.start_at && Date.parse(d.start_at) > Date.now();
      await patchCampaign(saved.id, { status: future ? 'scheduled' : 'active', next_batch_at: future ? d.start_at : new Date().toISOString() });
      const next = { ...saved, status: future ? 'scheduled' as const : 'active' as const, total_count: added };
      setRow(next); onSaved(next);
      toast(future ? `Scheduled for ${fmt(d.start_at)}.` : 'Campaign started. The first batch goes out within a minute.', 'success');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Scheduling failed'); } finally { setBusy(null); }
  };

  const pause = async () => {
    if (!row) return;
    setBusy('Pausing…');
    try { await pauseCampaign(row.id); const next = { ...row, status: 'paused' as const }; setRow(next); onSaved(next); toast('Paused. Texts not yet sent are held.'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Pause failed'); } finally { setBusy(null); }
  };
  const resume = async () => {
    if (!row) return;
    setBusy('Resuming…');
    try { await resumeCampaign(row.id); const next = { ...row, status: 'active' as const }; setRow(next); onSaved(next); toast('Resumed.'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Resume failed'); } finally { setBusy(null); }
  };

  const addTemplate = async () => {
    if (!newTpl.name.trim() || !newTpl.body.trim()) return;
    if (!live || !workspaceId) { toast('Sign in to a workspace to add templates.', 'error'); return; }
    setBusy('Adding…');
    const r = await saveTemplate(workspaceId, { name: newTpl.name.trim(), channel: 'sms', audience: buyers ? 'buyer' : 'seller', category: 'campaign', subject: null, body_text: newTpl.body.trim(), body_html: null, blocks: null, shared: true });
    setBusy(null);
    if (!r.ok) { setErr(r.message); return; }
    await reloadTemplates();
    set({ template_ids: [...d.template_ids, r.data.id] });
    setNewTpl({ name: '', body: '' }); setAdding(false);
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const dis = locked || !!busy;

  return (
    <section className="cp" data-screen-label="Campaign">
      <div className="cp-main">
        <div className="cp-head">
          {isMobile ? <button type="button" className="cp-icon-btn" aria-label="Back to campaigns" onClick={onBack}><ArrowLeft size={16} aria-hidden /></button> : <BackLink to={{ label: 'Campaigns', go: onBack }} />}
          <h1 className="cp-title">{row ? 'Review your campaign' : 'New campaign'}</h1>
          <span className="cp-badge" data-s={status}>{STATUS_LABEL[status]}</span>
          <span className="cp-grow" />
          {row && row.sent_count ? <button type="button" className="cp-btn" onClick={() => onFollowUp(row)}><Repeat size={14} aria-hidden />Create a follow-up</button> : null}
        </div>
        <div className="cp-edit-wrap"><div className="cp-edit">
          <div className="cp-stack">
            {err ? <div className="cp-alert" role="alert">{err}</div> : null}

            <div className="cp-card">
              <div className="cp-card-h">Details</div>
              <div className="cp-card-b">
                <div className="cp-field">
                  <label htmlFor="cp-name">Campaign name</label>
                  <div className="cp-ctl"><input id="cp-name" className="cp-input" value={d.name} disabled={dis} onChange={(e) => set({ name: e.target.value })} /></div>
                </div>
                <div className="cp-field">
                  <span className="cp-label" id="cp-aud-l">Select your contacts</span>
                  <div className="cp-ctl" role="group" aria-labelledby="cp-aud-l">
                    {d.audience.kind !== 'none' ? (
                      <span className="cp-inline"><span className="cp-tag"><Check size={12} aria-hidden />{audienceLabel(d.audience)}</span><span className="cp-sub">{n(total)} {total === 1 ? 'person' : 'people'}</span></span>
                    ) : null}
                    {!running && !locked && !buyers ? (
                      <select className="cp-select" aria-label="Pick a list" value="" disabled={dis} onChange={(e) => {
                        const l = lists.find((x) => x.label === e.target.value);
                        // The built list's count was the old audience's; the new one shows its own until it is checked.
                        if (l) { set({ audience: { kind: 'smart_list', list: l.label, label: l.label, count: l.count ?? 0 } }); setCounts(null); setRow((r) => (r ? { ...r, total_count: 0 } : r)); }
                      }}>
                        <option value="">{d.audience.kind === 'none' ? 'Pick a smart list…' : 'Swap for a smart list…'}</option>
                        {lists.map((l) => <option key={l.label} value={l.label}>{l.label}{l.count != null ? ` (${n(l.count)})` : ''}</option>)}
                      </select>
                    ) : null}
                    <span className="cp-help">{buyers
                      ? 'Pick contacts on the Buyers screen and choose Text campaign. Do-not-call, blacklisted, opted-out and landline numbers are left out when the list is built.'
                      : 'Or pick people on the People screen or in the Inbox and choose Push to campaign. Do-not-call, blacklisted, opted-out, wrong-number and landline numbers are left out when the list is built.'}</span>
                  </div>
                </div>
                {buyers ? (
                  <div className="cp-field">
                    <span className="cp-label" id="cp-opt-l">Consent</span>
                    <div className="cp-ctl" role="group" aria-labelledby="cp-opt-l">
                      <label className="cp-toggle"><input type="checkbox" checked={d.opted_in_only} disabled={dis || running} onChange={(e) => { set({ opted_in_only: e.target.checked }); setCounts(null); }} />Only contacts who opted in to texts</label>
                      <span className="cp-help">Texting people who never opted in risks carrier blocks on every line and TCPA claims. Check the list to see how many each choice leaves out.</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="cp-card">
              <div className="cp-card-h">Message</div>
              <div className="cp-card-b">
                <div className="cp-field">
                  <span className="cp-label">Campaign type</span>
                  <div className="cp-ctl" id="cp-type" style={{ font: '500 13px/1.4 var(--font-sans, system-ui)', color: 'var(--ink, #18181b)' }}>Text</div>
                </div>
                <div className="cp-field">
                  <span className="cp-label" id="cp-tpl-l">Select your message</span>
                  <div className="cp-ctl" role="group" aria-labelledby="cp-tpl-l">
                    <span className="cp-inline">
                      <select className="cp-select" aria-label="Add a message template" value="" disabled={dis} onChange={(e) => { const id = Number(e.target.value); if (id && !d.template_ids.includes(id)) set({ template_ids: [...d.template_ids, id] }); }} style={{ maxWidth: 260 }}>
                        <option value="">Message templates…</option>
                        {smsTemplates.filter((t) => !d.template_ids.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <button type="button" className="cp-btn" disabled={dis} onClick={() => setAdding((v) => !v)}><Plus size={14} aria-hidden />Add new</button>
                    </span>
                    {adding ? (
                      <div className="cp-tpl">
                        <label className="cp-help" htmlFor="cp-tpl-name">Template name</label>
                        <input id="cp-tpl-name" className="cp-input" value={newTpl.name} onChange={(e) => setNewTpl((p) => ({ ...p, name: e.target.value }))} />
                        <label className="cp-help" htmlFor="cp-tpl-body">Text</label>
                        <textarea id="cp-tpl-body" className="cp-textarea" value={newTpl.body} onChange={(e) => setNewTpl((p) => ({ ...p, body: e.target.value }))} placeholder={buyers ? 'Hi {{first_name}}, this is {{rep_first_name}} with {{company}}.' : 'Hi {{first_name}}, do you still own {{address}}?'} />
                        <TemplateCheck body={newTpl.body} />
                        <span className="cp-inline"><button type="button" className="cp-btn" data-kind="primary" disabled={!!busy || !newTpl.name.trim() || !newTpl.body.trim()} onClick={() => void addTemplate()}>Add template</button><button type="button" className="cp-btn" data-kind="ghost" onClick={() => setAdding(false)}>Cancel</button></span>
                      </div>
                    ) : null}
                    {picked.length ? picked.map((t, i) => (
                      <div key={t.id} className="cp-tpl">
                        <div className="cp-tpl-h">
                          <span>{t.name}</span>
                          <span className="cp-sub">{picked.length > 1 ? `variant ${i + 1} of ${picked.length} · ` : ''}{segments(t.body_text).chars} chars · {segments(t.body_text).segments} {segments(t.body_text).segments === 1 ? 'segment' : 'segments'}</span>
                          {!dis ? <button type="button" className="cp-icon-btn" aria-label={`Remove ${t.name}`} onClick={() => set({ template_ids: d.template_ids.filter((x) => x !== t.id) })}><X size={14} aria-hidden /></button> : null}
                        </div>
                        <TemplateBody body={t.body_text} />
                        <TemplateCheck body={t.body_text} />
                      </div>
                    )) : <span className="cp-help">Pick one or more templates. With several, each person gets the next one in turn, so the carriers see varied wording.</span>}
                  </div>
                </div>
              </div>
            </div>

            <div className="cp-card">
              <div className="cp-card-h">Phone numbers <span className="cp-sub">rotate across the ones you pick</span></div>
              <div className="cp-card-b">
                <div className="cp-field">
                  <span className="cp-label" id="cp-lines-l">Send from</span>
                  <div className="cp-ctl" role="group" aria-labelledby="cp-lines-l">
                    {lines === null && live ? <span className="cp-help">Reading your lines from Talkr…</span> : !avail.length ? <span className="cp-err">No Talkr line on this sign-in. Buy or assign one under Settings, Talkr, Numbers.</span> : (
                      <div className="cp-chips">
                        {avail.map((l) => (
                          <button key={l.id} type="button" role="checkbox" aria-checked={d.from_numbers.includes(l.id)} className="cp-chip" disabled={dis} onClick={() => set({ from_numbers: toggle(d.from_numbers, l.id) })}>
                            {d.from_numbers.includes(l.id) ? <Check size={12} aria-hidden /> : null}{l.label ? `${l.label} · ` : ''}{fmtPhone(l.phone_e164)}
                          </button>
                        ))}
                      </div>
                    )}
                    <span className="cp-help">Each line sends at most {n(dailyCap)} a day (Settings, sms_campaign_daily_cap). {d.from_numbers.length ? `${d.from_numbers.length} ${d.from_numbers.length === 1 ? 'line' : 'lines'}: up to ${n(perDay)} a day.` : ''}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="cp-card">
              <div className="cp-card-h">Schedule</div>
              <div className="cp-card-b">
                <div className="cp-field">
                  <label htmlFor="cp-start">Date and time</label>
                  <div className="cp-ctl">
                    <span className="cp-inline">
                      <input id="cp-start" type="datetime-local" className="cp-input" disabled={dis} value={toLocalInput(d.start_at)} onChange={(e) => set({ start_at: e.target.value ? new Date(e.target.value).toISOString() : null })} style={{ maxWidth: 220 }} />
                      <span className="cp-help">{d.start_at ? '' : 'Empty: starts when you press Schedule.'}</span>
                    </span>
                  </div>
                </div>
                <div className="cp-field">
                  <span className="cp-label">Pace</span>
                  <div className="cp-ctl">
                    <label className="cp-toggle"><input type="checkbox" checked={d.send_all_at_once} disabled={dis} onChange={(e) => set({ send_all_at_once: e.target.checked })} />Send all at once</label>
                    {!d.send_all_at_once ? (
                      <span className="cp-inline">
                        <input type="number" className="cp-input" data-n min={1} max={5000} aria-label="Contacts per batch" disabled={dis} value={d.batch_size} onChange={(e) => set({ batch_size: Math.max(1, Math.min(5000, Number(e.target.value) || 1)) })} />
                        contacts every
                        <input type="number" className="cp-input" data-n min={1} max={1440} aria-label="Minutes between batches" disabled={dis} value={d.batch_every_minutes} onChange={(e) => set({ batch_every_minutes: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })} />
                        minutes
                      </span>
                    ) : <span className="cp-help">Everything goes into the first window; the daily cap per line still holds.</span>}
                  </div>
                </div>
                <div className="cp-field">
                  <span className="cp-label" id="cp-win-l">Delivery window</span>
                  <div className="cp-ctl" role="group" aria-labelledby="cp-win-l">
                    <span className="cp-inline">
                      <label className="cp-help" htmlFor="cp-from">From</label>
                      <select id="cp-from" className="cp-select" disabled={dis} value={d.window_start} onChange={(e) => set({ window_start: Number(e.target.value) })} style={{ width: 118 }}>{HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{hour(h)}</option>)}</select>
                      <label className="cp-help" htmlFor="cp-to">To</label>
                      <select id="cp-to" className="cp-select" disabled={dis} value={d.window_end} onChange={(e) => set({ window_end: Number(e.target.value) })} style={{ width: 118 }}>{HOURS.slice(1).map((h) => <option key={h} value={h}>{hour(h)}</option>)}</select>
                      <label className="cp-help" htmlFor="cp-tz">If no state on file</label>
                      <select id="cp-tz" className="cp-select" disabled={dis} value={d.tz} onChange={(e) => set({ tz: e.target.value })} style={{ width: 170 }}>{[...new Set([d.tz, ...ZONES])].map((z) => <option key={z} value={z}>{z.replace('America/', '').replace('_', ' ')}</option>)}</select>
                    </span>
                    <div className="cp-chips" role="group" aria-label="Weekdays">
                      {WEEKDAYS.map((w, i) => <button key={w} type="button" role="checkbox" aria-checked={d.window_days.includes(i)} className="cp-chip" data-mini="" disabled={dis} onClick={() => set({ window_days: toggle(d.window_days, i).sort() })}>{w}</button>)}
                    </div>
                    <span className="cp-help">In each person&apos;s own time, from the state on their property. Talkr&apos;s quiet hours still apply on top.</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="cp-card">
              <div className="cp-card-h">Actions for replies</div>
              <div className="cp-card-b">
                <div className="cp-field">
                  <span className="cp-label" id="cp-nr-l">When a contact doesn&apos;t reply</span>
                  <div className="cp-ctl" role="group" aria-labelledby="cp-nr-l">
                    <span className="cp-inline">
                      within
                      <input type="number" className="cp-input" data-n min={0} max={720} aria-label="Hours without a reply" disabled={dis} value={d.reply_action.hours ?? ''} placeholder="48" onChange={(e) => set({ reply_action: { ...d.reply_action, hours: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0) } })} />
                      hours, then
                    </span>
                    <span className="cp-inline">
                      <label className="cp-help" htmlFor="cp-label">add label</label>
                      <select id="cp-label" className="cp-select" disabled={dis} value={d.reply_action.label ?? ''} onChange={(e) => set({ reply_action: { ...d.reply_action, label: e.target.value || undefined } })} style={{ width: 160 }}>
                        <option value="">None</option>{DISPOSITIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                      <label className="cp-help" htmlFor="cp-tag">and add to list (tag)</label>
                      <input id="cp-tag" className="cp-input" disabled={dis} value={d.reply_action.tag ?? ''} placeholder="No reply Oct" onChange={(e) => set({ reply_action: { ...d.reply_action, tag: e.target.value || undefined } })} style={{ width: 180 }} />
                    </span>
                    <span className="cp-help">Anyone who replies is taken off the rest of the campaign automatically and keeps their thread in the Inbox.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="cp-card cp-sum" aria-label="Campaign summary">
            <div className="cp-card-b">
              <dl>
                <dt>List</dt><dd>{audienceLabel(d.audience)}</dd>
                <dt>Contacts</dt><dd>{n(total)}</dd>
                {counts ? Object.entries(counts).filter(([k, v]) => k !== 'added' && v).map(([k, v]) => <React.Fragment key={k}><dt>Left out: {EXCLUSION_LABEL[k as keyof typeof EXCLUSION_LABEL]}</dt><dd>{n(v!)}</dd></React.Fragment>) : null}
                {counts?.added != null ? <><dt>Will text</dt><dd>{n(counts.added)}</dd></> : null}
                <dt>Start</dt><dd>{d.start_at ? fmt(d.start_at) : running ? fmt(row?.created_at) : 'When scheduled'}</dd>
                <dt>End estimate</dt><dd>{endEstimate}</dd>
                <dt>Next scheduled</dt><dd>{running ? fmt(row?.next_batch_at) : '–'}</dd>
                <dt>Messages sent</dt><dd>{n(row?.sent_count ?? 0)}/{n(row?.total_count ?? total)}</dd>
                {row?.responded_count ? <><dt>Replied</dt><dd>{n(row.responded_count)}</dd></> : null}
                {row?.failed_count ? <><dt>Failed</dt><dd>{n(row.failed_count)}</dd></> : null}
                <dt>Status</dt><dd><span className="cp-badge" data-s={status}>{STATUS_LABEL[status]}</span></dd>
              </dl>
              {row && row.total_count ? <div className="cp-bar" style={{ marginTop: 10 }} role="progressbar" aria-valuenow={row.sent_count} aria-valuemax={row.total_count} aria-label="Messages sent"><i style={{ width: `${Math.min(100, (row.sent_count / row.total_count) * 100)}%` }} /></div> : null}
            </div>
            <div className="cp-sum-acts">
              {busy ? <span className="cp-help" role="status">{busy}</span> : null}
              {!running && !locked ? <>
                <button type="button" className="cp-btn" data-kind="primary" disabled={!!busy || !!problems.length} title={problems[0]} onClick={() => void schedule()}>Schedule</button>
                <button type="button" className="cp-btn" disabled={!!busy} onClick={() => void save()}>Save as draft</button>
                <button type="button" className="cp-btn" data-kind="ghost" disabled={!!busy || d.audience.kind === 'none'} onClick={() => void checkList()}>Check the list</button>
              </> : null}
              {status === 'active' || status === 'scheduled' ? <button type="button" className="cp-btn" disabled={!!busy} onClick={() => void pause()}><Pause size={14} aria-hidden />Pause</button> : null}
              {status === 'paused' ? <>
                <button type="button" className="cp-btn" data-kind="primary" disabled={!!busy} onClick={() => void resume()}><Play size={14} aria-hidden />Resume</button>
                <button type="button" className="cp-btn" disabled={!!busy} onClick={() => void save()}>Save changes</button>
              </> : null}
              {problems.length && !running && !locked ? <ul className="cp-help" style={{ margin: 0, paddingLeft: 16 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
            </div>
          </aside>
        </div></div>
      </div>
    </section>
  );
}

/** The body with unknown merge fields marked. */
function TemplateBody({ body }: { body: string }) {
  const bad = new Set(badFields(body));
  const parts = body.split(/(\{\{?\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}?\})/g);
  return (
    <div className="cp-tpl-body">
      {parts.map((p, i) => {
        const m = /^\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}$/.exec(p);
        return m && bad.has(m[1]) ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </div>
  );
}

function TemplateCheck({ body }: { body: string }) {
  const bad = badFields(body);
  const slop = slopFindings(body);
  if (!bad.length && !slop.length) return null;
  return (
    <div className="cp-err" role="alert">
      <AlertCircle size={12} aria-hidden style={{ verticalAlign: '-2px', marginRight: 4 }} />
      {bad.length ? `Unknown merge field${bad.length === 1 ? '' : 's'}: ${bad.map((b) => `{{${b}}}`).join(', ')}. A campaign fills first_name, name, address, city, state, zip, company, rep_name and rep_phone. ` : ''}
      {slop.length ? `Reword it: ${slopReport(slop)}` : ''}
    </div>
  );
}
