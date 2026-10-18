'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { dismissDelay } from '@/lib/notif-dismiss';
import { Mark } from '@/components/ds/mark';

export type NotifListItem = {
  id: string;
  cat: string;
  text: string;
  time: string;
  isUnread: boolean;
  catColor: string;
  open: () => void;
  mute: () => void;
  /** The open button's label; '' when there is nothing to open (no button). */
  actionLabel?: string;
  /** A reply's tone (lib/reply-tone), shown as a Good or Not interested tag. */
  tone?: 'good' | 'bad' | 'auto' | null;
};

type Row = NotifListItem & { leaving: boolean; delay: number };

export type NotifListHandle = {
  /** Start the leave animation for these ids. Persistence is the caller's. */
  leave: (ids: string[]) => void;
};

const LEAVE_MS = 420;

function Check({ color = 'var(--on-dark, #fff)' }: { color?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ display: 'block' }}>
      <path d="M2.2 6.2 4.7 8.7 9.8 3.3" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NotifRow = ({ row, onOpen, onMark, onGone }: { row: Row; onOpen: (id: string) => void; onMark: (id: string) => void; onGone: (id: string) => void }) => {
  const finished = useRef(false);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    onGone(row.id);
  };
  const opens = row.actionLabel !== '' && !row.leaving;
  useEffect(() => {
    if (!row.leaving) return;
    const t = window.setTimeout(finish, row.delay + LEAVE_MS + 80);
    return () => window.clearTimeout(t);
  }, [row.leaving, row.delay, row.id]);
  return (
    <div
      data-testid="notif-row"
      data-leaving={row.leaving ? '1' : '0'}
      className={row.leaving ? 'notif-row is-out' : 'notif-row'}
      style={{ transitionDelay: row.leaving ? `${row.delay}ms` : '0ms' }}
      onTransitionEnd={(e) => {
        if (!row.leaving || e.propertyName !== 'transform') return;
        finish();
      }}
    >
      <div className="notif-row-clip">
        {/* The whole box opens what it is about; its buttons do their own thing. */}
        <div
          className={opens ? 'notif-row-card is-link' : 'notif-row-card'}
          data-testid="notif-row-card"
          title={opens ? row.actionLabel || 'Open record' : undefined}
          onClick={opens ? () => onOpen(row.id) : undefined}
          style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: '10px', padding: '11px 14px', borderBottom: '1px solid var(--divider-2, #f0f0f1)', background: row.leaving ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)' }}>
          <span className={row.leaving ? 'notif-check is-on' : undefined} style={row.leaving ? { background: '#0A8560' } : { color: row.catColor, display: 'inline-flex', marginTop: 2 }}>
            {row.leaving ? <Check /> : <Mark label={row.cat} size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: row.catColor }}>
                {row.cat}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--subtle, #a1a1aa)' }}>{row.time}</span>
              {row.tone === 'good' || row.tone === 'bad' ? (
                <span data-testid="notif-tone" style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 6px', borderRadius: '999px', background: row.tone === 'good' ? '#E7F8F1' : '#fdecec', color: row.tone === 'good' ? '#0A8560' : '#b42318' }}>
                  {row.tone === 'good' ? 'Good' : 'Not interested'}
                </span>
              ) : null}
              {row.isUnread && !row.leaving ? (
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#0A8560' }} />
              ) : null}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--ink, #18181b)', marginTop: '3px', lineHeight: 1.45 }}>{row.text}</div>
            <div className="notif-row-actions" style={{ display: 'flex', gap: '4px', marginTop: '7px', opacity: row.leaving ? 0 : 1 }}>
              {row.actionLabel !== '' ? (
                <button type="button" className="dc6" onClick={(e) => { e.stopPropagation(); onOpen(row.id); }} style={{ height: '26px', padding: '0 9px', borderRadius: '7px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
                  {row.actionLabel || 'Open record'}
                </button>
              ) : null}
              <button type="button" data-testid="notif-mark-read" className="dc2" onClick={(e) => { e.stopPropagation(); onMark(row.id); }} style={{ height: '26px', padding: '0 9px', borderRadius: '7px', border: '1px solid var(--c-btn-line)', background: 'var(--c-btn-bg)', fontSize: '11.5px', cursor: 'pointer' }}>
                Mark read
              </button>
              <button type="button" className="dc2" onClick={(e) => { e.stopPropagation(); row.mute(); }} style={{ height: '26px', padding: '0 9px', borderRadius: '7px', border: 0, background: 'none', fontSize: '11.5px', cursor: 'pointer', color: 'var(--meta, #71717a)' }}>
                Mute
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const NotifList = forwardRef<NotifListHandle, {
  items: NotifListItem[];
  onDismiss: (ids: string[]) => void;
}>(function NotifList({ items, onDismiss }, ref) {
  const [rows, setRows] = useState<Row[]>(() => items.map((it) => ({ ...it, leaving: false, delay: 0 })));
  const [itemSnap, setItemSnap] = useState(items);
  if (items !== itemSnap) {
    setItemSnap(items);
    setRows((prev) => {
      const itemById = new Map(items.map((it) => [it.id, it]));
      const seen = new Set<string>();
      const ordered: Row[] = [];
      for (const r of prev) {
        seen.add(r.id);
        if (r.leaving) {
          ordered.push(r);
          continue;
        }
        const fresh = itemById.get(r.id);
        if (fresh) ordered.push({ ...r, ...fresh, leaving: false, delay: 0 });
      }
      for (const it of items) {
        if (!seen.has(it.id)) ordered.push({ ...it, leaving: false, delay: 0 });
      }
      return ordered;
    });
  }

  const leave = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setRows((prev) => prev.map((r) => {
      const i = ids.indexOf(r.id);
      return i >= 0 && !r.leaving ? { ...r, leaving: true, delay: dismissDelay(i) } : r;
    }));
    onDismiss(ids);
  }, [onDismiss]);

  useImperativeHandle(ref, () => ({ leave }), [leave]);

  const onMark = (id: string) => leave([id]);
  const onOpen = (id: string) => {
    const row = rows.find((r) => r.id === id);
    leave([id]);
    row?.open();
  };

  const onGone = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  if (!rows.length) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center', animation: 'clozrFade .28s ease' }}>
        <span style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'var(--mint-dim, #e7f8f1)', display: 'inline-grid', placeItems: 'center' }}>
          <Check color="var(--tx-mint, #0a8560)" />
        </span>
        <div style={{ marginTop: '10px', fontSize: '13.5px', fontWeight: 650, color: 'var(--ink, #18181b)' }}>All caught up</div>
        <div style={{ marginTop: '4px', fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>Nothing waiting in this list.</div>
      </div>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <NotifRow key={row.id} row={row} onOpen={onOpen} onMark={onMark} onGone={onGone} />
      ))}
    </>
  );
});
