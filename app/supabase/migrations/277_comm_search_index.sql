-- 277 · A full-text index over every call, text, email and voicemail, so a rep
-- can search what was said across all their records ("roof", "divorce",
-- "foreclosure") instead of one call at a time.
--
-- comm_search_doc() is the searchable text of one communications row: the
-- subject (weight A), the call summary (B), the message body with any HTML
-- tags stripped and the call transcript (C). Each part is capped so a long
-- transcript or a pasted newsletter stays under the tsvector size limit. It is
-- IMMUTABLE (explicit 'english' config), so the index below and the search in
-- 278 (search_communications) use the same expression.
--
-- CONCURRENTLY, so the runner applies this file outside a transaction, one
-- statement at a time (227 is the pattern). The build reads every
-- communications row once. A concurrent build that failed leaves an INVALID index
-- under the same name, which `if not exists` then skips: drop that one by hand
-- (drop index concurrently communications_search_idx) and run again.

create or replace function public.comm_search_doc(subject text, summary text, body text, transcript text)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  select setweight(to_tsvector('english'::regconfig, left(coalesce(subject, ''), 1000)), 'A')
      || setweight(to_tsvector('english'::regconfig, left(coalesce(summary, ''), 20000)), 'B')
      || setweight(to_tsvector('english'::regconfig, left(regexp_replace(coalesce(body, ''), '<[^>]*>', ' ', 'g'), 100000)), 'C')
      || setweight(to_tsvector('english'::regconfig, left(coalesce(transcript, ''), 200000)), 'C')
$$;

create index concurrently if not exists communications_search_idx
  on public.communications using gin (public.comm_search_doc(subject, summary, body, transcript));
