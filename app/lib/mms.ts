// What a text can carry as an MMS attachment, and how a picked file is judged.
//
// One set of limits for every SMS composer: the inbox thread (MessagesScreen)
// and the dialer's text card (DialerTexts) both read these, so a file one box
// accepts is a file the other accepts too. Pure, so it is tested
// (tools/mms.test.ts); the upload itself is app/components/talkr/MmsAttachments.

export type AttachmentKind = 'image' | 'video' | 'file';

/** Carrier MMS ceiling is ~5 MB per message; 3 MB per file matches Talkr's upload API. */
export const MMS_MAX_BYTES = 3 * 1024 * 1024;
/** Talkr takes up to 10 media URLs on one message. */
export const MMS_MAX_FILES = 10;
/** Phone photos are 3–12 MB; carriers downscale anyway, so images shrink client-side to this edge. */
export const MMS_IMAGE_MAX_EDGE = 1600;
/** The file picker's accept list: photos, short video, PDF and contact cards. */
export const MMS_ACCEPT = 'image/*,video/mp4,video/3gpp,application/pdf,text/vcard';

export function kindFromType(contentType: string): AttachmentKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Inbound carrier URLs carry no extension and are always images in practice,
 * so only a telling extension moves a URL off the image path.
 */
export function kindFromUrl(url: string): AttachmentKind {
  const path = url.split('?')[0]!.toLowerCase();
  if (/\.(mp4|3gp|3gpp|mov|m4v)$/.test(path)) return 'video';
  if (/\.(pdf|vcf|txt|csv|docx?|xlsx?)$/.test(path)) return 'file';
  return 'image';
}

/** True when the picker's accept list covers this content type. */
export function mmsAccepts(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return MMS_ACCEPT.split(',').some((a) => (a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : t === a));
}

/**
 * Why a file cannot go on this text, or null when it can. `size` is the size
 * that would be uploaded (after an image is shrunk); `pending` is how many are
 * already on the message.
 */
export function mmsRefusal(file: { name: string; type: string; size: number }, pending = 0): string | null {
  if (pending >= MMS_MAX_FILES) return `A text holds ${MMS_MAX_FILES} attachments at most.`;
  if (!mmsAccepts(file.type || '')) return `${file.name} can't go by text. Send a photo, a short MP4 video, a PDF or a contact card.`;
  if (file.size > MMS_MAX_BYTES) return `${file.name} is over 3 MB. Carriers reject larger MMS attachments.`;
  return null;
}

/**
 * The body of the copy filed on the CLOZR record. The communications row has
 * no media column, so an attachment is named under the text; the timeline then
 * says a photo went, and where it lives.
 */
export function recordBody(text: string, mediaUrls: readonly string[] = []): string {
  if (!mediaUrls.length) return text;
  const lines = mediaUrls.map((u) => `Attachment: ${u}`);
  return [text.trim(), ...lines].filter(Boolean).join('\n');
}
