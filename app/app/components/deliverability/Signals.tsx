'use client';

// What Gmail itself says (Postmaster Tools), the warm-up provider's view,
// and the pre-campaign checklist built from both plus the domain checks.
//
// In plain words: three boxes in the warm email part of the page.
//   ChecklistCard: the go / no-go list before a buyer blast. Red items stop
//     the send on the server, amber ones are advice.
//   PostmasterCard: Gmail's own report card for the domain (trust level and
//     how often people press Report spam). CLOZR verifies the workspace's
//     domains for it, writing the DNS record itself where it can.
//   WarmupCard: Instantly's warm-up for the cold inboxes (score, inbox vs
//     spam) and InboxKit's health for the same mailboxes.

import React, { useEffect, useState } from 'react';
import { connectGoogle } from '@/lib/google';
import { type DomainVerification, type MailboxRow, type Overview, type Postmaster as PM, type PostmasterDay, type Warmup as WU, type WarmupKeys, campaignChecklist, deliverability, textValue } from '@/lib/deliverability';
import { requestSettingsTab } from '@/app/clozr/screens/settingsTab';
import { Badge, Copy, Icon, Note, NotSetUp, Section, danger, fieldLabel, ghost, input, mono, pct, primary, relDays, row } from './ui';

const REP_TONE = { HIGH: 'good', MEDIUM: 'warn', LOW: 'bad', BAD: 'bad' } as const;
const REP_COLOR: Record<string, string> = { HIGH: '#0A8560', MEDIUM: '#d97706', LOW: '#dc2626', BAD: '#7f1d1d' };

/** Postmaster v2 has no reputation: a day is coloured by its spam rate against Gmail's 0.1% / 0.3% lines. */
const spamColor = (spam: number | null) => (spam == null ? '#a1a1aa' : spam > 0.003 ? '#dc2626' : spam > 0.001 ? '#d97706' : '#0A8560');

/** 30 days as small squares coloured by reputation (or spam rate, on v2), with the spam rate as bar height. */
function Trend({ days }: { days: PostmasterDay[] }) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  // The 30 days up to Postmaster's latest day (it lags a day or two behind today).
  const end = Date.parse(`${days[days.length - 1]?.date ?? '1970-01-01'}T00:00:00Z`);
  const cells = Array.from({ length: 30 }, (_, i) => new Date(end - (29 - i) * 86_400_000).toISOString().slice(0, 10));
  const max = Math.max(0.003, ...days.map((d) => d.spam ?? 0));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '34px', marginTop: '6px' }} aria-label="30-day reputation and spam rate">
      {cells.map((date) => {
        const d = byDate.get(date);
        const h = d?.spam != null ? 6 + 28 * (d.spam / max) : 6;
        return <span key={date} title={d ? `${date}${d.reputation ? ` · reputation ${d.reputation}` : ''} · spam ${pct(d.spam, 2)} · DMARC pass ${pct(d.dmarc, 0)}` : `${date} · no data (too little Gmail volume that day)`} style={{ flex: 1, height: `${h}px`, borderRadius: '2px', background: d ? (d.reputation ? REP_COLOR[d.reputation] : spamColor(d.spam)) : '#f0f0f1' }} />;
      })}
    </div>
  );
}

const VERIFY_LABEL: Record<DomainVerification['status'], { tone: 'good' | 'warn' | 'bad' | 'muted'; text: string }> = {
  verified: { tone: 'good', text: 'Verified' },
  pending: { tone: 'warn', text: 'Waiting on DNS' },
  needs_dns: { tone: 'warn', text: 'Add the TXT record' },
  error: { tone: 'bad', text: 'Not verified' },
  unchecked: { tone: 'muted', text: 'Not checked yet' },
};
const HOST_LABEL = { inboxkit: 'InboxKit DNS', vercel: 'Vercel DNS' } as const;
/** While a domain waits on DNS the card re-checks every minute, up to this many times. */
const MAX_POLLS = 15;

