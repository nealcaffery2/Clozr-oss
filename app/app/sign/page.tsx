// The signing page. A seller or buyer lands here from the link CLOZR sent
// them: /sign/?t=<token>. No account, no login — the token is the credential,
// checked by the esign function on every call.
//
// The shape of it is the one people already know from signing anything else
// online: a bar that says where you are, the document itself on a sheet of
// paper, a flag on your signature line that takes you there, and a sheet that
// asks you to adopt a signature before anything is committed. The dock at the
// bottom always holds exactly one next step, so there is never a question of
// what to press.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { publicFn } from '@/lib/public-fn';
import { AdoptSignature } from './AdoptSignature';
import { ApprovalCard, DelegateSheet, SmsCodeGate } from './PeopleActions';
import { PdfSigning } from './PdfSigning';
import { SIGNING_CSS } from './signing.css';

type LockedView = { locked: true; hint: string | null; contract?: { name: string }; company?: { name: string };
  /** The link was texted (migration 114): the code can come by text too. */
  sms?: boolean; phone_hint?: string | null };
type Other = { role: string; label: string | null; name: string | null; status: string; recipient_type?: string };
type View = {
  contract: { id: number; name: string; kind: string; status: string; expires_at: string | null; message: string | null; html: string;
    /** 'pdf': an uploaded form with fields laid over it (PdfSigning). */
    mode?: string };
  signer: { id: number; role: string; label: string | null; name: string | null; email: string | null; status: string; signed_at: string | null;
    /** signer · cc · viewer · filler (supabase/functions/_shared/signing-order.ts). */
    recipient_type?: string;
    /** Signed in order and someone earlier has not signed yet. */
    waiting_on?: string | null };
  others: Other[];
  company: { name: string; legal: string; address: string; email: string; phone: string };
};

/** esign: view, sign, fields. docs-public: uploads (collect file). Both take the signing token as the credential. */
const esign = <T,>(body: Record<string, unknown>) => publicFn<T>('esign', body);
const docsPublic = <T,>(body: Record<string, unknown>) => publicFn<T>('docs-public', body);

