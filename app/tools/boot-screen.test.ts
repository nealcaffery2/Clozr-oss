// Which screen's chunk /app starts loading at boot (app/clozr/screens/lazy.tsx
// bootScreen): the one useClozr's restore will open, so it is on the way while
// the session and workspace reads are.
// Run with:  npx tsx tools/boot-screen.test.ts
import { bootScreen } from '../app/clozr/screens/lazy';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

// A bare address is the role's landing.
eq('bare, owner', bootScreen('', 'owner'), 'home');
eq('bare, acquisitions', bootScreen('', 'acquisitions'), 'today');
eq('bare, partnerships', bootScreen('', 'partnerships'), 'people');
eq('bare, sdr', bootScreen('', 'sdr'), 'buyers');
eq('bare, no role yet', bootScreen('', null), null);
eq('hash without a screen', bootScreen('#id=s4', 'acquisitions'), 'today');

// The address's screen, when the role may see it.
eq('record', bootScreen('#screen=person&id=s42&from=people', 'acquisitions'), 'person');
eq('home named by a Today role', bootScreen('#screen=home', 'acquisitions'), 'home');
eq('screen before the role is known', bootScreen('#screen=dispo', null), 'dispo');
eq('screen the role cannot see', bootScreen('#screen=dispo', 'acquisitions'), 'today');
eq('junk screen for a narrow role', bootScreen('#screen=nope', 'tc'), 'home');

// Screens with no chunk of their own load nothing extra.
eq('contracts', bootScreen('#screen=contracts', 'owner'), null);
eq('junk screen for an all-screens role', bootScreen('#screen=nope', 'owner'), null);
eq('prototype key', bootScreen('#screen=constructor', null), null);
