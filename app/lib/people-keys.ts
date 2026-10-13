// Keyboard movement on People: up/down (and left/right) walk the open list,
// alt+up/down jumps smart lists, and ctrl+left/right steps the focused row's
// stage. Plain arrows never leave the list, so checked rows stay checked.
// On an open person record the same chords still run. The record has no
// smart-list column, so up/down walks to the previous or next person in
// the active list, the same as left/right. Ctrl+left/right steps that
// record's stage. Typing and open chrome (dialogs, the photo slideshow,
// quick compose) keep the keys.

/** Wrap an index inside a list. An empty list stays at 0. */
export function stepIndex(index: number, length: number, dir: 1 | -1): number {
  if (length <= 0) return 0;
  const i = Number.isFinite(index) ? index : 0;
  return (i + dir + length) % length;
}

/** The next label in a named list. A label that is not in the list enters from the end you came from. */
export function stepLabel(current: string, labels: string[], dir: 1 | -1): string {
  if (!labels.length) return current;
  const i = labels.indexOf(current);
  if (i < 0) return dir > 0 ? labels[0] : labels[labels.length - 1];
  return labels[stepIndex(i, labels.length, dir)];
}

/** Demo stages, in the order a rep walks them. Live stages use SELLER_STAGE_LABELS. */
export const DEMO_STAGE_ORDER = [
  'New Lead', 'Contacted', 'Qualified', 'Appointment', 'Offer Sent', 'Negotiation',
  'Under Contract', 'Dispo', 'Assigned', 'Closing', 'Closed', 'Lost',
];

/**
 * The stage one step earlier or later. Null at either end, or when the
 * current stage is on neither list.
 */
/** Filler rows. Ctrl+arrow and Likely next never stop on these. Memo is not a stage. */
const NOT_A_STEP = new Set([
  'Pending Response', 'Offer Made - Follow Up', 'Offer Made - Retail', 'Pending Inspections',
  'Contract Sent to Seller', 'Memo Filed / Legal',
]);

export function adjacentStage(stage: string, dir: 1 | -1, liveLabels: readonly string[]): string | null {
  const list = liveLabels.includes(stage) ? liveLabels : DEMO_STAGE_ORDER.includes(stage) ? DEMO_STAGE_ORDER : null;
  if (!list) return null;
  const i = list.indexOf(stage);
  let n = i + dir;
  while (n >= 0 && n < list.length && NOT_A_STEP.has(list[n])) n += dir;
  if (n < 0 || n >= list.length) return null;
  return list[n];
}

export type PeopleNavSurface = 'list' | 'record';

export type PeopleNavAction =
  | { type: 'in-list'; dir: 1 | -1 }
  | { type: 'smart-list'; dir: 1 | -1 }
  | { type: 'stage'; dir: 1 | -1 };

export type PeopleKeyEvent = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented?: boolean;
};

/** True when the key landed in a field, so arrows must keep editing. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

/** People list: ignore arrows while a field, a dialog, or a list tool is up. */
export function listNavBlocked(b: {
  vendorList?: boolean;
  typing?: boolean;
  dialogOrMenu?: boolean;
  smartListOpen?: boolean;
  searchOpen?: boolean;
  colsOpen?: boolean;
  filterOpen?: boolean;
}): boolean {
  return !!(b.vendorList || b.typing || b.dialogOrMenu || b.smartListOpen || b.searchOpen || b.colsOpen || b.filterOpen);
}

/**
 * Open record: ignore arrows while typing, while a sheet/menu/dialog is up,
 * and while the photo slideshow or quick compose owns left/right.
 */
export function recordNavBlocked(b: {
  onRecord?: boolean;
  typing?: boolean;
  dialogOrMenu?: boolean;
  offerOpen?: boolean;
  addOpen?: boolean;
  searchOpen?: boolean;
  phoneUp?: boolean;
  detailsOpen?: boolean;
  photoShow?: boolean;
  quickReach?: boolean;
  inDialer?: boolean;
}): boolean {
  return !b.onRecord || !!(b.typing || b.dialogOrMenu || b.offerOpen || b.addOpen
    || b.searchOpen || b.phoneUp || b.detailsOpen || b.photoShow || b.quickReach || b.inDialer);
}

/**
 * Which way an arrow key moves.
 * List: every plain arrow walks rows, alt+up/down jumps smart lists,
 * ctrl+left/right steps stage.
 * Record: every plain arrow walks to the previous or next person in the active
 * list. Ctrl+left/right still steps stage. Anything else is null.
 */
export function peopleNavAction(e: PeopleKeyEvent, surface: PeopleNavSurface, blocked = false): PeopleNavAction | null {
  if (blocked || e.defaultPrevented || e.metaKey) return null;
  const horizontal = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
  const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
  if (!horizontal && !vertical) return null;
  const dir: 1 | -1 = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  if (e.altKey) return surface === 'list' && vertical && !e.ctrlKey ? { type: 'smart-list', dir } : null;
  if (e.ctrlKey && !horizontal) return null;
  if (e.ctrlKey) return { type: 'stage', dir };
  return { type: 'in-list', dir };
}

