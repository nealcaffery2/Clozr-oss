'use client';

// The seller record's shared blocks: the deal team, the contracts, and the
// photos and files. Both record layouts draw them (SellerRecord.tsx for the
// new deal page, SellerRecordClassic.tsx for the three-column record), so a
// fix here lands in both.

import React, { useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ContractPopup } from '@/components/ContractsHub';
import type { SectionKey } from '@/app/components/record/RecordDetailsSheet';
import { ContractsCard } from '@/components/ContractsCard';
import { ContractTemplatePicker } from '@/components/ContractTemplatePicker';
import { DealTeam } from '@/components/DealTeam';
import { DealFiles } from '@/components/DealFiles';
import { InteractiveFolderGallery } from '@/components/ui/interactive-folder-gallery';
import { eyebrow } from '@/app/components/record/ui';

export const MORE_GROUPS: { group: string; keys: SectionKey[] }[] = [
  { group: 'Deal', keys: ['contracts', 'team', 'deals'] },
  { group: 'Follow-up', keys: ['plan', 'appointments', 'tags'] },
  { group: 'Property', keys: ['records', 'files', 'sellers'] },
];

export function DealTeamBlock({ V }: { V: ClozrView }) {
  const live = V.liveIds;
  return (
    <div style={{ marginTop: '16px' }}>
      {live?.sellerId != null ? (
        <DealTeam bare sellerId={live.sellerId} dealId={live.dealId} onCall={V.callParty} onOpenSeller={(id) => V.openPerson('s' + id)} onOpenBuyer={(id) => V.openBuyerRecord('b' + id)} onOpenVendor={V.openVendorContact} onChanged={V.dealTeamSaved} />
      ) : (
        <>
          <div style={eyebrow}>Deal team</div>
          <div style={{ marginTop: '6px', fontSize: '12.5px', color: '#71717a' }}>Title, agents and the rest of the team show here on a signed-in deal.</div>
        </>
      )}
    </div>
  );
}

/**
 * The record's contracts: "New contract" lists the templates only; picking one
 * opens the contract full size on that template, filled from this record.
 * "Open contracts full size" opens the same view with nothing picked.
 */
export function ContractsBlock({ V }: { V: ClozrView }) {
  const live = V.liveIds;
  const [picking, setPicking] = useState(false);
  // undefined: closed; null: open, nothing picked; a number: open on that template.
  const [full, setFull] = useState<number | null | undefined>(undefined);
  if (live?.sellerId == null) {
    return (
      <div style={{ marginTop: '16px', fontSize: '12.5px', color: '#71717a', padding: '10px 12px', border: '1px dashed #e4e4e7', borderRadius: '9px' }}>
        Contracts fill from this record once you are signed in.
      </div>
    );
  }
  const seller = { id: live.sellerId, name: V.P.name, email: V.P.email || '', phone: V.P.phone || '', addr: V.P.addr, dealId: live.dealId };
  return (
    <div style={{ marginTop: '16px' }} data-testid="record-contracts">
      <button type="button" className="dc2" onClick={() => setFull(null)} style={{ display: 'block', marginLeft: 'auto', marginBottom: '6px', height: '26px', padding: '0 10px', borderRadius: '7px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '11.5px', fontWeight: 600, color: '#0A8560', cursor: 'pointer' }}>
        Open contracts full size
      </button>
      <ContractsCard
        compact
        workspaceId={live.workspaceId}
        sellerId={live.sellerId}
        dealId={live.dealId}
        seller={{ name: V.P.name, email: V.P.email, phone: V.P.phone }}
        canWrite={live.canWrite}
        onToast={V.showToast}
        onChanged={V.reloadCrm}
        onNewContract={() => setPicking(true)}
      />
      {picking && live.workspaceId ? (
        <ContractTemplatePicker
          workspaceId={live.workspaceId}
          who={V.P.name}
          onPick={(id) => { setPicking(false); setFull(id); }}
          onOther={() => { setPicking(false); setFull(-1); }}
          onClose={() => setPicking(false)}
        />
      ) : null}
      {full !== undefined ? (
        <ContractPopup
          key={full ?? 'all'}
          V={V}
          target={{ sellerId: live.sellerId, dealId: live.dealId, buyerId: null, title: `Contracts · ${V.P.name}`, seller }}
          startTemplateId={full}
          onClose={() => setFull(undefined)}
        />
      ) : null}
    </div>
  );
}

export function FilesBlock({ V, compact }: { V: ClozrView; compact?: boolean }) {
  const live = V.liveIds;
  // The house the Property card shows (V.P.dealDbId), so its photos and files sit together.
  const dealId = V.P.dealDbId ?? live?.dealId ?? null;
  return (
    <div style={{ marginTop: compact ? '10px' : '16px' }} data-testid="record-photos-files">
      <div style={{ ...eyebrow, marginBottom: '8px' }}>Photos and files</div>
      {live && dealId != null ? (
        <DealFiles
          key={dealId}
          workspaceId={live.workspaceId}
          dealId={dealId}
          canWrite={live.canWrite}
          onToast={V.showToast}
          onOpenPhotos={(title, urls, start) => V.openPhotoShow(title, urls, dealId, start)}
          fallbackPhotos={V.P.photos.length ? V.P.photos : [V.P.streetSafe].filter(Boolean)}
        />
      ) : (
        <>
          {V.P.photos.length ? (
            <div style={{ marginBottom: '8px', padding: '6px 0', display: 'flex', justifyContent: 'center', background: 'transparent' }}>
              <InteractiveFolderGallery
                size="sm"
                photos={V.P.photos.map((u, i) => ({ id: i, image: u, label: i === 0 ? 'Front' : undefined }))}
                folderName={`${V.P.photos.length} photo${V.P.photos.length === 1 ? '' : 's'}`}
                dragHintText="Tap a photo to view · drag down to close"
                onPhotoClick={(i) => V.openPhotoShow(V.P.addr, V.P.photos, null, i)}
              />
            </div>
          ) : null}
          <div style={{ fontSize: '12.5px', color: '#71717a', padding: '10px 12px', border: '1px dashed #e4e4e7', borderRadius: '9px' }}>
            Photos, docs and links attach to a deal, so they sit here once this record has one.
          </div>
        </>
      )}
    </div>
  );
}