/** One domain Postmaster does not list yet: where verification stands, and the record when it has to be added by hand. */
function VerifyRow({ v }: { v: DomainVerification }) {
  const label = VERIFY_LABEL[v.status] ?? VERIFY_LABEL.unchecked;
  return (
    <div style={{ ...row, padding: '8px 0', fontSize: '12.5px' }}>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{textValue(v.domain)}</span>
        <Badge tone={label.tone}>{label.text}</Badge>
        {v.dns_host ? <span style={{ fontSize: '11.5px', color: '#71717a' }}>TXT written at {HOST_LABEL[v.dns_host]}</span> : null}
        {v.checked_at ? <span style={{ fontSize: '11.5px', color: '#71717a' }}>checked {relDays(v.checked_at)}</span> : null}
      </div>
      {v.status === 'verified'
        ? <p style={{ margin: '4px 0 0', color: '#52525b', lineHeight: 1.5 }}>Add it once at postmaster.google.com. Google already counts it as verified, so it is accepted straight away.</p>
        : textValue(v.detail) ? <p style={{ margin: '4px 0 0', color: v.status === 'error' ? '#b91c1c' : '#52525b', lineHeight: 1.5 }}>{textValue(v.detail)}</p> : null}
      {v.status === 'needs_dns' && textValue(v.txt) ? (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' }}>
          <span style={{ fontSize: '11.5px', color: '#71717a' }}>TXT on {textValue(v.domain)}</span>
          <span style={{ flex: '1 1 220px', minWidth: 0, padding: '6px 8px', border: '1px solid #e4e4e7', borderRadius: '8px', background: '#fafafa', ...mono }}>{textValue(v.txt)}</span>
          <Copy text={textValue(v.txt)} />
        </div>
      ) : null}
    </div>
  );
}

