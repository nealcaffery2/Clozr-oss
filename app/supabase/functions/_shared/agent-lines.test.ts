// Local presence numbers: picking the number local to a lead, and the SIP
// connection, the number order and the ElevenLabs import against a fake
// Telnyx and ElevenLabs. Run:
//   npx tsx supabase/functions/_shared/agent-lines.test.ts
import {
  AREA_CODE_STATE, EL_SIP_HOST, TelnyxError, areaCodeOf, cleanAreaCode, cleanCovers, cleanLabel, defaultLabel, pickLocalNumber, elImportBody, ensureSipConnection, fqdnConnectionBody, importToEleven, orderNumber,
  pickOutboundProfile, sipCredentials,
} from './agent-lines.ts';

let failed = 0;
let passed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++;
  else { failed++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
}

type Call = { method: string; url: string; body: unknown };
function fake(routes: (c: Call) => { status?: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const c = { method: String(init?.method ?? 'GET'), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = routes(c) ?? { status: 404, body: { errors: [{ detail: `no route ${c.method} ${c.url}` }] } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

// ---- Cleaning -------------------------------------------------------------------------------------
eq('label trims and collapses', cleanLabel('  Riley \n · AI   line ', 'x'), 'Riley · AI line');
eq('label falls back', cleanLabel('   ', 'Riley · AI line'), 'Riley · AI line');
eq('label max 60', cleanLabel('a'.repeat(80), 'x').length, 60);
eq('area code ok', cleanAreaCode('(864)'), '864');
eq('area code bad first digit', cleanAreaCode('164'), null);
eq('area code too long', cleanAreaCode('8645'), null);
eq('default label', defaultLabel('Houston'), 'AI · Houston');
eq('area code of formats', [areaCodeOf('+1 (832) 555-0100'), areaCodeOf('8325550100'), areaCodeOf('18325550100'), areaCodeOf('555-0100'), areaCodeOf(null)], ['832', '832', '832', null, null]);
eq('covers keeps main first, unique, clean', cleanCovers('214', '972, 214 817 x 123'), ['214', '972', '817']);
eq('area code state', [AREA_CODE_STATE['979'], AREA_CODE_STATE['864'], AREA_CODE_STATE['999']], ['TX', 'SC', undefined]);

// ---- Local presence -------------------------------------------------------------------------------
{
  const row = (market: string, state: string, area_code: string, covers: string[], el: string | null, status: 'active' | 'wanted' = 'active') =>
    ({ market, state, area_code, covers, status, el_phone_number_id: el, phone_number: `+1${area_code}5550000` });
  const pool = [
    row('Dallas-Fort Worth', 'TX', '214', ['214', '469', '972', '817'], 'ph_dfw'),
    row('Houston', 'TX', '832', ['832', '713', '281'], 'ph_hou'),
    row('Upstate SC', 'SC', '864', ['864'], 'ph_sc'),
    row('Atlanta', 'GA', '404', ['404', '678', '770'], null, 'wanted'),
  ];
  eq('exact area code', pickLocalNumber(pool, '(832) 555-1212')?.el_phone_number_id, 'ph_hou');
  eq('covered area code', pickLocalNumber(pool, '817-555-1212')?.market, 'Dallas-Fort Worth');
  eq('why area code', pickLocalNumber(pool, '713 555 1212')?.why, 'area_code');
  eq('same state by area code map', pickLocalNumber(pool, '979-555-1212')?.why, 'state');
  eq('same state picks a TX number', pickLocalNumber(pool, '979-555-1212')?.el_phone_number_id, 'ph_dfw');
  eq('explicit state wins for unknown area code', pickLocalNumber(pool, '999-555-1212', 'sc')?.el_phone_number_id, 'ph_sc');
  eq('not live yet is skipped', pickLocalNumber(pool, '404-555-1212'), null);
  eq('nothing local', pickLocalNumber(pool, '415-555-1212'), null);
  eq('no phone, no state', pickLocalNumber(pool, null), null);
  eq('empty pool', pickLocalNumber([], '832-555-1212'), null);
}
const creds = sipCredentials(11, (n) => 'A'.repeat(n));
eq('sip creds', creds, { username: 'clozrai11aaaaaa', password: 'A'.repeat(28) });
eq('outbound profile prefers talkr', pickOutboundProfile([{ id: '1', name: 'Default', enabled: true }, { id: '2', name: 'talkr-outbound', enabled: true }]), '2');
eq('outbound profile skips disabled', pickOutboundProfile([{ id: '1', name: 'talkr', enabled: false }, { id: '3', name: 'x' }]), '3');
eq('outbound profile none', pickOutboundProfile([]), null);

// ---- Bodies ---------------------------------------------------------------------------------------
const fb = fqdnConnectionBody() as Record<string, any>;
eq('fqdn create: tcp, formats, no profile or auth fields', [fb.transport_protocol, fb.inbound.ani_number_format, 'outbound' in fb, 'user_name' in fb], ['TCP', '+E.164', false, false]);
const ib = elImportBody('+18645550100', 'Riley · AI line', 'agent_1', creds) as Record<string, any>;
eq('el import', [ib.provider, ib.phone_number, ib.label, ib.agent_id, ib.outbound_trunk_config.address, ib.outbound_trunk_config.transport, ib.outbound_trunk_config.credentials.username], ['sip_trunk', '+18645550100', 'Riley · AI line', 'agent_1', 'sip.telnyx.com', 'tcp', creds.username]);
eq('el import ACL has no credentials', 'credentials' in (elImportBody('+1', 'l', null, null) as any).outbound_trunk_config, false);

// ---- The connection -------------------------------------------------------------------------------
type Conn = { id: string; connection_name: string; user_name: string | null; outbound: { outbound_voice_profile_id: string | null } };
function telnyxWorld(start: Conn[] = [], fqdnsOn: string[] = []) {
  const conns = new Map(start.map((c) => [c.id, c]));
  const fqdns = new Set(fqdnsOn);
  let n = 0;
  const t = fake((c) => {
    const u = new URL(c.url);
    const path = u.pathname.replace('/v2', '');
    if (path === '/outbound_voice_profiles') return { body: { data: [{ id: 'p1', name: 'talkr-outbound', enabled: true }] } };
    if (path === '/fqdn_connections' && c.method === 'GET') {
      const q = u.searchParams.get('filter[connection_name][contains]') ?? '';
      return { body: { data: [...conns.values()].filter((x) => x.connection_name.includes(q)) } };
    }
    if (path === '/fqdn_connections' && c.method === 'POST') {
      if ((c.body as any).outbound) return { status: 422, body: { errors: [{ detail: 'must be fully configured before assigning an outbound profile' }] } };
      const id = `c${++n}`; const conn = { id, connection_name: (c.body as any).connection_name, user_name: null, outbound: { outbound_voice_profile_id: null } };
      conns.set(id, conn); return { body: { data: conn } };
    }
    const m = path.match(/^\/fqdn_connections\/(.+)$/);
    if (m) {
      const conn = conns.get(decodeURIComponent(m[1]));
      if (!conn) return { status: 404, body: { errors: [{ detail: 'not found' }] } };
      if (c.method === 'PATCH') {
        const b = c.body as any;
        if (b.user_name) conn.user_name = b.user_name;
        if (b.outbound?.outbound_voice_profile_id) {
          if (!fqdns.has(conn.id) || !conn.user_name) return { status: 422, body: { errors: [{ detail: 'must be fully configured before assigning an outbound profile' }] } };
          conn.outbound.outbound_voice_profile_id = b.outbound.outbound_voice_profile_id;
        }
      }
      return { body: { data: conn } };
    }
    if (path === '/fqdns' && c.method === 'GET') return { body: { data: fqdns.has(u.searchParams.get('filter[connection_id]') ?? '') ? [{ fqdn: EL_SIP_HOST }] : [] } };
    if (path === '/fqdns' && c.method === 'POST') { fqdns.add((c.body as any).connection_id); return { body: { data: { id: 'f' } } }; }
    return undefined;
  });
  return { t, conns, fqdns };
}
{
  // New: made bare, FQDN added, credentials set, then the profile (Telnyx's order).
  const w = telnyxWorld();
  const r = await ensureSipConnection({ apiKey: 'k', fetchFn: w.t.fn }, 11, { sip_connection_id: null, sip_username: null, sip_password: null });
  const conn = w.conns.get(r.state.sip_connection_id!)!;
  eq('new connection ready', [conn.user_name === r.creds.username, conn.outbound.outbound_voice_profile_id, w.fqdns.has(conn.id)], [true, 'p1', true]);
  eq('state carries creds', [r.state.sip_username, r.state.sip_password?.length], [r.creds.username, 28]);
  const fq = w.t.calls.find((c) => c.method === 'POST' && c.url.endsWith('/fqdns'))!.body as any;
  eq('fqdn points at elevenlabs', [fq.fqdn, fq.port, fq.dns_record_type], [EL_SIP_HOST, 5060, 'a']);
}
{
  // Made by hand (or a run that stopped halfway), not stored: adopted by name, given our creds.
  const w = telnyxWorld([{ id: 'hand', connection_name: 'CLOZR AI agents (ElevenLabs)', user_name: 'someoneelse', outbound: { outbound_voice_profile_id: 'p9' } }], ['hand']);
  const r = await ensureSipConnection({ apiKey: 'k', fetchFn: w.t.fn }, 11, { sip_connection_id: null, sip_username: null, sip_password: null });
  eq('adopted by name', r.state.sip_connection_id, 'hand');
  eq('our creds replace unknown ones', w.conns.get('hand')!.user_name, r.creds.username);
  eq('no second connection, fqdn not re-added, profile kept', [w.conns.size, w.t.calls.filter((c) => c.method === 'POST').length, w.conns.get('hand')!.outbound.outbound_voice_profile_id], [1, 0, 'p9']);
}
{
  // Stored and intact: reused with nothing changed.
  const w = telnyxWorld([{ id: 'old', connection_name: 'CLOZR AI agents (ElevenLabs)', user_name: 'u1', outbound: { outbound_voice_profile_id: 'p1' } }], ['old']);
  const r = await ensureSipConnection({ apiKey: 'k', fetchFn: w.t.fn }, 11, { sip_connection_id: 'old', sip_username: 'u1', sip_password: 'pw' });
  eq('reused', [r.state, r.creds], [{ sip_connection_id: 'old', sip_username: 'u1', sip_password: 'pw' }, { username: 'u1', password: 'pw' }]);
  eq('reuse writes nothing', w.t.calls.filter((c) => c.method !== 'GET').length, 0);
}
{
  // Stored but deleted in the portal: a new one.
  const w = telnyxWorld();
  const r = await ensureSipConnection({ apiKey: 'k', fetchFn: w.t.fn }, 11, { sip_connection_id: 'gone', sip_username: 'u', sip_password: 'p' });
  eq('deleted → recreated', [r.state.sip_connection_id !== 'gone', r.creds.username !== 'u'], [true, true]);
}
{
  // Telnyx drops the credentials: say so instead of wiring numbers that cannot call out.
  const t = fake((c) => {
    if (c.url.includes('connection_name')) return { body: { data: [{ id: 'x', connection_name: 'CLOZR AI agents (ElevenLabs)', user_name: null, outbound: {} }] } };
    if (c.url.includes('/fqdns')) return { body: { data: [{ fqdn: EL_SIP_HOST }] } };
    if (c.method === 'PATCH') return { body: { data: { id: 'x', user_name: null } } };
    return undefined;
  });
  let msg = '';
  try { await ensureSipConnection({ apiKey: 'k', fetchFn: t.fn }, 11, { sip_connection_id: null, sip_username: null, sip_password: null }); } catch (e) { msg = (e as Error).message; }
  eq('dropped creds is an error', /did not keep the SIP credentials/.test(msg), true);
}

// ---- The number -----------------------------------------------------------------------------------
{
  const t = fake((c) => {
    if (c.url.includes('/available_phone_numbers')) return { body: { data: [{ phone_number: '+18645550100' }] } };
    if (c.url.endsWith('/number_orders')) return { body: { data: { id: 'ord1' } } };
    return undefined;
  });
  const o = await orderNumber({ apiKey: 'k', fetchFn: t.fn }, '864', 'conn1', 'Riley · AI line');
  eq('ordered', o, { phone: '+18645550100', orderId: 'ord1' });
  const q = new URL(t.calls[0].url).searchParams;
  eq('search by area code', [q.get('filter[national_destination_code]'), q.get('filter[country_code]'), q.get('filter[features][]')], ['864', 'US', 'voice']);
  eq('order on connection, named', t.calls[1].body, { phone_numbers: [{ phone_number: '+18645550100' }], connection_id: 'conn1', customer_reference: 'Riley · AI line' });
}
{
  const t = fake((c) => (c.url.includes('/available_phone_numbers') ? { body: { data: [] } } : undefined));
  let msg = '';
  try { await orderNumber({ apiKey: 'k', fetchFn: t.fn }, '999', 'c', 'l'); } catch (e) { msg = e instanceof TelnyxError ? e.message : 'other'; }
  eq('none free says so', /no local number free in 999/.test(msg), true);
}
{
  // Telnyx errors never echo the key.
  const t = fake(() => ({ status: 401, body: { errors: [{ detail: 'bad key secretkey' }] } }));
  let msg = '';
  try { await orderNumber({ apiKey: 'secretkey', fetchFn: t.fn }, '864', 'c', 'l'); } catch (e) { msg = (e as Error).message; }
  eq('key redacted', msg.includes('secretkey'), false);
}

// ---- ElevenLabs -----------------------------------------------------------------------------------
{
  const t = fake((c) => (c.method === 'POST' && c.url.endsWith('/v1/convai/phone-numbers') ? { body: { phone_number_id: 'phnum_1' } } : undefined));
  const id = await importToEleven({ apiKey: 'el', fetchFn: t.fn }, '+18645550100', 'Riley · AI line', 'agent_1', creds);
  eq('imported', id, 'phnum_1');
  eq('import body', (t.calls[0].body as any).label, 'Riley · AI line');
}

// ---- Fallbacks seen live (2026-10-04) --------------------------------------------------------
{
  // 210 has nothing free (Telnyx answers with an error): the next covered area code is used.
  const t = fake((c) => {
    if (c.url.includes('national_destination_code%5D=210') || c.url.includes('national_destination_code]=210')) return { status: 400, body: { errors: [{ detail: 'No numbers found for the given filters. Please try again with best_effort=true.' }] } };
    if (c.url.includes('/available_phone_numbers')) return { body: { data: [{ phone_number: '+17265550100' }] } };
    if (c.url.endsWith('/number_orders')) return { body: { data: { id: 'ord' } } };
    return undefined;
  });
  const o = await orderNumber({ apiKey: 'k', fetchFn: t.fn }, ['210', '210', '726', '830'], 'c', 'AI · San Antonio');
  eq('falls back to a covered area code', o.phone, '+17265550100');
  eq('tries 210 then 726, once each', t.calls.filter((c) => c.url.includes('available_phone_numbers')).length, 2);
}
{
  const t = fake(() => ({ status: 400, body: { errors: [{ detail: 'No numbers found for the given filters.' }] } }));
  let msg = '';
  try { await orderNumber({ apiKey: 'k', fetchFn: t.fn }, ['210', '726'], 'c', 'l'); } catch (e) { msg = (e as Error).message; }
  eq('none in any area code says which were tried', /210, 726/.test(msg), true);
}
{
  // Already in ElevenLabs (an earlier run imported it): adopted, put on the agent, named.
  const t = fake((c) => {
    if (c.method === 'POST' && c.url.endsWith('/v1/convai/phone-numbers')) return { status: 400, body: { detail: { message: 'Phone number +18325550167 already exists.' } } };
    if (c.method === 'GET' && c.url.endsWith('/v1/convai/phone-numbers')) return { body: [{ phone_number: '+18325550167', phone_number_id: 'phnum_hou' }, { phone_number: '+12145550100', phone_number_id: 'phnum_x' }] };
    if (c.method === 'PATCH' && c.url.endsWith('/v1/convai/phone-numbers/phnum_hou')) return { body: {} };
    return undefined;
  });
  const id = await importToEleven({ apiKey: 'el', fetchFn: t.fn }, '+18325550167', 'AI · Houston', 'agent_r', creds);
  eq('adopts the existing id', id, 'phnum_hou');
  eq('assigns and names it', t.calls.find((c) => c.method === 'PATCH')!.body, { label: 'AI · Houston', agent_id: 'agent_r' });
}

console.log(`agent-lines: ${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) throw new Error(`${failed} failed`);
