'use client';

// The big editor a campaign message opens in: the whole message on the left,
// what one buyer gets on the right. A text gets "What do you want to change?"
// for the whole message or one part of it, with the carrier check on every
// version. An email gets the same, plus its subject, its words or HTML, and
// the main photo: one from the deal's photo folder or an upload, cropped to
// the email's 3:2 frame around its centre.
//
// Nothing here writes to the campaign until "Save changes"; Esc, the scrim
// and Cancel leave it as it was.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type CarrierFinding, carrierCheck } from '@/lib/carrier-safe';
import { htmlToText } from '@/lib/email-text';
import { fixHtmlWords, fixWords, findingLine, messageSections, reviewMessage, sectionLabel } from '@/lib/message-revise';
import { type Revised, reviseMessage } from '@/lib/message-revise-client';
import { type DealPhoto, emailablePhoto, heroFromUrl, loadEmailPhotos, refreshFromFolder, uploadHeroPhoto } from '@/lib/email-photo';
import { Btn, C, Icon, Note, Svg } from './ui';
import { Scaled } from './Preview';
import { dropToken, dropTokenHtml, htmlLike, smsSegments, swapToken } from './logic';

/** What the campaign's merge fields do in a draft: `unknown` go out as typed (`near` is the field a typo likely meant), `blank` have no value on this deal. */
export type MergeFlags = { unknown: string[]; blank: string[]; near: Record<string, string | null> };

export type LightboxDraft = { subject: string; body: string; html: string | null };

export type LightboxProps = {
  workspaceId: number;
  dealId: number;
  demo: boolean;
  channel: 'sms' | 'email';
  title: string;
  /** "Filled in for Marisol Vega". */
  sample: string | null;
  initial: LightboxDraft;
  /** The draft filled in for the sample buyer, for the preview. */
  render: (d: LightboxDraft, photoUrl: string | null) => { subject: string; text: string; html: string | null };
  /** The email's main photo. Absent for a text. */
  photo?: { url: string | null; /** The folder as it stands, when it is not read from the database (the demo). */ folder?: DealPhoto[] };
  /** The campaign's merge-field check, run on the draft as it changes. */
  checkMerge?: (text: string) => MergeFlags;
  fieldLabel?: (field: string) => string;
  onSave: (d: LightboxDraft, photoUrl: string | null) => void;
  onClose: () => void;
};

const QUICK_SMS = ['Shorter', 'More casual', 'Lead with the price', 'End with a question'];
const QUICK_EMAIL = ['Shorter', 'Warmer', 'Lead with the numbers', 'Make the subject clearer'];