/**
 * Buyers list / record: left/right walks buyers in the active list, up/down
 * jumps prospect lists (Buyers · Compr · Buyer Prospects · Capital Raise).
 * Same chords on the open buyer record. No stage chords — buyers do not have
 * the seller stage rail.
 */
export type BuyersNavAction =
  | { type: 'in-list'; dir: 1 | -1 }
  | { type: 'list'; dir: 1 | -1 };

export function buyersNavAction(e: PeopleKeyEvent, blocked = false): BuyersNavAction | null {
  if (blocked || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return null;
  const horizontal = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
  const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
  if (!horizontal && !vertical) return null;
  const dir: 1 | -1 = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  return horizontal ? { type: 'in-list', dir } : { type: 'list', dir };
}

/**
 * The id one step from the open record inside the active list.
 * A record that is not on the list enters from the end you came from.
 * An empty list returns null. A one-person list stays on that person.
 */
export function adjacentRecordId(ids: readonly string[], openId: string | null | undefined, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = openId ? ids.indexOf(openId) : -1;
  if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[stepIndex(i, ids.length, dir)];
}

/** The house a submission row stands for: 'sub:d12~4567' (a resubmission) is 'sub:d12'. */
export function submissionRowKey(id: string): string {
  return id.startsWith('sub:') ? id.split('~')[0] : id;
}

/**
 * The open record's row on the active list. A submission row opens its seller
 * pinned to that house (personDealId), so on a submission list the row is
 * 'sub:<deal>', never the seller's own id.
 */
export function openRowId(ids: readonly string[], personId: string | null | undefined, personDealId: string | null | undefined): string | null {
  if (personDealId) {
    const hit = ids.find((id) => submissionRowKey(id) === 'sub:' + personDealId);
    if (hit) return hit;
  }
  return personId ?? null;
}

/**
 * The row one step from the open record, skipping rows that would reopen the
 * same house (a resubmission's repeat row). Null when there is nowhere else to go.
 */
export function adjacentOpenRow(ids: readonly string[], here: string | null | undefined, dir: 1 | -1): string | null {
  const same = (id: string) => id === here || (!!here && here.startsWith('sub:') && submissionRowKey(id) === submissionRowKey(here));
  let next = adjacentRecordId(ids, here, dir);
  for (let n = 0; next && same(next) && n < ids.length; n++) next = adjacentRecordId(ids, next, dir);
  return next && !same(next) ? next : null;
}

/**
 * Ctrl+A (⌘A on a Mac) archives on Buyers: the checked rows, else the focused
 * row, or the open record. Never while typing, where it still selects the
 * text, and never with Shift or Alt. People uses isArchiveKey instead.
 */
export function isArchiveChord(e: PeopleKeyEvent & { shiftKey?: boolean; code?: string }, blocked = false): boolean {
  if (blocked || e.defaultPrevented || e.altKey || e.shiftKey) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  return e.code === 'KeyA' || e.key.toLowerCase() === 'a';
}

/**
 * Ctrl+A (⌘A on a Mac) on the People list selects every row in the list, the
 * way it does in any table. Never while typing, where it selects the text.
 */
export function isSelectAllChord(e: PeopleKeyEvent & { shiftKey?: boolean; code?: string }, blocked = false): boolean {
  return isArchiveChord(e, blocked);
}

/**
 * Shift+Delete (Shift+Backspace on a Mac keyboard) archives on People and the
 * seller record: the checked rows, else the focused row, or the open record,
 * always after the Yes/No prompt. Two keys on purpose, so a stray Delete or a
 * select-all never starts it. Never while typing.
 */
export function isArchiveKey(e: PeopleKeyEvent & { shiftKey?: boolean }, blocked = false): boolean {
  if (blocked || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !e.shiftKey) return false;
  return e.key === 'Delete' || e.key === 'Backspace';
}

/** Enter on a list opens the focused row. */
export function isOpenKey(e: PeopleKeyEvent & { shiftKey?: boolean }, blocked = false): boolean {
  return !blocked && !e.defaultPrevented && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'Enter';
}

export type ConfirmChoice = 'no' | 'yes';

/**
 * The archive prompt's keys. No sits on the left and is picked first, so an
 * Enter typed by habit does nothing harmful. Left/right (and Tab) move between
 * No and Yes, Enter answers with the one picked, Y and N answer directly,
 * Escape is No. Anything else is null: the prompt ignores it.
 */
export function confirmKey(key: string, current: ConfirmChoice): { pick: ConfirmChoice } | { answer: ConfirmChoice } | null {
  if (key === 'ArrowLeft') return { pick: 'no' };
  if (key === 'ArrowRight') return { pick: 'yes' };
  if (key === 'Tab') return { pick: current === 'no' ? 'yes' : 'no' };
  if (key === 'Enter') return { answer: current };
  if (key === 'Escape') return { answer: 'no' };
  const k = key.toLowerCase();
  if (k === 'y') return { answer: 'yes' };
  if (k === 'n') return { answer: 'no' };
  return null;
}
