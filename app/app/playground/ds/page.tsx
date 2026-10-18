// PLAYGROUND — the shared building blocks in components/ds, side by side, so a
// change to one can be seen (and screenshotted) without finding a screen that
// uses it. Nothing here saves anywhere: every save is a local promise.
'use client';

import React, { useState } from 'react';
import { InlineField, type InlineValue } from '@/components/ds/InlineField';
import { BackLink } from '@/components/ds/BackLink';
import { RepPicker } from '@/components/ds/RepPicker';
import { useConfirm } from '@/components/ds/Confirm';
import { btn, INK, MUTED } from '@/components/genius/parts';
import { D as SAMPLE } from '@/lib/clozr-types';
import { leadStagePicks } from '@/lib/stages';
import '../../clozr/chrome.css';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function DsPlayground() {
  const [vals, setVals] = useState<Record<string, InlineValue>>({
    name: 'Kara Mitchell', asking: 235000, beds: 4, close: '2026-10-30', stage: 'Offer Made',
    phone: '(210) 555-0136', email: 'kara@example.com', notes: 'Inherited the house; brother in Phoenix co-signs.',
  });
  const [rep, setRep] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const { confirm, confirmReason } = useConfirm();
  const save = (field: string, fail = false) => async (v: InlineValue) => {
    await wait(400);
    if (fail) return { ok: false, message: 'The database refused it: that phone is on another seller' };
    setVals((x) => ({ ...x, [field]: v }));
    return { ok: true };
  };
  const stageOptions = leadStagePicks(String(vals.stage)).flatMap((g) => g.stages.map((s) => ({ value: s, label: s, group: g.group })));
  const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '12px' };
  return (
    <main data-gx style={{ minHeight: '100dvh', background: 'var(--page, #f2f4f8)', padding: '16px', color: INK }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <BackLink to={{ label: 'Deals', go: () => setSaid('Back to Deals') }} />
        <h1 style={{ margin: 0, fontSize: '15px', fontWeight: 700, letterSpacing: '-0.015em' }}>Building blocks</h1>
        <section style={{ background: 'var(--surface, #fff)', border: '1px solid var(--edge, #dde2ea)', borderRadius: '12px', padding: '16px' }}>
          <h2 style={{ margin: '0 0 12px', fontSize: '13.5px', fontWeight: 650 }}>Click to edit</h2>
          <div style={{ ...row, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <InlineField showLabel recordId="s1" field="name" label="Name" type="text" value={vals.name} onSave={save('name')} />
            <InlineField showLabel recordId="s1" field="asking" label="Asking" type="money" value={vals.asking} onSave={save('asking')} />
            <InlineField showLabel recordId="s1" field="beds" label="Beds" type="number" value={vals.beds} onSave={save('beds')} />
            <InlineField showLabel recordId="s1" field="close" label="Close date" type="date" value={vals.close} onSave={save('close')} />
            <InlineField showLabel recordId="s1" field="stage" label="Stage" type="select" options={stageOptions} value={vals.stage} onSave={save('stage')} />
            <InlineField showLabel recordId="s1" field="phone" label="Phone (save fails)" type="phone" value={vals.phone} onSave={save('phone', true)} />
            <InlineField showLabel recordId="s1" field="email" label="Email" type="email" value={vals.email} onSave={save('email')} />
            <InlineField showLabel recordId="s1" field="owner" label="Owner (read-only)" type="text" value="Taylor Reed" readOnly="Only admins can change the owner" onSave={save('owner')} />
          </div>
          <div style={{ marginTop: '12px' }}>
            <InlineField showLabel recordId="s1" field="notes" label="Notes" type="textarea" value={vals.notes} onSave={save('notes')} width="100%" />
          </div>
        </section>
        <section style={{ background: 'var(--surface, #fff)', border: '1px solid var(--edge, #dde2ea)', borderRadius: '12px', padding: '16px' }}>
          <h2 style={{ margin: '0 0 12px', fontSize: '13.5px', fontWeight: 650 }}>Rep picker and confirm</h2>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <RepPicker label="TC" team={SAMPLE.team} roles={['tc']} value={rep} onChange={setRep} />
            <button type="button" style={btn('ghost')} onClick={async () => setSaid((await confirm({ title: 'Archive Kara Mitchell?', body: 'They leave every list, but nothing is deleted.', confirmLabel: 'Archive', tone: 'danger' })) ? 'Archived' : 'Kept')}>Archive</button>
            <button type="button" style={btn('purple')} onClick={async () => { const why = await confirmReason({ title: 'Close on a Friday?', body: 'Wires sent Friday can miss the weekend. Say why it has to be Friday.', confirmLabel: 'Close on Friday', reasonLabel: 'Why it has to be Friday' }); setSaid(why === null ? 'Cancelled' : 'Reason: ' + why); }}>Set Friday close</button>
          </div>
          <p role="status" style={{ margin: '12px 0 0', fontSize: '12.5px', color: MUTED }}>{said || 'Nothing yet'}</p>
        </section>
      </div>
    </main>
  );
}
