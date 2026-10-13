'use client';

/**
 * Next action, the original card: the task, who owns it, Complete, and
 * Reschedule. Reschedule is one click (tomorrow at 9). No menu.
 */

import type { ClozrView } from '@/app/clozr/view';

const label: React.CSSProperties = { fontSize: '11.5px', color: 'rgba(255,255,255,.62)', fontWeight: 600 };

export function NextActionCard({ V, compact = false }: { V: ClozrView; compact?: boolean }) {
  const ghost: React.CSSProperties = { flex: 1, height: '30px', borderRadius: '8px', border: '1px solid rgba(255,255,255,.22)', background: 'transparent', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' };
  const solid: React.CSSProperties = { ...ghost, border: 0, background: '#2d5bff' };
  return (
    <div data-testid="next-action" style={{ position: 'relative', overflow: 'hidden', borderRadius: '10px', padding: compact ? '10px' : '12px', background: '#141419', color: '#fff' }}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(120% 90% at 90% -10%, rgba(45,91,255,0.5), transparent 58%)' }} />
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={label}>Next action</div>
          <span style={{ width: '6px', height: '6px', borderRadius: '999px', background: '#2d5bff', animation: 'clozrPulse 2.4s infinite' }} />
        </div>
        <div style={{ fontSize: compact ? '13px' : '14px', fontWeight: 600, marginTop: '6px', color: V.hasNextTask ? '#fff' : 'rgba(255,255,255,.62)', lineHeight: 1.35 }}>
          {V.nextTaskLabel}
        </div>
        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,.66)', marginTop: '2px' }}>
          {V.hasNextTask && V.nextTaskDue ? (
            <span style={{ color: V.nextTaskOverdue ? '#fca5a5' : 'rgba(255,255,255,.66)', fontWeight: V.nextTaskOverdue ? 600 : 400 }}>{V.nextTaskDue} · </span>
          ) : null}
          Assigned to {V.nextTaskAssignee}
        </div>
        {V.hasNextTask && V.nextIsComprReport ? (
          <button type="button" className="dc3 rec-press" onClick={V.sendNextReport} style={{ width: '100%', height: '30px', marginTop: '10px', borderRadius: '8px', border: 0, background: '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>
            Send report
          </button>
        ) : null}
        {V.hasNextTask ? (
          <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
            <button type="button" className="dc10 rec-press" onClick={V.completeNext} style={solid}>
              Complete
            </button>
            <button type="button" className="dc2 rec-press" onClick={() => V.rescheduleNext('tomorrow')} title="Moves it to tomorrow at 9 AM" style={ghost}>
              Reschedule
            </button>
          </div>
        ) : (
          <button type="button" className="dc10 rec-press" onClick={V.scheduleNext} style={{ ...solid, width: '100%', marginTop: '10px' }}>
            + Schedule next action
          </button>
        )}
      </div>
    </div>
  );
}
