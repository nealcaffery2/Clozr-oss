'use client';

// "Assign" on the People and Buyers bulk bars. Two ways:
//   One person          everything selected goes to one teammate (or nobody).
//   Split between people pick teammates (or "All acquisitions"), then split the
//                       selection evenly or give each the next N in the list:
//                       "200 each for Quinn, Avery and Blake" is rows 1-200,
//                       201-400 and 401-600, in the order the list shows.
// The split itself is lib/bulk-assign (tested); the screen writes each block.

import React, { useMemo, useState } from 'react';
import { Shuffle, Users, X } from 'lucide-react';
import { blockRanges, countOf, inRole, splitBlocks, wanted, type AssignBlock } from '@/lib/bulk-assign';

export type AssignMate = { id: string; name: string; initials?: string; memberRole?: string };

const GREEN = '#0A8560';
const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const label: React.CSSProperties = { fontSize: '11.5px', color: MUTED, fontWeight: 600 };
const chip = (on: boolean): React.CSSProperties => ({
  height: 30, padding: '0 10px 0 4px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12.5, fontWeight: on ? 650 : 500, color: on ? GREEN : INK,
  border: `1px solid ${on ? 'rgba(10,133,96,.45)' : LINE}`, background: on ? 'var(--mint-dim, #e7f8f1)' : 'var(--surface, #fff)',
});
const ROLE_PICKS: { role: string; label: string }[] = [
  { role: 'acquisitions', label: 'All acquisitions' },
  { role: 'dispositions', label: 'All dispositions' },
];

function Dot({ mate, n }: { mate: AssignMate | null; n?: number }) {
  return (
    <span aria-hidden style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700, flex: 'none',
      background: n ? GREEN : 'var(--surface-2, #f4f4f5)', color: n ? 'var(--surface, #fff)' : 'var(--muted, #52525b)' }}>
      {n ?? (mate ? (mate.initials || mate.name.slice(0, 1)).slice(0, 2) : '–')}
    </span>
  );
}

