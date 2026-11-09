// A number in another workspace. Run: npx tsx tools/elsewhere.test.ts
import { pickElsewhere } from '../lib/elsewhere';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const names = new Map([[11, 'Acme Homes'], [13, 'Compr']]);
const got = pickElsewhere([
  { kind: 'buyer', id: 5, name: 'Buyer Bob', workspace_id: 11, phone_key: '+18645551111' },
  { kind: 'seller', id: 3699, name: 'Ronald Moore', workspace_id: 13, phone_key: '+18645551111' },
  { kind: 'seller', id: 3700, name: 'Later Ron', workspace_id: 13, phone_key: '+18645551111' },
  { kind: 'buyer', id: 9, name: '  ', workspace_id: 99, phone_key: '+12145552474' },
], names);
eq('a seller wins over a buyer, then the oldest record', got.get('+18645551111'), { kind: 'seller', id: 3699, name: 'Ronald Moore', workspaceId: 13, workspaceName: 'Compr' });
eq('no name and an unknown workspace still read', got.get('+12145552474'), { kind: 'buyer', id: 9, name: 'Buyer', workspaceId: 99, workspaceName: 'another workspace' });
eq('nothing for a number with no hit', got.get('+15555550100'), undefined);

if (failed) { console.error(`elsewhere: ${failed} failed`); process.exit(1); }
console.log('elsewhere: ok');
