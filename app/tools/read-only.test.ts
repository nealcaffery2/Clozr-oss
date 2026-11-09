// The "View as" write guard (lib/read-only): which Supabase requests a
// read-only preview refuses. Run: npx tsx tools/read-only.test.ts
import { isSupabaseWrite } from '../lib/read-only';

const BASE = 'https://your-project-ref.supabase.co';
let failed = 0;
function check(name: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — write: ${got}, want ${want}`);
}

// supabase-js sends every rpc() as POST; the read ones must get through.
for (const fn of ['people_page', 'record_stage_history', 'stage_history_ids', 'rvm_send_preview', 'plan_progress_inputs', 'talkr_elsewhere', 'team_stoplight', 'search_communications', 'inbox_search', 'address_key']) {
  check(`rpc ${fn} is a read`, isSupabaseWrite(`${BASE}/rest/v1/rpc/${fn}`, 'POST', '{}'), false);
}
// The ones that insert, update or delete stay refused.
for (const fn of ['match_buyer', 'match_deal', 'rvm_send_now', 'sms_campaign_fill', 'plan_set_active', 'crm_edit_tags', 'set_line_caller_id', 'request_contract', 'not_a_known_function']) {
  check(`rpc ${fn} is a write`, isSupabaseWrite(`${BASE}/rest/v1/rpc/${fn}`, 'POST', '{}'), true);
}
check('GET on a table is a read', isSupabaseWrite(`${BASE}/rest/v1/sellers?select=id`, 'GET', undefined), false);
check('PATCH on a table is a write', isSupabaseWrite(`${BASE}/rest/v1/sellers?id=eq.1`, 'PATCH', '{"name":"x"}'), true);
check('DELETE on a table is a write', isSupabaseWrite(`${BASE}/rest/v1/tasks?id=eq.1`, 'DELETE', undefined), true);
check('signing a storage URL is a read', isSupabaseWrite(`${BASE}/storage/v1/object/sign/deal-files/a.pdf`, 'POST', '{}'), false);
check('uploading to storage is a write', isSupabaseWrite(`${BASE}/storage/v1/object/deal-files/a.pdf`, 'POST', '{}'), true);
check('token refresh is a read', isSupabaseWrite(`${BASE}/auth/v1/token?grant_type=refresh_token`, 'POST', '{}'), false);
check('changing the account is a write', isSupabaseWrite(`${BASE}/auth/v1/user`, 'PUT', '{}'), true);
check('clozr-today edge function is a read', isSupabaseWrite(`${BASE}/functions/v1/clozr-today`, 'POST', '{}'), false);
check('ask-clozr without read_only is a write', isSupabaseWrite(`${BASE}/functions/v1/ask-clozr`, 'POST', '{"q":"x"}'), true);
check('ask-clozr with read_only is a read', isSupabaseWrite(`${BASE}/functions/v1/ask-clozr`, 'POST', '{"q":"x","read_only":true}'), false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
