// Example call playbook: a seed for Settings > Talkr > Scripts > "Import
// example playbook", which writes these rows to the workspace's scripts table
// (mode `skip`, so a re-run never overwrites an edited script). The dialer falls
// back to this file only where there is no table to read (the /demo sample
// workspace), so the sample call still has a script to show. Replace with your
// own scripts.
//
// Bodies are light markdown: `## ` sections, one spoken line per paragraph,
// `- If <condition>: <line>` bullets are branches, `> ` is a note to the rep.
// `{field}` tokens fill from the record on the line (lib/script-doc.ts).

import type { ScriptInput } from './talkr-web/api';

export type PlaybookScript = ScriptInput & { category: string; tags: string[]; contact_types: string[] };

const seller = (title: string, category: string, tags: string[], body: string): PlaybookScript => ({
  kind: 'script', title, category, tags, contact_types: ['seller'], body: body.trim(),
});
const buyer = (title: string, category: string, tags: string[], body: string): PlaybookScript => ({
  kind: 'script', title, category, tags, contact_types: ['buyer'], body: body.trim(),
});
const rebuttal = (title: string, category: string, tags: string[], body: string, contact: 'seller' | 'buyer' = 'seller'): PlaybookScript => ({
  kind: 'rebuttal', title, category, tags, contact_types: [contact], body: body.trim(),
});

export const EXAMPLE_SCRIPTS: readonly PlaybookScript[] = [
  seller('Example seller script', 'Seller', ['example', 'outbound', 'inbound'], `
## Intro
"Hi {first_name}, this is {rep_first_name}. I'm calling about your property on {address}. Is now a good time?"
- If yes: "Thanks. I'll be quick."
- If no: "No problem. When is a better time to call back?"

## Price
"What price did you have in mind for the property?"
> Last known asking: {asking}

## Next step
"Based on what you told me, can I send you a written offer to look over?"
`),
  rebuttal('Need to think about it', 'Timing', ['think about it', 'not sure'], `
"That makes sense. What part would you want to think through? I can answer it now so you have everything you need."
`),
];
