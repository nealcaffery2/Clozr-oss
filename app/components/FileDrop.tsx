// A file picker you can also drop onto: the dashed box PandaDoc and DocuSign
// use for "upload a document". Shows the chosen file once there is one.
'use client';

import React, { useRef, useState } from 'react';

export function FileDrop({ file, onFile, accept, hint }: { file: File | null; onFile: (f: File) => void; accept: string; hint?: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button" tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px', padding: '8px 12px', borderRadius: '9px', cursor: 'pointer',
        border: `1.5px dashed ${over ? '#0A8560' : file ? '#a7f3d0' : '#c4c4c8'}`, background: over ? 'var(--tint-green, #ecfdf5)' : file ? 'var(--tint-green-2, #f0fdf4)' : 'var(--surface, #fff)', fontSize: '12.5px', color: 'var(--ink, #18181b)' }}>
      <input ref={input} type="file" hidden accept={accept} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      <span aria-hidden style={{ fontSize: '16px' }}>{file ? '📄' : '⇪'}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file ? <><b>{file.name}</b> <span style={{ color: 'var(--meta, #71717a)' }}>· {(file.size / 1024 / 1024).toFixed(1)} MB · click to change</span></> : <>Drop a file here, or <u>choose one</u>{hint ? <span style={{ color: 'var(--meta, #71717a)' }}> · {hint}</span> : null}</>}
      </span>
    </div>
  );
}
