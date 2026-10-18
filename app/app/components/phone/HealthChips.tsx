// Settings → Numbers: a line's health as small chips (spam risk, Free Caller
// Registry, 10DLC, branded calling, STIR/SHAKEN attestation). The title on
// each chip says what it means; a click opens every signal for the line.
'use client';

import React, { useEffect } from 'react';
import type { BookLine } from '@/lib/number-book';
import { Modal } from '@/app/components/talkr/ui';
import { ReputationPanel } from './Reputation';
import { setReputationPanel, useReputation } from './reputationStore';
import { formatPhone } from '@/lib/talkr';

type Tone = 'good' | 'warn' | 'bad' | 'off';
export type Chip = { key: string; text: string; tone: Tone; detail: string };

const TONE: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: 'var(--mint-dim, #e7f8f1)', fg: '#066B47' }, // #0A8560 is 4.2:1 on this tint; this is 6:1
  warn: { bg: 'var(--caution-soft, #fef3c7)', fg: '#92400e' },
  bad: { bg: 'var(--negative-soft, #fee2e2)', fg: '#b91c1c' },
  off: { bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--muted, #52525b)' },
};

const FCR: Record<string, [string, Tone, string]> = {
  registered: ['FCR', 'good', 'Registered on the Free Caller Registry'],
  verified: ['FCR', 'good', 'Verified on the Free Caller Registry'],
  code_ready: ['FCR pending', 'warn', 'Free Caller Registry: verification code ready'],
  submitting: ['FCR pending', 'warn', 'Free Caller Registry: submitting'],
  submitted: ['FCR pending', 'warn', 'Free Caller Registry: submitted, waiting on the registry'],
  queued: ['FCR pending', 'off', 'Free Caller Registry: queued'],
  failed: ['FCR failed', 'bad', 'Free Caller Registry submission failed'],
};

/** The chips worth showing for a line; a signal with no data shows nothing. */
export function healthChips(l: Pick<BookLine, 'caller' | 'health'>): Chip[] {
  const out: Chip[] = [];
  const h = l.health;
  const c = l.caller;
  if (h?.paused) out.push({ key: 'paused', text: 'Paused', tone: 'bad', detail: 'Paused by the number guard after a warning' });
  const spam = (h?.spam_risk ?? c?.spam_risk ?? '').toLowerCase();
  if (spam) out.push({ key: 'spam', text: `Spam ${spam}`, tone: spam === 'low' ? 'good' : spam === 'medium' ? 'warn' : 'bad', detail: `Spam risk: ${spam}` });
  if (c?.fcr_status && FCR[c.fcr_status]) {
    const [text, tone, detail] = FCR[c.fcr_status]!;
    out.push({ key: 'fcr', text, tone, detail });
  }
  if (h && (h.ten_dlc_assigned !== null || h.ten_dlc_status)) {
    const ok = h.ten_dlc_assigned && h.campaign_approved !== false;
    out.push({ key: '10dlc', text: '10DLC', tone: ok ? 'good' : h.ten_dlc_assigned ? 'warn' : 'bad', detail: ok ? '10DLC: on an approved campaign' : `10DLC: ${h.ten_dlc_status ?? (h.ten_dlc_assigned ? 'campaign pending' : 'not on the campaign')}` });
  }
  if (c?.branded_attached) out.push({ key: 'brand', text: 'Branded', tone: 'good', detail: 'Branded calling attached' });
  if (h?.attestation_a_7d !== null && h?.attestation_a_7d !== undefined && (h.attestation_calls_7d ?? 0) > 0) {
    const pct = Math.round(h.attestation_a_7d * 100);
    out.push({ key: 'shaken', text: `A ${pct}%`, tone: pct >= 90 ? 'good' : pct >= 60 ? 'warn' : 'bad', detail: `STIR/SHAKEN: ${pct}% of ${h.attestation_calls_7d} calls signed A in 7 days` });
  }
  return out;
}

export function ChipView({ chip, onClick }: { chip: Pick<Chip, 'text' | 'tone' | 'detail'>; onClick?: () => void }) {
  const c = TONE[chip.tone];
  const style: React.CSSProperties = { font: '600 11px/1 var(--sans)', padding: '3px 6px', borderRadius: 6, background: c.bg, color: c.fg, whiteSpace: 'nowrap', border: 0, fontVariantNumeric: 'tabular-nums' };
  return onClick
    // 24px hit target around an 18px chip (Vercel: targets under 24px grow theirs).
    ? <button type="button" title={chip.detail} aria-label={`${chip.text}: ${chip.detail}`} onClick={onClick} className="num-press" style={{ ...style, cursor: 'pointer', minHeight: 24, display: 'inline-flex', alignItems: 'center' }}>{chip.text}</button>
    : <span title={chip.detail} style={style}>{chip.text}</span>;
}

export function HealthChips({ line, onOpen }: { line: BookLine; onOpen: () => void }) {
  const chips = healthChips(line);
  if (!chips.length) return null;
  return <span className="inline-flex flex-wrap items-center gap-1">{chips.map((c) => <ChipView key={c.key} chip={c} onClick={onOpen} />)}</span>;
}

/** Every signal for one line, and (admins, Talkr lines) the reputation controls. */
export function HealthModal({ line, admin, onClose }: { line: BookLine; admin: boolean; onClose: () => void }) {
  const chips = healthChips(line);
  const talkrId = line.talkr?.id ?? null;
  const rep = useReputation(admin && !!talkrId);
  useEffect(() => {
    if (!admin || !talkrId) return;
    setReputationPanel(talkrId);
    return () => setReputationPanel(null);
  }, [admin, talkrId]);
  const checked = line.health?.checked_at ? new Date(line.health.checked_at).toLocaleString() : null;
  return (
    <Modal title={`Health · ${formatPhone(line.phone)}`} onClose={onClose} width={620}>
      <div className="flex flex-col gap-2">
        {chips.length === 0 ? <span style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--muted)' }}>No signals yet. The morning number check fills these in.</span> : null}
        {chips.map((c) => (
          <div key={c.key} className="flex items-center gap-2">
            <ChipView chip={c} />
            <span style={{ font: '400 12.5px/1.4 var(--sans)' }}>{c.detail}</span>
          </div>
        ))}
        {checked ? <span style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>Checked {checked}</span> : null}
        {admin && talkrId ? (rep.status === 'loading' ? <span style={{ font: '400 12px/1 var(--sans)', color: 'var(--muted)' }}>Loading reputation…</span> : <ReputationPanel numberId={talkrId} />) : null}
      </div>
    </Modal>
  );
}
