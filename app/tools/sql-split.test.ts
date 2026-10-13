import { splitStatements } from '../scripts/sql-split.mjs';

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
