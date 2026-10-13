// Role visibility: dispositions see everything; acquisitions never see buyers.
import assert from 'node:assert/strict';
import { ASSIGNABLE_ROLES, canSee, canSeeBuyers, landingFor, peopleListOk, seesSellerLists, type Role } from '../lib/team';

const EVERY: string[] = [
  'home', 'today', 'people', 'person', 'buyers', 'buyer', 'dispo', 'dispoProperty',
  'tc', 'genius', 'dealMachine', 'buyr', 'deals', 'dealSheet', 'reporting',
  'tasks', 'inbox', 'dialer', 'import', 'plans', 'automations', 'liveLists', 'settings',
];

function check(label: string, ok: boolean) {
  assert.equal(ok, true, label);
}

{
  for (const screen of EVERY) {
    check(`dispositions can see ${screen}`, canSee('dispositions', screen));
  }
  check('dispositions can see buyers', canSeeBuyers('dispositions'));
  check('owner can see buyers', canSeeBuyers('owner'));

  const acq: Role = 'acquisitions';
  check('acquisitions cannot see buyers list', !canSee(acq, 'buyers'));
  check('acquisitions cannot see buyer record', !canSee(acq, 'buyer'));
  check('acquisitions cannot see Genius', !canSee(acq, 'genius'));
  check('acquisitions cannot see dispo', !canSee(acq, 'dispo'));
  check('acquisitions cannot see dispoProperty', !canSee(acq, 'dispoProperty'));
  check('acquisitions canSeeBuyers is false', !canSeeBuyers(acq));
  check('acquisitions keeps people and deals', canSee(acq, 'people') && canSee(acq, 'deals') && canSee(acq, 'dealSheet'));

  check('tc can see tc screen', canSee('tc', 'tc'));
  check('tc cannot see buyers', !canSeeBuyers('tc'));
  check('notary cannot see buyers', !canSeeBuyers('notary'));

  // Partnerships: submissions, vendors and COMPR (on the record); no buyers, dispo, Today or seller lists.
  const pt: Role = 'partnerships';
  for (const screen of ['buyers', 'buyer', 'dispo', 'dispoProperty', 'genius', 'today', 'dealMachine', 'buyr', 'tc']) check(`partnerships cannot see ${screen}`, !canSee(pt, screen));
  check('partnerships keeps people, the record and deals', canSee(pt, 'people') && canSee(pt, 'person') && canSee(pt, 'deals'));
  check('partnerships lands on People', landingFor(pt) === 'people');
  check('partnerships calls, texts and emails', canSee(pt, 'dialer') && canSee(pt, 'talkr') && canSee(pt, 'inbox') && canSee(pt, 'person'));
  check('partnerships has no seller lists', !seesSellerLists(pt) && seesSellerLists('acquisitions'));
  check('partnerships works submissions and vendors', peopleListOk(pt, 'New Submissions') && peopleListOk(pt, 'Offer Made') && peopleListOk(pt, 'Vendors') && peopleListOk(pt, 'Lenders'));
  check('...not seller lists', !peopleListOk(pt, 'My Leads') && !peopleListOk(pt, 'Sellers') && !peopleListOk(pt, 'Buyers') && !peopleListOk(pt, 'Agents'));
  check('...a saved list is theirs', peopleListOk(pt, 'My saved list', true));
  check('everyone else keeps every list', peopleListOk('acquisitions', 'My Leads'));
  check('partnerships is assignable', ASSIGNABLE_ROLES.includes(pt));
}

console.log('role-visibility: ok');
