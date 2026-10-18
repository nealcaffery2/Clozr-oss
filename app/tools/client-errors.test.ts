import { errorKey, toClientErrorRow } from '../lib/client-errors';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

const ctx = { kind: 'screen' as const, where: 'buyers', path: '/app', release: 'abc', userAgent: 'UA' };

const boom = new TypeError("Cannot read properties of undefined (reading 'phone')");
const row = toClientErrorRow(boom, ctx);
eq('error message kept', row?.message, "Cannot read properties of undefined (reading 'phone')");
eq('stack kept', typeof row?.stack, 'string');
eq('context kept', [row?.kind, row?.where_at, row?.path, row?.release, row?.user_agent], ['screen', 'buyers', '/app', 'abc', 'UA']);

eq('string error', toClientErrorRow('bad state', ctx)?.message, 'bad state');
eq('object with message', toClientErrorRow({ message: 'PGRST116' }, ctx)?.message, 'PGRST116');
eq('plain object', toClientErrorRow({ code: 42 }, ctx)?.message, '{"code":42}');
eq('null reason', toClientErrorRow(null, ctx)?.message, 'null');

eq('chunk load skipped', toClientErrorRow(new Error('Failed to fetch dynamically imported module: /x.js'), ctx), null);
eq('ResizeObserver skipped', toClientErrorRow(new Error('ResizeObserver loop completed with undelivered notifications.'), ctx), null);
eq('opaque script error skipped', toClientErrorRow('Script error.', ctx), null);
const ext = new Error('x'); ext.stack = 'Error: x\n    at chrome-extension://abc/content.js:1:1';
eq('extension error skipped', toClientErrorRow(ext, ctx), null);
eq('empty message skipped', toClientErrorRow('   ', ctx), null);

const long = toClientErrorRow('m'.repeat(5000), { ...ctx, where: 'w'.repeat(500) });
eq('message capped', long?.message.length, 2000);
eq('where capped', long?.where_at?.length, 200);

eq('same error same key', errorKey(row!), errorKey(toClientErrorRow(boom, ctx)!));
eq('other screen other key', errorKey(row!) === errorKey(toClientErrorRow(boom, { ...ctx, where: 'deals' })!), false);
