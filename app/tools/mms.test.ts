// MMS limits, the record copy of a text with attachments, and textOne passing
// media through to Talkr. Run: npx tsx tools/mms.test.ts
import assert from 'node:assert/strict';
import { MMS_MAX_BYTES, MMS_MAX_FILES, kindFromType, kindFromUrl, mmsAccepts, mmsRefusal, recordBody } from '../lib/mms';
import { textOne } from '../lib/sms';
import { talkr } from '../lib/talkr';
import { supabase } from '../lib/supabase';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  try { assert.deepEqual(got, want); console.log('ok  ', name); } catch { failed++; console.log('FAIL', name, '\n  got ', got, '\n  want', want); }
};

// ---- kinds ----
eq('image type', kindFromType('image/png'), 'image');
eq('video type', kindFromType('video/mp4'), 'video');
eq('pdf type is a file', kindFromType('application/pdf'), 'file');
eq('carrier url with no extension reads as an image', kindFromUrl('https://media.example/abc123?sig=1'), 'image');
eq('a .pdf url is a file', kindFromUrl('https://x.test/offer.PDF?x=1'), 'file');
eq('a .mp4 url is a video', kindFromUrl('https://x.test/clip.mp4'), 'video');

// ---- what can go ----
eq('jpeg accepted', mmsAccepts('image/jpeg'), true);
eq('pdf accepted', mmsAccepts('application/pdf'), true);
eq('vcard accepted', mmsAccepts('text/vcard'), true);
eq('zip refused', mmsAccepts('application/zip'), false);
eq('quicktime refused (carriers want mp4/3gpp)', mmsAccepts('video/quicktime'), false);
eq('a small photo goes', mmsRefusal({ name: 'a.jpg', type: 'image/jpeg', size: 200_000 }), null);
eq('a PDF at the limit goes', mmsRefusal({ name: 'offer.pdf', type: 'application/pdf', size: MMS_MAX_BYTES }), null);
eq('over 3 MB is refused with the reason',
  mmsRefusal({ name: 'big.pdf', type: 'application/pdf', size: MMS_MAX_BYTES + 1 }),
  'big.pdf is over 3 MB. Carriers reject larger MMS attachments.');
eq('a type carriers do not take is refused', /can't go by text/.test(mmsRefusal({ name: 'a.zip', type: 'application/zip', size: 10 }) ?? ''), true);
eq('the eleventh file is refused', /10 attachments/.test(mmsRefusal({ name: 'a.jpg', type: 'image/jpeg', size: 10 }, MMS_MAX_FILES) ?? ''), true);

// ---- the record copy ----
eq('no media: the text as sent', recordBody('Hi Kara'), 'Hi Kara');
eq('media named under the text', recordBody('Hi Kara', ['https://m/1.jpg']), 'Hi Kara\nAttachment: https://m/1.jpg');
eq('photo only: just the attachment lines', recordBody('  ', ['https://m/1.jpg', 'https://m/2.pdf']), 'Attachment: https://m/1.jpg\nAttachment: https://m/2.pdf');

// ---- textOne hands media to Talkr, and leaves it off when there is none ----
// No network: the record copy is captured here instead of written to the project.
const filed: Record<string, unknown>[] = [];
const sb = supabase as unknown as { from: unknown; auth: { getSession: unknown } };
const realFrom = sb.from;
const realSession = sb.auth.getSession;
sb.from = () => ({ insert: async (row: Record<string, unknown>) => { filed.push(row); return { error: null }; } });
sb.auth.getSession = async () => ({ data: { session: null }, error: null });
const realSend = talkr.sendMessage;
const calls: unknown[] = [];
talkr.sendMessage = (async (input: unknown) => {
  calls.push(input);
  return { message: { id: 'm1', status: 'queued' }, conversation_id: 'c1' };
}) as unknown as typeof talkr.sendMessage;
const clear = { ok: true as const, blocked: { sellers: new Set<number>(), buyers: new Set<number>() } };
const kara = { sellerId: 1, name: 'Kara Mitchell', phone: '(210) 555-0136' };
const withMedia = await textOne(5, kara, 'Hi {{first_name}}, the photo', { fromPhoneNumberId: null, mediaUrls: ['https://m/1.jpg'] }, clear);
eq('a text with a photo is queued', withMedia.status, 'queued');
eq('media_urls reach Talkr, merge fields filled', calls[0], { to_number: '+12105550136', body: 'Hi Kara, the photo', media_urls: ['https://m/1.jpg'] });
await textOne(5, kara, 'No photo', { fromPhoneNumberId: null }, clear);
eq('no media_urls key without attachments', calls[1], { to_number: '+12105550136', body: 'No photo' });
await textOne(5, kara, '', { fromPhoneNumberId: null, mediaUrls: ['https://m/2.jpg'] }, clear);
eq('a photo with no caption still sends', calls[2], { to_number: '+12105550136', body: '', media_urls: ['https://m/2.jpg'] });
const blocked = await textOne(5, kara, 'x', { mediaUrls: ['https://m/3.jpg'] }, { ok: true, blocked: { sellers: new Set([1]), buyers: new Set() } });
eq('the blacklist still stops a text with media', [blocked.status, calls.length], ['blocked', 3]);
eq('the record copy names the photo', filed[0]?.body, 'Hi Kara, the photo\nAttachment: https://m/1.jpg');
eq('the record copy of a plain text is the text', filed[1]?.body, 'No photo');
eq('the record copy is keyed by Talkr\'s message id', filed[0]?.source_id, 'msg:m1');
talkr.sendMessage = realSend;
sb.from = realFrom;
sb.auth.getSession = realSession;

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
