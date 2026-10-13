'use client';

// One composer for every bulk send — People's Text and Email, Buyers' Send
// marketing — because there was nothing behind those buttons but
// window.prompt(): no template, no preview, no idea who was about to be
// skipped, and email that went out as raw text even when the template picked
// had designed HTML.
//
// What it is: the selection on the left with a message beside it, and the
// thing that will actually land on the right, merged with the first
// recipient's own values. Two ways to write it — pick a CLOZR template
// (lib/message-templates), or type one here, in which case an email is still
// wrapped in the same 600px branded shell a template gets rather than posted
// as a bare paragraph.
//
// Sending is the existing plumbing, unchanged: SMS through Talkr as the
// signed-in rep (lib/sms textMany), email through the member's own Gmail and
// the mailbox guard (lib/google sendEmail, kind 'bulk'). What is new is that
// body_html survives the trip, and that every refusal comes back named.

import { SmsFromPicker } from '@/components/SmsFromPicker';
import React, { useEffect, useMemo, useState } from 'react';
// This composer is built out of Talkr's components, which speak the Talkr
// design-system tokens (--panel, --line, --text, --sans, --r-btn …). Those are
// scoped to `.talkr-inbox`, never :root, so mounted from People or Buyers —
// outside the inbox — every one of them resolved to nothing: `background:
// var(--panel)` went transparent, `border: 1px solid var(--line)` dropped the
// border entirely, and the `font:` shorthand failed whole because of
// var(--sans). White on white, no boxes. The stylesheet comes with the
// component now, and the root carries the scope.
import '@/app/clozr/talkr-inbox.css';
import {
  type Block, type MessageTemplate, MERGE_FIELDS,
  blocksToEmail, renderEmail,
} from '@/lib/message-templates';
import { MAX_BODY, MAX_RECIPIENTS, type Recipient, type SendContext, renderMerge, textMany } from '@/lib/sms';
import { sendEmail } from '@/lib/google';
import { queueBulkRvm } from '@/lib/crm-write';
import { RvmRecordingPicker } from '@/app/components/talkr/RvmRecordingPicker';
import type { VmClip } from '@/app/components/talkr/useVmLibrary';
import { clipClock, pinnedGroup } from '@/lib/rvm-pick';
import { SEND_SKIP_LABEL, personKey, previewSend, previewSentence, type SendPreview } from '@/lib/rvm-send';
import { loadSendPreview, type SendPreviewData } from '@/lib/rvm-send-data';
import { BLACKLIST_MESSAGE, isBlacklisted } from '@/lib/blacklist';
import { EmailHtml } from '@/app/components/email/EmailHtml';
import { Icon } from '@/app/components/talkr/Icon';
import { Button, FIELD } from '@/app/components/talkr/ui';
import { MergeChips } from '@/app/components/talkr/MessageTemplates';
import { supabase } from '@/lib/supabase';
import { insertAtCaret } from '@/app/components/talkr/EmojiPicker';
import { Bubble } from '@/app/components/talkr/Bubble';
import { firstNonGsmChar, smsSegments } from '@/app/components/talkr/contacts';
import { SpamRiskBadge } from '@/app/components/deliverability/SpamRiskBadge';
import { TemplateFilters, ownerLabel } from '@/app/components/templates/TemplatePicker';
import { type TemplateFilter, filterTemplates, useTemplates } from '@/app/components/templates/useTemplates';

export type Channel = 'sms' | 'email' | 'rvm';

/** Someone in the selection, with everything needed to decide whether they can be sent to. */
export type BulkPerson = {
  id: string;
  /** sellers.id or buyers.id — what the send is logged against. */
  dbId: number;
  name: string;
  phone?: string;
  email?: string;
  /** "Email only", "SMS only" — a preference the send honours. */
  pref?: string;
  inactive?: boolean;
  blacklisted?: boolean;
  /** Do-not-call. Ringless voicemail will not be queued. */
  dnc?: boolean;
  /** This person's own merge values: their address, city, zip. */
  fields?: Record<string, string>;
  /** The deal this person's drop is about (the Deals list sends to each deal's seller). */
  dealId?: number | null;
};

/** A deal whose fields a blast can carry ({{arv}}, {{marketing_link}}, …). */
export type BulkDeal = { id: number; label: string; fields: Record<string, string> };

export type BulkComposeProps = {
  /** Which list the selection came from — sets the template audience and where the send is logged. */
  kind: 'seller' | 'buyer' | 'vendor';
  people: BulkPerson[];
  /** Offered as "About a deal"; a buyer blast needs one, a seller nudge does not. */
  deals?: BulkDeal[];
  requireDeal?: boolean;
  channel?: Channel;
  workspaceId: number | null;
  canWrite: boolean;
  userId: string | null;
  /** The sender's own merge values — {{rep_name}}, {{rep_phone}}, {{rep_email}}, {{company}}. */
  rep: SendContext;
  /** Where "Send test to me" goes; null when Gmail is not connected. */
  testTo?: string | null;
  toast: (message: string) => void;
  /** After a send that reached somebody: the deal it was about and who got it. */
  onSent?: (r: { channel: Channel; dealId: number | null; sentDbIds: number[] }) => void | Promise<void>;
  onClose: () => void;
};

