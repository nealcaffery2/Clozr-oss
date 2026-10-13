// The one-screen campaign: who, how, what it says, launch. Everything the
// full builder decides is decided here with a default a dispo rep rarely
// changes, on one card: pick the buyers with chips, switch the channels,
// pick a recipe, read (and tap to edit) the copy, press Launch. From then on
// the server sends every step on schedule (dispo-campaign-tick): the texts and
// emails, the voicemail drop, the AI call, each follow-up only while nobody
// has replied. "Advanced builder" opens the full composer for anything else.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/lib/session';
import { talkr, type MeDto } from '@/lib/talkr';
import type { SendContext } from '@/lib/sms';
import { type AiText, type BuyerRow, buyerRow } from '@/lib/dispo-plan';
import { type CampaignBuyer, type CampaignData, launchCampaign, forgetCampaignData, loadCampaignBuyersByIds, loadCampaignData, writeWithAi } from '@/lib/dispo-campaign';
import { type Channel, type Preset, type QuickCopy, BUILTIN_PRESETS, CHANNELS, CHANNEL_LABEL, buildQuickPlan, defaultCopy, loadPresets, recipeWords } from '@/lib/quick-campaign';
import { METHOD_LABEL, METHOD_TAG, type Method } from '@/supabase/functions/_shared/genius-methods';
import { mintBuyerLinks } from '@/lib/dispo';
import { type ResendStatus, deliverability } from '@/lib/deliverability';
import { useVmLibrary } from '@/app/components/talkr/useVmLibrary';
import { droppable, pinnedGroup } from '@/lib/rvm-pick';
import { Btn, C, Eyebrow, Note, Switch } from './ui';
import { whenLabel } from './logic';

type Props = {
  workspaceId: number; dealId: number; canWrite: boolean; isMobile: boolean;
  dealFields: Record<string, string>; textCtx: { repName: string; company: string };
  /** Buyers handed over from Genius, the Buyers list or the Matches tab: they start ticked. */
  prefill: number[];
  onToast: (m: string) => void; onLaunched: () => void; onAdvanced: () => void; onClose: (() => void) | null;
};

type Who = 'matched' | 'vip' | 'picked' | 'all' | Method;
const METHODS: Method[] = ['homefull', 'wholesale_snipe', 'wholesaler_buyers', 'reverse_llc', 'landlord', 'contract', 'genius'];
const tagToMethod = new Map(Object.entries(METHOD_TAG).map(([m, t]) => [t, m as Method]));
const methodsOf = (b: CampaignBuyer): Method[] => Array.from(new Set(b.tags.map((t) => tagToMethod.get(t.toLowerCase())).filter((m): m is Method => !!m)));

const chip = (on: boolean, disabled = false): React.CSSProperties => ({
  border: `1px solid ${on ? C.ink : C.line}`, background: on ? C.ink : '#fff', color: on ? '#fff' : C.ink, borderRadius: '999px', padding: '5px 11px',
  fontSize: '12px', fontWeight: 600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap', lineHeight: '16px',
});
const area: React.CSSProperties = { width: '100%', border: `1px solid ${C.line}`, borderRadius: '9px', padding: '8px 10px', fontSize: '12.5px', lineHeight: 1.5, fontFamily: 'inherit', color: C.ink, background: '#fff', resize: 'vertical', minHeight: '64px', boxSizing: 'border-box' };

