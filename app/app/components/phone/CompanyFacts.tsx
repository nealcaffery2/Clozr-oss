// Settings → Workspace → Company & 10DLC. The facts only a person can supply —
// legal name, EIN, address, the opt-in story, the sample texts — typed once
// here and read by every automatic filing: ten-dlc-register (brand, campaign,
// numbers), caller-registry (Telnyx enterprise, Free Caller Registry, branded
// calling) and the morning number-guard that pushes both along.
//
// The checks are the same functions the edge functions run before they spend
// a registry fee, so what this screen calls complete is what the server files.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { type WorkspaceSettings, loadSettings, saveSettings } from '@/lib/integrations';
import { useSession } from '@/lib/session';
import { isAdmin, type Role } from '@/lib/team';
import {
  type CampaignFacts,
  type EntityFacts,
  type Problem,
  BUNDLED_USE_CASES,
  DEFAULT_SUB_USE_CASES,
  ENTITY_TYPES,
  SUB_USE_CASES,
  USE_CASES,
  VERTICALS,
  normalizeEin,
  normalizePhone,
  validateCampaign,
  validateEntity,
} from '@/supabase/functions/_shared/tendlc';
import { type RegistryFacts, dirGaps, enterpriseGaps } from '@/supabase/functions/_shared/caller-registry';
import { Btn, INK, LINE, MUTED, NoteBox, card, field, invokeFn, label, type Note } from './ui';
import { CallerRegistryStatus, TenDlcStatus } from './Reputation';

type Entity = Partial<EntityFacts>;
type Campaign = Partial<CampaignFacts>;
type Draft = { entity: Entity; campaign: Campaign; messaging_profile_id: string; reg: RegistryFacts };

const ENTITY_LABEL: Record<string, string> = {
  PRIVATE_PROFIT: 'Private company (LLC, S-corp, C-corp)',
  PUBLIC_PROFIT: 'Publicly traded company',
  NON_PROFIT: 'Non-profit',
  GOVERNMENT: 'Government',
  SOLE_PROPRIETOR: 'Sole proprietor (no EIN)',
};

/** "100 Commerce Way, Suite 200, Springfield, IL 62701" → its parts, or nothing. */
function splitAddress(a: string | undefined) {
  const m = (a ?? '').trim().match(/^(.+),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  return m ? { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), postal_code: m[4] } : {};
}

/**
 * A first draft from what the workspace already knows (the contract entity on
 * Integrations), so the admin edits instead of typing from nothing. Every
 * saved value wins over the draft.
 */
