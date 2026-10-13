// A contract filed from email moves its deal only when the deal is ready for it.
// Run with: npx tsx tools/email-stage-move.test.ts

import assert from 'node:assert/strict';
import { stageFromDoc } from '../supabase/functions/_shared/deal-docs';

// The seller's signed purchase agreement puts a Prospect under contract; our own copy going out does not.
assert.equal(stageFromDoc('Prospect', 'purchase_agreement', false), 'Under Contract Seller');
assert.equal(stageFromDoc(null, 'purchase_agreement', false), 'Under Contract Seller');
assert.equal(stageFromDoc('Prospect', 'purchase_agreement', true), null);
assert.equal(stageFromDoc('Ready To Market', 'purchase_agreement', false), null);

// An assignment with no buyer on the deal moves nothing (1317 E 3rd St, 405 Birchwood Ave, 8523 N Juniper St).
assert.equal(stageFromDoc('Ready To Market', 'assignment', false), null);
assert.equal(stageFromDoc('Ready To Market', 'assignment', false, false), null);
assert.equal(stageFromDoc('Under Contract Seller', 'assignment', false, false), null);
// With the buyer on the deal, it is buyer under contract.
assert.equal(stageFromDoc('Ready To Market', 'assignment', false, true), 'Buyer Under Contract');
assert.equal(stageFromDoc('Under Contract Seller', 'assignment', false, true), 'Buyer Under Contract');
// Never from a lead's Prospect sheet (1206 Harbor Blvd), and never backwards.
assert.equal(stageFromDoc('Prospect', 'assignment', false, true), null);
assert.equal(stageFromDoc('In Escrow', 'assignment', false, true), null);
assert.equal(stageFromDoc('Terminated', 'assignment', false, true), null);

console.log('email-stage-move: ok');
