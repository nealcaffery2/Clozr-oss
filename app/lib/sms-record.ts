// A text we sent, written on the record with who sent it and the line it left from.
//
// Every send path (the record composer and bulk texts in lib/sms, the Inbox,
// the dialer's thread, the TC's reply) ends here, so one row shape carries the
// same three facts: `rep_id` is the CLOZR user who pressed send, `from_phone`
// the org line the text went out on, `talkr_user_id` Talkr's own id for the
// sender. The line-owner trigger (migration 153) only guesses a rep from the
// line; a row written here never needs the guess, and the Inbox, the record's
// Activity feed and the leaderboard all read the same answer.
//
// Keyed by Talkr's message id, so a delivery receipt or the browser mirror
// (lib/talkr-sync) updates the row rather than adding a copy.
//
// The rules (sentTextRow, fromLine, talkrUserMap) live in sms-record-rules.ts
// and are covered by tools/sms-record.test.ts; this file is the one write.

import { supabase } from './supabase';
import type { SentTextRow } from './sms-record-rules';

export { type SentMessage, type SentTextInput, type SentTextRow, fromLine, sentTextRow, talkrUserMap } from './sms-record-rules';

/**
 * Write (or refresh) the row. Failing to write must not read as a failed
 * send: the text is gone either way, so this logs and returns.
 */
export async function recordSentText(row: SentTextRow): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('communications').upsert(row, { onConflict: 'workspace_id,source,source_id' });
  if (error) console.error('text sent but not recorded on the record', error.message);
}

/** The signed-in CLOZR user, for rep_id. */
export async function signedInRep(): Promise<string | null> {
  if (!supabase) return null;
  return (await supabase.auth.getSession()).data.session?.user.id ?? null;
}
