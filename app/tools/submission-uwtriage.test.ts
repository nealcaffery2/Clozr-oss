import assert from 'node:assert/strict';
import { askShortfallPct, hasSubmitterPhotos, uwTriageBucket } from '../lib/submission-uwtriage';

const deal = (extra: Partial<{ sourcePhotos: string[]; photosUrl: string | null; photos: string[] }> = {}) => ({
  sourcePhotos: [] as string[],
  photosUrl: null,
  photos: [] as string[],
  ...extra,
});

assert.equal(hasSubmitterPhotos(deal()), false);
assert.equal(hasSubmitterPhotos(deal({ photosUrl: 'https://drive.google.com/folder/x' })), true);
assert.equal(hasSubmitterPhotos(deal({ photos: ['https://thecompr.com/api/photo?lead_id=x&pos=0'] })), false);
assert.equal(hasSubmitterPhotos(deal({ photos: ['https://storage.example/x.jpg'] })), true);

assert.equal(askShortfallPct(100_000, 80_000), 0.2);
assert.equal(askShortfallPct(100_000, 100_000), 0);
assert.equal(askShortfallPct(100_000, 20_000), 0.8);

assert.equal(uwTriageBucket(100_000, 80_000, deal({ photosUrl: 'https://x' })), 'green');
assert.equal(uwTriageBucket(100_000, 20_000, deal({ photosUrl: 'https://x' })), 'decline');
assert.equal(uwTriageBucket(100_000, 50_000, deal({ photosUrl: 'https://x' })), 'review');
assert.equal(uwTriageBucket(100_000, 80_000, deal()), 'decline');
assert.equal(uwTriageBucket(null, null, deal()), 'decline');
assert.equal(uwTriageBucket(null, null, deal({ photosUrl: 'https://x' })), null);

console.log('submission-uwtriage: ok');
