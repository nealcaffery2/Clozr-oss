-- 400 · Lane resources: the team's reference docs, readable by Lane.
--
-- The TC Bible, call scripts, title company vetting checklists, SOPs and
-- contract templates lived in Google Docs and people's heads. They now live
-- in CLOZR, under Lane's Resources button, and Lane searches them when it
-- answers ("What do we check when vetting a title company?" is answered from
-- the vetting doc, with the doc named and one tap away).
--
-- resource_categories: the shelves (TC Bible, Training, Scripts, SOPs &
--   checklists, Templates, Title companies, Field agents, Other; the same
--   list as DEFAULT_CATEGORIES in _shared/resource-text.ts).
--   resource_categories_ensure() gives a
--   workspace the defaults the first time anyone opens Resources. Owners and
--   admins rename, add and remove them.
-- resources: one doc. body is its text, extracted when it was added by the
--   lane-resources edge function (PDF, Word, Markdown, plain text, a Google
--   Doc export or pasted text). pinned docs sit at the top of Resources (the
--   TC Bible: TC Training and the Acme Homes TC Handbook, read as one set);
--   owners and admins pin and unpin. file_path is the original in the private
--   `resources` bucket (ws/<workspace>/<uuid>/<file name>); drive_url is the
--   Drive file it came from.
-- resource_chunks: the body cut into sections of about 1,400 characters,
--   each with its heading path, and a weighted tsvector (heading A, text B)
--   for search_resources(). Written only by the edge function and the import
--   script (service role); members read them.
--
-- Members of the workspace read everything. Owners, admins, acquisitions,
-- dispositions and TC add docs (through the function). Owners and admins
-- edit categories and remove docs; whoever added a doc may retitle or
-- re-file it. Safe to re-run.

create table if not exists public.resource_categories (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  name         text   not null check (length(btrim(name)) between 1 and 60),
  position     int    not null default 0,
  created_at   timestamptz not null default now()
);
create unique index if not exists resource_categories_ws_name_idx on public.resource_categories (workspace_id, lower(name));

