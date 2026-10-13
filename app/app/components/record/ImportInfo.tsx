'use client';

// What an import brought beyond the core fields (migration 134), on the
// seller's What we know: other emails, a second owner, the mailing address,
// what the list says about the house, and "More from import" — every column
// the import had no field for, by its header. Read for the open seller only;
// on a database without migration 134 it shows nothing, as before.

import React, { useEffect, useState } from 'react';
import { type ImportInfo, loadImportInfo } from '@/lib/import-extras';

const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '132px minmax(0,1fr)', gap: '10px', padding: '7px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12.5px', alignItems: 'baseline', margin: 0 };
const dt: React.CSSProperties = { color: '#71717a', lineHeight: 1.35 };
const dd: React.CSSProperties = { margin: 0, minWidth: 0, fontWeight: 500, overflowWrap: 'anywhere' };
const badge: React.CSSProperties = { fontSize: '10px', fontWeight: 700, color: '#b91c1c', background: '#fef2f2', borderRadius: '5px', padding: '1px 5px', marginLeft: '6px', letterSpacing: '0.02em' };
// A list of facts takes the rail's whole width under its label: nested in the
// 132px label column it left values about 60px and broke them mid-word.
const block: React.CSSProperties = { padding: '7px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12.5px', margin: 0 };
const pairs: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(96px,max-content) minmax(0,1fr)', gap: '4px 12px', fontSize: '12.5px', marginTop: '6px' };

export function ImportInfoRows({ workspaceId, sellerId }: { workspaceId: number; sellerId: number }) {
  const [info, setInfo] = useState<ImportInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadImportInfo(workspaceId, sellerId).then((x) => { if (alive) setInfo(x); });
    return () => { alive = false; };
  }, [workspaceId, sellerId]);
  if (!info) return null;

  const mail = info.mailing
    ? [info.mailing.line1, info.mailing.city, [info.mailing.state, info.mailing.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : '';
  const house = [
    ...(info.lotSqft ? [{ k: 'Lot size', v: `${info.lotSqft.toLocaleString('en-US')} sqft` }] : []),
    ...(info.county ? [{ k: 'County', v: info.county }] : []),
    ...info.facts,
  ];
  const extra = Object.entries(info.extra);

  return (
    <>
      {info.otherEmails.length ? (
        <div style={row}>
          <dt style={dt}>Other emails</dt>
          <dd style={dd}>
            {info.otherEmails.map((e) => <div key={e}><a href={`mailto:${e}`} className="clozr-contact" style={{ fontWeight: 500 }}>{e}</a></div>)}
          </dd>
        </div>
      ) : null}
      {info.owner2 ? (
        <div style={row}><dt style={dt}>Owner 2</dt><dd style={dd}>{info.owner2}</dd></div>
      ) : null}
      {mail || info.doNotMail ? (
        <div style={row} data-testid="record-mailing">
          <dt style={dt}>Mailing address</dt>
          <dd style={dd}>{mail || '—'}{info.doNotMail ? <span style={badge} title="The list marks this owner do not mail">Do not mail</span> : null}</dd>
        </div>
      ) : null}
      {house.length ? (
        <div style={block} data-testid="record-list-facts">
          <dt style={dt}>From the list</dt>
          <dd style={{ margin: 0 }}>
            <div style={pairs}>
              {house.map((f) => (
                <React.Fragment key={f.k}>
                  <span style={{ color: '#71717a' }}>{f.k}</span>
                  <span style={{ fontWeight: 500, minWidth: 0, overflowWrap: 'break-word' }}>{f.v}</span>
                </React.Fragment>
              ))}
            </div>
          </dd>
        </div>
      ) : null}
      {extra.length ? (
        <div style={block} data-testid="record-import-extra">
          <dt style={dt}>More from import</dt>
          <dd style={{ margin: '4px 0 0' }}>
            <details>
              <summary style={{ cursor: 'pointer', color: '#0A8560', fontWeight: 600, fontSize: '12px' }}>
                {extra.length} {extra.length === 1 ? 'field' : 'fields'}
              </summary>
              <div style={{ ...pairs, marginTop: '6px' }}>
                {extra.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <span style={{ color: '#71717a' }}>{k}</span>
                    <span style={{ fontWeight: 500, minWidth: 0, overflowWrap: 'break-word' }}>{v}</span>
                  </React.Fragment>
                ))}
              </div>
            </details>
          </dd>
        </div>
      ) : null}
    </>
  );
}
