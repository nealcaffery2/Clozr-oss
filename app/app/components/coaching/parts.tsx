'use client';

// Small pieces the AI Sales Manager screens share: the card frame, the stage
// grid (the acquisitions call flow, hit / partial / miss), flag chips, the
// timestamped insights, and the roleplay feedback card.

import React from 'react';
import { FRAMEWORK_STAGES, REVIEW_SECTION_TITLES, type CallFlag, type CallFramework, type CoachingInsight, type ReviewSections, type StageId, type StageStatus } from '@/lib/sales-framework';
import { fmtClock } from '@/lib/call-media';
import type { RoleplayFeedback } from '@/lib/roleplay';

export const INK = 'var(--ink, #18181b)';
export const MUTED = 'var(--meta, #71717a)';
export const LINE = 'var(--divider, #e4e4e7)';
export const GREEN = '#0A8560';
export const AMBER = '#b45309';
export const RED = '#b91c1c';

export const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: 12, padding: '14px 16px' };
export const eyebrow: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: MUTED };
export const btn: React.CSSProperties = { height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', color: INK, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' };
export const primary: React.CSSProperties = { ...btn, border: 0, background: INK, color: 'var(--on-dark, #fff)', fontWeight: 600 };
export const select: React.CSSProperties = { height: 30, padding: '0 8px', borderRadius: 8, border: `1px solid ${LINE}`, background: 'var(--surface, #fff)', fontSize: 12.5, color: INK };

export const gradeColor = (n: number | null | undefined) => (n == null ? MUTED : n >= 70 ? GREEN : n >= 50 ? AMBER : RED);

const STATUS_STYLE: Record<StageStatus, { bg: string; fg: string; label: string }> = {
  hit: { bg: 'var(--c-action-soft, #e7f5ef)', fg: GREEN, label: 'Hit' },
  partial: { bg: '#fdf3e2', fg: AMBER, label: 'Partial' },
  miss: { bg: '#fdecec', fg: RED, label: 'Missed' },
  na: { bg: 'var(--surface-2, #f4f4f5)', fg: 'var(--subtle, #a1a1aa)', label: 'n/a' },
};

