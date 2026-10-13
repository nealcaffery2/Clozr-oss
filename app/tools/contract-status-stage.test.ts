// Contract status on the deal sheet keeps the pipeline (and the dispo list) in step.
// Run: npx tsx tools/contract-status-stage.test.ts
import assert from 'node:assert/strict';
import { stageForContractStatus } from '../lib/deal-sheet';

assert.equal(stageForContractStatus('Prospect', 'Under Contract'), 'Under Contract Seller');
assert.equal(stageForContractStatus('New Lead', 'Fully executed'), 'Under Contract Seller');
assert.equal(stageForContractStatus('Ready To Market', 'Under Contract'), null, 'marketing is not pulled back');
assert.equal(stageForContractStatus('Under Contract Seller', 'Buyer executed'), 'Buyer Under Contract');
assert.equal(stageForContractStatus('In Escrow', 'Buyer executed'), null);
assert.equal(stageForContractStatus('Closed', 'Under Contract'), null);
assert.equal(stageForContractStatus('Ready To Market', 'Terminated'), 'Terminated');
assert.equal(stageForContractStatus('Terminated', 'Terminated'), null);
assert.equal(stageForContractStatus('Prospect', 'Pending'), null);
assert.equal(stageForContractStatus('Contract Sent to Seller', 'Fully executed'), 'Under Contract Seller');
assert.equal(stageForContractStatus('In Escrow', 'Fully executed'), null);

console.log('contract-status-stage: ok');
