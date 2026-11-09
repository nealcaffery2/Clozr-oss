'use client';

/**
 * Beside the script while a call runs: the live transcript (both legs,
 * lib/live-transcript.ts through V.transcript) and the "Say next" card.
 *
 * Say next is a prompt for the rep, never spoken: the seller's last finished
 * turn is matched against the rebuttals' keywords (lib/script-doc.ts
 * matchObjection) and the matching rebuttal's first line shows with Mark
 * handled and Open rebuttal. No model call: a keyword hit is instant, free,
 * and wrong in a way the rep can see. The transcript's own suggested
 * response (Talkr's seller intelligence) stays where it was, under the call.
 */

import { useEffect, useRef, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { firstLine, matchObjection } from '@/lib/script-doc';
import { Merged, type PanelScript } from './ScriptPanel';
import { Icon } from './Icon';

export function LiveCoach({ V, rebuttals, values, onOpenRebuttal }: {
  V: ClozrView;
  rebuttals: PanelScript[];
  values: Record<string, string>;
  onOpenRebuttal: (id: string) => void;
}) {
  const listening = V.listeningLabel.startsWith('●') && V.listeningLabel !== '● connecting';
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => { tail.current?.scrollTo({ top: tail.current.scrollHeight }); }, [V.transcript.length]);

  // The last thing the other party finished saying, and where it sits in the
  // call, so Mark handled clears exactly that turn and the next one can match.
  const lines = V.callProfile.lines;
  const lastSeller = lastSellerTurn(lines);
  const [handled, setHandled] = useState<number>(-1);
  useEffect(() => { setHandled(-1); }, [V.callProfile.key]);
  const match = lastSeller && lastSeller.i > handled ? matchObjection(lastSeller.text, rebuttals) : null;

  return (
    <section className="lc" aria-label="Live coaching">
      <div className="lc-card lc-next" role="status" aria-live="polite">
        <div className="lc-head">
          <h2 className="lc-title">Say next</h2>
          <span className="lc-state">{match ? match.category ?? 'Objection' : listening ? 'Listening' : V.listeningLabel.replace(/^●\s*/, '')}</span>
        </div>
        {match ? (
          <>
            <p className="lc-quote">“{lastSeller!.text}”</p>
            <p className="lc-line"><Merged text={firstLine(match.body)} values={values} /></p>
            <div className="lc-actions">
              <button type="button" className="lc-btn lc-primary" onClick={() => setHandled(lastSeller!.i)}><Icon name="check" size={12} />Mark handled</button>
              <button type="button" className="lc-btn" onClick={() => onOpenRebuttal(match!.id)}>Open rebuttal</button>
            </div>
          </>
        ) : (
          <p className="lc-hint">{rebuttals.length === 0 ? 'No rebuttals on this workspace yet. Import the Acme Homes playbook under Settings, Talkr, Scripts.' : 'When the other side raises an objection, the line to say shows here.'}</p>
        )}
      </div>

      <div className="lc-card lc-transcript">
        <div className="lc-head">
          <h2 className="lc-title">Live transcript</h2>
          <span className="lc-state" style={{ color: listening ? 'var(--green)' : undefined }}>{V.listeningLabel}</span>
        </div>
        <div ref={tail} className="lc-lines">
          {V.transcript.length === 0 && <p className="lc-hint">The conversation appears here as it happens.</p>}
          {V.transcript.map((l, i) => (
            <p key={i} className="lc-turn" data-rep={l.color === 'var(--meta, #71717a)' ? '' : undefined}>
              <span className="lc-who">{l.who}</span>
              {l.text}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

function lastSellerTurn(lines: ReadonlyArray<{ rep: boolean; text: string }>): { i: number; text: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i]!.rep) return { i, text: lines[i]!.text };
  return null;
}
