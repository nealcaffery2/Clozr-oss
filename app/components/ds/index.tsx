// Compr Design System primitives used by the CLOZR screens.
// Ported from the design system bundle the prototype composed against
// (components/report/OfferHero, report/ExitSelector, display/ConditionBadge)
// so the visuals match the design exactly.
'use client';

import React from 'react';
import { Mark } from '@/components/ds/mark';

export type StatusTone = 'good' | 'review' | 'danger' | 'caution';

const STATUS_COLOR: Record<StatusTone, string> = {
  good: 'var(--positive)',
  review: 'var(--mint-light)',
  danger: 'var(--negative)',
  caution: 'var(--caution)',
};

export type RingStat = { v: React.ReactNode; k: React.ReactNode };

/**
 * OfferHero — the signature near-black offer card. Big white MAO figure,
 * an orange exit tag, a blue radial glow, optional ring stats + confidence.
 */
export function OfferHero({
  label = 'Presented offer',
  exit = 'Wholesale',
  amount = '$287,400',
  subline = '',
  status = null,
  ring = [],
  confidence = null,
  style = {},
  ...rest
}: {
  label?: React.ReactNode;
  exit?: React.ReactNode;
  amount?: React.ReactNode;
  subline?: React.ReactNode;
  status?: { tone: StatusTone; text: React.ReactNode } | null;
  ring?: RingStat[];
  confidence?: number | null;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style'>) {
  const statusColor = status ? STATUS_COLOR[status.tone] : undefined;
  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--offer-surface)',
        color: '#fff',
        borderRadius: 'var(--r-xl)',
        padding: '30px 30px 26px',
        boxShadow: 'var(--shadow-lg)',
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
      {...rest}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(120% 90% at 90% -10%, rgba(10, 133, 96,0.34), transparent 58%)',
        }}
      />
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span
            style={{
              fontSize: 11,
              letterSpacing: 'var(--ls-caps-wide)',
              color: 'rgba(255,255,255,0.6)',
              fontWeight: 500,
            }}
          >
            {label}
            {exit ? <> · {exit}</> : null}
          </span>
          {status && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 11.5,
                fontWeight: 600,
                color: statusColor,
              }}
            >
              <Mark label={typeof status.text === 'string' ? status.text : status.tone} />
              {status.text}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 'var(--fs-offer)',
            fontWeight: 700,
            letterSpacing: 'var(--ls-tight)',
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {amount}
        </div>
        {subline ? (
          <div style={{ color: 'rgba(255,255,255,0.66)', fontSize: 13.5, marginTop: 10 }}>{subline}</div>
        ) : null}
        {ring.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${ring.length}, minmax(0,1fr))`,
              gap: 12,
              marginTop: 24,
              paddingTop: 20,
              borderTop: '1px solid rgba(255,255,255,0.10)',
            }}
          >
            {ring.map((r, i) => (
              <div key={i}>
                <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.v}</div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgba(255,255,255,0.55)',
                    marginTop: 3,
                  }}
                >
                  {r.k}
                </div>
              </div>
            ))}
          </div>
        )}
        {confidence != null && (
          <div style={{ marginTop: 22 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 12,
                color: 'rgba(255,255,255,0.7)',
                marginBottom: 7,
              }}
            >
              <span>Confidence</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{confidence}%</span>
            </div>
            <div style={{ height: 7, borderRadius: 99, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
              <i
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${confidence}%`,
                  borderRadius: 99,
                  background: 'linear-gradient(90deg, var(--mint), var(--mint-light))',
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export type ExitTile = { key: string; label: React.ReactNode; value: React.ReactNode };

/**
 * ExitSelector — the row of exit-strategy tiles (Wholesale, Novation,
 * Listing, Rehab, Rental, BRRRR). Selected tile gets a blue inset ring.
 */
export function ExitSelector({
  exits = [],
  value,
  onChange,
  style = {},
  ...rest
}: {
  exits?: ExitTile[];
  value?: string;
  onChange?: (key: string) => void;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'onChange'>) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(exits.length, 3)}, minmax(0,1fr))`,
        gap: 10,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
      {...rest}
    >
      {exits.map((e) => {
        const on = e.key === value;
        return (
          <button
            key={e.key}
            type="button"
            onClick={() => onChange && onChange(e.key)}
            style={{
              textAlign: 'left',
              background: 'var(--surface-card)',
              borderRadius: 'var(--r-sm)',
              padding: '13px 15px',
              border: 'none',
              cursor: 'pointer',
              boxShadow: on ? 'inset 0 0 0 1.5px var(--mint), var(--shadow-soft)' : 'var(--shadow-soft)',
              transition: 'transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.03em' }}>{e.label}</div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                marginTop: 3,
                letterSpacing: '-0.01em',
                color: on ? 'var(--mint)' : 'var(--ink)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {e.value}
            </div>
          </button>
        );
      })}
    </div>
  );
}

const COND_RAMP = [
  'var(--cond-1)',
  'var(--cond-2)',
  'var(--cond-3)',
  'var(--cond-4)',
  'var(--cond-5)',
  'var(--cond-6)',
];

/**
 * ConditionBadge — the UAD C1–C6 grade chip, coloured by the condition
 * temperature ramp (C1 green -> C6 red).
 */
export function ConditionBadge({
  grade = 'C4',
  size = 40,
  solid = false,
  style = {},
  ...rest
}: {
  grade?: string;
  size?: number;
  solid?: boolean;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'style'>) {
  const n = parseInt(String(grade).replace(/\D/g, ''), 10) || 4;
  const c = COND_RAMP[Math.min(Math.max(n, 1), 6) - 1];
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: Math.round(size * 0.28),
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-sans)',
        fontWeight: 800,
        fontSize: size * 0.4,
        letterSpacing: '-0.02em',
        color: solid ? '#fff' : c,
        background: solid ? c : `color-mix(in srgb, ${c} 14%, transparent)`,
        ...style,
      }}
      {...rest}
    >
      {grade}
    </span>
  );
}
