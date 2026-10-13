// Where a bell row goes. Run: npx tsx tools/notif-target.test.ts
import { bellFromComms } from '../lib/bell-events';
import { notifLink, notifPhone } from '../lib/notif-target';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const row = (category: string, o: Partial<{ title: string; seller_id: number | null; buyer_id: number | null; deal_id: number | null; phone_key: string | null }> = {}) =>
  ({ category, title: o.title ?? 'x', seller_id: o.seller_id ?? null, buyer_id: o.buyer_id ?? null, deal_id: o.deal_id ?? null, phone_key: o.phone_key ?? null });

eq('a text from a seller opens their Texts', notifLink(row('inbound_sms', { seller_id: 4, phone_key: '+15125550100' })),
  { screen: 'person', id: 's4', tab: 'Texts', phone: '+15125550100' });
eq('a text from a stranger opens the Inbox thread', notifLink(row('inbound_sms', { phone_key: '5125550100' })), { screen: 'inboxSms', id: '+15125550100' });
eq('an old text row reads the number from its title', notifPhone({ category: 'inbound_sms', title: 'New text from +1 (512) 555-0100' }), '+15125550100');
eq('a mention opens the Notes', notifLink(row('Mention', { seller_id: 4 })), { screen: 'person', id: 's4', tab: 'Notes' });
eq('a mention on a buyer opens their Notes', notifLink(row('Mention', { buyer_id: 7 })), { screen: 'buyer', id: 'b7', tab: 'Notes' });
eq('underwriting opens the record on that deal', notifLink(row('Underwriting', { seller_id: 4, deal_id: 9 })), { screen: 'person', id: 's4', dealId: 'd9' });
eq('a TC note opens the TC file on that deal', notifLink(row('TC', { seller_id: 4, deal_id: 9 })), { screen: 'tc', id: 's4', dealId: 'd9' });
eq('offer accepted opens the dispo property', notifLink(row('Dispo', { seller_id: 4, deal_id: 9 })), { screen: 'dispoProperty', id: 's4', dealId: 'd9' });
eq('a buyer reply opens the buyer', notifLink(row('Dispo', { buyer_id: 7, deal_id: 9 })), { screen: 'buyer', id: 'b7' });
eq('a deal-only Dispo note opens its property', notifLink(row('Dispo', { deal_id: 9 }), 4), { screen: 'dispoProperty', id: 's4', dealId: 'd9' });
eq('a contract on a deal opens that deal', notifLink(row('Contracts', { seller_id: 4, deal_id: 9 })), { screen: 'person', id: 's4', dealId: 'd9' });
eq('a contract with no record opens Contracts', notifLink(row('Contracts')), { screen: 'contracts', id: '' });
eq('number health opens the numbers', notifLink(row('Number health')), { screen: 'settings', id: '', tab: 'numbers' });
eq('floor rows open the leaderboard', notifLink(row('Wheel', { seller_id: 4 })), { screen: 'leaderboard', id: '' });
eq('Lane opens on its file', notifLink(row('Lane', { seller_id: 4 })), { screen: 'lane', id: 's4' });
eq('nothing to open', notifLink(row('Email')), { screen: 'home', id: '' });

const comm = { channel: 'call', dir: 'in', party: 'Kara', time: 'now', ts: 1, preview: '', status: 'no_answer' };
eq('a missed call opens the Calls', bellFromComms([{ ...comm, id: 'c1', personId: 's4' }])[0].link, { screen: 'person', id: 's4', tab: 'Calls' });
eq('a text opens the Texts', bellFromComms([{ ...comm, id: 'c2', channel: 'sms', status: undefined, personId: 's4' }])[0].link, { screen: 'person', id: 's4', tab: 'Texts' });
eq('a voicemail opens Activity, where it shows', bellFromComms([{ ...comm, id: 'c4', channel: 'voicemail', personId: 's4' }])[0].link, { screen: 'person', id: 's4' });
eq('a buyer has no such tab', bellFromComms([{ ...comm, id: 'c3', buyerId: 'b7' }])[0].link, { screen: 'buyer', id: 'b7' });

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
