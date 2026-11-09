import { concurrentIndexNames, runsOutsideTransaction, splitStatements, stripComments } from '../scripts/sql-split.mjs';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

eq('two statements, comments dropped', splitStatements(`-- a header; with a semicolon
create index concurrently if not exists a on t (x);

-- between
drop index concurrently if exists b;
`), ['-- a header; with a semicolon\ncreate index concurrently if not exists a on t (x);', '-- between\ndrop index concurrently if exists b;']);

eq('a dollar-quoted body stays whole', splitStatements(`create function f() returns int language sql as $$ select 1; select 2; $$;
select f();`), ['create function f() returns int language sql as $$ select 1; select 2; $$;', 'select f();']);

eq('tagged dollar quotes and string semicolons', splitStatements(`do $body$ begin perform 1; end $body$;
insert into t values ('a;b', 'it''s; fine');`), ['do $body$ begin perform 1; end $body$;', "insert into t values ('a;b', 'it''s; fine');"]);

eq('a block comment with a semicolon', splitStatements('/* one; two */ select 1;'), ['/* one; two */ select 1;']);
eq('a trailing statement without a semicolon', splitStatements('select 1;\nselect 2'), ['select 1;', 'select 2']);
eq('comments only', splitStatements('-- nothing here;\n'), []);
eq('a dollar tag with digits', splitStatements('create function f() returns int language sql as $fn1$ select 1; $fn1$;\nselect 2;'), ['create function f() returns int language sql as $fn1$ select 1; $fn1$;', 'select 2;']);
eq("an E'' string with a backslash-escaped quote", splitStatements("select E'a\\';b';\nselect 3;"), ["select E'a\\';b';", 'select 3;']);
eq('a quoted identifier with a semicolon', splitStatements('create index "a;b" on t (x);\nselect 4;'), ['create index "a;b" on t (x);', 'select 4;']);
eq('a word ending in e is not an E string', splitStatements("select type'x';\nselect 5;"), ["select type'x';", 'select 5;']);

eq('stripComments drops line and block comments and keeps strings', stripComments(`-- head; concurrently
select 'a -- not a comment', "x /* nor this */"; /* gone */ select $$ -- kept $$;`), `
select 'a -- not a comment', "x /* nor this */";  select $$ -- kept $$;`);

eq('a CONCURRENTLY statement runs outside a transaction', runsOutsideTransaction('create index concurrently if not exists a on t (x);'), true);
eq('so does drop index concurrently after a comment', runsOutsideTransaction('-- x\ndrop index concurrently if exists public.a;'), true);
eq('and create unique index concurrently', runsOutsideTransaction('create unique index concurrently a on t (x);'), true);
eq('and vacuum', runsOutsideTransaction('select 1;\nvacuum analyze t;'), true);
eq('the word in a comment keeps the transaction', runsOutsideTransaction(`-- Created live with CONCURRENTLY ahead of this file; a no-op here.
create index if not exists a on t (x);`), false);
eq('the word in a block comment or a string keeps the transaction', runsOutsideTransaction(`/* built concurrently by hand */
insert into notes values ('ran concurrently');`), false);
eq('a plain file keeps the transaction', runsOutsideTransaction('create table t (x int);\nalter table t add y int;'), false);

eq('concurrentIndexNames reads every CREATE INDEX CONCURRENTLY name once', concurrentIndexNames(`-- drop index concurrently old_idx is not a create
create extension if not exists pg_trgm with schema extensions;
create index concurrently if not exists Buyers_Name_Trgm_Idx on public.buyers using gin (name extensions.gin_trgm_ops);
create unique index concurrently public."Mixed Case" on t (x);
create index concurrently plain_idx
  on public.deals (workspace_id, updated_at);
create index concurrently if not exists plain_idx on t (y);
drop index concurrently if exists public.gone_idx;
create index if not exists not_concurrent_idx on t (z);`), ['buyers_name_trgm_idx', 'Mixed Case', 'plain_idx']);
eq('concurrentIndexNames ignores comments and a file without one', concurrentIndexNames('-- create index concurrently if not exists in_a_comment on t (x);\nselect 1;'), []);