create table if not exists public.resources (
  id           bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  category_id  bigint references public.resource_categories(id) on delete set null,
  title        text   not null check (length(btrim(title)) between 1 and 200),
  source       text   not null default 'paste' check (source in ('upload', 'paste', 'drive', 'import')),
  file_path    text,
  file_name    text,
  mime_type    text,
  byte_size    bigint,
  drive_url    text,
  pinned       boolean not null default false,
  body         text   not null default '',
  chars        int    generated always as (length(body)) stored,
  created_by   uuid   default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists resources_ws_idx on public.resources (workspace_id, pinned desc, updated_at desc);

create table if not exists public.resource_chunks (
  id           bigint generated always as identity primary key,
  resource_id  bigint not null references public.resources(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  ord          int    not null,
  heading      text   not null default '',
  body         text   not null,
  tsv          tsvector generated always as (
                 setweight(to_tsvector('english'::regconfig, left(heading, 1000)), 'A')
                 || setweight(to_tsvector('english'::regconfig, left(body, 20000)), 'B')) stored
);
create index if not exists resource_chunks_doc_idx on public.resource_chunks (resource_id, ord);
create index if not exists resource_chunks_ws_idx on public.resource_chunks (workspace_id);
create index if not exists resource_chunks_tsv_idx on public.resource_chunks using gin (tsv);

create or replace function public.resources_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create or replace trigger resources_touch before update on public.resources
  for each row execute function public.resources_touch();

alter table public.resource_categories enable row level security;
alter table public.resources enable row level security;
alter table public.resource_chunks enable row level security;

-- Categories: members read; owners and admins write.
drop policy if exists resource_categories_read on public.resource_categories;
create policy resource_categories_read on public.resource_categories for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists resource_categories_admin on public.resource_categories;
create policy resource_categories_admin on public.resource_categories for all to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'))
  with check (public.has_role(workspace_id, 'owner', 'admin'));

-- Docs: members read; writers add; the adder or an admin edits; admins remove.
drop policy if exists resources_read on public.resources;
create policy resources_read on public.resources for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists resources_insert on public.resources;
create policy resources_insert on public.resources for insert to authenticated
  with check (public.has_role(workspace_id, 'owner', 'admin', 'acquisitions', 'dispositions', 'tc'));
drop policy if exists resources_update on public.resources;
create policy resources_update on public.resources for update to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin') or created_by = (select auth.uid()))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists resources_delete on public.resources;
create policy resources_delete on public.resources for delete to authenticated
  using (public.has_role(workspace_id, 'owner', 'admin'));

-- Chunks: members read. Writes come from the service role only.
drop policy if exists resource_chunks_read on public.resource_chunks;
create policy resource_chunks_read on public.resource_chunks for select to authenticated
  using (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.resource_categories to authenticated;
grant select, insert, update, delete on public.resources to authenticated;
grant select on public.resource_chunks to authenticated;

-- The default shelves, once per workspace, for a member.
create or replace function public.resource_categories_ensure(p_workspace bigint)
returns setof public.resource_categories
language plpgsql security definer set search_path = 'public', 'pg_temp' as $$
begin
  if not public.is_workspace_member(p_workspace) then
    raise exception 'not a member of that workspace' using errcode = '42501';
  end if;
  if not exists (select 1 from public.resource_categories c where c.workspace_id = p_workspace) then
    insert into public.resource_categories (workspace_id, name, position)
    select p_workspace, d.name, d.pos
    from (values ('TC Bible', 0), ('Training', 1), ('Scripts', 2), ('SOPs & checklists', 3), ('Templates', 4),
                 ('Title companies', 5), ('Field agents', 6), ('Other', 7)) as d(name, pos)
    on conflict do nothing;
  end if;
  return query select * from public.resource_categories c where c.workspace_id = p_workspace order by c.position, c.id;
end $$;
revoke all on function public.resource_categories_ensure(bigint) from public;
grant execute on function public.resource_categories_ensure(bigint) to authenticated;

-- Full-text search over a workspace's docs, as the caller (RLS applies).
-- A question is matched on any of its words (stemmed, stop words dropped), so
-- "What do we check when vetting a title company?" finds the vetting doc;
-- ts_rank_cd puts the sections that hold most of the words, closest
-- together, first. One section per doc unless p_per_doc says more.
create or replace function public.search_resources(p_workspace bigint, p_query text, p_limit int default 8, p_per_doc int default 2)
returns table (chunk_id bigint, resource_id bigint, title text, category text, heading text, body text, snippet text, rank real)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $$
  with q as (
    select (select string_agg(quote_literal(l), ' | ')
            from unnest(tsvector_to_array(to_tsvector('english'::regconfig, left(coalesce(p_query, ''), 2000)))) as l) as s
  ), tq as (
    select case when s is null then null else s::tsquery end as query from q
  ), hits as (
    select ch.id as chunk_id, ch.resource_id, r.title, c.name as category, ch.heading, ch.body,
           ts_rank_cd(ch.tsv, tq.query) + case when to_tsvector('english'::regconfig, r.title) @@ tq.query then 0.2 else 0 end as rank,
           row_number() over (partition by ch.resource_id order by ts_rank_cd(ch.tsv, tq.query) desc, ch.ord) as n
    from tq
    join public.resource_chunks ch on tq.query is not null and ch.tsv @@ tq.query
    join public.resources r on r.id = ch.resource_id
    left join public.resource_categories c on c.id = r.category_id
    where ch.workspace_id = p_workspace
  ), top as (
    select * from hits where n <= greatest(1, least(coalesce(p_per_doc, 2), 5))
    order by rank desc, chunk_id
    limit greatest(1, least(coalesce(p_limit, 8), 25))
  )
  -- The snippet marks matched words as [[word]] for the panel to highlight.
  select top.chunk_id, top.resource_id, top.title, top.category, top.heading, top.body,
         ts_headline('english'::regconfig, top.body, tq.query, 'MaxWords=40, MinWords=18, MaxFragments=1, StartSel=[[, StopSel=]]') as snippet,
         top.rank::real
  from top cross join tq
  order by top.rank desc, top.chunk_id
$$;
grant execute on function public.search_resources(bigint, text, int, int) to authenticated;

-- The originals: private bucket, folder per workspace.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('resources', 'resources', false, 26214400, array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/markdown', 'text/plain', 'text/x-markdown'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists resources_files_read on storage.objects';
    execute $p$create policy resources_files_read on storage.objects for select to authenticated
      using (bucket_id = 'resources' and split_part(name, '/', 1) = 'ws'
             and public.is_workspace_member(nullif(split_part(name, '/', 2), '')::bigint))$p$;
    execute 'drop policy if exists resources_files_write on storage.objects';
    execute $p$create policy resources_files_write on storage.objects for insert to authenticated
      with check (bucket_id = 'resources' and split_part(name, '/', 1) = 'ws'
             and public.has_role(nullif(split_part(name, '/', 2), '')::bigint, 'owner', 'admin', 'acquisitions', 'dispositions', 'tc'))$p$;
    execute 'drop policy if exists resources_files_delete on storage.objects';
    execute $p$create policy resources_files_delete on storage.objects for delete to authenticated
      using (bucket_id = 'resources' and split_part(name, '/', 1) = 'ws'
             and public.has_role(nullif(split_part(name, '/', 2), '')::bigint, 'owner', 'admin'))$p$;
  end if;
end $$;
