// Which COMPR report the record's Underwrite opens.
// Run: npx tsx tools/compr-embed.test.ts
import assert from 'node:assert/strict';
import { comprLeadIdOfDeal } from '../lib/compr-embed';

assert.equal(comprLeadIdOfDeal(undefined), null);
assert.equal(comprLeadIdOfDeal({ underwritingUrl: 'https://thecompr.com/r/lead-1' }), 'lead-1');
assert.equal(
  comprLeadIdOfDeal({ underwritingUrl: 'https://docs.google.com/spreadsheets/d/x/edit', comprReportUrl: 'https://thecompr.com/r/sub%202' }),
  'sub 2', 'a Podio "Ai Compr Tool" link opens the report when the analysis link is a sheet',
);
assert.equal(
  comprLeadIdOfDeal({ underwritingUrl: null, heroUrl: 'https://thecompr.com/api/photo?lead_id=from-photo&pos=0&token=t' }),
  'from-photo', 'a deal COMPR filled with photos still knows its report',
);
assert.equal(comprLeadIdOfDeal({ photos: ['https://cdn.example/a.jpg', 'https://thecompr.ai/api/photo?pos=1&lead_id=p2'] }), 'p2');
assert.equal(comprLeadIdOfDeal({ underwritingUrl: 'https://buybox-ai.com/deal/9', photos: ['https://cdn.example/a.jpg'] }), null, 'never run: COMPR opens on search');
assert.equal(
  comprLeadIdOfDeal({ underwritingUrl: 'https://thecompr.com/r/1105-pecan-ave-greenville-tx-75401-clozr-w11-d4256-2026-10-07' }),
  'clozr-w11-d4256-2026-10-07', 'a share link with the address in front opens the report, not "Failed to load"',
);
console.log('compr-embed ok');