export function PostmasterCard({ workspaceId, me, data, onLoad }: { workspaceId: number; me: MailboxRow | null; data: PM | null; onLoad: (verify?: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [polls, setPolls] = useState(0);
  const connect = async () => {
    setBusy(true); setNote(null);
    const r = await connectGoogle(workspaceId, { postmaster: true });
    setBusy(false);
    setNote(r.ok ? { ok: true, text: 'Postmaster connected. Checking your domains now.' } : { ok: false, text: r.message });
    if (r.ok) await onLoad(true);
  };
  const refresh = async (verify = false) => { setBusy(true); await onLoad(verify); setBusy(false); };
  const verification = data?.verification ?? [];
  const waiting = verification.some((v) => v.status === 'pending');
  // DNS takes minutes to reach Google: re-check while anything is pending, a bounded number of times.
  useEffect(() => {
    if (!waiting || polls >= MAX_POLLS) return;
    const t = window.setTimeout(() => { setPolls((n) => n + 1); void onLoad(false); }, 60_000);
    return () => window.clearTimeout(t);
  }, [waiting, polls, onLoad]);

  const how = <>Gmail&apos;s own numbers for your domain: the spam-complaint rate (the one signal a mailbox cannot see), authentication pass rates and delivery errors. Google&apos;s current Postmaster API no longer reports domain reputation. Read-only, from your Google connection; optional. Gmail only reports days with enough mail to Gmail users (roughly a few hundred a day). CLOZR verifies each of this workspace&apos;s domains for your Google account: it asks Google for the TXT record, writes it at InboxKit or Vercel DNS, and checks again until Google sees it. Google has no API for the last step, so a verified domain is added once at postmaster.google.com.</>;
  const why = 'Gmail’s own report card for your domain: how often people press Report spam and how much of your mail passes SPF, DKIM and DMARC. Optional.';

  if (!me) {
    return <NotSetUp title="Gmail Postmaster" why={why} how={how} action={<button type="button" style={ghost} onClick={() => requestSettingsTab({ main: 'outbound', tab: 'google' })}>Connect Google first</button>} />;
  }
  if (!me.postmaster) {
    return (
      <NotSetUp title="Gmail Postmaster" why={why} how={how} action={(
        <>
          <button type="button" style={ghost} disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect Postmaster'}</button>
          <Note note={note} />
        </>
      )} />
    );
  }

  return (
    <Section
      title="Gmail Postmaster"
      why={why}
      how={how}
      actions={(
        <>
          {data?.site_verification && data.unverified.length > 0 ? <button type="button" style={ghost} disabled={busy} onClick={() => void refresh(true)}>{busy ? 'Checking…' : 'Verify domains now'}</button> : null}
          <button type="button" style={ghost} disabled={busy} onClick={() => void refresh()}>{busy ? 'Loading…' : data ? 'Refresh' : 'Load'}</button>
        </>
      )}
    >
      {!data && !busy ? <p style={{ fontSize: '12px', color: '#71717a', margin: 0 }}>Press Load to read the last 30 days from Gmail and check your domains.</p> : null}
      {textValue(data?.error) ? <p role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', margin: 0 }}>{textValue(data?.error)}</p> : null}
      {data && !data.error && !data.domains.length ? <p style={{ fontSize: '12px', color: '#71717a', margin: 0 }}>None of this workspace&apos;s domains are in Postmaster yet.</p> : null}
      {data?.domains.map((d) => {
        const last = [...d.days].reverse().find((x) => x.reputation || x.spam != null) ?? null;
        return (
          <div key={textValue(d.domain)} style={row}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>{textValue(d.domain)}</span>
              {last?.reputation ? <Badge tone={REP_TONE[last.reputation]}>reputation {last.reputation.toLowerCase()}</Badge> : null}
              {last?.spam != null && <Badge tone={last.spam > 0.003 ? 'bad' : last.spam > 0.001 ? 'warn' : 'good'}>spam {pct(last.spam, 2)}</Badge>}
              {last && <span style={{ fontSize: '11.5px', color: '#71717a' }}>SPF {pct(last.spf, 0)} · DKIM {pct(last.dkim, 0)} · DMARC {pct(last.dmarc, 0)} · delivery errors {pct(last.errors, 2)}</span>}
            </div>
            {d.days.length ? <Trend days={d.days} /> : <p style={{ fontSize: '12px', color: '#71717a', margin: '4px 0 0' }}>No data in the last 30 days. Gmail only reports days with enough mail to Gmail users (roughly a few hundred a day).</p>}
            {last?.error_types.length ? <p style={{ fontSize: '11.5px', color: '#b91c1c', margin: '4px 0 0' }}>{last.error_types.map(textValue).filter(Boolean).join(' · ')}</p> : null}
          </div>
        );
      })}
      {data?.granted && data.unverified.length > 0 && (
        <div style={{ ...row, paddingBottom: 0 }}>
          <div style={{ fontSize: '12.5px', fontWeight: 600 }}>Not in Postmaster yet ({data.unverified.length})</div>
          {!data.site_verification ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 4px' }}>
              <p style={{ margin: 0, fontSize: '12.5px', color: '#52525b', lineHeight: 1.5, flex: '1 1 260px' }}>Reconnect Postmaster once so CLOZR can verify these for {textValue(me.email)} and write the DNS records itself. Google asks for one more permission (verify your sites).</p>
              <button type="button" style={primary} disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Reconnect Postmaster'}</button>
            </div>
          ) : null}
          {verification.length
            ? verification.map((v) => <VerifyRow key={textValue(v.domain)} v={v} />)
            : <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: '#52525b' }}>{data.unverified.map(textValue).filter(Boolean).join(', ')}</p>}
          {waiting ? <p role="status" style={{ margin: '8px 0 0', fontSize: '12px', color: '#71717a' }}>{polls < MAX_POLLS ? 'Re-checking every minute while DNS catches up.' : 'Still waiting on DNS. Press Verify domains now to check again.'}</p> : null}
        </div>
      )}
      <Note note={note} />
    </Section>
  );
}

const HEALTH_TONE: Record<string, 'good' | 'warn' | 'bad' | 'muted'> = { healthy: 'good', low_activity: 'warn', inactive: 'muted' };

