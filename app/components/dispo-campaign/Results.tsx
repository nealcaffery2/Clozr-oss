'use client';

// A deal's campaign results: the funnel in buyers (sent → delivered → viewed →
// replied → offers), the buyers who answered with Call / Text / Open, and each
// campaign with pause, resume and stop. The writes are the old results card's,
// with the same calls: setCampaignStatus, markInterest and the browser-send
// fallback for due texts. On /demo each one is a "(demo)" toast.

import React, { useState } from 'react';
import { type CampaignResults, markInterest, sendDueTexts, setCampaignStatus } from '@/lib/dispo-campaign';
import { formatPhone } from '@/lib/talkr';
import { openReach } from '@/app/components/record/reach';
import { addressRows, channelRows, funnel, pct, plural, repliedBuyers } from './logic';
import { Avatar, Btn, C, Dialog, Disclosure, Eyebrow, Icon, Note, Status, Svg, type Tone } from './ui';
import { PushReview, type ReviewSegment, type ReviewVariant } from './PushReview';
import { pushRecordingUrl } from '@/lib/rvm-recording';

export type BuyerInfo = { name: string; company: string | null; phone: string | null };
export type ResultsProps = {
  workspaceId: number; dealId: number; results: CampaignResults; canWrite: boolean; isMobile: boolean;
  onToast: (m: string) => void; onChanged: () => void; onNew: () => void;
  /** Buyers who opened their tracked link to this deal, when known. */
  viewed: number | null;
  buyer: (id: number) => BuyerInfo | null;
  onCall?: (name: string, phone: string) => void;
  onOpenBuyer?: (id: number) => void;
  demo: boolean;
};

const when = (iso: string | null, tz?: string) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—');
function ago(iso: string | null): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
const STATUS: Record<string, [Tone, string]> = {
  running: ['green', 'Running'], paused: ['amber', 'Paused'], done: ['grey', 'Done'], cancelled: ['grey', 'Stopped'],
  offered: ['green', 'Offered'], interested: ['mint', 'Interested'], replied: ['genius', 'Replied'], not_interested: ['grey', 'Passed'],
  opted_out: ['red', 'Opted out'], stopped: ['grey', 'Stopped'], active: ['grey', 'Waiting'], done_r: ['grey', 'Done'],
};

