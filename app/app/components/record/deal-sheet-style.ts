// The Deal sheet button looks the same everywhere: big, solid blue, white
// text, so it is the first thing the eye finds on a record, a deal card or a
// deal row. Callers spread it and only override size where space is tight.
import type React from 'react';

export const DEAL_SHEET_BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  height: '38px', padding: '0 18px', borderRadius: '9px',
  border: '1px solid #1d4ed8', background: '#2563eb', color: '#fff',
  fontSize: '14px', fontWeight: 700, letterSpacing: 0, textTransform: 'none',
  whiteSpace: 'nowrap', cursor: 'pointer', flex: 'none',
  boxShadow: '0 1px 2px rgba(29,78,216,.25), 0 4px 10px -4px rgba(37,99,235,.45)',
};
