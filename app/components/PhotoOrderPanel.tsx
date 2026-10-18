// Order photos from iVueit, inside a deal's Files & photos (deal sheet, TC
// file). One click opens the form with the address and survey filled in; the
// order line under it says where the Vue is, and the photos land in the
// gallery above when the Vuer is done (webhook, cron sweep, or Check now).
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  type IvueitStatus, type PhotoOrderRow, cancelPhotoOrder, checkPhotoOrder, ivueitStatus, listPhotoOrders, orderLine, orderPhotos,
} from '@/lib/ivueit';

const btn: React.CSSProperties = { height: '30px', padding: '0 11px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)', whiteSpace: 'nowrap' };
const primary: React.CSSProperties = { ...btn, background: '#0A8560', borderColor: '#0A8560', color: '#fff' };
const link: React.CSSProperties = { border: 0, background: 'none', padding: '4px 2px', minHeight: '24px', font: 'inherit', fontSize: '12px', fontWeight: 600, color: 'var(--tx-mint, #0a8560)', cursor: 'pointer' };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', fontWeight: 500, color: 'var(--meta, #71717a)', marginBottom: '4px' };
const STALE_MS = 10 * 60_000;

export function PhotoOrderPanel({ workspaceId, dealId, canWrite, open, onClose, onToast, onPhotosIn }: {
  workspaceId: number; dealId: number; canWrite: boolean;
  /** The form is showing (the Order photos button above toggles it). */
  open: boolean; onClose: () => void;
  onToast: (m: string) => void;
  /** Photos just landed on the deal: reload the gallery. */
  onPhotosIn: () => void;
}) {
  const [orders, setOrders] = useState<PhotoOrderRow[] | null>(null);
  const [status, setStatus] = useState<IvueitStatus | { error: string } | null>(null);
  const [notes, setNotes] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const loadOrders = useCallback(async () => setOrders(await listPhotoOrders(dealId)), [dealId]);
  useEffect(() => { const t = setTimeout(() => void loadOrders(), 0); return () => clearTimeout(t); }, [loadOrders]);

  // An open order nobody has checked lately: ask iVueit once, quietly. The
  // webhook and the 20-minute sweep normally get there first.
  useEffect(() => {
    const stale = (orders ?? []).filter((o) => o.status === 'ordered' && o.vue_id
      && Date.now() - new Date(o.checked_at ?? o.created_at).getTime() > STALE_MS);
    if (!stale.length || !canWrite) return;
    let live = true;
    void Promise.all(stale.slice(0, 3).map((o) => checkPhotoOrder(workspaceId, o.id))).then((rs) => {
      if (!live) return;
      if (rs.some((r) => r.ok && r.status === 'completed')) onPhotosIn();
      void loadOrders();
    });
    return () => { live = false; };
    // Only when the order list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders?.map((o) => `${o.id}:${o.status}`).join(',')]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(() => {
      setStatus(null);
      void ivueitStatus(workspaceId, dealId).then((r) => {
        if (!live) return;
        if (!r.ok) { setStatus({ error: r.message }); return; }
        setStatus(r);
        setTemplate(r.template_id ?? (r.templates.length === 1 ? r.templates[0].id : ''));
      });
    }, 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, workspaceId, dealId]);

  const place = async (again = false) => {
    setBusy('order');
    const r = await orderPhotos(workspaceId, dealId, { templateId: template || null, notes, urgent, again });
    setBusy(null);
    if (!r.ok) {
      if (/already on order/i.test(r.message) && window.confirm('Photos are already on order for this house. Order another set anyway?')) return void place(true);
      return onToast(r.message);
    }
    onToast('Photos ordered. They land here when the Vuer is done.');
    setOrders(r.orders);
    setNotes(''); setUrgent(false);
    onClose();
  };
  const check = async (o: PhotoOrderRow) => {
    setBusy('check:' + o.id);
    const r = await checkPhotoOrder(workspaceId, o.id);
    setBusy(null);
    if (!r.ok) return onToast(r.message);
    if (r.status === 'completed') { onToast(`${r.photos} iVueit photo${r.photos === 1 ? '' : 's'} added to the deal`); onPhotosIn(); }
    else onToast(r.status === 'ordered' ? 'Not shot yet. The photos land here the moment they are.' : 'That order is closed.');
    void loadOrders();
  };
  const cancel = async (o: PhotoOrderRow) => {
    if (!window.confirm(`Cancel the iVueit order for ${o.address ?? 'this house'}?`)) return;
    setBusy('cancel:' + o.id);
    const r = await cancelPhotoOrder(workspaceId, o.id);
    setBusy(null);
    onToast(r.ok ? 'Photo order canceled' : r.message);
    void loadOrders();
  };

  const shownOrders = (orders ?? []).filter((o, i) => o.status === 'ordered' || i < 3);
  const s = status && 'connected' in status ? status : null;
  const tpl = s?.templates.find((t) => t.id === template) ?? null;
  const ready = !!s?.connected && s.address_ok && !s.problem && (!!template || (s.templates.length <= 1));

  return (
    <>
      {open ? (
        <section aria-label="Order photos from iVueit" data-testid="ivueit-order" style={{ marginTop: '10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', padding: '12px', background: 'var(--canvas, #fafafa)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: 650, color: 'var(--ink, #18181b)' }}>Order photos from iVueit</span>
            {s?.staging ? <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--tx-amber, #b45309)', background: 'var(--caution-soft, #fef3c7)', borderRadius: '6px', padding: '1px 6px' }}>Staging</span> : null}
          </div>
          {status === null ? (
            <p style={{ margin: '8px 0 0', fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>Checking iVueit…</p>
          ) : 'error' in status ? (
            <p role="alert" style={{ margin: '8px 0 0', fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>{status.error}</p>
          ) : !status.connected ? (
            <p style={{ margin: '8px 0 0', fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)', lineHeight: 1.5 }}>
              iVueit is not connected yet. An owner or admin adds the API key and secret under Settings → Integrations, then anyone on the team can order.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: '10px', marginTop: '8px' }}>
              <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)', lineHeight: 1.5 }}>
                A local Vuer photographs <strong style={{ fontWeight: 650, color: 'var(--ink, #18181b)' }}>{status.address || 'this house'}</strong>
                {tpl?.slaHours ? `, usually within ${tpl.slaHours} hours` : ''}. The photos and the report PDF land on this deal by themselves.
              </p>
              {!status.address_ok ? (
                <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>iVueit needs the street, city, state and ZIP. Fix the address on the record first.</p>
              ) : null}
              {status.problem ? <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>{status.problem}</p> : null}
              {status.templates.length > 1 ? (
                <div>
                  <label htmlFor={`ivu-tpl-${dealId}`} style={label}>Survey</label>
                  <select id={`ivu-tpl-${dealId}`} value={template} onChange={(e) => setTemplate(e.target.value)}
                    style={{ height: '32px', width: '100%', maxWidth: '420px', padding: '0 8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', background: 'var(--surface, #fff)', fontSize: '13px', color: 'var(--ink, #18181b)' }}>
                    <option value="">Pick a survey</option>
                    {status.templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}{t.cost != null ? ` · $${t.cost.toFixed(2)}` : ''}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label htmlFor={`ivu-notes-${dealId}`} style={label}>Access notes for the Vuer</label>
                <textarea id={`ivu-notes-${dealId}`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000}
                  placeholder="Lockbox 1234 on the back door. Occupied: text the seller 30 minutes ahead."
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', resize: 'vertical', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)' }} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)', minHeight: '24px', cursor: 'pointer', width: 'fit-content' }}>
                <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} style={{ width: '16px', height: '16px', accentColor: 'var(--tx-mint, #0a8560)' }} />
                Rush order (iVueit charges more)
              </label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" data-testid="ivueit-place" style={{ ...primary, opacity: !ready || !!busy ? 0.5 : 1, cursor: !ready || !!busy ? 'not-allowed' : 'pointer' }}
                  disabled={!ready || !!busy || (status.templates.length > 1 && !template)} onClick={() => void place()}>
                  {busy === 'order' ? 'Ordering…' : 'Order photos'}
                </button>
                <button type="button" style={btn} onClick={onClose}>Not now</button>
                {tpl?.cost != null ? <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>${tpl.cost.toFixed(2)} per order{urgent ? ' plus the rush fee' : ''}</span> : null}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {shownOrders.length ? (
        <ul aria-label="iVueit photo orders" style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid', gap: '4px' }}>
          {shownOrders.map((o) => (
            <li key={o.id} data-testid="ivueit-order-line" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--ink-3, #3f3f46)' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, borderRadius: '6px', padding: '1px 6px', ...TONE[o.status] }}>{WORD[o.status]}</span>
              <span style={{ color: o.status === 'failed' ? '#b91c1c' : 'var(--ink-3, #3f3f46)', minWidth: 0 }}>iVueit · {orderLine(o)}</span>
              {o.status === 'ordered' && canWrite ? (
                <>
                  <button type="button" style={link} disabled={!!busy} onClick={() => void check(o)}>{busy === 'check:' + o.id ? 'Checking…' : 'Check now'}</button>
                  <button type="button" style={{ ...link, color: 'var(--meta, #71717a)' }} disabled={!!busy} onClick={() => void cancel(o)}>{busy === 'cancel:' + o.id ? 'Canceling…' : 'Cancel order'}</button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const WORD: Record<PhotoOrderRow['status'], string> = { ordered: 'On order', completed: 'Photos in', canceled: 'Canceled', failed: 'Failed' };
const TONE: Record<PhotoOrderRow['status'], React.CSSProperties> = {
  ordered: { background: 'var(--caution-soft, #fef3c7)', color: 'var(--tx-amber, #b45309)' },
  completed: { background: 'var(--c-action-soft, #e7f5ef)', color: 'var(--tx-mint, #0a8560)' },
  canceled: { background: 'var(--surface-2, #f4f4f5)', color: 'var(--meta, #71717a)' },
  failed: { background: 'var(--negative-soft, #fee2e2)', color: 'var(--tx-red, #b91c1c)' },
};
