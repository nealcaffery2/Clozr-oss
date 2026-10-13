// Search the carrier by area code and buy — optionally straight onto a teammate.
'use client';

import React, { useState } from 'react';
import { areaCity, formatPhone, talkr, type AvailableNumberDto } from '@/lib/talkr';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { Btn, MUTED, errText, field, type Note } from './ui';
import { attachToCampaign, ensureAssignable, refreshPhoneAdmin } from './store';

export function BuyNumber({ assignTo, assignName, onNote, initialArea = '210' }: {
  assignTo: string | null; assignName?: string | null; onNote: (n: Note) => void; initialArea?: string;
}) {
  const session = useSession();
  const [area, setArea] = useState(initialArea);
  const [found, setFound] = useState<AvailableNumberDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function search() {
    if (area.length !== 3) return onNote({ ok: false, text: 'Enter a three-digit area code.' });
    setBusy('search'); onNote(null);
    try {
      setFound((await talkr.searchNumbers({ area_code: area, limit: 6 })).numbers);
    } catch (err) {
      onNote({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function buy(n: AvailableNumberDto) {
    setBusy(n.phone_e164); onNote(null);
    try {
      const owner = await ensureAssignable(assignTo);
      const r = await talkr.buyNumber({ phone_e164: n.phone_e164, assigned_user_id: owner, label: areaCity(n.phone_e164) });
      setFound(null);
      const wsId = session.workspace?.id;
      if (supabase && wsId) {
        void supabase.functions.invoke('caller-registry', { body: { action: 'advance', workspace_id: wsId, phones: [r.number.phone_e164] } });
      }
      const tenDlc = await attachToCampaign(wsId, [r.number.phone_e164]);
      onNote({ ok: true, text: `${formatPhone(r.number.phone_e164)} bought${assignName ? ` for ${assignName}` : ' as a standby line'}. Calls and texts already route to Talkr. Caller registration is queued for this line.${tenDlc}` });
      await refreshPhoneAdmin();
    } catch (err) {
      onNote({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={area} onChange={(e) => setArea(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="Area code" inputMode="numeric" style={{ ...field, width: '96px' }} />
        <Btn primary disabled={busy === 'search'} onClick={() => void search()}>{busy === 'search' ? 'Searching…' : 'Search'}</Btn>
        {area.length === 3 && areaCity(`+1${area}0000000`) ? <span style={{ fontSize: '12px', color: MUTED }}>{areaCity(`+1${area}0000000`)}</span> : null}
      </div>
      {found ? (
        found.length === 0 ? (
          <div style={{ fontSize: '12px', color: MUTED, marginTop: '8px' }}>Nothing for sale in {area} right now. Try a neighbouring area code.</div>
        ) : (
          <div style={{ marginTop: '8px', border: '1px solid #e4e4e7', borderRadius: '10px', overflow: 'hidden' }}>
            {found.map((n, i) => (
              <div key={n.phone_e164} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px', borderTop: i ? '1px solid #f0f0f1' : 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{formatPhone(n.phone_e164)}</div>
                  <div style={{ fontSize: '11.5px', color: MUTED }}>{[n.locality, n.region].filter(Boolean).join(', ')}{n.capabilities.sms ? ' · SMS' : ''}</div>
                </div>
                <Btn primary small disabled={Boolean(busy)} onClick={() => void buy(n)}>{busy === n.phone_e164 ? 'Buying…' : 'Buy'}</Btn>
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
