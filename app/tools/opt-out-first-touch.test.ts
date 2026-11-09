// Who gets "Reply STOP to opt out." Run: npx tsx tools/opt-out-first-touch.test.ts
import { needsOptOutLine } from '../supabase/functions/_shared/opt-out-rule';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = got === exp;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed++;
};
const stranger = { vip: false, vetted: false, repliedBefore: false, textedBefore: false };
eq('a stranger on their first text gets it', needsOptOutLine(stranger), true);
eq('a VIP never does', needsOptOutLine({ ...stranger, vip: true }), false);
eq('a vetted buyer never does', needsOptOutLine({ ...stranger, vetted: true }), false);
eq('someone who wrote to us does not', needsOptOutLine({ ...stranger, repliedBefore: true }), false);
eq('someone we texted before does not', needsOptOutLine({ ...stranger, textedBefore: true }), false);
if (failed) { console.error(`opt-out-first-touch: ${failed} failed`); process.exit(1); }
console.log('opt-out-first-touch: ok');
