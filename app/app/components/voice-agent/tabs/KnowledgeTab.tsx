// AI Agent, Knowledge: answers the agent can rely on. Both lists go into the
// prompt as things it knows, so they are the place for facts, not for rules.
'use client';

import React from 'react';
import { Plus } from 'lucide-react';
import { LIMITS } from '@/lib/voice-agent';
import { fieldId, moveItem, removeAt, uniqueId } from '@/lib/voice-agent-console';
import { AreaField, Empty, Field, ItemControls, LINE, Section, TextField, ghost, INK, MUTED } from '../kit';
import type { TabCtx } from '../types';

export function KnowledgeTab({ form, canEdit }: TabCtx) {
  const { draft, errors, set } = form;
  const k = draft.knowledge;
  const off = !canEdit;
  const addFaq = () => set(['knowledge', 'faqs'], [...k.faqs, { id: uniqueId('faq', k.faqs.map((f) => f.id)), q: '', a: '' }]);
  const addFact = () => set(['knowledge', 'company_facts'], [...k.company_facts, '']);
  return (
    <>
      <Section id="va-faqs" title="Questions and answers" description="Sellers ask the same things. Write the answer once, in the words you want said."
        aside={canEdit && k.faqs.length < LIMITS.faqs ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={addFaq}><Plus size={14} aria-hidden="true" /> Add a question</button> : undefined}>
        {k.faqs.length === 0 ? (
          <Empty title="No questions yet">Add the answers to things like &ldquo;How fast can you close?&rdquo; or &ldquo;Do you charge fees?&rdquo;. Only promise what is company policy: the agent says it to sellers.</Empty>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {k.faqs.map((f, i) => {
              const base = `knowledge.faqs[${f.id}]`;
              return (
                <div key={f.id} id={fieldId(base)} style={{ border: '1px solid var(--inset-line)', borderRadius: 10, padding: '10px 12px', background: 'var(--inset)', boxShadow: 'var(--elev-inset)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: MUTED }}>Question {i + 1}</span>
                    {canEdit ? <ItemControls i={i} count={k.faqs.length} what={`question ${i + 1}`} onMove={(d) => set(['knowledge', 'faqs'], moveItem(k.faqs, i, d))} onRemove={() => set(['knowledge', 'faqs'], removeAt(k.faqs, i))} /> : null}
                  </div>
                  <Field label="Question" htmlFor={fieldId(`${base}.q`)} error={errors[`${base}.q`]}>
                    <TextField id={fieldId(`${base}.q`)} value={f.q} disabled={off} maxLength={LIMITS.faqQ + 20} placeholder="How fast can you close?" error={errors[`${base}.q`]} onChange={(v) => set(['knowledge', 'faqs', i, 'q'], v)} />
                  </Field>
                  <div style={{ marginTop: 10 }}>
                    <Field label="Answer" htmlFor={fieldId(`${base}.a`)} error={errors[`${base}.a`]}>
                      <AreaField id={fieldId(`${base}.a`)} value={f.a} rows={3} max={LIMITS.faqA} disabled={off} placeholder="As little as 10 days, on the date the seller picks." error={errors[`${base}.a`]} onChange={(v) => set(['knowledge', 'faqs', i, 'a'], v)} />
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED }}>A question with no answer is dropped when you save. {k.faqs.length}/{LIMITS.faqs}</p>
      </Section>

      <Section id="va-facts" title="Company facts" description="Short true statements the agent may use: where you buy, how you close, who you are."
        aside={canEdit && k.company_facts.length < LIMITS.facts ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={addFact}><Plus size={14} aria-hidden="true" /> Add a fact</button> : undefined}>
        {k.company_facts.length === 0 ? <Empty title="No facts yet">One line each, like &ldquo;We buy houses as-is, for cash.&rdquo;</Empty> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {k.company_facts.map((fact, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input id={fieldId(`knowledge.company_facts[${i}]`)} aria-label={`Company fact ${i + 1}`} className="va-field" value={fact} disabled={off} placeholder="We buy houses as-is, for cash."
                    aria-invalid={!!errors[`knowledge.company_facts[${i}]`]}
                    style={{ width: '100%', height: 36, padding: '0 11px', border: `1px solid ${errors[`knowledge.company_facts[${i}]`] ? '#f87171' : LINE}`, borderRadius: 9, fontSize: 13, outline: 0, background: 'var(--canvas, #fafafa)', color: INK, fontFamily: 'inherit', boxSizing: 'border-box' }}
                    onChange={(e) => set(['knowledge', 'company_facts', i], e.target.value)} />
                  {errors[`knowledge.company_facts[${i}]`] ? <p role="alert" style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tx-red, #b91c1c)' }}>{errors[`knowledge.company_facts[${i}]`]}</p> : null}
                </div>
                {canEdit ? <ItemControls i={i} count={k.company_facts.length} what={`fact ${i + 1}`} onMove={(d) => set(['knowledge', 'company_facts'], moveItem(k.company_facts, i, d))} onRemove={() => set(['knowledge', 'company_facts'], removeAt(k.company_facts, i))} /> : null}
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
