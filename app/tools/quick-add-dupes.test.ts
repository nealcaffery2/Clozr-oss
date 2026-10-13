// Quick Add's duplicate check: which match is put to the person, and what
// Add / Override write to the record already there.
//
// Pure functions, no network. Run with:  npx tsx tools/quick-add-dupes.test.ts

import { buyerMergePatch, changedWords, mergeToast, pickDuplicate, quickPatch, sellerFields, type DupeRow } from '../lib/quick-add-dupes';

let failed = 0;
const check = (name: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!pass) failed++;
};

// ---- which match ----
const karen: DupeRow = { id: 1, name: 'Karen Daniels', phone: '(936) 555-0142', email: 'karen@x.com', property_address: '330 Vista Dr, Shepherd, TX 77371' };
const luis: DupeRow = { id: 2, name: 'Luis Ortega', phone: null, email: null, property_address: '330 Vista Dr, Shepherd, TX 77371' };
const ron: DupeRow = { id: 3, name: 'Ronald Moore', phone: null, email: 'ron@x.com', property_address: null };

check('no hits, no question', pickDuplicate('seller', 'Anyone', { phone: [], email: [], address: [] }) === null);
const byPhone = pickDuplicate('seller', 'Karen D', { phone: [karen], email: [ron], address: [luis] });
check('phone wins over email and address', byPhone?.id === 1 && byPhone.by === 'phone', JSON.stringify(byPhone));
check('a phone match cannot be created anyway (sellers_phone_uniq)', byPhone?.canCreate === false);
check('the record shows its phone, email and address', byPhone?.detail.length === 3 && byPhone.detail[2].startsWith('330 Vista'));
check('an archived match says so', pickDuplicate('seller', 'Karen', { phone: [{ ...karen, archived_at: '2026-09-01' }], email: [], address: [] })?.detail.includes('archived') === true);
const byEmail = pickDuplicate('seller', 'Ron Moore', { phone: [], email: [ron], address: [] });
check('email match, and a new seller can still be made', byEmail?.by === 'email' && byEmail.id === 3 && byEmail.canCreate === true);
const sameAddr = pickDuplicate('seller', 'Karen E. Daniels', { phone: [], email: [], address: [luis, karen] });
check('on a shared property the same-name seller is the match', sameAddr?.id === 1 && sameAddr.by === 'address' && !sameAddr.otherPerson, JSON.stringify(sameAddr));
const otherAddr = pickDuplicate('seller', 'Maria Lopez', { phone: [], email: [], address: [luis, karen] });
check('a different name at the address is flagged as another person (co-owner)', otherAddr?.id === 2 && otherAddr.otherPerson && otherAddr.canCreate, JSON.stringify(otherAddr));
const buyer = pickDuplicate('buyer', 'Maria', { phone: [], email: [{ id: 7, name: 'Maria Lopez', phone: '210-555-0100', email: 'maria@lopez.com', company: 'Lopez Holdings' }], address: [] });
check('a buyer match is never created anyway, and shows the company', buyer?.kind === 'buyer' && buyer.canCreate === false && buyer.detail.includes('Lopez Holdings'), JSON.stringify(buyer));

// ---- what a seller form writes ----
const f = { name: ' Karen Daniels ', phone: '936-555-0142', email: 'KAREN@New.com', asking: '$110,000', motivation: '', source: '', compr: 'On', addr: '330 Vista Dr' };
const fields = sellerFields(f);
check('seller fields: typed values only, money parsed, email lowercased', JSON.stringify(fields) === JSON.stringify({ name: 'Karen Daniels', phone: '936-555-0142', email: 'karen@new.com', asking_price: 110000 }), JSON.stringify(fields));
const onFile = { name: 'Karen Daniels', phone: '(936) 555-0142', email: null, asking_price: 95000, motivation: 'Probate', source: 'Direct Mail', tags: ['probate'], notes: 'Wants 30 days' };
check('Add: only the empty email is filled', JSON.stringify(quickPatch(onFile, fields, 'fill')) === JSON.stringify({ email: 'karen@new.com' }), JSON.stringify(quickPatch(onFile, fields, 'fill')));
check('Override: every typed value that differs; the same phone in another spelling is not a change; motivation and source untouched (not typed)',
  JSON.stringify(quickPatch(onFile, fields, 'overwrite')) === JSON.stringify({ email: 'karen@new.com', asking_price: 110000 }),
  JSON.stringify(quickPatch(onFile, fields, 'overwrite')));
