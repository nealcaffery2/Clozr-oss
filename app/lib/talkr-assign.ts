/**
 * Talkr refuses to put a number on anyone whose seat is not `active`.
 * Adding a person in CLOZR creates that seat as `invited` until they sign in,
 * which is why "I added the whole team" still fails the buy with
 * "assigned_user_id is not an active member of this org".
 *
 * `activate` means an admin may PATCH the seat to active before the buy.
 * `disabled` is a deliberate off switch and must not be flipped here.
 */
export type AssignBlock = 'ok' | 'activate' | 'disabled' | 'missing';

export function assignmentBlock(status: string | null | undefined): AssignBlock {
  if (!status) return 'missing';
  if (status === 'disabled') return 'disabled';
  if (status === 'active') return 'ok';
  return 'activate';
}
