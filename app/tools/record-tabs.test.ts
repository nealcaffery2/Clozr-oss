// The seller record's tab row. Run: npx tsx tools/record-tabs.test.ts
import {
  HISTORY_TYPES, TAB_TO_SECTION, isAutomationRow, recordTabs, resolveRecordTab, stepTab, tabOf,
} from '../app/components/record/record-tabs';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const full = recordTabs(true).map((t) => t.label);
eq('the row, with a submission', full, ['Activity', 'Calls', 'Texts', 'Email', 'Notes', 'Automations', 'History', 'Details', 'Submission']);
eq('no submission, no Submission tab', recordTabs(false).map((t) => t.key).includes('Submission'), false);
eq('Email is the Emails filter', recordTabs(false).find((t) => t.label === 'Email')?.key, 'Emails');

eq('a current name lands as is', resolveRecordTab('Texts', false), 'Texts');
eq('History lands', resolveRecordTab('History', false), 'History');
eq('Submission lands when there is one', resolveRecordTab('Submission', true), 'Submission');
eq('Submission without one lands on Details', resolveRecordTab('Submission', false), 'Details');
eq('Communications was the whole feed', resolveRecordTab('Communications', false), 'Activity');
eq('the old AI tab listed calls', resolveRecordTab('AI', false), 'Calls');
eq('All chip name', resolveRecordTab('All', false), 'Activity');
eq('Email label', resolveRecordTab('Email', false), 'Emails');
eq('action plans live in Automations', resolveRecordTab('Action plans', false), 'Automations');
eq('What we know lives in Details', resolveRecordTab('What we know', true), 'Details');
eq('unknown name lands on Activity', resolveRecordTab('Something else', true), 'Activity');
eq('empty lands on Activity', resolveRecordTab('', false), 'Activity');
eq('null lands on Activity', resolveRecordTab(null, false), 'Activity');
eq('TC opens the closing section', TAB_TO_SECTION.TC, 'closing');
eq('Files & Links opens files', TAB_TO_SECTION['Files & Links'], 'files');
eq('TC is not a tab, so the row shows Activity', resolveRecordTab('TC', false), 'Activity');

const keys = recordTabs(true).map((t) => t.key);
eq('right moves one', stepTab(keys, 'Activity', 'ArrowRight'), 'Calls');
eq('right wraps', stepTab(keys, 'Submission', 'ArrowRight'), 'Activity');
eq('left wraps', stepTab(keys, 'Activity', 'ArrowLeft'), 'Submission');
eq('home', stepTab(keys, 'Notes', 'Home'), 'Activity');
eq('end', stepTab(keys, 'Notes', 'End'), 'Submission');
eq('other keys are not the row', stepTab(keys, 'Notes', 'ArrowDown'), null);
eq('a tab not in the row steps from the start', stepTab(recordTabs(false).map((t) => t.key), 'Submission', 'ArrowRight'), 'Calls');
eq('empty row', stepTab([], 'Activity', 'ArrowRight'), null);

eq('feeds take the composer', tabOf('Notes').composer, true);
eq('automations stream without the composer', [tabOf('Automations').stream, tabOf('Automations').composer], [true, false]);
eq('details is not a stream', tabOf('Details').stream, false);

eq('a plan step is an automation', isAutomationRow({ type: 'task' }), true);
eq('an AI agent run is an automation', isAutomationRow({ type: 'ai_agent' }), true);
eq('a text an agent sent is an automation', isAutomationRow({ type: 'sms_out', agent: { key: 'riley' } }), true);
eq('a rep text is not', isAutomationRow({ type: 'sms_out' }), false);
eq('stage moves are history', HISTORY_TYPES.has('stage'), true);
eq('offers are history', HISTORY_TYPES.has('offer'), true);
eq('calls are not history', HISTORY_TYPES.has('call'), false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
