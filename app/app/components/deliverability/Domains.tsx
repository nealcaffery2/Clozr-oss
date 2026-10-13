'use client';

// Sending domains: every domain the workspace sends from, in one list.
// Company domains come from connected Google accounts or are added by hand;
// outreach domains come from the cold pool. Each is checked over DNS, scored
// 0 to 100, and shows the exact record to add for every failure.
//
// In plain words: a domain is the part after the @ (yourcompany.com).
// Gmail and Outlook look up a few records on it (SPF says which servers may
// send for it, DKIM is a signature on each email, DMARC says what to do with
// fakes) and check the public spam lists before they trust the mail. This box
// shows those checks in groups, each with one line on what it is for, and
// when one fails, the exact line to paste at the domain host. CLOZR re-checks
// outreach domains every night, so "Checked" is usually hours old, not days.
//
// A cold domain's check also writes its email_domains row, so one domain has
// one report; this list joins the two by name and shows the newer read.

import React, { useState } from 'react';
import { type Check, type DomainRow, deliverability, textValue } from '@/lib/deliverability';
import { type ColdDomain, type ColdOverview, coldPool } from '@/lib/cold-pool';
import { Badge, Copy, Fold, Mark, Note, Section, type Tone, danger, fieldLabel, fullDate, ghost, input, mono, pct, primary, relDays, row, toneOf } from './ui';