check('Override: a different phone is written', quickPatch(onFile, { phone: '936-555-9999' }, 'overwrite').phone === '936-555-9999');
check('Override: the same email in other case is not a change', Object.keys(quickPatch({ email: 'Karen@X.com' }, { email: 'karen@x.com' }, 'overwrite')).length === 0);

// ---- what a buyer form writes ----
const buyerOnFile = {
  name: 'Maria Lopez', company: null, phone: '+12105550100', email: 'maria@lopez.com', buyer_type: 'flipper', buy_box: null,
  criteria: { location_prefs: [{ name: 'San Antonio', type: 'city' }], price: { min: 80000, max: null } },
};
const typed = { name: 'Maria Lopez', company: 'Lopez Holdings', phone: '2105550100', email: 'maria@lopez.com', type: '', markets: 'Austin, San Antonio', price: '$90K - $350K' };
const add = buyerMergePatch(buyerOnFile, typed, 'fill');
check('buyer Add: company filled, phone and type left as they were', add.company === 'Lopez Holdings' && !('phone' in add) && !('buyer_type' in add), JSON.stringify(add));
check('buyer Override: the same phone in another spelling is not rewritten', !('phone' in buyerMergePatch(buyerOnFile, typed, 'overwrite')));
const prefs = (add.criteria as { location_prefs: { name: string }[] } | undefined)?.location_prefs.map((p) => p.name) ?? [];
check('buyer Add: a new market joins the buy box, an existing one is not doubled', prefs.join('|') === 'San Antonio|Austin', prefs.join('|'));
check('buyer Add: only the empty price end is filled', add.min_purchase_price === 80000 && add.max_purchase_price === 350000, `${add.min_purchase_price} ${add.max_purchase_price}`);
check('buyer Add: derived markets follow the box', Array.isArray(add.markets) && (add.markets as string[]).length === 2 && typeof add.buy_box === 'string', JSON.stringify(add.markets));
const over = buyerMergePatch(buyerOnFile, typed, 'overwrite');
const overPrefs = (over.criteria as { location_prefs: { name: string }[] } | undefined)?.location_prefs.map((p) => p.name) ?? [];
check('buyer Override: the typed markets replace the box’s, both price ends replaced', overPrefs.join('|') === 'Austin|San Antonio' && over.min_purchase_price === 90000 && over.max_purchase_price === 350000, JSON.stringify([overPrefs, over.min_purchase_price, over.max_purchase_price]));
const nothing = buyerMergePatch(buyerOnFile, { name: 'Maria Lopez', email: 'maria@lopez.com' }, 'overwrite');
check('buyer: nothing new typed, nothing written (the buy box is not rewritten)', Object.keys(nothing).length === 0, JSON.stringify(nothing));
const handWritten = buyerMergePatch({ ...buyerOnFile, buy_box: 'Wants brick only' }, typed, 'fill');
check('buyer: a buy-box summary written by hand is kept', !('buy_box' in handWritten));

// ---- words ----
check('changed words: the buy box columns read as one', JSON.stringify(changedWords(['company', 'criteria', 'markets', 'min_purchase_price', 'buy_box'])) === JSON.stringify(['company', 'buy box']));
check('changed words: asking', JSON.stringify(changedWords(['asking_price', 'email'])) === JSON.stringify(['asking', 'email']));
check('toast: added / overrode / nothing new', mergeToast('Karen', 'fill', ['email']) === 'Added to Karen: email' && mergeToast('Karen', 'overwrite', ['phone']) === 'Overrode Karen: phone' && mergeToast('Karen', 'fill', []).startsWith('Nothing added to Karen') && mergeToast('Karen', 'overwrite', []).includes('nothing changed'));

console.log(failed ? `\n${failed} FAILED` : '\nall quick add duplicate checks passed');
process.exit(failed ? 1 : 0);