/** Paste or clear the Instantly and InboxKit keys. Both are checked with the vendor before they are stored, sealed. */
function WarmupKeysForm({ workspaceId, keys, onSaved }: { workspaceId: number; keys: WarmupKeys | undefined; onSaved: () => void }) {
  const [inst, setInst] = useState('');
  const [kit, setKit] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (body: Record<string, string | null>, done: string) => {
    setBusy(true); setNote(null);
    const r = await deliverability(workspaceId, 'warmup_keys', body);
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    setInst(''); setKit('');
    setNote({ ok: true, text: done });
    onSaved();
  };
  const source = (own: boolean | undefined, set: boolean | undefined, env: string) => (own ? 'This workspace’s own key is saved.' : set ? `Using the project key (${env}). Save this workspace’s own key to read only its account.` : 'No key yet.');
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <form onSubmit={(e) => { e.preventDefault(); void save({ instantly_key: inst }, 'Instantly key saved.'); }}>
        <label htmlFor={`dlv-instantly-${workspaceId}`} style={fieldLabel}>Instantly API key, v2 (Instantly, Settings, Integrations)</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input id={`dlv-instantly-${workspaceId}`} type="password" autoComplete="off" spellCheck={false} style={{ ...input, flex: '1 1 240px' }} value={inst} onChange={(e) => setInst(e.target.value)} placeholder={keys?.instantly_own ? 'Saved. Paste a new key to replace it' : ''} />
          <button type="submit" style={ghost} disabled={busy || !inst.trim()}>{busy ? 'Checking…' : keys?.instantly_own ? 'Replace key' : 'Save key'}</button>
          {keys?.instantly_own ? <button type="button" style={danger} disabled={busy} onClick={() => { if (window.confirm('Remove the Instantly key? The cold pool warm-up gate reads the same key.')) void save({ instantly_key: null }, 'Instantly key removed.'); }}>Remove</button> : null}
        </div>
        <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#71717a' }}>{source(keys?.instantly_own, keys?.instantly, 'INSTANTLY_API_KEY')} The cold pool&apos;s warm-up gate uses the same key.</p>
      </form>
      <form onSubmit={(e) => { e.preventDefault(); void save({ inboxkit_key: kit }, 'InboxKit key saved.'); }}>
        <label htmlFor={`dlv-inboxkit-key-${workspaceId}`} style={fieldLabel}>InboxKit API key (InboxKit, Settings, API)</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input id={`dlv-inboxkit-key-${workspaceId}`} type="password" autoComplete="off" spellCheck={false} style={{ ...input, flex: '1 1 240px' }} value={kit} onChange={(e) => setKit(e.target.value)} placeholder={keys?.inboxkit_own ? 'Saved. Paste a new key to replace it' : ''} />
          <button type="submit" style={ghost} disabled={busy || !kit.trim()}>{busy ? 'Checking…' : keys?.inboxkit_own ? 'Replace key' : 'Save key'}</button>
          {keys?.inboxkit_own ? <button type="button" style={danger} disabled={busy} onClick={() => { if (window.confirm('Remove the InboxKit key?')) void save({ inboxkit_key: null }, 'InboxKit key removed.'); }}>Remove</button> : null}
        </div>
        <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#71717a' }}>{source(keys?.inboxkit_own, keys?.inboxkit, 'INBOXKIT_API_KEY')} Also used to write DNS records for Postmaster and to import inboxes.</p>
      </form>
      <Note note={note} />
    </div>
  );
}

