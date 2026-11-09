'use client';

// People → More filters: the questions a stage filter cannot answer.
//   Stage history  everyone who was ever at a stage, wherever they are now,
//                  optionally only when they reached it inside a window.
//   Money          offer and ARV ranges (any of a contact's deals in range).
//   List stacking  deals sent, properties held, lists they are on.
// One panel rather than seven more chips on a toolbar that already wraps.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { AttackGapFields, DateRangeFields } from '@/app/components/filters/RangeFilters';

const label: React.CSSProperties = { display: 'block', fontSize: 11.5, color: 'var(--meta, #71717a)', fontWeight: 500, marginBottom: 4 };
const field: React.CSSProperties = { width: '100%', height: 32, padding: '0 8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 8, fontSize: 12.5, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)', fontFamily: 'inherit', boxSizing: 'border-box' };
const head: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--ink, #18181b)', margin: '0 0 8px' };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 };
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 };
const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--meta, #71717a)', marginTop: 6, lineHeight: 1.45 };

/** 'Any' is how an unset value is stored; an input shows it as empty. */
const shown = (v: string | undefined) => (v && v !== 'Any' ? v : '');
const stored = (v: string) => (v.trim() ? v.trim() : 'Any');

function Pick({ name, value, options, onChange }: { name: string; value: string | undefined; options: string[]; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'block', minWidth: 0 }}>
      <span style={label}>{name}</span>
      <select value={value ?? options[0]} onChange={(e) => onChange(e.target.value)} style={field}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function MoneyRange({ name, bucket, min, max, options, set, keys }: {
  name: string; bucket: string | undefined; min: string | undefined; max: string | undefined; options: string[];
  set: (patch: Record<string, string>) => void; keys: [string, string, string];
}) {
  return (
    <div>
      <Pick name={name} value={bucket} options={options} onChange={(v) => set({ [keys[0]]: v })} />
      {bucket === 'Custom' ? (
        <div style={{ ...grid2, marginTop: 6 }}>
          <input aria-label={`${name} minimum`} placeholder="Min (150k)" value={shown(min)} onChange={(e) => set({ [keys[1]]: stored(e.target.value) })} style={field} />
          <input aria-label={`${name} maximum`} placeholder="Max (250k)" value={shown(max)} onChange={(e) => set({ [keys[2]]: stored(e.target.value) })} style={field} />
        </div>
      ) : null}
    </div>
  );
}

/** Stage history, money and list stacking: the fields alone, for the popover below and the side filter panel. */
export function MoreFiltersFields({ V }: { V: ClozrView }) {
  const m = V.peopleMore;
  const f = m.values;
  const set = m.set as (patch: Record<string, string>) => void;
  return (
    <>
      <DateRangeFields when={f.addedWhen} from={f.addedFrom} to={f.addedTo} onChange={(patch) => set({ addedWhen: patch.when, ...(patch.from != null ? { addedFrom: patch.from } : {}), ...(patch.to != null ? { addedTo: patch.to } : {}) })} />
      <AttackGapFields basis={f.attackBasis} gap={f.attackGap} onBasis={(v) => set({ attackBasis: v })} onGap={(v) => set({ attackGap: v })} />
      <section>
        <h3 style={head}>Stage history</h3>
        <div style={grid2}>
          <Pick name="Ever reached" value={f.history} options={['Any', ...m.stages]} onChange={(v) => set({ history: v })} />
          <Pick name="When" value={f.historyWhen} options={m.when} onChange={(v) => set({ historyWhen: v })} />
        </div>
        {f.historyWhen === 'Custom' ? (
          <div style={{ ...grid2, marginTop: 6 }}>
            <label><span style={label}>From</span><input type="date" value={shown(f.historyFrom)} onChange={(e) => set({ historyFrom: stored(e.target.value) })} style={field} /></label>
            <label><span style={label}>To</span><input type="date" value={shown(f.historyTo)} onChange={(e) => set({ historyTo: stored(e.target.value) })} style={field} /></label>
          </div>
        ) : null}
        <div style={note}>
          {m.historyLoading ? 'Looking through stage history…'
            : 'Everyone who was ever at this stage, whatever stage they are at now. Moves before stage history began carry the best date on file.'}
        </div>
      </section>
      <section>
        <h3 style={head}>Money</h3>
        <div style={grid2}>
          <MoneyRange name="Our offer" bucket={f.offer} min={f.offerMin} max={f.offerMax} options={m.money} set={set} keys={['offer', 'offerMin', 'offerMax']} />
          <MoneyRange name="ARV" bucket={f.arv} min={f.arvMin} max={f.arvMax} options={m.money} set={set} keys={['arv', 'arvMin', 'arvMax']} />
        </div>
        <div style={note}>A partner matches when any of their deals is in range.</div>
      </section>
      <section>
        <h3 style={head}>List stacking</h3>
        <div style={grid3}>
          <Pick name="Submissions" value={f.subs} options={m.subs} onChange={(v) => set({ subs: v })} />
          <Pick name="Properties" value={f.props} options={m.props} onChange={(v) => set({ props: v })} />
          <Pick name="List stack" value={f.stack} options={m.stack} onChange={(v) => set({ stack: v })} />
        </div>
        <div style={note}>Submissions: deals they have sent. List stack: lists they are on (tags, less bookkeeping like Podio submission). Sort by any of these from Sort or the column headers.</div>
      </section>
    </>
  );
}

/** `sheet`: on a phone the trigger sits in a sideways-scrolling tray that would clip a dropdown, so the panel rises from the bottom instead. */
export function MoreFilters({ V, sheet = false }: { V: ClozrView; sheet?: boolean }) {
  const m = V.peopleMore;
  const on = m.active > 0;
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button type="button" className="dc9 cz-menu-trigger" onClick={m.toggle} aria-expanded={m.open}
        style={{ height: 32, padding: '0 10px', borderRadius: 10, border: `1px solid ${on ? '#0A8560' : 'var(--c-btn-line)'}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--c-btn-bg)', fontSize: 12.5, color: on ? 'var(--tx-mint, #0a8560)' : 'var(--ink-2, #27272a)', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: on ? 600 : 500, fontFamily: 'var(--font-sans)' }}>
        More filters{on ? ` · ${m.active}` : ''}
      </button>
      {m.open ? (
        <>
          <div onClick={m.close} style={{ position: 'fixed', inset: 0, zIndex: sheet ? 49 : 44, background: sheet ? 'rgba(24,24,27,.28)' : undefined }} />
          <div role="dialog" aria-label="More filters" className="cz-menu cz-menu--left"
            style={sheet
              ? { position: 'fixed', left: 12, right: 12, top: 'auto', bottom: 'calc(66px + env(safe-area-inset-bottom, 0px))', zIndex: 49, maxHeight: 'calc(100dvh - 150px)', overflow: 'auto', padding: 14, display: 'grid', gap: 16 }
              : { top: 38, left: 0, width: 'min(420px, calc(100vw - 32px))', maxHeight: 'min(560px, 70vh)', overflow: 'auto', padding: 14, display: 'grid', gap: 16 }}>
            <MoreFiltersFields V={V} />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button type="button" onClick={m.clear} style={{ height: 30, padding: '0 10px', border: 0, background: 'none', color: 'var(--tx-mint, #0a8560)', fontSize: 12.5, cursor: 'pointer' }}>Clear these</button>
              <button type="button" onClick={m.close} style={{ height: 30, padding: '0 14px', borderRadius: 8, border: '1px solid #0A8560', background: '#0A8560', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Done</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