type Row = BulkPerson & { to: string; skip?: string };

const label: React.CSSProperties = { display: 'block', font: '600 11px/1 var(--sans)', color: 'var(--muted)', marginBottom: 5 };
const input: React.CSSProperties = { ...FIELD, width: '100%', font: '500 13px/1.3 var(--sans)' };
const seg = (on: boolean): React.CSSProperties => ({
  height: 26, padding: '0 11px', borderRadius: 6, border: 0, cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap',
  font: '600 11.5px/1 var(--sans)', background: on ? '#fff' : 'transparent', color: on ? 'var(--text)' : 'var(--muted)',
  boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
});
const segWrap: React.CSSProperties = { display: 'inline-flex', gap: 2, padding: 3, background: 'var(--panel-2)', borderRadius: 8 };

const SMS_START = 'Hi {{first_name}}, ';
const EMAIL_START = 'Hi {{first_name}},\n\n';

/** Why this person cannot be sent to on this channel, or undefined. */
function skipReason(p: BulkPerson, channel: Channel, to: string): string | undefined {
  if (isBlacklisted(p)) return BLACKLIST_MESSAGE;
  if (p.dnc) return 'do not call';
  if (p.inactive) return 'inactive';
  if (!to) return channel === 'email' ? 'no email' : 'no phone';
  if ((channel === 'sms' || channel === 'rvm') && /email only/i.test(p.pref ?? '')) return 'prefers email only';
  if (channel === 'email' && /sms only/i.test(p.pref ?? '')) return 'prefers SMS only';
  return undefined;
}

const channelName = (channel: Channel) => channel === 'sms' ? 'Text' : channel === 'rvm' ? 'RVM' : 'Email';

/** The designed email a buyer blast opens on: the Acme Homes deal blast (migration 58), else any other blast template. */
function defaultBlast(templates: MessageTemplate[]): MessageTemplate | null {
  const blasts = templates.filter((x) => x.channel === 'email' && x.category === 'dispo-blast' && x.body_html);
  return blasts.find((b) => /acme homes/i.test(b.name)) ?? blasts[0] ?? null;
}

export function BulkCompose(props: BulkComposeProps) {
  const t = useTemplates(props.workspaceId);
  // Templates first, then the composer. A buyer email opens on the Acme Homes
  // deal blast, and that is the composer's initial state — not an effect that
  // rewrites what the rep may already have typed.
  if (t.loading) return null;
  return <Composer {...props} t={t} blast={props.kind === 'buyer' ? defaultBlast(t.templates) : null} />;
}

