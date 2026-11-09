// Mic failure messages. Run: npx tsx tools/mic-failure.test.ts
import { micFailureText, openMic } from '../lib/phone-audio';

let failed = 0;
const has = (label: string, got: string, part: string) => {
  const pass = got.includes(part);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)}`}`);
  if (!pass) failed++;
};

const fail = (name: string, message = '') => Object.assign(new Error(message), { name });
let permission = 'denied';
let next: Error = fail('NotAllowedError');
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'Chrome', platform: 'Win32', maxTouchPoints: 0,
    mediaDevices: { getUserMedia: () => Promise.reject(next) },
    permissions: { query: async () => ({ state: permission }) },
  },
});

async function main() {
  await openMic();
  has('blocked site says browser will not ask', await micFailureText(), 'will not ask again');
  permission = 'prompt';
  await openMic();
  has('dismissed prompt says choose Allow', await micFailureText(), 'choose Allow');
  next = fail('NotAllowedError', 'Permission denied by system');
  await openMic();
  has('OS block names Windows settings', await micFailureText(), 'Privacy & security');
  next = fail('NotReadableError');
  await openMic();
  has('busy mic names other apps', await micFailureText(), 'busy');
  next = fail('NotFoundError');
  await openMic();
  has('no mic says plug one in', await micFailureText(), 'No microphone found');
  if (failed) process.exit(1);
}
void main();
