-- 244 · body_preview: a list row's snippet without the email body.
--
-- The Inbox's email lists read 500 messages with their full HTML bodies on
-- every load and every live change (megabytes, mostly markup nobody sees in
-- a list). They now leave `body` out and ask for `body_preview`, a computed
-- column (PostgREST exposes a function over the row type as a field), and
-- read bodies only for the thread that is opened (components/inbox/data.ts
-- useThreadBodies).
--
-- The first 300 characters of the body as text: <style> and <script> blocks
-- dropped, tags turned to spaces, the common entities decoded, whitespace
-- folded. Computed per row read, nothing stored, so no table rewrite. Until
-- this is applied the lists read without a preview (data.ts retries without
-- the column).
create or replace function public.body_preview(c public.communications)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(left(btrim(regexp_replace(
    replace(replace(replace(replace(replace(
      regexp_replace(
        -- One pass per tag, each wholly non-greedy, so two <style> blocks
        -- do not take the text between them (a back-reference made the RE
        -- greedy); then a block the 20,000-character cut left open.
        regexp_replace(
          regexp_replace(
            regexp_replace(left(coalesce(c.body, ''), 20000), '<style.*?</style\s*>', ' ', 'gi'),
            '<script.*?</script\s*>', ' ', 'gi'),
          '<(style|script)[^>]*>.*$', ' ', 'i'),
        '<[^>]*>', ' ', 'g'),
      '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&#39;', ''''),
    '\s+', ' ', 'g')), 300), '');
$$;

revoke all on function public.body_preview(public.communications) from public, anon;
grant execute on function public.body_preview(public.communications) to authenticated, service_role;

-- PostgREST learns the new field on its next schema reload; ask for it now.
notify pgrst, 'reload schema';