/** One row per call-flow stage with its status. */
export function StageGrid({ stages, compact = false }: { stages: Partial<Record<StageId, StageStatus>>; compact?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(150px, 1fr))' : 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 }}>
      {FRAMEWORK_STAGES.map((s) => {
        const st = STATUS_STYLE[stages[s.id] ?? 'na'];
        return (
          <div key={s.id} title={s.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8, background: 'var(--canvas, #fafafa)', border: `1px solid ${LINE}`, minWidth: 0 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{compact ? s.short : s.label}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: st.fg, background: st.bg, borderRadius: 6, padding: '1px 6px' }}>{st.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Stage hit rates (0-100 or null) as bars. */
export function StageRates({ rates }: { rates: Record<StageId, number | null> }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {FRAMEWORK_STAGES.map((s) => {
        const v = rates[s.id];
        return (
          <div key={s.id} title={s.hint} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 40px', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.short}</span>
            <div style={{ height: 8, background: 'var(--divider-2, #f0f0f1)', borderRadius: 4 }}>
              {v != null ? <div style={{ height: 8, width: `${Math.max(2, v)}%`, background: gradeColor(v), borderRadius: 4 }} /> : null}
            </div>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: v == null ? MUTED : INK }}>{v == null ? 'n/a' : `${v}%`}</span>
          </div>
        );
      })}
    </div>
  );
}

export function FlagChip({ flag }: { flag: Pick<CallFlag, 'label' | 'severity'> }) {
  const c = flag.severity === 'high' ? RED : flag.severity === 'medium' ? AMBER : MUTED;
  return <span style={{ fontSize: 11, fontWeight: 600, color: c, border: `1px solid ${c}33`, background: `${c}0d`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>{flag.label}</span>;
}

export function Insights({ items, onSeek }: { items: CoachingInsight[]; onSeek?: (s: number) => void }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map((i, k) => (
        <div key={k} style={{ borderLeft: `3px solid ${INK}`, paddingLeft: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
            {i.at_s != null ? (
              onSeek ? <button type="button" onClick={() => onSeek(i.at_s!)} style={{ border: 0, background: 'none', padding: 0, marginRight: 6, color: GREEN, fontWeight: 700, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(i.at_s)}</button>
                : <span style={{ marginRight: 6, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{fmtClock(i.at_s)}</span>
            ) : null}
            {i.title}
          </div>
          {i.quote ? <div style={{ fontSize: 12.5, color: MUTED, fontStyle: 'italic', marginTop: 2 }}>&ldquo;{i.quote}&rdquo;</div> : null}
          <div style={{ fontSize: 12.5, color: 'var(--ink-2, #27272a)', marginTop: 2 }}>{i.tip}</div>
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, color }: { label: string; value: React.ReactNode; hint?: string; color?: string }) {
  return (
    <div title={hint} style={{ ...card, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ ...eyebrow, fontSize: 10 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: color ?? INK, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
    </div>
  );
}

export function FrameworkSummary({ fw }: { fw: CallFramework }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ ...eyebrow }}>Call flow{fw.hit_rate != null ? ` · ${fw.hit_rate}% hit` : ''}</div>
      <StageGrid stages={fw.stages} compact />
    </div>
  );
}

const at = (s: number | null) => (s != null ? <span style={{ color: GREEN, fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginRight: 6 }}>{fmtClock(s)}</span> : null);
const quote = (q: string) => (q ? <div style={{ fontSize: 12.5, color: MUTED, fontStyle: 'italic', marginTop: 2 }}>&ldquo;{q}&rdquo;</div> : null);

/** The four named review sections: hidden objections, missed closes, areas of improvement, emotional engagement. */
export function ReviewSectionsView({ s }: { s: ReviewSections }) {
  const head = (t: string) => <div style={{ ...eyebrow, marginBottom: 6 }}>{t}</div>;
  const none = (t: string) => <div style={{ fontSize: 12.5, color: MUTED }}>{t}</div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        {head(REVIEW_SECTION_TITLES.hidden_objections)}
        {s.hidden_objections.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {s.hidden_objections.map((o, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${AMBER}`, paddingLeft: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{at(o.at_s)}{o.objection}</div>
                {quote(o.quote)}
                <div style={{ fontSize: 12.5, color: 'var(--ink-2, #27272a)', marginTop: 2 }}>{o.handle}</div>
              </div>
            ))}
          </div>
        ) : none('None missed.')}
      </div>
      <div>
        {head(REVIEW_SECTION_TITLES.missed_closes)}
        {s.missed_closes.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {s.missed_closes.map((c, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${RED}`, paddingLeft: 10 }}>
                <div style={{ fontSize: 13, color: INK }}>{at(c.at_s)}<span style={{ fontWeight: 600 }}>Close here:</span> {c.say}</div>
                {quote(c.quote)}
              </div>
            ))}
          </div>
        ) : none('The rep asked every time.')}
      </div>
      <div>
        {head(REVIEW_SECTION_TITLES.improvement)}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, fontSize: 12.5, lineHeight: 1.5 }}>
          <div><div style={{ fontWeight: 600, color: GREEN }}>Strengths</div><ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>{s.improvement.strengths.map((l) => <li key={l}>{l}</li>)}</ul></div>
          <div><div style={{ fontWeight: 600, color: RED }}>Gaps</div><ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>{s.improvement.gaps.map((l) => <li key={l}>{l}</li>)}</ul></div>
          <div><div style={{ fontWeight: 600, color: INK }}>Next steps</div><ol style={{ margin: '2px 0 0', paddingLeft: 16 }}>{s.improvement.steps.map((l) => <li key={l}>{l}</li>)}</ol></div>
        </div>
      </div>
      <div>
        {head(REVIEW_SECTION_TITLES.emotional)}
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 4 }}>
          {[s.emotional.tone && `Tone: ${s.emotional.tone}`, s.emotional.energy && `Energy: ${s.emotional.energy}`].filter(Boolean).join(' · ')}
        </div>
        {s.emotional.summary ? <div style={{ fontSize: 13, color: 'var(--ink-2, #27272a)', lineHeight: 1.5 }}>{s.emotional.summary}</div> : null}
        {s.emotional.turning_points.length ? (
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            {s.emotional.turning_points.map((t, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${t.outcome === 'won' ? GREEN : t.outcome === 'lost' ? RED : LINE}`, paddingLeft: 10, fontSize: 12.5 }}>
                <div style={{ color: INK }}>{at(t.at_s)}<span style={{ fontWeight: 600 }}>{t.outcome === 'won' ? 'Won here' : t.outcome === 'lost' ? 'Lost here' : 'Turning point'}:</span> {t.why}</div>
                {quote(t.quote)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The roleplay scorecard: score, stages, objection handling, talk ratio, three fixes, the model answer. */
export function FeedbackView({ f }: { f: RoleplayFeedback }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', color: gradeColor(f.overall) }}>{f.overall}</span>
        <span style={{ fontSize: 13, color: MUTED }}>/100 · talk {f.rep_name} {f.rep_talk}% / {f.prospect_name} {f.prospect_talk}%{f.framework?.hit_rate != null ? ` · call flow ${f.framework.hit_rate}% hit` : ''}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2, #27272a)' }}>{f.verdict}</p>
      {f.objection ? (
        <div>
          <div style={eyebrow}>Objection handling · {f.objection.score}/10</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2, #27272a)', marginTop: 3 }}>{f.objection.note}</div>
        </div>
      ) : null}
      <div>
        <div style={{ ...eyebrow, marginBottom: 4 }}>Do better next time</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>{f.fix.map((l) => <li key={l}>{l}</li>)}</ol>
      </div>
      {f.hardest_moment ? (
        <div style={{ background: 'var(--canvas, #fafafa)', border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px' }}>
          <div style={eyebrow}>Hardest moment</div>
          {f.hardest_moment.quote ? <div style={{ fontSize: 12.5, color: MUTED, fontStyle: 'italic', marginTop: 4 }}>Seller: &ldquo;{f.hardest_moment.quote}&rdquo;</div> : null}
          <div style={{ fontSize: 13.5, color: INK, fontWeight: 600, marginTop: 6 }}>{f.hardest_moment.model_answer}</div>
        </div>
      ) : null}
      {f.sections ? <ReviewSectionsView s={f.sections} /> : null}
      {f.framework ? <FrameworkSummary fw={f.framework} /> : null}
      {f.insights?.length ? <div><div style={{ ...eyebrow, marginBottom: 6 }}>Moments</div><Insights items={f.insights} /></div> : null}
      <div>
        <div style={eyebrow}>Better line than</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>&ldquo;{f.worst_line}&rdquo;</div>
        <div style={{ fontSize: 13.5, color: INK, fontWeight: 600, marginTop: 3 }}>{f.better_line}</div>
      </div>
    </div>
  );
}
