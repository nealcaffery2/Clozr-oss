'use client';

// Label chips on a thread row and in the thread header: what CLOZR already
// knows (the stage, the heat word from lib/heat.ts) plus the disposition
// labels a rep puts on (lib/inbox-folders DISPOSITIONS, kept in inbox state).
// Every colour carries its word. One dropdown changes the dispositions; a
// ghost chip offers the label the last text suggests, accepted in one click.

import React from 'react';
import { ChevronDown, Plus, Sparkles } from 'lucide-react';
import { type Disposition, DISPOSITIONS, DISPOSITION_TONE, isDisposition } from '@/lib/inbox-folders';
import { NO_HEAT, heat, tempText } from '@/lib/heat';
import { Menu } from './Menu';

export type HeatChip = { label: string; fg: string; bg: string } | null;

/** The heat word and tint for a record's score, else Talkr's temperature word. */
export function heatChip(score: number | null | undefined, temperature: string | null | undefined): HeatChip {
  if (score != null) { const h = heat(score); return { label: h.label, fg: h.text, bg: h.tint }; }
  if (!temperature) return null;
  const t = temperature.toUpperCase();
  const word = t === 'HOT' ? 'Hot' : t === 'WARM' ? 'Warm' : t === 'COLD' ? 'Cold' : null;
  if (!word) return null;
  const fg = tempText(t);
  const bg = word === 'Hot' ? heat(85).tint : word === 'Warm' ? heat(70).tint : heat(0).tint;
  return { label: word, fg: fg === NO_HEAT.text ? NO_HEAT.text : fg, bg };
}

export function Chip({ label, fg, bg, ghost, title }: { label: string; fg?: string; bg?: string; ghost?: boolean; title?: string }) {
  return <span className="ax-tag" data-ghost={ghost || undefined} style={fg ? { color: fg, background: bg } : undefined} title={title}>{label}</span>;
}

/**
 * The chips for one thread. `compact` keeps the row to one line of chips:
 * the first few, then “+2”.
 */
export function LabelChips({ stage, heat: h, labels, suggestion, onLabels, compact = false, canEdit = true }: {
  stage: string | null | undefined;
  heat: HeatChip;
  labels: string[];
  /** The ghost chip from the last text, when no disposition is set yet. */
  suggestion: Disposition | null;
  onLabels: (labels: string[]) => void;
  compact?: boolean;
  canEdit?: boolean;
}) {
  const dispositions = labels.filter(isDisposition);
  const toggle = (d: Disposition) => onLabels(dispositions.includes(d) ? dispositions.filter((x) => x !== d) : [...dispositions, d]);
  const items = DISPOSITIONS.map((d) => ({ label: d, on: dispositions.includes(d), swatch: DISPOSITION_TONE[d].fg, run: () => toggle(d) }));
  const max = compact ? 2 : 99;
  const shown = dispositions.slice(0, max);
  const more = dispositions.length - shown.length;
  return (
    <span className="ax-tags" onClick={(e) => e.stopPropagation()}>
      {stage ? <Chip label={stage} title="Stage" /> : null}
      {h ? <Chip label={h.label} fg={h.fg} bg={h.bg} title="Heat" /> : null}
      {shown.map((d) => <Chip key={d} label={d} fg={DISPOSITION_TONE[d].fg} bg={DISPOSITION_TONE[d].bg} />)}
      {more > 0 ? <Chip label={`+${more}`} title={dispositions.slice(max).join(', ')} /> : null}
      {canEdit && suggestion && !dispositions.length ? (
        <button type="button" className="ax-tag ax-tag-suggest" title={`Suggested from their last text. Click to add “${suggestion}”.`} onClick={() => onLabels([suggestion])}>
          <Sparkles size={11} strokeWidth={2.25} aria-hidden />{suggestion}
        </button>
      ) : null}
      {canEdit ? (
        <Menu chip label={dispositions.length ? <ChevronDown size={12} strokeWidth={2.5} aria-hidden /> : <><Plus size={11} strokeWidth={2.5} aria-hidden />Label</>}
          title={dispositions.length ? 'Change labels' : 'Add a label'} heading="Labels" items={items} />
      ) : null}
    </span>
  );
}
