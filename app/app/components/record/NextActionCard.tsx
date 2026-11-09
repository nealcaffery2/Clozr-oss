'use client';

/**
 * Next action: the task, who owns it, Mark complete, and Reschedule.
 * Reschedule is one click (tomorrow at 9). No menu. Tinted red when late.
 */

import type { ClozrView } from '@/app/clozr/view';
import { eyebrow as label } from './ui';

export function NextActionCard({ V, compact = false }: { V: ClozrView; compact?: boolean }) {
  // A light card, tinted red only when the task is late: the reference's
  // "Get access · Overdue · Mark complete". It used to be a dark card with a
  // blue glow and a pulsing dot, a second accent on a green app.
  const late = V.hasNextTask && V.nextTaskOverdue;
  const ghost: React.CSSProperties = { flex: 1, height: '30px', borderRadius: '8px', border: 0, background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-ring)' };
  const solid: React.CSSProperties = { ...ghost, background: 'var(--ink, #18181b)', color: 'var(--surface, #fff)', boxShadow: 'none' };
  return (
    <div data-testid="next-action" style={{ borderRadius: '10px', padding: compact ? '10px 12px' : '12px', background: late ? 'var(--tint-red, #fef2f2)' : 'var(--canvas, #fafafa)', border: `1px solid ${late ? 'var(--tint-red-2, #fecaca)' : 'var(--divider, #e4e4e7)'}`, color: 'var(--ink, #18181b)' }}>
      <div style={label}>Next action</div>
      <div style={{ fontSize: compact ? '13.5px' : '14px', fontWeight: 650, marginTop: '4px', color: V.hasNextTask ? 'var(--ink, #18181b)' : 'var(--meta, #71717a)', lineHeight: 1.35 }}>
        {V.nextTaskLabel}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--meta, #71717a)', marginTop: '2px' }}>
        {V.hasNextTask && V.nextTaskDue ? (
          <span style={{ color: late ? 'var(--tx-red, #b91c1c)' : 'var(--meta, #71717a)', fontWeight: late ? 600 : 400 }}>{late && !/overdue/i.test(V.nextTaskDue) ? 'Overdue · ' : ''}{V.nextTaskDue} · </span>
        ) : null}
        Assigned to {V.nextTaskAssignee}
      </div>
      {V.hasNextTask && V.nextIsComprReport ? (
        <button type="button" className="dc3 rec-press rec-primary" onClick={V.sendNextReport} style={{ width: '100%', height: '30px', marginTop: '10px', borderRadius: '8px', border: 0, background: '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>
          Send report
        </button>
      ) : null}
      {V.hasNextTask ? (
        <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
          <button type="button" className="rec-press rec-ink" onClick={V.completeNext} style={{ ...solid, minWidth: '120px', whiteSpace: 'nowrap' }}>
            Mark complete
          </button>
          <button type="button" className="rec-press rec-ghost" onClick={() => V.rescheduleNext('tomorrow')} title="Moves it to tomorrow at 9 AM" style={{ ...ghost, minWidth: '100px', whiteSpace: 'nowrap' }}>
            Reschedule
          </button>
          <button type="button" className="rec-press rec-ghost" onClick={V.editNextTask} title="Change the title, type, due time, owner or note; or delete it" style={{ ...ghost, whiteSpace: 'nowrap' }}>
            Edit
          </button>
        </div>
      ) : (
        <button type="button" className="rec-press rec-ghost" onClick={V.scheduleNext} style={{ ...ghost, width: '100%', marginTop: '10px' }}>
          Schedule next action
        </button>
      )}
    </div>
  );
}
