// What a filed attachment is labelled.  Run:  deno run supabase/functions/_shared/deal-docs.test.ts
import { classifyDoc, isJunkAttachment } from './deal-docs.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

eq('commitment by name', classifyDoc('Title_Commitment_611 Dorie St.pdf'), 'title_commitment');
eq('prelim', classifyDoc('Prelim Report - 1716 Ashby.pdf'), 'title_commitment');
eq('T-47 is the survey affidavit', classifyDoc('T-47 affidavit.pdf'), 'survey');
eq('commitment from the subject', classifyDoc('24-1188.pdf', 'Title Commitment - 3992 Orchard Farms Rd'), 'title_commitment');
eq('CD', classifyDoc('Closing Disclosure FINAL.pdf'), 'closing_disclosure');
eq('HUD', classifyDoc('HUD-1 235 Daybreak Dr.pdf'), 'settlement_statement');
eq('ALTA SS', classifyDoc('ALTA Settlement Statement.pdf'), 'settlement_statement');
eq('wire', classifyDoc('Wire Instructions.pdf'), 'wire_instructions');
eq('EMD receipt', classifyDoc('EMD Receipt.pdf'), 'emd_receipt');
eq('assignment', classifyDoc('Assignment of Contract - signed.pdf'), 'assignment');
eq('PSA', classifyDoc('Executed PSA.pdf'), 'purchase_agreement');
eq('A-B contract is the purchase agreement', classifyDoc('1206 Harbor Blvd - AB Contract.pdf'), 'purchase_agreement');
eq('B-C contract is the assignment', classifyDoc('1206 Harbor Blvd - BC Contract.pdf'), 'assignment');
eq('a file just called a contract', classifyDoc('Signed contract 600 Dell Ave.pdf'), 'purchase_agreement');
eq('addendum', classifyDoc('Addendum 2 price change.pdf'), 'addendum');
eq('payoff', classifyDoc('Payoff statement.pdf'), 'payoff');
eq('unknown pdf', classifyDoc('scan0001.pdf', 'Hello'), 'other');
eq('photo', classifyDoc('IMG_2231.jpg', '', 'image/jpeg'), 'photos');

eq('signature logo is junk', isJunkAttachment('image001.png', 'image/png', 9_000, true), true);
eq('small image is junk', isJunkAttachment('logo.jpg', 'image/jpeg', 20_000, false), true);
eq('calendar invite is junk', isJunkAttachment('invite.ics', 'text/calendar', 2_000, false), true);
eq('a pdf is kept', isJunkAttachment('Commitment.pdf', 'application/pdf', 240_000, false), false);
eq('a real photo is kept', isJunkAttachment('kitchen.jpg', 'image/jpeg', 900_000, false), false);

if (failed) { console.log(`${failed} failed`); Deno.exit(1); }
console.log('deal-docs: all passed');
