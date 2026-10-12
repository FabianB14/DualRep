-- Text sources (20261012120000_text_sources.sql): sources.kind 'text' and sources.body, the text kept
-- for the phone to show again. body is only for 'text', 1 to 30,000 characters, published to
-- PowerSync with the rest of the row, and owned by the server (a phone's value is ignored, never
-- refused; a source with text also keeps its kind). A text source counts against the monthly source
-- cap through its extract job, exactly like a PDF.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

-- Runs one write and returns how many rows it changed (a write the server rewrites still counts).
create function pg_temp.affected(statement text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute statement;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Ada owns group G with Mia; Xena is an outsider.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'mia@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'xena@example.com');
insert into public.groups (id, owner_id, name)
values ('30000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'G');
insert into public.group_members (group_id, user_id, role)
values ('30000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'member');

-- The column ----------------------------------------------------------------------------------------
select col_type_is('public', 'sources', 'body', 'text', 'sources.body is text');
select col_is_null('public', 'sources', 'body', 'sources.body is nullable (nothing for PowerSync to backfill)');
select col_hasnt_default('public', 'sources', 'body', 'sources.body has no default');
select ok(
  (select 'body' = any(attnames) from pg_publication_tables
    where pubname = 'powersync' and schemaname = 'public' and tablename = 'sources'),
  'the powersync publication carries sources.body (no column list)'
);

-- What the server (the study function, service role) may store ------------------------------------
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'text',
            'Spoken notes', 'Osmosis moves water across a membrane.')$$,
  'the study function stores a text source with its text'
);
select throws_ok(
  $$insert into public.sources (id, owner_id, kind, title)
    values ('a1000000-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111', 'audio', 'x')$$,
  '23514', null,
  'kind is still checked: only pdf, doc, link, notes and text'
);
select throws_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'pdf', 'x', 'text')$$,
  '23514', null,
  'only a text source has a body'
);
select throws_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'text', 'x', '')$$,
  '23514', null,
  'an empty body is refused'
);
select throws_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'text', 'x',
            repeat('a', 30001))$$,
  '23514', null,
  'a body over 30,000 characters is refused'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'text', 'x',
            repeat('é', 30000))$$,
  '30,000 characters are accepted, counted as characters (60,000 bytes here), not bytes'
);
select throws_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    select 'a1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'text', 'x',
           ('{"t": "a\u0000b"}'::jsonb) ->> 't'$$,
  '22P05', null,
  'a NUL character in JSON never reaches the column (so the study function strips control characters)'
);
select lives_ok(
  $$update public.sources set body = 'Corrected by the server.' where id = 'a1000000-0000-4000-8000-000000000001'$$,
  'the service role may change the text'
);
reset role;

-- What a phone (authenticated) may do: body is ignored, never refused --------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'notes', 'Notes',
            'a body on a notes source')
    on conflict (id) do update set owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
      body = excluded.body$$,
  'PUT: a phone creates a source sending a body (on a kind that may not have one)'
);
select is(
  (select body from public.sources where id = 'a1000000-0000-4000-8000-000000000004'),
  null,
  '... it is stored without one (ignored, not refused)'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'text', 'Mine',
            'typed on the phone')
    on conflict (id) do update set owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
      body = excluded.body$$,
  'PUT: a phone creates a text source itself (the app never does; the study function does)'
);
select results_eq(
  $$select body, status from public.sources where id = 'a1000000-0000-4000-8000-000000000005'$$,
  $$values (null::text, 'pending')$$,
  '... it has no text and stays pending: only the study function stores text'
);
select is(
  pg_temp.affected($$update public.sources set title = 'Week 1, spoken', body = 'rewritten on the phone'
    where id = 'a1000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: the owner renames a text source, also sending a new body'
);
select results_eq(
  $$select title, body from public.sources where id = 'a1000000-0000-4000-8000-000000000001'$$,
  $$values ('Week 1, spoken', 'Corrected by the server.')$$,
  '... the rename is stored; the text stays what the server stored'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, body)
    values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'text',
            'Week 1, spoken', null)
    on conflict (id) do update set owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
      body = excluded.body$$,
  'a retried PUT of the same source sending body null still uploads'
);
select is(
  (select body from public.sources where id = 'a1000000-0000-4000-8000-000000000001'),
  'Corrected by the server.',
  '... and does not erase the text'
);
select is(
  pg_temp.affected($$update public.sources set kind = 'pdf' where id = 'a1000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: a phone changes the kind of a source that has text'
);
select results_eq(
  $$select kind, body from public.sources where id = 'a1000000-0000-4000-8000-000000000001'$$,
  $$values ('text', 'Corrected by the server.')$$,
  '... it stays a text source with its text (a refused write would be dropped on the phone)'
);
select is(
  pg_temp.affected($$update public.sources set kind = 'pdf' where id = 'a1000000-0000-4000-8000-000000000004'$$),
  1::bigint,
  'PATCH: a phone changes the kind of a source without text'
);
select is(
  (select kind from public.sources where id = 'a1000000-0000-4000-8000-000000000004'),
  'pdf',
  '... which is stored as before: only a source with text keeps its kind'
);
select is(
  pg_temp.affected($$update public.sources set group_id = '30000000-0000-4000-8000-000000000001'
    where id = 'a1000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'the owner shares the text source with group G'
);

-- Who reads the text: the owner and group members, like a set of notes' transcripts ---------------------
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
select is(
  (select body from public.sources where id = 'a1000000-0000-4000-8000-000000000001'),
  'Corrected by the server.',
  'a group member reads the text of a shared text source'
);
set local request.jwt.claims to '{"sub": "33333333-3333-4333-8333-333333333333", "role": "authenticated"}';
select is_empty(
  $$select 1 from public.sources where id = 'a1000000-0000-4000-8000-000000000001'$$,
  'an outsider sees neither the source nor its text'
);
reset role;

-- The cap: a text source is one source of the month, through its extract job ----------------------------
select lives_ok(
  $$select public.enqueue_tracy_event(
      p_user_id => '11111111-1111-4111-8111-111111111111', p_job => 'study_builder', p_stage => 'extract',
      p_input => '{"kind": "text", "cursor_page": 1}', p_source_id => 'a1000000-0000-4000-8000-000000000001',
      p_free_limit => 1, p_paid_limit => 1)$$,
  'a text source''s extract job takes 1 of a limit of 1'
);
select throws_ok(
  $$select public.enqueue_tracy_event(
      p_user_id => '11111111-1111-4111-8111-111111111111', p_job => 'study_builder', p_stage => 'extract',
      p_input => '{"kind": "pdf", "cursor_page": 1}', p_source_id => 'a1000000-0000-4000-8000-000000000002',
      p_free_limit => 1, p_paid_limit => 1)$$,
  'P0001', null,
  '... so the next source of the month (a PDF here) is over the limit'
);

select * from finish();
rollback;
