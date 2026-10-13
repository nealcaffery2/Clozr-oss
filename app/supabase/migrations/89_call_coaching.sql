-- 89: native post-call coaching on the call.
--
-- Additive. communications.coaching_review holds the scorecard from
-- lib/call-coaching.ts (overall, talk split, ten categories, keep, three
-- fixes, one better line). call-coach writes it on demand and from the
-- hang-up. call-sync writes it once the recording transcript is in, and
-- replaces a hang-up card that was graded off the live lines.
--
-- Members can already update communications, so no new policy. score_overall
-- stays the grade the record title shows; a native card sets it.

alter table public.communications
  add column if not exists coaching_review jsonb;

comment on column public.communications.coaching_review is
  'Native post-call coaching scorecard (lib/call-coaching.ts). Null until a transcript is coached.';
