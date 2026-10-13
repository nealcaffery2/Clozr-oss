// A public form link: /forms/?s=<slug> (PandaDoc Forms). Whoever opens it
// gives their name and email, docs-public makes a fresh document from the
// template with them as the first signer, and they carry on at /sign/, which
// asks for the email code before it opens. Countersigners named on the form
// get their turn after.
'use client';

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { publicFn } from '@/lib/public-fn';
import { SIGNING_CSS } from '../sign/signing.css';
import '../clozr/tokens.css';

type Form = { name: string; intro: string | null; template: { name: string; kind: string }; company: { name: string; address: string; phone: string } };

export default function FormLink() {
  const slug = useSyncExternalStore(() => () => {}, () => new URLSearchParams(window.location.search).get('s') ?? '', () => null);
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const fatal = slug === '' ? 'This form link is incomplete. Ask whoever shared it for the full link.' : failed;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!slug) return;
    void publicFn<{ form: Form }>('docs-public', { action: 'form_view', slug }).then((r) => (r.ok ? setForm(r.data.form) : setFailed(r.message)));
  }, [slug]);

  async function start() {
    setBusy(true); setErr(null);
    const r = await publicFn<{ token: string }>('docs-public', { action: 'form_start', slug, name: name.trim(), email: email.trim(), phone: phone.trim() || null, origin: window.location.origin });
    if (!r.ok) { setErr(r.message); setBusy(false); return; }
    router.push(`/sign/?t=${encodeURIComponent(r.data.token)}`);
  }

  return (
    <main className="cz-page">
      <style>{SIGNING_CSS}</style>
      <div className="cz-bar">
        <div className="cz-bar-in">
          <ClozrMark size={22} />
          <div className="cz-bar-title">
            <p className="cz-bar-name">{form?.name ?? 'Form'}</p>
            <p className="cz-bar-sub">{form ? `From ${form.company.name}` : fatal ? '' : 'Loading…'}</p>
          </div>
        </div>
      </div>
      <div className="cz-shell">
        {fatal ? (
          <div className="cz-card"><h1 className="cz-h1">This form is not open</h1><p className="cz-lede">{fatal}</p></div>
        ) : form ? (
          <div className="cz-card">
            <h1 className="cz-h1">{form.name}</h1>
            {form.intro ? <p className="cz-lede" style={{ whiteSpace: 'pre-wrap' }}>{form.intro}</p> : <p className="cz-lede">Enter your details to open {form.template.name}. We email you a code to confirm it is you, then you fill it in and sign.</p>}
            <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
              <input className="cz-input" placeholder="Full legal name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="cz-input" type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="cz-input" type="tel" placeholder="Mobile (optional)" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            {err ? <div className="cz-err">{err}</div> : null}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="button" disabled={busy || name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={() => void start()} className="cz-btn cz-btn-primary">
                {busy ? 'Preparing your document…' : 'Continue'}
              </button>
            </div>
            <p className="cz-lede" style={{ marginTop: 14, fontSize: 12 }}>{[form.company.address, form.company.phone].filter(Boolean).join(' · ')}</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
