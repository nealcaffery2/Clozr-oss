// Quick Add's drafts. Putting the dialog away (Escape, the ×, Cancel, a click
// outside it) keeps what was typed, one draft per kind of record, and opening
// that kind again brings it back — until it is saved or cleared with Clear.
// A failed save keeps it too. Nothing typed into Quick Add is lost to a
// stray key.
//
// A draft remembers the seed it was opened with (the record it was for), so
// opening the same kind from another record starts that record's form rather
// than showing the other one's; opening it from nowhere (the Quick Add menu,
// ⌘K's Create) brings back whichever draft is waiting.
//
// Pure: no React, no state. tools/quick-add-draft.test.ts runs it.

export type AddDraft = { seed: Record<string, string>; form: Record<string, string> };
export type AddDrafts = Partial<Record<string, AddDraft>>;

/** The kinds a dialog opens on one record (its address, a co-seller on its property): only ever restored on that record. */
const HOSTED = new Set(['address', 'coseller']);

/** Whether anything in the form was typed: a field that is not blank and not just what it was opened with. */
export function hasTyped(seed: Record<string, string>, form: Record<string, string>): boolean {
  return Object.entries(form).some(([k, v]) => (v ?? '').trim() !== '' && v !== seed[k]);
}

const sameSeed = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? '') === (b[k] ?? ''));
};

/** The drafts once this form is put away: kept when something was typed, else dropped. */
export function keepDraft(drafts: AddDrafts, kind: string, seed: Record<string, string>, form: Record<string, string>): AddDrafts {
  if (!hasTyped(seed, form)) return dropDraft(drafts, kind);
  return { ...drafts, [kind]: { seed, form } };
}

/** The drafts without this kind's (it was saved, or cleared). */
export function dropDraft(drafts: AddDrafts, kind: string): AddDrafts {
  if (!drafts[kind]) return drafts;
  const next = { ...drafts };
  delete next[kind];
  return next;
}

/** The draft to open this kind on, when one is waiting and belongs here; null opens the seed. */
export function draftFor(drafts: AddDrafts, kind: string, seed: Record<string, string>): AddDraft | null {
  const d = drafts[kind];
  if (!d) return null;
  if (sameSeed(d.seed, seed)) return d;
  return !HOSTED.has(kind) && !Object.keys(seed).length ? d : null;
}
