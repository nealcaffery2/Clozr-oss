'use client';

// Settings → Outbound OS → Cold email. A workspace owns the mailboxes.
// Campaigns enroll buyers (a tag or a saved Buyers view), not a deal.
//
// In plain words: cold email is first-contact email to buyers who have never
// heard from us, sent from separate "outreach" inboxes on spare domains so a
// spam complaint can never hurt the company's main address. This file draws
// the boxes for those inboxes: which ones exist and whether they are healthy,
// their warmup (the two weeks of practice mail before they may send), the
// campaigns, the safety rules, and last week's numbers. The page above
// (DeliverabilitySettings) loads the data once and hands it in here. Each
// domain's DNS report lives once, under Sending domains (Domains.tsx); the
// inbox list links there instead of repeating it.

import React, { useState } from 'react';
import { LOCKED_SENDING_DOMAINS, type ColdMailbox, type ColdOverview, type InboxRead, type WarmupReading, type WarmupSync, coldPool, coldReadiness } from '@/lib/cold-pool';
import { textValue } from '@/lib/deliverability';
import { type DomainGroup, groupByDomain, healthLine, mailboxIssue, mailboxPill, overLimit, shortDate } from '@/lib/deliverability-summary';
import { Badge, Icon, Note, NotSetUp, Section, card, fieldLabel, fullDate, ghost, goTo, input, pct, primary, relDays, sub } from './ui';
import { domainAnchor } from './Domains';

type StepDraft = { delay_business_days: number; subject: string; body: string; bSubject: string; bBody: string };
type Where = 'inboxes' | 'warmup' | 'campaigns' | 'rules';
type Run = (action: string, body: Record<string, unknown>, where: Where) => Promise<{ ok: boolean }>;
type Notes = { where: Where; ok: boolean; text: string } | null;

const emptyStep = (): StepDraft => ({ delay_business_days: 2, subject: '', body: '', bSubject: '', bBody: '' });
const metaText: React.CSSProperties = { fontSize: '12px', color: 'var(--meta, #71717a)', fontVariantNumeric: 'tabular-nums' };

