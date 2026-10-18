// telnyxSetting: the function secret, else Vault. A failed Vault read must not
// read as "not set up" (rvm-tick used to mark the drop ready on that null).
// A Deno test: the file reads Deno.env, so tools/ (tsc) cannot import it.
// Run:  deno run --allow-env supabase/functions/_shared/telnyx-settings.test.ts
import assert from 'node:assert/strict';
import { telnyxSetting } from './telnyx-settings.ts';

const vault = (res: { data: unknown; error: { message: string } | null }) => ({ rpc: () => Promise.resolve(res) }) as never;

Deno.env.delete('TELNYX_API_KEY');
Deno.env.delete('TELNYX_CONNECTION_ID');
assert.equal(await telnyxSetting(vault({ data: ' key-1 ', error: null }), 'TELNYX_API_KEY'), 'key-1', 'the Vault copy, trimmed');
assert.equal(await telnyxSetting(vault({ data: null, error: null }), 'TELNYX_API_KEY'), null, 'not set anywhere is null');
assert.equal(await telnyxSetting(vault({ data: '  ', error: null }), 'TELNYX_API_KEY'), null, 'a blank Vault value is not set');
await assert.rejects(telnyxSetting(vault({ data: null, error: { message: 'timeout' } }), 'TELNYX_CONNECTION_ID'), /telnyx_connection_id.*timeout/, 'a failed Vault read throws, it is not "not set"');
Deno.env.set('TELNYX_API_KEY', ' from-env ');
assert.equal(await telnyxSetting(vault({ data: null, error: { message: 'down' } }), 'TELNYX_API_KEY'), 'from-env', 'the function secret wins and Vault is not needed');

console.log('telnyx-settings: ok');
