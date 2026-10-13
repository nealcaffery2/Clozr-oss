-- Per-person switches for floor-show notifications. Default on, which is
-- the behavior already shipping: a pass still toasts, a badge still takes
-- the screen. The person updates their own row (profiles_update_own).

alter table public.profiles
  add column if not exists notify_leaderboard boolean not null default true,
  add column if not exists notify_badges boolean not null default true;

comment on column public.profiles.notify_leaderboard is
  'When false, this person gets no leaderboard pass toast and no Leaderboard bell row.';
comment on column public.profiles.notify_badges is
  'When false, this person gets no badge popup, toast, sound, catch-up, or Badge bell row.';
