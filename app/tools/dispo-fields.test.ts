// Dispo blast merge fields. Run: npx tsx tools/dispo-fields.test.ts
import assert from 'node:assert/strict';
import { dispoFields, emailSafeUrl } from '../lib/dispo-fields';
import type { Person } from '../lib/clozr-types';

const person = (over: Partial<Person['property']> = {}): Person => ({
  id: 'p1', name: 'Pat', stage: 'Under Contract', score: 80, assigned: null, source: '',
  phone: '', email: '', lastComm: '', lastCommTs: null, nextTask: '', offer: null, created: '',
  tags: [], market: '', motivation: '', timeline: '', condition: '', occupancy: '',
  mortgage: '', asking: '', desiredClose: '', decisionMakers: '',
  property: { addr: '1418 Oak Hollow Dr', city: 'San Antonio', st: 'TX', zip: '78209', beds: 3, baths: 2, sqft: 1420, year: 1958, lot: '', type: 'Single Family', img: '', apn: '', ...over },
});

assert.equal(emailSafeUrl(''), '');
assert.equal(emailSafeUrl('not-a-url'), '');
assert.equal(emailSafeUrl('http://insecure.example/x'), '');
assert.equal(emailSafeUrl('https://thecompr.com/v/abc'), 'https://thecompr.com/v/abc');
assert.equal(emailSafeUrl('https://x.supabase.co/storage/v1/object/sign/deal-files/a.jpg?token=z'), '');
assert.equal(emailSafeUrl('https://x.supabase.co/storage/v1/object/authenticated/deal-files/a.jpg'), '');

const empty = dispoFields({ marketing: { headline: 'H', description: 'D', url: null, garage: 2 } }, person(), '1418 Oak Hollow Dr', 189000);
assert.equal(empty.marketing_link, '', 'no COMPR / listing / marketing url → empty, not a fake href');
assert.equal(empty.photo_url, '');
assert.equal(empty.photos_link, '');
assert.equal(empty.comps_link, '');
assert.equal(empty.asking_price, '$189,000');
assert.equal(empty.full_address, '1418 Oak Hollow Dr, San Antonio, TX 78209');
assert.equal(empty.property_type, 'SFH');
assert.equal(empty.garage, '2');

const filled = dispoFields({
  arv: 280000, rehab: 35000,
  marketing: { headline: 'Fairview steal', description: 'Solid bones.', url: 'https://typed.example/deal', garage: null },
  underwritingUrl: 'https://thecompr.com/r/lead-1',
  photoUrl: 'https://x.supabase.co/storage/v1/object/sign/deal-files/private.jpg?token=z',
  heroUrl: 'https://thecompr.com/api/photo?lead_id=lead-1&pos=0&token=tok',
  buyerReportUrl: 'https://thecompr.com/v/buyer-tok',
  cmaPdfUrl: 'https://yourprojectref00000.supabase.co/storage/v1/object/public/deal-public/ws/11/deals/9/cma.pdf',
  photosUrl: 'https://yourprojectref00000.supabase.co/functions/v1/listing/abc#photos',
  listingUrl: 'https://yourprojectref00000.supabase.co/functions/v1/listing/abc',
}, person(), '1418 Oak Hollow Dr', 189000);

assert.equal(filled.marketing_link, 'https://thecompr.com/v/buyer-tok', 'View Full Deal is the COMPR buyer report, not the typed marketing URL');
assert.equal(filled.photo_url, 'https://thecompr.com/api/photo?lead_id=lead-1&pos=0&token=tok', 'money shot is the COMPR hero, not the private upload');
assert.equal(filled.photos_link, 'https://yourprojectref00000.supabase.co/functions/v1/listing/abc#photos');
assert.ok(filled.comps_link.endsWith('/cma.pdf'), filled.comps_link);
assert.equal(filled.arv, '$280,000');

const fallbacks = dispoFields({
  marketing: { headline: null, description: null, url: null, garage: null },
  underwritingUrl: 'https://thecompr.com/r/lead-1',
  photoUrl: 'https://images.example/front.jpg',
  buyerReportUrl: 'https://thecompr.com/v/buyer-tok',
}, person(), '1418 Oak Hollow Dr', null);
assert.equal(fallbacks.marketing_link, 'https://thecompr.com/v/buyer-tok');
assert.equal(fallbacks.photos_link, 'https://thecompr.com/v/buyer-tok', 'no photo-set URL: Photos falls through to the buyer report');
assert.equal(fallbacks.comps_link, 'https://thecompr.com/v/buyer-tok', 'no CMA PDF: Comps falls through to the buyer report');
assert.equal(fallbacks.photo_url, 'https://images.example/front.jpg', 'public photo URL is email-safe when there is no COMPR hero');
assert.equal(fallbacks.asking_price, '');

console.log('dispo-fields: all assertions passed');
