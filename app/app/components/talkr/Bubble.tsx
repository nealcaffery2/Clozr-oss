'use client';

/**
 * iMessage-accurate SMS bubbles: 20px radius, a drawn tail on the last bubble
 * of a run, and the receipt line under outbound messages.
 *
 * The tail is two overlapping shapes — a rounded square in the bubble's own
 * color, then a cut-out in the thread background that carves the curve. That
 * is how iOS draws it, and why the cut-out must be told the background color
 * rather than assuming white.
 *
 * Outbound uses Talkr red rather than iOS blue, to stay in brand.
 */

import type { ReactNode } from 'react';

export function Bubble({
  mine,
  tail = true,
  background = 'var(--thread, var(--panel))',
  children,
  receipt,
  faded = false,
  maxWidth = '72%',
}: {
  mine: boolean;
  /** Only the last bubble in a run gets a tail. */
  tail?: boolean;
  /** The thread's background — the tail cut-out has to match it exactly. */
  background?: string;
  children: ReactNode;
  receipt?: ReactNode;
  /** Still sending: drawn at 60% until the carrier takes it. */
  faded?: boolean;
  maxWidth?: string;
}) {
  const fill = mine ? 'var(--accent)' : 'var(--bubble-in, #e9e9eb)';
  const color = mine ? '#fff' : 'var(--text)';
  const side = mine ? 'right' : 'left';

  return (
    <div
      className="flex flex-col"
      // iOS spacing: 2px inside a run from one side, 10px where the run ends (the tailed bubble).
      style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth, marginBottom: tail ? 10 : 2, opacity: faded ? 0.6 : 1 }}
    >
      <div className={mine ? 'relative bubble bubble-out' : 'relative bubble bubble-in'} style={{ padding: '8px 13px', borderRadius: 18, background: fill, color, font: '400 16px/1.3 var(--sans)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {children}
        {tail && (
          <>
            <span
              aria-hidden
              style={{
                position: 'absolute',
                [side]: -6,
                bottom: 0,
                width: 19,
                height: 19,
                background: fill,
                [`borderBottom${mine ? 'Left' : 'Right'}Radius`]: 16,
              } as React.CSSProperties}
            />
            <span
              aria-hidden
              style={{
                position: 'absolute',
                [side]: -9,
                bottom: 0,
                width: 11,
                height: 19,
                background,
                [`borderBottom${mine ? 'Left' : 'Right'}Radius`]: 11,
              } as React.CSSProperties}
            />
          </>
        )}
      </div>
      {receipt && (
        <span style={{ padding: mine ? '3px 4px 0 0' : '3px 0 0 4px', font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>
          {receipt}
        </span>
      )}
    </div>
  );
}

/** "Today 9:41 AM", "Yesterday 9:41 AM", "Mon, Sep 8 9:41 AM" — the iOS thread stamp. */
export function stampLabel(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], diff < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/** True when a timestamp separator belongs before this message: the first, or 15+ minutes after the previous one. */
export const needsStamp = (prev: string | null | undefined, at: string) => !prev || Date.parse(at) - Date.parse(prev) > 15 * 60_000;

/** The small centred grey stamp between groups. */
export function TimeSeparator({ at }: { at: string }) {
  return (
    <div className="self-center" style={{ margin: '10px 0 6px', font: '500 11px/1 var(--sans)', color: 'var(--muted-2)' }}>
      {stampLabel(at)}
    </div>
  );
}

/**
 * The three dots. SMS has no typing signal, so this is never "they are
 * typing": it holds the outbound side while your own send is in flight.
 */
export function TypingBubble({ inbound = false }: { inbound?: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ alignSelf: inbound ? 'flex-start' : 'flex-end', padding: '12px 16px', borderRadius: 18, background: 'var(--bubble-in, #e9e9eb)', marginBottom: 10 }}
      aria-label={inbound ? 'Typing' : 'Sending'}
    >
      {[0, 0.18, 0.36].map((delay) => (
        <span
          key={delay}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--muted-2)',
            animation: `typingdot 1.2s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
