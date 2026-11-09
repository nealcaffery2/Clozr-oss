// Uploaded ringtone / ringback / alert sounds. Run: npx tsx tools/phone-audio-upload.test.ts
import {
  DEFAULT_AUDIO_PREFS, MAX_CUSTOM_AUDIO_BYTES, audioLinkProblem, cloudAudioPrefs, isUploadedSound, mergeAudioPrefs,
  setCustomRingtoneFromFile, setEventSoundFromFile,
} from '../lib/phone-audio';

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
eq('a bucket reference is an uploaded file', isUploadedSound('sb:u1/ringback#1'), true);
eq('a pasted link is not', isUploadedSound('https://x.test/a.mp3'), false);
eq('nothing is not', isUploadedSound(null), false);

// Sign-in merge: the account's choices win, the devices plugged into this desk stay.
const desk = { ...DEFAULT_AUDIO_PREFS, ringtone: 'classic' as const, inputDeviceId: 'mic-desk', ringDeviceId: 'spk-desk', outgoingCustomRingtoneUrl: 'idb:u1:ringback#1' };
const merged = mergeAudioPrefs(desk, { ringtone: 'trill', outgoingCustomRingtoneUrl: 'sb:u1/ringback#2', inputDeviceId: 'mic-laptop', events: { sms: { on: false, tone: 'blip' } } });
eq('the account wins the tone and the wait music', [merged.ringtone, merged.outgoingCustomRingtoneUrl], ['trill', 'sb:u1/ringback#2']);
eq('this desk keeps its mic and ring device', [merged.inputDeviceId, merged.ringDeviceId], ['mic-desk', 'spk-desk']);
eq('alert switches merge one event at a time', [merged.events.sms.on, merged.events.missed.on], [false, true]);
eq('nothing in the row leaves the desk as it was', mergeAudioPrefs(desk, null), desk);
eq('device ids stay out of the row', 'inputDeviceId' in cloudAudioPrefs(desk), false);
eq('a data URL stays out of the row', 'customRingtoneUrl' in cloudAudioPrefs({ ...desk, customRingtoneUrl: 'data:audio/mpeg;base64,AA' }), false);

(async () => {
  const over = mp3(MAX_CUSTOM_AUDIO_BYTES + 1);
  eq('ringtone over 10 MB is refused', await err(setCustomRingtoneFromFile(over)), 'File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  eq('ringback over 10 MB is refused', await err(setCustomRingtoneFromFile(over, 'outgoing')), 'File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  eq('text alert over 10 MB is refused', await err(setEventSoundFromFile('sms', over)), 'File too large (max 10 MB). Host it and paste an HTTPS link instead.');
  eq('a non-audio file is refused', await err(setCustomRingtoneFromFile(new File(['x'], 'a.txt', { type: 'text/plain' }))), 'File must be an audio file (MP3, WAV, OGG, …).');
  // No IndexedDB here (Node): a 5 MB file cannot fall back to a data URL in localStorage.
  eq('5 MB with no IndexedDB says why', await err(setCustomRingtoneFromFile(mp3(5 * 1024 * 1024))), 'This browser cannot keep a file over 2 MB. Host it and paste an HTTPS link instead.');
  const page = 'That is a web page, not an audio file. Download the MP3 and use Upload MP3 instead.';
  eq('a YouTube watch link is refused', await audioLinkProblem('https://www.youtube.com/watch?v=Gi1gMAotwn8&list=RDGi1gMAotwn8'), page);
  eq('a youtu.be link is refused', await audioLinkProblem('https://youtu.be/Gi1gMAotwn8'), page);
  eq('a Spotify link is refused', await audioLinkProblem('https://open.spotify.com/track/abc'), page);
  // No Audio in Node: a direct file link is left to the browser.
  eq('an MP3 link is not refused up front', await audioLinkProblem('https://cdn.example.com/hold.mp3'), null);
  if (failed) process.exit(1);
})();