function draftFrom(s: WorkspaceSettings, wsName: string): Draft {
  const co = s.company ?? {};
  const domain = (co.email ?? '').split('@')[1] ?? '';
  const website = domain && !/gmail|yahoo|outlook|hotmail|icloud/i.test(domain) ? `https://${domain}` : '';
  const biz = co.name || wsName || 'Our company';
  const [first, ...rest] = (co.signer ?? '').trim().split(/\s+/);
  const phone = co.phone ? normalizePhone(co.phone) ?? co.phone : '';
  const help = [phone && `call ${phone}`, co.email && `email ${co.email}`].filter(Boolean).join(' or ');
  const saved = s.ten_dlc ?? {};
  const entity: Entity = {
    legal_name: co.legal ?? '',
    display_name: co.name ?? '',
    entity_type: 'PRIVATE_PROFIT',
    vertical: 'REAL_ESTATE',
    country: 'US',
    email: co.email ?? '',
    phone,
    website,
    ...splitAddress(co.address),
    ...(saved.entity ?? {}),
  };
  const campaign: Campaign = {
    usecase: 'LOW_VOLUME',
    sub_usecases: DEFAULT_SUB_USE_CASES,
    description: `${biz} is a real estate investment company. We text homeowners who asked us for a cash offer on their property, and investors on our buyers list who asked to hear about properties for sale. Texts are about their property, appointments and offers.`,
    message_flow: `People opt in on the form at ${website || 'our website'}: the phone number field is optional, and next to it is an optional, unchecked box reading "By checking this box, I agree to receive text messages from ${biz} about my property and offers. Consent is not a condition of purchase. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help." The form submits without the box ticked; we only text people who ticked it. The consent, the page and a timestamp are stored in our CRM. We never buy or share phone numbers.`,
    samples: [
      `Hi Mark, this is Morgan with ${biz}. Thanks for asking for an offer on 123 Main St. Is now a good time to go over the numbers? Reply STOP to opt out.`,
      `${biz}: confirming your walkthrough at 123 Main St tomorrow at 2pm. Reply here if you need to reschedule.`,
      `Hi Dana, ${biz} here. We just got an off-market 3/2 in San Antonio that fits your buy box. Want the details?`,
    ],
    help_message: `${biz}: for help ${help || 'reply to this text'}. Msg & data rates may apply. Reply STOP to opt out.`,
    optin_message: `${biz}: you are subscribed to texts about your property and offers. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    optout_message: `${biz}: you are unsubscribed and will get no more texts. Reply START to resubscribe.`,
    privacy_policy_url: website ? `${website}/privacy` : '',
    terms_url: website ? `${website}/terms` : '',
    embedded_link: false,
    embedded_phone: false,
    ...(saved.campaign ?? {}),
  };
  const reg: RegistryFacts = {
    contact_first: first ?? '',
    contact_last: rest.join(' '),
    contact_title: co.title ?? '',
    // Same person who signs contracts; Telnyx wants them named on the DIR.
    authorizer_name: (co.signer ?? '').trim() || [first, rest.join(' ')].filter(Boolean).join(' '),
    authorizer_email: co.email ?? '',
    // Pre-approved Telnyx reasons that match how CLOZR dials.
    call_reasons: ['Follow-Up Calls', 'Appointment Reminder', 'Customer Service'],
    ...(s.caller_registry ?? {}),
  };
  return { entity, campaign, messaging_profile_id: saved.messaging_profile_id ?? '', reg };
}

const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
const clean = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, trim(v)]).filter(([, v]) => v !== '' && v !== undefined && v !== null)) as T;

export function CompanyFacts({ isMobile }: { isMobile: boolean }) {
  const s = useSession();
  const wsId = s.workspace?.id ?? null;
  const ro = !isAdmin((s.workspace?.role as Role | undefined) ?? null) || s.demo;
  const [loaded, setLoaded] = useState<{ key: number; settings: WorkspaceSettings } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [server, setServer] = useState<{ carrier?: string; problems: Problem[] } | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (wsId === null) return;
    let live = true;
    void loadSettings(wsId).then((settings) => { if (live) setLoaded({ key: wsId, settings }); });
    return () => { live = false; };
  }, [wsId]);

  const base = useMemo(() => (loaded && loaded.key === wsId ? draftFrom(loaded.settings, s.workspace?.name ?? '') : null), [loaded, wsId, s.workspace?.name]);
  const d = draft ?? base;

  const problems = useMemo(() => {
    if (!d) return new Map<string, string>();
    const all = [
      ...validateEntity(d.entity),
      ...validateCampaign(d.campaign, d.entity.display_name || d.entity.legal_name),
      ...enterpriseGaps(d.entity, d.reg).filter((p) => p.field.startsWith('contact_')),
      ...(d.reg.auto_file ? dirGaps(d.reg, d.entity) : []),
    ];
    const m = new Map<string, string>();
    for (const p of all) if (!m.has(p.field)) m.set(p.field, p.problem);
    return m;
  }, [d]);

  if (wsId === null) return <div style={card}>Sign in to a workspace to edit its company facts.</div>;
  if (!d) return <div style={{ ...card, color: MUTED, fontSize: '12.5px' }}>Loading company facts…</div>;

  const setE = (k: keyof EntityFacts, v: string) => setDraft({ ...d, entity: { ...d.entity, [k]: v } });
  const setC = <K extends keyof CampaignFacts>(k: K, v: CampaignFacts[K]) => setDraft({ ...d, campaign: { ...d.campaign, [k]: v } });
  const setR = <K extends keyof RegistryFacts>(k: K, v: RegistryFacts[K]) => setDraft({ ...d, reg: { ...d.reg, [k]: v } });
  const samples = [...(d.campaign.samples ?? []), '', '', '', '', ''].slice(0, 5);
  const bundled = BUNDLED_USE_CASES.includes(d.campaign.usecase as typeof BUNDLED_USE_CASES[number]);
  const subs = d.campaign.sub_usecases ?? [];

  const save = async () => {
    if (!loaded) return;
    setBusy(true); setNote(null); setServer(null);
    const entity = clean({
      ...d.entity,
      ein: normalizeEin(d.entity.ein ?? '') ?? d.entity.ein,
      phone: normalizePhone(d.entity.phone ?? '') ?? d.entity.phone,
      state: d.entity.state?.trim().toUpperCase(),
    });
    const campaign = { ...clean(d.campaign), samples: (d.campaign.samples ?? []).map((x) => x.trim()).filter(Boolean) };
    const fresh = await loadSettings(wsId);
    const r = await saveSettings(wsId, {
      ten_dlc: { ...(fresh.ten_dlc ?? {}), entity, campaign, messaging_profile_id: d.messaging_profile_id.trim() || null },
      caller_registry: clean({ ...(fresh.caller_registry ?? {}), ...d.reg }),
    });
    if (!r.ok) {
      setBusy(false);
      setNote({ ok: false, text: r.message ?? 'Could not save.' });
      return;
    }
    setLoaded({ key: wsId, settings: await loadSettings(wsId) });
    setDraft(null);
    // Ask the filing function itself, so "complete" here means complete there.
    const chk = await invokeFn<{ ok?: boolean; problems?: Problem[]; carrier?: string }>('ten-dlc-register', { action: 'check', workspace_id: wsId });
    setServer({ carrier: chk.data?.carrier, problems: chk.data?.problems ?? [] });
    setBusy(false);
    setRev((x) => x + 1);
    if (chk.error && !chk.data?.problems) setNote({ ok: false, text: `Saved, but the 10DLC check could not run: ${chk.error}` });
    else if (chk.data?.problems?.length) setNote({ ok: false, text: `Saved. ${chk.data.problems.length} thing${chk.data.problems.length === 1 ? '' : 's'} still to fix before CLOZR can file.` });
    else setNote({ ok: true, text: 'Saved. The facts are complete — Register below files the brand, then the campaign, then attaches your lines. The morning guard and the caller registry read these same facts.' });
  };

  const err = (k: string) => problems.get(k);
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'repeat(2, minmax(0,1fr))', gap: '10px 12px' };
  const input = (k: string, value: string | null | undefined, onChange: (v: string) => void, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={ro} aria-invalid={!!err(k)} style={{ ...field, width: '100%', borderColor: err(k) ? '#fca5a5' : LINE }} {...extra} />
  );
  const area = (k: string, value: string | null | undefined, onChange: (v: string) => void, rows = 3) => (
    <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={ro} rows={rows} aria-invalid={!!err(k)} style={{ ...field, width: '100%', height: 'auto', padding: '7px 9px', lineHeight: 1.45, resize: 'vertical', borderColor: err(k) ? '#fca5a5' : LINE }} />
  );

  return (
    <>
      <div style={card}>
        <Head title="Business" sub="Exactly as the IRS has it. TCR matches the legal name and EIN character for character against the EIN letter (CP 575 or 147C) — the most common reason a brand is rejected." />
        <div style={grid}>
          <Field k="legal_name" label="Legal company name" err={err} hint="As printed on the EIN letter, including LLC / Inc.">{input('legal_name', d.entity.legal_name, (v) => setE('legal_name', v), { placeholder: 'Acme Holdings, LLC' })}</Field>
          <Field k="display_name" label="Company name (DBA)" err={err} hint="What people see. Branded calling and the caller name use it.">{input('display_name', d.entity.display_name, (v) => setE('display_name', v), { placeholder: 'Acme Homes' })}</Field>
          <Field k="ein" label="EIN" err={err} hint="Nine digits, XX-XXXXXXX.">{input('ein', d.entity.ein, (v) => setE('ein', v), { placeholder: '12-3456789', inputMode: 'numeric' })}</Field>
          <Field k="entity_type" label="Entity type" err={err}>
            <select value={d.entity.entity_type ?? ''} onChange={(e) => setE('entity_type', e.target.value)} disabled={ro} style={{ ...field, width: '100%' }}>
              {ENTITY_TYPES.map((t) => <option key={t} value={t}>{ENTITY_LABEL[t] ?? t}</option>)}
            </select>
          </Field>
          <Field k="vertical" label="Industry" err={err}>
            <select value={d.entity.vertical ?? ''} onChange={(e) => setE('vertical', e.target.value)} disabled={ro} style={{ ...field, width: '100%' }}>
              {VERTICALS.map((v) => <option key={v} value={v}>{v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}
            </select>
          </Field>
          <Field k="website" label="Website" err={err} hint="Public https:// — reviewers open it.">{input('website', d.entity.website, (v) => setE('website', v), { placeholder: 'https://yourcompany.com' })}</Field>
          <Field k="street" label="Street address" err={err} hint="The address on file with the IRS for this EIN.">{input('street', d.entity.street, (v) => setE('street', v))}</Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 70px 100px', gap: '8px' }}>
            <Field k="city" label="City" err={err}>{input('city', d.entity.city, (v) => setE('city', v))}</Field>
            <Field k="state" label="State" err={err}>{input('state', d.entity.state, (v) => setE('state', v), { maxLength: 2, placeholder: 'TX' })}</Field>
            <Field k="postal_code" label="ZIP" err={err}>{input('postal_code', d.entity.postal_code, (v) => setE('postal_code', v), { inputMode: 'numeric' })}</Field>
          </div>
          <Field k="email" label="Support email" err={err} hint="Has to receive mail; reviewers test it.">{input('email', d.entity.email, (v) => setE('email', v), { type: 'email' })}</Field>
          <Field k="phone" label="Support phone" err={err}>{input('phone', d.entity.phone, (v) => setE('phone', v), { type: 'tel', placeholder: '(210) 555-0161' })}</Field>
        </div>
      </div>

      <div style={card}>
        <Head title="Contact person" sub="Named on the Telnyx enterprise that Number Reputation and branded calling hang off." />
        <div style={{ ...grid, gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'repeat(3, minmax(0,1fr))' }}>
          <Field k="contact_first" label="First name" err={err}>{input('contact_first', d.reg.contact_first, (v) => setR('contact_first', v))}</Field>
          <Field k="contact_last" label="Last name" err={err}>{input('contact_last', d.reg.contact_last, (v) => setR('contact_last', v))}</Field>
          <Field k="contact_title" label="Title" err={err}>{input('contact_title', d.reg.contact_title, (v) => setR('contact_title', v), { placeholder: 'Owner' })}</Field>
        </div>
      </div>

      <div style={card}>
        <Head title="Texting campaign" sub="What you text and how people agreed to it. CLOZR drafted this from your company; edit it until every word is true of your website and your texts. A rejected campaign cannot be edited — it is filed again, at a new fee." />
        <div style={grid}>
          <Field k="usecase" label="Use case" err={err} hint="Low volume mixed fits a few lines and a few hundred texts a day.">
            <select value={d.campaign.usecase ?? ''} onChange={(e) => setC('usecase', e.target.value)} disabled={ro} style={{ ...field, width: '100%' }}>
              {USE_CASES.map((u) => <option key={u} value={u}>{u === 'LOW_VOLUME' ? 'Low volume mixed' : u.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}
            </select>
          </Field>
          {bundled ? (
            <Field k="sub_usecases" label="What the texts are (pick 2–5)" err={err}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                {SUB_USE_CASES.map((u) => (
                  <label key={u} style={{ fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input type="checkbox" disabled={ro} checked={subs.includes(u)} onChange={(e) => setC('sub_usecases', e.target.checked ? [...subs, u] : subs.filter((x) => x !== u))} />
                    {u.replace(/_/g, ' ').toLowerCase()}
                  </label>
                ))}
              </div>
            </Field>
          ) : <div />}
        </div>
        <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>
          <Field k="description" label="Campaign description" err={err} hint="Two to four sentences: who you are, who you text, about what.">{area('description', d.campaign.description, (v) => setC('description', v))}</Field>
          <Field k="message_flow" label="How people opt in" err={err} hint="Where the form is and the exact checkbox wording. A reviewer goes and looks.">{area('message_flow', d.campaign.message_flow, (v) => setC('message_flow', v), 4)}</Field>
          <div style={grid}>
            <Field k="privacy_policy_url" label="Privacy policy" err={err} hint="Must say mobile numbers are never shared for marketing.">{input('privacy_policy_url', d.campaign.privacy_policy_url, (v) => setC('privacy_policy_url', v))}</Field>
            <Field k="terms_url" label="Messaging terms (optional)" err={err}>{input('terms_url', d.campaign.terms_url, (v) => setC('terms_url', v))}</Field>
          </div>
          <div>
            <span style={label}>Sample texts</span>
            <div style={{ fontSize: '11.5px', color: MUTED, margin: '-2px 0 6px' }}>Two to five real messages. The first is the first touch and carries the opt-out line.</div>
            <div style={{ display: 'grid', gap: '6px' }}>
              {samples.map((smp, i) => (
                <div key={i}>
                  {area(`samples.${i}`, smp, (v) => { const next = [...samples]; next[i] = v; setC('samples', next); }, 2)}
                  {err(`samples.${i}`) ? <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '2px' }}>{err(`samples.${i}`)}</div> : null}
                </div>
              ))}
            </div>
            {err('samples') ? <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '2px' }}>{err('samples')}</div> : null}
          </div>
          <Field k="help_message" label="HELP reply" err={err} hint="Names the business and says how to stop.">{area('help_message', d.campaign.help_message, (v) => setC('help_message', v), 2)}</Field>
          <div style={grid}>
            <Field k="optin_message" label="Opt-in confirmation" err={err}>{area('optin_message', d.campaign.optin_message, (v) => setC('optin_message', v), 2)}</Field>
            <Field k="optout_message" label="Opt-out confirmation" err={err}>{area('optout_message', d.campaign.optout_message, (v) => setC('optout_message', v), 2)}</Field>
          </div>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12.5px' }}>
            <label style={{ display: 'flex', gap: '5px', alignItems: 'center' }}><input type="checkbox" disabled={ro} checked={!!d.campaign.embedded_link} onChange={(e) => setC('embedded_link', e.target.checked)} /> Texts include links</label>
            <label style={{ display: 'flex', gap: '5px', alignItems: 'center' }}><input type="checkbox" disabled={ro} checked={!!d.campaign.embedded_phone} onChange={(e) => setC('embedded_phone', e.target.checked)} /> Texts include phone numbers</label>
          </div>
          {d.campaign.embedded_link ? <Field k="embedded_link_sample" label="Example link" err={err}>{input('embedded_link_sample', d.campaign.embedded_link_sample, (v) => setC('embedded_link_sample', v), { placeholder: 'https://yourcompany.com/deals/123' })}</Field> : null}
        </div>
      </div>

      <div style={card}>
        <Head title="Carrier and caller registry" sub="Optional. Filled in, these let the morning job finish the rest without anyone opening a portal." />
        <div style={grid}>
          <Field k="messaging_profile_id" label="Telnyx messaging profile id" err={err} hint="Every line on it joins the campaign. Blank: CLOZR uses your only profile.">{input('messaging_profile_id', d.messaging_profile_id, (v) => setDraft({ ...d, messaging_profile_id: v }), { placeholder: '40017a3c-…' })}</Field>
          <Field k="fcr_email" label="Free Caller Registry email" err={err} hint="Defaults to the support email.">{input('fcr_email', d.reg.fcr_email, (v) => setR('fcr_email', v))}</Field>
          <Field k="agentmail_inbox_id" label="AgentMail inbox" err={err} hint="Where the registry’s verification code is read from.">{input('agentmail_inbox_id', d.reg.agentmail_inbox_id, (v) => setR('agentmail_inbox_id', v))}</Field>
          <Field k="auto_file" label="Automatic filing" err={err}>
            <label style={{ fontSize: '12.5px', display: 'flex', gap: '6px', alignItems: 'flex-start', lineHeight: 1.4 }}>
              <input type="checkbox" disabled={ro} checked={!!d.reg.auto_file} onChange={(e) => setR('auto_file', e.target.checked)} style={{ marginTop: '2px' }} />
              Create the Telnyx enterprise (and the branded-calling identity, below) from these facts
            </label>
          </Field>
        </div>
        <details style={{ marginTop: '10px' }}>
          <summary style={{ fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: INK }}>Branded calling (paid, optional)</summary>
          <div style={{ ...grid, marginTop: '10px' }}>
            <Field k="authorizer_name" label="Authorized by" err={err}>{input('authorizer_name', d.reg.authorizer_name, (v) => setR('authorizer_name', v))}</Field>
            <Field k="authorizer_email" label="Authorizer email" err={err}>{input('authorizer_email', d.reg.authorizer_email, (v) => setR('authorizer_email', v))}</Field>
            <Field k="call_reasons" label="Call reasons (one per line, up to 10)" err={err}>{area('call_reasons', (d.reg.call_reasons ?? []).join('\n'), (v) => setR('call_reasons', v.split('\n')), 3)}</Field>
            <Field k="loa_document_id" label="Signed LOA (Telnyx document id)" err={err} hint="Upload the signed LOA in Telnyx → Documents first.">{input('loa_document_id', d.reg.loa_document_id, (v) => setR('loa_document_id', v))}</Field>
            <label style={{ fontSize: '12.5px', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="checkbox" disabled={ro} checked={!!d.reg.terms_accepted} onChange={(e) => setR('terms_accepted', e.target.checked)} /> I accept Telnyx’s branded calling terms
            </label>
          </div>
        </details>
      </div>

      <div style={{ ...card, position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', color: problems.size ? 'var(--tx-red, #b91c1c)' : '#15803d' }}>
          {ro ? 'Only an owner or admin can change these.' : problems.size ? `${problems.size} field${problems.size === 1 ? '' : 's'} to fix before CLOZR can file.` : 'Complete — ready to file.'}
          {server?.carrier === 'talkr' ? <span style={{ color: 'var(--tx-amber-deep, #92400e)' }}> CLOZR has no Telnyx key (neither the TELNYX_API_KEY secret nor Vault telnyx_api_key), so Register cannot reach Telnyx yet (Workspace → Server keys).</span> : null}
        </span>
        {draft ? <Btn disabled={busy} onClick={() => { setDraft(null); setNote(null); }}>Discard</Btn> : null}
        <Btn primary disabled={ro || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save company facts'}</Btn>
      </div>
      <NoteBox note={note} />
      {server?.problems.length ? (
        <ul style={{ margin: '8px 0 12px', paddingLeft: '18px', fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)', lineHeight: 1.5 }}>
          {server.problems.map((p, i) => <li key={`${p.field}-${i}`}><b style={{ fontWeight: 600 }}>{p.field}</b> — {p.problem}</li>)}
        </ul>
      ) : null}

      <div style={card} key={rev}>
        <Head title="Filing" sub="The same controls as Talkr → Numbers → Caller reputation, reading the facts above." />
        <TenDlcStatus />
        <CallerRegistryStatus />
      </div>
    </>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>{title}</h2>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>{sub}</p>
    </>
  );
}

function Field({ k, label: text, hint, err, children }: { k: string; label: string; hint?: string; err: (k: string) => string | undefined; children: React.ReactNode }) {
  const e = err(k);
  return (
    <div style={{ minWidth: 0 }}>
      <span style={label}>{text}</span>
      {children}
      {e ? <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '3px', lineHeight: 1.4 }}>{e}</div>
        : hint ? <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '3px', lineHeight: 1.4 }}>{hint}</div> : null}
    </div>
  );
}