/** After the last signature, a sender-set https page (PandaDoc "redirect after signing"). */
function redirectAfter(url: string | null | undefined) {
  if (url && /^https:\/\//.test(url)) window.setTimeout(() => window.location.assign(url), 2500);
}

const gateKey = (token: string) => 'esign:' + token;
const readGate = (token: string) => { try { return sessionStorage.getItem(gateKey(token)); } catch { return null; } };
const writeGate = (token: string, gate: string) => { try { sessionStorage.setItem(gateKey(token), gate); } catch { /* private mode keeps the gate in memory */ } };

const day = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '');
const initials = (n: string | null | undefined, fallback: string) => {
  const parts = (n ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback.slice(0, 1).toUpperCase();
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

export default function SignPage() {
  // The token from ?t=, read on the client only (the page is prerendered without one).
  const token = useSyncExternalStore(() => () => {}, () => new URLSearchParams(window.location.search).get('t') ?? '', () => null);
  const [view, setView] = useState<View | null>(null);
  const [locked, setLocked] = useState<LockedView | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ completed: boolean; pdf_url: string | null; waiting?: number } | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  // Migration 114: an approver's answer, and a signature handed to someone else.
  const [answered, setAnswered] = useState<{ approved: boolean; sent: boolean } | null>(null);
  const [delegating, setDelegating] = useState(false);
  const [handedTo, setHandedTo] = useState<string | null>(null);
  const paper = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    const saved = readGate(token);
    void esign<View & { locked?: boolean; hint?: string | null }>({ action: 'view', token, gate: saved }).then((r) => {
      if (!live) return;
      if (!r.ok) { setFatal(r.message); return; }
      if (r.data.locked) { setLocked(r.data as LockedView); setView(null); return; }
      setGate(saved);
      setLocked(null);
      setView(r.data);
    });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    if (!token || !gate || !view) return;
    const id = window.setInterval(() => { void esign({ action: 'heartbeat', token, gate }); }, 20000);
    return () => window.clearInterval(id);
  }, [token, gate, view]);

  const c = view?.contract;
  const me = view?.signer;
  const missingToken = token === '';
  // A form filler who pressed Done is finished the same way a signer who signed is.
  const alreadySigned = me?.status === 'signed' || me?.status === 'filled';
  const pdfMode = c?.mode === 'pdf';
  const isFiller = me?.recipient_type === 'filler';
  const closed = c ? ['voided', 'declined', 'expired'].includes(c.status) : false;
  const completed = c?.status === 'completed' || !!done?.completed;
  const readOnly = !!me?.recipient_type && !['signer', 'approver', 'filler'].includes(me.recipient_type);
  const waitingOn = me?.waiting_on ?? null;
  const isApprover = me?.recipient_type === 'approver';
  const canSign = !!c && !alreadySigned && !closed && !completed && c.status !== 'draft' && !done && !readOnly && !waitingOn && !isApprover && !handedTo;
  const canApprove = !!c && isApprover && c.status === 'awaiting_approval' && !answered && !handedTo && !['approved', 'rejected'].includes(me?.status ?? '');

  /** Jump to my signature line in the document. */
  async function sendCode() {
    if (!token) return;
    setBusy(true); setErr(null);
    const r = await esign<{ hint?: string }>({ action: 'request_code', token, email });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setCodeSent(true);
  }

  async function unlock() {
    if (!token) return;
    setBusy(true); setErr(null);
    const r = await esign<View & { gate?: string; locked?: boolean }>({ action: 'unlock', token, email, code });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    if (r.data.gate) { writeGate(token, r.data.gate); setGate(r.data.gate); }
    setLocked(null);
    setView(r.data);
  }

  const goToSignature = useCallback(() => {
    const el = paper.current?.querySelector<HTMLElement>('.sig.mine');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  /**
   * Turn my own signature line into something pressable.
   *
   * The document arrives as HTML from the contract engine, so the flag is
   * grafted on after render rather than rendered by React. It is removed on
   * cleanup, which keeps this safe to re-run whenever the state it depends on
   * changes.
   */
  useEffect(() => {
    const root = paper.current;
    if (!root || !me) return;
    const block = root.querySelector<HTMLElement>(`.sig[data-role="${CSS.escape(me.role)}"]`);
    const line = block?.querySelector<HTMLElement>('.sig-line');
    if (!block || !line) return;
    if (!canSign) { block.classList.remove('is-armed'); return; }

    block.classList.add('is-armed');
    const blank = line.querySelector('.blank');
    if (blank) blank.remove();
    const flag = document.createElement('button');
    flag.type = 'button';
    flag.className = 'cz-flag is-armed';
    flag.textContent = 'Sign here';
    flag.addEventListener('click', () => setAdopting(true));
    line.appendChild(flag);
    return () => { flag.remove(); block.classList.remove('is-armed'); };
  }, [canSign, me, view]);

  async function adopt({ name, png }: { name: string; png: string | null }) {
    if (!token) return;
    setBusy(true); setErr(null);
    const r = await esign<{ ok: boolean; completed: boolean; pdf_url?: string | null; waiting_on?: number; redirect_url?: string | null }>({
      action: 'sign', token, gate, name, signature_png: png, consent: true,
    });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setAdopting(false);
    setDone({ completed: r.data.completed, pdf_url: r.data.pdf_url ?? null, waiting: r.data.waiting_on });
    redirectAfter(r.data.redirect_url);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function decline() {
    if (!token) return;
    setBusy(true); setErr(null);
    const r = await esign<{ ok: boolean }>({ action: 'decline', token, gate, reason });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setView((v) => (v ? { ...v, contract: { ...v.contract, status: 'declined' }, signer: { ...v.signer, status: 'declined' } } : v));
    setDeclining(false);
  }

  async function pdf() {
    if (!token) return;
    const r = await esign<{ url: string }>({ action: 'pdf', token, gate });
    if (!r.ok) { setErr(r.message); return; }
    window.open(r.data.url, '_blank', 'noopener');
  }

  const status = useMemo(() => {
    if (!c) return null;
    if (completed) return { cls: 'cz-pill-done', text: 'Completed' };
    if (c.status === 'declined') return { cls: 'cz-pill-bad', text: 'Declined' };
    if (c.status === 'voided') return { cls: 'cz-pill-dead', text: 'Voided' };
    if (c.status === 'expired') return { cls: 'cz-pill-dead', text: 'Expired' };
    if (alreadySigned || done) return { cls: 'cz-pill-done', text: isFiller ? 'You are done' : 'You signed' };
    if (isApprover) return me?.status === 'approved' || answered?.approved ? { cls: 'cz-pill-done', text: 'You approved' } : { cls: 'cz-pill-wait', text: c.status === 'awaiting_approval' ? 'Needs your approval' : 'Approver' };
    return { cls: 'cz-pill-wait', text: isFiller ? 'Needs your input' : 'Needs your signature' };
  }, [c, completed, alreadySigned, done, isApprover, isFiller, me, answered]);

  const signingParties = (view?.others ?? []).filter((o) => o.recipient_type !== 'cc' && o.recipient_type !== 'viewer');
  const signedCount = signingParties.filter((o) => o.status === 'signed' || o.status === 'filled').length + (alreadySigned || done ? 1 : 0);
  const total = signingParties.length + 1;
  const partyStatus = (p: { status: string; recipient_type?: string }) => {
    if (p.recipient_type === 'cc') return 'Gets copy when done';
    if (p.recipient_type === 'viewer') return 'Viewer';
    if (p.status === 'signed' || p.status === 'filled') return p.status === 'filled' ? 'Filled in' : 'Signed';
    if (p.status === 'declined') return 'Declined';
    if (p.status === 'viewed') return 'Viewed';
    return 'Waiting';
  };

  return (
    <main className="cz-page">
      <style>{SIGNING_CSS}</style>

      <div className="cz-bar">
        <div className="cz-bar-in">
          <ClozrMark size={22} />
          <div className="cz-bar-title">
            <p className="cz-bar-name">{c?.name ?? 'Secure signing'}</p>
            <p className="cz-bar-sub">{view?.company.name ? `Sent by ${view.company.name}` : locked?.contract?.name ? 'Confirm your email to open it' : 'Loading…'}</p>
          </div>
          {status ? <span className={`cz-pill ${status.cls}`}>{status.text}</span> : null}
        </div>
      </div>

      <div className="cz-shell">
        {missingToken ? (
          <div className="cz-card">
            <h1 className="cz-h1">This link is missing its code</h1>
            <p className="cz-lede">Signing links look like <code>/sign/?t=…</code>. Ask whoever sent it for a fresh one and it will open straight to your document.</p>
          </div>
        ) : null}

        {fatal && !missingToken ? (
          <div className="cz-card">
            <h1 className="cz-h1">We could not open this document</h1>
            <p className="cz-lede">{fatal}</p>
            <p className="cz-lede" style={{ marginTop: 10 }}>If you were expecting to sign something, ask the sender to send the link again — links expire, and each one only works for one signer.</p>
          </div>
        ) : null}

        {locked && !view && !fatal && !missingToken ? (
          <div className="cz-card">
            <h1 className="cz-h1">This document is locked to one email</h1>
            <p className="cz-lede">
              {locked.contract?.name ? `${locked.contract.name} opens only for ` : 'It opens only for '}
              <b>{locked.hint ?? 'the address it was sent to'}</b>. Enter that email and we will send a code.
            </p>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@email.com" className="cz-input" style={{ marginTop: 14 }} />
            {codeSent ? (
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" className="cz-input" style={{ marginTop: 10 }} />
            ) : null}
            {err ? <div className="cz-err">{err}</div> : null}
            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy || !email.includes('@')} onClick={sendCode} className="cz-btn cz-btn-ghost">{busy && !codeSent ? 'Sending…' : codeSent ? 'Send a new code' : 'Email me a code'}</button>
              {codeSent ? <button type="button" disabled={busy || code.trim().length < 4} onClick={unlock} className="cz-btn cz-btn-primary">{busy ? 'Checking…' : 'Open document'}</button> : null}
            </div>
            {locked.sms && token ? (
              <SmsCodeGate<View> call={esign} token={token} phoneHint={locked.phone_hint ?? null} onUnlocked={(v) => {
                if (v.gate) { writeGate(token, v.gate); setGate(v.gate); }
                setLocked(null);
                setView(v);
              }} />
            ) : null}
          </div>
        ) : null}

        {!view && !locked && !fatal && !missingToken ? (
          <div className="cz-card"><p className="cz-lede" style={{ margin: 0 }}>Opening your document…</p></div>
        ) : null}

        {view && c && me ? (
          <>
            {handedTo ? (
              <div className="cz-card cz-done">
                <div className="cz-check" aria-hidden>✓</div>
                <h1 className="cz-h1">Sent to {handedTo}</h1>
                <p className="cz-lede" style={{ maxWidth: 440, margin: '8px auto 0' }}>They have their own link now, and {view.company.name} has been told. This link no longer opens the document.</p>
              </div>
            ) : null}
            {canApprove && token ? (
              <ApprovalCard call={esign} token={token} gate={gate} company={view.company.name} onAnswered={(a) => {
                setAnswered(a);
                setView((v) => (v ? { ...v, contract: { ...v.contract, status: a.approved ? (a.sent ? 'sent' : 'awaiting_approval') : 'draft' }, signer: { ...v.signer, status: a.approved ? 'approved' : 'rejected' } } : v));
              }} />
            ) : null}
            {answered ? (
              <div className="cz-card">
                <h2 className="cz-h1" style={{ fontSize: 18 }}>{answered.approved ? (answered.sent ? 'Approved and sent' : 'Approved') : 'Sent back'}</h2>
                <p className="cz-lede">{answered.approved ? (answered.sent ? 'It has gone out for signature.' : 'It goes out when the other approvers approve too.') : 'It is back with the sender, with your reason.'}</p>
              </div>
            ) : null}
            {done ? (
              <div className="cz-card cz-done">
                <div className="cz-check" aria-hidden>✓</div>
                <h1 className="cz-h1">{done.completed ? 'All signed' : isFiller ? 'Your part is done' : 'Your signature is in'}</h1>
                <p className="cz-lede" style={{ maxWidth: 440, margin: '8px auto 0' }}>
                  {done.completed
                    ? 'Everyone has signed. Your completed copy, with the signature certificate, is ready to download.'
                    : `We are waiting on ${done.waiting ?? 1} more signature${(done.waiting ?? 1) === 1 ? '' : 's'}. You will get an email with the completed document, and this same link will always have the latest copy.`}
                </p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
                  <button type="button" onClick={pdf} className="cz-btn cz-btn-primary">Download your copy</button>
                </div>
                {err ? <div className="cz-err" style={{ textAlign: 'left' }}>{err}</div> : null}
              </div>
            ) : (
              <div className="cz-card">
                <h1 className="cz-h1">{c.name}</h1>
                <p className="cz-lede">
                  {completed ? 'This document is complete and signed by all parties.'
                    : alreadySigned ? 'You have signed. We are waiting on the other parties.'
                    : c.status === 'declined' ? 'This document was declined.'
                    : closed ? `This document is ${c.status}.`
                    : c.status === 'draft' ? 'This document has not been sent for signature yet.'
                    : isApprover ? `${view.company.name} has asked you to approve this before it goes out for signature.`
                    : `${view.company.name} has asked you to review and sign as ${me.label || me.role}.`}
                  {c.expires_at && !completed && !closed && !alreadySigned ? ` Please sign by ${day(c.expires_at)}.` : ''}
                </p>

                {c.message ? (
                  <div className="cz-note">
                    <span className="cz-note-from">Message from {view.company.name}</span>
                    {c.message}
                  </div>
                ) : null}

                <ul className="cz-parties">
                  {[{ role: me.role, label: me.label, name: me.name, status: done ? (isFiller ? 'filled' : 'signed') : me.status, mine: true },
                    ...view.others.map((o) => ({ ...o, mine: false }))].map((p) => {
                    const isCc = p.recipient_type === 'cc' || p.recipient_type === 'viewer';
                    const isDone = !isCc && (p.status === 'signed' || p.status === 'filled');
                    return (
                      <li className="cz-party" key={`${p.role}-${p.mine ? 'me' : 'other'}`}>
                        <span className={`cz-dot${isDone ? ' is-done' : p.mine ? ' is-me' : isCc ? ' is-cc' : ''}`} aria-hidden>
                          {isDone ? '✓' : initials(p.name, p.label || p.role)}
                        </span>
                        <span className="cz-party-who">{p.name || p.label || p.role}{p.mine ? ' (you)' : ''}</span>
                        <span className="cz-party-role">{partyStatus(p)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {pdfMode && token ? (
              <PdfSigning
                token={token} gate={gate} api={esign} upload={docsPublic} me={me} canAct={canSign && !declining}
                onDone={(d) => { setDone(d); window.scrollTo({ top: 0, behavior: 'smooth' }); redirectAfter(d.redirect_url); }}
                onDecline={() => setDeclining(true)}
              />
            ) : (
              <div className="cz-paper">
                <div className="cz-paper-top">
                  <span style={{ flex: 1 }}>{signedCount} of {total} signed</span>
                  <button type="button" onClick={pdf} className="cz-linkbtn">Download PDF</button>
                </div>
                <article className="doc" ref={paper} dangerouslySetInnerHTML={{ __html: c.html }} />
              </div>
            )}

            {declining ? (
              <div className="cz-card">
                <h2 className="cz-h1" style={{ fontSize: 17 }}>Decline to sign</h2>
                <p className="cz-lede">The sender will be told you declined. You can add a reason so they know why.</p>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="cz-input" style={{ marginTop: 12 }} />
                {err ? <div className="cz-err">{err}</div> : null}
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button type="button" onClick={() => setDeclining(false)} className="cz-btn cz-btn-ghost cz-btn-sm">Back</button>
                  <button type="button" disabled={busy} onClick={decline} className="cz-btn cz-btn-sm" style={{ background: 'var(--surface, #fff)', color: 'var(--tx-red, #b91c1c)', borderColor: 'var(--tint-red-2, #fecaca)' }}>
                    {busy ? 'Declining…' : 'Decline document'}
                  </button>
                </div>
              </div>
            ) : null}

            <p className="cz-foot">
              {view.company.legal || view.company.name}
              {view.company.address ? <><br />{view.company.address}</> : null}
              {view.company.phone || view.company.email ? <><br />{[view.company.phone, view.company.email].filter(Boolean).join(' · ')}</> : null}
              <br />Signed electronically. Your signature is legally binding under the U.S. ESIGN Act and UETA.
            </p>
          </>
        ) : null}
      </div>

      {view && c && me && !declining && !(pdfMode && canSign) ? (
        <div className="cz-dock">
          <div className="cz-dock-in">
            <span className="cz-dock-stat">
              {done || alreadySigned ? <><b>Done.</b> Nothing else is needed from you.</>
                : canSign ? <><b>1 signature</b> is needed from you on this document.</>
                : readOnly && !completed ? <>You are {me.recipient_type === 'cc' ? 'copied on' : 'viewing'} this document. {me.recipient_type === 'cc' ? 'The signed copy comes to you when everyone has signed.' : 'There is nothing for you to sign.'}</>
                : waitingOn && !completed && !closed ? <>This is signed in order. It is waiting on <b>{waitingOn}</b> first; you will get an email when it is your turn.</>
                : canApprove ? <><b>Your approval</b> is needed before this goes out.</>
                : c.status === 'awaiting_approval' ? <>This is waiting on an internal approval before anyone signs.</>
                : <>This document is {completed ? 'complete' : c.status}.</>}
            </span>
            {canSign || canApprove ? <button type="button" onClick={() => setDelegating(true)} className="cz-linkbtn">Not the right person?</button> : null}
            {canSign ? (
              <>
                <button type="button" onClick={() => setDeclining(true)} className="cz-linkbtn">Decline</button>
                <button type="button" onClick={goToSignature} className="cz-btn cz-btn-ghost cz-btn-sm">Go to signature</button>
                <button type="button" onClick={() => setAdopting(true)} className="cz-btn cz-btn-primary">Sign document</button>
              </>
            ) : (
              <button type="button" onClick={pdf} className="cz-btn cz-btn-ghost">Download PDF</button>
            )}
          </div>
        </div>
      ) : null}

      {delegating && token ? (
        <DelegateSheet call={esign} token={token} gate={gate} onClose={() => setDelegating(false)} onDone={(n) => { setDelegating(false); setHandedTo(n); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      ) : null}
      {adopting && me ? (
        <AdoptSignature
          initialName={me.name ?? ''}
          role={me.label || me.role}
          busy={busy}
          error={err}
          onClose={() => { setAdopting(false); setErr(null); }}
          onAdopt={adopt}
        />
      ) : null}
    </main>
  );
}