function Composer({
  kind, people, deals = [], requireDeal = false, channel: channel0 = 'sms',
  workspaceId, canWrite, userId, rep, testTo = null, toast, onSent, onClose, t, blast,
}: BulkComposeProps & { t: ReturnType<typeof useTemplates>; blast: MessageTemplate | null }) {
  const [channel, setChannel] = useState<Channel>(channel0);
  const [dealId, setDealId] = useState<string>(deals.length === 1 ? String(deals[0].id) : '');
  const start = channel0 === 'email' ? blast : null;
  const [subject, setSubject] = useState(start?.subject ?? '');
  const [body, setBody] = useState(start ? start.body_text : channel0 === 'sms' ? SMS_START : EMAIL_START);
  /** Set only while a designed template is in use; typing a message of your own clears it. */
  const [tpl, setTpl] = useState<MessageTemplate | null>(start);
  const [picking, setPicking] = useState(false);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ summary: string; lines: string[] } | null>(null);
  /** The recording an RVM send plays: a saved one, or one just recorded here. Every drop plays it. */
  const [rvmClip, setRvmClip] = useState<VmClip | null>(null);
  /** What rvm_send_preview read for this selection; the pre-send check runs the tick's rules over it. */
  const [rvmFacts, setRvmFacts] = useState<{ key: string; data: SendPreviewData | null; error: string | null } | null>(null);
  // A ringless drop is logged on a seller or a buyer; a vendor has neither.
  const rvmOk = kind !== 'vendor';
  const live = canWrite && workspaceId !== null;
  const idsKey = people.map((p) => p.dbId).join(',');
  /** The read this selection needs; the facts are loading until one with this key lands. */
  const rvmKey = channel === 'rvm' && live && rvmOk ? `${workspaceId}:${kind}:${idsKey}` : null;
  useEffect(() => {
    if (!rvmKey || workspaceId === null) return;
    let gone = false;
    const ids = people.map((p) => p.dbId);
    void loadSendPreview(workspaceId, kind === 'seller' ? ids : [], kind === 'buyer' ? ids : []).then((r) => {
      if (!gone) setRvmFacts(r.ok ? { key: rvmKey, data: r.data, error: null } : { key: rvmKey, data: null, error: r.message });
    });
    return () => { gone = true; };
    // The key carries the selection's ids: the parent rebuilds `people` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rvmKey]);
  const facts = rvmFacts && rvmFacts.key === rvmKey ? rvmFacts : null;

  const deal = deals.find((d) => String(d.id) === dealId) ?? null;
  // A vendor list has no templates of its own: offer them all and let the rep pick.
  const audience: TemplateFilter['audience'] = kind === 'buyer' ? 'buyer' : kind === 'vendor' ? 'any' : 'seller';
  const [f, setF] = useState<TemplateFilter>({ channel: channel0 === 'rvm' ? 'sms' : channel0, audience, owner: 'any', q: '' });
  const shown = useMemo(() => filterTemplates(t.templates, { ...f, channel: channel === 'rvm' ? 'sms' : channel }, userId), [t.templates, f, channel, userId]);

  // The last field typed in, so a merge chip lands at the caret.
  const [last, setLast] = useState<{ el: HTMLInputElement | HTMLTextAreaElement; apply: (v: string) => void } | null>(null);
  const track = (apply: (v: string) => void) => ({ onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => setLast({ el: e.currentTarget, apply }) });
  const insert = (token: string) => { if (last) last.apply(insertAtCaret(last.el as HTMLTextAreaElement, last.el.value, token)); };

  /** The tick's own rules over this selection: who goes now, who waits for their window, who is skipped and why. */
  const rvmCheck: SendPreview | null = useMemo(() => {
    if (channel !== 'rvm' || !facts?.data || kind === 'vendor') return null;
    const k = kind;
    const phones: Record<string, string> = {};
    for (const p of people) if (!skipReason(p, 'rvm', (p.phone ?? '').trim())) phones[personKey(k, p.dbId)] = (p.phone ?? '').trim();
    return previewSend({ phones, people: facts.data.people, lines: facts.data.pool, settings: facts.data.settings, now: new Date() });
  }, [channel, facts, people, kind]);
  const rvmSkip = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of rvmCheck?.people ?? []) if (v.action === 'skip') m.set(v.key, SEND_SKIP_LABEL[v.reason]);
    return m;
  }, [rvmCheck]);

  const rows: Row[] = useMemo(() => people.map((p) => {
    const to = ((channel === 'email' ? p.email : p.phone) ?? '').trim();
    const own = skipReason(p, channel, to);
    const tick = channel === 'rvm' && kind !== 'vendor' ? rvmSkip.get(personKey(kind, p.dbId)) : undefined;
    return { ...p, to, skip: own ?? tick };
  }), [people, channel, kind, rvmSkip]);
  const go = rows.filter((r) => !r.skip);
  const skipped = rows.filter((r) => r.skip);

  /** Everything a message can merge for one person: the deal, then them, then who they are and who is writing. */
  const fieldsOf = (r: Row): Record<string, string> => ({
    // A blast has no campaign facts about each buyer, so the per-buyer dispo
    // fields render blank here (and the sentence around them closes up)
    // rather than going out as a literal {{purchase_note}}.
    purchase_note: '', purchase_count: '', last_purchase_address: '', last_purchase_ago: '', last_purchase_type: '', deal_distance: '', similar_size: '',
    ...(deal?.fields ?? {}),
    ...(r.fields ?? {}),
    first_name: r.name.trim().split(/\s+/)[0] ?? '',
    name: r.name,
    contact_name: r.name,
    email: r.email ?? '',
    phone: r.phone ?? '',
    rep_name: rep.repName ?? '',
    rep_first_name: (rep.repName ?? '').split(/\s+/)[0] ?? '',
    rep_phone: rep.repPhone ?? '',
    rep_email: rep.repEmail ?? '',
    company: rep.company ?? '',
  });

  const pickChannel = (c: Channel) => {
    if (c === channel) return;
    setChannel(c); setConfirming(false);
    // Switching a buyer blast to email opens on the designed blast, as a fresh composer does.
    const next = c === 'email' ? blast : null;
    setTpl(next);
    setBody(next ? next.body_text : c === 'email' ? EMAIL_START : SMS_START);
    if (next?.subject) setSubject(next.subject);
  };
  const pickTemplate = (x: MessageTemplate) => {
    setTpl(x.channel === 'email' && x.body_html ? x : null);
    setBody(x.body_text);
    if (x.subject) setSubject(x.subject);
    setPicking(false); setConfirming(false);
  };
  const writeMyOwn = () => { setTpl(null); setBody(tpl?.body_text ?? body); setConfirming(false); };

  /** The HTML that goes out: the template's own, or this message in the same branded shell. */
  const html = useMemo(() => {
    if (channel !== 'email') return null;
    if (tpl?.body_html) return tpl.body_html;
    // No name, phone or address to sign with (a demo workspace, a member who
    // has filled none of it in) would render the signature as a bare "·".
    const signed = Boolean((rep.repName ?? rep.repEmail ?? rep.repPhone ?? '').trim());
    const blocks: Block[] = [{ id: 'body', type: 'paragraph', text: body }, ...(signed ? [{ id: 'sign', type: 'signature' } as Block] : [])];
    return blocksToEmail(blocks).html;
  }, [channel, tpl, body, rep.repName, rep.repEmail, rep.repPhone]);

  const sample = go[0] ? fieldsOf(go[0]) : null;
  const preview = useMemo(() => (sample ? renderEmail({ subject, body_html: html, body_text: body }, sample) : null), [sample, subject, html, body]);
  const smsOut = sample ? renderMerge(body, sample) : '';
  const s = smsSegments(smsOut);
  const culprit = s.encoding === 'ucs2' ? firstNonGsmChar(smsOut) : null;

  const tooMany = channel !== 'rvm' && go.length > MAX_RECIPIENTS;
  // Nothing to pick is not the same as not having picked: with no active deal
  // in inventory the blast still goes out, it just carries no deal fields.
  const mustPickDeal = requireDeal && deals.length > 0;
  // An RVM plays a recording; outside a workspace (demo) there is nothing to pick, so it previews without one.
  const rvmNeedsClip = channel === 'rvm' && canWrite && workspaceId !== null && !rvmClip;
  // The check is still reading: wait for it, so nobody it would skip is queued.
  const rvmChecking = rvmKey !== null && !facts;
  const ready = (channel === 'rvm' ? !rvmNeedsClip && rvmOk && !rvmChecking : Boolean(body.trim() || tpl)) && go.length > 0 && !tooMany
    && (channel !== 'email' || subject.trim().length > 0)
    && (!mustPickDeal || deal !== null);
  const blocked = tooMany ? `${go.length} recipients; ${MAX_RECIPIENTS} is the most in one send. Select fewer.`
    : channel === 'rvm' && !rvmOk ? 'Ringless voicemail goes to sellers and buyers, not vendors.'
    : rvmNeedsClip ? 'Pick a saved recording or record one.'
    : rvmChecking ? 'Checking who can get it…'
    : mustPickDeal && !deal ? 'Pick the deal this is about.'
      : channel === 'email' && !subject.trim() ? 'An email needs a subject.'
        : !go.length ? `Every selected ${kind === 'buyer' ? 'buyer' : kind === 'vendor' ? 'vendor' : 'person'} is skipped for ${channelName(channel)}.`
          : null;

  const sendTest = async () => {
    if (!testTo || workspaceId === null || !preview) return;
    setTesting(true);
    const r = await sendEmail(workspaceId, { to: testTo, subject: `[Test] ${preview.subject}`, body_html: preview.html ?? undefined, body_text: preview.text, test: true });
    setTesting(false);
    toast(r.ok && r.data.ok ? `Test sent to ${testTo}` : r.ok ? r.data.message ?? 'Gmail refused that send.' : r.message);
  };

  const send = async () => {
    if (!canWrite || workspaceId === null) {
      setResult({ summary: `${go.length} would be sent (demo)`, lines: ['Sign in to a workspace to send for real.'] });
      return;
    }
    const ws = workspaceId;
    setProgress(0);
    const sent: number[] = [];
    const failed: string[] = [];

    if (channel === 'rvm') {
      // The script is the recording's written record (what the activity log shows), not something read aloud.
      const clip = rvmClip;
      const out = await queueBulkRvm(ws, userId, go.map((r) => ({
        sellerId: kind === 'seller' ? r.dbId : null,
        buyerId: kind === 'buyer' ? r.dbId : null,
        phone: r.to,
        script: clip ? (clip.script.trim() ? renderMerge(clip.script, fieldsOf(r)) : `Voicemail: ${clip.name}`) : renderMerge(body, fieldsOf(r)),
        dealId: r.dealId ?? null,
      })), clip ? { libraryId: clip.id, variantGroup: pinnedGroup(clip.id) } : null, deal?.id ?? null);
      if (!out.ok) failed.push(out.message);
      else {
        // Exactly who was queued: a blacklisted row in the middle is not counted as sent.
        sent.push(...(kind === 'buyer' ? out.buyerIds : out.sellerIds));
        if (out.blocked) failed.push(`${out.blocked} ${BLACKLIST_MESSAGE}`);
        if (out.queued + out.blocked < go.length) failed.push(`${go.length - out.queued - out.blocked} could not be queued`);
      }
      setProgress(go.length);
    } else if (channel === 'sms') {
      const to: Recipient[] = go.map((r) => ({
        sellerId: kind === 'seller' ? r.dbId : null, buyerId: kind === 'buyer' ? r.dbId : null, vendorId: kind === 'vendor' ? r.dbId : null,
        name: r.name, phone: r.to, extra: fieldsOf(r),
      }));
      const out = await textMany(ws, to, body, rep);
      out.forEach((o, i) => (o.error ? failed.push(`${go[i].name}: ${o.error}`) : sent.push(go[i].dbId)));
      setProgress(go.length);
    } else {
      // One at a time: the mailbox guard paces bulk mail, and when it refuses
      // for a reason that will refuse the next one too (paused, a cap, outside
      // the window) the rest are not attempted rather than hammered.
      let held = '';
      for (const [i, r] of go.entries()) {
        setProgress(i);
        if (held) { failed.push(`${r.name}: not attempted (${held})`); continue; }
        const m = renderEmail({ subject, body_html: html, body_text: body }, fieldsOf(r));
        const res = await sendEmail(ws, {
          to: r.to, subject: m.subject, body_html: m.html ?? undefined, body_text: m.text,
          ...(kind === 'seller' ? { seller_id: r.dbId } : kind === 'buyer' ? { buyer_id: r.dbId } : { vendor_id: r.dbId }), kind: 'bulk',
        });
        if (!res.ok) { failed.push(`${r.name}: ${res.message}`); continue; }
        if (!res.data.connected) { held = 'connect Google in Settings to send email'; failed.push(`${r.name}: ${held}`); continue; }
        if (res.data.ok === false) {
          if (res.data.code && res.data.code !== 'suppressed') held = `mailbox guard: ${res.data.code}${res.data.next_at ? `, next at ${new Date(res.data.next_at).toLocaleTimeString()}` : ''}`;
          failed.push(`${r.name}: ${res.data.message || res.data.code || 'refused'}`);
          continue;
        }
        // google-sync files the row on a seller or buyer; a vendor is filed from here.
        if (kind === 'vendor' && res.data.communication_id && supabase) {
          await supabase.from('communications').update({ vendor_id: r.dbId }).eq('id', res.data.communication_id);
        }
        sent.push(r.dbId);
      }
      setProgress(go.length);
    }

    if (sent.length && onSent) await onSent({ channel, dealId: deal?.id ?? null, sentDbIds: sent });
    setProgress(null);
    setResult({
      summary: `${sent.length} sent · ${failed.length} failed · ${skipped.length} skipped`,
      lines: [...failed, ...skipped.map((r) => `${r.name}: skipped (${r.skip})`)],
    });
  };

  // Escape closes, unless a send is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && progress === null) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [progress, onClose]);

  const noun = kind === 'buyer' ? (go.length === 1 ? 'buyer' : 'buyers') : kind === 'vendor' ? (go.length === 1 ? 'vendor' : 'vendors') : (go.length === 1 ? 'person' : 'people');
  const who = `${go.length} ${noun}`;

  return (
    <div role="dialog" aria-label="Bulk send" className="talkr-inbox flex flex-col" style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'var(--bg)' }}>
      <header className="glass-bar flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <button type="button" aria-label="Close" onClick={onClose} disabled={progress !== null} style={{ color: 'var(--accent)', cursor: 'pointer' }}><Icon name="chevron-left" size={20} strokeWidth={2.4} /></button>
        <div className="mr-auto flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate" style={{ font: '700 15px/1 var(--sans)' }}>
            {result ? 'Send report' : `${channelName(channel)} ${rows.length} selected`}
          </h1>
          <p className="truncate" style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted)' }}>
            {result ? result.summary : `${who} will get it${skipped.length ? ` · ${skipped.length} skipped` : ''}${deal ? ` · ${deal.label}` : ''}`}
          </p>
        </div>
        {!result && (
          <span style={segWrap}>
            <button type="button" style={seg(channel === 'sms')} disabled={progress !== null} onClick={() => pickChannel('sms')}>SMS</button>
            <button type="button" style={seg(channel === 'email')} disabled={progress !== null} onClick={() => pickChannel('email')}>Email</button>
            {rvmOk && <button type="button" style={seg(channel === 'rvm')} disabled={progress !== null} onClick={() => pickChannel('rvm')}>RVM</button>}
          </span>
        )}
      </header>

      {result ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto flex max-w-2xl flex-col gap-2">
            <p style={{ font: '700 20px/1.2 var(--sans)' }}>{result.summary}</p>
            {result.lines.length === 0 && <p style={{ font: '400 13px/1.5 var(--sans)', color: 'var(--muted)' }}>Everyone selected got it.</p>}
            {result.lines.map((l, i) => (
              <p key={i} className="rounded-lg px-3 py-2" style={{ font: '400 12.5px/1.45 var(--sans)', color: 'var(--muted)', background: 'var(--panel)', border: '1px solid var(--line)' }}>{l}</p>
            ))}
            <div className="mt-2 flex gap-2">
              <Button tone="accent" className="dc3" onClick={onClose}>Done</Button>
              {result.lines.length > 1 && (
                <Button tone="ghost" className="dc2" onClick={() => { void navigator.clipboard?.writeText(result.lines.join('\n')); toast('Copied'); }}>
                  <Icon name="copy" size={13} /> Copy the list
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(340px,430px)_1fr]">
          {/* ── Left: who it goes to, and what it says ─────────────────── */}
          <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4" style={{ borderRight: '1px solid var(--line)' }}>
            {(deals.length > 0 || requireDeal) && (
              <label><span style={label}>{requireDeal ? 'Which deal' : 'About a deal — optional'}</span>
                <select style={input} value={dealId} disabled={deals.length === 0} aria-label={requireDeal ? 'Which deal' : 'About a deal'} onChange={(e) => { setDealId(e.target.value); setConfirming(false); }}>
                  <option value="">{deals.length === 0 ? 'No active deals to attach (Under Contract Seller, Ready To Market, Buyer Under Contract)' : requireDeal ? 'Pick a deal to send it to…' : 'No deal — just a message'}</option>
                  {deals.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                {deal && <span style={{ display: 'block', marginTop: 5, font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>Fills {'{{address}} {{city}} {{asking_price}} {{arv}} {{marketing_link}}'} and the rest of the deal&apos;s fields.</span>}
              </label>
            )}

            {channel === 'rvm' ? (
              <RvmRecordingPicker workspaceId={workspaceId} value={rvmClip?.id ?? null} label="Voicemail to drop"
                defaultName={deal ? `RVM · ${deal.fields.address || deal.label}` : kind === 'buyer' ? 'Buyer voicemail' : 'Voicemail'}
                onChange={(c) => { setRvmClip(c); setConfirming(false); }} disabled={progress !== null} />
            ) : (
            <div className="flex flex-col gap-2">
              <span style={label}>Message</span>
              {tpl ? (
                <div className="flex flex-col gap-2 rounded-xl p-3" style={{ border: '1px solid rgba(10, 133, 96,.3)', background: 'var(--accent-soft)' }}>
                  <span className="flex items-center gap-2">
                    <Icon name="template" size={13} style={{ color: 'var(--accent)' }} />
                    <span className="mr-auto truncate" style={{ font: '600 12.5px/1.2 var(--sans)' }}>{tpl.name}</span>
                    <span style={{ font: '700 11px/1 var(--sans)', color: 'var(--accent)' }}>Designed</span>
                  </span>
                  <span style={{ font: '400 11.5px/1.45 var(--sans)', color: 'var(--muted)' }}>
                    This one has its own HTML, so it goes out exactly as designed. Edit it in Templates; here you can change the subject.
                  </span>
                  <div className="flex gap-2">
                    <Button tone="ghost" className="dc2" onClick={() => setPicking(true)} style={{ padding: '7px 11px' }}>Pick another</Button>
                    <Button tone="ghost" className="dc2" onClick={writeMyOwn} style={{ padding: '7px 11px' }}><Icon name="edit" size={12} /> Write my own</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button tone="ghost" className="dc2" onClick={() => setPicking(!picking)} style={{ padding: '7px 11px' }}>
                      <Icon name="template" size={13} /> {picking ? 'Hide templates' : 'Use a template'}
                    </Button>
                    {body.trim() && <Button tone="ghost" className="dc2" onClick={() => setBody(channel === 'sms' ? SMS_START : EMAIL_START)} style={{ padding: '7px 11px' }}>Clear</Button>}
                  </div>
                  {channel === 'email' && (
                    <label><span style={label}>Subject</span>
                      <input style={input} value={subject} onChange={(e) => { setSubject(e.target.value); setConfirming(false); }} {...track(setSubject)} placeholder="Off market in {{city}} — {{asking_price}}" /></label>
                  )}
                  <textarea
                    rows={channel === 'sms' ? 5 : 9}
                    style={{ ...input, resize: 'vertical', lineHeight: 1.45 }}
                    value={body}
                    onChange={(e) => { setBody(e.target.value.slice(0, channel === 'sms' ? MAX_BODY : 20000)); setConfirming(false); }}
                    {...track(setBody)}
                    placeholder={channel === 'sms' ? 'Hi {{first_name}}, new deal at {{address}} — interested?' : 'Hi {{first_name}},\n\nWe just picked up {{address}}…'}
                  />
                  <MergeChips fields={MERGE_FIELDS} onInsert={insert} />
                  {channel === 'email' && <span style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>Your words go out in the same branded shell a template uses, signed as you.</span>}
                </>
              )}

              {picking && (
                <div className="flex flex-col gap-2 rounded-xl p-2.5" style={{ border: '1px solid var(--line)', background: 'var(--panel)' }}>
                  <TemplateFilters f={{ ...f, channel }} set={(p) => setF((cur) => ({ ...cur, ...p }))} team={t.team} lockChannel />
                  <div className="flex max-h-64 flex-col overflow-auto">
                    {t.error && <p className="p-2" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--red)' }}>{t.error}</p>}
                    {!t.error && !t.loading && shown.length === 0 && <p className="p-2" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>No {channel === 'sms' ? 'SMS' : 'email'} template matches. Write one here instead.</p>}
                    {shown.map((x) => (
                      <button key={x.id} type="button" onClick={() => pickTemplate(x)} className="lift-row flex w-full flex-col gap-1 px-2 py-2 text-left" style={{ borderBottom: '1px solid var(--panel-2)', cursor: 'pointer' }}>
                        <span className="flex items-center gap-2">
                          <span className="mr-auto truncate" style={{ font: '600 12.5px/1.2 var(--sans)' }}>{x.name}</span>
                          {x.body_html && <span style={{ font: '700 11px/1 var(--sans)', color: 'var(--accent)' }}>Designed</span>}
                        </span>
                        <span className="truncate" style={{ font: '400 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>{x.subject ? `${x.subject} — ` : ''}{x.body_text.replace(/\s+/g, ' ').slice(0, 120)}</span>
                        <span style={{ font: '500 10px/1 var(--sans)', color: 'var(--muted-2)' }}>{ownerLabel(x, userId, t.team)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            )}

            <div className="flex min-h-0 flex-col gap-1.5">
              <span style={label}>Recipients · {go.length} getting it{skipped.length ? `, ${skipped.length} skipped` : ''}</span>
              <div className="flex flex-col overflow-auto rounded-xl" style={{ border: '1px solid var(--line)', background: 'var(--panel)', maxHeight: 280 }}>
                {rows.map((r) => (
                  <span key={r.id} className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: '1px solid var(--panel-2)', opacity: r.skip ? 0.55 : 1 }}>
                    <Icon name={r.skip ? 'x' : 'check'} size={12} style={{ color: r.skip ? 'var(--muted-2)' : 'var(--accent)', flex: 'none' }} />
                    <span className="mr-auto truncate" style={{ font: '500 12px/1.3 var(--sans)' }}>{r.name}</span>
                    <span className="truncate" style={{ font: '400 11px/1.3 var(--sans)', color: 'var(--muted)', maxWidth: '45%' }}>{r.skip ?? r.to}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right: what lands ──────────────────────────────────────── */}
          <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4" style={{ background: 'var(--panel-2)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto" style={label}>{sample ? `Preview · as ${go[0].name} gets it` : 'Preview'}</span>
              {channel === 'email' && preview && <SpamRiskBadge subject={preview.subject} html={preview.html} text={preview.text} recipients={go.length} kind="bulk" />}
              {channel === 'email' && (
                <>
                  <span style={segWrap}>
                    <button type="button" style={seg(width === 'desktop')} onClick={() => setWidth('desktop')}>Desktop</button>
                    <button type="button" style={seg(width === 'mobile')} onClick={() => setWidth('mobile')}>Mobile</button>
                  </span>
                  <Button tone="ghost" className="dc2" disabled={!testTo || testing || !preview} title={testTo ? `Sends to ${testTo} from your Gmail` : 'Connect Gmail to send a test'} onClick={() => void sendTest()} style={{ padding: '7px 11px' }}>
                    <Icon name="send" size={13} /> {testing ? 'Sending…' : 'Send test to me'}
                  </Button>
                </>
              )}
            </div>

            {!sample ? (
              <p style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--muted)' }}>Nobody in the selection can be reached on this channel, so there is nothing to preview.</p>
            ) : channel === 'rvm' ? (
              <div className="flex flex-col gap-2 rounded-xl p-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }} data-testid="rvm-preview">
                {rvmClip ? (
                  <>
                    <span style={{ font: '600 13px/1.3 var(--sans)' }}>Plays “{rvmClip.name}”{rvmClip.seconds ? ` · ${clipClock(rvmClip.seconds)}` : ''}</span>
                    <span style={{ font: '400 12px/1.45 var(--sans)', color: 'var(--muted)' }}>Every one of the {go.length} drop{go.length === 1 ? '' : 's'} plays this recording, between 8am and 8pm their time, Monday to Saturday.</span>
                  </>
                ) : (
                  <span style={{ font: '400 12px/1.45 var(--sans)', color: 'var(--muted)' }}>Pick a saved recording or record one on the left. Use Play to hear it.</span>
                )}
                <RvmCheck check={rvmCheck} loading={rvmChecking} error={facts?.error ?? null} live={live} />
              </div>
            ) : channel === 'sms' ? (
              <>
                <div className="flex flex-col rounded-xl p-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)', minHeight: 140 }}>
                  {smsOut.trim() ? <Bubble mine tail maxWidth="85%">{smsOut}</Bubble> : <span style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted-2)' }}>Type a message to preview it.</span>}
                </div>
                <p style={{ font: '500 11px/1.4 var(--sans)', color: s.segments > 1 && s.encoding === 'ucs2' ? 'var(--amber)' : 'var(--muted-2)' }}>
                  {s.chars} chars · {s.segments} segment{s.segments === 1 ? '' : 's'} each · {s.encoding === 'ucs2' ? `UCS-2 (${culprit && /\p{Extended_Pictographic}/u.test(culprit) ? 'an emoji' : `“${culprit}”`}) — 70 per segment` : 'GSM-7'} · {go.length} recipient{go.length === 1 ? '' : 's'}
                </p>
              </>
            ) : (
              <div className="mx-auto flex w-full flex-col overflow-hidden rounded-xl" style={{ maxWidth: width === 'desktop' ? 680 : 390, background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-rest)', transition: 'max-width .18s ease' }}>
                <div className="flex flex-col gap-1 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
                  <span style={{ font: '700 14px/1.3 var(--sans)' }}>{preview?.subject || <span style={{ color: 'var(--muted-2)' }}>(no subject)</span>}</span>
                  <span style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>{[rep.repName, rep.repEmail && `<${rep.repEmail}>`].filter(Boolean).join(' ') || 'You'} → {go[0].name} &lt;{go[0].to}&gt;</span>
                </div>
                {/* Our own markup, merged with escaped values, sandboxed with no scripts. */}
                <EmailHtml html={preview?.html ?? ''} title="Email preview" scrollHeight={620} />
              </div>
            )}
          </div>
        </div>
      )}

      {!result && (
        <footer className="flex flex-wrap items-center gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
          {progress !== null ? (
            <span className="mr-auto" style={{ font: '600 12.5px/1.3 var(--sans)', color: 'var(--accent)' }}>Sending… {progress}/{go.length}</span>
          ) : blocked ? (
            <span className="mr-auto" style={{ font: '500 12.5px/1.3 var(--sans)', color: 'var(--red)' }}>{blocked}</span>
          ) : confirming ? (
            <span className="mr-auto" style={{ font: '500 12.5px/1.4 var(--sans)' }}>
              {channelName(channel)} <b>{who}</b>{deal ? ` about ${deal.fields.address || deal.label}` : ''}{skipped.length ? ` · ${skipped.length} skipped` : ''}. {channel === 'rvm' ? (rvmCheck ? `${previewSentence(rvmCheck, fmtWhen)}.` : 'This sends the ringless voicemail now.') : 'This sends now.'}
            </span>
          ) : (
            <span className="mr-auto" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>
              {channel === 'rvm'
                ? (canWrite ? 'Goes out now from the RVM number pool, a local line first. Anyone outside 8am–8pm their time waits for it.' : 'Sign in to a workspace to send for real.')
                : canWrite
                  ? `Sends as you${channel === 'sms' ? ' through Talkr' : ' from your Gmail'}.`
                  : 'Sign in to a workspace to send for real.'}
            </span>
          )}
          {channel === 'sms' ? <SmsFromPicker compact /> : null}
          <Button tone="ghost" className="dc2" disabled={progress !== null} onClick={onClose}>Cancel</Button>
          {confirming ? (
            <Button tone="accent" className="dc3" disabled={progress !== null} onClick={() => void send()}>
              {progress !== null ? 'Sending…' : `Yes — send ${go.length}`}
            </Button>
          ) : (
            <Button tone="accent" className="dc3" disabled={!ready} onClick={() => setConfirming(true)}>
              <Icon name="send" size={13} /> Review send
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}

/** "Thu 8:00 AM": when a held drop opens, in the viewer's own clock. */
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const TIER_LABEL: Record<string, string> = {
  area_code: 'their own area code', state: 'a line in their state', phone_state: "their phone's state", neighbor: 'a neighbouring state', any: 'any pool line',
};

/** The pre-send check: the tick's rules over this selection, before anything is queued. */
function RvmCheck({ check, loading, error, live }: { check: SendPreview | null; loading: boolean; error: string | null; live: boolean }) {
  const line: React.CSSProperties = { font: '400 12px/1.45 var(--sans)', color: 'var(--muted)' };
  if (!live) return null;
  if (loading) return <span style={line}>Checking quiet hours, do-not-call, recent drops and the pool…</span>;
  if (error) return <span style={{ ...line, color: 'var(--amber)' }}>{error} Every rule still applies when it sends.</span>;
  if (!check) return null;
  const tiers = Object.entries(check.tiers).filter(([, n]) => n);
  const holes = Object.entries(check.noLocalLine).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-1.5" style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--line)' }} data-testid="rvm-check">
      <span style={{ font: '700 11px/1 var(--sans)', color: 'var(--muted)' }}>Before it goes</span>
      <span style={{ font: '600 12.5px/1.45 var(--sans)' }}>{previewSentence(check, fmtWhen)}.</span>
      {check.noPool ? (
        <span style={{ ...line, color: 'var(--amber)' }}>No line is in the RVM number pool, so drops rotate across your main caller lines. An admin can set up the pool under Settings → Phone numbers.</span>
      ) : (
        <span style={line}>
          {check.poolLines} pool line{check.poolLines === 1 ? '' : 's'} can carry {check.poolLeft} more today.
          {tiers.length ? ` Caller ID: ${tiers.map(([t, n]) => `${n} from ${TIER_LABEL[t] ?? t}`).join(', ')}.` : ''}
        </span>
      )}
      {holes.length > 0 && (
        <span style={line}>No pool line in {holes.map(([st, n]) => `${st} (${n})`).join(', ')}: those drop from a neighbouring state&apos;s line, else any line.</span>
      )}
    </div>
  );
}
