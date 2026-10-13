// Uploaded ringtone / ringback / alert sounds. Run: npx tsx tools/phone-audio-upload.test.ts
import { MAX_CUSTOM_AUDIO_BYTES, isUploadedSound, setCustomRingtoneFromFile, setEventSoundFromFile } from '../lib/phone-audio';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};
const mp3 = (bytes: number) => new File([new Uint8Array(bytes)], 'tone.mp3', { type: 'audio/mpeg' });
const err = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

eq('the cap is 10 MB', MAX_CUSTOM_AUDIO_BYTES, 10 * 1024 * 1024);
eq('an idb reference is an uploaded file', isUploadedSound('idb:u1:ringtone#1'), true);
eq('a data URL is an uploaded file', isUploadedSound('data:audio/mpeg;base64,AA'), true);
eq('a pasted link is not', isUploadedSound('https://x.test/a.mp3'), false);
eq('nothing is not', isUploadedSound(null), false);

(async () => {
  const over = mp3(MAX_CUSTOM_AUDIO_BYTES + 1);
  eq('ringtone over 10 MB is refused', await err(setCustomRingtoneFromFile(over)), 'File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  eq('ringback over 10 MB is refused', await err(setCustomRingtoneFromFile(over, 'outgoing')), 'File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  eq('text alert over 10 MB is refused', await err(setEventSoundFromFile('sms', over)), 'File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  eq('a non-audio file is refused', await err(setCustomRingtoneFromFile(new File(['x'], 'a.txt', { type: 'text/plain' }))), 'File must be an audio file (MP3, WAV, OGG, …).');
  // No IndexedDB here (Node): a 5 MB file cannot fall back to a data URL in localStorage.
  eq('5 MB with no IndexedDB says why', await err(setCustomRingtoneFromFile(mp3(5 * 1024 * 1024))), 'This browser cannot keep a file over 2 MB. Host it and paste an HTTPS link instead.');
  if (failed) process.exit(1);
})();
