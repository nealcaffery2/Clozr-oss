-- 449: no kick holds the pg_net worker for more than 5 seconds.
--
-- pg_net 0.20 runs one worker that takes a batch from the request queue
-- and waits for every request in it to finish before it takes the next.
-- wholesaler_chase_kick waited up to 150 s for wholesaler-chase (about
-- 132 s per run), so every hour at :23 the queue stalled for ~2.5 min and
-- the minute ticks (cold-campaign-tick, plan-tick, google-sync) waited.
-- The other long kicks (120 s, 60 s, 30 s, 25 s, 20 s) hold it the same way
-- for as long as their function runs.
--
-- Edge functions keep running after pg_net hangs up: plan-tick and
-- cold-campaign-tick are kicked with 5 s and finish 200 after up to 45 s.
-- Nothing reads these kicks' rows in net._http_response. So every kick
-- posts with 5 s, like the rest. This rewrites the live definitions in
-- place so it lowers only the timeout and keeps whatever else each body
-- has picked up since its migration.

do $$
declare
  f text;
  def text;
begin
  foreach f in array array[
    'compr_photo_sync_kick', 'google_sync_kick', 'dm_cloud_kick',
    'drive_photo_sync_kick', 'ivueit_sweep_kick', 'wholesaler_chase_kick',
    'compr_trial_sync_kick', 'rvm_pool_kick', 'compr_photo_sweep_kick',
    'gmail_fast_kick', 'talkr_line_kick', 'dispogenius_sync_kick'
  ] loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f;
    if def is null then continue; end if;
    execute regexp_replace(def, 'timeout_milliseconds\s*(:=|=>)\s*[0-9]+',
                           'timeout_milliseconds \1 5000', 'g');
  end loop;
end $$;
