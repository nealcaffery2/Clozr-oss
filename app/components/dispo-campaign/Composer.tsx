'use client';

// The campaign composer: three stages — Audience, Message, Review — beside a
// live preview of what one buyer gets and a rail that says who, how, when and
// how much. It opens with everything filled (the matched audience, the AI
// intro in a friendly tone, the deal brief from the workspace's templates), so
// a good campaign is Review → Send.
//
// The data side is the old seven-step builder's, unchanged: the same load
// (matchDeal when stale, then COMPR sync and publish), the same moment the
// tracked links are minted (when the rep reaches the brief), the same AI calls
// when Review opens, and launch hands the same settings, delivery and freshly
// timed plan to dispo_campaign_launch. On /demo (`demo` set) none of that runs:
// the rows are sample data and every write ends in a "(demo)" toast.

import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '@/lib/session';
import { talkr, formatPhone, type MeDto } from '@/lib/talkr';
import type { SendContext } from '@/lib/sms';
import { type AiOptions, type CampaignBuyer, type CampaignData, type PlannedRecipient, isRealtor, launchCampaign, forgetCampaignData, loadCampaignBuyersByIds, loadCampaignData, loadMarketRealtors, realtorInMarket, REALTOR_CAP, writeWithAi } from '@/lib/dispo-campaign';
import { savePushRecording, retirePushRecording, pushRecordingUrl } from '@/lib/rvm-recording';
import { useVmLibrary } from '@/app/components/talkr/useVmLibrary';
import { clipClock, droppable, pinnedGroup } from '@/lib/rvm-pick';
import {
  type AiText, type BuyerRow, type Filters, type Settings, DEFAULT_FILTERS, aiIntroFor, buildPlan, buyerRow, fieldsForBuyer, filteredOut, isFirstLook, messageKey, skipWhy,
} from '@/lib/dispo-plan';
import { renderMerge } from '@/lib/sms';
import { queueBulkRvm } from '@/lib/crm-write';
import { MERGE_FIELDS, renderEmail } from '@/lib/message-templates';
import { type LinkMap, mintBuyerLinks } from '@/lib/dispo';
import { type ResendStatus, deliverability, poolRoom, repSenderPool, spamRisk } from '@/lib/deliverability';
import { STRATEGIES } from '@/lib/buyer-profile';
import {
  GENERIC_INTRO, chooseIntro, dealCountLabel, dispoBuyerFields, distanceLabel, inSendWindow, offerAsk, propertyTypeLabel, rotate, WINDOW,
} from '@/supabase/functions/_shared/dispo-rules';
import { type DemoMarketing, demoIntro } from './demo-data';
import { audienceView, cadenceLabel, channelWords, closestField, dropToken, dropTokenHtml, launchSentence, mergeCheck, planSummary, plural, swapToken, tzLabel, whenLabel } from './logic';
import { Avatar, Btn, C, Choice, Dialog, Disclosure, Eyebrow, Icon, Note, Status, Svg, Switch } from './ui';
import { EmailView, Scaled, SmsThread } from './Preview';
import { type LightboxDraft, MessageLightbox } from './MessageLightbox';
import { carrierCheck } from '@/lib/carrier-safe';
import { htmlToText } from '@/lib/email-text';
import { type CarrierReview, findingLine, fixHtmlWords, fixWords, reviewMessage } from '@/lib/message-revise';
import { RvmRecorder } from './RvmRecorder';
import { GeniusImport } from './GeniusImport';
import { PushReview, type ReviewSegment, type ReviewVariant } from './PushReview';

export type ComposerProps = {
  workspaceId: number; dealId: number; canWrite: boolean; isMobile: boolean; dealFields: Record<string, string>; textCtx: { repName: string; company: string };
  prefill: number[]; onToast: (m: string) => void; onLaunched: () => void;
  /** Back to the results, when there are any. */
  onClose: (() => void) | null;
  demo: DemoMarketing | null;
  /** Opened from "New campaign": bring it into view. */
  reveal?: boolean;
  /** Put these buyers on the rep's call queue. */
  onQueue?: (buyerIds: number[]) => void | Promise<void>;
  /** Start the buyer AI agent for these buyers. */
  onAgent?: (buyerIds: number[]) => void | Promise<void>;
  /** Switch to the one-screen quick send. */
  onQuick?: () => void;
};

const TONES = ['casual', 'professional', 'friendly', 'direct', 'urgent'];
const FREQ: Settings['intro']['split'][] = ['never', 'sometimes', 'frequently'];
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } };
const TZS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'];
// The fallbacks when the workspace has no shared templates. {{purchase_note}}
// is the buyer's last purchase and its distance to this deal, or nothing.
const SMS_BRIEF = 'Hi {{first_name}}, new deal: {{address}}, {{city}} at {{price}}. {{purchase_note}} Photos and numbers: {{deal_link}} Reply YES for details.';
const EMAIL_SUBJECT = 'New deal: {{address}} · {{price}}';
const EMAIL_BRIEF = 'Hi {{first_name}},\n\nWe just got {{address}}, {{city}} under contract at {{price}} ({{beds}} bd / {{baths}} ba). {{purchase_note}}\n\nPhotos, numbers and the offer form: {{deal_link}}\n\nReply if you want the details or a walkthrough.';
/** What {{deal_link}} and {{listing_url}} show in the preview before the tracked links exist. Preview only; never sent. */
const LINK_PLACEHOLDER = '[their tracked link]';
const INSERT = ['first_name', 'address', 'city', 'price', 'arv', 'beds', 'baths', 'deal_link', 'purchase_note', 'rep_first_name'];
const FIELD_LABEL: Record<string, string> = Object.fromEntries(MERGE_FIELDS.map((f) => [f.token.replace(/[{}]/g, ''), f.label]));
FIELD_LABEL.price = 'Price'; FIELD_LABEL.listing_url = 'Tracked link'; FIELD_LABEL.deal_link = 'Deal link'; FIELD_LABEL.rehab = 'Rehab';

/**
 * Email templates a deal brief can use, best first: the Acme Homes deal blast
 * (the designed HTML, migration 58), any other blast, then the block-built
 * dispo emails.
 */
