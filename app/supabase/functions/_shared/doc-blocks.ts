// Clozr Docs reusable sections (the clause library, `doc_content_blocks`).
//
// A template places a section by reference, `{{block:12}}`, and the section's
// text is pasted in before variables are filled, so a clause can use the same
// `{{deal.buyer_emd|currency}}` / `[Deal.EMD]` syntax as the template around
// it. Locked sections are only ever placed by reference: the template editor
// cannot change their words, and `lockedIntact` lets anything that edits a
// document's text afterwards check that it left them alone. Editable sections
// can also be pasted as a plain copy that the template then owns.
//
// No I/O: tools/doc-blocks.test.ts covers it.

export type ContentBlock = { id: number; name: string; body: string; locked?: boolean | null; tags?: string[] | null };
export type BlockUse = { id: number; name: string; locked: boolean };

const REF = /\{\{\s*block:(\d+)\s*\}\}/g;

/** The token a template stores for a section. */
export const blockToken = (id: number) => `{{block:${id}}}`;

/** Section ids a body mentions, in order, once each. */
export const blocksIn = (body: string): number[] => Array.from(new Set(Array.from(String(body ?? '').matchAll(REF), (m) => Number(m[1]))));

/**
 * Paste every `{{block:id}}` in. A section may itself place another one (a
 * state rider inside the EMD clause); that nests up to four deep and a loop is
 * cut rather than followed. A reference to a section that no longer exists is
 * reported in `missing` and left in the text, so nothing silently drops a clause.
 */
export function expandBlocks(body: string, blocks: ContentBlock[]): { text: string; used: BlockUse[]; missing: number[] } {
  const byId = new Map(blocks.map((b) => [Number(b.id), b]));
  const used: BlockUse[] = [];
  const missing: number[] = [];
  const walk = (src: string, trail: number[]): string => src.replace(REF, (whole, raw: string) => {
    const id = Number(raw);
    const b = byId.get(id);
    if (!b) { if (!missing.includes(id)) missing.push(id); return whole; }
    if (trail.includes(id) || trail.length >= 4) return '';
    if (!used.some((u) => u.id === id)) used.push({ id, name: b.name, locked: !!b.locked });
    return walk(String(b.body ?? ''), [...trail, id]);
  });
  return { text: walk(String(body ?? ''), []), used, missing };
}

/**
 * Whether an edited document still carries every locked section word for
 * word. `expanded` is what `expandBlocks` produced before variables were
 * filled; pass the same blocks. Returns the names of locked sections that were
 * changed or removed.
 */
export function lockedIntact(edited: string, blocks: ContentBlock[], usedIds: number[]): string[] {
  const broken: string[] = [];
  for (const id of usedIds) {
    const b = blocks.find((x) => Number(x.id) === id);
    if (!b?.locked) continue;
    const inner = expandBlocks(String(b.body ?? ''), blocks).text;
    if (!String(edited ?? '').includes(inner)) broken.push(b.name);
  }
  return broken;
}

/**
 * Starter clauses for a Texas wholesaler, added from the Sections tab with
 * one button (never seeded by a migration). Plain language, filled from the
 * deal; a missing value shows up as a fill-in on the New contract form.
 */
export const STARTER_BLOCKS: Array<{ name: string; tags: string[]; locked: boolean; body: string }> = [
  {
    name: 'Earnest money',
    tags: ['emd', 'purchase'],
    locked: false,
    body: 'EARNEST MONEY. Within three (3) business days after the Effective Date, Buyer will deposit {{deal.inhouse_emd|currency}} ({{deal.inhouse_emd|words}}) as earnest money with {{title.company}}, the title company. The earnest money is applied to the purchase price at closing. If Buyer terminates during the option period, the earnest money is refunded to Buyer. If Buyer defaults after the option period, Seller may keep the earnest money as liquidated damages as Seller\'s only remedy.',
  },
  {
    name: 'Inspection and option period',
    tags: ['option', 'inspection', 'tx'],
    locked: false,
    body: 'INSPECTION AND OPTION PERIOD. Buyer and Buyer\'s inspectors, contractors, lenders and partners may enter the Property at reasonable times, with notice to Seller, to inspect it, until {{deal.option_ends|date:long}} (the "Option Period"). Seller will keep the utilities on through closing. For any reason or no reason, Buyer may terminate this agreement by written notice to Seller before the Option Period ends, and the earnest money is refunded to Buyer.',
  },
  {
    name: 'Property sold as-is',
    tags: ['as-is', 'condition'],
    locked: true,
    body: 'AS-IS. Buyer accepts the Property in its present condition, "AS IS, WHERE IS, WITH ALL FAULTS." Seller makes no warranty about the condition of the Property, its improvements, or its systems, except as stated in writing in this agreement. Seller is not required to make any repairs. Buyer relies on Buyer\'s own inspections and not on any statement by Seller or anyone acting for Seller.',
  },
  {
    name: 'Assignment',
    tags: ['assignment', 'wholesale'],
    locked: true,
    body: 'ASSIGNMENT. Buyer may assign this agreement, in whole or in part, to any person or entity without Seller\'s consent, and the assignee takes on Buyer\'s rights and duties under it. Seller understands that Buyer may be paid a fee for the assignment, that the fee may be disclosed on the settlement statement, and that Buyer is not acting as Seller\'s agent or broker. Buyer "and/or assigns" is the buyer under this agreement.',
  },
  {
    name: 'Title company and closing',
    tags: ['title', 'closing'],
    locked: false,
    body: 'TITLE AND CLOSING. {{title.company}} will act as escrow agent and issue the title commitment. Seller will convey the Property by general warranty deed, free of liens and encumbrances other than those Buyer accepts in writing. Closing will take place at {{title.company}} on or before {{deal.close_date|date:long}}, or on an earlier date both parties agree to. Seller pays for the owner\'s title policy unless the parties agree otherwise in writing; each party pays its own customary closing costs.',
  },
];
