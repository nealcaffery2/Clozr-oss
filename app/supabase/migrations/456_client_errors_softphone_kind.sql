-- client_errors also records softphone audio stalls (lib/audio-flow-watch.ts).
alter table public.client_errors drop constraint if exists client_errors_kind_check;
alter table public.client_errors
  add constraint client_errors_kind_check check (kind in ('screen', 'app', 'window', 'promise', 'softphone'));
