// Settings → Outbound OS: campaign email, sending domain, Gmail 1:1, and the
// keys that drive them. Phone / SMS / 10DLC stay in Talkr; this is the email
// half of outbound. CLOZR never adds open-tracking pixels to one-to-one email,
// and AgentMail is not on this pipe (it stays on inbound and agent inboxes).
'use client';

import React, { useState } from 'react';
import { DeliverabilitySettings } from '@/app/components/deliverability/DeliverabilitySettings';
import { GoogleConnect, GoogleDriveCard } from '@/components/GoogleConnect';
import { resendWebhookUrl } from '@/lib/deliverability';
import { useSession } from '@/lib/session';
import type { OutboundSettingsTab } from './settingsTab';

const card: React.CSSProperties = {
  background: 'var(--surface, #fff)',
  border: '1px solid var(--divider, #e4e4e7)',
  borderRadius: '12px',
  padding: '16px 18px',
  marginBottom: '12px',
};
const h2: React.CSSProperties = { margin: '0 0 4px', fontSize: '14px', fontWeight: 600 };
const sub: React.CSSProperties = { margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };
const row: (isMobile: boolean) => React.CSSProperties = (isMobile) => ({
  display: 'grid',
  gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 210px) 1fr',
  gap: isMobile ? '3px' : '10px', padding: '8px 0',
  borderTop: '1px solid var(--divider-2, #f0f0f1)', fontSize: '12.5px',
});
const code: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', color: 'var(--ink, #18181b)', wordBreak: 'break-all' };

/**
 * One section of Settings → Outbound OS. The section header (title and what it
 * covers) is drawn by Settings from its nav, so each pane starts at its cards.
 */
export function OutboundOsSettings({ section, isMobile }: { section: OutboundSettingsTab; isMobile: boolean }) {
  const s = useSession();
  if (section === 'google') return (
    <>
      <GoogleConnect workspaceId={s.workspace?.id ?? null} demo={s.demo} userId={s.user?.id ?? null} />
      <GoogleDriveCard workspaceId={s.workspace?.id ?? null} demo={s.demo} />
    </>
  );
  if (section === 'keys') return <EmailSecrets isMobile={isMobile} />;
  return <DeliverabilitySettings workspaceId={s.workspace?.id ?? null} demo={s.demo} />;
}

function EmailSecrets({ isMobile }: { isMobile: boolean }) {
  const hook = resendWebhookUrl();
  const [copied, setCopied] = useState(false);
  return (
    <div style={card}>
      <h2 style={h2}>Email keys</h2>
      <p style={sub}>
        Project secrets on the Supabase project (Edge Functions → Secrets). They are never entered or shown here.
        Without Resend, signing links are copied or texted and campaigns fall back to a connected Gmail account.
      </p>
      <div style={row(isMobile)}><span style={code}>RESEND_API_KEY + MAIL_FROM</span><span style={{ color: 'var(--muted, #52525b)' }}>Resend · signing-link mail (transactional). MAIL_FROM is the company from, not a Gmail address.</span></div>
      <div style={row(isMobile)}><span style={code}>MAIL_FROM_BLASTS</span><span style={{ color: 'var(--muted, #52525b)' }}>Dispo campaign from. Prefer Acme Homes &lt;deals@deals.yourcompany.com&gt; so a blast cannot burn the root domain or a rep&apos;s Gmail. Falls back to MAIL_FROM.</span></div>
      <div style={row(isMobile)}><span style={code}>RESEND_WEBHOOK_SECRET</span><span style={{ color: 'var(--muted, #52525b)' }}>Svix signing secret from Resend → Webhooks. Posts bounces and spam complaints so they land on the suppression list.</span></div>
      <div style={row(isMobile)}><span style={code}>GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET</span><span style={{ color: 'var(--muted, #52525b)' }}>The OAuth client behind Connect Google. Calendar sync and 1:1 Gmail / campaign Reply-To.</span></div>
      <div style={{ marginTop: '12px' }}>
        <div style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 500, marginBottom: '5px' }}>Resend webhook URL</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...code, flex: 1, minWidth: '200px', padding: '8px 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', background: 'var(--canvas, #fafafa)' }}>{hook || 'Supabase is not configured'}</span>
          <button type="button" disabled={!hook} onClick={() => { void navigator.clipboard?.writeText(hook).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} style={{ height: '34px', padding: '0 12px', borderRadius: '9px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
          In Resend → Webhooks, subscribe email.bounced, email.failed and email.complained. Put the signing secret on the project as RESEND_WEBHOOK_SECRET.
        </p>
      </div>
    </div>
  );
}
