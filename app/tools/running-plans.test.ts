import { NOT_ON_A_PLAN, ON_A_PLAN, runningMatch } from '../lib/running-plans';

const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`FAIL ${label}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`); process.exit(1); }
};
eq('no picks passes everyone', [runningMatch([], undefined), runningMatch([], ['A'])], [true, true]);
eq('not on a plan', [runningMatch([NOT_ON_A_PLAN], undefined), runningMatch([NOT_ON_A_PLAN], ['A'])], [true, false]);
eq('on a plan', [runningMatch([ON_A_PLAN], []), runningMatch([ON_A_PLAN], ['A'])], [false, true]);
eq('by name', [runningMatch(['B'], ['A']), runningMatch(['A', NOT_ON_A_PLAN], ['A'])], [false, true]);
console.log('running-plans ok');