/** The id of one domain's row, so the inbox list and the status line can jump to it. */
export const domainAnchor = (name: string) => `sending-domain-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** The checks in groups, each with one plain line on what it is for. */
const GROUPS: { key: string; title: string; what: string; has: (k: string) => boolean }[] = [
  { key: 'auth', title: 'Authentication', what: 'SPF lists who may send for the domain, DKIM signs each email, DMARC tells inboxes what to do when those fail, and alignment means they all agree on the From domain. MX lets the domain receive replies and bounces.', has: (k) => /^(spf|dkim|dmarc|mx)/.test(k) },
  { key: 'bl', title: 'Blocklists', what: 'Public spam lists (Spamhaus, URIBL, SpamCop). Being listed sends mail to spam almost everywhere.', has: (k) => k.startsWith('bl_') && k !== 'bl_ips' },
  { key: 'ips', title: 'Sending IPs', what: 'The servers your SPF names, checked against the IP blocklists.', has: (k) => k === 'bl_ips' },
  { key: 'opt', title: 'Optional extras', what: 'BIMI shows your logo in Gmail, MTA-STS forces encrypted delivery to you, TLS-RPT reports when that fails. Nice to have, not needed to send.', has: (k) => /^(bimi|mta_sts|tls_rpt)/.test(k) },
];
const SUMMARY: [string, string][] = [['spf', 'SPF'], ['dkim', 'DKIM'], ['dmarc', 'DMARC'], ['bl', 'Blocklists']];
const RANK: Record<string, number> = { fail: 0, warn: 1, unknown: 2, info: 3, pass: 4 };

function summaryStatus(checks: Check[], key: string): string {
  if (key !== 'bl') return textValue(checks.find((c) => c.key === key)?.status) || 'unknown';
  const bl = checks.filter((c) => c.key.startsWith('bl_') && c.key !== 'bl_ips');
  return bl.some((c) => c.status === 'fail') ? 'fail' : bl.some((c) => c.status === 'unknown') ? 'unknown' : bl.length ? 'pass' : 'unknown';
}

type Item = { name: string; email: DomainRow | null; cold: ColdDomain | null };

/** Company domains and outreach domains, joined by name. */
function merge(domains: DomainRow[], cold: ColdDomain[]): Item[] {
  const by = new Map<string, Item>();
  for (const d of domains) { const name = textValue(d.domain); if (name) by.set(name.toLowerCase(), { name, email: d, cold: null }); }
  for (const c of cold) {
    const name = textValue(c.domain);
    if (!name) continue;
    const cur = by.get(name.toLowerCase());
    by.set(name.toLowerCase(), { name, email: cur?.email ?? null, cold: c });
  }
  return [...by.values()];
}

/** The newer of the two reads (a cold check writes both). */
function latest(it: Item) {
  const e = it.email, c = it.cold;
  const coldNewer = !!c?.checked_at && (!e?.checked_at || c.checked_at >= e.checked_at);
  const src = coldNewer ? c : e ?? c;
  return {
    score: src?.score ?? null,
    blocking: (src?.blocking ?? []).map(textValue).filter(Boolean),
    checked_at: src?.checked_at ?? null,
    report: (coldNewer ? c?.report : null) ?? e?.report ?? c?.report ?? null,
  };
}

/** Last week's cold numbers for one outreach domain, or null when it sent nothing. */
function coldWeek(data: ColdOverview | null, domain: string): string | null {
  const h = data?.health.domains.find((r) => textValue(r.domain).toLowerCase() === domain.toLowerCase());
  return h && h.sent_7d ? `Last 7 days: ${h.sent_7d} sent, ${pct(h.bounceRate)} bounced, ${pct(h.replyRate)} replied, ${pct(h.complaintRate)} spam complaints` : null;
}

export function Domains({ workspaceId, domains, admin, onChange, cold }: {
  workspaceId: number; domains: DomainRow[]; admin: boolean; onChange: () => void;
  /** The cold-pool overview, when it loaded. Its domains join this list. */
  cold?: { data: ColdOverview; reload: () => Promise<void> } | null;
}) {
  const [adding, setAdding] = useState(false);
  const blank = { domain: '', dkim_selectors: '', tracking_domain: '', uses_resend: false, cold: !!cold };
  const [draft, setDraft] = useState(blank);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const items = merge(domains, cold?.data.domains ?? []).map((it) => ({ it, r: latest(it) }));
  const bad = (x: (typeof items)[number]) => !!x.it.cold?.paused || !x.r.checked_at || x.r.blocking.length > 0;
  // The domain to fix goes on top, then the lowest score.
  items.sort((a, b) => Number(bad(b)) - Number(bad(a)) || (a.r.score ?? -1) - (b.r.score ?? -1) || a.it.name.localeCompare(b.it.name));
  const failing = items.filter(bad).length;

  const reloadAll = async () => { onChange(); await cold?.reload(); };

  const check = async (it: Item) => {
    setBusy(it.name); setNote(null);
    const r = it.cold
      ? await coldPool<{ score: number }>(workspaceId, 'check_domain', { id: it.cold.id })
      : await deliverability<{ score: number }>(workspaceId, 'check_domain', { id: it.email!.id });
    setBusy(null);
    if (!r.ok) return setNote({ ok: false, text: r.message });
    await reloadAll();
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('add'); setNote(null);
    const asCold = draft.cold && !!cold;
    const r = asCold
      ? await coldPool<{ id: number }>(workspaceId, 'add_domain', { domain: draft.domain, dkim_selectors: draft.dkim_selectors })
      : await deliverability<{ id: number }>(workspaceId, 'add_domain', { domain: draft.domain, dkim_selectors: draft.dkim_selectors, tracking_domain: draft.tracking_domain, uses_resend: draft.uses_resend });
    if (!r.ok) { setBusy(null); return setNote({ ok: false, text: r.message }); }
    const c = asCold ? await coldPool(workspaceId, 'check_domain', { id: r.data.id }) : await deliverability(workspaceId, 'check_domain', { id: r.data.id });
    setBusy(null);
    if (!c.ok) setNote({ ok: false, text: c.message });
    setAdding(false);
    setDraft(blank);
    await reloadAll();
  };
  const remove = async (d: DomainRow) => {
    if (!window.confirm(`Stop tracking ${textValue(d.domain)}? Its DNS is not touched.`)) return;
    const r = await deliverability(workspaceId, 'remove_domain', { id: d.id });
    if (!r.ok) setNote({ ok: false, text: r.message });
    onChange();
  };
  const pause = async (c: ColdDomain) => {
    const r = await coldPool(workspaceId, 'save_domain', { id: c.id, paused: !c.paused });
    setNote(r.ok ? { ok: true, text: c.paused ? `${textValue(c.domain)} sends again.` : `${textValue(c.domain)} is paused. Its inboxes send nothing until you resume it.` } : { ok: false, text: r.message });
    if (r.ok) await cold?.reload();
  };

  return (
    <Section
      id="sending-domains"
      title={`Sending domains (${items.length})`}
      why={items.length
        ? `${failing ? `${failing} of ${items.length} need${failing === 1 ? 's' : ''} you.` : `All ${items.length} pass.`} Gmail and Outlook check a few records at your domain host, and the public spam lists, before they trust any mail from it.`
        : 'Gmail and Outlook check a few records at your domain host, and the public spam lists, before they trust any mail from it.'}
      how={<>Each connected Google account&apos;s company domain is added automatically; free addresses like @gmail.com are not domains you control. Outreach domains come in with their inboxes. CLOZR re-checks outreach domains every night, because a cold email needs a check under 7 days old; Check now forces a fresh read. The score runs 0 to 100, and every failed check shows the exact record to add at the DNS host.</>}
      actions={admin ? <button type="button" style={ghost} aria-expanded={adding} onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : 'Add domain'}</button> : null}
    >
      {adding && (
        <form onSubmit={(e) => void add(e)} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', padding: '10px 0', borderTop: '1px solid #f0f0f1', alignItems: 'end' }}>
          <label><span style={fieldLabel}>Domain</span><input required style={{ ...input, width: '100%' }} name="domain" autoComplete="off" spellCheck={false} value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} placeholder="outreach.example.com" /></label>
          {cold ? (
            <label><span style={fieldLabel}>Used for</span>
              <select style={{ ...input, width: '100%' }} name="domain_use" value={draft.cold ? 'cold' : 'warm'} onChange={(e) => setDraft({ ...draft, cold: e.target.value === 'cold' })}>
                <option value="cold">Cold email inboxes</option>
                <option value="warm">Rep Gmail or buyer blasts</option>
              </select>
            </label>
          ) : null}
          <label><span style={fieldLabel}>Extra DKIM selectors</span><input style={{ ...input, width: '100%' }} name="dkim_selectors" autoComplete="off" spellCheck={false} value={draft.dkim_selectors} onChange={(e) => setDraft({ ...draft, dkim_selectors: e.target.value })} placeholder="s1, mandrill" /></label>
          {!draft.cold || !cold ? (
            <>
              <label><span style={fieldLabel}>Link or tracking domain</span><input style={{ ...input, width: '100%' }} name="tracking_domain" autoComplete="off" spellCheck={false} value={draft.tracking_domain} onChange={(e) => setDraft({ ...draft, tracking_domain: e.target.value })} placeholder="links.yourcompany.com" /></label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', minHeight: '32px', cursor: 'pointer' }}><input type="checkbox" name="uses_resend" checked={draft.uses_resend} onChange={(e) => setDraft({ ...draft, uses_resend: e.target.checked })} style={{ accentColor: '#0A8560' }} /> Also sends through Resend</label>
            </>
          ) : null}
          <button type="submit" disabled={busy === 'add'} style={{ ...primary, justifySelf: 'start' }}>{busy === 'add' ? 'Checking…' : 'Add and check'}</button>
        </form>
      )}

      {items.length === 0 && <p style={{ ...row, margin: 0, fontSize: '12.5px', color: '#71717a' }}>No sending domain yet. Connect Google with a work address, bring in outreach inboxes, or add the domain you send from.</p>}
      {items.map(({ it, r }) => {
        const checks = r.report?.checks ?? [];
        const isBad = bad({ it, r });
        const tone: Tone = isBad ? 'bad' : r.score != null && r.score < 85 ? 'warn' : 'good';
        const fixes = checks.filter((c) => c.fix && (c.status === 'fail' || c.status === 'warn'));
        const provider = textValue(r.report?.provider);
        const week = it.cold ? coldWeek(cold?.data ?? null, it.name) : null;
        const uses = [it.cold ? `Cold email, up to ${it.cold.daily_cap} a day` : null, it.email?.uses_resend ? 'Buyer blasts' : null, it.email && !it.cold ? 'Company mail' : null].filter(Boolean).join(', ');
        return (
          <Fold key={it.name} id={domainAnchor(it.name)} open={isBad} style={{ borderTop: '1px solid #f0f0f1', padding: '4px 0' }} summary={
            <>
              <Mark tone={tone} />
              <span style={{ fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>{it.name}</span>
              {it.cold?.paused ? <Badge tone="bad">Paused</Badge> : null}
              {r.score != null ? <Badge tone={r.score >= 85 ? 'good' : r.score >= 70 ? 'warn' : 'bad'}>{r.score}/100</Badge> : <Badge tone="bad">Not checked</Badge>}
              {r.blocking.length > 0 ? <Badge tone="bad" title={r.blocking.join('\n')}>Stops sending</Badge> : null}
              <span style={{ fontSize: '11.5px', color: '#71717a', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }} title={fullDate(r.checked_at)}>Checked {relDays(r.checked_at)}</span>
            </>
          }>
            <p style={{ margin: '0 0 8px', fontSize: '11.5px', color: '#71717a', lineHeight: 1.5 }}>
              {[uses, provider ? (provider === 'google' ? 'Google Workspace' : provider) : null, week].filter(Boolean).join(' · ')}
              {r.checked_at && !isBad ? <><br />{SUMMARY.map(([k, l]) => `${l} ${summaryStatus(checks, k) === 'pass' ? 'pass' : summaryStatus(checks, k)}`).join(', ')}</> : null}
            </p>
            {it.cold?.paused ? <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#b91c1c' }}>Paused{textValue(it.cold.paused_reason) ? `: ${textValue(it.cold.paused_reason).replace(/\.$/, '')}` : ''}. Its inboxes send nothing until you resume it.</p> : null}
            {r.blocking.length > 0 && (
              <ul style={{ margin: '0 0 10px', paddingLeft: '18px', fontSize: '12.5px', color: '#b91c1c', lineHeight: 1.5, maxWidth: '64ch' }}>
                {r.blocking.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}

            {fixes.length > 0 && (
              <div style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>Records to add at your DNS host</div>
                {fixes.map((c) => (
                  <div key={c.key} style={{ padding: '6px 0', borderTop: '1px solid #fef3c7' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: '4px 8px', alignItems: 'start' }}>
                      <span style={{ ...mono, fontWeight: 700 }}>{textValue(c.fix!.type)}</span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ ...mono, display: 'block' }}>{textValue(c.fix!.host)}</span>
                        <span style={{ ...mono, display: 'block', color: '#52525b' }}>{textValue(c.fix!.value)}</span>
                      </span>
                      <Copy text={textValue(c.fix!.value)} />
                    </div>
                    <div style={{ fontSize: '11.5px', color: '#78350f', marginTop: '3px' }}>{textValue(c.label)}: {textValue(c.fix!.note ?? c.detail)}</div>
                  </div>
                ))}
              </div>
            )}

            {!checks.length && r.checked_at ? <p style={{ fontSize: '11.5px', color: '#71717a', margin: '0 0 8px' }}>The detailed report is not here yet. Press Check now to see each record.</p> : null}
            {GROUPS.map((g) => {
              const list = checks.filter((c) => g.has(textValue(c.key))).sort((a, b) => (RANK[textValue(a.status)] ?? 2) - (RANK[textValue(b.status)] ?? 2));
              if (!list.length) return null;
              const worst = textValue(list[0].status);
              return (
                <Fold key={g.key} open={worst === 'fail' || worst === 'warn'} summary={
                  <>
                    <Mark tone={worst === 'pass' || worst === 'info' ? 'good' : toneOf(worst)} size={13} />
                    <span style={{ fontSize: '12.5px', fontWeight: 600 }}>{g.title}</span>
                    <span style={{ fontSize: '11.5px', color: '#71717a', fontVariantNumeric: 'tabular-nums' }}>{list.filter((c) => c.status === 'pass').length} of {list.length} pass</span>
                  </>
                }>
                  <p style={{ fontSize: '11.5px', color: '#71717a', margin: '0 0 4px', maxWidth: '64ch', lineHeight: 1.5 }}>{g.what}</p>
                  {list.map((c) => <CheckRow key={c.key} c={c} />)}
                </Fold>
              );
            })}
            {checks.filter((c) => !GROUPS.some((g) => g.has(textValue(c.key)))).map((c) => <CheckRow key={c.key} c={c} />)}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
              <button type="button" style={ghost} disabled={busy === it.name} onClick={() => void check(it)}>{busy === it.name ? 'Checking…' : 'Check now'}</button>
              {admin && it.cold ? <button type="button" style={ghost} onClick={() => void pause(it.cold!)}>{it.cold.paused ? 'Resume sending' : 'Pause sending'}</button> : null}
              {admin && it.email?.source === 'manual' && !it.cold ? <button type="button" style={danger} onClick={() => void remove(it.email!)}>Remove</button> : null}
            </div>
          </Fold>
        );
      })}
      <Note note={note} />
    </Section>
  );
}

/** One DNS check: a mark and a word for its result, then what it found. */
function CheckRow({ c }: { c: Check }) {
  const status = textValue(c.status);
  const tone: Tone = status === 'info' ? 'muted' : toneOf(status);
  const word = status === 'unknown' ? "Couldn't check" : status === 'pass' ? 'Pass' : status === 'fail' ? (c.blocking ? 'Fail, stops sending' : 'Fail') : status === 'warn' ? 'Warning' : status === 'info' ? 'Not set' : status || 'Unknown';
  return (
    <div style={{ display: 'flex', gap: '8px', padding: '5px 0', fontSize: '12px', borderTop: '1px solid #f4f4f5', alignItems: 'start' }}>
      <span style={{ paddingTop: '1px' }}><Mark tone={tone} size={13} /></span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 600, flex: '0 0 150px' }}>
          {textValue(c.label)}
          <span style={{ display: 'block', fontWeight: 500, color: tone === 'bad' ? '#b91c1c' : tone === 'warn' ? '#b45309' : '#71717a' }}>{word}</span>
        </span>
        <span style={{ color: '#52525b', overflowWrap: 'anywhere', flex: '1 1 240px', minWidth: 0 }}>
          {textValue(c.detail)}
          {status !== 'fail' && status !== 'warn' && c.fix ? <span style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '3px', flexWrap: 'wrap' }}><span style={{ ...mono, color: '#71717a' }}>{textValue(c.fix.host)} {textValue(c.fix.type)} {textValue(c.fix.value)}</span><Copy text={textValue(c.fix.value)} /></span> : null}
        </span>
      </span>
    </div>
  );
}
