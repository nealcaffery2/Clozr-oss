// RVM pool rotation: when a line leaves the pool, and whether a replacement is bought (lib/rvm-rotation.ts).
// Run: npx tsx tools/rvm-rotation.test.ts
import {
  capMonth, lineVerdict, reasonsSentence, replaceDecision, replaceSettings, replacementAreaCodes, rotationPolicy,
} from '../lib/rvm-rotation';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const line = { phone_e164: '+18035550900', market_state: 'SC' };

// ---- verdicts
eq('a healthy line stays', lineVerdict(line, { grade: 'good', spam_risk: 'low', attestation_a_7d: 0.98, attestation_calls_7d: 120 }), []);
eq('no health row and no flags stays', lineVerdict(line, null), []);
eq('carrier spam label high retires', lineVerdict({ ...line, spam_risk: 'high' }, { spam_risk: 'low' }), ['spam_label']);
eq('Talkr spam label high retires', lineVerdict(line, { spam_risk: 'HIGH' }), ['spam_label']);
eq('medium stays by default', lineVerdict({ ...line, spam_risk: 'medium' }, null), []);
eq('medium retires when the workspace says so', lineVerdict({ ...line, spam_risk: 'medium' }, null, rotationPolicy({ replace: { retire_on: 'medium' } }, null)), ['spam_label']);
eq('at risk grade retires', lineVerdict(line, { grade: 'at_risk' }), ['reputation']);
eq('paused by the guard retires', lineVerdict(line, { paused: true }), ['reputation']);
eq('registry refusal retires', lineVerdict({ ...line, fcr_status: 'failed' }, null), ['registry']);
eq('poor attestation over 20 calls retires', lineVerdict(line, { attestation_a_7d: 0.6, attestation_calls_7d: 40 }), ['attestation']);
eq('poor attestation on a handful of calls does not', lineVerdict(line, { attestation_a_7d: 0.2, attestation_calls_7d: 5 }), []);
eq('the guard floor is the workspace one', lineVerdict(line, { attestation_a_7d: '0.85', attestation_calls_7d: 40 }, rotationPolicy(null, { min_attestation_a: 0.8 })), []);
eq('several reasons at once', lineVerdict({ ...line, spam_risk: 'high', fcr_status: 'failed' }, { grade: 'at_risk' }), ['spam_label', 'reputation', 'registry']);
eq('a retired line is not judged again', lineVerdict({ ...line, spam_risk: 'high', retired_at: '2026-10-01T00:00:00Z' }, null), []);
eq('sentence', reasonsSentence(['spam_label', 'attestation']), 'carriers label it spam; too few of its calls are signed A (STIR/SHAKEN)');

// ---- buying
eq('default is off with no cap', replaceSettings(null), { mode: 'off', monthlyCap: 0 });
eq('settings read', replaceSettings({ replace: { mode: 'approve', monthly_cap: 4 } }), { mode: 'approve', monthlyCap: 4 });
eq('a silly cap is held to 50', replaceSettings({ replace: { mode: 'auto', monthly_cap: 900 } }).monthlyCap, 50);
eq('an unknown mode is off', replaceSettings({ replace: { mode: 'yes' as never, monthly_cap: 4 } }).mode, 'off');
eq('off never buys', replaceDecision({ mode: 'off', monthlyCap: 10 }, 0), { action: 'skip', why: 'off' });
eq('approve asks', replaceDecision({ mode: 'approve', monthlyCap: 2 }, 1), { action: 'request' });
eq('auto buys under the cap', replaceDecision({ mode: 'auto', monthlyCap: 2 }, 1), { action: 'buy' });
eq('auto stops at the cap', replaceDecision({ mode: 'auto', monthlyCap: 2 }, 2), { action: 'skip', why: 'cap' });
eq('a zero cap means none, even on auto', replaceDecision({ mode: 'auto', monthlyCap: 0 }, 0), { action: 'skip', why: 'cap' });

// ---- local replacement
const codes = replacementAreaCodes(line);
eq('own area code first, then the rest of SC', [codes[0], codes.includes('864'), codes.includes('404')], ['803', true, false]);
eq('no market state uses the area code\'s state', replacementAreaCodes({ phone_e164: '+12105550161', market_state: null })[0], '210');
eq('TX line stays in TX', replacementAreaCodes({ phone_e164: '+12105550161', market_state: null }).every((c) => ['210', '214', '254', '281', '325', '346', '361', '409', '430', '432', '469', '512', '682', '713', '726', '737', '806', '817', '830', '832', '903', '915', '936', '940', '945', '956', '972', '979'].includes(c)), true);

// ---- the cap month is Central's
eq('11pm Central on Oct 31 is still October', capMonth(new Date('2026-11-01T04:00:00Z')), '2026-10');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
