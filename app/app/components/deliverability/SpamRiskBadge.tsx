'use client';

// The spam-risk badge for the template editor and the email composer: a
// score and, on click, the reasons. It measures content signals only; it
// cannot promise the Primary tab, and says so.

import React, { useMemo, useState } from 'react';
import { type SpamFinding, spamRisk } from '@/lib/deliverability';
import { Badge } from './ui';

export function SpamRiskBadge({ subject, html, text, recipients, kind }: { subject: string; html?: string | null; text?: string | null; recipients?: number; kind?: 'one_to_one' | 'bulk' }) {
  const r = useMemo(() => spamRisk({ subject, html, text, recipients, kind }), [subject, html, text, recipients, kind]);
  const [open, setOpen] = useState(false);
  const tone = r.level === 'low' ? 'good' : r.level === 'medium' ? 'warn' : 'bad';
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ border: 0, padding: 0, background: 'none', cursor: 'pointer' }} title="Content signals that affect inbox placement">
        <Badge tone={tone}>Spam risk {r.score} · {r.level}</Badge>
      </button>
      {open && (
        <span role="dialog" style={{ position: 'absolute', zIndex: 30, top: '26px', right: 0, width: 'min(320px, 80vw)', background: '#fff', border: '1px solid #e4e4e7', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: '10px 12px', fontSize: '12px', lineHeight: 1.45, color: '#18181b', textAlign: 'left' }}>
          {r.findings.length === 0
            ? <span style={{ display: 'block', color: '#0A8560', fontWeight: 600 }}>Nothing in the content looks like bulk mail.</span>
            : r.findings.map((f: SpamFinding) => (
              <span key={f.key} style={{ display: 'block', padding: '4px 0', borderBottom: '1px solid #f4f4f5' }}>
                <strong>{f.label}</strong> <span style={{ color: '#a1a1aa' }}>+{f.points}</span><br />
                <span style={{ color: '#52525b' }}>{f.detail}</span>
              </span>
            ))}
          <span style={{ display: 'block', marginTop: '6px', color: '#71717a' }}>
            Gmail places mail per recipient from authentication, your domain&apos;s reputation and how people treat your mail. Content is one signal; a low score is not a promise of the Primary tab.
          </span>
        </span>
      )}
    </span>
  );
}