function emailChoices(ts: CampaignData['templates']): CampaignData['templates'] {
  const rank = (t: CampaignData['templates'][number]) => (t.category === 'dispo-blast' ? (/acme homes/i.test(t.name) ? 0 : 1) : 2);
  return ts.filter((t) => t.channel === 'email' && (t.category === 'dispo-blast' || t.category === 'dispo'))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const INITIAL: Settings = {
  intro: { mode: 'ai', templateBody: GENERIC_INTRO, split: 'never', emoji: 'never', instructions: '', tone: 'friendly', avoid: [] },
  variations: { useImage: false, imageUrl: '', reserveLevel: 0, frequency: 'sometimes' },
  brief: { order: 'sms', wait: 1, waitUnit: 'hours', sms: true, smsBody: SMS_BRIEF, email: true, emailSubject: EMAIL_SUBJECT, emailBody: EMAIL_BRIEF, emailHtml: null, rvm: false, rvmBody: 'Hi {{first_name}}, this is about {{address}}. Call me back when you have a minute.' },
  followups: { after: 1, afterUnit: 'hours', order: 'sms', wait: 23, waitUnit: 'hours', smart: false, sms: true, smsAi: false, smsList: [], email: true, emailAi: false, emailList: [], pauseUnengaged: true, unengagedN: 3 },
  timezone: browserTz(), startAt: '',
  // The SOP: VIP and A-list buyers get the first 24 hours, then the list.
  vipFirst: { on: true, hours: 24 },
};

/** The workspace's templates as the composer's starting point (the old builder's defaults, unchanged). */
function defaultsFrom(d: CampaignData) {
  const tpl = (name: string) => d.templates.find((t) => t.name === name);
  const sms = tpl('Dispo · New deal text');
  // The email brief is the Acme Homes deal blast — the designed HTML — with
  // the block-built "New deal email" still there to pick.
  const email = emailChoices(d.templates)[0];
  const intros = d.templates.filter((t) => t.category === 'dispo-intro' && t.channel === 'sms');
  // The intro that carries {{purchase_note}} reads right whatever is on
  // file; the older two fall back to the generic intro unless every one of
  // their facts is present.
  const intro = intros.find((t) => /purchase_note/.test(t.body_text)) ?? intros[0];
  const apply = (s: Settings): Settings => ({
    ...s,
    intro: { ...s.intro, templateBody: intro?.body_text ?? s.intro.templateBody },
    brief: { ...s.brief, smsBody: sms?.body_text ?? s.brief.smsBody, emailSubject: email?.subject ?? s.brief.emailSubject, emailBody: email?.body_text ?? s.brief.emailBody, emailHtml: email?.body_html ?? null },
    followups: {
      ...s.followups,
      smsList: d.templates.filter((t) => t.category === 'dispo-followup' && t.channel === 'sms').map((t) => t.body_text),
      emailList: d.templates.filter((t) => t.category === 'dispo-followup' && t.channel === 'email').map((t) => ({ subject: t.subject ?? '', body: t.body_text })),
    },
    variations: { ...s.variations, imageUrl: d.photos[0]?.url ?? '' },
  });
  return { apply, introId: intro ? String(intro.id) : '', emailId: email ? String(email.id) : '' };
}

const when = (iso: string | null, tz?: string) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—');

/** The demo's AI: what dispo-intro would write from the same facts, per tone. */
function demoAi(rows: BuyerRow[], tone: string, repFirst: string, deal: CampaignData['deal']): Record<number, AiText> {
  return Object.fromEntries(rows.map((r) => [r.b.id, {
    intro: demoIntro(tone, { first: r.facts.firstName, rep: repFirst || 'Morgan', note: dispoBuyerFields(r.facts).purchase_note, hook: offerAsk(r.facts, deal.address), city: deal.city ?? '', type: propertyTypeLabel(deal.propertyType) }),
  }]));
}

export function Composer({ workspaceId, dealId, canWrite, isMobile, dealFields, textCtx, prefill, onToast, onLaunched, onClose, demo, reveal, onQueue, onAgent, onQuick }: ComposerProps) {
  const session = useSession();
  const me = session.user?.id ?? null;
  const role = (session as unknown as { workspace?: { role?: string } | null }).workspace?.role ?? '';
  const ctx: SendContext = { ...textCtx, repPhone: session.profile?.phone ?? '', repEmail: session.user?.email ?? '' };
  const repFirst = (textCtx.repName || session.profile?.full_name || '').trim().split(/\s+/)[0] ?? '';

  // ---- the old builder's state, as it was
  const demoDefaults = useMemo(() => (demo ? defaultsFrom(demo.data) : null), [demo]);
  const [data, setData] = useState<CampaignData | null>(() => demo?.data ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkMap>({});
  const [linksBusy, setLinksBusy] = useState(false);
  const [now] = useState(() => new Date());
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [include, setInclude] = useState<Record<number, boolean>>(() => Object.fromEntries(prefill.map((id) => [id, true])));
  const [q, setQ] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [avoidDraft, setAvoidDraft] = useState('');
  const [templateId, setTemplateId] = useState(() => demoDefaults?.introId ?? '');
  const [emailTemplateId, setEmailTemplateId] = useState(() => demoDefaults?.emailId ?? '');
  const [settings, setSettings] = useState<Settings>(() => (demoDefaults ? demoDefaults.apply({ ...INITIAL, timezone: 'America/Chicago' }) : INITIAL));
  const [ai, setAi] = useState<Record<number, AiText>>({});
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<Record<number, string>>({});
  const [overrides, setOverrides] = useState<Record<string, { body: string; subject?: string }>>({});
  const [talkrMe, setTalkrMe] = useState<MeDto | null>(() => demo?.talkrMe ?? null);
  const [talkrErr, setTalkrErr] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ phoneMode: 'default' | 'custom'; numberId: string; fromName: string; accountId: string }>({ phoneMode: 'default', numberId: '', fromName: repFirst, accountId: '' });
  const [pick, setPick] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'sms' | 'email'>('sms');
  const [editing, setEditing] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [resend, setResend] = useState<ResendStatus | null>(() => demo?.resend ?? null);

  // ---- the composer's own
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [list, setList] = useState<'matched' | 'others'>('matched');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [previewCh, setPreviewCh] = useState<'sms' | 'email'>('sms');
  /** The preview opened over the whole screen, at the size a buyer reads it. */
  const [bigPreview, setBigPreview] = useState(false);
  useEffect(() => {
    if (!bigPreview) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setBigPreview(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [bigPreview]);
  const [sampleTone, setSampleTone] = useState<string | null>(null);
  /** The message open in the big editor: intro, brief-sms, brief-email, fu-sms-N or fu-email-N (N indexes the follow-up list). */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /** The email's main photo when the rep picked one in the editor; otherwise the deal's own. */
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  /** Deal fields this deal has no value for, typed in from a check for this campaign only. */
  const [fill, setFill] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [toneSwapped, setToneSwapped] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Realtors as a segment of this push, read when the rep switches them on.
  const [realtorsOn, setRealtorsOn] = useState(false);
  const [realtorPool, setRealtorPool] = useState<{ rows: CampaignBuyer[]; corpusTotal: number; capped: boolean } | null>(null);
  const [realtorsBusy, setRealtorsBusy] = useState(false);
  const [realtorsErr, setRealtorsErr] = useState<string | null>(null);
  const [realtorsAll, setRealtorsAll] = useState(false);
  // Playback of the push's recording: the take itself, so it plays without a signed URL.
  const [recUrl, setRecUrl] = useState<string | null>(null);
  useEffect(() => () => { if (recUrl) URL.revokeObjectURL(recUrl); }, [recUrl]);
  // The workspace's saved voicemails, so a push can drop one instead of a new take.
  const vmLib = useVmLibrary(demo ? null : workspaceId);
  const savedClips = vmLib.clips.filter(droppable);
  const set = <K extends keyof Settings>(k: K, patch: Partial<Settings[K]>) => setSettings((s) => ({ ...s, [k]: typeof s[k] === 'object' ? { ...(s[k] as object), ...patch } : patch } as Settings));

  useEffect(() => {
    if (demo) return;
    let live = true;
    void loadCampaignData(workspaceId, dealId).then(async (r) => {
      if (!live) return;
      if (!r.ok) { setErr(r.message); return; }
      let d = r.data;
      const mine = d.matches.filter((m) => m.deal_id === dealId);
      const newest = mine.reduce((a, m) => Math.max(a, Date.parse(m.updated_at)), 0);
      // Stale: never matched, or the deal changed since, or older than a day.
      if (canWrite && (!mine.length || newest < Date.parse(d.deal.updatedAt) || newest < Date.now() - 86_400_000)) {
        const { matchDeal } = await import('@/lib/crm-write');
        const m = await matchDeal(dealId);
        if (m.ok) { forgetCampaignData(dealId); const again = await loadCampaignData(workspaceId, dealId); if (again.ok) d = again.data; }
      }
      // Anyone handed over who is not in the pool (a lassoed realtor) is read by id, so they start ticked rather than vanishing.
      const pooled = new Set(d.buyers.map((b) => b.id));
      const missing = prefill.filter((id) => !pooled.has(id));
      if (missing.length) {
        const extra = await loadCampaignBuyersByIds(workspaceId, missing);
        if (extra.length) d = { ...d, buyers: [...d.buyers, ...extra] };
      }
      if (!live) return;
      if (canWrite && d.deal.sellerId) {
        void import('@/lib/compr').then((m) => m.syncComprMarketing(workspaceId, d.deal.sellerId!, dealId)).catch(() => {});
        void import('@/lib/dispo').then((m) => m.publishDeal(dealId)).catch(() => {});
      }
      const dflt = defaultsFrom(d);
      setSettings(dflt.apply);
      if (dflt.introId) setTemplateId(dflt.introId);
      if (dflt.emailId) setEmailTemplateId(dflt.emailId);
      const own = d.gmail.find((g) => g.user_id === me);
      setDelivery((x) => ({ ...x, accountId: own ? String(own.id) : '' }));
      setData(d);
    });
    return () => { live = false; };
  }, [workspaceId, dealId, canWrite, me, demo, prefill]);

  // Talkr numbers: read when Review opens (the old builder read them on its Delivery step).
  useEffect(() => {
    if (demo || stage !== 2 || talkrMe || talkrErr) return;
    let live = true;
    talkr.me().then((m) => { if (live) setTalkrMe(m); }).catch((e: Error) => { if (live) setTalkrErr(e.message); });
    return () => { live = false; };
  }, [stage, talkrMe, talkrErr, demo]);

  useEffect(() => {
    if (demo) return;
    let live = true;
    void deliverability<ResendStatus>(workspaceId, 'resend_status').then((r) => { if (live && r.ok) setResend(r.data); });
    return () => { live = false; };
  }, [workspaceId, demo]);

  useEffect(() => { if (reveal) rootRef.current?.scrollIntoView({ block: 'start' }); }, [reveal]);

  const rows = useMemo(() => (data ? data.buyers.map((b) => buyerRow(b, data)) : []), [data]);
  // The deal's merge fields, with a photo when the deal fields have none:
  // the public photos this builder already loads (COMPR's first), so
  // {{photo_url}} is never blank while the deal has a picture to show.
  // A photo the rep picked for the email wins over both.
  const fields = useMemo(() => {
    const filled = { ...dealFields, ...Object.fromEntries(Object.entries(fill).filter(([k, v]) => v.trim() && !String(dealFields[k] ?? '').trim())) };
    const base = filled.photo_url || !data?.photos.length ? filled : { ...filled, photo_url: data.photos[0].url };
    return heroUrl ? { ...base, photo_url: heroUrl } : base;
  }, [dealFields, data, heroUrl, fill]);
  const view = useMemo(() => audienceView(rows, filters, include, data?.deal.price ?? null), [rows, filters, include, data]);
  // Realtors in the deal's market join after the buyers. Workspace realtors a
  // match already put in the audience stay where they are; unticking one here
  // leaves them out.
  const realtorRows = useMemo(() => {
    if (!data || !realtorsOn || !realtorPool) return [];
    const known = new Map(rows.map((r) => [r.b.id, r]));
    return realtorPool.rows.map((b) => known.get(b.id) ?? buyerRow(b, data));
  }, [data, realtorsOn, realtorPool, rows]);
  const audience = useMemo(() => {
    if (!realtorRows.length) return view.audience;
    const inA = new Set(view.audience.map((r) => r.b.id));
    return [...view.audience, ...realtorRows.filter((r) => !inA.has(r.b.id) && include[r.b.id] !== false)];
  }, [view.audience, realtorRows, include]);
  const firstLook = useMemo(() => audience.filter(isFirstLook).length, [audience]);
  const handPicked = useMemo(() => Object.entries(include).flatMap(([id, on]) => (on ? [Number(id)] : [])), [include]);
  const scoreOf = (r: BuyerRow) => r.match?.score ?? 0;
  // The plan renders from a deferred copy, so typing in a brief never waits on hundreds of buyers.
  const lagging = useDeferredValue(settings);
  const plan = useMemo(
    () => (data ? buildPlan(audience, lagging, fields, ctx, data, ai, overrides, now, links, handPicked) : { recipients: [], skipped: [] }),
    // ctx is rebuilt per render from the session and textCtx; its parts are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, audience, lagging, fields, ai, overrides, now, links, handPicked, textCtx.repName, textCtx.company, session.profile?.phone, session.user?.email],
  );
  const sum = useMemo(() => planSummary(plan), [plan]);

  // Demo: the preview opens with the AI's first samples already written, as if the rep had asked for them.
  const [seeded, setSeeded] = useState(false);
  if (demo && data && !seeded) {
    setSeeded(true);
    const first = audience.filter((r) => aiIntroFor(settings, r) && !!r.b.phone && r.b.preferredChannel !== 'email_only').slice(0, 5);
    setAi(demoAi(first, settings.intro.tone, repFirst, data.deal));
    setSampleTone(settings.intro.tone);
  }

  if (err) return <div className="mk-card" style={{ padding: '16px' }}><Note level="block">Could not load the buyers for this deal: {err}</Note></div>;
  if (!data) return <div className="mk-card" style={{ padding: '18px 16px', fontSize: '12.5px', color: C.muted2 }} role="status">Loading matched buyers, templates and history…</div>;

  const aiOpts: AiOptions = { tone: settings.intro.tone, emoji: settings.intro.emoji, instructions: settings.intro.instructions, avoid: settings.intro.avoid };
  const aiTargets = audience.filter((r) => aiIntroFor(settings, r) && !!r.b.phone && r.b.preferredChannel !== 'email_only');
  const previewRows = aiTargets.slice(0, 5);

  const runAi = async (targets: BuyerRow[], what: 'intro' | 'followSms' | 'followEmail', opts: AiOptions = aiOpts) => {
    if (!targets.length) return;
    setAiBusy(`${what}:0/${targets.length}`);
    const templates: Record<number, string> = {};
    if (what !== 'intro') {
      targets.forEach((r) => {
        const i = audience.indexOf(r);
        const f = fieldsForBuyer(r, fields, ctx, links);
        const t = what === 'followSms' ? rotate(settings.followups.smsList.filter((x) => x.trim()), i) : rotate(settings.followups.emailList.filter((x) => x.body.trim()), i)?.body;
        if (t) templates[r.b.id] = renderMerge(t, f);
      });
    }
    if (demo) {
      // Sample data: written here, from the same facts, after a beat so the progress is visible.
      await new Promise((res) => setTimeout(res, 450));
      setAiBusy(null);
      setAi((cur) => {
        const next = { ...cur };
        const written = what === 'intro' ? demoAi(targets, opts.tone, repFirst, data.deal) : {};
        for (const r of targets) next[r.b.id] = { ...next[r.b.id], [what]: what === 'intro' ? written[r.b.id].intro : templates[r.b.id] ?? null };
        return next;
      });
      if (what === 'intro') setSampleTone(opts.tone);
      return;
    }
    const res = await writeWithAi(workspaceId, dealId, targets.map((r) => r.b.id), what === 'intro' ? 'intro' : 'followup', opts, templates, (n) => setAiBusy(`${what}:${n}/${targets.length}`));
    setAiBusy(null);
    if (!res.ok) { onToast(res.message); return; }
    setAi((cur) => {
      const next = { ...cur };
      for (const x of res.data) next[x.buyer_id] = { ...next[x.buyer_id], [what]: x.text };
      return next;
    });
    if (what === 'intro') setSampleTone(opts.tone);
    setAiNote((cur) => ({ ...cur, ...Object.fromEntries(res.data.filter((x) => !x.text).map((x) => [x.buyer_id, `AI message not used (${x.reason}); the template is used instead.`])) }));
  };
  const missingAi = aiTargets.filter((r) => ai[r.b.id]?.intro === undefined);
  const missingFollow = (what: 'followSms' | 'followEmail') => (what === 'followSms' ? settings.followups.smsAi && settings.followups.sms : settings.followups.emailAi && settings.followups.email)
    ? plan.recipients.filter((p) => p.messages.some((m) => m.kind === 'followup' && m.channel === (what === 'followSms' ? 'sms' : 'email')) && ai[p.buyer_id]?.[what] === undefined).map((p) => p.row)
    : [];

  /**
   * Publish the deal's buyer page if it is not published, and mint a signed
   * link per matched buyer. Called once, when the composer first needs
   * {{listing_url}} — publishing is a real side effect, so it happens when the
   * rep reaches the message, not when they open the tab.
   */
  const ensureLinks = async () => {
    if (linksBusy || Object.keys(links).length) return;
    if (demo) { setLinks(demo.links); return; }
    setLinksBusy(true);
    const r = await mintBuyerLinks(dealId);
    setLinksBusy(false);
    if (!r.ok) return onToast(`Could not build the tracked buyer links: ${r.message}`);
    setLinks(r.data.links);
  };

  const go = (s: 0 | 1 | 2) => {
    setStage(s);
    // A new stage starts at its top, not wherever the last one was scrolled to.
    const top = rootRef.current?.getBoundingClientRect().top;
    if (top != null && top < 0) rootRef.current?.scrollIntoView({ block: 'start' });
    if (s >= 1) void ensureLinks();
    if (s === 2) {
      if (missingAi.length) void runAi(missingAi, 'intro');
      else if (missingFollow('followSms').length) void runAi(missingFollow('followSms'), 'followSms');
      else if (missingFollow('followEmail').length) void runAi(missingFollow('followEmail'), 'followEmail');
    }
  };
  const aiPending = missingAi.length + missingFollow('followSms').length + missingFollow('followEmail').length;

  const smsCount = sum.smsBuyers;
  const emailCount = sum.emailBuyers;
  const firstSend = sum.firstSend ?? undefined;
  const outside = !inSendWindow(settings.startAt ? new Date(settings.startAt) : now, settings.timezone);
  const numbers = talkrMe?.org_numbers ?? [];
  const defaultNumber = talkrMe ? (talkrMe.org_numbers.find((n) => n.id === talkrMe.default_phone_number_id)?.phone_e164 ?? talkrMe.numbers[0]?.phone_e164 ?? null) : null;
  const gmailChoices = data.gmail.filter((g) => g.user_id === me || ['owner', 'admin'].includes(role));
  const account = data.gmail.find((g) => String(g.id) === delivery.accountId) ?? null;
  const useResend = !!resend?.configured && !!resend.sender;
  const tz = settings.timezone;
  const zone = tzLabel(tz);

  // ---- segments: buyers and realtors, as the review and the saved campaign name them
  const realtorIds = new Set(realtorRows.map((r) => r.b.id));
  const isRealtorRow = (r: BuyerRow) => realtorIds.has(r.b.id) || isRealtor(r.b);
  const segmentsOf = (recs: (PlannedRecipient & { row: BuyerRow })[]): ReviewSegment[] => {
    const by = (xs: typeof recs) => {
      const t = xs.filter((p) => p.messages.some((m) => m.channel === 'sms')).length;
      const e = xs.filter((p) => p.messages.some((m) => m.channel === 'email')).length;
      return `${t} by text · ${e} by email`;
    };
    const agents = recs.filter((p) => isRealtorRow(p.row));
    const buyers = recs.filter((p) => !isRealtorRow(p.row));
    const out: ReviewSegment[] = [{
      key: 'buyers', label: 'Buyers', count: buyers.length,
      detail: `Matched, scoring ${filters.minScore}+${view.byHand ? `, ${view.byHand} set by hand` : ''} · ${by(buyers)}${sum.skippedTotal ? ` · ${sum.skippedTotal} skipped` : ''}`,
    }];
    if (realtorsOn || agents.length) {
      out.push({
        key: 'realtors', label: 'Realtors', count: agents.length,
        detail: `${realtorsOn ? `Working ${data.deal.city || 'this market'}` : 'Matched this deal'} · ${by(agents)}`,
      });
    }
    return out;
  };
  const toggleRealtors = async (on: boolean) => {
    setRealtorsOn(on);
    if (!on || realtorPool || realtorsBusy) return;
    if (demo) {
      const own = data.buyers.filter((b) => isRealtor(b) && realtorInMarket(b, data.deal));
      setRealtorPool({ rows: [...own, ...(demo.realtors ?? [])], corpusTotal: demo.realtors?.length ?? 0, capped: false });
      return;
    }
    setRealtorsBusy(true);
    const r = await loadMarketRealtors(workspaceId, data);
    setRealtorsBusy(false);
    if (!r.ok) { setRealtorsErr(r.message); return; }
    setRealtorsErr(null);
    setRealtorPool({ rows: r.data.realtors, corpusTotal: r.data.corpusTotal, capped: r.data.capped });
  };

  // ---- the recording for this push's ringless voicemail
  // A take recorded for this push belongs to it and is retired when replaced; a
  // saved library recording the rep picked is shared, so it is never retired here.
  const ownTake = (rec: { variantGroup: string }) => rec.variantGroup.startsWith('dispo-push-');
  const pickSaved = async (id: string) => {
    const c = savedClips.find((x) => String(x.id) === id);
    if (!c?.audio_path) return;
    const prior = settings.brief.rvmRecording;
    if (prior && ownTake(prior)) void retirePushRecording(prior.libraryId);
    set('brief', { rvmRecording: { libraryId: c.id, path: c.audio_path, variantGroup: pinnedGroup(c.id), seconds: c.seconds ?? 0 } });
    if (!settings.brief.rvmBody?.trim() && c.script.trim()) set('brief', { rvmBody: c.script });
    setRecUrl(await pushRecordingUrl(c.audio_path));
    onToast(`Using “${c.name}” for this push`);
  };
  const attachRecording = async (blob: Blob, seconds: number): Promise<string | null> => {
    const prior = settings.brief.rvmRecording;
    if (demo) {
      set('brief', { rvmRecording: { libraryId: -1, path: '', variantGroup: 'demo', seconds } });
      setRecUrl(URL.createObjectURL(blob));
      onToast('Recording attached to this push (demo)');
      return null;
    }
    if (!canWrite) return 'A dispositions role is needed to save a recording.';
    const r = await savePushRecording(workspaceId, dealId, blob, seconds, settings.brief.rvmBody ?? '', `Dispo push · ${data.deal.address || `deal ${dealId}`}`, me);
    if (!r.ok) return r.message;
    if (prior && ownTake(prior)) void retirePushRecording(prior.libraryId);
    set('brief', { rvmRecording: r.data });
    setRecUrl(URL.createObjectURL(blob));
    onToast('Recording attached to this push');
    return null;
  };
  const removeRecording = () => {
    const prior = settings.brief.rvmRecording;
    if (prior && !demo && ownTake(prior)) void retirePushRecording(prior.libraryId);
    set('brief', { rvmRecording: null });
    setRecUrl(null);
  };

  const launch = async () => {
    if (!canWrite) return onToast('Sign in with a dispositions role to launch.');
    if (emailCount && !useResend && !account) return onToast(resend?.configured === false
      ? 'Resend is not configured (RESEND_API_KEY + MAIL_FROM_BLASTS). Pick a connected Gmail account in Delivery, or turn email off.'
      : 'Pick a connected Gmail account in Delivery, or turn email off.');
    setLaunching(true);
    // Re-timed from this moment: the review may have been open a while, and a send time in the past would lose the spacing.
    const fresh = buildPlan(audience, settings, fields, ctx, data, ai, overrides, new Date(), links, handPicked);
    if (demo) {
      await new Promise((res) => setTimeout(res, 350));
      setLaunching(false); setConfirming(false);
      onToast(`Campaign launched · ${fresh.recipients.length} buyers · sending on schedule (demo)`);
      onLaunched();
      return;
    }
    // Ringless voicemail goes to the same people the texts would: skipWhy's
    // exclusions (blacklisted, inactive, on an AI agent, a prospect, DNC, no
    // phone, email only), and only once the campaign has actually launched.
    const clip = settings.brief.rvmRecording ?? null;
    const pickedIds = new Set(handPicked);
    const drops = settings.brief.rvm && (settings.brief.rvmBody?.trim() || clip)
      ? audience.flatMap((row) => (skipWhy(row.b, 'sms', pickedIds.has(row.b.id)) ? [] : [{
        buyerId: row.b.id, phone: row.b.phone as string, script: renderMerge(settings.brief.rvmBody ?? '', fieldsForBuyer(row, fields, ctx, links)),
      }]))
      : [];
    const queueRvm = async (): Promise<{ ok: boolean; queued: number; message?: string }> => {
      if (!drops.length) return { ok: true, queued: 0 };
      const q = await queueBulkRvm(workspaceId, me, drops, clip, dealId);
      return q.ok ? { ok: true, queued: q.queued } : { ok: false, queued: 0, message: q.message };
    };
    // Voicemails ride a launched campaign, so they are tracked and stop with
    // it. With no text or email to launch, there is no campaign to tie them to.
    if (!fresh.recipients.length) {
      setLaunching(false); setConfirming(false);
      return onToast(drops.length
        ? 'Turn on a text or email to launch. For voicemail only, use RVM matches on the Matches tab.'
        : 'Nobody in this campaign can be reached by text or email.');
    }
    const rvmQueued = drops.length;
    const r = await launchCampaign(workspaceId, dealId, JSON.parse(JSON.stringify({ filters, intro: { ...settings.intro, templateBody: undefined }, variations: settings.variations, brief: { order: settings.brief.order, wait: settings.brief.wait, waitUnit: settings.brief.waitUnit, sms: settings.brief.sms, email: settings.brief.email, rvm: !!settings.brief.rvm, rvmBody: settings.brief.rvm ? settings.brief.rvmBody ?? '' : undefined, rvmRecording: settings.brief.rvm ? clip : undefined, rvmQueued }, followups: { ...settings.followups, smsList: undefined, emailList: undefined }, segments: segmentsOf(fresh.recipients).map(({ key, label, count }) => ({ key, label, count })) })), {
      from_phone_number_id: delivery.phoneMode === 'custom' && delivery.numberId ? delivery.numberId : null,
      from_phone: delivery.phoneMode === 'custom' ? numbers.find((n) => n.id === delivery.numberId)?.phone_e164 ?? null : defaultNumber,
      email_account_id: account ? account.id : null, from_name: delivery.fromName.trim() || null,
      email_provider: useResend ? 'resend' : 'gmail', email_sender_id: useResend ? resend!.sender!.id : null,
      timezone: settings.timezone, starts_at: settings.startAt || new Date().toISOString(),
    }, fresh.recipients.map(({ row: _row, ...p }) => { void _row; return p; }));
    if (!r.ok) { setLaunching(false); setConfirming(false); return onToast(r.message); }
    const q = await queueRvm();
    setLaunching(false);
    setConfirming(false);
    onToast(`Campaign launched · ${fresh.recipients.length} buyers · sending on schedule${!q.ok ? ` · the voicemails did not queue: ${q.message ?? 'try again from Matches'}` : q.queued ? ` · ${q.queued} ringless voicemails queued` : ''}`);
    onLaunched();
  };

  // ---------------------------------------------------------------- preview
  const pRow = audience.find((r) => r.b.id === previewId) ?? audience[0] ?? null;
  const pIndex = pRow ? audience.indexOf(pRow) : -1;
  const pLinks = pRow && !links[String(pRow.b.id)] ? { ...links, [String(pRow.b.id)]: LINK_PLACEHOLDER } : links;
  const pPlan = pRow ? buildPlan([pRow], settings, fields, ctx, data, ai, overrides, now, pLinks, handPicked) : null;
  const pRec = pPlan?.recipients[0] ?? null;
  const pSkip = pPlan?.skipped[0] ?? null;
  const pFields = pRow ? fieldsForBuyer(pRow, fields, ctx, pLinks) : fields;
  const pEmail = pRec?.messages.find((m) => m.channel === 'email' && m.kind === 'brief') ?? null;
  const spam = pEmail ? spamRisk({ subject: pEmail.subject ?? '', html: pEmail.body_html, text: pEmail.body, kind: 'bulk', recipients: 1 }) : null;
  const fromLine = talkrMe && defaultNumber ? formatPhone(delivery.phoneMode === 'custom' ? numbers.find((n) => n.id === delivery.numberId)?.phone_e164 ?? defaultNumber : defaultNumber) : 'your Talkr line';
  const blastPool = useResend ? repSenderPool(resend?.senders?.length ? resend.senders : resend?.sender ? [resend.sender] : [], me) : [];
  const poolLead = blastPool.find((s) => s.reply_to) ?? blastPool[0];
  const emailFrom = useResend
    ? (blastPool.length > 1
      ? `${poolLead?.from_name || 'Your'} · ${blastPool.length} addresses${poolLead?.reply_to ? `, replies to ${poolLead.reply_to}` : ''}`
      : `${delivery.fromName.trim() || poolLead?.from_name || resend?.sender?.from_name || 'Acme Homes'} <${poolLead?.from_email || resend?.email}>`)
    : account ? account.email : 'a connected Gmail account';
  const pIntroAi = pRow ? ai[pRow.b.id]?.intro : undefined;
  const pGetsAi = !!pRow && aiIntroFor(settings, pRow) && !!pRow.b.phone && pRow.b.preferredChannel !== 'email_only';

  // ---------------------------------------------------------------- carrier check
  // Every message template, checked the way a carrier (or an inbox filter) reads it, before anything sends.
  const fuSmsAt = settings.followups.sms ? settings.followups.smsList.map((t, i) => ({ t, i })).filter((x) => x.t.trim()) : [];
  const fuEmailAt = settings.followups.email ? settings.followups.emailList.map((t, i) => ({ t, i })).filter((x) => x.t.body.trim()) : [];
  const emailWords = (html: string | null, body: string) => (html ? htmlToText(html) : body);
  const carrierReviews: CarrierReview[] = [
    settings.intro.mode !== 'none' ? reviewMessage(settings.intro.mode === 'ai' ? 'Intro template' : 'Intro text', 'intro', 'sms', settings.intro.templateBody) : null,
    settings.brief.sms ? reviewMessage('Deal brief by text', 'brief-sms', 'sms', settings.brief.smsBody) : null,
    settings.brief.email ? reviewMessage('Deal brief by email', 'brief-email', 'email', `${settings.brief.emailSubject}\n${emailWords(settings.brief.emailHtml, settings.brief.emailBody)}`) : null,
    ...fuSmsAt.map(({ t, i }, j) => reviewMessage(`Follow-up text ${j + 1}`, `fu-sms-${i}`, 'sms', t)),
    ...fuEmailAt.map(({ t, i }, j) => reviewMessage(`Follow-up email ${j + 1}`, `fu-email-${i}`, 'email', `${t.subject}\n${t.body}`)),
  ].filter((r): r is CarrierReview => !!r);
  /** The suggested wording, in place: texts take the check's own version, emails the same swaps in their subject, words and HTML. */
  const fixMessage = (r: CarrierReview) => {
    const f = r.check.findings;
    const fu = /^fu-(sms|email)-(\d+)$/.exec(r.target);
    if (r.target === 'intro') set('intro', { templateBody: carrierCheck(settings.intro.templateBody).text });
    else if (r.target === 'brief-sms') set('brief', { smsBody: carrierCheck(settings.brief.smsBody).text });
    else if (r.target === 'brief-email') set('brief', { emailSubject: fixWords(settings.brief.emailSubject, f), emailBody: fixWords(settings.brief.emailBody, f), emailHtml: settings.brief.emailHtml ? fixHtmlWords(settings.brief.emailHtml, f) : null });
    else if (fu?.[1] === 'sms') set('followups', { smsList: settings.followups.smsList.map((x, i) => (i === Number(fu[2]) ? carrierCheck(x).text : x)) });
    else if (fu?.[1] === 'email') set('followups', { emailList: settings.followups.emailList.map((x, i) => (i === Number(fu[2]) ? { subject: fixWords(x.subject, f), body: fixWords(x.body, f) } : x)) });
    onToast(`${r.label}: suggested wording in place`);
  };
  const fixAll = () => carrierReviews.filter((r) => r.suggestion).forEach(fixMessage);

  // ---------------------------------------------------------------- the editor
  const draftOf = (t: string): LightboxDraft | null => {
    if (t === 'intro') return { subject: '', body: settings.intro.templateBody, html: null };
    if (t === 'brief-sms') return { subject: '', body: settings.brief.smsBody, html: null };
    if (t === 'brief-email') return { subject: settings.brief.emailSubject, body: settings.brief.emailBody, html: settings.brief.emailHtml };
    const fu = /^fu-(sms|email)-(\d+)$/.exec(t);
    if (fu?.[1] === 'sms') { const x = settings.followups.smsList[Number(fu[2])]; return x == null ? null : { subject: '', body: x, html: null }; }
    if (fu?.[1] === 'email') { const x = settings.followups.emailList[Number(fu[2])]; return x == null ? null : { subject: x.subject, body: x.body, html: null }; }
    return null;
  };
  const writeDraft = (t: string, d: LightboxDraft, photo = fields.photo_url || null) => {
    const fu = /^fu-(sms|email)-(\d+)$/.exec(t);
    if (t === 'intro') set('intro', { templateBody: d.body });
    else if (t === 'brief-sms') set('brief', { smsBody: d.body });
    else if (t === 'brief-email') {
      // Words typed into a plain email are their own template now; a designed one keeps its name.
      if (!d.html && d.body !== settings.brief.emailBody) setEmailTemplateId('');
      set('brief', { emailSubject: d.subject, emailBody: d.body, emailHtml: d.html });
      if (photo !== (fields.photo_url || null)) setHeroUrl(photo);
    } else if (fu?.[1] === 'sms') set('followups', { smsList: settings.followups.smsList.map((x, i) => (i === Number(fu[2]) ? d.body : x)) });
    else if (fu?.[1] === 'email') set('followups', { emailList: settings.followups.emailList.map((x, i) => (i === Number(fu[2]) ? { subject: d.subject, body: d.body } : x)) });
  };
  const saveDraft = (t: string, d: LightboxDraft, photo: string | null) => {
    writeDraft(t, d, photo);
    setLightbox(null);
    onToast('Saved');
  };
  /** One change to a message's subject, words and HTML alike, straight from a check. */
  const editDraft = (t: string, f: (s: string) => string, fHtml = f) => {
    const d = draftOf(t);
    if (d) writeDraft(t, { subject: f(d.subject), body: f(d.body), html: d.html ? fHtml(d.html) : null });
  };
  /** Merge fields out of a message, and any email link that pointed at one. */
  const dropFields = (t: string, names: string[]) => editDraft(t, (s) => names.reduce(dropToken, s), (h) => names.reduce(dropTokenHtml, h));
  const lightboxTitle = (t: string) => {
    const fu = /^fu-(sms|email)-(\d+)$/.exec(t);
    if (t === 'intro') return settings.intro.mode === 'ai' ? 'Intro template, when the AI does not write' : 'Intro text';
    if (t === 'brief-sms') return 'Deal brief by text';
    if (t === 'brief-email') return 'Deal brief by email';
    if (fu) return `Follow-up ${fu[1] === 'sms' ? 'text' : 'email'} ${(fu[1] === 'sms' ? fuSmsAt : fuEmailAt).findIndex((x) => x.i === Number(fu[2])) + 1 || Number(fu[2]) + 1}`;
    return 'Message';
  };
  /** What the sample buyer gets from a draft, with the photo the editor has picked. */
  const renderDraft = (t: string) => (d: LightboxDraft, photo: string | null) => {
    const f = photo ? { ...pFields, photo_url: photo } : pFields;
    if (t === 'intro') return { subject: '', text: renderMerge(chooseIntro(d.body, f).body, f), html: null };
    if (t === 'brief-sms' || t.startsWith('fu-sms-')) return { subject: '', text: renderMerge(d.body, f), html: null };
    const e = renderEmail({ subject: d.subject, body_html: d.html, body_text: d.body }, f);
    return { subject: e.subject, text: e.text, html: e.html };
  };
  const openEdit = (target: string) => {
    if (target.startsWith('lb:')) setLightbox(target.slice(3));
    else editAt(target);
  };

  // ---------------------------------------------------------------- checks
  type Issue = { level: 'block' | 'warn' | 'info'; text: React.ReactNode; stage: 0 | 1 | 2; fix?: () => void; edit?: string; actions?: { label: string; run: () => void }[] };
  const issues: Issue[] = [];
  if (!audience.length) issues.push({ level: 'block', stage: 0, text: 'Nobody is in this campaign. Lower the minimum score, clear a filter, or tick buyers by hand.' });
  else if (!plan.recipients.length && !settings.brief.rvm && !aiBusy) issues.push({ level: 'block', stage: 0, text: `Every buyer in the audience is skipped (${sum.skipped.map(([k, v]) => `${v} ${k}`).join(', ')}), so nobody would get a message.` });
  if (settings.intro.mode === 'none' && !settings.brief.sms && !settings.brief.email && !settings.brief.rvm) issues.push({ level: 'block', stage: 1, text: 'Nothing to send: the intro, the text brief, the email and the ringless voicemail are all off.' });
  if (settings.brief.sms && !settings.brief.smsBody.trim()) issues.push({ level: 'block', stage: 1, text: 'The text brief is empty.' });
  if (settings.brief.rvm && !settings.brief.rvmBody?.trim() && !settings.brief.rvmRecording) issues.push({ level: 'block', stage: 1, text: 'The ringless voicemail has no recording and no script. Pick a saved recording, record one, or write the script.' });
  if (realtorsOn && realtorsErr) issues.push({ level: 'warn', stage: 0, text: realtorsErr });
  if (settings.brief.email && !settings.brief.emailSubject.trim()) issues.push({ level: 'block', stage: 1, text: 'The email has no subject.' });
  if (settings.brief.email && !settings.brief.emailBody.trim() && !settings.brief.emailHtml) issues.push({ level: 'block', stage: 1, text: 'The email is empty.' });
  const longSms = pRec?.messages.find((m) => m.channel === 'sms' && m.body.length > 1600);
  if (longSms) issues.push({ level: 'block', stage: 1, text: `A text is ${longSms.body.length.toLocaleString('en-US')} characters, over Talkr's 1,600 limit. Shorten the ${longSms.kind === 'brief' ? 'text brief' : longSms.kind}.` });
  // Merge fields, checked one message at a time so each warning names the message and the field, with the fix beside it.
  const knownFields = { ...pFields, listing_url: 'x', deal_link: 'x' };
  const checkMerge = (text: string) => {
    const m = mergeCheck(text, knownFields, fields);
    return { ...m, near: Object.fromEntries(m.unknown.map((u) => [u, closestField(u, Object.keys(knownFields))])) };
  };
  const msgTargets = [
    settings.intro.mode !== 'none' && 'intro', settings.brief.sms && 'brief-sms', settings.brief.email && 'brief-email',
    ...fuSmsAt.map(({ i }) => `fu-sms-${i}`), ...fuEmailAt.map(({ i }) => `fu-email-${i}`),
  ].filter((t): t is string => !!t);
  for (const t of msgTargets) {
    const d = draftOf(t);
    if (!d) continue;
    const m = checkMerge(`${d.subject}\n${d.html ?? d.body}`);
    const name = lightboxTitle(t);
    for (const u of m.unknown) {
      const near = m.near[u];
      issues.push({
        level: 'warn', stage: 1, edit: t,
        text: <><b>{name}</b>: {`{{${u}}}`} is not a merge field, so it goes out exactly as typed.{near ? <> Did you mean {`{{${near}}}`} ({FIELD_LABEL[near] ?? near})?</> : null}</>,
        actions: near ? [{ label: `Use {{${near}}}`, run: () => { editDraft(t, (s) => swapToken(s, u, near)); onToast(`${name}: {{${near}}} in place`); } }]
          : [{ label: 'Take it out', run: () => { dropFields(t, [u]); onToast(`${name}: {{${u}}} taken out`); } }],
      });
    }
    if (m.blank.length) {
      const labels = m.blank.map((b) => FIELD_LABEL[b] ?? b);
      issues.push({
        level: 'warn', stage: 1, edit: t,
        text: (
          <>
            <b>{name}</b>: this deal has nothing on file for {m.blank.map((b) => `{{${b}}}`).join(', ')}, so {m.blank.length === 1 ? 'it goes' : 'they go'} out blank. Fill in below for this campaign, or take {m.blank.length === 1 ? 'it' : 'them'} out.
            {m.blank.map((b) => <FillField key={b} label={FIELD_LABEL[b] ?? b} onUse={(v) => { setFill((x) => ({ ...x, [b]: v })); onToast(`${FIELD_LABEL[b] ?? b} filled in for this campaign`); }} />)}
          </>
        ),
        actions: [{ label: m.blank.length === 1 ? 'Take it out' : 'Take them out', run: () => { dropFields(t, m.blank); onToast(`${name}: ${labels.join(', ')} taken out`); } }],
      });
    }
  }
  if (emailCount && resend && !useResend && !account) issues.push({ level: 'block', stage: 2, text: 'Email needs a sender. Resend is not set up, so pick a connected Gmail account under Sending from, or turn email off.' });
  const room = useResend ? poolRoom(blastPool) : null;
  if (emailCount && useResend && room && room.count === 0) issues.push({ level: 'warn', stage: 2, text: 'Every blast address for you is paused. Emails queue until one is resumed in Settings → Outbound OS.' });
  if (room && room.count && sum.emails && sum.emails > room.left) issues.push({ level: 'warn', stage: 2, text: `Your ${room.count} blast ${room.count === 1 ? 'address' : 'addresses'} can send ${room.left.toLocaleString('en-US')} more today (50 a day while warming, 100 once warm). The rest wait until one of your addresses has room.` });
  if (spam && spam.level !== 'low') issues.push({ level: 'warn', stage: 1, text: `Spam risk is ${spam.level}: ${spam.findings.slice(0, 3).map((f) => f.label.toLowerCase()).join(', ')}.` });
  if (settings.variations.useImage && !data.photos.length) issues.push({ level: 'warn', stage: 1, text: 'Attach a photo is on, but this deal has no photo links. Add one on the Files tab.' });
  for (const r of carrierReviews) {
    const blocks = r.check.findings.filter((f) => f.severity === 'block');
    const shown = (blocks.length ? blocks : r.check.findings).slice(0, 2);
    const more = r.check.findings.length - shown.length;
    issues.push({
      level: blocks.length ? 'block' : 'warn', stage: 1, edit: r.target, fix: r.suggestion ? () => fixMessage(r) : undefined,
      text: <>{r.label}: {shown.map(findingLine).join(' ')}{more > 0 ? ` ${plural(more, 'more finding')}.` : ''}</>,
    });
  }
  if (outside) issues.push({ level: 'info', stage: 1, text: `It is outside ${WINDOW.start} AM–${WINDOW.end - 12} PM ${zone}, so the first messages wait until the window opens (${whenLabel(firstSend ?? null, tz, now)}).` });
  const blocking = issues.filter((i) => i.level === 'block');

  const talkrLoading = stage === 2 && !demo && !talkrMe && !talkrErr && smsCount > 0;
  const whyNot = launching ? null
    : !canWrite ? 'A dispositions role is needed to launch.'
      : aiBusy ? `The AI is writing messages · ${aiBusy.split(':')[1]}`
        : aiPending ? `${plural(aiPending, 'AI message')} still to write`
          : talkrLoading ? 'Checking your Talkr number…'
            : blocking[0] ? blocking[0].text : null;
  const sentence = launchSentence(sum, tz, now);

  // ---------------------------------------------------------------- pieces
  const setTone = (tone: string) => {
    set('intro', { tone });
    setToneSwapped(true);
    // Rewriting a sample is free on sample data; on a workspace it is a paid model call, so it waits for the rep.
    if (demo && sampleTone) void runAi(Array.from(new Set([...previewRows, ...(pRow && pGetsAi ? [pRow] : [])])), 'intro', { ...aiOpts, tone });
  };
  const insert = (token: string) => {
    const el = document.getElementById('mk-sms-body') as HTMLTextAreaElement | null;
    const body = settings.brief.smsBody;
    const at = el ? el.selectionStart ?? body.length : body.length;
    const end = el ? el.selectionEnd ?? at : at;
    const text = `{{${token}}}`;
    set('brief', { smsBody: body.slice(0, at) + text + body.slice(end) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };

  /** Buyers a Genius pull just added or traced: read again (new phones and emails included) and ticked into the audience. */
  const importBuyers = async (ids: number[]) => {
    const fresh = await loadCampaignBuyersByIds(workspaceId, ids);
    const got = new Set(fresh.map((b) => b.id));
    forgetCampaignData(dealId);
    setData((d) => (d ? { ...d, buyers: [...d.buyers.filter((b) => !got.has(b.id)), ...fresh] } : d));
    setInclude((x) => ({ ...x, ...Object.fromEntries(ids.map((id) => [id, true])) }));
    onToast(`${plural(ids.length, 'buyer')} from Genius in this campaign`);
  };

  const audienceBody = () => {
    const src = (list === 'matched' ? view.matched : view.others)
      .filter((r) => !q || (r.b.name + ' ' + (r.b.company ?? '') + ' ' + r.b.tags.join(' ') + ' ' + r.b.markets.join(' ')).toLowerCase().includes(q.toLowerCase()));
    const shown = showAll ? src : src.slice(0, 60);
    const inA = new Set(audience.map((r) => r.b.id));
    const activeFilters = [filters.minScore !== DEFAULT_FILTERS.minScore && `score ≥ ${filters.minScore}`, filters.radiusMi && `${filters.radiusMi} mi`, filters.city, filters.zip, filters.priceBandPct && `±${filters.priceBandPct}%`,
      filters.strategy && STRATEGIES.find(([k]) => k === filters.strategy)?.[1], filters.vipOnly && 'VIP only', !filters.excludeSent && 'including already sent', ...filters.excludeTags.map((t) => `not ${t}`)].filter(Boolean) as string[];
    return (
      <div style={{ display: 'grid', gap: '14px' }}>
        <div className="mk-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' }}>
            <div>
              <Eyebrow>In this campaign</Eyebrow>
              <div className="mk-num" style={{ fontSize: '30px', fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1.1, marginTop: '4px' }} data-testid="audience-count">{audience.length.toLocaleString('en-US')} <span style={{ fontSize: '14px', fontWeight: 500, letterSpacing: 0, color: C.muted2 }}>{realtorRows.length ? 'buyers and realtors' : 'buyers'}</span></div>
              <div style={{ fontSize: '12.5px', color: C.muted2, marginTop: '2px' }}>from {plural(view.matched.length, 'matched buyer')} scoring {filters.minScore}+{view.byHand ? ` · ${view.byHand} set by hand` : ''}</div>
            </div>
            <div style={{ flex: 1 }} />
            {audience.length && (onQueue || onAgent) ? (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {onQueue ? <Btn size="sm" onClick={() => void onQueue(audience.map((r) => r.b.id))}>Add to call queue</Btn> : null}
                {onAgent ? <Btn size="sm" onClick={() => void onAgent(audience.map((r) => r.b.id))}>AI agent</Btn> : null}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: '18px', fontSize: '12.5px' }}>
              <span><b className="mk-num">{smsCount}</b> <span style={{ color: C.muted2 }}>by text</span></span>
              <span><b className="mk-num">{emailCount}</b> <span style={{ color: C.muted2 }}>by email</span></span>
              {settings.brief.rvm ? <span><b className="mk-num">{audience.filter((r) => r.b.phone && !r.b.blacklisted).length}</b> <span style={{ color: C.muted2 }}>by RVM</span></span> : null}
            </div>
          </div>
          {view.filtered.length || sum.skippedTotal ? (
            <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${C.line2}`, display: 'grid', gap: '6px' }}>
              <Eyebrow>Left out</Eyebrow>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }} data-testid="left-out">
                {view.filtered.map(([why, n]) => <span key={why} style={pill}><b className="mk-num">{n}</b> {why}</span>)}
                {sum.skipped.map(([why, n]) => <span key={why} style={{ ...pill, background: C.redSoft, color: 'var(--tx-red-deep, #991b1b)' }} title="In the audience, but nothing can be sent to them"><b className="mk-num">{n}</b> {why}</span>)}
              </div>
            </div>
          ) : null}
        </div>

        <GeniusImport workspaceId={workspaceId} dealId={dealId} address={data.deal.address || null} userId={me} canWrite={canWrite} demo={!!demo} onImported={importBuyers} />

        {realtorCard()}

        <div className="mk-card" style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 14px', borderBottom: `1px solid ${C.line2}`, flexWrap: 'wrap' }}>
            <div role="tablist" aria-label="Buyer list" style={{ display: 'flex' }}>
              {(['matched', 'others'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={list === k} className="mk-tab" onClick={() => { setList(k); setShowAll(false); }}>
                  {k === 'matched' ? 'Matched' : 'Other buyers'} <span className="mk-num" style={{ color: C.muted2, fontWeight: 500 }}>{(k === 'matched' ? view.matched : view.others).length}</span>
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, tag or market" aria-label="Search buyers" className="mk-field" style={{ width: isMobile ? '100%' : '240px', margin: '8px 0' }} />
          </div>
          <div className="mk-list">
            {shown.length ? null : <div style={{ padding: '18px 14px', fontSize: '12.5px', color: C.muted2 }}>{q ? `No buyer matches "${q}".` : list === 'matched' ? `No buyers score ${filters.minScore} or more for this deal.` : 'No other buyers on this workspace.'}</div>}
            {shown.map((r) => {
              const out = filteredOut(r, filters, data.deal.price);
              const on = inA.has(r.b.id);
              return (
                <div key={r.b.id} className="mk-row" style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto', gap: '10px', alignItems: 'start', padding: '9px 14px', borderBottom: `1px solid ${C.line2}`, fontSize: '12.5px' }}>
                  <label style={{ display: 'contents', cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={(e) => setInclude((x) => ({ ...x, [r.b.id]: e.target.checked }))} style={{ accentColor: 'var(--c-primary)', marginTop: '2px' }} aria-label={`Include ${r.b.name}`} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0 }}>
                        <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.b.company || r.b.name}</b>
                        {r.b.company ? <span style={{ color: C.muted2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.b.name}</span> : null}
                      </span>
                      <span style={{ display: 'block', color: C.muted2, fontSize: '11.5px', marginTop: '1px' }}>
                        L{r.level} {r.levelLabel} · {(r.match?.reasons ?? []).slice(0, 2).join(' · ') || 'not matched'}
                        {!r.b.phone ? <span style={{ color: C.amber }}> · no phone</span> : null}{!r.b.email ? <span style={{ color: C.amber }}> · no email</span> : null}
                        {out && list === 'matched' ? <span style={{ color: 'var(--tx-amber-deep, #92400e)' }}> · left out: {out}</span> : null}
                      </span>
                    </span>
                  </label>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span className="mk-num" style={{ fontWeight: 700, color: scoreOf(r) >= 80 ? C.green : C.muted2 }}>{r.match ? scoreOf(r) : '—'}</span>
                    {onQueue ? <Btn size="sm" onClick={() => void onQueue([r.b.id])}>Add to call queue</Btn> : null}
                    {onAgent ? <Btn size="sm" onClick={() => void onAgent([r.b.id])}>AI agent</Btn> : null}
                  </span>
                </div>
              );
            })}
            {src.length > shown.length ? <div style={{ padding: '10px 14px' }}><Btn size="sm" onClick={() => setShowAll(true)}>Show {src.length - shown.length} more</Btn></div> : null}
          </div>
        </div>

        <div className="mk-card" style={{ padding: '12px 16px' }}>
          <Disclosure title="Filters" summary={activeFilters.length ? activeFilters.join(' · ') : 'Score 55+, not sent this deal'} open={!!open.filters} onToggle={() => toggle('filters')} testId="filters">
            <div style={{ display: 'grid', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
                <Field label="Min score"><input type="number" min={0} max={100} value={filters.minScore} onChange={(e) => setFilters({ ...filters, minScore: Number(e.target.value) || 0 })} className="mk-field" /></Field>
                <Field label="Radius (mi)" hint="From their last purchase on file; buyers with no located purchase are left out"><input type="number" min={0} value={filters.radiusMi} onChange={(e) => setFilters({ ...filters, radiusMi: e.target.value })} className="mk-field" /></Field>
                <Field label="City"><input value={filters.city} onChange={(e) => setFilters({ ...filters, city: e.target.value })} className="mk-field" /></Field>
                <Field label="Zip"><input value={filters.zip} onChange={(e) => setFilters({ ...filters, zip: e.target.value })} className="mk-field" /></Field>
                <Field label="Price band ± %" hint={data.deal.price ? `Deal price ${data.deal.price.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}` : 'No price on the deal'}>
                  <input type="number" min={0} value={filters.priceBandPct} disabled={!data.deal.price} onChange={(e) => setFilters({ ...filters, priceBandPct: e.target.value })} className="mk-field" />
                </Field>
                <Field label="Strategy"><select value={filters.strategy} onChange={(e) => setFilters({ ...filters, strategy: e.target.value })} className="mk-field"><option value="">Any</option>{STRATEGIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              </div>
              <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
                <Switch on={filters.vipOnly} set={(v) => setFilters({ ...filters, vipOnly: v })}>VIP only</Switch>
                <Switch on={filters.excludeSent} set={(v) => setFilters({ ...filters, excludeSent: v })}>Leave out buyers already sent this deal</Switch>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '12.5px' }}>Leave out tags</span>
                {filters.excludeTags.map((t) => <Btn key={t} size="sm" onClick={() => setFilters({ ...filters, excludeTags: filters.excludeTags.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>{t} ×</Btn>)}
                <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tagDraft.trim()) { setFilters({ ...filters, excludeTags: [...filters.excludeTags, tagDraft.trim()] }); setTagDraft(''); } }} placeholder="tag, then Enter" list="campaign-tags" className="mk-field" style={{ width: '150px' }} />
                <datalist id="campaign-tags">{Array.from(new Set(data.buyers.flatMap((b) => b.tags))).filter((t) => t.trim().toLowerCase() !== 'secret-blacklist').map((t) => <option key={t} value={t} />)}</datalist>
              </div>
              <div style={{ fontSize: '12px', color: C.muted2 }}>Filters apply to the matched list. A buyer ticked or unticked by hand stays that way.</div>
            </div>
          </Disclosure>
        </div>
      </div>
    );
  };

  const realtorCard = () => {
    const city = data.deal.city || 'this market';
    const pool = realtorRows;
    const shown = realtorsAll ? pool : pool.slice(0, 40);
    const inA = new Set(audience.map((r) => r.b.id));
    return (
      <div className="mk-card" id="mk-sec-realtors" style={{ padding: '12px 16px', display: 'grid', gap: '10px', scrollMarginTop: '12px' }} data-testid="realtor-segment">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13.5px', fontWeight: 650 }}>Realtors</div>
            <div style={{ fontSize: '12px', color: C.muted, marginTop: '2px' }}>Also send this deal to agents who work {city}, for their investor clients. From Buyers › Realtors and the free-agent list.</div>
          </div>
          <Switch on={realtorsOn} set={(v) => void toggleRealtors(v)}><span style={srOnly}>Market this deal to realtors</span></Switch>
        </div>
        {!realtorsOn ? null
          : realtorsBusy ? <span role="status" style={{ fontSize: '12px', color: C.muted }}>Finding realtors who work {city}…</span>
            : realtorsErr ? <Note level="block" action={<Btn size="sm" onClick={() => { setRealtorsErr(null); void toggleRealtors(true); }}>Try again</Btn>}>{realtorsErr}</Note>
              : !pool.length ? <span style={{ fontSize: '12px', color: C.muted }}>No realtor on file works {city}. Tag agents <b>realtors</b> with {city} as a market to reach them here.</span>
                : (
                  <>
                    <div className="mk-num" style={{ fontSize: '12.5px' }} role="status">
                      <b>{pool.filter((r) => inA.has(r.b.id)).length.toLocaleString('en-US')}</b> of {plural(pool.length, 'realtor')} in {city} are in this push
                      {realtorPool?.capped ? <span style={{ color: C.muted }}> · the first {REALTOR_CAP.toLocaleString('en-US')} of {realtorPool.corpusTotal.toLocaleString('en-US')} free agents searched</span> : null}
                    </div>
                    <div className="mk-list" style={{ maxHeight: '240px', borderTop: `1px solid ${C.line2}` }}>
                      {shown.map((r) => (
                        <label key={r.b.id} className="mk-row" style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: '10px', alignItems: 'start', padding: '7px 0', borderBottom: `1px solid ${C.line2}`, cursor: 'pointer', fontSize: '12.5px' }}>
                          <input type="checkbox" checked={inA.has(r.b.id)} onChange={(e) => setInclude((x) => ({ ...x, [r.b.id]: e.target.checked }))} style={{ accentColor: 'var(--c-primary)', marginTop: '2px' }} aria-label={`Include ${r.b.name}`} />
                          <span style={{ minWidth: 0 }}>
                            <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.b.name}>{r.b.name}{r.b.company ? <span style={{ fontWeight: 400, color: C.muted }}> · {r.b.company}</span> : null}</b>
                            <span style={{ display: 'block', fontSize: '11.5px', color: C.muted }}>
                              {r.b.markets.slice(0, 2).join(' · ') || city}
                              {!r.b.phone ? <span style={{ color: C.amber }}> · no phone</span> : null}{!r.b.email ? <span style={{ color: C.amber }}> · no email</span> : null}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {pool.length > shown.length ? <div><Btn size="sm" onClick={() => setRealtorsAll(true)}>Show {pool.length - shown.length} more</Btn></div> : null}
                  </>
                )}
      </div>
    );
  };

  const messageBody = () => (
    <div style={{ display: 'grid', gap: '14px' }}>
      <Section id="mk-sec-intro" title="Intro text" hint="A short first text before the deal. Email-only buyers skip it.">
        <Choice label="Intro" value={settings.intro.mode} options={['ai', 'own', 'none'] as const} labels={{ ai: 'AI writes each one', own: 'Use my template', none: 'No intro' }} onChange={(v) => set('intro', { mode: v })} />
        {settings.intro.mode === 'ai' ? (
          <div style={{ display: 'grid', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: C.muted }}>Tone</span>
            <Choice label="Tone" value={settings.intro.tone} options={TONES} onChange={setTone} />
            <span style={{ fontSize: '11.5px', color: C.muted2, lineHeight: 1.45 }}>Written from real facts only: first name, their last purchase on file and how far it is from this deal. A message with a number not on file is thrown out.</span>
          </div>
        ) : null}
        {settings.intro.mode === 'own' ? introTemplate() : null}
      </Section>

      <Section id="mk-sec-sms" title="Deal brief by text" right={<Switch on={settings.brief.sms} set={(v) => set('brief', { sms: v })}><span className="sr-only" style={srOnly}>Send a text brief</span></Switch>}>
        {settings.brief.sms ? (
          <>
            <textarea id="mk-sms-body" rows={rowsFor(settings.brief.smsBody, isMobile ? 40 : 76)} value={settings.brief.smsBody} onChange={(e) => set('brief', { smsBody: e.target.value })} className="mk-area mk-lb-words" aria-label="Text brief" data-testid="sms-body" style={{ resize: 'none', fieldSizing: 'content' } as React.CSSProperties} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
              <span style={{ fontSize: '11.5px', color: C.muted2, marginRight: '2px' }}>Insert</span>
              {INSERT.map((t) => <button key={t} type="button" className="mk-chip mk-press" style={{ height: '24px', fontSize: '11px', padding: '0 7px' }} onClick={() => insert(t)}>{FIELD_LABEL[t] ?? t}</button>)}
            </div>
            <EditBar onEdit={() => setLightbox('brief-sms')} label="the text brief" review={carrierReviews.find((r) => r.target === 'brief-sms')} />
          </>
        ) : <Off>No text brief. Buyers still get the intro{settings.brief.email ? ' and the email' : ''}.</Off>}
      </Section>

      <Section id="mk-sec-email" title="Deal brief by email" right={<Switch on={settings.brief.email} set={(v) => set('brief', { email: v })}><span style={srOnly}>Send an email brief</span></Switch>}>
        {settings.brief.email ? (
          <>
            <Field label="Subject"><input value={settings.brief.emailSubject} onChange={(e) => set('brief', { emailSubject: e.target.value })} className="mk-field" data-testid="email-subject" style={{ height: '36px', fontSize: '13.5px' }} /></Field>
            <Field label="Template">
              <select value={emailTemplateId} onChange={(e) => {
                const t = data.templates.find((x) => String(x.id) === e.target.value);
                setEmailTemplateId(e.target.value);
                set('brief', t ? { emailSubject: t.subject ?? EMAIL_SUBJECT, emailBody: t.body_text, emailHtml: t.body_html ?? null } : { emailSubject: EMAIL_SUBJECT, emailBody: EMAIL_BRIEF, emailHtml: null });
              }} className="mk-field" style={{ maxWidth: '100%' }}>
                <option value="">Plain text</option>
                {emailChoices(data.templates).map((t) => <option key={t.id} value={t.id}>{t.name}{t.body_html ? ' · designed' : ''}</option>)}
              </select>
            </Field>
            {(() => {
              const e = renderDraft('brief-email')({ subject: settings.brief.emailSubject, body: settings.brief.emailBody, html: settings.brief.emailHtml }, fields.photo_url || null);
              return e.html ? (
                <div className="mk-msg-open" onClick={() => setLightbox('brief-email')} data-testid="email-card" style={{ cursor: 'pointer' }}>
                  <div style={{ padding: '8px', pointerEvents: 'none' }}><Scaled html={e.html} /></div>
                </div>
              ) : (
                <textarea rows={rowsFor(settings.brief.emailBody, isMobile ? 40 : 84)} value={settings.brief.emailBody} onChange={(ev) => { set('brief', { emailBody: ev.target.value, emailHtml: null }); setEmailTemplateId(''); }}
                  className="mk-area mk-lb-words" aria-label="Email body" style={{ resize: 'none', fieldSizing: 'content' } as React.CSSProperties} />
              );
            })()}
            <EditBar onEdit={() => setLightbox('brief-email')} label="the email" extra={settings.brief.emailHtml ? 'Words, HTML and the main photo' : 'Words and subject'} review={carrierReviews.find((r) => r.target === 'brief-email')} />
          </>
        ) : <Off>No email. Buyers with no textable number get nothing but follow-ups.</Off>}
      </Section>

      <Section id="mk-sec-rvm" title="Ringless voicemail" hint="Drops in the mailbox without ringing. Caller IDs rotate across your numbers. No daily cap." right={<Switch on={!!settings.brief.rvm} set={(v) => set('brief', { rvm: v })}><span style={srOnly}>Send a ringless voicemail</span></Switch>}>
        {settings.brief.rvm ? (
          <>
            {!demo && savedClips.length ? (
              <Field label="Use a saved recording">
                <select className="mk-field" aria-label="Saved recording" data-testid="rvm-saved" disabled={!canWrite}
                  value={settings.brief.rvmRecording && !ownTake(settings.brief.rvmRecording) ? String(settings.brief.rvmRecording.libraryId) : ''}
                  onChange={(e) => { if (e.target.value) void pickSaved(e.target.value); else removeRecording(); }}>
                  <option value="">{settings.brief.rvmRecording && ownTake(settings.brief.rvmRecording) ? 'Recorded for this push (below)' : 'None, record one below'}</option>
                  {savedClips.map((c) => <option key={c.id} value={String(c.id)}>{c.name}{c.seconds ? ` · ${clipClock(c.seconds)}` : ''}</option>)}
                </select>
              </Field>
            ) : null}
            <RvmRecorder attached={settings.brief.rvmRecording ? { seconds: settings.brief.rvmRecording.seconds, url: recUrl } : null}
              onUse={attachRecording} onRemove={removeRecording} disabled={!canWrite && !demo} />
            <Field label={settings.brief.rvmRecording ? 'Script, the written record of the recording' : 'Script, read aloud by the carrier when there is no recording'}>
              <textarea rows={4} value={settings.brief.rvmBody ?? ''} onChange={(e) => set('brief', { rvmBody: e.target.value })} className="mk-area" aria-label="Ringless voicemail script" />
            </Field>
          </>
        ) : <Off>No ringless voicemail. Text and email stay as they are.</Off>}
      </Section>

      <Section id="mk-sec-followups" title="Follow-ups" hint="Only to buyers who have not replied, offered or opted out. A reply stops them at once.">
        <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
          <Switch on={settings.followups.sms} set={(v) => set('followups', { sms: v })}>Follow up by text</Switch>
          <Switch on={settings.followups.email} set={(v) => set('followups', { email: v })}>Follow up by email</Switch>
        </div>
        <div style={{ fontSize: '12.5px', color: C.ink2 }} data-testid="cadence">{cadenceLabel(settings)}</div>
      </Section>

      <Section title="When">
        <Choice label="Start" value={settings.startAt ? 'later' : 'now'} options={['now', 'later'] as const} labels={{ now: 'As soon as the window allows', later: 'Pick a start time' }}
          onChange={(v) => setSettings((s) => ({ ...s, startAt: v === 'now' ? '' : new Date(Math.max(Date.now(), now.getTime()) + 3600_000).toISOString() }))} />
        <Switch on={!!settings.vipFirst?.on} set={(v) => setSettings((s) => ({ ...s, vipFirst: { on: v, hours: s.vipFirst?.hours ?? 24 } }))}
          hint={`${firstLook.toLocaleString('en-US')} of ${audience.length.toLocaleString('en-US')} on this list are VIP or A-list (offered on or closed a deal with us). Everyone else starts ${settings.vipFirst?.hours ?? 24} hours later.`}>
          VIP and A-list buyers get the first {settings.vipFirst?.hours ?? 24} hours
        </Switch>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {settings.startAt ? <Field label="Start"><input type="datetime-local" value={toLocalInput(settings.startAt)} onChange={(e) => setSettings((s) => ({ ...s, startAt: e.target.value ? new Date(e.target.value).toISOString() : '' }))} className="mk-field" /></Field> : null}
          <Field label="Time zone (team)" hint="Buyers have no time zone on file, so the team time zone is used for everyone.">
            <select value={settings.timezone} onChange={(e) => setSettings((s) => ({ ...s, timezone: e.target.value }))} className="mk-field">
              {Array.from(new Set([browserTz(), ...TZS, settings.timezone])).map((z) => <option key={z} value={z}>{tzLabel(z)} · {z.split('/').pop()?.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ fontSize: '12px', color: C.muted2 }}>Sends only between {WINDOW.start} AM and {WINDOW.end - 12} PM {zone}, within Talkr&apos;s quiet hours and number caps and the mailbox&apos;s daily cap.</div>
      </Section>

      <div className="mk-card" id="mk-sec-advanced" style={{ padding: '12px 16px', scrollMarginTop: '12px' }}>
        <Disclosure title="Advanced options" summary="Variations, splitting, templates, timing, follow-up rules" open={!!open.advanced} onToggle={() => toggle('advanced')} testId="advanced">
          <div style={{ display: 'grid', gap: '18px' }}>
            {settings.intro.mode === 'ai' ? (
              <Group title="How the AI writes">
                <Row label="Split an intro into two texts"><Choice label="Split" value={settings.intro.split} options={FREQ} onChange={(v) => set('intro', { split: v })} /></Row>
                <Row label="Emoji"><Choice label="Emoji" value={settings.intro.emoji} options={FREQ} onChange={(v) => set('intro', { emoji: v })} /></Row>
                <Row label="Writing instructions"><textarea rows={2} value={settings.intro.instructions} onChange={(e) => set('intro', { instructions: e.target.value })} placeholder="e.g. keep it under two sentences, sign off with my first name" className="mk-area" /></Row>
                <Row label="Words to avoid">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {settings.intro.avoid.map((w) => <Btn key={w} size="sm" onClick={() => set('intro', { avoid: settings.intro.avoid.filter((x) => x !== w) })} aria-label={`Remove ${w}`}>{w} ×</Btn>)}
                    <input value={avoidDraft} onChange={(e) => setAvoidDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && avoidDraft.trim()) { set('intro', { avoid: [...settings.intro.avoid, avoidDraft.trim()] }); setAvoidDraft(''); } }} placeholder="word, then Enter" className="mk-field" style={{ width: '150px' }} />
                  </div>
                </Row>
                <Row label="Individually written for">
                  <Choice label="Reserve AI for" value={String(settings.variations.reserveLevel)} options={['0', '2', '3', '4', '5'] as const} labels={{ '0': 'Everyone', '2': 'L2+', '3': 'L3+', '4': 'L4+', '5': 'L5' }} onChange={(v) => set('variations', { reserveLevel: Number(v) })} />
                  <span style={{ fontSize: '11.5px', color: C.muted2 }}>Everyone below gets the template. L1 New · L2 sent a deal · L3 replied · L4 made an offer · L5 closed with us (VIP +1).</span>
                </Row>
                <Row label="Template when the AI does not write">{introTemplate()}</Row>
              </Group>
            ) : null}
            <Group title="Variations">
              <Row label="Property photo">
                <Switch on={settings.variations.useImage} set={(v) => set('variations', { useImage: v })}>Attach a photo to the first intro text (MMS)</Switch>
                {settings.variations.useImage ? (data.photos.length ? (
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {data.photos.map((p) => (
                      <button key={p.id} type="button" className="mk-press" aria-pressed={settings.variations.imageUrl === p.url} onClick={() => set('variations', { imageUrl: p.url })} title={p.name}
                        style={{ width: '84px', height: '60px', borderRadius: '8px', border: `2px solid ${settings.variations.imageUrl === p.url ? 'var(--c-primary)' : C.line}`, background: `var(--surface-2, #f4f4f5) url(${JSON.stringify(p.url)}) center/cover no-repeat`, cursor: 'pointer', transition: 'transform 160ms ease-out' }} />
                    ))}
                  </div>
                ) : <span style={{ fontSize: '12px', color: C.muted2 }}>This deal has no photo links yet: add an https photo link on the Files tab.</span>) : null}
              </Row>
              <Row label="Send pace">
                <Choice label="Send pace" value={settings.variations.frequency} options={['sometimes', 'frequently'] as const} labels={{ sometimes: 'Steady · a buyer every 1.5–3.5 min', frequently: 'Fast · every 30–60 s' }} onChange={(v) => set('variations', { frequency: v })} />
              </Row>
            </Group>
            <Group title="Deal brief order">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', fontSize: '12.5px' }}>
                <Choice label="Brief order" value={settings.brief.order} options={['sms', 'email'] as const} labels={{ sms: 'Text first', email: 'Email first' }} onChange={(v) => set('brief', { order: v })} />
                <span>then wait</span>
                <input type="number" min={0} value={settings.brief.wait} onChange={(e) => set('brief', { wait: Number(e.target.value) || 0 })} className="mk-field" style={{ width: '64px' }} aria-label="Wait" />
                <select value={settings.brief.waitUnit} onChange={(e) => set('brief', { waitUnit: e.target.value as 'minutes' | 'hours' })} className="mk-field" aria-label="Wait unit"><option>minutes</option><option>hours</option></select>
                <span>before the other.</span>
              </div>
            </Group>
            <Group title="Follow-up timing and rules">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', fontSize: '12.5px' }}>
                <span>After</span>
                <input type="number" min={0} value={settings.followups.after} onChange={(e) => set('followups', { after: Number(e.target.value) || 0 })} className="mk-field" style={{ width: '60px' }} aria-label="After" />
                <select value={settings.followups.afterUnit} onChange={(e) => set('followups', { afterUnit: e.target.value as 'minutes' | 'hours' })} className="mk-field" aria-label="After unit"><option>minutes</option><option>hours</option></select>
                <span>with no reply,</span>
                <Choice label="Follow-up order" value={settings.followups.order} options={['sms', 'email'] as const} labels={{ sms: 'text first', email: 'email first' }} onChange={(v) => set('followups', { order: v })} />
                <span>then wait</span>
                <input type="number" min={0} value={settings.followups.wait} onChange={(e) => set('followups', { wait: Number(e.target.value) || 0 })} className="mk-field" style={{ width: '60px' }} aria-label="Then wait" />
                <select value={settings.followups.waitUnit} onChange={(e) => set('followups', { waitUnit: e.target.value as 'minutes' | 'hours' })} className="mk-field" aria-label="Then wait unit"><option>minutes</option><option>hours</option></select>
                <span>before the other.</span>
              </div>
              <Switch on={settings.followups.smart} set={(v) => set('followups', { smart: v })}>Smart timing: send at the hour (and day, with enough history) each buyer has replied most; the fixed delay when there are fewer than three replies</Switch>
              <Switch on={settings.followups.pauseUnengaged} set={(v) => set('followups', { pauseUnengaged: v })}>
                Skip follow-ups for buyers who answered none of the last
                <input type="number" min={1} max={20} value={settings.followups.unengagedN} onChange={(e) => set('followups', { unengagedN: Math.max(1, Number(e.target.value) || 1) })} onClick={(e) => e.preventDefault()} className="mk-field" style={{ width: '52px', height: '26px', margin: '0 6px' }} aria-label="Deals" />
                deals sent
              </Switch>
            </Group>
            {(['sms', 'email'] as const).map((ch) => {
              const on = ch === 'sms' ? settings.followups.sms : settings.followups.email;
              if (!on) return null;
              const aiOn = ch === 'sms' ? settings.followups.smsAi : settings.followups.emailAi;
              const items = ch === 'sms' ? settings.followups.smsList.map((b) => ({ subject: '', body: b })) : settings.followups.emailList;
              const write = (next: { subject: string; body: string }[]) => set('followups', ch === 'sms' ? { smsList: next.map((x) => x.body) } : { emailList: next });
              return (
                <Group key={ch} title={ch === 'sms' ? 'Follow-up texts' : 'Follow-up emails'} hint="They rotate across buyers: the first buyer gets #1, the second #2, and so on.">
                  <Switch on={aiOn} set={(v) => set('followups', ch === 'sms' ? { smsAi: v } : { emailAi: v })}>AI personalizes each one</Switch>
                  {items.map((t, i) => {
                    const move = (d: number) => { const n = items.slice(); const [x] = n.splice(i, 1); n.splice(i + d, 0, x); write(n); };
                    return (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '20px minmax(0,1fr) auto', gap: '8px', alignItems: 'start' }}>
                        <span className="mk-num" style={{ fontWeight: 700, fontSize: '12px', paddingTop: '8px', color: C.muted2 }}>{i + 1}</span>
                        <div style={{ display: 'grid', gap: '4px' }}>
                          {ch === 'email' ? <input value={t.subject} onChange={(e) => write(items.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))} placeholder="Subject" className="mk-field" aria-label={`Follow-up ${i + 1} subject`} /> : null}
                          <textarea rows={2} value={t.body} onChange={(e) => write(items.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} className="mk-area" aria-label={`Follow-up ${i + 1}`} />
                        </div>
                        <div style={{ display: 'flex', gap: '2px' }}>
                          <Btn size="sm" disabled={i === 0} onClick={() => move(-1)} aria-label="Move up" title={i === 0 ? 'Already first' : 'Move up'}>↑</Btn>
                          <Btn size="sm" disabled={i === items.length - 1} onClick={() => move(1)} aria-label="Move down" title={i === items.length - 1 ? 'Already last' : 'Move down'}>↓</Btn>
                          <Btn size="sm" onClick={() => setLightbox(`fu-${ch}-${i}`)} aria-label={`Edit follow-up ${i + 1} in the editor`} title="Open in the editor"><Svg d={Icon.edit} size={12} /></Btn>
                          <Btn size="sm" kind="danger" onClick={() => write(items.filter((_, j) => j !== i))} aria-label="Delete">×</Btn>
                        </div>
                      </div>
                    );
                  })}
                  {!items.some((x) => x.body.trim()) ? <Note level="warn">No {ch === 'sms' ? 'text' : 'email'} follow-up written, so none will go.</Note> : null}
                  <div><Btn size="sm" onClick={() => set('followups', ch === 'sms' ? { smsList: [...settings.followups.smsList, ''] } : { emailList: [...settings.followups.emailList, { subject: 'Following up: {{address}}', body: '' }] })}><Svg d={Icon.plus} size={12} /> Add a follow-up</Btn></div>
                </Group>
              );
            })}
            <div style={{ fontSize: '11.5px', color: C.muted2, lineHeight: 1.5 }}>
              {'{{deal_link}}'} is each buyer&apos;s own tracked link to the deal page on your domain, so their views and offers come back against their name. A brief without a link gets it added at the end
              {linksBusy ? ' · building the links now…' : Object.keys(links).length ? ` · ${Object.keys(links).length} ready.` : '.'} Personalized GIFs are not part of CLOZR campaigns.
            </div>
          </div>
        </Disclosure>
      </div>
    </div>
  );

  // The intro template picker (own intro, and the AI's fallback).
  function introTemplate() {
    const f = pRow ? fieldsForBuyer(pRow, fields, ctx, pLinks) : null;
    const c = f ? chooseIntro(settings.intro.templateBody, f) : null;
    return (
      <div style={{ display: 'grid', gap: '6px', width: '100%' }}>
        <select value={templateId} onChange={(e) => { setTemplateId(e.target.value); const t = data!.templates.find((x) => String(x.id) === e.target.value); set('intro', { templateBody: t?.body_text ?? GENERIC_INTRO }); }} className="mk-field" aria-label="Intro template">
          <option value="">Generic intro</option>
          {data!.templates.filter((t) => t.channel === 'sms' && t.category === 'dispo-intro').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <textarea rows={rowsFor(settings.intro.templateBody, 70)} value={settings.intro.templateBody} onChange={(e) => set('intro', { templateBody: e.target.value })} className="mk-area" aria-label="Intro template text" style={{ resize: 'none', fieldSizing: 'content' } as React.CSSProperties} />
        <div><Btn size="sm" onClick={() => setLightbox('intro')}><Svg d={Icon.edit} size={12} /> Edit the intro</Btn></div>
        {c?.fallback ? <span style={{ fontSize: '11.5px', color: 'var(--tx-amber-deep, #92400e)' }}>{pRow!.b.name} gets the generic intro: no {c.missing.join(', ')} on file.</span> : null}
        <span style={{ fontSize: '11.5px', color: C.muted2 }}>When a buyer&apos;s purchase facts are not on file, the generic intro goes instead of a sentence with a gap.</span>
      </div>
    );
  }

  // Every distinct message in the push, filled in for the preview's buyer.
  const editAt = (id: string) => {
    if (id === 'mk-sec-advanced') setOpen((o) => ({ ...o, advanced: true }));
    go(1);
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 60);
  };
  const pushVariants = (): ReviewVariant[] => {
    const f = pFields;
    const recs = plan.recipients;
    const has = (ch: 'sms' | 'email', kind: 'intro' | 'brief' | 'followup') => recs.filter((p) => p.messages.some((m) => m.channel === ch && m.kind === kind));
    const at = new Map(audience.map((r, i) => [r.b.id, i]));
    const out: ReviewVariant[] = [];
    if (settings.intro.mode !== 'none') {
      const mine = pRec?.messages.filter((m) => m.kind === 'intro').map((m) => m.body).join('\n\n');
      out.push({
        key: 'intro', channel: 'sms', title: 'Intro text', reach: has('sms', 'intro').length,
        note: settings.intro.mode === 'ai' ? `The AI writes each buyer's own, in a ${settings.intro.tone} tone. This is ${pRow ? pRow.b.name.split(' ')[0] : 'a sample'}'s${pIntroAi ? '' : ' template until the AI writes it'}.` : undefined,
        body: mine || renderMerge(chooseIntro(settings.intro.templateBody, f).body, f), edit: settings.intro.mode === 'ai' ? 'mk-sec-intro' : 'lb:intro',
      });
    }
    if (settings.brief.sms) out.push({ key: 'brief-sms', channel: 'sms', title: 'Deal brief by text', reach: has('sms', 'brief').length, body: renderMerge(settings.brief.smsBody, f), edit: 'lb:brief-sms' });
    if (settings.brief.email) {
      const e = renderEmail({ subject: settings.brief.emailSubject, body_html: settings.brief.emailHtml, body_text: settings.brief.emailBody }, f);
      out.push({ key: 'brief-email', channel: 'email', title: 'Deal brief by email', reach: has('email', 'brief').length, subject: e.subject, body: e.text, html: e.html, edit: 'lb:brief-email' });
    }
    const fuSms = fuSmsAt.map((x) => x.t);
    const fuEmail = fuEmailAt.map((x) => x.t);
    const turn = (p: (typeof recs)[number], n: number) => { const i = at.get(p.buyer_id) ?? 0; return ((i % n) + n) % n; };
    fuSms.forEach((t, j) => out.push({
      key: `fu-sms-${j}`, channel: 'sms', title: `Follow-up text ${j + 1} of ${fuSms.length}`, reach: has('sms', 'followup').filter((p) => turn(p, fuSms.length) === j).length,
      note: settings.followups.smsAi ? 'The AI personalizes each one from this.' : 'Only if they have not replied.', body: renderMerge(t, f), edit: `lb:fu-sms-${fuSmsAt[j].i}`,
    }));
    fuEmail.forEach((t, j) => {
      const e = renderEmail({ subject: t.subject || 'Following up: {{address}}', body_html: null, body_text: t.body }, f);
      out.push({
        key: `fu-email-${j}`, channel: 'email', title: `Follow-up email ${j + 1} of ${fuEmail.length}`, reach: has('email', 'followup').filter((p) => turn(p, fuEmail.length) === j).length,
        note: settings.followups.emailAi ? 'The AI personalizes each one from this.' : 'Only if they have not replied.', subject: e.subject, body: e.text, edit: `lb:fu-email-${fuEmailAt[j].i}`,
      });
    });
    if (settings.brief.rvm) {
      out.push({
        key: 'rvm', channel: 'rvm', title: 'Ringless voicemail', reach: audience.filter((r) => r.b.phone && !r.b.blacklisted && !/email only/i.test(r.b.preferredChannel)).length,
        body: renderMerge(settings.brief.rvmBody ?? '', f), audioUrl: settings.brief.rvmRecording ? recUrl : null, seconds: settings.brief.rvmRecording?.seconds ?? null,
        edit: 'mk-sec-rvm',
      });
    }
    return out;
  };

  const reviewBody = () => {
    const shown = plan.recipients.filter((p) => !search || p.row.b.name.toLowerCase().includes(search.toLowerCase()) || (p.row.b.company ?? '').toLowerCase().includes(search.toLowerCase()));
    const sel = plan.recipients.find((p) => p.buyer_id === pick) ?? plan.recipients[0];
    const bar = (x: number, y: number) => <span className="mk-bar" style={{ display: 'block', height: '4px', marginTop: '3px' }}><span style={{ transform: `scaleX(${y ? x / y : 0})` }} /></span>;
    const aiProg = aiBusy ? aiBusy.split(':')[1].split('/').map(Number) : null;
    return (
      <div style={{ display: 'grid', gap: '14px' }}>
        {aiBusy ? (
          <div className="mk-card" role="status" style={{ padding: '12px 16px', display: 'grid', gap: '6px' }}>
            <div style={{ fontSize: '12.5px' }}><b>The AI is writing each buyer&apos;s message</b> <span className="mk-num" style={{ color: C.muted2 }}>· {aiBusy.split(':')[1]}</span></div>
            <div className="mk-bar"><span style={{ transform: `scaleX(${aiProg && aiProg[1] ? Math.max(0.04, aiProg[0] / aiProg[1]) : 0.04})` }} /></div>
          </div>
        ) : aiPending ? <Note level="warn" action={<Btn size="sm" onClick={() => go(2)}>Write them</Btn>}>{plural(aiPending, 'AI message')} still to write before this can send.</Note> : null}

        {carrierReviews.length ? (
          <section className="mk-lb-check" data-state={carrierReviews.some((r) => r.check.blocked) ? 'block' : 'warn'} aria-labelledby="mk-carrier-h" data-testid="carrier-review" style={{ gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <Svg d={Icon.shield} size={15} color={carrierReviews.some((r) => r.check.blocked) ? C.red : C.amber} />
              <h2 id="mk-carrier-h" style={{ margin: 0, fontSize: '13.5px', fontWeight: 650 }}>Carrier check before this sends</h2>
              <span style={{ fontSize: '12px', color: C.muted }}>{plural(carrierReviews.length, 'message')} with words carrier or inbox filters score</span>
              <div style={{ flex: 1 }} />
              {carrierReviews.filter((r) => r.suggestion).length > 1 ? <Btn size="sm" kind="primary" onClick={fixAll}>Use all suggested wording</Btn> : null}
            </div>
            {carrierReviews.map((r) => (
              <div key={r.target} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '10px', alignItems: 'start', paddingTop: '10px', borderTop: `1px solid ${r.check.blocked ? 'var(--tint-red-2, #fecaca)' : 'var(--tint-amber-2, #fde68a)'}` }}>
                <div style={{ minWidth: 0, fontSize: '12.5px', lineHeight: 1.5 }}>
                  <b>{r.label}</b>
                  {r.check.findings.map((f, i) => <div key={i} style={{ color: f.severity === 'block' ? C.red : C.ink2 }}>{findingLine(f)}</div>)}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {r.suggestion ? <Btn size="sm" kind="primary" onClick={() => fixMessage(r)}>Use suggested</Btn> : null}
                  <Btn size="sm" onClick={() => setLightbox(r.target)} aria-label={`Edit ${r.label.toLowerCase()}`}><Svg d={Icon.edit} size={12} /> Edit</Btn>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
          <Tile k="Buyers" v={sum.buyers} sub={sum.skippedTotal ? `${sum.skippedTotal} skipped` : 'none skipped'} />
          <Tile k="Texts" v={sum.texts} sub={`≈ ${plural(sum.segments, 'segment')}`} />
          <Tile k="Emails" v={sum.emails} sub={`to ${plural(sum.emailBuyers, 'buyer')}`} />
          <Tile k="First sends" v={cap(whenLabel(firstSend ?? null, tz, now))} sub={zone} />
        </div>

        <PushReview title="Everything in this push" sample={pRow ? `filled in for ${pRow.b.name}` : null} segments={segmentsOf(plan.recipients)} variants={pushVariants()} onEdit={openEdit} />

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(240px, 320px) minmax(0,1fr)', gap: '12px', alignItems: 'start' }}>
          <div className="mk-card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '10px', borderBottom: `1px solid ${C.line2}`, display: 'grid', gap: '6px' }}>
              <Eyebrow>{plural(plan.recipients.length, 'buyer')}</Eyebrow>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search buyers in this campaign" className="mk-field" />
            </div>
            <div className="mk-list" style={{ maxHeight: '480px' }}>
              {shown.length ? null : <div style={{ padding: '14px', fontSize: '12.5px', color: C.muted2 }}>{search ? 'No buyer by that name.' : 'Nobody to send to.'}</div>}
              {shown.map((p) => {
                const s = p.row.stats;
                const on = sel?.buyer_id === p.buyer_id;
                return (
                  <button key={p.buyer_id} type="button" onClick={() => { setPick(p.buyer_id); setPreviewId(p.buyer_id); }} aria-pressed={on} className="mk-row"
                    style={{ display: 'grid', gridTemplateColumns: '32px minmax(0,1fr)', gap: '10px', width: '100%', textAlign: 'left', padding: '10px', border: 0, borderBottom: `1px solid ${C.line2}`, background: on ? C.mintSoft : 'var(--surface, #fff)', cursor: 'pointer' }}>
                    <Avatar name={p.row.b.name} />
                    <span style={{ minWidth: 0, fontSize: '12px' }}>
                      <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.row.b.company || p.row.b.name}</b>
                      <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px', fontSize: '10.5px' }}>
                        <span style={{ fontWeight: 700, color: 'var(--c-primary)' }}>L{p.level} · {p.row.levelLabel}{p.row.b.vetted ? ' · Vetted' : ''}</span>
                        <span style={{ color: C.muted2 }}>{dealCountLabel(s.purchases)}</span>
                        <span style={{ color: C.muted2 }} title="35% match score + 25% reply rate + 30% offer rate + 10% closed with us">Probability {p.probability == null ? '—' : p.probability + '%'}</span>
                      </span>
                      <span style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px', color: C.muted2, fontSize: '10.5px' }}>
                        <span>{s.dealsOffered} offers of {s.dealsSent}{bar(s.dealsOffered, s.dealsSent)}</span>
                        <span>{s.dealsReplied} replies of {s.dealsSent}{bar(s.dealsReplied, s.dealsSent)}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mk-card" style={{ padding: '14px', minWidth: 0 }}>
            {sel ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px' }}>What <b>{sel.row.b.name}</b> gets</span>
                  <span style={{ fontSize: '11.5px', color: C.muted2 }}>{sel.row.facts.lastPurchase ? `last purchase ${sel.row.facts.lastPurchase.address}${sel.row.facts.lastPurchase.distanceMi != null ? `, ${distanceLabel(sel.row.facts.lastPurchase.distanceMi)} away` : ''}` : 'no purchase on file'}</span>
                  <div style={{ flex: 1 }} />
                  <Choice label="Channel" value={tab} options={['sms', 'email'] as const} labels={{ sms: 'Texts', email: 'Email' }} onChange={setTab} />
                </div>
                <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
                  {sel.messages.filter((m) => m.channel === tab).length ? null : <div style={{ fontSize: '12.5px', color: C.muted2, padding: '10px 0' }}>{tab === 'sms' ? 'No texts for this buyer.' : 'No emails for this buyer.'}</div>}
                  {sel.messages.filter((m) => m.channel === tab).map((m) => {
                    const k = messageKey(sel.buyer_id, m);
                    return (
                      <div key={k} style={{ display: 'grid', gap: '4px' }}>
                        <span style={{ fontSize: '10.5px', color: C.muted2 }}>{m.kind === 'intro' ? 'Intro' : m.kind === 'brief' ? 'Deal brief' : 'Follow-up · if no reply'} · {when(m.send_at, tz)}{overrides[k] ? ' · edited' : ''}</span>
                        {editing === k ? (
                          <div style={{ display: 'grid', gap: '4px' }}>
                            {m.channel === 'email' ? <input defaultValue={m.subject ?? ''} id={`s-${k}`} className="mk-field" aria-label="Subject" /> : null}
                            <textarea defaultValue={m.body} id={`b-${k}`} rows={m.channel === 'email' ? 8 : 3} className="mk-area" aria-label="Message" />
                            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                              <Btn size="sm" onClick={() => setEditing(null)}>Cancel</Btn>
                              <Btn size="sm" kind="primary" onClick={() => {
                                const body = (document.getElementById(`b-${k}`) as HTMLTextAreaElement | null)?.value ?? m.body;
                                const subject = (document.getElementById(`s-${k}`) as HTMLInputElement | null)?.value;
                                setOverrides((o) => ({ ...o, [k]: { body: body.trim() || m.body, subject } }));
                                setEditing(null);
                              }}>Save for {sel.row.b.name.split(' ')[0]}</Btn>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gap: '4px' }}>
                            {m.channel === 'email' && m.subject ? <div style={{ fontSize: '12.5px' }}><span style={{ color: C.muted }}>Subject </span><b>{m.subject}</b></div> : null}
                            <div style={{ fontSize: '12.5px', lineHeight: 1.45, color: C.muted, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.body}</div>
                            <div><Btn size="sm" kind="quiet" onClick={() => { setPreviewId(sel.buyer_id); setPreviewCh(m.channel === 'email' ? 'email' : 'sms'); }}>Show in preview</Btn></div>
                          </div>
                        )}
                        {editing === k ? null : <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Btn size="sm" kind="quiet" onClick={() => setEditing(k)}>Edit for this buyer</Btn></div>}
                        {aiNote[sel.buyer_id] && m.kind === 'intro' ? <span style={{ fontSize: '11px', color: 'var(--tx-amber-deep, #92400e)', textAlign: 'right' }}>{aiNote[sel.buyer_id]}</span> : null}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : <div style={{ fontSize: '12.5px', color: C.muted2, display: 'grid', gap: '8px', justifyItems: 'start' }}>Nobody to send to yet.<Btn size="sm" onClick={() => go(0)}>Back to Audience</Btn></div>}
          </div>
        </div>

        <Section title="Sending from">
          <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            <div style={{ display: 'grid', gap: '6px', alignContent: 'start' }}>
              <span style={{ fontSize: '12px', color: C.muted, display: 'flex', alignItems: 'center', gap: '6px' }}><Svg d={Icon.text} size={13} color="var(--c-talkr)" /> Texts, through Talkr as you</span>
              <Choice label="Sending number" value={delivery.phoneMode} options={['default', 'custom'] as const} labels={{ default: 'My caller ID', custom: 'Another number' }} onChange={(v) => setDelivery({ ...delivery, phoneMode: v })} />
              {talkrErr ? <Note level="warn">Talkr did not answer ({talkrErr}). Texts go from your default line.</Note> : !talkrMe ? <span role="status" style={{ fontSize: '12px', color: C.muted2 }}>Loading your Talkr numbers…</span>
                : delivery.phoneMode === 'default' ? <span className="mk-num" style={{ fontSize: '12.5px' }}>{defaultNumber ? formatPhone(defaultNumber) : 'Talkr picks your default line'}</span>
                  : (
                    <select value={delivery.numberId} onChange={(e) => setDelivery({ ...delivery, numberId: e.target.value })} className="mk-field" style={{ maxWidth: '320px' }} aria-label="Number">
                      <option value="">Pick a number…</option>
                      {numbers.map((n) => <option key={n.id} value={n.id}>{formatPhone(n.phone_e164)}{n.label ? ` · ${n.label}` : ''}</option>)}
                    </select>
                  )}
            </div>
            <div style={{ display: 'grid', gap: '6px', alignContent: 'start' }}>
              <span style={{ fontSize: '12px', color: C.muted, display: 'flex', alignItems: 'center', gap: '6px' }}><Svg d={Icon.mail} size={13} /> Email, {useResend ? `through Resend from ${resend?.from ?? 'the blast domain'}` : 'from a connected Gmail account'}</span>
              {!resend ? <span role="status" style={{ fontSize: '12px', color: C.muted2 }}>Checking the email sender…</span> : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                <Field label="From name"><input value={delivery.fromName} onChange={(e) => setDelivery({ ...delivery, fromName: e.target.value })} className="mk-field" style={{ width: '160px' }} /></Field>
                <Field label={useResend ? 'Reply-To (Gmail)' : 'From email'}>
                  <select value={delivery.accountId} onChange={(e) => setDelivery({ ...delivery, accountId: e.target.value })} className="mk-field">
                    <option value="">{gmailChoices.length ? (useResend ? 'Optional: a Reply-To' : 'Pick an account…') : 'No connected Gmail (Settings → Google)'}</option>
                    {gmailChoices.map((g) => <option key={g.id} value={g.id}>{g.email}</option>)}
                  </select>
                </Field>
              </div>
              {useResend ? <span style={{ fontSize: '11.5px', color: C.muted2 }}>Gmail is Reply-To only, so replies land in your inbox.</span> : resend ? <span style={{ fontSize: '11.5px', color: C.muted2 }}>Resend is not set up yet (Settings → Outbound OS), so email goes from Gmail.</span> : null}
            </div>
          </div>
        </Section>
      </div>
    );
  };

  // ---------------------------------------------------------------- layout
  const stages = ['Audience', 'Message', 'Review'] as const;
  const next = stage === 0 ? (
    <>
      {onClose ? <Btn kind="quiet" onClick={onClose}>Cancel</Btn> : null}
      <Btn onClick={() => go(1)}>Edit message</Btn>
      <Btn kind="primary" size="lg" disabled={!audience.length} title={!audience.length ? 'Nobody is in this campaign yet' : undefined} onClick={() => go(2)} data-testid="to-review">Review {plural(sum.buyers || audience.length, 'buyer')} →</Btn>
    </>
  ) : stage === 1 ? (
    <>
      <Btn onClick={() => go(0)}>← Audience</Btn>
      <Btn kind="primary" size="lg" disabled={!audience.length} onClick={() => go(2)} data-testid="to-review">Review {plural(sum.buyers || audience.length, 'buyer')} →</Btn>
    </>
  ) : (
    <>
      <Btn onClick={() => go(1)}>← Message</Btn>
      <Btn kind="primary" size="lg" className="mk-btn--wrap" disabled={!!whyNot || launching} aria-describedby="mk-why" onClick={() => setConfirming(true)} data-testid="launch" style={{ maxWidth: isMobile ? '100%' : '460px' }}>
        {launching ? 'Launching…' : sentence}
      </Btn>
    </>
  );

  /** The preview's body: the inline pane and the full-screen view render the same messages. */
  const previewContent = () => (
    <>
              {!pRow ? <div style={{ fontSize: '12.5px', color: C.muted2, textAlign: 'center', padding: '40px 0' }}>Nobody in the audience to preview for.</div>
                : pSkip ? <Note level="block">{pRow.b.name} is skipped: {pSkip.why}. Pick another buyer with the arrows.</Note>
                  : previewCh === 'sms' ? (
                    <>
                      {settings.intro.mode === 'ai' && pGetsAi ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '10px', fontSize: '11.5px', color: C.muted2 }}>
                          {aiBusy?.startsWith('intro') ? <span role="status">Writing the intro in a {settings.intro.tone} tone…</span>
                            : pIntroAi ? <span>AI intro · {sampleTone ?? settings.intro.tone} tone</span>
                              : <span>The template shows until the AI writes {pRow.b.name.split(' ')[0]}&apos;s intro at Review.</span>}
                          <div style={{ flex: 1 }} />
                          {!aiBusy && canWrite && (!pIntroAi || (sampleTone && sampleTone !== settings.intro.tone)) ? (
                            <Btn size="sm" kind="quiet" onClick={() => void runAi(Array.from(new Set([...previewRows, pRow])), 'intro')} data-testid="write-sample">
                              {pIntroAi ? `Rewrite in a ${settings.intro.tone} tone` : 'Write a sample'}
                            </Btn>
                          ) : null}
                        </div>
                      ) : null}
                      <SmsThread messages={pRec?.messages.filter((m) => m.channel === 'sms') ?? []} tz={tz} now={now} from={fromLine} swapKey={toneSwapped ? `${pRow.b.id}:${pIntroAi ?? ''}` : undefined} />
                    </>
                  ) : <EmailView messages={pRec?.messages.filter((m) => m.channel === 'email') ?? []} tz={tz} now={now} from={emailFrom} />}
              {pRow && !links[String(pRow.b.id)] ? <div style={{ marginTop: '12px', fontSize: '11px', color: C.muted2 }}>{LINK_PLACEHOLDER} becomes {pRow.b.name.split(' ')[0]}&apos;s own link to the deal page once you open Message or Review.</div> : null}
    </>
  );

  return (
    <div ref={rootRef} className="mk-card mk-composer" style={{ containerType: 'inline-size', overflow: 'clip', scrollMarginTop: '12px' }} data-testid="composer">
      {bigPreview && typeof document !== 'undefined' ? createPortal(
        <div className="mk mk-scrim" style={{ zIndex: 130, padding: isMobile ? '0' : '24px' }} onMouseDown={(e) => { if (e.target === e.currentTarget) setBigPreview(false); }}>
          <div role="dialog" aria-modal="true" aria-label="Preview, full screen" data-testid="preview-big"
            style={{ width: isMobile ? '100%' : 'min(1100px, 100%)', height: isMobile ? '100%' : 'min(100%, calc(100dvh - 48px))', background: 'var(--surface, #fff)', borderRadius: isMobile ? 0 : '16px', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', borderBottom: `1px solid ${C.line2}`, flexWrap: 'wrap' }}>
              <Eyebrow>Preview</Eyebrow>
              {pRow ? <b style={{ fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pRow.b.name}{pRow.b.company ? ` · ${pRow.b.company}` : ''}</b> : null}
              <div style={{ flex: 1 }} />
              <Choice label="Preview channel" value={previewCh} options={['sms', 'email'] as const} labels={{ sms: 'Text', email: 'Email' }} onChange={setPreviewCh} />
              {pRow ? (
                <>
                  <span className="mk-num" style={{ fontSize: '11.5px', color: C.muted2 }}>{pIndex + 1} of {audience.length}</span>
                  <Btn size="sm" aria-label="Previous buyer" disabled={pIndex <= 0} onClick={() => setPreviewId(audience[pIndex - 1].b.id)} style={{ padding: '0 8px' }}><Svg d={Icon.left} size={12} /></Btn>
                  <Btn size="sm" aria-label="Next buyer" disabled={pIndex >= audience.length - 1} onClick={() => setPreviewId(audience[pIndex + 1].b.id)} style={{ padding: '0 8px' }}><Svg d={Icon.right} size={12} /></Btn>
                </>
              ) : null}
              <Btn size="sm" onClick={() => setBigPreview(false)} aria-label="Close the full-screen preview" data-autofocus>Close</Btn>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', padding: '20px', background: previewCh === 'email' ? '#f4f5f7' : '#fff' }}>
              <div style={{ maxWidth: previewCh === 'sms' ? '560px' : '720px', margin: '0 auto' }}>{previewContent()}</div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0 16px', borderBottom: `1px solid ${C.line2}`, flexWrap: 'wrap' }}>
        <div role="tablist" aria-label="Campaign stages" style={{ display: 'flex', overflowX: 'auto' }}>
          {stages.map((l, i) => (
            <button key={l} role="tab" aria-selected={stage === i} data-done={stage > i} className="mk-tab" onClick={() => go(i as 0 | 1 | 2)}>
              <span className="mk-step mk-num">{i + 1}</span>{l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {demo ? <Status tone="grey">Sample data</Status> : null}
        {onQuick ? <Btn size="sm" kind="quiet" onClick={onQuick}>Quick send</Btn> : null}
      </div>

      <div className="mk-grid" style={{ padding: '16px' }}>
        <div className="mk-main" style={{ minWidth: 0 }}>
          {stage === 0 ? audienceBody() : stage === 1 ? messageBody() : reviewBody()}
        </div>
        <div className="mk-side">
          <aside className="mk-card mk-summary" aria-label="Campaign summary" style={{ padding: '14px 16px', display: 'grid', gap: '10px', alignContent: 'start' }} data-testid="summary">
            <Eyebrow>This campaign</Eyebrow>
            <RailRow k="Who">
              <b className="mk-num">{plural(sum.buyers, 'buyer')}</b>
              {sum.skippedTotal || view.filtered.length ? (
                <span style={{ display: 'block', fontSize: '11.5px', color: C.muted2 }} title={[...sum.skipped, ...view.filtered].map(([k, v]) => `${v} ${k}`).join('\n')}>
                  {[sum.skippedTotal ? `${sum.skippedTotal} can't be reached` : '', ...view.filtered.slice(0, 1).map(([k, v]) => `${v} ${k.replace(' this deal', '')}`)].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </RailRow>
            <RailRow k="How">
              <span style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: smsCount ? C.ink : C.subtle }}><Svg d={Icon.text} size={13} color={smsCount ? 'var(--c-talkr)' : C.subtle} /><span className="mk-num">{smsCount}</span> text</span>
                <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: emailCount ? C.ink : C.subtle }}><Svg d={Icon.mail} size={13} /><span className="mk-num">{emailCount}</span> email</span>
              </span>
            </RailRow>
            <RailRow k="When">
              <span>Starts {whenLabel(firstSend ?? null, tz, now)}{whenLabel(firstSend ?? null, tz, now) === 'now' ? '' : ` ${zone}`}</span>
              <span style={{ display: 'block', fontSize: '11.5px', color: C.muted2 }}>{WINDOW.start} AM–{WINDOW.end - 12} PM {zone} only</span>
            </RailRow>
            <RailRow k="Follow-ups"><span style={{ fontSize: '12px' }}>{cadenceLabel(settings)}</span></RailRow>
            <RailRow k="Volume">
              <span className="mk-num">{plural(sum.messages, 'message')}</span>
              <span className="mk-num" style={{ display: 'block', fontSize: '11.5px', color: C.muted2 }}>≈ {plural(sum.segments, 'text segment')} billed by Talkr · {plural(sum.emails, 'email')}</span>
            </RailRow>
            {issues.filter((i) => i.level !== 'info').length ? (
              <div style={{ display: 'grid', gap: '6px', paddingTop: '4px' }} data-testid="issues">
                {issues.filter((i) => i.level !== 'info').map((i, n) => (
                  <Note key={n} level={i.level} action={i.actions ? undefined : i.edit ? (
                    <span style={{ display: 'inline-flex', gap: '2px' }}>
                      {i.fix ? <Btn size="sm" kind="quiet" onClick={i.fix} style={{ height: '24px' }}>Use suggested</Btn> : null}
                      <Btn size="sm" kind="quiet" onClick={() => setLightbox(i.edit!)} style={{ height: '24px' }}>Edit</Btn>
                    </span>
                  ) : stage !== i.stage ? <Btn size="sm" kind="quiet" onClick={() => go(i.stage)} style={{ height: '24px' }}>Fix</Btn> : undefined}>
                    {i.text}
                    {i.actions ? (
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                        {i.actions.map((a) => <Btn key={a.label} size="sm" onClick={a.run} style={{ height: '24px' }}>{a.label}</Btn>)}
                        {i.edit ? <Btn size="sm" kind="quiet" onClick={() => setLightbox(i.edit!)} style={{ height: '24px' }}>Show me</Btn> : null}
                      </span>
                    ) : null}
                  </Note>
                ))}
              </div>
            ) : null}
            {issues.filter((i) => i.level === 'info').map((i, n) => <Note key={`i${n}`} level="info">{i.text}</Note>)}
          </aside>

          <section className="mk-card mk-preview" aria-label="Preview" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }} data-testid="preview">
            <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${C.line2}`, display: 'grid', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Eyebrow>Preview</Eyebrow>
                <div style={{ flex: 1 }} />
                <Choice label="Preview channel" value={previewCh} options={['sms', 'email'] as const} labels={{ sms: 'Text', email: 'Email' }} onChange={setPreviewCh} />
                <Btn size="sm" onClick={() => setBigPreview(true)} title="See it full screen" aria-label="Open the preview full screen" data-testid="preview-full">⤢ Full screen</Btn>
              </div>
              {pRow ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <Avatar name={pRow.b.name} size={28} />
                  <span style={{ minWidth: 0, flex: 1, fontSize: '12px', lineHeight: 1.3 }}>
                    <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid="preview-buyer">{pRow.b.name}</b>
                    <span style={{ color: C.muted2, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pRow.b.company ? `${pRow.b.company} · ` : ''}L{pRow.level} {pRow.levelLabel}</span>
                  </span>
                  <span className="mk-num" style={{ fontSize: '11px', color: C.muted2 }}>{pIndex + 1} of {audience.length}</span>
                  <Btn size="sm" aria-label="Previous buyer" disabled={pIndex <= 0} title={pIndex <= 0 ? 'First buyer' : 'Previous buyer'} onClick={() => setPreviewId(audience[pIndex - 1].b.id)} style={{ padding: '0 6px' }}><Svg d={Icon.left} size={12} /></Btn>
                  <Btn size="sm" aria-label="Next buyer" disabled={pIndex >= audience.length - 1} title={pIndex >= audience.length - 1 ? 'Last buyer' : 'Next buyer'} onClick={() => setPreviewId(audience[pIndex + 1].b.id)} style={{ padding: '0 6px' }}><Svg d={Icon.right} size={12} /></Btn>
                </div>
              ) : null}
            </div>
            <div className="mk-preview-body" style={{ overflow: 'auto', overscrollBehavior: 'contain', padding: '14px' }}>
              {previewContent()}
            </div>
          </section>
        </div>
      </div>

      {/* Sticky on the desk; on a phone the tab's scroll area is too short for a bar that stays put, so it sits at the end. */}
      <div className="mk-footer" style={{ position: isMobile ? 'static' : 'sticky', bottom: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: isMobile ? '10px 16px 12px' : '10px 76px 10px 16px', borderTop: `1px solid ${C.line}`, background: 'var(--surface, #fff)', boxShadow: '0 -6px 16px -12px rgba(18,22,40,.18)' }}>
        <div id="mk-why" role="status" style={{ flex: '1 1 220px', minWidth: 0, fontSize: '12.5px', color: whyNot && stage === 2 ? '#92400e' : C.muted }}>
          {stage === 2 && whyNot ? whyNot
            : sum.buyers ? <><b className="mk-num" style={{ color: C.ink }}>{plural(sum.buyers, 'buyer')}</b> {channelWords(smsCount, emailCount)} · starts {whenLabel(firstSend ?? null, tz, now)}{whenLabel(firstSend ?? null, tz, now) === 'now' ? '' : ` ${zone}`}{blocking.length ? <span style={{ color: C.red }}> · {plural(blocking.length, 'thing')} to fix</span> : null}</>
              : 'Nobody in this campaign yet.'}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto', minWidth: 0, maxWidth: '100%' }}>{next}</div>
      </div>

      {lightbox && draftOf(lightbox) ? (
        <MessageLightbox key={lightbox} workspaceId={workspaceId} dealId={dealId} demo={!!demo}
          channel={lightbox === 'brief-email' || lightbox.startsWith('fu-email-') ? 'email' : 'sms'}
          title={lightboxTitle(lightbox)} sample={pRow ? `Filled in for ${pRow.b.name}` : null}
          initial={draftOf(lightbox)!} render={renderDraft(lightbox)}
          photo={lightbox === 'brief-email' ? { url: fields.photo_url || null, folder: demo ? data.photos.map((x) => ({ id: x.id, name: x.name, url: x.url })) : undefined } : undefined}
          checkMerge={checkMerge} fieldLabel={(f) => FIELD_LABEL[f] ?? f}
          onSave={(d, photo) => saveDraft(lightbox, d, photo)} onClose={() => setLightbox(null)} />
      ) : null}

      {confirming ? (
        <Dialog title={`Send to ${plural(sum.buyers, 'buyer')}?`} onClose={() => { if (!launching) setConfirming(false); }} actions={
          <>
            <Btn onClick={() => setConfirming(false)} disabled={launching} data-autofocus>Cancel</Btn>
            <Btn kind="primary" onClick={() => void launch()} disabled={launching} data-testid="confirm-send">{launching ? 'Launching…' : demo ? 'Send now (demo)' : 'Send now'}</Btn>
          </>
        }>
          <div style={{ display: 'grid', gap: '10px', fontSize: '13px' }}>
            <p style={{ margin: 0, color: C.muted, lineHeight: 1.5 }}>{sentence}. Once it starts, it runs on the server whether this tab is open or not.</p>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '6px 14px' }}>
              {smsCount ? <><dt style={dt}>Texts</dt><dd style={dd} className="mk-num">{plural(sum.texts, 'text')} to {plural(smsCount, 'buyer')} · ≈ {plural(sum.segments, 'segment')} · from {fromLine}</dd></> : null}
              {emailCount ? <><dt style={dt}>Emails</dt><dd style={dd} className="mk-num">{plural(sum.emails, 'email')} to {plural(emailCount, 'buyer')} · from {emailFrom}</dd></> : null}
              <dt style={dt}>Starts</dt><dd style={dd}>{whenLabel(firstSend ?? null, tz, now) === 'now' ? 'Now' : `${cap(whenLabel(firstSend ?? null, tz, now))} ${zone}`}, then only {WINDOW.start} AM–{WINDOW.end - 12} PM {zone}</dd>
              <dt style={dt}>Follow-ups</dt><dd style={dd}>{cadenceLabel(settings)}; they stop the moment a buyer replies</dd>
              {sum.skippedTotal ? <><dt style={dt}>Skipped</dt><dd style={dd}>{sum.skipped.map(([k, v]) => `${v} ${k}`).join(', ')}</dd></> : null}
              <dt style={dt}>Carrier check</dt>
              <dd style={dd} data-testid="confirm-carrier">
                {carrierReviews.length ? (
                  <span style={{ display: 'grid', gap: '6px', justifyItems: 'start' }}>
                    <span style={{ color: 'var(--tx-amber-deep, #92400e)' }}>{carrierReviews.map((r) => `${r.label}: ${plural(r.check.findings.length, 'word')} filters score`).join(' · ')}</span>
                    {carrierReviews.some((r) => r.suggestion) ? <Btn size="sm" onClick={fixAll} disabled={launching}>Use the suggested wording</Btn> : null}
                  </span>
                ) : 'Nothing carrier or inbox filters flag.'}
              </dd>
            </dl>
            <p style={{ margin: 0, fontSize: '12px', color: C.muted2 }}>Talkr bills texts by the segment. You can pause or stop the campaign from its results.</p>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- bits
const pill: React.CSSProperties = { display: 'inline-flex', gap: '4px', alignItems: 'center', height: '24px', padding: '0 8px', borderRadius: '6px', background: C.surface2, fontSize: '11.5px', color: C.muted };
const srOnly: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const dt: React.CSSProperties = { fontSize: '11px', color: C.muted2, fontWeight: 600, paddingTop: '2px' };
const dd: React.CSSProperties = { margin: 0, lineHeight: 1.45 };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function Section({ id, title, hint, right, children }: { id?: string; title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="mk-card" style={{ padding: '14px 16px', display: 'grid', gap: '10px', scrollMarginTop: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Eyebrow>{title}</Eyebrow>
          {hint ? <div style={{ fontSize: '12px', color: C.muted2, marginTop: '3px' }}>{hint}</div> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}
function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: '10px', paddingTop: '14px', borderTop: `1px solid ${C.line2}` }}>
      <div><div style={{ fontSize: '12.5px', fontWeight: 600 }}>{title}</div>{hint ? <div style={{ fontSize: '11.5px', color: C.muted2, marginTop: '2px' }}>{hint}</div> : null}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mk-row-2" style={{ display: 'grid', gap: '6px' }}>
      <span style={{ fontSize: '12px', color: C.muted }}>{label}</span>
      <div style={{ display: 'grid', gap: '6px', minWidth: 0 }}>{children}</div>
    </div>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement }) {
  return (
    <label style={{ display: 'grid', gap: '4px', minWidth: 0 }} title={hint}>
      <span style={{ fontSize: '11.5px', color: C.muted }}>{label}</span>
      {children}
    </label>
  );
}
const Off = ({ children }: { children: React.ReactNode }) => <div style={{ fontSize: '12.5px', color: C.muted2 }}>{children}</div>;
/** A deal field a check found blank, typed in right there. */
function FillField({ label, onUse }: { label: string; onUse: (v: string) => void }) {
  const [v, setV] = useState('');
  const use = () => { if (v.trim()) onUse(v.trim()); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); use(); }} style={{ display: 'flex', gap: '4px', marginTop: '6px', minWidth: 0 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} className="mk-field" aria-label={label} placeholder={`${label}…`} style={{ flex: 1, width: 0, height: '26px' }} />
      <Btn size="sm" type="submit" disabled={!v.trim()} style={{ height: '26px' }}>Use</Btn>
    </form>
  );
}
/** Rows enough for the whole message at about `perLine` characters a line, where field-sizing cannot do it. */
const rowsFor = (text: string, perLine: number) => Math.max(3, text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0) + 1);
/** Under a message: the way into the big editor, and what the carrier check thinks of it. */
function EditBar({ onEdit, label, extra, review }: { onEdit: () => void; label: string; extra?: string; review?: CarrierReview }) {
  const blocks = review?.check.findings.filter((f) => f.severity === 'block').length ?? 0;
  const n = review?.check.findings.length ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <Btn onClick={onEdit} aria-label={`Edit ${label}`}><Svg d={Icon.edit} size={13} /> Edit</Btn>
      {extra ? <span style={{ fontSize: '12px', color: C.muted2 }}>{extra}, and changes with AI</span> : <span style={{ fontSize: '12px', color: C.muted2 }}>Change it with AI, a part or the whole</span>}
      <div style={{ flex: 1 }} />
      <span className="mk-status" style={{ color: blocks ? C.red : n ? '#b45309' : 'var(--c-primary)' }}>
        <Svg d={Icon.shield} size={13} /> {blocks ? 'A carrier would refuse this' : n ? `${plural(n, 'word')} filters score` : 'Carrier check clear'}
      </span>
    </div>
  );
}
function RailRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: '8px', fontSize: '12.5px', lineHeight: 1.4, paddingTop: '8px', borderTop: `1px solid ${C.line2}` }}>
      <span style={{ color: C.muted2 }}>{k}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}
function Tile({ k, v, sub }: { k: string; v: number | string; sub: string }) {
  return (
    <div className="mk-card" style={{ padding: '12px 14px' }}>
      <Eyebrow>{k}</Eyebrow>
      <div className="mk-num" style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '-0.03em', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{typeof v === 'number' ? v.toLocaleString('en-US') : v}</div>
      <div className="mk-num" style={{ fontSize: '11px', color: C.subtle }}>{sub}</div>
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const COMPOSER_CSS = `
.mk-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); grid-template-areas: "summary" "main" "preview"; }
.mk-main { grid-area: main; }
/* Every stage is a one-column grid whose cards may shrink below their content: long words ellipsize or wrap instead of widening the page. */
.mk-main > div, .mk-main section.mk-card, .mk-main .mk-card > .mk-disclosure { grid-template-columns: minmax(0, 1fr); min-width: 0; }
.mk-side { display: contents; }
.mk-summary { grid-area: summary; }
.mk-preview { grid-area: preview; }
.mk-preview-body { min-height: 420px; max-height: 820px; height: auto; }
@container (min-width: 880px) {
  .mk-grid { grid-template-columns: minmax(0, 1fr) minmax(420px, 520px); grid-template-areas: "main side"; align-items: start; }
  .mk-side { display: grid; gap: 12px; grid-area: side; position: sticky; top: 12px; align-self: start; }
  .mk-summary { max-height: 240px; overflow: auto; }
  .mk-preview-body { min-height: 420px; max-height: calc(100dvh - 260px); height: auto; }
  .mk-row-2 { grid-template-columns: 170px minmax(0, 1fr) !important; align-items: start; }
}
@container (min-width: 1240px) {
  .mk-grid { grid-template-columns: minmax(0, 1fr) minmax(440px, 640px) 250px; grid-template-areas: "main preview summary"; }
  .mk-side { display: contents; }
  .mk-summary, .mk-preview { position: sticky; top: 12px; align-self: start; }
  .mk-summary { max-height: calc(100dvh - 330px); }
  .mk-preview-body { min-height: 480px; max-height: calc(100dvh - 220px); height: auto; }
}
@container (min-width: 1560px) {
  .mk-grid { grid-template-columns: minmax(0, 1fr) minmax(560px, 780px) 260px; }
}
`;
