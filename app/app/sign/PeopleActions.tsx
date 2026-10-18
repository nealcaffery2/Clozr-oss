// The people side of the signing page (migration 114):
//   SmsCodeGate    open the document with a code by text, for a recipient the
//                  link was texted to
//   ApprovalCard   an approver approves or rejects (with a reason) before the
//                  document goes out for signature
//   DelegateSheet  "Not the right person?" — hand the signature to someone else
'use client';

import React, { useEffect, useState } from 'react';

type Call = <T>(body: Record<string, unknown>) => Promise<{ ok: true; data: T } | { ok: false; message: string }>;

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(16,16,20,.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)',
};

/** "Text me a code instead", under the email gate. `onUnlocked` gets the view and the gate. */
export function SmsCodeGate<V>({ call, token, phoneHint, onUnlocked }: { call: Call; token: string; phoneHint: string | null; onUnlocked: (view: V & { gate?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, '');

  async function send() {
    setBusy(true); setErr(null);
    const r = await call<{ hint?: string }>({ action: 'request_code', token, channel: 'sms', phone });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setSent(true);
  }
  async function unlock() {
    setBusy(true); setErr(null);
    const r = await call<V & { gate?: string }>({ action: 'unlock', token, channel: 'sms', phone, code });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    onUnlocked(r.data);
  }

  if (!open) {
    return (
      <p className="cz-lede" style={{ marginTop: 14 }}>
        Got this by text? <button type="button" className="cz-linkbtn" onClick={() => setOpen(true)}>Text me a code instead{phoneHint ? ` (${phoneHint})` : ''}</button>
      </p>
    );
  }
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #ececf0' }}>
      <p className="cz-lede" style={{ margin: 0 }}>Enter the mobile number this was sent to{phoneHint ? <> (<b>{phoneHint}</b>)</> : null} and we will text a code.</p>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" inputMode="tel" placeholder="(210) 555-0100" className="cz-input" style={{ marginTop: 12 }} />
      {sent ? <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" className="cz-input" style={{ marginTop: 10 }} /> : null}
      {err ? <div className="cz-err">{err}</div> : null}
      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy || digits.length < 10} onClick={send} className="cz-btn cz-btn-ghost">{busy && !sent ? 'Sending…' : sent ? 'Text a new code' : 'Text me a code'}</button>
        {sent ? <button type="button" disabled={busy || code.trim().length < 4} onClick={unlock} className="cz-btn cz-btn-primary">{busy ? 'Checking…' : 'Open document'}</button> : null}
      </div>
    </div>
  );
}

/** Approve, or reject with a reason. Approving the last approval sends it for signature. */
export function ApprovalCard({ call, token, gate, company, onAnswered }: {
  call: Call; token: string; gate: string | null; company: string;
  onAnswered: (a: { approved: boolean; sent: boolean }) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function answer(approve: boolean) {
    setBusy(true); setErr(null);
    const r = await call<{ approved: boolean; sent: boolean }>({ action: approve ? 'approve' : 'reject', token, gate, reason, origin: window.location.origin });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    onAnswered({ approved: r.data.approved, sent: r.data.sent });
  }

  return (
    <div className="cz-card" style={{ borderColor: 'var(--c-action-line, #a7dcc5)' }}>
      <h2 className="cz-h1" style={{ fontSize: 18 }}>Your approval is needed</h2>
      <p className="cz-lede">{company} will not send this for signature until you approve it. Read it below, then approve, or reject it with what needs to change.</p>
      {rejecting ? (
        <>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="What needs to change?" className="cz-input" style={{ marginTop: 12, height: 'auto', padding: '10px 14px', resize: 'vertical' }} />
          {err ? <div className="cz-err">{err}</div> : null}
          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setRejecting(false)} className="cz-btn cz-btn-ghost cz-btn-sm">Back</button>
            <button type="button" disabled={busy || !reason.trim()} onClick={() => answer(false)} className="cz-btn cz-btn-sm" style={{ background: 'var(--surface, #fff)', color: 'var(--tx-red, #b91c1c)', borderColor: 'var(--tint-red-2, #fecaca)' }}>{busy ? 'Rejecting…' : 'Reject and send back'}</button>
          </div>
        </>
      ) : (
        <>
          {err ? <div className="cz-err">{err}</div> : null}
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="cz-btn cz-btn-ghost cz-btn-sm">Reject</button>
            <button type="button" disabled={busy} onClick={() => answer(true)} className="cz-btn cz-btn-primary cz-btn-sm">{busy ? 'Approving…' : 'Approve'}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Not the right person?" Hand the signature to someone else, with a reason the sender sees. */
export function DelegateSheet({ call, token, gate, onClose, onDone }: {
  call: Call; token: string; gate: string | null; onClose: () => void; onDone: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const ready = name.trim().length > 1 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && reason.trim().length > 0;
  async function submit() {
    setBusy(true); setErr(null);
    const r = await call<{ ok: boolean; name: string }>({ action: 'delegate', token, gate, name, email, phone, reason, origin: window.location.origin });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    onDone(r.data.name || name.trim());
  }

  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Hand this to someone else" className="cz-sheet" style={{ borderRadius: 16, maxWidth: 520 }}>
        <header style={{ padding: '10px 22px 0' }}>
          <h2 style={{ margin: 0, fontSize: '18px', letterSpacing: '-0.015em' }}>Not the right person?</h2>
          <p style={{ margin: '4px 0 0', fontSize: '13.5px', color: '#6b6b74' }}>Send it to whoever should sign instead. They get their own link, yours stops working, and the sender is told why.</p>
        </header>
        <div style={{ padding: '16px 22px 0', display: 'grid', gap: 12 }}>
          <label><span className="cz-label">Their full name</span><input value={name} onChange={(e) => setName(e.target.value)} className="cz-input" autoComplete="off" autoFocus /></label>
          <label><span className="cz-label">Their email</span><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="cz-input" autoComplete="off" /></label>
          <label><span className="cz-label">Their mobile (optional)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" className="cz-input" autoComplete="off" /></label>
          <label><span className="cz-label">Why</span><input value={reason} onChange={(e) => setReason(e.target.value)} className="cz-input" placeholder="e.g. My spouse is the owner on title" /></label>
          {err ? <div className="cz-err">{err}</div> : null}
        </div>
        <div className="cz-sheet-foot">
          <button type="button" onClick={onClose} className="cz-btn cz-btn-ghost">Cancel</button>
          <button type="button" disabled={!ready || busy} onClick={submit} className="cz-btn cz-btn-primary" style={{ flex: 1 }}>{busy ? 'Sending…' : 'Send it to them'}</button>
        </div>
      </div>
    </div>
  );
}