export function QuickCampaign({ workspaceId, dealId, canWrite, isMobile, dealFields, textCtx, prefill, onToast, onLaunched, onAdvanced, onClose }: Props) {
  const session = useSession();
  const me = session.user?.id ?? null;
  const role = (session as unknown as { workspace?: { role?: string } | null }).workspace?.role ?? '';
  const ctx: SendContext = { ...textCtx, repPhone: session.profile?.phone ?? '', repEmail: session.user?.email ?? '' };

  const [data, setData] = useState<CampaignData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>(BUILTIN_PRESETS);
  const [presetKey, setPresetKey] = useState('machine');
  const [who, setWho] = useState<Set<Who>>(() => new Set<Who>(prefill.length ? ['picked'] : ['matched']));
  const [channels, setChannels] = useState<Record<Channel, boolean>>({ sms: true, email: true, rvm: true, ai_call: true });
  const [copy, setCopy] = useState<QuickCopy | null>(null);
  const [editing, setEditing] = useState<keyof QuickCopy | null>(null);
  const [aiIntro, setAiIntro] = useState(true);
  const [clipId, setClipId] = useState<string>('');
  const [resend, setResend] = useState<ResendStatus | null>(null);
  const [talkrMe, setTalkrMe] = useState<MeDto | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [launching, setLaunching] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [now] = useState(() => new Date());
  const tz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } }, []);
  const vmLib = useVmLibrary(workspaceId);
  const clips = vmLib.clips.filter(droppable);

  useEffect(() => {
    let live = true;
    void loadCampaignData(workspaceId, dealId).then(async (r) => {
      if (!live) return;
      if (!r.ok) { setErr(r.message); return; }
      let d = r.data;
      const mine = d.matches.filter((m) => m.deal_id === dealId);
      const newest = mine.reduce((a, m) => Math.max(a, Date.parse(m.updated_at)), 0);
      if (canWrite && (!mine.length || newest < Date.parse(d.deal.updatedAt) || newest < Date.now() - 86_400_000)) {
        const { matchDeal } = await import('@/lib/crm-write');
        const m = await matchDeal(dealId);
        if (m.ok) { forgetCampaignData(dealId); const again = await loadCampaignData(workspaceId, dealId); if (again.ok) d = again.data; }
      }
      const pooled = new Set(d.buyers.map((b) => b.id));
      const missing = prefill.filter((id) => !pooled.has(id));
      if (missing.length) { const extra = await loadCampaignBuyersByIds(workspaceId, missing); if (extra.length) d = { ...d, buyers: [...d.buyers, ...extra] }; }
      if (!live) return;
      if (canWrite) void import('@/lib/dispo').then((m) => m.publishDeal(dealId)).catch(() => {});
      setCopy(defaultCopy(d.templates));
      const own = d.gmail.find((g) => g.user_id === me);
      setAccountId(own ? String(own.id) : '');
      setData(d);
    });
    void loadPresets(workspaceId).then((p) => { if (live) setPresets(p); });
    void deliverability<ResendStatus>(workspaceId, 'resend_status').then((r) => { if (live && r.ok) setResend(r.data); });
    talkr.me().then((m) => { if (live) setTalkrMe(m); }).catch(() => {});
    return () => { live = false; };
  }, [workspaceId, dealId, canWrite, me, prefill]);

  const preset = presets.find((p) => p.key === presetKey) ?? presets[0] ?? BUILTIN_PRESETS[0];
  const rows = useMemo(() => (data ? data.buyers.map((b) => buyerRow(b, data)) : []), [data]);
  const picked = useMemo(() => new Set(prefill), [prefill]);
  const counts = useMemo(() => {
    const c: Partial<Record<Who, number>> = { matched: 0, vip: 0, picked: prefill.length, all: 0 };
    for (const r of rows) {
      const live = !r.b.blacklisted && !/inactive/i.test(r.b.status);
      if (!live) continue;
      c.all = (c.all ?? 0) + 1;
      if (r.match && (r.match.score ?? 0) >= 55) c.matched = (c.matched ?? 0) + 1;
      if (r.b.vip) c.vip = (c.vip ?? 0) + 1;
      for (const m of methodsOf(r.b)) c[m] = (c[m] ?? 0) + 1;
    }
    return c;
  }, [rows, prefill.length]);
  const audience = useMemo(() => {
    const inA = (r: BuyerRow) => {
      if (r.b.blacklisted || /inactive/i.test(r.b.status)) return false;
      if (who.has('all')) return true;
      if (who.has('picked') && picked.has(r.b.id)) return true;
      if (who.has('matched') && r.match && (r.match.score ?? 0) >= 55) return true;
      if (who.has('vip') && r.b.vip) return true;
      const ms = methodsOf(r.b);
      return ms.some((m) => who.has(m));
    };
    return rows.filter(inA).sort((a, b) => b.level - a.level || (b.match?.score ?? 0) - (a.match?.score ?? 0));
  }, [rows, who, picked]);
  // Buyers found by a method are prospects until vetted; picking their chip is picking them by hand.
  const handPicked = useMemo(() => Array.from(new Set([...prefill, ...audience.filter((r) => methodsOf(r.b).some((m) => who.has(m))).map((r) => r.b.id)])), [prefill, audience, who]);
  const fields = useMemo(() => (dealFields.photo_url || !data?.photos.length ? dealFields : { ...dealFields, photo_url: data.photos[0].url }), [dealFields, data]);

  const plan = useMemo(() => (data && copy ? buildQuickPlan({ rows: audience, preset, channels, copy, dealFields: fields, ctx, data, links: {}, ai: {}, aiIntro, tz, now, handPicked }) : null),
    // ctx is rebuilt per render; its parts are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, copy, audience, preset, channels, fields, aiIntro, tz, now, handPicked, textCtx.repName, textCtx.company, session.profile?.phone, session.user?.email]);
  const perChannel = (ch: Channel) => plan?.recipients.filter((r) => r.messages.some((m) => m.channel === ch)).length ?? 0;
  const firstSend = plan?.recipients.length ? Math.min(...plan.recipients.flatMap((r) => r.messages.map((m) => Date.parse(m.send_at)))) : null;
  const usesIntro = preset.steps.some((s) => s.channel === 'sms' && s.kind === 'intro') && channels.sms;
  const gmailChoices = (data?.gmail ?? []).filter((g) => g.user_id === me || ['owner', 'admin'].includes(role));
  const account = (data?.gmail ?? []).find((g) => String(g.id) === accountId) ?? null;
  const useResend = !!resend?.configured && !!resend.sender;
  const emailReady = useResend || !!account;
  const defaultNumber = talkrMe ? (talkrMe.org_numbers.find((n) => n.id === talkrMe.default_phone_number_id)?.phone_e164 ?? talkrMe.numbers[0]?.phone_e164 ?? null) : null;
  const toggleWho = (w: Who) => setWho((s) => { const n = new Set(s); if (n.has(w)) n.delete(w); else n.add(w); return n; });

  const launch = async () => {
    if (!data || !copy || !plan || !canWrite) return;
    if (!plan.recipients.length) return onToast('Nobody is in this campaign yet: pick a chip above.');
    if (channels.email && perChannel('email') && !emailReady) return onToast('Email needs Resend configured or your Gmail connected (Settings → Google). Switch Email off to send without it.');
    setLaunching('Building the buyer links…');
    const ids = plan.recipients.map((r) => r.buyer_id);
    const linksRes = await mintBuyerLinks(dealId, ids);
    if (!linksRes.ok) { setLaunching(null); return onToast(`Could not build the tracked buyer links: ${linksRes.message}`); }
    let ai: Record<number, AiText> = {};
    if (usesIntro && aiIntro) {
      const targets = plan.recipients.filter((r) => r.messages.some((m) => m.channel === 'sms' && m.kind === 'intro')).map((r) => r.buyer_id).slice(0, 400);
      setLaunching(`Writing ${targets.length} intros…`);
      const w = await writeWithAi(workspaceId, dealId, targets, 'intro', { tone: 'friendly', emoji: 'never', instructions: '', avoid: [] }, {}, (n) => setLaunching(`Writing intros… ${n} of ${targets.length}`));
      if (w.ok) ai = Object.fromEntries(w.data.map((x) => [x.buyer_id, { intro: x.text }]));
      else onToast(`AI intros unavailable (${w.message}); the template intro is used.`);
    }
    setLaunching('Launching…');
    const fresh = buildQuickPlan({ rows: audience, preset, channels, copy, dealFields: fields, ctx, data, links: linksRes.data.links, ai, aiIntro, tz, now: new Date(), handPicked });
    const clip = clips.find((c) => String(c.id) === clipId) ?? null;
    const settings = {
      quick: true, preset: preset.key, channels, steps: preset.steps,
      intro: { mode: usesIntro && aiIntro ? 'ai' : usesIntro ? 'own' : 'none', tone: 'friendly' },
      brief: { sms: channels.sms, email: channels.email, rvm: channels.rvm, rvmBody: channels.rvm ? copy.rvm : undefined, rvmRecording: channels.rvm && clip?.audio_path ? { libraryId: clip.id, path: clip.audio_path, variantGroup: pinnedGroup(clip.id), seconds: clip.seconds ?? 0 } : null, ai_call: channels.ai_call, callGoal: channels.ai_call ? copy.call : undefined },
      followups: { sms: channels.sms, email: channels.email },
      segments: [{ key: 'buyers', label: 'Buyers', count: fresh.recipients.length }],
    };
    const r = await launchCampaign(workspaceId, dealId, JSON.parse(JSON.stringify(settings)), {
      from_phone_number_id: null, from_phone: defaultNumber, email_account_id: account ? account.id : null, from_name: (textCtx.repName || '').trim().split(/\s+/)[0] || null,
      email_provider: useResend ? 'resend' : 'gmail', email_sender_id: useResend ? resend!.sender!.id : null, timezone: tz, starts_at: new Date().toISOString(),
    }, fresh.recipients.map(({ row: _row, ...p }) => { void _row; return p; }));
    setLaunching(null); setConfirm(false);
    if (!r.ok) return onToast(r.message);
    onToast(`Launched to ${fresh.recipients.length} buyer${fresh.recipients.length === 1 ? '' : 's'} · ${recipeWords(fresh.steps)} · hands off from here`);
    onLaunched();
  };

  if (err) return <div className="mk-card" style={{ padding: '16px' }}><Note level="block">Could not load the buyers for this deal: {err}</Note></div>;
  if (!data || !copy || !plan) return <div className="mk-card" style={{ padding: '18px 16px', fontSize: '12.5px', color: C.muted2 }} role="status">Loading matched buyers, templates and history…</div>;

  const whoChips: [Who, string][] = [
    ['matched', `Matched · ${counts.matched ?? 0}`], ['vip', `VIP · ${counts.vip ?? 0}`],
    ...(prefill.length ? [['picked', `Hand-picked · ${prefill.length}`] as [Who, string]] : []),
    ...METHODS.filter((m) => counts[m]).map((m) => [m, `${METHOD_LABEL[m]} · ${counts[m]}`] as [Who, string]),
    ['all', `Every active buyer · ${counts.all ?? 0}`],
  ];
  const copyRows: { key: keyof QuickCopy; label: string; on: boolean; note?: string }[] = [
    { key: 'intro', label: 'Opening text', on: usesIntro, note: usesIntro && aiIntro ? 'AI writes one per buyer from what they bought; this is the fallback' : undefined },
    { key: 'sms', label: 'Deal text', on: channels.sms && preset.steps.some((s) => s.channel === 'sms' && s.kind === 'brief') },
    { key: 'email', label: 'Deal email', on: channels.email && preset.steps.some((s) => s.channel === 'email' && s.kind === 'brief'), note: copy.emailHtml ? 'Sent as the designed Acme Homes deal email; this is the text version' : undefined },
    { key: 'rvm', label: 'Voicemail script', on: channels.rvm && preset.steps.some((s) => s.channel === 'rvm'), note: clipId ? 'The recording picked below plays instead' : 'Read by the voice; or pick a recording below' },
    { key: 'call', label: 'What the AI says on the call', on: channels.ai_call && preset.steps.some((s) => s.channel === 'ai_call'), note: 'The call goal the agent works from; it introduces itself and asks before pitching' },
    { key: 'followSms', label: 'Follow-up text', on: channels.sms && preset.steps.some((s) => s.channel === 'sms' && s.kind === 'followup') },
    { key: 'followEmail', label: 'Follow-up email', on: channels.email && preset.steps.some((s) => s.channel === 'email' && s.kind === 'followup') },
  ];
  const excerpt = (t: string) => { const f = t.replace(/\s+/g, ' ').trim(); return f.length > 150 ? `${f.slice(0, 147)}…` : f; };

  return (
    <div className="mk-card" data-testid="quick-campaign" style={{ padding: isMobile ? '14px 12px' : '18px 20px', display: 'grid', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: C.ink }}>Market this deal</div>
          <div style={{ fontSize: '12px', color: C.muted2, marginTop: '2px' }}>Pick the buyers, the channels and a recipe. Launch once; the machine sends the rest and stops for anyone who replies.</div>
        </div>
        <div style={{ flex: 1 }} />
        <Btn size="sm" onClick={onAdvanced}>Advanced builder</Btn>
        {onClose ? <Btn size="sm" onClick={onClose}>Close</Btn> : null}
      </div>

      <section>
        <Eyebrow>1 · Who</Eyebrow>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
          {whoChips.map(([w, l]) => <button key={w} type="button" onClick={() => toggleWho(w)} style={chip(who.has(w))}>{l}</button>)}
        </div>
        <div style={{ fontSize: '12px', color: C.muted2, marginTop: '6px' }}>
          {plan.recipients.length} buyer{plan.recipients.length === 1 ? '' : 's'} get it{plan.skipped.length ? ` · ${plan.skipped.length} skipped (${Array.from(new Set(plan.skipped.map((s) => s.why))).slice(0, 3).join(', ')})` : ''}.
          {METHODS.some((m) => counts[m]) ? ' Buyers Genius found are labelled by the method that found them.' : ''}
        </div>
      </section>

      <section>
        <Eyebrow>2 · How</Eyebrow>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
          {CHANNELS.map((ch) => (
            <button key={ch} type="button" onClick={() => setChannels((c) => ({ ...c, [ch]: !c[ch] }))} style={chip(channels[ch])} title={ch === 'ai_call' ? 'Your published dispo AI agent calls them with the deal brief' : ch === 'rvm' ? 'A ringless voicemail drop, your recording or the script read aloud' : undefined}>
              {CHANNEL_LABEL[ch]}{channels[ch] ? ` · ${perChannel(ch)}` : ''}
            </button>
          ))}
          <span style={{ fontSize: '11.5px', color: C.muted2 }}>{channels.email && perChannel('email') && !emailReady ? 'Email needs Resend or your Gmail connected.' : useResend ? `Email from ${resend?.sender?.from_email ?? 'the blast pool'}` : account ? `Email from ${account.email}` : ''}{defaultNumber ? ` · Texts from ${defaultNumber}` : ''}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(190px, 1fr))', gap: '8px', marginTop: '10px' }}>
          {presets.map((p) => (
            <button key={p.key} type="button" onClick={() => setPresetKey(p.key)} style={{ textAlign: 'left', border: `1px solid ${presetKey === p.key ? C.ink : C.line}`, background: presetKey === p.key ? '#fafafa' : '#fff', borderRadius: '10px', padding: '10px 12px', cursor: 'pointer', boxShadow: presetKey === p.key ? `inset 0 0 0 1px ${C.ink}` : 'none' }}>
              <div style={{ fontSize: '13px', fontWeight: 650, color: C.ink }}>{p.name}</div>
              <div style={{ fontSize: '11.5px', color: C.muted2, marginTop: '3px', lineHeight: 1.45 }}>{p.blurb}</div>
              <div style={{ fontSize: '11px', color: C.muted, marginTop: '4px' }}>{recipeWords(p.steps.filter((s) => channels[s.channel]))}</div>
            </button>
          ))}
        </div>
        {!isMobile && gmailChoices.length > 1 && !useResend ? (
          <div style={{ marginTop: '8px', fontSize: '12px', color: C.muted2 }}>
            Send email as <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ fontSize: '12px' }}>{gmailChoices.map((g) => <option key={g.id} value={String(g.id)}>{g.email}</option>)}</select>
          </div>
        ) : null}
      </section>

      <section>
        <Eyebrow>3 · What it says</Eyebrow>
        {usesIntro ? <div style={{ marginTop: '6px' }}><Switch on={aiIntro} set={setAiIntro}>AI writes the opening text for each buyer from what they bought nearby</Switch></div> : null}
        <div style={{ display: 'grid', gap: '6px', marginTop: '8px' }}>
          {copyRows.filter((r) => r.on).map((r) => (
            <div key={r.key} style={{ border: `1px solid ${C.line}`, borderRadius: '10px', padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <b style={{ fontSize: '12px', color: C.ink }}>{r.label}</b>
                {r.note ? <span style={{ fontSize: '11px', color: C.muted2 }}>{r.note}</span> : null}
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => setEditing(editing === r.key ? null : r.key)} style={{ border: 0, background: 'none', color: C.ink, fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>{editing === r.key ? 'Done' : 'Edit'}</button>
              </div>
              {editing === r.key ? (
                <>
                  {r.key === 'email' || r.key === 'followEmail' ? <input value={r.key === 'email' ? copy.emailSubject : copy.followEmailSubject} onChange={(e) => setCopy({ ...copy, [r.key === 'email' ? 'emailSubject' : 'followEmailSubject']: e.target.value })} placeholder="Subject" style={{ ...area, minHeight: 0, marginTop: '6px' }} /> : null}
                  <textarea value={copy[r.key] ?? ''} onChange={(e) => setCopy({ ...copy, [r.key]: e.target.value })} style={{ ...area, marginTop: '6px' }} />
                  <div style={{ fontSize: '11px', color: C.muted2, marginTop: '4px' }}>Merge fields: {'{{first_name}} {{address}} {{city}} {{price}} {{beds}} {{baths}} {{deal_link}} {{purchase_note}} {{rep_first_name}} {{company}}'}</div>
                </>
              ) : <div style={{ fontSize: '12px', color: C.muted, marginTop: '3px', lineHeight: 1.45 }}>{excerpt(copy[r.key] ?? '')}</div>}
              {r.key === 'rvm' && clips.length ? (
                <div style={{ marginTop: '6px', fontSize: '12px', color: C.muted2 }}>
                  Recording: <select value={clipId} onChange={(e) => setClipId(e.target.value)} style={{ fontSize: '12px' }}>
                    <option value="">Read the script aloud</option>
                    {clips.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          ))}
          {!copyRows.some((r) => r.on) ? <Note level="warn">Switch a channel on, or pick a recipe with a step on one.</Note> : null}
        </div>
      </section>

      <section style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', paddingTop: '4px', borderTop: `1px solid ${C.line}` }}>
        <div style={{ fontSize: '12.5px', color: C.ink }}>
          <b>{plan.recipients.length}</b> buyer{plan.recipients.length === 1 ? '' : 's'} · {recipeWords(plan.steps)}{firstSend ? ` · first send ${whenLabel(firstSend, tz, now)}` : ''}
          <div style={{ fontSize: '11.5px', color: C.muted2 }}>Follow-ups, the voicemail and the call go only to buyers who have not replied. A reply or an offer stops their sequence and tells you.</div>
        </div>
        <span style={{ flex: 1 }} />
        {confirm ? (
          <>
            <span style={{ fontSize: '12px', color: C.muted2 }}>Send to {plan.recipients.length} now?</span>
            <Btn size="sm" onClick={() => setConfirm(false)} disabled={!!launching}>Not yet</Btn>
            <Btn kind="primary" size="sm" onClick={() => void launch()} disabled={!!launching}>{launching ?? 'Yes, launch'}</Btn>
          </>
        ) : (
          <Btn kind="primary" size="lg" onClick={() => setConfirm(true)} disabled={!canWrite || !plan.recipients.length}>Launch</Btn>
        )}
      </section>
    </div>
  );
}
