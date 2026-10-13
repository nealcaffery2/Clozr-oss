'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, KeyRound, Lock, X } from 'lucide-react';
import { api, saveAccess } from './store';

export type GateMode = 'login' | 'join';

const PROPERTY_TYPES = ['Single family', 'Multi-family', 'Townhouse or condo', 'Land', 'Mobile home', 'Commercial'];
const STRATEGIES = ['Fix and flip', 'Buy and hold', 'BRRRR', 'Wholesale', 'Owner occupant'];
const FUNDING = ['Cash', 'Hard money', 'Private money', 'Conventional'];

type Contact = { first: string; last: string; email: string; phone: string; company: string; sms: boolean; terms: boolean };

/**
 * The sign-up wall. Like InvestorLift: an email-first log-in, and a two-step
 * join — who you are, then your buy box. Joining puts the buyer on the
 * buyers list in Clozr and unlocks full addresses, every photo and the COMPR
 * package on this device.
 */
export function BuyerGate({ mode: start, reason, markets, onClose, onUnlocked }: {
  mode: GateMode;
  reason?: string | null;
  markets: string[];
  onClose: () => void;
  onUnlocked: (name: string | null) => void;
}) {
  const [mode, setMode] = useState<GateMode>(start);
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [login, setLogin] = useState('');
  const [c, setC] = useState<Contact>({ first: '', last: '', email: '', phone: '', company: '', sms: false, terms: false });
  const [box, setBox] = useState({ markets: [] as string[], marketText: '', types: [] as string[], strategies: [] as string[], funding: [] as string[], min: '', max: '', beds: '' });
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => { first.current?.focus(); }, [mode, step]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const done = (token: string, name: string | null, buyerId: number | null) => {
    saveAccess({ token, name, buyerId });
    onUnlocked(name);
  };

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    const v = login.trim();
    if (!v) return setErr('Enter the email or phone you joined with.');
    setBusy(true); setErr('');
    const isEmail = v.includes('@');
    const r = await api.post<{ access?: string; name?: string; buyer_id?: number }>('access', isEmail ? { email: v } : { phone: v });
    setBusy(false);
    if (r.ok && r.data.access) return done(r.data.access, r.data.name ?? null, r.data.buyer_id ?? null);
    if (r.data.join) {
      setMode('join');
      setStep(1);
      setC((x) => ({ ...x, email: isEmail ? v : x.email, phone: isEmail ? x.phone : v }));
      setErr('You are not on the list yet. Join below. It takes a minute.');
      return;
    }
    setErr(r.data.error || 'That did not go through. Try again.');
  }

  function nextStep(e: React.FormEvent) {
    e.preventDefault();
    if (!c.first.trim()) return setErr('Enter your first name.');
    if (!c.email.trim() || !/^\S+@\S+\.\S+$/.test(c.email.trim())) return setErr('Enter a valid email.');
    // Phone is optional: carriers reject a campaign whose opt-in form forces a
    // number. It is only needed when the buyer ticks the box to get texts.
    const digits = c.phone.replace(/\D/g, '').length;
    if (digits && digits < 10) return setErr('Enter a 10-digit phone number, or leave it blank.');
    if (c.sms && !digits) return setErr('Add a mobile number to get deals by text, or untick the box.');
    if (!c.terms) return setErr('Agree to the terms to continue.');
    setErr('');
    setStep(2);
  }

  async function join(withBox: boolean) {
    setBusy(true); setErr('');
    const typed = box.marketText.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const allMarkets = [...new Set([...box.markets, ...typed])];
    const r = await api.post<{ access?: string; name?: string; buyer_id?: number }>('join', {
      name: [c.first.trim(), c.last.trim()].filter(Boolean).join(' '),
      email: c.email.trim(),
      phone: c.phone.trim() || undefined,
      company: c.company.trim() || undefined,
      sms_ok: c.sms && !!c.phone.trim(),
      markets: withBox ? allMarkets.join(', ') : '',
      strategy: withBox ? box.strategies[0] ?? '' : '',
      property_types: withBox ? box.types : [],
      strategy_types: withBox ? box.strategies : [],
      financing_types: withBox ? box.funding : [],
      min_price: withBox ? box.min : '',
      max_price: withBox ? box.max : '',
      beds_min: withBox ? box.beds : '',
      company_website: (document.getElementById('mk-trap') as HTMLInputElement | null)?.value ?? '',
    });
    setBusy(false);
    if (r.ok && r.data.access) return done(r.data.access, r.data.name ?? c.first.trim(), r.data.buyer_id ?? null);
    if (r.ok) return setErr('You are on the list. Refresh the page if deals do not unlock.');
    setErr(r.data.error || 'That did not go through. Try again.');
  }

  const toggle = (k: 'markets' | 'types' | 'strategies' | 'funding', v: string) =>
    setBox((b) => ({ ...b, [k]: b[k].includes(v) ? b[k].filter((x) => x !== v) : [...b[k], v] }));

  const title = mode === 'login' ? 'Welcome back' : step === 1 ? 'Join the Acme Homes buyers list' : 'Set your buy box';

  return (
    <div className="mk-modal" role="dialog" aria-modal="true" aria-labelledby="mk-gate-title">
      <button type="button" className="mk-modal-back" onClick={onClose} aria-label="Close" />
      <div className="mk-gate">
        <div className="mk-gate-head">
          {mode === 'join' && step === 2 ? (
            <button type="button" className="mk-icon-btn" onClick={() => { setStep(1); setErr(''); }} aria-label="Back to your details"><ArrowLeft size={18} aria-hidden /></button>
          ) : <span className="mk-gate-lock"><Lock size={16} aria-hidden /></span>}
          <span className="mk-gate-kicker">{mode === 'login' ? 'Log in' : `Step ${step} of 2`}</span>
          <button type="button" className="mk-icon-btn" onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
        <div className="mk-gate-body">
          <h2 id="mk-gate-title">{title}</h2>
          <p className="mk-gate-sub">
            {mode === 'login'
              ? 'Use the email or phone you joined with to see full addresses, every photo, and the COMPR report.'
              : step === 1
                ? (reason || 'Free for investors. Unlock full addresses, every photo, the COMPR report, and offers.')
                : 'Tell us what you buy and we send you the deals that fit first. You can skip this.'}
          </p>
          {mode === 'join' && step === 1 ? (
            <ul className="mk-perks">
              <li><Check size={14} aria-hidden /> Full address and every photo</li>
              <li><Check size={14} aria-hidden /> COMPR report, comps, and repair numbers</li>
              <li><Check size={14} aria-hidden /> Make offers and get new deals first</li>
            </ul>
          ) : null}

          {mode === 'login' ? (
            <form onSubmit={submitLogin} className="mk-form">
              <label>Email or phone<input ref={first} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="email" inputMode="email" placeholder="you@company.com" /></label>
              <button type="submit" className="mk-primary mk-wide" disabled={busy}><KeyRound size={16} aria-hidden />{busy ? 'Checking…' : 'Continue'}</button>
              {err ? <p className="mk-err" role="alert">{err}</p> : null}
              <p className="mk-gate-switch">New here? <button type="button" onClick={() => { setMode('join'); setStep(1); setErr(''); }}>Join the buyers list</button></p>
            </form>
          ) : step === 1 ? (
            <form onSubmit={nextStep} className="mk-form">
              <input id="mk-trap" name="company_website" tabIndex={-1} autoComplete="off" className="mk-trap" aria-hidden="true" />
              <div className="mk-two">
                <label>First name<input ref={first} value={c.first} onChange={(e) => setC({ ...c, first: e.target.value })} autoComplete="given-name" required /></label>
                <label>Last name<input value={c.last} onChange={(e) => setC({ ...c, last: e.target.value })} autoComplete="family-name" /></label>
              </div>
              <label>Email<input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} autoComplete="email" required /></label>
              <label><span>Mobile phone <span className="mk-opt">optional</span></span><input type="tel" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} autoComplete="tel" placeholder="(210) 555-0123" /></label>
              <label><span>Company <span className="mk-opt">optional</span></span><input value={c.company} onChange={(e) => setC({ ...c, company: e.target.value })} autoComplete="organization" /></label>
              <label className="mk-check">
                <input type="checkbox" checked={c.sms} onChange={(e) => setC({ ...c, sms: e.target.checked })} />
                <span><span className="mk-opt">Optional.</span> By checking this box, I agree to receive text messages from Acme Homes about new deals that fit my buy box at the mobile number above. Consent is not a condition of joining. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help.</span>
              </label>
              <label className="mk-check">
                <input type="checkbox" checked={c.terms} onChange={(e) => setC({ ...c, terms: e.target.checked })} />
                <span>I agree to the <a href="https://www.yourcompany.com/terms-of-service" target="_blank" rel="noreferrer">terms</a> and <a href="https://www.yourcompany.com/privacy-policy" target="_blank" rel="noreferrer">privacy policy</a>.</span>
              </label>
              <button type="submit" className="mk-primary mk-wide">Continue</button>
              {err ? <p className="mk-err" role="alert">{err}</p> : null}
              <p className="mk-gate-switch">Already on the list? <button type="button" onClick={() => { setMode('login'); setErr(''); }}>Log in</button></p>
            </form>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void join(true); }} className="mk-form">
              <fieldset>
                <legend>Markets</legend>
                {markets.length ? (
                  <div className="mk-chips">
                    {markets.map((m) => <button key={m} type="button" className="mk-chip" aria-pressed={box.markets.includes(m)} onClick={() => toggle('markets', m)}>{m}</button>)}
                  </div>
                ) : null}
                <input ref={first} value={box.marketText} onChange={(e) => setBox({ ...box, marketText: e.target.value })} placeholder="Other cities or counties, comma separated" aria-label="Other markets" />
              </fieldset>
              <fieldset>
                <legend>Property types</legend>
                <div className="mk-chips">{PROPERTY_TYPES.map((t) => <button key={t} type="button" className="mk-chip" aria-pressed={box.types.includes(t)} onClick={() => toggle('types', t)}>{t}</button>)}</div>
              </fieldset>
              <fieldset>
                <legend>Strategy</legend>
                <div className="mk-chips">{STRATEGIES.map((t) => <button key={t} type="button" className="mk-chip" aria-pressed={box.strategies.includes(t)} onClick={() => toggle('strategies', t)}>{t}</button>)}</div>
              </fieldset>
              <div className="mk-three">
                <label>Min price<input inputMode="numeric" value={box.min} onChange={(e) => setBox({ ...box, min: e.target.value })} placeholder="$50,000" /></label>
                <label>Max price<input inputMode="numeric" value={box.max} onChange={(e) => setBox({ ...box, max: e.target.value })} placeholder="$400,000" /></label>
                <label>Min beds
                  <select value={box.beds} onChange={(e) => setBox({ ...box, beds: e.target.value })}>
                    <option value="">Any</option>
                    {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}+</option>)}
                  </select>
                </label>
              </div>
              <fieldset>
                <legend>How you fund deals</legend>
                <div className="mk-chips">{FUNDING.map((t) => <button key={t} type="button" className="mk-chip" aria-pressed={box.funding.includes(t)} onClick={() => toggle('funding', t)}>{t}</button>)}</div>
              </fieldset>
              <button type="submit" className="mk-primary mk-wide" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock deals'}</button>
              <button type="button" className="mk-link" disabled={busy} onClick={() => void join(false)}>Skip for now</button>
              {err ? <p className="mk-err" role="alert">{err}</p> : null}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
