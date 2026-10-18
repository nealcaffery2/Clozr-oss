'use client';

/**
 * "From this call": who the caller is and what they buy, filled from the live
 * transcript while the call runs and at wrap-up.
 *
 * Shown on the Dialer when the number has no CLOZR record, or is a buyer whose
 * buy box has gaps. The rep can change the suggested kind; the primary action
 * opens the existing form for that kind filled with everything heard (the
 * buyer profile on a signed-in workspace, Quick Add otherwise) and nothing is
 * saved until the rep saves it there. Each field carries the words it came
 * from as its tooltip.
 *
 * Self-contained: it reads V and its own hook (useCallProfile), so it drops
 * into any column of either dialer layout. Styles: `.call-profile` in
 * clozr/talkr-dialer.css.
 */

import { useId } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { BUY_BOX_FIELDS, PICKABLE_KINDS, profileRows } from '@/lib/call-profile';
import { Card } from './ui';
import { Icon } from './Icon';
import { useCallProfile } from './useCallProfile';

export function CallProfileCard({ V }: { V: ClozrView }) {
  const c = V.callProfile;
  const st = useCallProfile(V);
  const kindLabelId = useId();
  const gapsMode = c.recordKind === 'buyer';
  if (!c.key) return null;
  // A seller on record has seller intelligence; a complete buyer needs nothing.
  if (c.recordKind != null && !(gapsMode && c.buyerGaps.length > 0)) return null;

  const rows = profileRows(st.profile).filter((r) => !gapsMode || BUY_BOX_FIELDS.includes(r.field));
  const kind = st.kind === 'unknown' ? null : st.kind;
  const action = PICKABLE_KINDS.find((k) => k.kind === kind);
  const suggested = st.profile.kind !== 'unknown' ? PICKABLE_KINDS.find((k) => k.kind === st.profile.kind)?.label : null;
  const wrap = V.callState === 'wrap';
  const statusLabel = st.status === 'off' ? 'Off'
    : st.busy ? 'Reading the call…'
      : wrap ? (rows.length ? 'From the whole call' : '')
        : 'Listening…';

  return (
    <Card className="call-profile flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 style={{ font: '650 13.5px/1.3 var(--sans)', margin: 0 }}>From this call</h2>
          <p style={{ font: '400 12px/1.45 var(--sans)', color: 'var(--muted)', margin: 0 }}>
            {gapsMode
              ? `${c.buyerName ?? 'This buyer'}’s buy box is missing ${c.buyerGaps.join(', ').toLowerCase()}. What they say about it shows here.`
              : 'This number has no CLOZR record. What the caller says about themselves fills a profile here.'}
          </p>
        </div>
        {statusLabel && (
          <span role="status" className="shrink-0" style={{ font: '600 11.5px/1.3 var(--sans)', color: st.busy || (!wrap && st.status !== 'off') ? '#0A8560' : 'var(--muted)' }}>
            {statusLabel}
          </span>
        )}
      </div>

      {st.status === 'off' ? (
        <div className="flex flex-col items-start gap-2">
          <p style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--text)', margin: 0 }}>
            AI transcription is off for this call, so nothing is read from it.
          </p>
          <button type="button" className="cp-btn cp-ghost" onClick={V.toggleAiRec}>Turn on AI transcription</button>
        </div>
      ) : (
        <>
          {!gapsMode && (
            <div className="flex flex-col gap-1.5">
              <span id={kindLabelId} style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>
                What they are{suggested ? ` (the call suggests ${suggested.toLowerCase()})` : ''}
              </span>
              <div role="group" aria-labelledby={kindLabelId} className="flex flex-wrap gap-1.5">
                {PICKABLE_KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    className="cp-chip"
                    aria-pressed={kind === k.kind}
                    onClick={() => st.pickKind(k.kind)}
                  >
                    {kind === k.kind && <Icon name="check" size={12} />}
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {rows.length > 0 ? (
            <dl className="flex flex-col" style={{ margin: 0 }}>
              {rows.map((r) => (
                <div
                  key={r.field}
                  className="grid gap-2 py-1.5"
                  style={{ gridTemplateColumns: '96px 1fr', borderBottom: '1px solid var(--line-soft)' }}
                  title={r.quote ? `Said on the call: “${r.quote}”` : undefined}
                >
                  <dt style={{ font: '500 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>{r.label}</dt>
                  <dd style={{ font: '600 12.5px/1.4 var(--sans)', margin: 0, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{r.value}</dd>
                </div>
              ))}
              {c.phone && !gapsMode && (
                <div className="grid gap-2 py-1.5" style={{ gridTemplateColumns: '96px 1fr', borderBottom: '1px solid var(--line-soft)' }} title="The number on this call">
                  <dt style={{ font: '500 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>Phone</dt>
                  <dd style={{ font: '600 12.5px/1.4 var(--sans)', margin: 0, fontVariantNumeric: 'tabular-nums' }}>{c.phoneLabel}</dd>
                </div>
              )}
            </dl>
          ) : (
            st.status !== 'error' && (
              <p style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--muted)', margin: 0 }}>
                Nothing to fill yet. Details show here as they come up on the call.
              </p>
            )
          )}

          {st.profile.notes && (
            <p style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--text)', margin: 0 }}>{st.profile.notes}</p>
          )}

          {st.error && (
            <div role="alert" className="flex flex-wrap items-center gap-2">
              <span style={{ font: '500 12px/1.45 var(--sans)', color: 'var(--red)' }}>Could not read the call: {st.error}</span>
              <button type="button" className="cp-btn cp-ghost" onClick={st.retry} disabled={st.busy}>{st.busy ? 'Trying again…' : 'Try again'}</button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {gapsMode ? (
              c.canEditBuyBox ? (
                <button type="button" className="cp-btn cp-primary" disabled={rows.length === 0} onClick={() => V.addCallProfileToBuyBox(st.profile)}>
                  Add to buy box
                </button>
              ) : (
                <span style={{ font: '400 12px/1.45 var(--sans)', color: 'var(--muted)' }}>Buy box editing runs on a signed-in workspace.</span>
              )
            ) : (
              <button
                type="button"
                className="cp-btn cp-primary"
                disabled={!action || rows.length === 0}
                title={!action ? 'Pick what they are first' : rows.length === 0 ? 'Nothing to fill yet' : undefined}
                onClick={() => action && V.createFromCallProfile(action.kind, st.profile)}
              >
                {action?.action ?? 'Create profile'}
              </button>
            )}
            {rows.length > 0 && (
              <span style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>
                Opens the form to check before saving. Hover a field to see what was said.
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
