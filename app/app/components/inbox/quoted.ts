// Splitting a reply from the history quoted under it.
//
// Shared: the old Email tab renders the two halves as separate cards, and the
// Gmail one hides the quoted half behind the `•••` toggle and takes the first
// half as the list snippet. One regex, one definition of where a reply ends.

/** The new part of a reply, and the quoted history under it. */
export function splitQuoted(body: string): [string, string] {
  const m = /\n\s*(On [^\n]{4,200}wrote:|-{2,}\s*Original Message|From: [^\n]+\n(Sent|Date): )/i.exec(body) ?? /\n>/.exec(body);
  return m ? [body.slice(0, m.index).trim(), body.slice(m.index).trim()] : [body.trim(), ''];
}
