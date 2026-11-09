'use client';

/**
 * The script the rep reads, as a reading surface: sections down the page,
 * the current one lit, j/k or the arrow keys to move, a button per branch
 * ("If yes" / "If no"), and the objection chips across the top that swap in
 * the rebuttal and back. Merge fields fill from the record on the line; a
 * field the record lacks is a blank chip the rep says a word for.
 *
 * The panel owns no fetching: the dialer hands it the scripts and rebuttals
 * (the workspace's table, or the Acme Homes playbook where there is none) and
 * the merge map (lib/script-doc.ts mergeFieldsFor). Styles: `.sp-*` in
 * clozr/talkr-dialer.css.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { OBJECTION_CHIPS, mergeRuns, parseScriptDoc, type ScriptLine } from '@/lib/script-doc';
import { Icon } from './Icon';

export type PanelScript = { id: string; title: string; category: string | null; tags: string[]; body: string };

export function ScriptPanel({
  scripts,
  rebuttals,
  values,
  openRebuttalId,
  onRebuttalShown,
  onUsed,
  footer,
  defaultId,
  onDefault,
}: {
  scripts: PanelScript[];
  rebuttals: PanelScript[];
  values: Record<string, string>;
  /** The coach asked for this rebuttal (Say next → Open). Cleared through onRebuttalShown. */
  openRebuttalId?: string | null;
  onRebuttalShown?: () => void;
  /** Talkr's "used" tally, when the workspace has one. */
  onUsed?: (id: string) => void;
  footer?: ReactNode;
  /** The rep's default script (the dialer opens on it), and how to change it. */
  defaultId?: string | null;
  onDefault?: (id: string) => void;
}) {
  const [scriptId, setScriptId] = useState<string | null>(null);
  const script = scripts.find((s) => s.id === scriptId) ?? scripts[0] ?? null;
  const doc = useMemo(() => (script ? parseScriptDoc(script.title, script.body) : null), [script]);
  const [cur, setCur] = useState(0);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [rebuttalId, setRebuttalId] = useState<string | null>(null);
  const rebuttal = rebuttals.find((r) => r.id === rebuttalId) ?? null;
  const list = useRef<HTMLDivElement>(null);

  // A new script starts at the top with no branches picked.
  useEffect(() => { setCur(0); setPicked({}); }, [script?.id]);
  useEffect(() => {
    if (openRebuttalId) { setRebuttalId(openRebuttalId); onRebuttalShown?.(); }
  }, [openRebuttalId, onRebuttalShown]);

  const n = doc?.sections.length ?? 0;
  const move = (d: number) => setCur((c) => Math.min(Math.max(c + d, 0), Math.max(n - 1, 0)));

  // j / k and the arrows move the lit section, from anywhere on the page that
  // is not a text field: a rep mid-call has one hand on the mouse at best.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Escape' && rebuttalId) { e.preventDefault(); setRebuttalId(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-section="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const byCategory = (cat: string) => rebuttals.filter((r) => r.category === cat);
  const chips = OBJECTION_CHIPS.filter((c) => byCategory(c).length > 0);
  const more = [...new Set(rebuttals.map((r) => r.category).filter((c): c is string => !!c && !(OBJECTION_CHIPS as readonly string[]).includes(c)))];

  return (
    <section className="sp" aria-label="Script">
      {/* ── Objections across the top ─────────────────────────────────── */}
      {rebuttals.length > 0 && (
        <div className="sp-chips" role="group" aria-label="Objections">
          {chips.map((c) => {
            const rs = byCategory(c);
            const on = !!rebuttal && rebuttal.category === c;
            return (
              <button key={c} type="button" className="sp-chip" aria-pressed={on} onClick={() => setRebuttalId(on ? null : rs[0]!.id)}>
                {c}
              </button>
            );
          })}
          {more.length > 0 && (
            <select
              className="sp-chip sp-more"
              aria-label="More objections"
              value={rebuttal && more.includes(rebuttal.category ?? '') ? rebuttal.id : ''}
              onChange={(e) => setRebuttalId(e.target.value || null)}
            >
              <option value="">More</option>
              {more.map((c) => (
                <optgroup key={c} label={c}>
                  {byCategory(c).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </div>
      )}

      {rebuttal ? (
        <RebuttalView
          rebuttal={rebuttal}
          siblings={byCategory(rebuttal.category ?? '')}
          values={values}
          onPick={setRebuttalId}
          onBack={() => setRebuttalId(null)}
          onUsed={onUsed}
        />
      ) : !doc ? (
        <p className="sp-empty">No script for this call yet. Managers add them under Settings, Talkr, Scripts, or import the Acme Homes playbook there.</p>
      ) : (
        <>
          <header className="sp-head">
            {scripts.length > 1 ? (
              <select className="sp-select" aria-label="Script" value={script!.id} onChange={(e) => setScriptId(e.target.value)}>
                {scripts.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            ) : (
              <h2 className="sp-title">{doc.title}</h2>
            )}
            {onDefault && script && scripts.length > 1 && (
              script.id === defaultId
                ? <span className="sp-count">Your default</span>
                : <button type="button" className="sp-ghost" onClick={() => onDefault(script.id)} title="Open the dialer on this script every time">Make default</button>
            )}
            <span className="sp-nav" aria-live="polite">
              <button type="button" className="sp-navbtn" aria-label="Previous section (k)" onClick={() => move(-1)} disabled={cur === 0}><ChevronLeft size={14} aria-hidden /></button>
              <span className="sp-count">{Math.min(cur + 1, n)} of {n}</span>
              <button type="button" className="sp-navbtn" aria-label="Next section (j)" onClick={() => move(1)} disabled={cur >= n - 1}><ChevronRight size={14} aria-hidden /></button>
            </span>
          </header>
          <div className="sp-list" ref={list}>
            {doc.sections.map((s, i) => (
              <article key={i} className="sp-section" data-section={i} aria-current={i === cur ? 'step' : undefined}>
                {s.title && (
                  <button type="button" className="sp-section-title" onClick={() => setCur(i)}>
                    {s.title}
                  </button>
                )}
                {blocksOf(s.lines).map((b, j) =>
                  b.kind === 'note' ? <p key={j} className="sp-note"><Merged text={b.text} values={values} /></p>
                    : b.kind === 'say' ? <p key={j} className="sp-say"><Merged text={b.text} values={values} /></p>
                      : <Branch key={j} options={b.options} values={values} lit={i === cur} chosen={picked[`${i}:${j}`] ?? null} onPick={(v) => setPicked((p) => ({ ...p, [`${i}:${j}`]: v }))} />,
                )}
              </article>
            ))}
          </div>
          {(onUsed || footer) && (
            <footer className="sp-foot">
              {footer}
              {onUsed && script && <button type="button" className="sp-ghost" onClick={() => onUsed(script.id)}>Mark used</button>}
            </footer>
          )}
        </>
      )}
    </section>
  );
}

type Block = Extract<ScriptLine, { kind: 'say' | 'note' }> | { kind: 'branch'; options: Array<{ label: string; text: string }> };

/** Consecutive branch lines are one choice the rep makes with one row of buttons. */
function blocksOf(lines: ScriptLine[]): Block[] {
  const out: Block[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (l.kind === 'branch') {
      if (last?.kind === 'branch') last.options.push({ label: l.label, text: l.text });
      else out.push({ kind: 'branch', options: [{ label: l.label, text: l.text }] });
    } else out.push(l);
  }
  return out;
}

function Branch({ options, values, lit, chosen, onPick }: {
  options: Array<{ label: string; text: string }>; values: Record<string, string>; lit: boolean; chosen: number | null; onPick: (i: number) => void;
}) {
  return (
    <div className="sp-branch" role="group" aria-label="Branch">
      <div className="sp-branch-btns">
        {options.map((o, i) => (
          <button key={i} type="button" className="sp-chip" aria-pressed={chosen === i} onClick={() => onPick(i)} data-lit={lit || chosen != null ? '' : undefined}>
            If {o.label}
          </button>
        ))}
      </div>
      {chosen != null && <p className="sp-say sp-say-branch"><Merged text={options[chosen]!.text} values={values} /></p>}
    </div>
  );
}

function RebuttalView({ rebuttal, siblings, values, onPick, onBack, onUsed }: {
  rebuttal: PanelScript; siblings: PanelScript[]; values: Record<string, string>;
  onPick: (id: string) => void; onBack: () => void; onUsed?: (id: string) => void;
}) {
  const doc = useMemo(() => parseScriptDoc(rebuttal.title, rebuttal.body), [rebuttal]);
  return (
    <div className="sp-rebuttal">
      <header className="sp-head">
        <button type="button" className="sp-back" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
          Back to script
          <kbd className="sp-kbd">Esc</kbd>
        </button>
        {siblings.length > 1 && (
          <select className="sp-select" aria-label="Rebuttal" value={rebuttal.id} onChange={(e) => onPick(e.target.value)}>
            {siblings.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        )}
      </header>
      <h2 className="sp-title">{rebuttal.title}</h2>
      <div className="sp-list">
        <article className="sp-section" aria-current="step">
          {doc.sections.flatMap((s) => s.lines).map((l, j) =>
            l.kind === 'note' ? <p key={j} className="sp-note"><Merged text={l.text} values={values} /></p>
              : <p key={j} className="sp-say">{l.kind === 'branch' && <span className="sp-if">If {l.label}: </span>}<Merged text={l.text} values={values} /></p>,
          )}
        </article>
      </div>
      {onUsed && (
        <footer className="sp-foot">
          <button type="button" className="sp-ghost" onClick={() => onUsed(rebuttal.id)}><Icon name="check" size={12} />Used this</button>
        </footer>
      )}
    </div>
  );
}

/** A spoken line with its merge fields filled, or blank where the record has nothing. */
export function Merged({ text, values }: { text: string; values: Record<string, string> }) {
  return (
    <>
      {mergeRuns(text, values).map((r, i) =>
        r.kind === 'text' ? <span key={i}>{r.text}</span>
          : r.kind === 'value' ? <mark key={i} className="sp-value" title={r.field}>{r.text}</mark>
            : <span key={i} className="sp-blank" title={`No ${r.text} on the record. Say one.`}>{r.text}</span>,
      )}
    </>
  );
}
