// Edit on a pending scheduled email (the record's timeline, the Inbox):
// the row is cancelled and its words are handed to the next EmailCompose
// that mounts, which reads them once. A module-level slot, like
// composerStore holds the text box, so no store or context is needed.

import type { OutgoingFile } from '@/lib/google';

export type EmailEdit = { subject: string; html: string; cc: string | null; bcc: string | null; attachments: OutgoingFile[] };

let slot: EmailEdit | null = null;

export function handEmailEdit(e: EmailEdit) { slot = e; }
export function takeEmailEdit(): EmailEdit | null { const e = slot; slot = null; return e; }
