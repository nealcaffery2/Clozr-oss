// Drafts kept per conversation. Run: npx tsx tools/compose-drafts.test.ts
import { clearDraft, draftFor, keepDraft, restoreDraft, withRestored } from '../lib/compose-drafts';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// Kara's draft stays Kara's: Ronald's thread opens empty.
keepDraft('sms:kara', { text: 'Hi Kara, still selling 12 Elm?' });
eq('own draft', draftFor('sms:kara').text, 'Hi Kara, still selling 12 Elm?');
eq('another thread starts empty', draftFor('sms:ronald').text, '');
keepDraft('sms:ronald', { text: 'Ronald, quick one' });
eq('switching back finds it', draftFor('sms:kara').text, 'Hi Kara, still selling 12 Elm?');
eq('and the other keeps its own', draftFor('sms:ronald').text, 'Ronald, quick one');

// An emptied box forgets the key.
keepDraft('sms:kara', { text: '' });
eq('emptied', draftFor('sms:kara'), { text: '', subject: '' });

// Record composer and the docked quick box never share.
keepDraft('record:p1', { text: 'note for Ann' });
keepDraft('quick:text:p1', { text: 'text for Ann' });
eq('record box', draftFor('record:p1').text, 'note for Ann');
eq('quick box', draftFor('quick:text:p1').text, 'text for Ann');
clearDraft('quick:text:p1');
eq('cleared after a send', draftFor('quick:text:p1').text, '');
eq('record untouched', draftFor('record:p1').text, 'note for Ann');

// A failed send puts its text back.
eq('empty box takes it', withRestored('', 'Offer is $90k'), 'Offer is $90k');
eq('typed since: both kept', withRestored('next thought', 'Offer is $90k'), 'Offer is $90k\n\nnext thought');
eq('already there', withRestored('Offer is $90k', 'Offer is $90k'), 'Offer is $90k');
eq('nothing to restore', withRestored('abc', '  '), 'abc');
eq('restore into the store', restoreDraft('record:p2', 'Call me back', 'Re: 12 Elm'), 'Call me back');
eq('subject comes back too', draftFor('record:p2'), { text: 'Call me back', subject: 'Re: 12 Elm' });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
