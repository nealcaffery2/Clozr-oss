// The /demo workspace's Resources: two short placeholder docs so the panel,
// the reader and Lane's citations have something to show without a database.
// They are sample content written for the demo, not anyone's real policy; the
// real TC Bible and checklists go in through Resources → Add doc or
// scripts/import-resources.ts.

export type SampleResource = {
  id: string;
  title: string;
  category: string;
  source: 'import';
  updatedAt: string;
  pinned: boolean;
  body: string;
};

export const SAMPLE_RESOURCES: SampleResource[] = [
  {
    id: 'sample-tc-bible',
    title: 'TC Bible (sample excerpt)',
    category: 'TC Bible',
    source: 'import',
    pinned: true,
    updatedAt: '2026-10-14T15:00:00.000Z',
    body: `# TC Bible (sample excerpt)

Sample content for the demo workspace. Your team's real TC Bible replaces this once it is added under Resources.

## Day 0: contract in

- Send the executed contract to title the same day it is signed, with the earnest money instructions.
- Open the TC file in CLOZR and set D0 to the contract date.
- Text the seller to introduce yourself as their point of contact through closing.

## Days 1 to 3: earnest money and title order

- Confirm title opened the file and has a file number. Put the number on the deal.
- Earnest money is due within 3 business days unless the contract says otherwise. Ask title for the receipt; a wire confirmation from the buyer is not a receipt.
- If earnest money is not receipted by day 3, call the buyer, then tell the dispo lead the same day.

## Title commitment

- Read every Schedule C requirement. Each one gets an owner and a date on the checklist.
- Liens, probate and unreleased mortgages go to the acquisitions rep the day the commitment lands.

## T-2: settlement statement

- Check the price, the assignment fee, earnest money credit, payoffs and the wire instructions line by line.
- No wire goes out until the settlement statement is approved in writing.
`,
  },
  {
    id: 'sample-title-vetting',
    title: 'Title company vetting checklist (sample)',
    category: 'Title companies',
    source: 'import',
    pinned: false,
    updatedAt: '2026-10-12T15:00:00.000Z',
    body: `# Title company vetting checklist (sample)

Sample content for the demo workspace. Replace it with your team's own vetting doc.

## Before the first file

- Confirm the company closes assignments and double closes, and ask how they fund a double close (same-day funding or a transactional lender).
- Get the escrow officer's name, direct line and email, plus a backup contact.
- Ask for their turn time on a title commitment. Five business days or less is the bar.
- Ask whether they insure wholesale deals with an unrecorded assignment, and which underwriter they use.

## Licensing and insurance

- Look the company up with the state department of insurance and confirm the license is active.
- Get a copy of the errors and omissions policy and the closing protection letter from the underwriter.

## Wire safety

- Wire instructions come by phone from a known number, never only by email.
- Ask how they verify payoff and seller wire details before funding.

## Red flags

- Will not say who the underwriter is.
- Commitment turn time over 10 business days.
- Escrow officer changes on every file.
- Pushes back on the assignment clause after the contract is signed.
`,
  },
];
