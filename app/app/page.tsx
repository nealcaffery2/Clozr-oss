// The public front door.
//
// Deliberately plain: the same zinc/mint system as the app, one screenshot's
// worth of claim per section, no stock photography. Someone landing here is
// deciding whether CLOZR replaces the four tools they already pay for, so the
// page leads with the pipeline it covers rather than adjectives.
'use client';

import React from 'react';
import { ClozrMark } from '@/components/ds/ClozrMark';
import { useSession } from '@/lib/session';
import { Mark } from '@/components/ds/mark';

const MINT = '#0A8560';

const STAGES = [
  ['Lead', 'Speed-to-lead in seconds, not hours'],
  ['Underwrite', 'COMPR runs ARV, rehab and MAO'],
  ['Offer', 'Built from the numbers, sent from the record'],
  ['Contract', 'Stage moves, the TC file opens itself'],
  ['Dispo', 'Matched to the buyers who actually buy'],
  ['Close', 'Every cure item and deadline in one place'],
];

const FEATURES = [
  ['One dataset', 'A seller, their property, the underwrite, every call and text, the offer, the buyer and the closing file are one record — not six tools pretending to sync.'],
  ['Transaction coordination', 'Commitment exceptions, earnest money, deadlines, documents and who owes what next. Built on the Acme Homes checklists your TC already runs.'],
  ['Native comms', 'Calls, texts, voicemail and email through Talkr, logged against the record without anyone copying anything.'],
  ['Buyers that match', 'Buy boxes, market coverage and actual purchase history, so dispo starts with a list instead of a blast.'],
  ['Action plans', 'Follow-up sequences that fire on stage changes and lead source, and stop the moment someone replies.'],
  ['Reporting that answers', 'Speed to lead, cost per contract, rep leaderboards and assignment revenue — on a wall display if you want it.'],
];

export default function Landing() {
  const s = useSession();
  const appHref = s.session || s.demo ? '/app' : '/login';

  return (
    <main style={{ background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', minHeight: '100dvh' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 20px', background: 'rgba(255,255,255,.9)', backdropFilter: 'saturate(180%) blur(12px)', borderBottom: '1px solid #e4e4e7' }}>
        <ClozrMark size={19} />
        <div style={{ flex: 1 }} />
        <a href="/login" style={{ fontSize: '13.5px', fontWeight: 500, color: 'var(--muted, #52525b)', textDecoration: 'none', padding: '8px 10px' }}>
          Sign in
        </a>
        <a href={appHref} style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--surface, #fff)', background: 'var(--ink, #18181b)', borderRadius: '9px', padding: '9px 14px', textDecoration: 'none', whiteSpace: 'nowrap' }}>
          {s.demo ? 'Open the demo' : 'Open CLOZR'}
        </a>
      </header>

      <section style={{ maxWidth: '900px', margin: '0 auto', padding: '76px 20px 56px', textAlign: 'center' }}>
        <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 700, color: MINT, background: 'var(--mint-dim, #e7f8f1)', border: '1px solid #A8ECD2', borderRadius: '999px', padding: '5px 11px' }}>
          For acquisitions teams
        </span>
        <h1 style={{ margin: '20px 0 0', fontSize: 'clamp(34px, 6.2vw, 58px)', lineHeight: 1.04, letterSpacing: '-0.04em', fontWeight: 800 }}>
          One workspace.<br />Every deal moving.
        </h1>
        <p style={{ margin: '20px auto 0', maxWidth: '620px', fontSize: 'clamp(15px, 2.2vw, 18px)', lineHeight: 1.55, color: 'var(--muted, #52525b)' }}>
          Lead, property, underwriting, communications, buyers, disposition and closing.
          One CRM, one dataset, one interface — built for wholesalers who close.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', marginTop: '30px' }}>
          <a href={appHref} style={{ fontSize: '14px', fontWeight: 600, color: 'var(--on-dark, #fff)', background: MINT, borderRadius: '10px', padding: '13px 22px', textDecoration: 'none' }}>
            {s.demo ? 'Open the demo' : 'Get started'}
          </a>
          <a href="/demo" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink, #18181b)', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', padding: '13px 22px', textDecoration: 'none' }}>
            See it on sample data
          </a>
        </div>
      </section>

      <section aria-label="Pipeline" style={{ borderTop: '1px solid var(--divider, #e4e4e7)', borderBottom: '1px solid var(--divider, #e4e4e7)', background: 'var(--canvas, #fafafa)' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '34px 20px', display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))' }}>
          {STAGES.map(([name, note], i) => (
            <div key={name} style={{ background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '7px' }}>
                <span style={{ color: MINT, display: 'inline-flex' }}><Mark label={name} /></span>
                <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--meta, #71717a)' }}>
                  Step {i + 1}
                </span>
              </div>
              <div style={{ fontSize: '14.5px', fontWeight: 700, letterSpacing: '-0.01em' }}>{name}</div>
              <div style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)', marginTop: '3px', lineHeight: 1.45 }}>{note}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: '1100px', margin: '0 auto', padding: '64px 20px' }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(24px, 3.6vw, 34px)', letterSpacing: '-0.03em', fontWeight: 800 }}>
          The tools stop being separate
        </h2>
        <p style={{ margin: '10px 0 30px', maxWidth: '620px', fontSize: '15px', lineHeight: 1.6, color: 'var(--muted, #52525b)' }}>
          Every screen reads the same records. Nothing is exported, re-keyed or reconciled.
        </p>
        <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {FEATURES.map(([title, body]) => (
            <div key={title} style={{ border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '18px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</h3>
              <p style={{ margin: '7px 0 0', fontSize: '13.5px', lineHeight: 1.6, color: 'var(--muted, #52525b)' }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={{ background: 'var(--ink-hero, #141419)', color: 'var(--on-dark, #fff)' }}>
        <div style={{ maxWidth: '760px', margin: '0 auto', padding: '64px 20px', textAlign: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 'clamp(24px, 3.6vw, 34px)', letterSpacing: '-0.03em', fontWeight: 800 }}>
            Put your pipeline in one place
          </h2>
          <p style={{ margin: '12px auto 26px', maxWidth: '520px', fontSize: '15px', lineHeight: 1.6, color: 'rgba(255,255,255,.72)' }}>
            Start on sample data. Bring your own when you&rsquo;re ready.
          </p>
          <a href={appHref} style={{ display: 'inline-block', fontSize: '14px', fontWeight: 600, color: '#18181b', background: '#12D69A', borderRadius: '10px', padding: '13px 24px', textDecoration: 'none' }}>
            {s.demo ? 'Open the demo' : 'Get started'}
          </a>
        </div>
      </section>

      <footer style={{ borderTop: '1px solid var(--divider, #e4e4e7)' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '26px 20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
          <ClozrMark size={16} />
          <span style={{ fontSize: '12.5px', color: 'var(--subtle, #a1a1aa)' }}>© {new Date().getFullYear()} Acme Homes</span>
          <div style={{ flex: 1 }} />
          <a href="/login" style={{ fontSize: '12.5px', color: 'var(--muted, #52525b)', textDecoration: 'none' }}>Sign in</a>
        </div>
      </footer>
    </main>
  );
}