export function MessageLightbox({ workspaceId, dealId, demo, channel, title, sample, initial, render, photo, checkMerge, fieldLabel = (f) => f, onSave, onClose }: LightboxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<LightboxDraft>(initial);
  const [hero, setHero] = useState<string | null>(photo?.url ?? null);
  const [picked, setSection] = useState<string | null>(null);
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Revised | null>(null);
  const [htmlOpen, setHtmlOpen] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const isEmail = channel === 'email';
  const designed = isEmail && !!draft.html;
  const words = designed ? htmlToText(draft.html!) : draft.body;
  const dirty = draft.subject !== initial.subject || draft.body !== initial.body || draft.html !== initial.html || hero !== (photo?.url ?? null);

  // Esc closes (asking first when there are changes), Tab stays inside, focus comes back after.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = () => { if (!dirty || window.confirm('Close without saving your changes?')) onClose(); }; });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
      if (e.key === 'Tab' && ref.current) {
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not([type=file]), select, textarea')).filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key, true); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, []);

  const sections = useMemo(() => messageSections(words), [words]);
  // A part the rep picked and then edited away is no longer picked.
  const section = picked && words.includes(picked) ? picked : null;
  const review = useMemo(() => reviewMessage(title, '', channel, isEmail ? `${draft.subject}\n${words}` : draft.body), [title, channel, isEmail, draft.subject, words, draft.body]);
  const shown = render(draft, hero);
  const texts = useMemo(() => (draft.html ? htmlTexts(draft.html).out.map(textInfo) : []), [draft.html]);
  const merge = checkMerge?.(`${draft.subject}\n${draft.html ?? draft.body}`) ?? null;
  const flagged = merge ? [...merge.unknown, ...merge.blank] : [];
  const hasFlag = (s: string) => flagged.some((t) => new RegExp(`\\{\\{?\\s*${t}\\s*\\}?\\}`, 'i').test(s));
  const everywhere = (f: (s: string) => string, fHtml = f) => setDraft((d) => ({ subject: f(d.subject), body: f(d.body), html: d.html ? fHtml(d.html) : null }));
  const dropAll = (names: string[]) => everywhere((s) => names.reduce(dropToken, s), (h) => names.reduce(dropTokenHtml, h));

  const applyFixes = (findings: CarrierFinding[]) => {
    if (!isEmail) { setDraft((d) => ({ ...d, body: carrierCheck(d.body).text })); return; }
    setDraft((d) => ({ subject: fixWords(d.subject, findings), body: fixWords(d.body, findings), html: d.html ? fixHtmlWords(d.html, findings) : null }));
  };

  const rewrite = async () => {
    if (!ask.trim() || busy) return;
    setBusy(true); setAskErr(null); setProposal(null);
    if (demo) {
      await new Promise((r) => setTimeout(r, 500));
      setBusy(false);
      setAskErr('AI changes are off on the demo. Edit the words by hand.');
      return;
    }
    const r = await reviseMessage(workspaceId, { channel, instruction: ask.trim(), text: words, subject: isEmail ? draft.subject : null, html: draft.html, section });
    setBusy(false);
    if (!r.ok) { setAskErr(r.message); return; }
    setProposal(r.data);
  };
  const useProposal = () => {
    if (!proposal) return;
    setDraft((d) => ({
      subject: proposal.subject ?? d.subject,
      body: designed ? d.body : proposal.text,
      html: d.html ? proposal.html ?? d.html : null,
    }));
    setProposal(null); setAsk(''); setSection(null);
  };

  const editor = (
    <div style={{ display: 'grid', gap: '22px', alignContent: 'start' }}>
      {isEmail && photo ? <PhotoPicker workspaceId={workspaceId} dealId={dealId} demo={demo} folder={photo.folder} url={hero} onPick={setHero} slot={!draft.html || /\{\{\s*photo_url\s*\}\}/.test(draft.html)} /> : null}

      {merge && flagged.length ? (
        <section style={{ display: 'grid', gap: '6px' }} aria-label="Missing merge fields">
          {merge.blank.length ? (
            <Note level="warn" action={<Btn size="sm" onClick={() => dropAll(merge.blank)} style={{ height: '24px', whiteSpace: 'nowrap' }}>{merge.blank.length === 1 ? 'Take it out' : 'Take them out'}</Btn>}>
              Nothing on this deal for {merge.blank.map((t) => `{{${t}}} (${fieldLabel(t)})`).join(', ')}, so {merge.blank.length === 1 ? 'it goes' : 'they go'} out blank. Marked in amber below. Fill {merge.blank.length === 1 ? 'it' : 'them'} in from the warning beside the preview, or take {merge.blank.length === 1 ? 'it' : 'them'} out (a link to one goes with it).
            </Note>
          ) : null}
          {merge.unknown.map((t) => {
            const near = merge.near[t];
            return (
              <Note key={t} level="warn" action={<Btn size="sm" onClick={() => (near ? everywhere((s) => swapToken(s, t, near)) : dropAll([t]))} style={{ height: '24px', whiteSpace: 'nowrap' }}>{near ? `Use {{${near}}}` : 'Take it out'}</Btn>}>
                {`{{${t}}}`} is not a merge field, so it goes out exactly as typed.{near ? ` Did you mean {{${near}}} (${fieldLabel(near)})?` : ''} Marked below.
              </Note>
            );
          })}
        </section>
      ) : null}

      {isEmail ? (
        <label style={{ display: 'grid', gap: '6px' }}>
          <span className="mk-lb-label">Subject</span>
          <input value={draft.subject} onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))} className="mk-field" style={{ height: '38px', fontSize: '14px', ...(hasFlag(draft.subject) ? FLAG : null) }} data-autofocus={designed ? true : undefined} />
        </label>
      ) : null}

      {designed ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          <span className="mk-lb-label">The email</span>
          <span style={{ fontSize: '12.5px', color: C.muted, lineHeight: 1.5 }}>Every line of the designed template, in order. Type over any of them; {'{{fields}}'} fill in for each buyer. Ask the AI below, or edit the HTML for layout.</span>
          <div style={{ display: 'grid', gap: '10px' }} role="group" aria-label="The email's words">
            {texts.map((x, i) => (
              <label key={i} style={{ display: 'grid', gap: '3px' }}>
                <span style={{ fontSize: '11px', color: C.muted2 }}>{x.kind}</span>
                <Grow value={x.text} onChange={(v) => setDraft((d) => ({ ...d, html: d.html ? setHtmlText(d.html, i, v) : d.html }))} label={`${x.kind} ${i + 1}`} min={34} flag={hasFlag(`${x.text} ${x.href}`)} dense />
              </label>
            ))}
          </div>
          <div>
            <Btn size="sm" aria-expanded={htmlOpen} onClick={() => setHtmlOpen((o) => !o)}><Svg d={Icon.edit} size={12} /> {htmlOpen ? 'Hide the HTML' : 'Edit the HTML'}</Btn>
          </div>
          {htmlOpen ? (
            <textarea value={draft.html ?? ''} onChange={(e) => setDraft((d) => ({ ...d, html: e.target.value }))} className="mk-area mk-lb-code" spellCheck={false} aria-label="Email HTML" rows={16} />
          ) : null}
        </div>
      ) : (
        <label style={{ display: 'grid', gap: '6px' }}>
          <span className="mk-lb-label">{isEmail ? 'Message' : 'Text'}</span>
          <Grow value={draft.body} onChange={(v) => setDraft((d) => ({ ...d, body: v }))} label={isEmail ? 'Email message' : 'Text message'} autoFocus min={isEmail ? 220 : 120} flag={hasFlag(draft.body)} />
          {!isEmail ? (
            <span className="mk-num" style={{ fontSize: '11.5px', color: draft.body.length > 320 ? C.amber : C.muted2 }}>
              {draft.body.length} characters before merge fields fill in · about {smsSegments(shown.text)} segment{smsSegments(shown.text) === 1 ? '' : 's'} for this buyer
            </span>
          ) : null}
        </label>
      )}

      <section className="mk-lb-ask" aria-labelledby={`${titleId}-ask`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Svg d={Icon.wand} size={15} color="var(--c-primary)" />
          <h3 id={`${titleId}-ask`} style={{ margin: 0, fontSize: '14px', fontWeight: 650 }}>What do you want to change?</h3>
        </div>
        {sections.length ? (
          <div style={{ display: 'grid', gap: '6px' }}>
            <span className="mk-lb-label">Change</span>
            <div role="radiogroup" aria-label="Which part to change" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button type="button" role="radio" aria-checked={section === null} className="mk-chip mk-press" onClick={() => setSection(null)}>The whole message</button>
              {sections.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={section === s} className="mk-chip mk-press" title={s} onClick={() => setSection(s)} style={{ maxWidth: '100%' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sectionLabel(s)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <label style={{ display: 'grid', gap: '6px' }}>
          <span className="mk-lb-label">{section ? 'How should this part read?' : 'How should it read?'}</span>
          <textarea value={ask} onChange={(e) => setAsk(e.target.value)} rows={2} className="mk-area" maxLength={1000}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void rewrite(); } }} />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          {(isEmail ? QUICK_EMAIL : QUICK_SMS).map((q) => <button key={q} type="button" className="mk-chip mk-press" onClick={() => setAsk(q)}>{q}</button>)}
          <div style={{ flex: 1 }} />
          <Btn kind="primary" onClick={() => void rewrite()} disabled={!ask.trim() || busy} aria-describedby={askErr ? `${titleId}-err` : undefined}>
            {busy ? 'Rewriting…' : section ? 'Rewrite this part' : 'Rewrite'}
          </Btn>
        </div>
        {askErr ? <div id={`${titleId}-err`}><Note level="block">{askErr}</Note></div> : null}
        {busy ? <div className="mk-lb-skeleton" role="status" aria-label="The AI is rewriting the message"><span /><span /><span style={{ width: '60%' }} /></div> : null}
        {proposal ? <Proposal proposal={proposal} isEmail={isEmail} designed={designed} before={words} onUse={useProposal} onDiscard={() => setProposal(null)} /> : null}
      </section>

      <CarrierPanel findings={review?.check.findings ?? []} canFix={!!review?.suggestion} onFix={() => review && applyFixes(review.check.findings)} isEmail={isEmail} />
    </div>
  );

  const preview = (
    <div style={{ display: 'grid', gap: '10px', alignContent: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span className="mk-lb-label">What they get</span>
        {sample ? <span style={{ fontSize: '11.5px', color: C.muted2 }}>{sample}</span> : null}
      </div>
      {isEmail ? (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: '12px', overflow: 'hidden', background: 'var(--surface, #fff)' }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.line2}`, background: 'var(--canvas, #fafafa)' }}>
            <b style={{ fontSize: '14px' }}>{shown.subject || '(no subject)'}</b>
          </div>
          <div style={{ padding: shown.html ? '10px' : '14px 16px' }}>
            {shown.html ? <Scaled html={shown.html} /> : <div style={{ fontSize: '14px', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shown.text}</div>}
          </div>
        </div>
      ) : (
        <div className="mk-lb-phone">
          <div className="mk-bubble mk-swap" key={shown.text} style={{ fontSize: '14px' }}>{shown.text || ' '}</div>
        </div>
      )}
    </div>
  );

  return createPortal(
    <div className="mk-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div ref={ref} className="mk-dialog mk mk-lb" data-channel={channel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="message-lightbox">
        <header className="mk-lb-head">
          <Svg d={isEmail ? Icon.mail : Icon.text} size={16} color={isEmail ? C.ink : 'var(--c-talkr)'} />
          <h2 id={titleId} style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <div role="tablist" aria-label="Show" className="mk-lb-switch">
            <button type="button" role="tab" aria-selected={view === 'edit'} className="mk-chip mk-press" onClick={() => setView('edit')}>Edit</button>
            <button type="button" role="tab" aria-selected={view === 'preview'} className="mk-chip mk-press" onClick={() => setView('preview')}>Preview</button>
          </div>
          <button type="button" className="mk-btn mk-press mk-lb-x" onClick={() => closeRef.current()} aria-label="Close the editor"><Svg d={Icon.close} size={14} /></button>
        </header>
        <div className="mk-lb-body" data-view={view} data-channel={channel}>
          <div className="mk-lb-edit">{editor}</div>
          <div className="mk-lb-preview">{preview}</div>
        </div>
        <footer className="mk-lb-foot">
          <span style={{ fontSize: '12px', color: C.muted2, minWidth: 0 }}>{review?.check.blocked ? 'A carrier would refuse this as written. Fix the red finding first.' : dirty ? 'Not saved yet.' : 'No changes yet.'}</span>
          <div style={{ flex: 1 }} />
          <Btn onClick={() => closeRef.current()}>Cancel</Btn>
          <Btn kind="primary" size="lg" disabled={!dirty || !!review?.check.blocked} onClick={() => onSave(draft, hero)} data-testid="lightbox-save">Save changes</Btn>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** A textarea as tall as its words, so the whole message is in view while it is edited. */
function Grow({ value, onChange, label, autoFocus, min, flag, dense }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean; min: number; flag?: boolean; dense?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(min, el.scrollHeight + 2)}px`;
  }, [value, min]);
  return <textarea ref={ref} rows={1} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="mk-area mk-lb-words" data-autofocus={autoFocus || undefined} style={{ resize: 'none', overflow: 'hidden', ...(dense ? { padding: '7px 10px', fontSize: '13.5px', lineHeight: 1.45 } : null), ...(flag ? FLAG : null) }} aria-invalid={flag || undefined} />;
}

/** A field holding a merge field that will not fill in. */
const FLAG: React.CSSProperties = { borderColor: '#d97706', boxShadow: '0 0 0 3px rgba(217,119,6,.15)' };

// A designed email's words, one per text node, so they edit in place and the HTML around them stays as it is.
function htmlTexts(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue?.trim() && !n.parentElement?.closest('style,script,title')) out.push(n as Text);
  return { doc, out };
}
function textInfo(n: Text) {
  const el = n.parentElement;
  const link = el?.closest('a');
  const kind = el?.closest('[style*="display:none"],[style*="display: none"]') ? 'Inbox preview line (hidden in the email)' : link ? 'Link' : el?.closest('h1,h2,h3,h4') ? 'Heading' : 'Text';
  return { kind, href: link?.getAttribute('href') ?? '', text: n.nodeValue!.replace(/​/g, '').replace(/\s+/g, ' ').trim() };
}
function setHtmlText(html: string, i: number, v: string) {
  const { doc, out } = htmlTexts(html);
  const n = out[i];
  if (!n) return html;
  const [, lead, , trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.nodeValue ?? '')!;
  // An emptied line keeps a zero-width space, so it stays in the list to type into again.
  n.nodeValue = lead + (v || '​') + trail;
  return htmlLike(html, doc);
}

function Proposal({ proposal, isEmail, designed, before, onUse, onDiscard }: { proposal: Revised; isEmail: boolean; designed: boolean; before: string; onUse: () => void; onDiscard: () => void }) {
  const after = designed && proposal.html ? htmlToText(proposal.html) : proposal.text;
  const flagged = proposal.carrier.findings.filter((f) => f.severity !== 'fix' || f.to != null);
  return (
    <div className="mk-lb-proposal mk-reveal" role="region" aria-label="The AI's version">
      <span className="mk-lb-label" style={{ color: 'var(--c-primary)' }}>The AI&apos;s version</span>
      {isEmail && proposal.subject ? <div style={{ fontSize: '13px' }}><span style={{ color: C.muted }}>Subject </span><b>{proposal.subject}</b></div> : null}
      <div style={{ fontSize: '13.5px', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{after}</div>
      {after === before && !proposal.subject ? <span style={{ fontSize: '12px', color: C.muted }}>The words came back the same. Try saying the change another way.</span> : null}
      {flagged.length ? <span style={{ fontSize: '12px', color: C.amber }}>{flagged.length === 1 ? 'One carrier finding' : `${flagged.length} carrier findings`} on this version, listed under Carrier check once you use it.</span> : null}
      {proposal.slop.length ? <span style={{ fontSize: '12px', color: C.amber }}>Reads like a template in places: {proposal.slop.slice(0, 2).map((s) => `"${s.quote}"`).join(', ')}.</span> : null}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Btn onClick={onDiscard}>Discard</Btn>
        <Btn kind="primary" onClick={onUse}>Use this version</Btn>
      </div>
    </div>
  );
}

function CarrierPanel({ findings, canFix, onFix, isEmail }: { findings: CarrierFinding[]; canFix: boolean; onFix: () => void; isEmail: boolean }) {
  const blocks = findings.filter((f) => f.severity === 'block');
  return (
    <section className="mk-lb-check" data-state={blocks.length ? 'block' : findings.length ? 'warn' : 'ok'} aria-label="Carrier check">
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px 8px', flexWrap: 'wrap' }}>
        <Svg d={Icon.shield} size={15} color={blocks.length ? C.red : findings.length ? C.amber : 'var(--c-primary)'} />
        <b style={{ fontSize: '13px' }}>Carrier check</b>
        <span style={{ fontSize: '12px', color: C.muted }}>
          {blocks.length ? 'A carrier would refuse this.' : findings.length ? `${findings.length === 1 ? 'One word' : `${findings.length} words`} ${isEmail ? 'inbox filters' : 'carrier filters'} score.` : `Nothing ${isEmail ? 'inbox' : 'carrier'} filters flag.`}
        </span>
        <div style={{ flex: 1 }} />
        {canFix ? <Btn size="sm" kind="primary" onClick={onFix}>Use the suggested wording</Btn> : null}
      </div>
      {findings.length ? (
        <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '4px', fontSize: '12.5px', lineHeight: 1.5, color: C.ink2 }}>
          {findings.map((f, i) => <li key={i} style={{ color: f.severity === 'block' ? C.red : undefined }}>{findingLine(f)}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

/** The email's main photo: the current one large, the deal's photo folder to pick from, and an upload. */
function PhotoPicker({ workspaceId, dealId, demo, folder, url, onPick, slot }: { workspaceId: number; dealId: number; demo: boolean; folder?: DealPhoto[]; url: string | null; onPick: (u: string | null) => void; slot: boolean }) {
  const [photos, setPhotos] = useState<DealPhoto[] | null>(demo ? folder ?? [] : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ level: 'block' | 'warn' | 'info'; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (demo) return;
    let live = true;
    void loadEmailPhotos(dealId).then((p) => { if (live) setPhotos(p); });
    return () => { live = false; };
  }, [dealId, demo]);

  const choose = async (src: string) => {
    if (demo) { onPick(src); return; }
    setBusy('frame'); setNote(null);
    const r = await heroFromUrl(workspaceId, dealId, src);
    setBusy(null);
    onPick(r.url);
    if (!r.framed) setNote({ level: 'info', text: 'That photo host does not let CLOZR crop its pictures, so it goes as it is, scaled to the width of the email.' });
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (demo) { setNote({ level: 'info', text: 'Uploads are off on the demo.' }); return; }
    setBusy('upload'); setNote(null);
    const r = await uploadHeroPhoto(workspaceId, dealId, f);
    setBusy(null);
    if (!r.ok) { setNote({ level: 'block', text: r.message }); return; }
    onPick(r.url);
    setPhotos((p) => (p ? [...p, { id: -Date.now(), name: f.name, url: r.url }] : p));
    setNote({ level: 'info', text: `${f.name} is cropped to the email frame and added to this deal's photos.` });
  };
  const refresh = async () => {
    setBusy('folder'); setNote(null);
    const r = await refreshFromFolder(workspaceId, dealId);
    setBusy(null);
    if (!r.ok) { setNote({ level: 'block', text: r.message }); return; }
    setPhotos(r.photos);
    setNote({ level: 'info', text: r.note });
  };

  return (
    <section style={{ display: 'grid', gap: '10px' }} aria-label="Main photo">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="mk-lb-label">Main photo</span>
        <div style={{ flex: 1 }} />
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/heic" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        <Btn size="sm" onClick={() => file.current?.click()} disabled={!!busy}><Svg d={Icon.upload} size={12} /> {busy === 'upload' ? 'Uploading…' : 'Upload a photo'}</Btn>
        {demo ? null : <Btn size="sm" onClick={() => void refresh()} disabled={!!busy}>{busy === 'folder' ? 'Reading the folder…' : 'Refresh the folder'}</Btn>}
      </div>
      {!slot ? <Note level="warn">This template has no photo slot, so the photo does not show. Pick the Acme Homes deal blast to send it.</Note> : null}
      <div className="mk-lb-hero" data-busy={busy === 'frame' || busy === 'upload' ? 'true' : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a remote photo at its own size, as the email shows it */}
        {url && emailablePhoto(url) ? <img src={url} alt="The email's main photo" /> : (
          <div style={{ display: 'grid', placeItems: 'center', gap: '6px', color: C.muted2, fontSize: '12.5px', textAlign: 'center', padding: '16px' }}>
            <Svg d={Icon.image} size={22} color={C.subtle} />
            No main photo yet. Pick one from the folder or upload one.
          </div>
        )}
        {busy === 'frame' || busy === 'upload' ? <span className="mk-lb-hero-busy" role="status">Fitting the photo to the frame…</span> : null}
      </div>
      {note ? <Note level={note.level}>{note.text}</Note> : null}
      {photos === null ? (
        <div className="mk-lb-thumbs" aria-busy="true" aria-label="Loading the photo folder">{Array.from({ length: 6 }, (_, i) => <span key={i} className="mk-lb-thumb mk-lb-thumb--ghost" />)}</div>
      ) : photos.length ? (
        <div className="mk-lb-thumbs" role="radiogroup" aria-label="Photos in this deal's folder">
          {photos.map((p) => {
            const on = p.url === url;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={on} className="mk-lb-thumb mk-press" disabled={!!busy} onClick={() => void choose(p.url)} title={p.name} aria-label={`Use ${p.name}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- folder thumbnails from Drive and storage */}
                <img src={p.url} alt="" loading="lazy" />
              </button>
            );
          })}
        </div>
      ) : demo ? null : <span style={{ fontSize: '12.5px', color: C.muted }}>No photos in this deal&apos;s folder yet. Upload one, or link the folder on the Files tab and refresh.</span>}
    </section>
  );
}