export function Results({ workspaceId, dealId, results, canWrite, isMobile, onToast, onChanged, onNew, viewed, buyer, onCall, onOpenBuyer, demo }: ResultsProps) {
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [rvmUrls, setRvmUrls] = useState<Record<number, string | null>>({});
  const [allReplies, setAllReplies] = useState(false);
  const [addrOpen, setAddrOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; go: () => void; label: string; danger?: boolean }>(null);
  const { campaigns, recipients, messages } = results;
  const f = funnel(results, results.offers, viewed);
  const rows = channelRows(results);
  const byAddress = addressRows(results);
  const held = messages.filter((m) => m.channel === 'sms' && m.status === 'queued' && /browser send/.test(m.last_error ?? ''));
  const act = async (p: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    if (demo) { onToast(`${done} (demo)`); return; }
    setBusy(true); const r = await p(); setBusy(false);
    onToast(r.ok ? ((r as { message?: string }).message || done) : (r as { message?: string }).message || 'That did not save.'); onChanged();
  };
  const replied = repliedBuyers(results);
  const shownReplies = allReplies ? replied : replied.slice(0, 6);
  const nameOf = (id: number, r?: { phone: string | null; email: string | null }) => buyer(id) ?? { name: r?.phone ? formatPhone(r.phone) : r?.email || `Buyer ${id}`, company: null, phone: r?.phone ?? null };

  const stages: [string, number | null, string][] = [
    ['Sent', f.sent, 'buyers'], ['Delivered', f.delivered, pct(f.delivered, f.sent)], ['Viewed', f.viewed, f.viewed == null ? 'needs tracked links' : pct(f.viewed, f.sent)],
    ['Replied', f.replied, pct(f.replied, f.sent)], ['Offers', f.offers, pct(f.offers, f.sent)],
  ];

  return (
    <div style={{ display: 'grid', gap: '14px' }} data-testid="results">
      <section className="mk-card" aria-label="Campaign results" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <Eyebrow>Campaign results</Eyebrow>
            <div style={{ fontSize: '12.5px', color: C.muted2, marginTop: '3px' }} className="mk-num">{plural(campaigns.length, 'campaign')} · {plural(new Set(recipients.map((r) => r.buyer_id)).size, 'buyer')} reached</div>
          </div>
          <div style={{ flex: 1 }} />
          <Btn onClick={onChanged} aria-label="Refresh results" title="Refresh"><Svg d={Icon.refresh} size={13} />{isMobile ? null : 'Refresh'}</Btn>
          <Btn kind="primary" onClick={onNew} data-testid="new-campaign"><Svg d={Icon.plus} size={13} />New campaign</Btn>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0,1fr))' : 'repeat(5, minmax(0,1fr))', borderTop: `1px solid ${C.line2}` }} data-testid="funnel">
          {stages.map(([k, v, sub], i) => (
            <div key={k} style={{ padding: '12px 16px', borderRight: `1px solid ${C.line2}`, borderBottom: isMobile ? `1px solid ${C.line2}` : 0, gridColumn: isMobile && i === 4 ? 'span 2' : undefined }}>
              <Eyebrow>{k}</Eyebrow>
              <div className="mk-num" style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.03em', marginTop: '4px', color: v == null ? C.subtle : C.ink }}>{v == null ? '—' : v.toLocaleString('en-US')}</div>
              <div className="mk-bar" style={{ height: '4px', margin: '6px 0 4px' }}><span style={{ transform: `scaleX(${v && f.sent ? Math.min(1, v / f.sent) : 0})`, background: k === 'Offers' ? 'var(--c-money)' : undefined }} /></div>
              <div className="mk-num" style={{ fontSize: '11px', color: C.subtle }}>{sub}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', padding: '10px 16px', borderTop: `1px solid ${C.line2}`, fontSize: '12px', color: C.muted }} className="mk-num">
          {rows.map((r) => (
            <span key={r.ch} style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
              <Svg d={r.ch === 'sms' ? Icon.text : r.ch === 'email' ? Icon.mail : Icon.phone} size={13} color={r.ch === 'sms' ? 'var(--c-talkr)' : C.muted} />
              <b style={{ color: C.ink }}>{r.ch === 'sms' ? 'Text' : r.ch === 'email' ? 'Email' : r.ch === 'rvm' ? 'Voicemail' : 'AI call'}</b>
              {r.sent} sent{r.delivered != null ? ` · ${r.delivered} delivered` : ''} · {r.replied} replied{r.queued ? ` · ${r.queued} queued` : ''}
              {r.failed ? <span style={{ color: C.red }}> · {r.failed} failed</span> : null}
            </span>
          ))}
          <span>Interested <b style={{ color: C.ink }}>{f.interested}</b></span>
          <span>Opted out <b style={{ color: C.ink }}>{f.optedOut}</b></span>
        </div>
        {byAddress.length > 1 ? (
          <div style={{ padding: '0 16px 10px' }}>
            <Disclosure title={`By sending address · ${byAddress.length}`} open={addrOpen} onToggle={() => setAddrOpen((o) => !o)} testId="by-address-toggle">
              <div style={{ display: 'grid', gap: '2px', fontSize: '12px', color: C.muted }} className="mk-num" data-testid="by-address">
                {byAddress.map((a) => (
                  <div key={a.from} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{ color: C.ink, minWidth: '220px' }}>{a.from}</span>
                    <span>{a.sent} sent · {a.replied} replied ({pct(a.replied, a.sent)}){a.failed ? <span style={{ color: C.red }}> · {a.failed} failed</span> : null}</span>
                  </div>
                ))}
              </div>
            </Disclosure>
          </div>
        ) : null}
        {held.length && canWrite ? (
          <div style={{ padding: '0 16px 12px' }}>
            <Note level="warn" action={<Btn size="sm" kind="primary" disabled={busy} onClick={() => {
              // Every campaign with a held text, not just the first one found.
              const due = campaigns.filter((x) => held.some((m) => m.campaign_id === x.id));
              if (!due.length) return;
              setConfirm({
                title: `Send ${plural(held.length, 'due text')} now?`, label: 'Send them now',
                body: 'Server texting is not configured, so these waited for a signed-in rep. They go from this browser, as you, through Talkr.',
                go: () => void act(async () => {
                  let sent = 0; const failed: string[] = [];
                  for (const c of due) {
                    const r = await sendDueTexts(workspaceId, c);
                    if (!r.ok) failed.push(r.message); else { sent += r.data.sent; failed.push(...r.data.failed); }
                  }
                  return failed.length ? { ok: sent > 0, message: `${sent} sent · ${failed.length} failed: ${failed[0]}` } : { ok: true, message: '' };
                }, 'Due texts sent'),
              });
            }}>Send {held.length} now</Btn>}>{plural(held.length, 'text')} are due and waiting for a rep to send them.</Note>
          </div>
        ) : null}
      </section>

      <section className="mk-card" aria-label="Buyers who replied" style={{ overflow: 'hidden' }} data-testid="replies">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: `1px solid ${C.line2}` }}>
          <Eyebrow>Replied</Eyebrow>
          <span className="mk-num" style={{ fontSize: '12px', color: C.muted2 }}>{replied.length}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: '11.5px', color: C.muted2 }}>Newest first</span>
        </div>
        {replied.length ? null : <div style={{ padding: '18px 16px', fontSize: '12.5px', color: C.muted2 }}>No replies yet. Replies to a campaign text or email land here and in the Inbox.</div>}
        {shownReplies.map((r) => {
          const who = nameOf(r.buyer_id, r);
          const [tone, label] = STATUS[r.status] ?? ['grey', r.status];
          const phone = who.phone || r.phone;
          return (
            <div key={r.id} className="mk-row" style={{ display: 'grid', gridTemplateColumns: isMobile ? '32px minmax(0,1fr)' : '32px minmax(0,1fr) auto auto', gap: '10px', alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${C.line2}` }}>
              <Avatar name={who.name} />
              <div style={{ minWidth: 0, fontSize: '12.5px' }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0 }}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who.company || who.name}</b>
                  {who.company ? <span style={{ color: C.muted2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{who.name}</span> : null}
                </div>
                <div style={{ fontSize: '11.5px', color: C.muted2 }}>Replied by {r.replied_channel === 'email' ? 'email' : 'text'} · {ago(r.replied_at)}</div>
              </div>
              <div style={{ gridColumn: isMobile ? '2' : undefined }}><Status tone={tone}>{label}</Status></div>
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', gridColumn: isMobile ? '2' : undefined }}>
                <Btn size="sm" kind="talkr" disabled={!phone || !onCall} title={phone ? `Call ${who.name}` : 'No phone number on file'} onClick={() => phone && onCall?.(who.company ? `${who.name} · ${who.company}` : who.name, phone)}>Call</Btn>
                <Btn size="sm" kind="talkr" disabled={!phone} title={phone ? `Text ${who.name}` : 'No phone number on file'} onClick={() => phone && openReach('text', { name: who.name, phone, buyerId: r.buyer_id, audience: 'buyer' })}>Text</Btn>
                <Btn size="sm" kind="quiet" disabled={!onOpenBuyer} onClick={() => onOpenBuyer?.(r.buyer_id)}>Open buyer →</Btn>
              </div>
            </div>
          );
        })}
        {replied.length > shownReplies.length ? <div style={{ padding: '10px 16px' }}><Btn size="sm" onClick={() => setAllReplies(true)}>Show all {replied.length}</Btn></div> : null}
      </section>

      <section className="mk-card" aria-label="Campaigns" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.line2}` }}><Eyebrow>Campaigns</Eyebrow></div>
        {campaigns.map((c) => {
          const rs = recipients.filter((r) => r.campaign_id === c.id);
          const ms = messages.filter((m) => m.campaign_id === c.id);
          const done = ms.filter((m) => m.sent_at).length;
          const next = ms.filter((m) => m.status === 'queued').sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at))[0];
          const [tone, label] = STATUS[c.status] ?? ['grey', c.status];
          const cf = funnel(results, 0, null, c.id);
          return (
            <div key={c.id} style={{ borderBottom: `1px solid ${C.line2}` }} data-testid="campaign-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: '13px' }}>Launched {when(c.created_at)}</b>
                    <Status tone={tone}>{label}</Status>
                  </div>
                  <div className="mk-num" style={{ fontSize: '12px', color: C.muted2, marginTop: '3px' }}>
                    {plural(rs.length, 'buyer')} · {done.toLocaleString('en-US')} of {plural(ms.length, 'message')} sent · {cf.replied} replied
                    {' · '}{next ? <>next send {when(next.send_at, c.timezone)}{next.last_error ? <span style={{ color: '#92400e' }}> · {next.last_error}</span> : null}</> : 'nothing queued'}
                  </div>
                  <div className="mk-bar" style={{ height: '4px', marginTop: '8px', maxWidth: '420px' }}><span style={{ transform: `scaleX(${ms.length ? done / ms.length : 0})` }} /></div>
                </div>
                {canWrite && c.status === 'running' ? <Btn disabled={busy} onClick={() => void act(() => setCampaignStatus(c.id, 'paused'), 'Campaign paused')}>Pause</Btn> : null}
                {canWrite && c.status === 'paused' ? <Btn disabled={busy} onClick={() => void act(() => setCampaignStatus(c.id, 'running'), 'Campaign resumed')}>Resume</Btn> : null}
                {canWrite && (c.status === 'running' || c.status === 'paused') ? (
                  <Btn kind="danger" disabled={busy} onClick={() => setConfirm({
                    title: 'Stop this campaign?', label: 'Stop campaign', danger: true,
                    body: `Every queued message is cancelled${next ? `, starting with the one due ${when(next.send_at, c.timezone)}` : ''}. Replies still come in. This cannot be undone; pause instead to hold it.`,
                    go: () => void act(() => setCampaignStatus(c.id, 'cancelled'), 'Campaign cancelled'),
                  })}>Stop</Btn>
                ) : null}
              </div>
              <div style={{ padding: '0 16px 10px' }}>
                <Disclosure title="Buyers" summary={`${rs.length} · mark who is interested`} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)}>
                  <div className="mk-list" style={{ maxHeight: '360px', display: 'grid' }}>
                    {rs.map((r) => {
                      const mine = ms.filter((m) => m.recipient_id === r.id);
                      const who = nameOf(r.buyer_id, r);
                      const failed = mine.find((m) => m.status === 'failed');
                      const [t, l] = STATUS[r.status] ?? ['grey', r.status];
                      return (
                        <div key={r.id} style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr) auto' : 'minmax(0,1fr) auto auto', gap: '8px', alignItems: 'center', fontSize: '12px', padding: '7px 0', borderBottom: `1px solid ${C.line2}` }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <b>{who.company || who.name}</b> <span className="mk-num" style={{ color: C.muted2 }}>· {mine.filter((m) => m.sent_at).length}/{mine.length} sent{r.replied_at ? ` · replied ${when(r.replied_at)}` : ''}</span>
                            {failed ? <span style={{ color: C.red }}> · {failed.last_error}</span> : null}
                          </span>
                          <Status tone={t}>{l}</Status>
                          {canWrite ? (
                            <span style={{ display: 'flex', gap: '4px', gridColumn: isMobile ? '1 / -1' : undefined }}>
                              <Btn size="sm" disabled={busy} onClick={() => void act(() => markInterest(dealId, r.buyer_id, r.id, true), 'Marked interested')}>Interested</Btn>
                              <Btn size="sm" disabled={busy} onClick={() => void act(() => markInterest(dealId, r.buyer_id, r.id, false), 'Marked not interested')}>Not interested</Btn>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </Disclosure>
                <Disclosure title="What was sent" summary="every segment and message in this push" open={reviewId === c.id} onToggle={() => {
                  const next = reviewId === c.id ? null : c.id;
                  setReviewId(next);
                  const path = sentRecordingPath(c.settings);
                  if (next && path && !demo && rvmUrls[c.id] === undefined) void pushRecordingUrl(path).then((u) => setRvmUrls((x) => ({ ...x, [c.id]: u })));
                }} testId="sent-review">
                  {reviewId === c.id ? <SentReview settings={c.settings} rs={rs} ms={ms} buyer={nameOf} audioUrl={rvmUrls[c.id] ?? null} /> : null}
                </Disclosure>
              </div>
            </div>
          );
        })}
      </section>

      {confirm ? (
        <Dialog title={confirm.title} onClose={() => setConfirm(null)} actions={
          <>
            <Btn onClick={() => setConfirm(null)} data-autofocus>Keep it</Btn>
            <Btn kind={confirm.danger ? 'danger' : 'primary'} onClick={() => { confirm.go(); setConfirm(null); }}>{confirm.label}</Btn>
          </>
        }>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: C.muted }}>{confirm.body}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- after launch
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const sentRecordingPath = (settings: unknown): string => {
  const rec = obj(obj(obj(settings).brief).rvmRecording);
  return typeof rec.path === 'string' ? rec.path : '';
};
const KIND_TITLE = { intro: 'Intro text', brief: 'Deal brief', followup: 'Follow-up' } as const;

/** The launched push, read back from what was queued: its segments as saved, and one real message per kind and channel. */
function SentReview({ settings, rs, ms, buyer, audioUrl }: {
  settings: unknown; rs: CampaignResults['recipients']; ms: CampaignResults['messages'];
  buyer: (id: number) => { name: string }; audioUrl: string | null;
}) {
  const saved = Array.isArray(obj(settings).segments) ? (obj(settings).segments as unknown[]).map(obj) : [];
  const segments: ReviewSegment[] = saved.length
    ? saved.map((x, i) => ({ key: String(x.key ?? i), label: String(x.label ?? 'Segment'), count: Number(x.count) || 0, detail: 'As launched' }))
    : [{ key: 'buyers', label: 'Buyers', count: rs.length, detail: 'Everyone this campaign was queued for' }];
  const groups = new Map<string, CampaignResults['messages']>();
  for (const m of [...ms].sort((a, b) => a.id - b.id)) {
    const k = `${m.kind}:${m.channel}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const order = ['intro:sms', 'brief:sms', 'brief:email', 'followup:sms', 'followup:email'];
  const variants: ReviewVariant[] = Array.from(groups.entries())
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([k, list]) => {
      const [kind, channel] = k.split(':') as ['intro' | 'brief' | 'followup', 'sms' | 'email' | 'rvm' | 'ai_call'];
      const first = list[0];
      const versions = new Set(list.map((m) => m.body)).size;
      const who = new Set(list.map((m) => m.recipient_id)).size;
      return {
        key: `sent-${kind}-${channel}`, channel, title: `${KIND_TITLE[kind]} by ${channel === 'sms' ? 'text' : channel === 'email' ? 'email' : channel === 'rvm' ? 'voicemail' : 'AI call'}`, reach: who,
        note: `${buyer(first.buyer_id).name}'s, as queued${versions > 1 ? ` · ${versions} versions across the push` : ''} · ${list.filter((m) => m.sent_at).length} of ${list.length} sent`,
        subject: first.subject ?? null, body: first.body,
      };
    });
  const brief = obj(obj(settings).brief);
  if (brief.rvm) {
    const rec = obj(brief.rvmRecording);
    variants.push({
      key: 'sent-rvm', channel: 'rvm', title: 'Ringless voicemail', reach: Number(brief.rvmQueued) || 0,
      note: 'Queued at launch. The script is the template; merge fields were filled per buyer.',
      body: typeof brief.rvmBody === 'string' ? brief.rvmBody : '', audioUrl, seconds: typeof rec.seconds === 'number' ? rec.seconds : null,
    });
  }
  return <PushReview title="What this push sent" sample={null} segments={segments} variants={variants} testId="sent-push-review" />;
}
