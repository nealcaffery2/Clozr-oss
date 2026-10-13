// Verify a signed document: /verify/. Every executed PDF's audit trail page
// points here. Upload the PDF and docs-public checks it byte for byte against
// the executed copy on file, and that the audit chain is intact. The file is
// hashed in the browser; only the hash is sent.
'use client';

import React, { useState } from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { publicFn } from '@/lib/public-fn';
import { SIGNING_CSS } from '../sign/signing.css';
import '../clozr/tokens.css';

type Result = {
  found: boolean;
  contract?: { name: string; status: string; ref: string | null; completed_at: string | null };
  chain_intact?: boolean | null; stored_pdf_intact?: boolean | null;
  signers?: { name: string | null; role: string; signed_at: string | null }[];
};

async function sha256(file: File) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export default function Verify() {
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function check(file: File) {
    setBusy(true); setErr(null); setRes(null);
    const r = await publicFn<Result>('docs-public', { action: 'verify', sha256: await sha256(file) });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setRes(r.data);
  }
  const ok = !!res?.found && res.chain_intact !== false && res.stored_pdf_intact !== false;

  return (
    <main className="cz-page">
      <style>{SIGNING_CSS}</style>
      <div className="cz-bar">
        <div className="cz-bar-in">
          <ClozrMark size={22} />
          <div className="cz-bar-title"><p className="cz-bar-name">Verify a signed document</p><p className="cz-bar-sub">Executed copies signed through CLOZR</p></div>
        </div>
      </div>
      <div className="cz-shell">
        <div className="cz-card">
          <h1 className="cz-h1">Is this the document everyone signed?</h1>
          <p className="cz-lede">Choose the signed PDF you received. It is checked against the executed copy on file without leaving your device; only its fingerprint is sent.</p>
          <input type="file" accept="application/pdf" disabled={busy} style={{ marginTop: 14 }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); }} />
          {busy ? <p className="cz-lede" style={{ marginTop: 10 }}>Checking…</p> : null}
          {err ? <div className="cz-err">{err}</div> : null}
          {res && !res.found ? <div className="cz-err">No executed document matches this file. It may have been changed after signing, or it was not signed through CLOZR.</div> : null}
          {res?.found ? (
            // Same card, set off by a divider: the verdict is the heading, coloured because it is a status.
            <section role="status" style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--cz-line, #e4e4e7)' }}>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: ok ? '#0A8560' : '#b91c1c' }}>{ok ? 'Authentic and unchanged' : 'Integrity check failed'}</h2>
              <p className="cz-lede">
                {res.contract?.name}{res.contract?.ref ? ` · ${res.contract.ref}` : ''}{res.contract?.completed_at ? ` · completed ${new Date(res.contract.completed_at).toLocaleString()}` : ''}
              </p>
              <ul className="cz-lede" style={{ margin: '10px 0 0', paddingLeft: 20, display: 'grid', gap: 4 }}>
                <li>Your file is identical to the executed copy.</li>
                <li>Audit trail: {res.chain_intact ? 'intact' : res.chain_intact === false ? 'broken' : 'not checked'}</li>
                <li>Copy on file: {res.stored_pdf_intact ? 'matches its fingerprint' : res.stored_pdf_intact === false ? 'does not match' : 'not checked'}</li>
              </ul>
              {res.signers?.length ? <p className="cz-lede" style={{ marginTop: 10 }}>Signed by {res.signers.map((s) => `${s.name ?? 'unknown'} (${s.role})${s.signed_at ? ` on ${new Date(s.signed_at).toLocaleDateString()}` : ''}`).join(', ')}.</p> : null}
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
