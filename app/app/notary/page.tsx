// A notary lands here from the email CLOZR sent: /notary/?t=<token>.
// The same email lock as signing. Once the code is entered, they apply the
// seal that was drawn from their commission when they were added.
'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { supabase } from '@/lib/supabase';
import { SIGNING_CSS } from '../sign/signing.css';
import '../clozr/tokens.css';

type NotaryView = {
  locked?: boolean;
  hint?: string | null;
  gate?: string;
  contract?: { name: string };
  stamp?: string | null;
  status?: string;
  state?: string | null;
};

async function esign<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'This page is not configured.' };
  const { data, error } = await supabase.functions.invoke('esign', { body });
  if (error) {
    let message = error.message;
    try { const ctx = (error as { context?: Response }).context; if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message; } catch { /* keep */ }
    return { ok: false, message };
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) return { ok: false, message: String((data as { error: string }).error) };
  return { ok: true, data: data as T };
}

const gateKey = (token: string) => 'notary:' + token;

export default function NotaryPage() {
  const token = useSyncExternalStore(() => () => {}, () => new URLSearchParams(window.location.search).get('t') ?? '', () => null);
  const [view, setView] = useState<NotaryView | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(gateKey(token)); } catch { /* private */ }
    void esign<NotaryView>({ action: 'notary_view', token, gate: saved }).then((r) => {
      if (!live) return;
      if (!r.ok) { setFatal(r.message); return; }
      if (!r.data.locked && saved) setGate(saved);
      setView(r.data);
    });
    return () => { live = false; };
  }, [token]);

  async function sendCode() {
    if (!token) return;
    setBusy(true); setErr(null);
    const r = await esign<{ hint?: string }>({ action: 'notary_code', token, email });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setCodeSent(true);
  }

  async function unlock() {
    if (!token) return;
    setBusy(true); setErr(null);
    const r = await esign<NotaryView>({ action: 'notary_unlock', token, email, code });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    if (r.data.gate) {
      try { sessionStorage.setItem(gateKey(token), r.data.gate); } catch { /* keep in memory */ }
      setGate(r.data.gate);
    }
    setView(r.data);
  }

  async function stamp() {
    if (!token || !gate) return;
    setBusy(true); setErr(null);
    const r = await esign<{ ok: boolean }>({ action: 'notary_stamp', token, gate });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setDone(true);
  }

  const locked = !view || view.locked || !gate;
  const name = view?.contract?.name ?? 'Document';

  return (
    <main className="cz-page">
      <style>{SIGNING_CSS}</style>
      <div className="cz-bar">
        <div className="cz-bar-in">
          <ClozrMark size={22} />
          <div className="cz-bar-title">
            <p className="cz-bar-name">{name}</p>
            <p className="cz-bar-sub">Digital notary</p>
          </div>
        </div>
      </div>
      <div className="cz-shell">
        {token === '' ? (
          <div className="cz-card">
            <h1 className="cz-h1">This link is missing its code</h1>
            <p className="cz-lede">Notary links look like <code>/notary/?t=…</code>. Open the one in the email.</p>
          </div>
        ) : null}
        {fatal && token ? (
          <div className="cz-card">
            <h1 className="cz-h1">We could not open this</h1>
            <p className="cz-lede">{fatal}</p>
          </div>
        ) : null}
        {!fatal && token && locked && !done ? (
          <div className="cz-card">
            <h1 className="cz-h1">Confirm the notary email</h1>
            <p className="cz-lede">
              Only {view?.hint ?? 'the notary this was sent to'} can apply a seal to {name}.
            </p>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" placeholder="notary@email.com" className="cz-input" style={{ marginTop: 14 }} />
            {codeSent ? <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="6-digit code" className="cz-input" style={{ marginTop: 10 }} /> : null}
            {err ? <div className="cz-err">{err}</div> : null}
            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy || !email.includes('@')} onClick={sendCode} className="cz-btn cz-btn-ghost">{codeSent ? 'Send a new code' : 'Email me a code'}</button>
              {codeSent ? <button type="button" disabled={busy || code.trim().length < 4} onClick={unlock} className="cz-btn cz-btn-primary">Open</button> : null}
            </div>
          </div>
        ) : null}
        {!fatal && token && !locked ? (
          <div className="cz-card">
            <h1 className="cz-h1">{done || view?.status === 'stamped' ? 'Seal applied' : 'Apply your seal'}</h1>
            <p className="cz-lede">{name}{view?.state ? ` · ${view.state}` : ''}</p>
            {view?.stamp ? (
              <div style={{ marginTop: 16 }} dangerouslySetInnerHTML={{ __html: view.stamp }} />
            ) : (
              <p className="cz-lede">No seal is on file yet. Ask an admin to save your commission state and expiration in Settings.</p>
            )}
            {err ? <div className="cz-err">{err}</div> : null}
            {!done && view?.status !== 'stamped' && view?.stamp ? (
              <button type="button" disabled={busy} onClick={stamp} className="cz-btn cz-btn-primary" style={{ marginTop: 16 }}>
                {busy ? 'Applying…' : 'Apply seal'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
