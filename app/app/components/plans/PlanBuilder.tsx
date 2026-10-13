// The action-plan builder, whole: list on the left, editor and AI box on the
// right. Self-contained — it owns its own data through usePlans and takes
// only the little it needs from the shell (mobile layout, navigation).
'use client';

import React from 'react';
import { usePlans } from './usePlans';
import { PlansList } from './PlansList';
import { PlanEditor } from './PlanEditor';
import { AiPanel } from './AiPanel';
import { Btn, FAINT, INK, LINE, MUTED, PlayPause, Toast } from './ui';

export function PlanBuilder({
  isMobile, headerLeft, headerRight, onOpenPerson, notify, onChanged,
}: {
  isMobile: boolean;
  /** Rendered in the header before the title (e.g. a Back button). */
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  onOpenPerson?: (sellerId: number) => void;
  /** The shell's toast, when it is exposed; otherwise the builder shows its own. */
  notify?: (msg: string) => void;
  /** Called after any write, so the shell can re-read the workspace. */
  onChanged?: () => void;
}) {
  const api = usePlans({ notify, onSaved: onChanged });
  const d = api.draft;

  return (
    <section data-screen-label="Action plans" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div data-head style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', background: '#fff', borderBottom: `1px solid ${LINE}`, flex: 'none', flexWrap: 'wrap' }}>
        {headerLeft}
        <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Action plans</h1>
        {!isMobile ? <span style={{ fontSize: '12.5px', color: MUTED }}>follow-up sequences for sellers, buyers, TC, and sources</span> : null}
        <div style={{ flex: 1 }} />
        {headerRight}
        {d?.id ? (
          <PlayPause playing={d.active} disabled={!api.canWrite && !api.preview} onClick={() => void api.toggleActive(d.id!, !d.active)} />
        ) : null}
        {d ? (
          <>
            {api.dirty ? <span style={{ fontSize: '11.5px', color: '#b45309', fontWeight: 600 }}>Unsaved changes</span> : null}
            <Btn onClick={api.cancel} disabled={!api.dirty}>Cancel</Btn>
            <Btn kind="primary" onClick={() => void api.save()} disabled={api.saving || !api.dirty || !api.canWrite} title={api.canWrite ? '' : 'Sign in to a workspace to save'}>
              {api.saving ? 'Saving…' : d.id ? 'Save plan' : 'Create plan'}
            </Btn>
          </>
        ) : null}
        <Btn kind="dark" onClick={api.newPlan}>+ New plan</Btn>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: isMobile ? 'block' : 'grid', overflow: isMobile ? 'auto' : 'visible', gridTemplateColumns: isMobile ? '1fr' : '300px minmax(0,1fr)' }}>
        <aside style={{ borderRight: isMobile ? 0 : `1px solid ${LINE}`, borderBottom: isMobile ? `1px solid ${LINE}` : 0, background: '#fff', overflow: 'auto', maxHeight: isMobile ? '34vh' : 'none' }}>
          <PlansList
            plans={api.plans} loading={api.loading} error={api.loadError} currentId={d?.id ?? null} isNew={!!d && d.id === null}
            onSelect={api.select} onNew={api.newPlan} onDuplicate={(id) => void api.duplicate(id)} onDelete={(id) => void api.remove(id)}
            onToggle={(id, on) => void api.toggleActive(id, on)} onRetry={() => void api.refreshList()}
          />
        </aside>
        <div style={{ overflow: 'auto', padding: '16px 20px 40px', background: '#fafafa' }}>
          <AiPanel
            hasPlan={!!d} busy={api.aiBusy} review={api.aiReview} tone={d?.settings.tone ?? ''}
            onGenerate={(g, t, n) => void api.aiGenerate(g, t, n)} onEdit={(i, t) => void api.aiEdit(i, t)}
            onUndo={api.aiUndo} onDismiss={api.dismissReview}
          />
          <div style={{ height: '14px' }} />
          {d ? (
            <PlanEditor api={api} draft={d} isMobile={isMobile} onOpenPerson={onOpenPerson} />
          ) : (
            <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', padding: '28px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: INK }}>{api.plans.length ? 'Pick a plan on the left, or start a new one' : 'Your first action plan'}</div>
              <div style={{ fontSize: '12.5px', color: MUTED, marginTop: '6px', lineHeight: 1.55, maxWidth: '460px', margin: '6px auto 0' }}>
                A plan is a sequence of texts, calls, emails and tasks with a wait between each. Enrol a seller and every step is queued as dated work for whoever owns the lead; a reply stops it so a person takes over.
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '14px' }}>
                <Btn kind="dark" onClick={api.newPlan}>+ New plan</Btn>
              </div>
              <div style={{ fontSize: '11.5px', color: FAINT, marginTop: '10px' }}>or describe one in the box above</div>
            </div>
          )}
        </div>
      </div>
      <Toast msg={api.toastMsg} />
    </section>
  );
}