export function ColdPool({ workspaceId, demo, data, err, reload }: { workspaceId: number; demo: boolean; data: ColdOverview | null; err: string | null; reload: () => Promise<void> }) {
  const [note, setNote] = useState<Notes>(null);

  // Every save goes through here: call the cold-pool function, say what
  // happened next to the box that asked, and reload so the rows are fresh.
  const run: Run = async (action, body, where) => {
    setNote(null);
    const r = await coldPool(workspaceId, action, body);
    setNote(r.ok ? { where, ok: true, text: 'Saved.' } : { where, ok: false, text: r.message });
    if (r.ok) await reload();
    return r;
  };
  const say = (where: Where) => (n: { ok: boolean; text: string } | null) => setNote(n ? { where, ...n } : null);
  const noteFor = (where: Where) => (note?.where === where ? note : null);

  if (demo) return <NotSetUp title="Outreach inboxes" why="Cold email needs the live database. Sign in to a real workspace to see it." />;
  if (err && !data) {
    return (
      <section style={card} aria-label="Outreach inboxes">
        <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>Couldn&apos;t load cold email: {err.replace(/\.$/, '')}. Nothing was changed.</p>
        <button type="button" style={{ ...ghost, marginTop: '10px' }} onClick={() => void reload()}>Try again</button>
      </section>
    );
  }
  if (!data) {
    return (
      <section style={card} aria-label="Outreach inboxes" aria-busy="true">
        <p role="status" style={{ margin: 0, fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>Loading outreach inboxes…</p>
      </section>
    );
  }

  const admin = data.admin;
  const empty = !data.mailboxes.length && !data.domains.length;
  return (
    <>
      {empty ? (
        <NotSetUp
          id="cold-inboxes"
          title="Outreach inboxes"
          why="No outreach inboxes yet. Buy a few on spare domains (InboxKit sells them ready to use), then bring them in here."
          how={<AddInboxesHelp data={data} />}
          action={admin ? <AddInboxes workspaceId={workspaceId} data={data} say={say('inboxes')} reload={reload} /> : <p style={{ ...sub, margin: 0 }}>Ask an owner or admin to add them.</p>}
        />
      ) : (
        <Inboxes workspaceId={workspaceId} data={data} run={run} say={say('inboxes')} reload={reload} note={noteFor('inboxes')} />
      )}
      {empty ? null : <Warmup workspaceId={workspaceId} data={data} run={run} say={say('warmup')} reload={reload} note={noteFor('warmup')} />}
      {empty ? null : <Campaigns data={data} run={run} note={noteFor('campaigns')} />}
      <Rules data={data} run={run} note={noteFor('rules')} />
      {empty ? null : <Health data={data} />}
      {empty ? <Note note={noteFor('inboxes')} /> : null}
    </>
  );
}

/* ---- Inboxes, grouped by domain --------------------------------------------------- */

/**
 * The list of outreach inboxes, one line per domain. Opening a domain shows
 * its inboxes. Anything that needs the owner floats to the top and starts
 * open, so a healthy pool reads as nine short lines.
 */
function Inboxes({ workspaceId, data, run, say, reload, note }: { workspaceId: number; data: ColdOverview; run: Run; say: (n: { ok: boolean; text: string } | null) => void; reload: () => Promise<void>; note: Notes }) {
  const minDays = data.warmup.gate?.min_days ?? 14;
  const groups = groupByDomain(data);
  // When each inbox may send, or reaches full volume: the same read the status line uses.
  const reads = new Map(coldReadiness(data).inboxes.map((i) => [i.id, i]));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (g: DomainGroup) => open[g.name] ?? g.level === 'problem';
  const count = data.mailboxes.length;
  return (
    <Section
      id="cold-inboxes"
      title={`Outreach inboxes (${count})`}
      why="The inboxes that send cold email, grouped by domain. They live on spare domains so a spam complaint never touches your main company address."
      how={<AddInboxesHelp data={data} />}
    >
      <div role="list" style={{ borderTop: '1px solid var(--divider-2, #f0f0f1)' }}>
        {groups.map((g) => (
          <DomainRow key={g.name} g={g} open={isOpen(g)} toggle={() => setOpen((cur) => ({ ...cur, [g.name]: !isOpen(g) }))} data={data} run={run} minDays={minDays} reads={reads} />
        ))}
      </div>
      {data.admin ? (
        <details style={{ marginTop: '12px' }}>
          <summary style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', fontSize: '12px', fontWeight: 600, color: 'var(--tx-mint, #0a8560)' }}>
            <Icon name="chevron" size={13} />Add inboxes
          </summary>
          <div style={{ marginTop: '10px' }}><AddInboxes workspaceId={workspaceId} data={data} say={say} reload={reload} /></div>
        </details>
      ) : null}
      <Note note={note} />
    </Section>
  );
}

function DomainRow({ g, open, toggle, data, run, minDays, reads }: { g: DomainGroup; open: boolean; toggle: () => void; data: ColdOverview; run: Run; minDays: number; reads: Map<number, InboxRead> }) {
  const d = g.domain;
  const panel = `dlv-domain-${d?.id ?? 'none'}`;
  return (
    <div role="listitem" style={{ borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '6px 0' }}>
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={panel} style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 240px', minWidth: 0, minHeight: '32px', padding: '0 4px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--ink, #18181b)', borderRadius: '6px' }}>
          <span style={{ color: 'var(--meta, #71717a)', display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .14s cubic-bezier(.23,1,.32,1)' }}><Icon name="chevron" size={14} /></span>
          <span style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={g.name}>{g.name}</span>
          <span style={{ ...metaText, whiteSpace: 'nowrap' }}>{g.mailboxes.length} {g.mailboxes.length === 1 ? 'inbox' : 'inboxes'}</span>
          <span style={{ marginLeft: 'auto' }}><Badge tone={g.pill.tone}>{g.pill.label}</Badge></span>
        </button>
        {d ? <button type="button" style={ghost} onClick={() => goTo(domainAnchor(g.name))}>DNS details</button> : null}
      </div>
      {open ? (
        <div id={panel} style={{ padding: '0 0 8px 26px' }}>
          {g.issue ? <p style={{ margin: '0 0 6px', fontSize: '12px', color: 'var(--tx-red, #b91c1c)', lineHeight: 1.5, maxWidth: '64ch' }}>{g.issue}</p> : null}
          {d ? <p style={{ ...metaText, margin: '0 0 4px' }}>Up to {d.daily_cap} cold emails a day from this domain{d.checked_at ? <> · DNS score {d.score ?? 'n/a'} · <span title={fullDate(d.checked_at)}>checked {relDays(d.checked_at)}</span></> : ''}</p> : null}
          {g.mailboxes.length ? g.mailboxes.map((m) => (
            <MailboxRow key={m.id} m={m} read={reads.get(m.id)} live={data.health.warmup?.[textValue(m.email).toLowerCase()]} gateOn={!!data.warmup.gate?.on} minDays={minDays} admin={data.admin} run={run} />
          )) : <p style={{ ...metaText, margin: 0 }}>No inboxes on this domain yet.</p>}
        </div>
      ) : null}
    </div>
  );
}

/** One outreach inbox: its state in a word, what (if anything) is wrong in plain words, and Pause/Resume. */
function MailboxRow({ m, read, live, gateOn, minDays, admin, run }: { m: ColdMailbox; read?: InboxRead; live?: WarmupReading; gateOn: boolean; minDays: number; admin: boolean; run: Run }) {
  const pill = mailboxPill(m, minDays);
  const issue = mailboxIssue(m, live);
  const when = read?.clears ? `${read.state === 'warming' ? 'ready' : 'full volume'} ${shortDate(new Date(read.clears))}` : '';
  // Paused, broken, or still behind the Instantly gate: allowed 0 cold emails today.
  const blocked = m.paused || m.status === 'error' || (!!m.warmup_gate && !m.warmup_gate.ready && m.status === 'warming');
  const cap = blocked ? 0 : m.daily_cap;
  return (
    <div style={{ padding: '7px 0', borderTop: '1px solid var(--surface-2, #f4f4f5)' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12.5px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>{textValue(m.email)}</span>
        <Badge tone={pill.tone}>{pill.label}</Badge>
        <span style={metaText} title={fullDate(read?.clears)}>{cap} a day{when ? `, ${when}` : ''}</span>
        {admin ? <button type="button" style={{ ...ghost, height: '28px', marginLeft: 'auto' }} onClick={() => void run(m.paused ? 'resume_mailbox' : 'pause_mailbox', { id: m.id }, 'inboxes')}>{m.paused ? 'Resume' : 'Pause'}</button> : null}
      </div>
      {issue ? <p style={{ margin: '3px 0 0', fontSize: '12px', lineHeight: 1.45, maxWidth: '64ch', color: issue.level === 'problem' ? '#b91c1c' : 'var(--muted, #52525b)' }}>{issue.text}</p> : null}
      <WarmupLine mailbox={m} live={live} gateOn={gateOn} />
    </div>
  );
}

/**
 * The warmup read for one mailbox: the stored sync, overridden by the live
 * Instantly reading when the overview fetched one. Words, not colours alone.
 */
function WarmupLine({ mailbox: m, live, gateOn }: { mailbox: ColdMailbox; live?: WarmupReading; gateOn: boolean }) {
  if (!gateOn) return null;
  const score = live?.score ?? m.warmup_score;
  const sent = live?.sent14 ?? m.warmup_sent_14d;
  const spamPct = live ? live.spam_pct : m.warmup_spam_pct;
  // Before Instantly reports anything there is nothing to add to the pill, so say nothing.
  if (score == null && !sent && live?.warming !== null) return null;
  return (
    <p style={{ ...metaText, margin: '2px 0 0' }}>
      Warmup score {score ?? 'not in yet'} · {spamPct == null ? 'no practice mail landed yet' : `${spamPct.toFixed(1)}% of ${sent ?? 0} practice emails went to spam`}
      {live?.warming === null ? ' · not on Instantly' : ''}
    </p>
  );
}

/** The long setup notes for inboxes, moved here from the top of the old page. */
function AddInboxesHelp({ data }: { data: ColdOverview }) {
  return (
    <>
      <p style={{ margin: '0 0 8px' }}>Each inbox starts at 5 cold emails a day and reaches its cap over about 3 weeks, never above 20 a day by default. A domain&apos;s DNS has to pass before its inboxes send. SPF, DKIM, DMARC and MX use the same checker as the rest of Outbound OS. DKIM should be a 2048-bit key: in Google Admin, generate a new 2048-bit record, publish it, then start authentication. A shorter key warns, and a key under 1024 bits fails the check.</p>
      <p style={{ margin: '0 0 8px' }}>Add Google Workspace inboxes from a reseller such as InboxKit with SMTP and IMAP app passwords. A CSV needs email and app_password. Blank hosts use smtp.gmail.com port 587 and imap.gmail.com port 993, and the username is the email address. Spaces in a Google app password are removed. One bad row is skipped. Optional columns: display_name, first_name, last_name, smtp_host, smtp_port, smtp_username, imap_host, imap_port, imap_username, imap_password.</p>
      <p style={{ margin: 0 }}>Google OAuth redirect, when you use it later: {textValue(data.google.redirect_uri) || 'the cold-pool callback'}. Microsoft redirect: {textValue(data.microsoft.redirect_uri) || 'the cold-pool microsoft callback'}.</p>
    </>
  );
}

/** Bring inboxes in from InboxKit, a CSV, Google or Microsoft. Their domains are added with them. Owners and admins only. */
function AddInboxes({ workspaceId, data, say, reload }: { workspaceId: number; data: ColdOverview; say: (n: { ok: boolean; text: string } | null) => void; reload: () => Promise<void> }) {
  const [inboxkitId, setInboxkitId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function importInboxkit() {
    setBusy('inboxkit');
    say(null);
    const body: Record<string, unknown> = {};
    if (inboxkitId.trim()) body.inboxkit_workspace_id = inboxkitId.trim();
    const r = await coldPool<{ listed: number; imported: number; updated: number; skipped: { email: string; reason: string }[] }>(workspaceId, 'import_inboxkit', body);
    setBusy(null);
    if (!r.ok) { say({ ok: false, text: r.message }); return; }
    const skipped = r.data.skipped?.length ?? 0;
    say({ ok: true, text: `InboxKit listed ${r.data.listed}. Added ${r.data.imported}, updated ${r.data.updated}${skipped ? `, skipped ${skipped}` : ''}.` });
    setInboxkitId('');
    await reload();
  }

  async function connect(action: 'google_start' | 'microsoft_start') {
    const r = await coldPool<{ url: string }>(workspaceId, action);
    if (!r.ok) { say({ ok: false, text: r.message }); return; }
    window.location.assign(r.data.url);
  }

  const kit = data.inboxkit;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <label htmlFor="dlv-inboxkit" style={fieldLabel}>Bring in inboxes you bought</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {!kit?.workspace_uid ? (
            <input id="dlv-inboxkit" style={{ ...input, flex: '1 1 220px' }} value={inboxkitId} placeholder="InboxKit workspace id" onChange={(e) => setInboxkitId(e.target.value)} />
          ) : null}
          <button
            type="button"
            style={primary}
            disabled={busy === 'inboxkit' || !kit?.configured || (!kit?.workspace_uid && !inboxkitId.trim())}
            title={!kit?.configured ? 'Add an InboxKit key under Warm-up and mailbox health first' : kit?.workspace_uid ? `Reads InboxKit workspace ${kit.workspace_uid}` : 'Paste the InboxKit workspace id first'}
            onClick={() => void importInboxkit()}
          >
            {busy === 'inboxkit' ? 'Importing…' : 'Import from InboxKit'}
          </button>
          <label className="dlv-file" style={{ ...ghost, display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
            Import CSV
            <input type="file" accept=".csv,text/csv" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void f.text().then(async (csv) => {
                const r = await coldPool<{ imported: number; skipped: { email: string; reason: string }[] }>(workspaceId, 'import_csv', { csv });
                if (!r.ok) { say({ ok: false, text: r.message }); return; }
                const skipped = r.data.skipped?.length ?? 0;
                say({ ok: true, text: skipped ? `Imported ${r.data.imported}. Skipped ${skipped}.` : `Imported ${r.data.imported}.` });
                await reload();
              });
            }} />
          </label>
          <button type="button" style={ghost} onClick={() => void connect('google_start')}>Connect Google</button>
          <button type="button" style={ghost} onClick={() => void connect('microsoft_start')}>Connect Microsoft</button>
        </div>
        {!kit?.configured ? <p style={{ ...metaText, margin: '4px 0 0' }}>InboxKit import is off until this workspace has an InboxKit key. Add it under Warm-up and mailbox health below.</p> : null}
      </div>
      <p style={{ ...metaText, margin: 0 }}>Each inbox&apos;s domain is added with it. To add a domain on its own, use Add domain under Sending domains.</p>
    </div>
  );
}

/* ---- Warmup ---------------------------------------------------------------------- */

/**
 * Warmup, in plain words: a new inbox spends about two weeks trading friendly
 * mail with other inboxes (Instantly runs this) so Gmail and Outlook learn to
 * trust it. Only then may it send cold email. This box shows whether that
 * service is connected and lets an admin change its settings.
 */
function Warmup({ workspaceId, data, run, say, reload, note }: { workspaceId: number; data: ColdOverview; run: Run; say: (n: { ok: boolean; text: string } | null) => void; reload: () => Promise<void>; note: Notes }) {
  const w = data.warmup;
  const gate = w.gate;
  const [provider, setProvider] = useState(w.provider || 'stub');
  const [apiKey, setApiKey] = useState('');
  const [tag, setTag] = useState(textValue(w.instantly_tag));
  const [daily, setDaily] = useState(String(w.daily ?? 20));
  const [gateDays, setGateDays] = useState(String(gate?.min_days ?? 14));
  const [busy, setBusy] = useState(false);
  // When fresh data arrives, reset the form to what the server holds.
  const [seen, setSeen] = useState(w);
  if (seen !== w) {
    setSeen(w);
    setProvider(w.provider || 'stub');
    setTag(textValue(w.instantly_tag));
    setDaily(String(w.daily ?? 20));
    setGateDays(String(w.gate?.min_days ?? 14));
  }

  async function save() {
    const body: Record<string, unknown> = { provider, api_base: w.api_base ?? '', instantly_tag: tag, warmup_daily: Number(daily) };
    if (apiKey.trim()) body.key = apiKey.trim();
    const r = await run('save_warmup', body, 'warmup');
    if (r.ok) setApiKey('');
    // The warmup days are a workspace rule (deliverability.warmup_gate_days, 1 to 30), saved with the other rules.
    const days = Math.round(Number(gateDays));
    if (r.ok && days >= 1 && days <= 30 && days !== (gate?.min_days ?? 14)) await run('save_deliverability', { deliverability: { warmup_gate_days: days } }, 'warmup');
  }

  // Ask Instantly for fresh scores now instead of waiting for the daily read.
  async function sync() {
    setBusy(true);
    say(null);
    const r = await coldPool<WarmupSync>(workspaceId, 'sync_warmup');
    setBusy(false);
    if (!r.ok) { say({ ok: false, text: r.message }); return; }
    const d = r.data;
    const names = (list: string[] | undefined) => (list ?? []).map(textValue).filter(Boolean).join(', ');
    const parts = [`Checked ${d.checked}.`];
    if (d.promoted.length) parts.push(`Cleared to send: ${names(d.promoted)}.`);
    if (d.paused.length) parts.push(`Paused for spam: ${names(d.paused)}.`);
    if (d.resumed?.length) parts.push(`Back under the spam limit and unpaused: ${names(d.resumed)}.`);
    if (d.rewarmed?.length) parts.push(`Warmup was off on Instantly and is back on: ${names(d.rewarmed)}.`);
    if (d.unlisted.length) parts.push(`Not on Instantly: ${names(d.unlisted)}.`);
    if (textValue(d.error)) parts.push(textValue(d.error));
    say({ ok: !textValue(d.error), text: parts.join(' ') });
    await reload();
  }

  const limits: [string, string][] = [
    ['New inbox', gate?.on ? `No cold email until ${gate.min_days} days of warmup and a score of ${gate.min_score} or more` : 'Volume ramp only, no score gate'],
    ['Per inbox', 'Starts at 5 a day and reaches its cap in about 3 weeks, 20 a day by default'],
    ['Warmup volume', `${w.daily ?? 20} a day; cold plus warmup stays at ${w.combined_ceiling ?? 40} or under`],
    ['Per company', 'At most 3 cold emails a day to one company domain (Gmail and other free inboxes are not capped)'],
    ['Auto pause', `Bounces over 2%, complaints at 0.1%, or warmup landing in spam over ${gate?.spam_pause_pct ?? 3}%`],
  ];

  return (
    <Section
      id="cold-warmup"
      title="Warmup"
      why={`New inboxes trade practice mail with other inboxes for ${gate?.min_days ?? 14} days before any cold email, so Gmail and Outlook learn to trust them.`}
      actions={gate?.on && data.admin ? (
        <button type="button" style={ghost} disabled={busy || !w.key_set} title={w.key_set ? 'Read Instantly now and store the scores' : 'Save the Instantly key first'} onClick={() => void sync()}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      ) : null}
      how={
        <>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 110px) minmax(0, 1fr)', gap: '4px 12px', margin: '0 0 8px' }}>
            {limits.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt style={{ color: 'var(--meta, #71717a)' }}>{k}</dt>
                <dd style={{ margin: 0 }}>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          <p style={{ margin: '0 0 8px' }}>Every night CLOZR reads Instantly for each inbox and re-checks every sending domain&apos;s DNS. It turns warmup back on where Instantly switched it off, and unpauses an inbox it paused for warmup Spam once the rate is back under the limit; bounce and complaint pauses wait for a person. When anything needs a person, or the night fixed something by itself, the workspace owner gets one email. Quiet nights send nothing.</p>
          <p style={{ margin: 0 }}>Warmup volume is {w.daily ?? 20} a day by default, and cold plus warmup stays at {w.combined_ceiling ?? 40} or under. With Instantly as the provider and its API key saved, a new mailbox sends no cold mail until it has warmed {gate?.min_days ?? 14} days and its Instantly score is {gate?.min_score ?? 90} or more, then the ramp starts at day 1. Warmup mail landing in Spam more than {gate?.spam_pause_pct ?? 3}% of the time pauses the mailbox. Without Instantly, the volume ramp alone limits new mailboxes. The Instantly warmup ID is a tag in the subject and at the bottom of the body. Mail that contains it, an Instantly warmup header, the Warmup label, or the Instantly Warmup folder is not a reply and does not stop a sequence.</p>
        </>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        <Badge tone={gate?.on ? 'good' : 'muted'}>{gate?.on ? 'Runs through Instantly' : 'Volume ramp only'}</Badge>
        {gate?.on ? <Badge tone={w.key_set ? 'good' : 'bad'}>{w.key_set ? 'Instantly key saved' : 'No Instantly key'}</Badge> : null}
        {gate?.on && w.synced_at ? <Badge tone="muted" title={fullDate(w.synced_at)}>Synced {relDays(w.synced_at)}</Badge> : null}
      </div>
      {gate?.on && textValue(w.sync_error) ? <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--tx-red, #b91c1c)' }}>The last score read failed: {textValue(w.sync_error).replace(/\.$/, '')}. It tries again tonight, or press Sync now.</p> : null}
      {textValue(data.health.warmup_error) ? <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--tx-amber-deep, #92400e)' }}>Live scores could not be read just now ({textValue(data.health.warmup_error).replace(/\.$/, '')}). The scores shown are from the last daily read.</p> : null}
      {data.admin ? (
        <details style={{ marginTop: '12px' }}>
          <summary style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', fontSize: '12px', fontWeight: 600, color: 'var(--tx-mint, #0a8560)' }}><Icon name="chevron" size={13} />Warmup settings</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginTop: '10px' }}>
            <label><span style={fieldLabel}>Warmup service</span>
              <select style={{ ...input, width: '100%' }} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="stub">Volume ramp only</option>
                <option value="instantly">Instantly</option>
              </select>
            </label>
            <label><span style={fieldLabel}>Instantly API key</span>
              <input style={{ ...input, width: '100%' }} type="password" autoComplete="off" value={apiKey} placeholder={w.key_set ? 'Saved. Paste to replace' : 'Paste the key'} onChange={(e) => setApiKey(e.target.value)} />
            </label>
            <label><span style={fieldLabel}>Instantly warmup tag</span>
              <input style={{ ...input, width: '100%' }} value={tag} onChange={(e) => setTag(e.target.value)} />
            </label>
            <label><span style={fieldLabel}>Warmup emails per day</span>
              <input style={{ ...input, width: '100%' }} value={daily} inputMode="numeric" onChange={(e) => setDaily(e.target.value)} />
            </label>
            <label><span style={fieldLabel}>Days of warmup before cold email</span>
              <input style={{ ...input, width: '100%' }} type="number" min={1} max={30} value={gateDays} inputMode="numeric" onChange={(e) => setGateDays(e.target.value)} />
            </label>
          </div>
          <button type="button" style={{ ...ghost, marginTop: '10px' }} onClick={() => void save()}>Save warmup</button>
        </details>
      ) : null}
      <Note note={note} />
    </Section>
  );
}

/* ---- Campaigns ------------------------------------------------------------------- */

/**
 * Campaigns, in plain words: a short series of plain emails to a group of
 * buyers (everyone with a tag, or a saved Buyers view), a few business days
 * apart, that stops the moment someone replies. Drafts are written here and
 * only send after Launch.
 */
function stepsFrom(c: ColdOverview['campaigns'][number]): StepDraft[] {
  const rows = [...c.steps].sort((a, b) => a.position - b.position);
  return rows.length ? rows.map((s) => {
    const b = s.variants.find((v) => v.key === 'B') ?? s.variants[0];
    return { delay_business_days: s.delay_business_days, subject: s.subject, body: s.body, bSubject: b?.subject ?? '', bBody: b?.body ?? '' };
  }) : [{ ...emptyStep(), delay_business_days: 0 }];
}

function Campaigns({ data, run, note }: { data: ColdOverview; run: Run; note: Notes }) {
  const [writing, setWriting] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [viewId, setViewId] = useState('');
  const [autoEnroll, setAutoEnroll] = useState(false);
  const [steps, setSteps] = useState<StepDraft[]>([{ ...emptyStep(), delay_business_days: 0 }]);
  const admin = data.admin;
  const setStep = (i: number, patch: Partial<StepDraft>) => setSteps((cur) => cur.map((s, n) => (n === i ? { ...s, ...patch } : s)));

  function blankForm() {
    setEditId(null);
    setName('');
    setTag('');
    setViewId('');
    setSteps([{ ...emptyStep(), delay_business_days: 0 }]);
  }

  function openEdit(c: ColdOverview['campaigns'][number]) {
    setEditId(c.id);
    setName(textValue(c.name));
    setTag(textValue(c.audience_tag));
    setViewId(c.saved_view_id ? String(c.saved_view_id) : '');
    setSteps(stepsFrom(c));
    setWriting(true);
  }

  async function saveDraft() {
    const payload = steps.map((s, i) => ({
      delay_business_days: i === 0 ? 0 : s.delay_business_days,
      subject: s.subject,
      body: s.body,
      // A second subject and body is "version B": half the buyers get it, to see which one gets more replies.
      variants: s.bSubject && s.bBody ? [{ key: 'B', subject: s.bSubject, body: s.bBody, weight: 1 }] : [],
    }));
    const r = await run('save_campaign', {
      ...(editId ? { id: editId } : {}),
      name,
      audience_kind: viewId ? 'saved_view' : 'tag',
      audience_tag: tag,
      saved_view_id: viewId ? Number(viewId) : null,
      fallback_timezone: data.fallback_timezone,
      ...(data.autopilot ? { auto_enroll: !viewId && autoEnroll } : {}),
      steps: payload,
    }, 'campaigns');
    if (r.ok) {
      blankForm();
      setWriting(false);
    }
  }

  const field = (id: string, label: string, el: React.ReactNode) => <div><label htmlFor={id} style={fieldLabel}>{label}</label>{el}</div>;
  return (
    <Section
      id="cold-campaigns"
      title={`Campaigns (${data.campaigns.length})`}
      why="A few plain emails to a group of buyers, sent days apart. Each one stops by itself when the buyer replies."
      actions={admin && !writing ? <button type="button" style={ghost} onClick={() => { blankForm(); setWriting(true); }}>New campaign</button> : null}
      how={<p style={{ margin: 0 }}>Merge fields: {'{{first_name}}'}, {'{{last_name}}'}, {'{{company}}'}, {'{{city}}'}, {'{{state}}'}. Spintax: {'{hi|hello}'}. A second subject and body on a step is variant B. One recipient is in one active sequence, from the mailbox that sent step 1. A real reply stops the sequence, is assigned to the buyer&apos;s owner, and shows in the inbox. An out-of-office reply pauses it and resumes later.</p>}
    >
      {data.campaigns.length === 0 && !writing ? <p style={{ ...metaText, margin: 0 }}>No campaigns yet.{admin ? ' Press New campaign to write the first one.' : ''}</p> : null}
      {data.campaigns.map((c) => (
        <div key={c.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 600 }}>{textValue(c.name)}</span>
          <Badge tone={c.status === 'active' ? 'good' : 'muted'}>{c.status === 'active' ? 'Sending' : c.status === 'draft' ? 'Draft' : c.status === 'paused' ? 'Paused' : textValue(c.status)}</Badge>
          <span style={metaText}>{c.enrolled} buyers · {c.steps.length} {c.steps.length === 1 ? 'email' : 'emails'}</span>
          {data.autopilot && c.auto_enroll && c.audience_kind === 'tag' ? <Badge tone="muted" title={`Adds buyers tagged ${textValue(c.audience_tag)} every 30 minutes while it sends`}>Autopilot</Badge> : null}
          {admin ? (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {(c.status === 'draft' || c.status === 'paused') ? <button type="button" style={ghost} onClick={() => openEdit(c)}>Edit</button> : null}
              {c.status === 'active' ? <span style={metaText}>Pause it to change the emails</span> : null}
              {data.autopilot && c.audience_kind === 'tag' && c.status !== 'done' ? (
                <button type="button" style={ghost} onClick={() => void run('auto_enroll_campaign', { id: c.id, on: !c.auto_enroll }, 'campaigns')}>
                  {c.auto_enroll ? 'Turn off autopilot' : 'Turn on autopilot'}
                </button>
              ) : null}
              {c.status === 'draft' ? <button type="button" style={primary} onClick={() => void run('launch', { id: c.id }, 'campaigns')}>Launch</button> : null}
              {c.status === 'active' ? <button type="button" style={ghost} onClick={() => void run('pause_campaign', { id: c.id }, 'campaigns')}>Pause</button> : null}
              {c.status === 'paused' ? <button type="button" style={ghost} onClick={() => void run('resume_campaign', { id: c.id }, 'campaigns')}>Resume</button> : null}
            </span>
          ) : null}
        </div>
      ))}
      {admin && writing ? (
        <form onSubmit={(e) => { e.preventDefault(); void saveDraft(); }} style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--divider-2, #f0f0f1)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{ margin: 0, fontSize: '12.5px', fontWeight: 600 }}>{editId ? 'Edit campaign' : 'New campaign'}</p>
          {field('dlv-c-name', 'Campaign name', <input id="dlv-c-name" required style={{ ...input, width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} />)}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
            {field('dlv-c-tag', 'Send to buyers with this tag', <input id="dlv-c-tag" style={{ ...input, width: '100%' }} value={tag} onChange={(e) => setTag(e.target.value)} />)}
            {field('dlv-c-view', 'Or a saved Buyers view', (
              <select id="dlv-c-view" style={{ ...input, width: '100%' }} value={viewId} onChange={(e) => setViewId(e.target.value)}>
                <option value="">None</option>
                {data.saved_views.map((v) => <option key={v.id} value={v.id}>{textValue(v.name)}</option>)}
              </select>
            ))}
          </div>
          {data.autopilot && !viewId ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', minHeight: '24px', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoEnroll} onChange={(e) => setAutoEnroll(e.target.checked)} style={{ accentColor: 'var(--tx-mint, #0a8560)' }} /> Autopilot: once launched, add newly tagged buyers every 30 minutes
            </label>
          ) : null}
          {steps.map((s, i) => (
            <fieldset key={i} style={{ border: '1px solid var(--divider-2, #f0f0f1)', borderRadius: '8px', padding: '10px', margin: 0, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
              <legend style={{ fontSize: '12px', fontWeight: 600, padding: '0 4px' }}>Email {i + 1}{i > 0 ? <button type="button" style={{ ...ghost, marginLeft: '8px', padding: '2px 8px' }} onClick={() => setSteps((cur) => cur.filter((_, n) => n !== i))}>Remove</button> : null}</legend>
              {i > 0 ? field(`dlv-s${i}-wait`, 'Business days to wait after the last email', <input id={`dlv-s${i}-wait`} style={{ ...input, width: '88px' }} inputMode="numeric" value={s.delay_business_days} onChange={(e) => setStep(i, { delay_business_days: Number(e.target.value) || 0 })} />) : null}
              {field(`dlv-s${i}-subj`, 'Subject', <input id={`dlv-s${i}-subj`} style={{ ...input, width: '100%' }} value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} />)}
              {field(`dlv-s${i}-body`, 'Body', <textarea id={`dlv-s${i}-body`} style={{ ...input, width: '100%', height: '88px', padding: '8px' }} value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />)}
              {field(`dlv-s${i}-bsubj`, 'Version B subject (optional)', <input id={`dlv-s${i}-bsubj`} style={{ ...input, width: '100%' }} value={s.bSubject} onChange={(e) => setStep(i, { bSubject: e.target.value })} />)}
              {field(`dlv-s${i}-bbody`, 'Version B body (optional)', <textarea id={`dlv-s${i}-bbody`} style={{ ...input, width: '100%', height: '64px', padding: '8px' }} value={s.bBody} onChange={(e) => setStep(i, { bBody: e.target.value })} />)}
            </fieldset>
          ))}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" style={ghost} onClick={() => setSteps((cur) => [...cur, emptyStep()])}>Add another email</button>
            <button type="submit" style={primary}>{editId ? 'Save changes' : 'Save draft'}</button>
            <button type="button" style={ghost} onClick={() => { blankForm(); setWriting(false); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      <Note note={note} />
    </Section>
  );
}

/* ---- Safety rules ---------------------------------------------------------------- */

/**
 * The rules every cold email follows, and the two things an admin can set:
 * extra domains that must never send cold mail, and the mailing address the
 * law requires in the footer.
 */
function Rules({ data, run, note }: { data: ColdOverview; run: Run; note: Notes }) {
  const [extra, setExtra] = useState(data.blocked_extra.map(textValue).filter(Boolean).join(', '));
  const [address, setAddress] = useState(textValue(data.physical_address));
  const [seen, setSeen] = useState(data);
  if (seen !== data) {
    setSeen(data);
    setExtra(data.blocked_extra.map(textValue).filter(Boolean).join(', '));
    setAddress(textValue(data.physical_address));
  }
  return (
    <Section
      id="cold-rules"
      title="Safety rules"
      why="Limits that keep outreach inboxes out of spam folders: plain text, no tracking, small daily caps, and an unsubscribe link with your mailing address."
      how={
        <>
          <p style={{ margin: '0 0 8px' }}>Each address starts at 5 a day and reaches its cap over about 3 weeks, never above 20 a day by default. Cold mail plus warmup stays around 40 a day. Sends are 4 to 11 minutes apart, and the daily total is jittered. Mail is plain text first, with no tracking pixel. Step 1 has no links and never starts with Re: or Fwd:. Only a later step that replies to our own first email gets Re:. A company domain gets at most 3 cold emails a day. Gmail and other free inboxes are not under that cap. Instantly warmup mail does not count. Nothing sends from {LOCKED_SENDING_DOMAINS.join(', ')}.</p>
          <p style={{ margin: 0 }}>Defaults are on. Plain text with a matching HTML part and no images. Open tracking is off. Click tracking is off unless a sending domain has its own tracking host. Step 1 is blocked when it contains a link. Later steps allow one link. Spintax and merge fields are checked before send, and a spam-word score blocks bad copy. Weekends are skipped, and each mailbox rests one weekday. The same body is not sent to many people in a short window. Gmail, Google Workspace, and Outlook volume is spread. info@, admin@, and catch-all addresses are suppressed. A mailbox or domain pauses when bounces pass 2%, the spam complaint rate reaches 0.1% (one complaint in a week of 20-a-day sending is already over that), reply health is low, Primary placement falls off, or any placement test lands in Spam. Placement can be a weekly manual test or a seed list. The footer needs a physical address, the mailbox signature, and a one-click unsubscribe.</p>
        </>
      }
    >
      <p style={{ ...fieldLabel, marginBottom: '6px' }}>Never sends cold email from</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {LOCKED_SENDING_DOMAINS.map((d) => <Badge key={d} tone="muted">{d}</Badge>)}
        {data.blocked_extra.flatMap((d) => {
          const label = textValue(d);
          return label ? [<Badge key={label} tone="muted">{label}</Badge>] : [];
        })}
      </div>
      {data.admin ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginTop: '12px' }}>
          <form onSubmit={(e) => { e.preventDefault(); void run('save_blocked', { extra }, 'rules'); }}>
            <label htmlFor="dlv-blocked" style={fieldLabel}>Other domains to keep off-limits</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input id="dlv-blocked" style={{ ...input, flex: 1 }} value={extra} placeholder="Comma separated" onChange={(e) => setExtra(e.target.value)} />
              <button type="submit" style={ghost}>Save</button>
            </div>
          </form>
          <form onSubmit={(e) => { e.preventDefault(); void run('save_deliverability', { physical_address: address }, 'rules'); }}>
            <label htmlFor="dlv-address" style={fieldLabel}>Mailing address for the footer</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input id="dlv-address" style={{ ...input, flex: 1 }} value={address} onChange={(e) => setAddress(e.target.value)} />
              <button type="submit" style={ghost}>Save</button>
            </div>
          </form>
        </div>
      ) : null}
      {!data.physical_address ? <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--tx-amber-deep, #92400e)' }}>No mailing address yet. The law requires one in every cold email footer.</p> : null}
      <Note note={note} />
    </Section>
  );
}

/* ---- Health ---------------------------------------------------------------------- */

/**
 * Last week's numbers, as one sentence. "Show all" opens the per-inbox and
 * per-domain table, with any inbox over the safe limits on top.
 */
function Health({ data }: { data: ColdOverview }) {
  const [all, setAll] = useState(false);
  const rows = data.health.mailboxes;
  const { line, flagged } = healthLine(rows);
  const sorted = [...rows, ...data.health.domains].sort((a, b) => Number(overLimit(b)) - Number(overLimit(a)));
  return (
    <Section
      id="cold-health"
      title="Last 7 days"
      why="How cold email went this week. Bounces (bad addresses) and spam complaints are what get inboxes blocked."
      actions={sorted.length ? <button type="button" style={ghost} aria-expanded={all} onClick={() => setAll((v) => !v)}>{all ? 'Hide details' : 'Show all'}</button> : null}
    >
      <p style={{ margin: 0, fontSize: '12.5px', color: flagged ? 'var(--tx-red, #b91c1c)' : 'var(--ink-3, #3f3f46)', fontVariantNumeric: 'tabular-nums' }}>{line}</p>
      {all ? (
        <div style={{ marginTop: '8px' }}>
          <div aria-hidden="true" style={{ display: 'flex', gap: '8px', padding: '4px 0', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 500 }}>
            <span style={{ flex: '1 1 200px' }}>Inbox or domain</span>
            <span style={{ display: 'flex', gap: '8px' }}><span style={{ width: '56px', textAlign: 'right' }}>Sent</span><span style={{ width: '56px', textAlign: 'right' }}>Bounced</span><span style={{ width: '56px', textAlign: 'right' }}>Replied</span><span style={{ width: '64px', textAlign: 'right' }}>Spam</span></span>
          </div>
          {sorted.map((r) => {
            const name = textValue(r.email) || textValue(r.domain) || 'Mailbox';
            const bad = overLimit(r);
            return (
              <div key={name} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '5px 0', borderTop: '1px solid var(--surface-2, #f4f4f5)', fontSize: '12px', color: bad ? 'var(--tx-red, #b91c1c)' : 'var(--ink-3, #3f3f46)', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere', fontWeight: r.domain ? 600 : 500 }}>{name}{bad ? ' (over the limit)' : ''}</span>
                <span style={{ display: 'flex', gap: '8px' }} aria-label={`${r.sent_7d} sent, ${pct(r.bounceRate)} bounced, ${pct(r.replyRate)} replied, ${pct(r.complaintRate)} spam complaints`}>
                  <span style={{ width: '56px', textAlign: 'right' }}>{r.sent_7d}</span>
                  <span style={{ width: '56px', textAlign: 'right' }}>{pct(r.bounceRate)}</span>
                  <span style={{ width: '56px', textAlign: 'right' }}>{pct(r.replyRate)}</span>
                  <span style={{ width: '64px', textAlign: 'right' }}>{pct(r.complaintRate)}</span>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </Section>
  );
}
