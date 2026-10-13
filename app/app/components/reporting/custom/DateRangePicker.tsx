'use client';

// The report's date range: a preset, or custom from/to dates, plus how it
// compares (previous period of equal length, the year before, or nothing).

import React, { useState } from 'react';
import { DATE_PRESETS, type Comparison, presetRange, rangeLabel } from '@/lib/report-engine';
import { btn, field, popover } from './ui';

export type DateChoice = { preset: string; custom: { from: string; to: string } | null; comparison: Comparison };

const COMPARE: { v: Comparison; label: string }[] = [{ v: 'none', label: 'No comparison' }, { v: 'previous', label: 'Previous period' }, { v: 'year', label: 'Year before' }];

export function compareLabelOf(choice: { preset: string; comparison: Comparison; custom?: { from: string; to: string } | null }): string {
  if (choice.comparison === 'none') return '';
  if (choice.comparison === 'year') return 'year before';
  const r = presetRange(choice.preset, choice.custom ?? null);
  if (!Number.isFinite(r.start)) return 'prior';
  const days = Math.max(1, Math.round((r.end - r.start) / 86_400_000));
  return days === 1 ? 'previous day' : `previous ${days} days`;
}

export function DateRangePicker({ value, onChange, allowReport, align = 'left' }: { value: DateChoice; onChange: (v: DateChoice) => void; /** Adds "Report date range" for a widget's own override. */ allowReport?: boolean; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateChoice>(value);
  const summary = allowReport && !value.preset ? 'Report date range' : value.preset === 'Custom' && value.custom ? rangeLabel(presetRange('Custom', value.custom)) : value.preset || 'Report date range';
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" onClick={() => { setDraft(value); setOpen(!open); }} style={{ ...btn.ghost, display: 'inline-flex', alignItems: 'center', gap: '7px', fontWeight: 600 }} aria-haspopup="dialog" aria-expanded={open}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
        {summary}
        {value.comparison !== 'none' && value.preset ? <span style={{ color: '#71717a', fontWeight: 500 }}>· vs {compareLabelOf(value)}</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Date range" style={{ ...popover, [align]: 0, width: '320px' }}>
          <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, marginBottom: '6px' }}>Select date range</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', maxHeight: '190px', overflow: 'auto' }}>
            {allowReport ? <button type="button" onClick={() => setDraft({ ...draft, preset: '', custom: null })} style={{ ...btn.chip(!draft.preset), gridColumn: '1 / -1' }}>Report date range</button> : null}
            {DATE_PRESETS.map((p) => (
              <button key={p} type="button" onClick={() => setDraft({ ...draft, preset: p, custom: p === 'Custom' ? draft.custom ?? { from: iso(new Date(Date.now() - 29 * 86_400_000)), to: iso(new Date()) } : null })} style={btn.chip(draft.preset === p)}>{p}</button>
            ))}
          </div>
          {draft.preset === 'Custom' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
              <label style={{ fontSize: '11px', color: '#71717a' }}>From<input type="date" value={draft.custom?.from ?? ''} onChange={(e) => setDraft({ ...draft, custom: { from: e.target.value, to: draft.custom?.to ?? '' } })} style={{ ...field, marginTop: '3px' }} /></label>
              <label style={{ fontSize: '11px', color: '#71717a' }}>To<input type="date" value={draft.custom?.to ?? ''} onChange={(e) => setDraft({ ...draft, custom: { from: draft.custom?.from ?? '', to: e.target.value } })} style={{ ...field, marginTop: '3px' }} /></label>
            </div>
          ) : null}
          <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, margin: '12px 0 6px' }}>Comparison</div>
          <select value={draft.comparison} onChange={(e) => setDraft({ ...draft, comparison: e.target.value as Comparison })} style={field}>
            {COMPARE.map((c) => <option key={c.v} value={c.v}>{c.label}{c.v === 'previous' && draft.preset ? ` (${compareLabelOf({ ...draft, comparison: 'previous' })})` : ''}</option>)}
          </select>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '12px' }}>
            <button type="button" onClick={() => setOpen(false)} style={btn.ghost}>Cancel</button>
            <button type="button" onClick={() => { onChange(draft); setOpen(false); }} style={btn.primary}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