export function AssignPanel({ noun, team, selectedIds, listCount, canWrite, onSelectFirst, onAssign, onClose }: {
  /** 'lead' / 'buyer': the panel's wording. */
  noun: { one: string; many: string };
  team: AssignMate[];
  /** The selection in list order: blocks are cut from this. */
  selectedIds: string[];
  /** Rows in the list right now, for "select the first 600". */
  listCount: number;
  canWrite: boolean;
  /** Replace the selection with the first `n` rows of the list. */
  onSelectFirst: (n: number) => void;
  /** Write the blocks; the panel shows busy until it settles. */
  onAssign: (blocks: AssignBlock[]) => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'one' | 'split'>('one');
  const [picked, setPicked] = useState<string[]>([]);
  const [howMany, setHowMany] = useState<'even' | 'each'>('even');
  const [eachText, setEachText] = useState('200');
  const [busy, setBusy] = useState(false);
  const n = selectedIds.length;
  const byId = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const words = (k: number) => `${k.toLocaleString('en-US')} ${k === 1 ? noun.one : noun.many}`;

  const each = howMany === 'each' ? countOf(eachText) : null;
  const blocks = useMemo(() => (mode === 'split' && (howMany === 'even' || each) ? splitBlocks(selectedIds, picked, each) : []),
    [mode, howMany, each, selectedIds, picked]);
  const ranges = blockRanges(blocks);
  const total = blocks.reduce((k, b) => k + b.ids.length, 0);
  const want = wanted(picked.length, each, n);

  const run = async (b: AssignBlock[]) => {
    if (!b.length || busy) return;
    setBusy(true);
    try { await onAssign(b); } finally { setBusy(false); }
  };
  const togglePerson = (id: string) => setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const pickRole = (role: string) => {
    const ids = inRole(team, role).map((m) => m.id);
    setPicked((l) => (ids.every((id) => l.includes(id)) ? l.filter((id) => !ids.includes(id)) : [...l, ...ids.filter((id) => !l.includes(id))]));
  };

  return (
    <div role="region" aria-label="Assign" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px', background: 'var(--surface, #fff)', borderBottom: `1px solid ${LINE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={label}>Assign {words(n)}</span>
        <div role="tablist" aria-label="How to assign" style={{ display: 'inline-flex', padding: 2, borderRadius: 9, background: 'var(--surface-2, #f4f4f5)' }}>
          {([['one', 'One person', Users], ['split', 'Split between people', Shuffle]] as const).map(([id, text, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
              style={{ height: 28, padding: '0 10px', borderRadius: 7, border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: mode === id ? 650 : 500,
                display: 'inline-flex', alignItems: 'center', gap: 6, background: mode === id ? 'var(--surface, #fff)' : 'transparent', color: mode === id ? INK : MUTED, boxShadow: mode === id ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>
              <Icon size={13} aria-hidden /> {text}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose} aria-label="Close assign" style={{ width: 28, height: 28, border: 0, background: 'none', cursor: 'pointer', color: MUTED, display: 'grid', placeItems: 'center' }}><X size={15} /></button>
      </div>

      {mode === 'one' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {team.map((m) => (
            <button key={m.id} type="button" disabled={busy || !n} onClick={() => void run([{ userId: m.id, ids: selectedIds }])} style={chip(false)} title={`Assign ${words(n)} to ${m.name}`}>
              <Dot mate={m} /> {m.name}
            </button>
          ))}
          <button type="button" disabled={busy || !n} onClick={() => void run([{ userId: null, ids: selectedIds }])} style={chip(false)} title={`Take ${words(n)} off whoever has them`}>
            <Dot mate={null} /> Unassigned
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {ROLE_PICKS.filter((r) => inRole(team, r.role).length).map((r) => {
              const ids = inRole(team, r.role).map((m) => m.id);
              const all = ids.every((id) => picked.includes(id));
              return (
                <button key={r.role} type="button" onClick={() => pickRole(r.role)} aria-pressed={all}
                  style={{ ...chip(all), padding: '0 10px', borderStyle: 'dashed' }}>
                  {r.label} ({ids.length})
                </button>
              );
            })}
            {picked.length ? <button type="button" onClick={() => setPicked([])} style={{ height: 30, padding: '0 6px', border: 0, background: 'none', color: GREEN, fontSize: 12, cursor: 'pointer' }}>Clear</button> : null}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {team.map((m) => {
              const at = picked.indexOf(m.id);
              return (
                <button key={m.id} type="button" onClick={() => togglePerson(m.id)} aria-pressed={at >= 0} style={chip(at >= 0)}
                  title={at >= 0 ? `${m.name} is number ${at + 1} in the rotation` : `Add ${m.name} to the split`}>
                  <Dot mate={m} n={at >= 0 ? at + 1 : undefined} /> {m.name}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: INK }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" name="assign-howmany" checked={howMany === 'even'} onChange={() => setHowMany('even')} />
              Split the {words(n)} evenly
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" name="assign-howmany" checked={howMany === 'each'} onChange={() => setHowMany('each')} />
              The next
              <input aria-label={`${noun.many} each`} inputMode="numeric" value={eachText} onFocus={() => setHowMany('each')}
                onChange={(e) => setEachText(e.target.value.replace(/[^\d,]/g, '').slice(0, 7))}
                style={{ width: 64, height: 28, borderRadius: 7, border: `1px solid ${LINE}`, padding: '0 8px', fontSize: 12.5, fontFamily: 'inherit', textAlign: 'right' }} />
              each, in list order
            </label>
          </div>

          {picked.length && howMany === 'each' && each && want > n ? (
            <div style={{ fontSize: 12.5, color: 'var(--tx-amber-deep, #92400e)', background: 'var(--tint-amber, #fffbeb)', border: '1px solid var(--tint-amber-2, #fde68a)', borderRadius: 10, padding: '8px 11px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>{each.toLocaleString('en-US')} each for {picked.length} {picked.length === 1 ? 'person' : 'people'} takes {words(want)}; {n.toLocaleString('en-US')} are selected.</span>
              {listCount > n ? (
                <button type="button" onClick={() => onSelectFirst(Math.min(want, listCount))}
                  style={{ height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid #f59e0b', background: 'var(--surface, #fff)', color: 'var(--tx-amber-deep, #92400e)', fontWeight: 650, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Select the first {Math.min(want, listCount).toLocaleString('en-US')} in the list
                </button>
              ) : null}
              {listCount < want ? <span style={{ color: MUTED }}>This list has {listCount.toLocaleString('en-US')}, so the last {picked.length === 1 ? 'one' : 'person'} gets fewer.</span> : null}
            </div>
          ) : null}

          {ranges.length ? (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 }}>
              {ranges.map((r, i) => {
                const m = r.userId ? byId.get(r.userId) ?? null : null;
                return (
                  <li key={r.userId ?? 'none'} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 10, border: `1px solid ${LINE}`, background: 'var(--canvas, #fafafa)' }}>
                    <Dot mate={m} n={i + 1} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.name ?? 'Unassigned'}</span>
                      <span style={{ display: 'block', fontSize: 11.5, color: MUTED }}>{words(r.count)} · rows {r.from.toLocaleString('en-US')}–{r.to.toLocaleString('en-US')}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div style={{ fontSize: 12.5, color: MUTED }}>{picked.length ? (howMany === 'each' && !each ? 'Type how many each.' : `Select some ${noun.many} first.`) : 'Pick the people to split between. The order you pick them is the order they get their rows.'}</div>
          )}
          {total && total < n ? <div style={{ fontSize: 12, color: MUTED }}>{words(n - total)} past the last block stay as they are.</div> : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" disabled={busy || !blocks.length} onClick={() => void run(blocks)}
              style={{ height: 34, padding: '0 14px', borderRadius: 10, border: 0, background: GREEN, color: 'var(--on-dark, #fff)', fontWeight: 700, fontSize: 12.5, cursor: blocks.length ? 'pointer' : 'not-allowed', opacity: blocks.length ? 1 : 0.5, fontFamily: 'inherit' }}>
              {busy ? 'Assigning…' : blocks.length ? `Assign ${words(total)} to ${blocks.length} ${blocks.length === 1 ? 'person' : 'people'}` : 'Assign'}
            </button>
            {!canWrite ? <span style={{ fontSize: 11.5, color: MUTED }}>Preview only: nothing is saved.</span> : null}
          </div>
        </>
      )}
    </div>
  );
}

/** "Select [200]" on a bulk bar: the first N rows of the list, optionally only those with no owner. */
export function SelectCount({ listCount, onSelect, ownerAware }: {
  listCount: number;
  onSelect: (n: number, unassignedOnly: boolean) => void;
  /** Offer "unassigned only" (rows with an owner skipped). */
  ownerAware?: boolean;
}) {
  const [text, setText] = useState('');
  const [unassigned, setUnassigned] = useState(false);
  const n = countOf(text);
  const go = () => { if (n) onSelect(Math.min(n, listCount), unassigned); };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', fontSize: 12, color: INK }}>
      <span style={{ color: MUTED }}>Select</span>
      <input aria-label="How many to select" inputMode="numeric" placeholder="200" value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d,]/g, '').slice(0, 7))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
        style={{ width: 60, height: 28, borderRadius: 7, border: '1px solid rgba(10,133,96,.3)', padding: '0 8px', fontSize: 12, textAlign: 'right', fontFamily: 'inherit', background: 'var(--surface, #fff)' }} />
      {ownerAware ? (
        <label title="Skip rows that already have an owner" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap', color: MUTED }}>
          <input type="checkbox" checked={unassigned} onChange={(e) => setUnassigned(e.target.checked)} /> unassigned
        </label>
      ) : null}
      <button type="button" disabled={!n} onClick={go} title={`Select the first ${n ?? 'N'} of ${listCount.toLocaleString('en-US')} in the list`}
        style={{ height: 28, padding: '0 9px', borderRadius: 7, border: '1px solid rgba(10,133,96,.25)', background: 'var(--surface, #fff)', fontSize: 12, fontWeight: 600, color: n ? GREEN : 'var(--subtle, #a1a1aa)', cursor: n ? 'pointer' : 'not-allowed', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
        first {n ? Math.min(n, listCount).toLocaleString('en-US') : 'N'}
      </button>
    </span>
  );
}
