// What the Quick Add dialog asks before it writes, in place of the form.
//
//   A duplicate (lib/quick-add-dupes): the seller or buyer typed is already in
//   the workspace — add to them, override them, create a new one anyway
//   (sellers only, and not on a phone another seller has), or go back.
//   A shared address: an address edit on a property other sellers are on —
//   move just this seller, or everyone on it.
'use client';

import React from 'react';
import type { ClozrView } from './view';

const choice: React.CSSProperties = {
  display: 'grid', gap: '2px', width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '10px',
  border: '1px solid #e4e4e7', background: '#fff', cursor: 'pointer', color: '#18181b', font: 'inherit',
};
const title: React.CSSProperties = { fontSize: '13px', fontWeight: 650 };
const why: React.CSSProperties = { fontSize: '12px', color: '#71717a', lineHeight: 1.45 };

function Choice({ label, note, onClick, primary, disabled, testId }: {
  label: string; note: string; onClick: () => void; primary?: boolean; disabled?: boolean; testId?: string;
}) {
  return (
    <button type="button" className="dc2" data-testid={testId} onClick={onClick} disabled={disabled}
      style={{ ...choice, ...(primary ? { borderColor: '#18181b' } : {}), ...(disabled ? { cursor: 'not-allowed', opacity: 0.55, background: '#fafafa' } : {}) }}>
      <span style={title}>{label}</span>
      <span style={why}>{note}</span>
    </button>
  );
}

export function AddAsk({ V }: { V: ClozrView }) {
  const ask = V.addAsk;
  if (!ask) return null;

  if (ask.kind === 'scope') {
    const first = V.P.name.split(' ')[0] || V.P.name;
    const n = ask.others.length;
    const names = ask.others.slice(0, 3).map((o) => o.name).join(', ') + (n > 3 ? ` and ${n - 3} more` : '');
    return (
      <div role="group" aria-label="Who moves to the new address" style={{ display: 'grid', gap: '8px' }}>
        <div style={{ padding: '10px 12px', borderRadius: '10px', background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '12.5px', color: '#1e3a8a', lineHeight: 1.5 }}>
          <strong>{n} other seller{n === 1 ? ' is' : 's are'} on {ask.address || 'this property'}</strong>: {names}. Who moves to the new address?
        </div>
        <Choice primary testId="ask-scope-seller" label={`Just ${first}`} note={`Moves ${first} and their open deals. The others stay at the old address.`} onClick={() => V.resolveAddAsk('seller')} />
        <Choice testId="ask-scope-everyone" label={`Everyone on the property (${n + 1})`} note="Moves every seller on it and every open deal on it to the new address." onClick={() => V.resolveAddAsk('everyone')} />
        <Choice label="Back to the address" note="Change it before anything moves. Nothing is saved yet." onClick={() => V.resolveAddAsk('cancel')} />
      </div>
    );
  }

  const d = ask.dupe;
  const first = d.name.split(' ')[0] || d.name;
  const seller = d.kind === 'seller';
  const typedAddr = !!(V.addFields.find((f) => f.key === 'addr')?.value ?? '').trim();
  return (
    <div role="group" aria-label="Already in CLOZR" style={{ display: 'grid', gap: '8px' }}>
      <div style={{ padding: '10px 12px', borderRadius: '10px', background: '#fffbeb', border: '1px solid #fde68a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: '#92400e' }}>
            Already in CLOZR · same {d.by}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={V.openAddAskRecord} style={{ border: 0, background: 'none', padding: 0, color: '#0A8560', fontSize: '12px', fontWeight: 650, cursor: 'pointer' }}>
            Open {seller ? 'the record' : 'the buyer'}
          </button>
        </div>
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#18181b', marginTop: '4px' }}>{d.name}</div>
        {d.detail.length ? <div style={{ fontSize: '12px', color: '#52525b', marginTop: '1px' }}>{d.detail.join(' · ')}</div> : null}
        {d.archived ? (
          <div style={{ fontSize: '12px', color: '#92400e', marginTop: '6px', fontWeight: 600 }}>This {seller ? 'seller' : 'buyer'} is archived. Add to or Override takes them out of the archive and opens the record.</div>
        ) : null}
        {d.otherPerson ? (
          <div style={{ fontSize: '12px', color: '#92400e', marginTop: '6px' }}>A different name at this address — a co-owner or an heir, most likely. Create new adds them as another seller on the property.</div>
        ) : null}
      </div>
      <Choice primary testId="ask-dupe-fill" label={`Add to ${first}`}
        note={`Fills only ${first}’s empty fields with what you typed${seller ? (typedAddr ? ', and the address if they have none' : '') : '; new markets join the buy box'}. Nothing is blanked or replaced.`}
        onClick={() => V.resolveAddAsk('fill')} />
      <Choice testId="ask-dupe-overwrite" label={`Override ${first}`}
        note={`Writes every field you filled in over ${first}’s${seller && typedAddr ? '; a different address moves them, with their open deals' : ''}. Empty fields leave theirs alone.`}
        onClick={() => V.resolveAddAsk('overwrite')} />
      {seller ? (
        <Choice testId="ask-dupe-create" label="Create new anyway" disabled={!d.canCreate}
          note={d.canCreate ? (d.by === 'address' ? 'A separate seller on the same property.' : 'A separate seller record.') : 'Not possible: two sellers cannot share a phone number. Change the phone, or add to the record above.'}
          onClick={() => V.resolveAddAsk('create')} />
      ) : null}
      <Choice label="Back to the form" note="Change what you typed. Nothing is saved; Cancel below drops it." onClick={() => V.resolveAddAsk('cancel')} />
    </div>
  );
}
