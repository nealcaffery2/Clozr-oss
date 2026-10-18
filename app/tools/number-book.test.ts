import assert from 'node:assert/strict';
import { buildNumberBook, e164, needsCallerId, type BookTalkrNumber } from '../lib/number-book';

const team = [
  { user_id: 'morgan', full_name: 'Morgan Lane', email: 'morgan@x.com', role: 'acquisitions' },
  { user_id: 'alex', full_name: 'Alex Lee', email: 'alex@x.com', role: 'acquisitions' },
  { user_id: 'notary', full_name: 'Nora Notary', email: 'nora@x.com', role: 'notary' },
];
const tn = (id: string, phone: string, owner: string | null, extra: Partial<BookTalkrNumber> = {}): BookTalkrNumber =>
  ({ id, phone_e164: phone, label: null, status: 'active', assigned_user_id: owner, assigned_user_name: null, ...extra });

const book = buildNumberBook({
  team,
  rows: [
    { phone_e164: '+12105550169', user_id: 'morgan', label: 'Morgan' },
    { phone_e164: '+12105550174', user_id: 'morgan', label: 'Morgan 2' },
    { phone_e164: '+12105550175', user_id: 'alex', label: 'Alex Main', is_caller_id: true },
    { phone_e164: '+18305550178', user_id: null, label: 'Company Main' },
    { phone_e164: '+12105550176', user_id: 'gone', label: 'Taylor Main' },
    { phone_e164: '+14045550179', user_id: null, label: 'Georgia' },
  ],
  talkrNumbers: [
    tn('n1', '+12105550174', 'T-morgan'),
    tn('n2', '+12105550175', 'T-morgan'), // Talkr says Morgan, CLOZR says Alex
    tn('n3', '+15125550100', 'T-alex'), // only on Talkr
    tn('n4', '+18305550178', null, { is_company_line: true }),
    tn('n5', '+17135550100', null, { status: 'released' }),
    tn('n6', '+13465550100', null),
  ],
  talkrMembers: [
    { id: 'T-morgan', email: 'MORGAN@x.com', display_name: 'Morgan', status: 'active', default_phone_number_id: 'n1' },
    { id: 'T-alex', email: 'alex@x.com', display_name: 'Alex', status: 'active', default_phone_number_id: null },
  ],
  callerLines: [{ phone_e164: '+14045550179', pool: 'rvm', fcr_status: 'registered', reputation_enrolled: true, branded_attached: false, spam_risk: 'low' }],
  health: [],
  agentPhones: ['(346) 555-0100'],
});

assert.equal(e164('(210) 555-0100'), '+12105550100');
assert.equal(e164('12105550100'), '+12105550100');
assert.equal(e164('555'), null);

// The notary is not a phone person; people sort by name.
assert.deepEqual(book.people.map((p) => p.member.user_id), ['alex', 'morgan']);

const morgan = book.people.find((p) => p.member.user_id === 'morgan')!;
assert.equal(morgan.talkr?.id, 'T-morgan');
// Talkr's caller ID stands in until CLOZR's flag is set, and it sorts first.
assert.equal(morgan.callerId, '+12105550174');
assert.deepEqual(morgan.lines.map((l) => l.phone), ['+12105550174', '+12105550169']);

const alex = book.people.find((p) => p.member.user_id === 'alex')!;
// CLOZR's owner wins; Talkr's other owner is flagged. A Talkr-only line goes by Talkr's owner.
assert.deepEqual(alex.lines.map((l) => l.phone).sort(), ['+12105550175', '+15125550100']);
const main = alex.lines.find((l) => l.phone === '+12105550175')!;
assert.equal(main.mismatch, true);
assert.equal(main.talkrOwnerId, 'morgan');
assert.equal(alex.callerId, '+12105550175');

// Company lines: no owner or a former teammate's, the Talkr company line first. Released, RVM pool and AI lines are elsewhere.
assert.deepEqual(book.company.map((l) => l.phone), ['+18305550178', '+12105550176']);
assert.equal(book.company[1]!.formerOwner, true);
assert.deepEqual(book.pool.map((l) => l.phone), ['+14045550179']);
assert.equal(book.agentLines, 1);

// Morgan has two lines and no CLOZR flag yet; Alex picked his.
assert.deepEqual(needsCallerId(book).map((p) => p.member.user_id), ['morgan']);

// A rep sees only their own Talkr seat through `me`.
const repView = buildNumberBook({
  team, rows: [], talkrNumbers: [tn('n1', '+12105550174', 'T-morgan'), tn('n3', '+15125550100', 'T-alex', { assigned_user_name: 'Alex Lee' })],
  talkrMembers: [], me: { userId: 'morgan', talkrId: 'T-morgan', defaultNumberId: 'n1' }, callerLines: [], health: [], agentPhones: [],
});
assert.equal(repView.people.find((p) => p.member.user_id === 'morgan')!.callerId, '+12105550174');
assert.deepEqual(repView.people.find((p) => p.member.user_id === 'alex')!.lines.map((l) => l.phone), ['+15125550100']);

// Talkr email differs from CLOZR but display name matches uniquely → still linked.
const caseyTeam = [{ user_id: 'w', full_name: 'Casey Example', email: 'casey@yourcompany.com', role: 'acquisitions' }];
const caseyBook = buildNumberBook({
  team: caseyTeam,
  rows: [{ phone_e164: '+12105550332', user_id: 'w', label: 'Casey' }],
  talkrNumbers: [tn('wn', '+12105550332', 'T-w')],
  talkrMembers: [{ id: 'T-w', email: 'w.example@talkr.io', display_name: 'Casey Example', status: 'active', default_phone_number_id: 'wn' }],
  callerLines: [], health: [], agentPhones: [],
});
assert.equal(caseyBook.people[0]!.talkr?.id, 'T-w');
assert.equal(caseyBook.people[0]!.lines[0]!.talkr?.id, 'wn');

console.log('number-book ok');
