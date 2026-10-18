// AI Agent, Offer authority: whether the agent may say a number, and inside
// what range. The ceiling is the seller's latest deal MAO; the floor is the
// percentage set here. With no MAO on file the agent has no range and quotes
// nothing, whatever this says.
'use client';

import React, { useState } from 'react';
import type { OfferMode } from '@/lib/voice-agent';
import { fieldId } from '@/lib/voice-agent-console';
import { Banner, ChoiceCards, INK, MUTED, RangeField, Section, SettingRow, Switch, TextField } from '../kit';
import type { TabCtx } from '../types';

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

export function OfferTab({ form, canEdit }: TabCtx) {
  const { draft, errors, set } = form;
  const o = draft.offer_authority;
  const off = !canEdit;
  const [mao, setMao] = useState('200000');
  const maoN = Number(mao.replace(/[^\d.]/g, ''));
  const ex = Number.isFinite(maoN) && maoN > 0 ? { low: maoN * o.floor_pct_of_mao / 100, high: maoN } : null;
  const quoting = o.mode !== 'none';
  return (
    <>
      <Section id="va-offer-mode" title="Can the agent name a price?" description="The single biggest limit on what an agent may say to a seller.">
        <ChoiceCards<OfferMode> label="Offer authority" value={o.mode} disabled={off} min={200} onChange={(v) => set(['offer_authority', 'mode'], v)}
          options={[
            { id: 'none', label: 'Never', hint: 'It does not make offers or hint at a price. The team prepares that.' },
            { id: 'range_only', label: 'Inside a range', hint: 'It may state a price inside the approved range.' },
            { id: 'range_with_approval', label: 'Range, a rep approves', hint: 'It may state a price inside the range, and a rep confirms and sends the agreement.' },
          ]} />
        {errors['offer_authority.mode'] ? <p role="alert" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--tx-red, #b91c1c)' }}>{errors['offer_authority.mode']}</p> : null}
        {!quoting ? <p style={{ margin: '10px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>The agent will say the team works out the number with them. Switch this on for acquisitions agents.</p> : null}
      </Section>

      {quoting ? (
        <>
          <Section id="va-range" title="The range" description="Where a quote may land, as a share of the deal's maximum allowable offer (MAO).">
            <RangeField id={fieldId('offer_authority.floor_pct_of_mao')} label="Lowest it may quote" value={o.floor_pct_of_mao} min={50} max={100} step={1} unit="% of MAO" disabled={off} error={errors['offer_authority.floor_pct_of_mao']}
              hint="The floor. The ceiling is always the MAO itself, from the seller's latest underwrite." onChange={(v) => set(['offer_authority', 'floor_pct_of_mao'], v)} />
            <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label htmlFor="va-example-mao" style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>Try it with an MAO of</label>
                <div style={{ width: 150 }}><TextField id="va-example-mao" value={mao} onChange={setMao} inputMode="numeric" placeholder="200000" /></div>
              </div>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: INK }} aria-live="polite">
                {ex ? <>The agent may quote <strong>{money(ex.low)}</strong> to <strong>{money(ex.high)}</strong>.</> : 'Type a number to see the range.'}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>With no MAO on the seller, the agent has no range and quotes nothing.</p>
            </div>
          </Section>

          <Section id="va-quote-as" title="How it says it" description="One number to negotiate from, or the whole range as a ballpark.">
            <ChoiceCards<'number' | 'range'> label="How it quotes" value={o.quote_as} disabled={off} min={200} onChange={(v) => set(['offer_authority', 'quote_as'], v)}
              options={[
                { id: 'number', label: 'One number', hint: 'It names a price inside the range and negotiates from there. For acquisitions agents.' },
                { id: 'range', label: 'A ballpark range', hint: 'It gives the range ("somewhere in the low to high range") once it knows the basics, and the team firms it up. For lead managers.' },
              ]} />
          </Section>

          <Section id="va-steps" title="Moving the number" description="Whether the agent may go up during a call, and how fast.">
            <SettingRow first title="Allow step ups" help={o.quote_as === 'range' ? 'Not used while it quotes a ballpark range: the range itself never moves on a call.' : 'It starts near the floor and moves up only when the seller gives a reason or a trade, like a faster close. Never past the ceiling.'}>
              <Switch label="Allow step ups" on={o.allow_step_ups} disabled={off || o.quote_as === 'range'} onChange={(v) => set(['offer_authority', 'allow_step_ups'], v)} />
            </SettingRow>
            {o.allow_step_ups && o.quote_as !== 'range' ? (
              <div className="va-in" style={{ padding: '4px 0 12px' }}>
                <RangeField id={fieldId('offer_authority.step_size_pct')} label="Size of a step" value={o.step_size_pct} min={0.5} max={10} step={0.5} unit="% of the price" disabled={off} error={errors['offer_authority.step_size_pct']}
                  hint="Small steps keep the agent from bidding against itself." onChange={(v) => set(['offer_authority', 'step_size_pct'], v)} />
              </div>
            ) : null}
            <SettingRow title="A rep approves the agreement" help="The agent never sends paperwork on its own. It says a team member will send it shortly and agrees the time.">
              <Switch label="A rep approves the agreement" on={o.agreement_requires_rep_approval} disabled={off} onChange={(v) => set(['offer_authority', 'agreement_requires_rep_approval'], v)} />
            </SettingRow>
          </Section>

          <Banner tone="info">With the COMPR offer tool on, the agent quotes only after the tool returns a range inside the limits above. The range comes from the deal&apos;s MAO, or from a COMPR run that starts in the background when the call connects. The agreement tool is not built yet, so a person sends the paperwork.</Banner>
        </>
      ) : null}
    </>
  );
}
