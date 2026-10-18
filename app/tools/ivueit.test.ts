// iVueit: reading a submission's photos and the order line Casey sees.
import { hookTypeOf, IVUEIT_HOOK_TYPES, submissionPhotos } from '../supabase/functions/_shared/ivueit-photos';
import { orderLine, type PhotoOrderRow } from '../lib/ivueit';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`ok   ${name}`);
}

// Steps arrive out of order, a photo can repeat across steps, a step can have none.
const sub = {
  name: 'Residential exterior',
  steps: [
    { StepNumber: 2, Description: 'Back of the house', Photos: [{ info: { id: 'p3', mimeType: 'image/jpeg' }, url: 'https://x/p3' }] },
    { StepNumber: 1, Description: 'Front of the house', Photos: [
      { info: { id: 'p1', mimeType: 'image/png' }, url: 'https://x/p1' },
      { info: { id: 'p2' }, url: 'https://x/p2' },
    ] },
    { StepNumber: 3, Description: 'Roof', Photos: [{ info: { id: 'p1' }, url: 'https://x/p1' }, { info: { id: 'p4' }, url: '' }] },
    { StepNumber: 4, Description: 'Occupied?', Value: 'No' },
  ],
};
eq('photos in step order, each once, no empty urls', submissionPhotos(sub).map((p) => `${p.id}:${p.caption}:${p.mime}`),
  ['p1:Front of the house:image/png', 'p2:Front of the house:image/jpeg', 'p3:Back of the house:image/jpeg']);
eq('no steps, no photos', submissionPhotos({}), []);

const base: PhotoOrderRow = {
  id: 1, deal_id: 9, vue_id: 'v', status: 'ordered', address: '1 Main St', notes: null, urgent: false,
  photo_count: 0, cost: null, error: null, created_at: '2026-10-13T12:00:00Z', checked_at: null, completed_at: null,
};
const noon = new Date('2026-10-13T15:10:00Z').getTime();
eq('open order says how long', orderLine(base, noon), 'Ordered Oct 13 · waiting on a Vuer (3h)');
eq('rush shows', orderLine({ ...base, urgent: true }, new Date('2026-10-13T12:20:00Z').getTime()), 'Ordered Oct 13 · rush · waiting on a Vuer');
eq('done counts photos', orderLine({ ...base, status: 'completed', photo_count: 1, completed_at: '2026-10-14T18:00:00Z' }), '1 photo in · Oct 14');
eq('failed says why', orderLine({ ...base, status: 'failed', error: 'The order expired before a Vuer shot it. Order again.' }), 'The order expired before a Vuer shot it. Order again.');

eq('all three iVueit webhooks are registered', [...IVUEIT_HOOK_TYPES], ['VueCompleted', 'VueCanceled', 'VueEscalated']);
eq('webhook type from the URL; an old URL without one is VueCompleted, an unknown one is null', [hookTypeOf('VueCanceled'), hookTypeOf('VueEscalated'), hookTypeOf(null), hookTypeOf(''), hookTypeOf('junk')], ['VueCanceled', 'VueEscalated', 'VueCompleted', 'VueCompleted', null]);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
