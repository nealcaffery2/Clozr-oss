-- 389: each rep's default dialer script. The Dialer opens on the script whose
-- title is profiles.default_script, whatever kind of contact is on the line,
-- and the rep changes it with "Make default" on the script panel
-- (DialerScreen useDefaultScript). Alex dials Compr prospects: his starts
-- on "Compr: cold call". Safe to re-run.

alter table public.profiles add column if not exists default_script text;

update public.profiles
   set default_script = 'Compr: cold call'
 where email = 'alex@yourcompany.com'
   and default_script is null;
