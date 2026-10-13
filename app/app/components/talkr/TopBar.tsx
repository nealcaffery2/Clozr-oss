'use client';

/**
 * Workspace header (design 1c): what you are looking at, the rep's presence,
 * their own local time, and the one primary action. It used to carry a
 * search field with nothing behind it; CLOZR's ⌘K command bar is the search.
 *
 * The clock is here because every other time in the app is somebody else's;
 * this is the anchor the rep reads them against.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Mark } from '@/components/ds/mark';
import { Button } from './ui';
import { localZone, tzAbbr, tzTime } from '@/lib/talkr-web/time';
import { PRESENCE_OPTIONS, setPresence, usePresence } from '@/lib/talkr-presence';

export function TopBar({
  title,
  subtitle,
  onNewCall,
  children,
}: {
  title: string;
  subtitle: string;
  /** CLOZR seam: Talkr pushes to /dialer; CLOZR opens its floating dialer. */
  onNewCall?: () => void;
  /** CLOZR seam: the inbox's channel tabs, between the title and the controls (a second row on a phone). */
  children?: ReactNode;
}) {
  const [now, setNow] = useState<number | null>(null);

  // Rendered only after mount: the server has no idea what zone the rep is in,
  // and a mismatched first paint is a hydration error.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const zone = localZone();

  return (
    <header
      className="glass-bar flex shrink-0 flex-wrap items-center gap-2 px-3 py-2.5 md:flex-nowrap md:gap-3.5 md:px-5 md:py-3"
      style={{ borderBottom: '1px solid var(--line)' }}
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:min-w-[190px]">
        <h1 className="truncate" style={{ font: '700 15px/1 var(--sans)', letterSpacing: '-0.015em' }}>{title}</h1>
        <p className="truncate" style={{ font: '500 11px/1 var(--sans)', color: 'var(--muted)' }}>{subtitle}</p>
      </div>

      {children ? (
        <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-2 md:order-none md:flex-1 md:basis-auto md:justify-center">{children}</div>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <PresenceMenu />

        <div
          className="hidden items-center gap-2 px-3 py-2 lg:flex"
          style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', font: '600 12px/1 var(--sans)' }}
        >
          <Icon name="clock" size={13} style={{ color: 'var(--accent)' }} />
          <span suppressHydrationWarning>
            {now === null ? '—' : `${tzTime(zone, now)} ${tzAbbr(zone, now)}`}
          </span>
        </div>

        <Button tone="accent" onClick={onNewCall} style={{ boxShadow: '0 6px 16px rgba(10, 133, 96,.28)' }}>
          <Icon name="phone" size={14} />
          <span className="hidden sm:inline">New call</span>
        </Button>
      </div>
    </header>
  );
}

/**
 * The rep's presence (lib/talkr-presence): what Talkr's floor and transfer
 * lists show, and with Do not disturb, whether calls ring here at all. Arrow
 * keys move, Escape closes and hands focus back to the button.
 */
function PresenceMenu() {
  const presence = usePresence();
  const current = PRESENCE_OPTIONS.find((o) => o.value === presence) ?? PRESENCE_OPTIONS[0]!;
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[aria-checked=true]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const els = [...(list.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? [])];
      if (!els.length) return;
      e.preventDefault();
      const i = els.indexOf(document.activeElement as HTMLElement);
      els[e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length]!.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Presence: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-2"
        style={{
          minHeight: 32,
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-btn)',
          background: 'var(--panel)',
          font: '600 12px/1 var(--sans)',
          cursor: 'pointer',
        }}
      >
        <span style={{ color: current.color, display: 'inline-flex' }}><Mark label={current.label} /></span>
        <span className="hidden sm:inline">{current.label}</span>
        <Icon name="chevron-down" size={13} style={{ color: 'var(--muted-2)' }} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div ref={list} role="menu" aria-label="Presence" className="cz-menu cz-menu--right" style={{ top: 'calc(100% + 6px)', width: 'min(296px, calc(100vw - 32px))' }}>
            {PRESENCE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === presence}
                className="cz-menu-item"
                style={{ alignItems: 'flex-start', whiteSpace: 'normal', minHeight: 44 }}
                onClick={() => { setPresence(o.value); setOpen(false); btn.current?.focus(); }}
              >
                <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: o.color, display: 'inline-flex', paddingTop: 2 }}><Mark label={o.label} /></span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span>{o.label}</span>
                    <span style={{ font: '500 11.5px/1.35 var(--sans)', color: 'var(--muted)' }}>{o.hint}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
