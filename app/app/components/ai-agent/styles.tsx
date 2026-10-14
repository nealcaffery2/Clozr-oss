'use client';

// Keyframes and responsive rules for the AI agent popup, toggle and report,
// scoped by the aia- prefix. Rendered by each root; identical copies are harmless.

import React from 'react';

export function AiaStyles() {
  return (
    <style>{`
      @keyframes aia-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @keyframes aia-pop { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
      @keyframes aia-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes aia-pulse { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.55); } 70% { box-shadow: 0 0 0 7px rgba(34,197,94,0); } 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); } }
      @keyframes aia-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .45; } 40% { transform: translateY(-4px); opacity: 1; } }
      @keyframes aia-shimmer { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
      @keyframes aia-spin { to { transform: rotate(360deg); } }
      .aia-back { animation: aia-fade .16s ease-out; }
      .aia-modal { animation: aia-pop .22s cubic-bezier(.2,.8,.2,1); }
      .aia-rise { animation: aia-rise .22s ease-out; }
      .aia-live { animation: aia-pulse 1.8s ease-out infinite; }
      .aia-dot { width: 7px; height: 7px; border-radius: 50%; background: #a1a1aa; display: inline-block; animation: aia-bounce 1s infinite ease-in-out; }
      .aia-magic { background: linear-gradient(90deg, #08694C, #0A8560, #0f9b70, #08694C); background-size: 200% 100%; animation: aia-shimmer 4s linear infinite; box-shadow: 0 10px 24px -12px rgba(10,133,96,.7); }
      .aia-magic:hover:not(:disabled) { filter: brightness(1.06); }
      .aia-chip { transition: border-color .15s, box-shadow .15s, transform .15s; }
      .aia-chip:hover:not(:disabled) { border-color: rgba(10,133,96,.4) !important; box-shadow: 0 4px 14px -8px rgba(10,133,96,.5); transform: translateY(-1px); }
      .aia-composer:focus-within { border-color: rgba(10,133,96,.55) !important; box-shadow: 0 0 0 4px rgba(10,133,96,.12), 0 8px 24px -16px rgba(15,23,42,.25) !important; }
      .aia-glow { position: absolute; inset: 0; background: radial-gradient(600px 120px at 10% -20%, rgba(255,255,255,.22), transparent 60%), radial-gradient(400px 140px at 100% 120%, rgba(255,255,255,.12), transparent 60%); pointer-events: none; }
      .aia-orbit { position: absolute; inset: -6px; border-radius: 50%; border: 2px dashed rgba(10,133,96,.35); animation: aia-spin 14s linear infinite; }
      .aia-icon-btn:hover:not(:disabled) { background: rgba(255,255,255,.2) !important; }
      .aia-seg { transition: background .15s, color .15s, box-shadow .15s; }
      .aia-seg:hover:not(:disabled):not([aria-pressed="true"]) { color: #18181b !important; background: rgba(255,255,255,.6) !important; }
      .aia-pill { transition: box-shadow .15s, transform .15s, background .2s, border-color .2s; }
      .aia-pill:hover:not(:disabled) { transform: translateY(-1px); }
      .aia-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      .aia-modal button:focus-visible, .aia-modal select:focus-visible, .aia-pill:focus-visible, .aia-modal summary:focus-visible { outline: 2px solid #0A8560; outline-offset: 2px; }
      .aia-modal summary::-webkit-details-marker { display: none; }
      @media (max-width: 760px) {
        .aia-back { padding: 0 !important; align-items: stretch !important; }
        .aia-modal { width: 100% !important; height: 100% !important; border-radius: 0 !important; }
        .aia-body { grid-template-columns: minmax(0,1fr) !important; grid-template-rows: minmax(0,1fr) auto; overflow-y: auto; }
        .aia-side { border-top: 1px solid #e4e4e7; max-height: 38vh; }
        .aia-hint { display: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .aia-back, .aia-modal, .aia-rise, .aia-live, .aia-dot, .aia-magic, .aia-orbit { animation: none !important; }
      }
    `}</style>
  );
}