export function WarmupCard({ workspaceId, admin, keys, data, onLoad, onChange }: { workspaceId: number; admin: boolean; keys: WarmupKeys | undefined; data: WU | null; onLoad: () => Promise<void>; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = () => { setBusy(true); void onLoad().finally(() => setBusy(false)); };
  const saved = () => { setAdding(false); onChange(); void onLoad(); };
  const title = 'Warm-up and mailbox health';
  const how = (
    <>
      <p style={{ margin: '0 0 8px' }}>Instantly runs the warm-up: its network sends and opens mail between inboxes so Gmail and Outlook learn to trust a new mailbox. CLOZR reads Instantly&apos;s health score and where the last 14 days of warm-up mail landed (inbox or spam). InboxKit hosts the inboxes; CLOZR reads its 7-day health (healthy, low activity, inactive) and bounce rate. Keys are stored encrypted and never sent back to the browser.</p>
      <ul style={{ margin: 0, paddingLeft: '18px' }}>
        <li>A score under 90, or more than 3% of warm-up mail in spam, means the inbox is not ready for cold mail. The cold pool holds it until it is.</li>
        <li>The ramp under Gmail inboxes is separate: CLOZR growing a mailbox&apos;s real volume slowly.</li>
        <li>Keep warm-up on once a mailbox is in steady use.</li>
      </ul>
    </>
  );
  const why = 'Instantly warm-up scores and InboxKit health for this workspace’s sending inboxes, in one list.';

  if (!keys?.instantly && !keys?.inboxkit) {
    return (
      <NotSetUp
        title={title}
        why="Add your Instantly key to see warm-up scores and where warm-up mail lands, and your InboxKit key to see mailbox health."
        how={how}
        action={admin ? (adding ? <WarmupKeysForm workspaceId={workspaceId} keys={keys} onSaved={saved} /> : <button type="button" style={ghost} onClick={() => setAdding(true)}>Add your keys</button>) : <p style={{ margin: 0, fontSize: '12.5px', color: '#71717a' }}>An owner or admin adds the Instantly and InboxKit keys.</p>}
      />
    );
  }
  const boxes = data?.mailboxes ?? [];
  return (
    <Section
      title={title}
      why={why}
      how={how}
      actions={<button type="button" style={ghost} disabled={busy} onClick={load}>{busy ? 'Loading…' : data ? 'Refresh' : 'Load status'}</button>}
    >
      {!data && !busy ? <p style={{ fontSize: '12px', color: '#71717a', margin: 0 }}>Press Load status to read {keys.instantly && keys.inboxkit ? 'Instantly and InboxKit' : keys.instantly ? 'Instantly' : 'InboxKit'}.</p> : null}
      {textValue(data?.instantly.error) ? <p role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', margin: '0 0 6px' }}>{textValue(data?.instantly.error)}</p> : null}
      {textValue(data?.inboxkit.error) ? <p role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', margin: '0 0 6px' }}>{textValue(data?.inboxkit.error)}</p> : null}
      {data && !keys.instantly ? <p style={{ fontSize: '12px', color: '#92400e', margin: '0 0 6px' }}>Add your Instantly key below to see warm-up scores and inbox vs spam.</p> : null}
      {data && !keys.inboxkit ? <p style={{ fontSize: '12px', color: '#92400e', margin: '0 0 6px' }}>Add your InboxKit key below to see mailbox health.</p> : null}
      {data && !boxes.length && !data.instantly.error && !data.inboxkit.error ? <p style={{ fontSize: '12px', color: '#71717a', margin: 0 }}>No mailboxes on this workspace&apos;s domains in Instantly or InboxKit yet.</p> : null}
      {boxes.length ? <p role="status" style={{ margin: '0 0 4px', fontSize: '11.5px', color: '#71717a', fontVariantNumeric: 'tabular-nums' }}>{boxes.length} mailbox{boxes.length === 1 ? '' : 'es'} · {boxes.filter((b) => b.warming).length} warming · {boxes.filter((b) => b.score != null && b.score < 90).length} under score 90</p> : null}
      {boxes.map((w) => (
        <div key={textValue(w.email)} style={{ ...row, padding: '8px 0', fontSize: '12.5px' }}>
          <div style={{ display: 'flex', gap: '4px 6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0, marginRight: '2px' }}>{textValue(w.email)}</span>
            {w.instantly
              ? <Badge tone={w.warming ? 'good' : 'warn'}>{w.warming ? 'warming' : 'warm-up off'}</Badge>
              : <Badge tone="muted" title="This inbox is not in Instantly">not in Instantly</Badge>}
            {w.score != null ? <Badge tone={w.score >= 90 ? 'good' : w.score >= 70 ? 'warn' : 'bad'}>score {Math.round(w.score)}</Badge> : null}
            {w.inboxkit ? <Badge tone={HEALTH_TONE[w.health ?? ''] ?? 'muted'} title={w.last_event_at ? `InboxKit, last activity ${new Date(w.last_event_at).toLocaleString()}` : 'InboxKit, no activity in 7 days'}>{(w.health ?? 'inactive').replace('_', ' ')}</Badge> : null}
          </div>
          <div style={{ display: 'flex', gap: '2px 14px', flexWrap: 'wrap', marginTop: '3px', color: '#71717a', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>
            {w.instantly ? <span>Warm-up, 14 days: {w.sent14 ? `${w.sent14} sent · ${pct(w.inbox_pct, 0)} inbox · ${pct(w.spam_pct)} spam` : 'none sent yet'}</span> : null}
            {w.inboxkit && w.sent7 != null ? <span>InboxKit, 7 days: {w.sent7} sent{w.bounce_pct != null ? ` · ${w.bounce_pct.toFixed(1)}% bounced` : ''}</span> : null}
          </div>
        </div>
      ))}
      {admin ? (
        <details style={{ marginTop: '10px' }} open={!keys.instantly || !keys.inboxkit ? true : undefined}>
          <summary style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', fontSize: '12px', fontWeight: 600, color: '#0A8560' }}><Icon name="chevron" size={13} />API keys</summary>
          <div style={{ marginTop: '8px' }}><WarmupKeysForm workspaceId={workspaceId} keys={keys} onSaved={saved} /></div>
        </details>
      ) : null}
    </Section>
  );
}

/** One checklist line: an icon, the check, and what was found. The icon also has words for screen readers. */
function CheckRow({ i }: { i: { label: string; ok: boolean; blocking: boolean; detail: string } }) {
  return (
    <div style={{ ...row, padding: '7px 0', display: 'flex', gap: '4px 8px', alignItems: 'flex-start', flexWrap: 'wrap', fontSize: '12.5px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: '8px', flex: '1 1 240px', minWidth: 0 }}>
        <span style={{ color: i.ok ? '#0A8560' : i.blocking ? '#b91c1c' : '#b45309', display: 'inline-flex', marginTop: '1px' }}><Icon name={i.ok ? 'check' : i.blocking ? 'x' : 'alert'} /></span>
        <span style={{ fontWeight: 500 }}>
          {textValue(i.label)}
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{i.ok ? ', passes' : i.blocking ? ', blocks sending' : ', advice'}</span>
        </span>
      </span>
      <span style={{ color: '#71717a', flex: '1 1 220px', minWidth: 0, paddingLeft: '22px', overflowWrap: 'anywhere' }}>{textValue(i.detail)}</span>
    </div>
  );
}

/**
 * The go / no-go list before a buyer blast. The same items the server checks:
 * a blast is refused while any red one is open.
 */
export function ChecklistCard({ overview, postmaster, accountId, setAccountId }: { overview: Overview; postmaster: PM | null; accountId: number | null; setAccountId: (id: number) => void }) {
  const items = campaignChecklist(overview, postmaster, accountId);
  const blocked = items.filter((i) => i.blocking && !i.ok);
  // Problems on top, so the list reads as "what to fix", then "what is fine".
  const sorted = [...items].sort((a, b) => Number(a.ok) - Number(b.ok) || Number(b.blocking) - Number(a.blocking));
  return (
    <Section
      id="warm-checklist"
      title="Before you send a buyer blast"
      why={blocked.length ? `${blocked.length} red ${blocked.length === 1 ? 'item stops' : 'items stop'} every blast until fixed. Amber items are advice.` : 'Every required check passes. Amber items are advice.'}
      actions={(
        <>
          {!overview.resend?.configured && overview.mailboxes.length > 1 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: '#71717a' }}>Mailbox
              <select style={input} value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
                {overview.mailboxes.map((m) => <option key={m.account_id} value={m.account_id}>{textValue(m.email)}</option>)}
              </select>
            </label>
          )}
          {blocked.length ? <Badge tone="bad">On hold</Badge> : <Badge tone="good">Ready</Badge>}
        </>
      )}
      how={overview.resend?.configured
        ? 'Campaigns send through Resend. Blocking items are enforced on the server: a blast is refused while any of them fails. Gmail on the campaign is Reply-To only.'
        : 'Blocking items are enforced on the server: a bulk or plan email from this mailbox is refused while any of them fails (a bounce-rate breach pauses the mailbox, which blocks it). Postmaster\'s spam rate is advisory here because CLOZR cannot read it at send time. Over 0.3%, stop and fix the list before sending.'}
    >
      {sorted.filter((i) => !i.ok).map((i) => <CheckRow key={i.label} i={i} />)}
      {/* Passing checks fold away: the owner only needs to see what is wrong. */}
      {sorted.some((i) => i.ok) ? (
        <details style={{ marginTop: sorted.some((i) => !i.ok) ? '8px' : 0 }}>
          <summary style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', fontSize: '12px', fontWeight: 600, color: '#0A8560' }}>
            <Icon name="chevron" size={13} />Show the {sorted.filter((i) => i.ok).length} checks that pass
          </summary>
          <div style={{ marginTop: '6px' }}>{sorted.filter((i) => i.ok).map((i) => <CheckRow key={i.label} i={i} />)}</div>
        </details>
      ) : null}
    </Section>
  );
}
