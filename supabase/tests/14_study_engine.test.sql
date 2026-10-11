-- The study engine (20261009120000_study_engine.sql): the private `sources` bucket and its folder
-- policies; source_files.storage_path pinned to the source's own folder; sources.status kept by the
-- server; topics.status; cards.source_id derived from the source chunk; the tracy_events columns the
-- phone reads and cannot write; the worker's claim / release and the stale-job reap; the monthly caps
-- per stage in enqueue_tracy_event and requeue_tracy_event (the month a unit counts in, and a job
-- that ran stays counted); the list of orphaned files; and the cron kick, which calls the worker only
-- when there is work and Vault holds its URL and secret.
begin;
create extension if not exists pgtap with schema extensions;
select plan(111);

-- Runs one write and returns how many rows it changed. RLS hides other people's rows from UPDATE
-- (0 rows, no error), so that is how "cannot modify" is asserted.
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

-- Runs a statement that must fail and returns what the Edge Function would see: SQLSTATE, message,
-- hint and the detail (parsed as JSON when it is JSON).
create function pg_temp.error_of(statement text) returns jsonb
language plpgsql as $$
declare
  state text;
  msg text;
  hint text;
  detail text;
begin
  execute statement;
  return null;
exception when others then
  get stacked diagnostics state = returned_sqlstate, msg = message_text, hint = pg_exception_hint,
                          detail = pg_exception_detail;
  return jsonb_build_object('code', state, 'message', msg, 'hint', hint,
                            'detail', case when detail like '{%' then detail::jsonb else to_jsonb(detail) end);
end;
$$;

-- The body of a recorded pg_net request as JSON (pg_net stores it as bytea; the test stubs as jsonb).
create function pg_temp.request_body(request_id bigint) returns jsonb
language sql as $$
  select case when left(b, 2) = '\x' then convert_from(decode(substr(b, 3), 'hex'), 'UTF8')::jsonb
              else b::jsonb end
  from (select to_jsonb(q) ->> 'body' as b from net.http_request_queue q where q.id = request_id) r;
$$;

-- The first day of next month (UTC), as the cap error reports it.
create function pg_temp.next_month() returns text
language sql stable as $$
  select to_char(date_trunc('month', now() at time zone 'UTC') + interval '1 month',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Ada and Bob, each with private sources, a plan and (Bob) a private chunk Ada cannot read.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');
insert into public.sources (id, owner_id, kind, title) values
  ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'pdf', 'Lecture 1'),
  ('a1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'pdf', 'Lecture 2'),
  ('a1000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'link', 'Article'),
  ('b1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'pdf', 'Bob private');
insert into public.source_chunks (id, source_id, page, content) values
  ('c1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 3, 'Cells divide.'),
  ('c1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 7, 'Mitochondria.'),
  ('c1000000-0000-4000-8000-000000000009', 'b1000000-0000-4000-8000-000000000001', 1, 'Bob only.');
insert into public.study_plans (id, owner_id, title, scope) values
  ('d1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Biology', 'cumulative'),
  ('d1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Reading', 'single'),
  ('d1000000-0000-4000-8000-000000000009', '22222222-2222-4222-8222-222222222222', 'Bob', 'single');

-- The bucket -----------------------------------------------------------------------------------------
select results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'sources'$$,
  $$values (false, 26214400::bigint, array['application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png',
    'image/webp'])$$,
  'the sources bucket is private, 25 MiB per file, and takes PDF, DOCX, JPEG, PNG and WebP'
);

-- The kick with nothing to do --------------------------------------------------------------------------
select is(private.kick_tracy_worker(), null, 'no queued job: the cron kick makes no request');
select is(private.kick_tracy_worker('sweep'), null, 'no orphaned file: the daily sweep makes no request');
select is_empty($$select 1 from net.http_request_queue$$, '... and nothing was sent');

-- Storage policies: each user in their own folder ---------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('sources', '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/1.pdf',
            '11111111-1111-4111-8111-111111111111')$$,
  'a user uploads into their own folder'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('sources', '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/2.jpg',
            '11111111-1111-4111-8111-111111111111')$$,
  '... a second file (abandoned: no file row will point at it)'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('sources', '22222222-2222-4222-8222-222222222222/b1000000-0000-4000-8000-000000000001/1.pdf',
            '11111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'a user cannot upload into someone else''s folder'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('sources', '1.pdf', '11111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'a file at the bucket root (no owner folder) is refused'
);
reset role;
insert into storage.objects (bucket_id, name, owner_id) values
  ('sources', '22222222-2222-4222-8222-222222222222/b1000000-0000-4000-8000-000000000001/1.pdf',
   '22222222-2222-4222-8222-222222222222');
set local role authenticated;
select results_eq(
  $$select name from storage.objects order by name$$,
  $$values ('11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/1.pdf'),
           ('11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/2.jpg')$$,
  'a user sees only their own files'
);
select is(
  pg_temp.affected($$update storage.objects set metadata = '{}' where bucket_id = 'sources'$$),
  2::bigint,
  'a user can overwrite only their own files'
);

-- source_files.storage_path: <owner_id>/<source_id>/<file name> ------------------------------------------
select lives_ok(
  $$insert into public.source_files (id, source_id, owner_id, storage_path, page)
    values ('71000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
            '11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/1.pdf', 1)
    on conflict (id) do update set source_id = excluded.source_id, owner_id = excluded.owner_id,
      storage_path = excluded.storage_path, page = excluded.page$$,
  'PUT: a file row inside its own source''s folder is accepted'
);
select throws_ok(
  $$insert into public.source_files (source_id, owner_id, storage_path)
    values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222/b1000000-0000-4000-8000-000000000001/1.pdf')$$,
  '23514', null,
  'a file row pointing into someone else''s folder is refused (the worker would read it as you)'
);
select throws_ok(
  $$insert into public.source_files (source_id, owner_id, storage_path)
    values ('a1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
            '22222222-2222-4222-8222-222222222222/a1000000-0000-4000-8000-000000000001/1.pdf')$$,
  '23514', null,
  '... also when the row claims that owner (owner_id is copied from the source first)'
);
select throws_ok(
  $$insert into public.source_files (source_id, owner_id, storage_path)
    values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000002/1.pdf')$$,
  '23514', null,
  'a file row pointing into another source''s folder is refused'
);
select throws_ok(
  $$insert into public.source_files (source_id, owner_id, storage_path)
    values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/x/../1.pdf')$$,
  '23514', null,
  'the file name is a plain name (no subfolders or ..)'
);
select throws_ok(
  $$insert into public.source_files (source_id, owner_id, storage_path)
    values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/')$$,
  '23514', null,
  'the file name is not empty'
);
select throws_ok(
  $$update public.source_files
       set storage_path = '22222222-2222-4222-8222-222222222222/b1000000-0000-4000-8000-000000000001/1.pdf'
     where id = '71000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'PATCH: a file row cannot be pointed at someone else''s file either'
);

-- sources.status belongs to the server ------------------------------------------------------------------
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, status)
    values ('a1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'notes', 'Notes',
            'ready')
    on conflict (id) do update set owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
      status = excluded.status$$,
  'PUT: the phone creates a source, sending status ready'
);
select is(
  (select status from public.sources where id = 'a1000000-0000-4000-8000-000000000003'),
  'pending',
  '... it is stored as pending'
);
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
update public.sources set status = 'processing' where id = 'a1000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title, status)
    values ('a1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'notes', 'Notes',
            'pending')
    on conflict (id) do update set owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
      status = excluded.status$$,
  'a retried PUT of the same source still uploads'
);
select is(
  pg_temp.affected($$update public.sources set title = 'Week 1 notes', status = 'ready'
    where id = 'a1000000-0000-4000-8000-000000000003'$$),
  1::bigint,
  'PATCH: the owner renames the source, also sending a status'
);
select results_eq(
  $$select title, status from public.sources where id = 'a1000000-0000-4000-8000-000000000003'$$,
  $$values ('Week 1 notes', 'processing')$$,
  'the rename is stored; the status stays what the server set (neither back to pending nor ready)'
);
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
update public.sources set status = 'ready' where id = 'a1000000-0000-4000-8000-000000000003';
select is(
  (select status from public.sources where id = 'a1000000-0000-4000-8000-000000000003'),
  'ready',
  'the service role (the worker) moves the status on'
);
reset role;

-- topics.status -------------------------------------------------------------------------------------------
-- The study builder (server) proposes a draft topic.
insert into public.topics (id, plan_id, title, position, status)
values ('e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Cells', 0, 'draft');
select throws_ok(
  $$update public.topics set status = 'bogus' where id = 'e1000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'topics.status is draft, confirmed or ready'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select lives_ok(
  $$insert into public.topics (id, plan_id, title, position)
    values ('e1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'My own topic', 1)
    on conflict (id) do update set plan_id = excluded.plan_id, title = excluded.title,
      position = excluded.position$$,
  'PUT: the owner adds a topic by hand'
);
select is(
  (select status from public.topics where id = 'e1000000-0000-4000-8000-000000000002'),
  'ready',
  '... which is ready at once'
);
select is(
  pg_temp.affected($$update public.topics set status = 'confirmed', title = 'Cell division'
    where id = 'e1000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: the owner keeps (and renames) a draft topic'
);
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
select is(
  pg_temp.affected($$update public.topics set status = 'draft' where id = 'e1000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'someone else cannot change the topic'
);
reset role;

-- cards.source_id is derived from the source chunk ---------------------------------------------------------
-- The worker inserts a card from chunk 1 (Lecture 1), sending a wrong source_id.
insert into public.cards (id, topic_id, plan_id, source_chunk_id, page, question, answer, source_id)
values ('f1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
        'd1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 3, 'Q1', 'A1',
        'a1000000-0000-4000-8000-000000000002');
select is(
  (select source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000001'),
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'insert: source_id comes from the chunk, whatever the writer sends'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select lives_ok(
  $$update public.cards set source_id = 'a1000000-0000-4000-8000-000000000002'
     where id = 'f1000000-0000-4000-8000-000000000001'$$,
  'PATCH of source_id does not fail ...'
);
select is(
  (select source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000001'),
  'a1000000-0000-4000-8000-000000000001'::uuid,
  '... but cannot repoint it'
);
select lives_ok(
  $$update public.cards set source_chunk_id = 'c1000000-0000-4000-8000-000000000002'
     where id = 'f1000000-0000-4000-8000-000000000001'$$,
  'PATCH: the owner points the card at another readable chunk'
);
select is(
  (select source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000001'),
  'a1000000-0000-4000-8000-000000000002'::uuid,
  '... which re-derives source_id'
);
select lives_ok(
  $$update public.cards set source_chunk_id = 'c1000000-0000-4000-8000-000000000009'
     where id = 'f1000000-0000-4000-8000-000000000001'$$,
  'PATCH to a chunk the owner cannot read does not fail'
);
select results_eq(
  $$select source_chunk_id, source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000001'$$,
  $$values (null::uuid, 'a1000000-0000-4000-8000-000000000002'::uuid)$$,
  '... the chunk is stored as null and source_id is kept'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, plan_id, question, answer, source_id)
    values ('f1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002',
            'd1000000-0000-4000-8000-000000000001', 'Q2', 'A2', 'b1000000-0000-4000-8000-000000000001')
    on conflict (id) do update set topic_id = excluded.topic_id, plan_id = excluded.plan_id,
      question = excluded.question, answer = excluded.answer, source_id = excluded.source_id$$,
  'PUT of a hand-made card with a forged source_id does not fail'
);
select is(
  (select source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000002'),
  null::uuid,
  '... and the card has no source'
);
reset role;
update public.cards set source_chunk_id = 'c1000000-0000-4000-8000-000000000002'
 where id = 'f1000000-0000-4000-8000-000000000001';
delete from public.source_chunks where id = 'c1000000-0000-4000-8000-000000000002';
select results_eq(
  $$select source_chunk_id, source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000001'$$,
  $$values (null::uuid, 'a1000000-0000-4000-8000-000000000002'::uuid)$$,
  'chunk deleted (re-extraction): the card keeps its source'
);
update public.cards set source_chunk_id = 'c1000000-0000-4000-8000-000000000001'
 where id = 'f1000000-0000-4000-8000-000000000001';
select lives_ok(
  $$delete from public.sources where id = 'a1000000-0000-4000-8000-000000000002'$$,
  'deleting a source that cards cite does not fail'
);
select is(
  (select source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000001'),
  'a1000000-0000-4000-8000-000000000001'::uuid,
  '... and leaves cards of other sources alone'
);
update public.cards set source_chunk_id = 'c1000000-0000-4000-8000-000000000001'
 where id = 'f1000000-0000-4000-8000-000000000002';
delete from public.sources where id = 'a1000000-0000-4000-8000-000000000001';
select results_eq(
  $$select source_chunk_id, source_id from public.cards where id = 'f1000000-0000-4000-8000-000000000002'$$,
  $$values (null::uuid, null::uuid)$$,
  'source deleted (chunks cascade): chunk and source_id are both null'
);
-- Lecture 1 again, with its file, for the sections below.
insert into public.sources (id, owner_id, kind, title)
values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'pdf', 'Lecture 1');
insert into public.source_files (id, source_id, storage_path)
values ('71000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/1.pdf');

-- tracy_events: new columns are server-written ------------------------------------------------------------
select throws_ok(
  $$insert into public.tracy_events (user_id, job, stage)
    values ('11111111-1111-4111-8111-111111111111', 'study_builder', 'bogus')$$,
  '23514', null,
  'tracy_events.stage is one of the pipeline''s stages'
);
select throws_ok(
  $$insert into public.tracy_events (user_id, job, stage)
    values ('11111111-1111-4111-8111-111111111111', 'handwriting', 'cards')$$,
  '23514', null,
  'a stage belongs to its job (handwriting only transcribes)'
);
insert into public.tracy_events (id, user_id, job, stage, status, plan_id, source_id)
values ('90000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'study_builder',
        'extract', 'succeeded', 'd1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004');
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select results_eq(
  $$select job, stage, plan_id, source_id from public.tracy_events$$,
  $$values ('study_builder', 'extract', 'd1000000-0000-4000-8000-000000000002'::uuid,
            'a1000000-0000-4000-8000-000000000004'::uuid)$$,
  'the user reads which plan, source and stage their job is for'
);
select throws_ok(
  $$update public.tracy_events set stage = 'cards' where id = '90000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the device cannot write tracy_events.stage'
);
select throws_ok(
  $$update public.tracy_events set plan_id = 'd1000000-0000-4000-8000-000000000001'
     where id = '90000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the device cannot write tracy_events.plan_id'
);
select throws_ok(
  $$update public.tracy_events set source_id = 'a1000000-0000-4000-8000-000000000001'
     where id = '90000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the device cannot write tracy_events.source_id'
);
select is(
  pg_temp.affected($$update public.tracy_events set accepted = true where id = '90000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'the device still records whether the user accepted a result'
);
reset role;
delete from public.study_plans where id = 'd1000000-0000-4000-8000-000000000002';
delete from public.sources where id = 'a1000000-0000-4000-8000-000000000004';
select results_eq(
  $$select plan_id, source_id, accepted from public.tracy_events where id = '90000000-0000-4000-8000-000000000001'$$,
  $$values (null::uuid, null::uuid, true)$$,
  'deleting the plan and the source keeps the job in the history, unlinked'
);

-- The queue: claim, release, reap (PostgREST with a secret key: role service_role, no sub) ------------------
insert into public.tracy_events (id, user_id, job, stage, status, created_at) values
  ('90000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'study_builder', 'extract',
   'queued', now() - interval '3 minutes'),
  ('90000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'handwriting', 'transcribe',
   'queued', now() - interval '2 minutes'),
  ('90000000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'study_builder', 'cards',
   'succeeded', now() - interval '4 minutes');
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select results_eq(
  $$select id, status, attempts, locked_at = now() from public.claim_tracy_events(1)$$,
  $$values ('90000000-0000-4000-8000-000000000002'::uuid, 'running', 1, true)$$,
  'claim takes the oldest queued job, marks it running and counts the attempt'
);
select results_eq(
  $$select id from public.claim_tracy_events(5)$$,
  $$values ('90000000-0000-4000-8000-000000000003'::uuid)$$,
  'the next claim gets the next queued job only'
);
select is_empty($$select * from public.claim_tracy_events(5)$$, 'nothing left to claim');
select is(
  public.release_tracy_event('90000000-0000-4000-8000-000000000003', 2), false,
  'release is fenced: a run that does not hold the job (other attempts) cannot put it back'
);
select is(
  public.release_tracy_event('90000000-0000-4000-8000-000000000003', 1), true,
  'release puts a claimed job back (Tracy was asleep) ...'
);
select results_eq(
  $$select status, attempts, locked_at from public.tracy_events where id = '90000000-0000-4000-8000-000000000003'$$,
  $$values ('queued', 0, null::timestamptz)$$,
  '... queued again, without counting the attempt'
);
select is(
  (select releases from public.tracy_events where id = '90000000-0000-4000-8000-000000000003'), 1,
  '... and counts the release (the worker fails a job that keeps finding Tracy unreachable)'
);
select results_eq(
  $$select id, attempts from public.claim_tracy_events(5)$$,
  $$values ('90000000-0000-4000-8000-000000000003'::uuid, 1)$$,
  'the released job is claimed again by the next run'
);
reset role;
update public.tracy_events set locked_at = now() - interval '6 minutes'
 where id = '90000000-0000-4000-8000-000000000002';
update public.tracy_events set locked_at = now() - interval '6 minutes', attempts = 3
 where id = '90000000-0000-4000-8000-000000000003';
set local role service_role;
select results_eq(
  $$select id, attempts from public.claim_tracy_events(5)$$,
  $$values ('90000000-0000-4000-8000-000000000002'::uuid, 2)$$,
  'a job stuck in running for 5 minutes (its worker died) is queued again and claimed'
);
select results_eq(
  $$select status, error, locked_at from public.tracy_events where id = '90000000-0000-4000-8000-000000000003'$$,
  $$values ('failed', 'This step took too long. Try again.', null::timestamptz)$$,
  'a job stuck after its third attempt fails with a short message the phone shows'
);
select is(
  public.release_tracy_event('90000000-0000-4000-8000-000000000003', 3), false,
  'a job that is not running cannot be released'
);
reset role;
-- At most p_max_running jobs at once (job 2 is running now, locked a moment ago).
insert into public.tracy_events (id, user_id, job, stage, status, created_at) values
  ('90000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'study_builder', 'outline',
   'queued', now() - interval '1 minute'),
  ('90000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'study_builder', 'cards',
   'queued', now() - interval '30 seconds');
set local role service_role;
select is_empty(
  $$select * from public.claim_tracy_events(5, 1)$$,
  'with one job running and room for one, nothing more is claimed (Tracy on Render free runs one at a time)'
);
select results_eq(
  $$select id from public.claim_tracy_events(5, 2)$$,
  $$values ('90000000-0000-4000-8000-000000000005'::uuid)$$,
  'room for two: one more job is claimed, however many were asked for'
);
reset role;
update public.tracy_events set locked_at = now() - interval '4 minutes'
 where id in ('90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000005');
set local role service_role;
select results_eq(
  $$select id from public.claim_tracy_events(5, 1)$$,
  $$values ('90000000-0000-4000-8000-000000000006'::uuid)$$,
  'a run locked more than 3 minutes ago (its worker is gone) no longer takes up a place'
);
reset role;
-- Cards jobs are background work: a page of notes added after an outline review goes first.
insert into public.tracy_events (id, user_id, job, stage, status, created_at) values
  ('90000000-0000-4000-8000-000000000007', '11111111-1111-4111-8111-111111111111', 'study_builder', 'cards',
   'queued', now() - interval '2 minutes'),
  ('90000000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111', 'handwriting', 'transcribe',
   'queued', now() - interval '1 minute');
set local role service_role;
select results_eq(
  $$select id from public.claim_tracy_events(1)$$,
  $$values ('90000000-0000-4000-8000-000000000008'::uuid)$$,
  'a queued transcription is claimed before an older queued cards job'
);
select results_eq(
  $$select id from public.claim_tracy_events(1)$$,
  $$values ('90000000-0000-4000-8000-000000000007'::uuid)$$,
  '... which comes next'
);
reset role;

-- The monthly caps (Bob, free tier) ----------------------------------------------------------------------
-- Last month's sources do not count this month.
insert into public.tracy_events (user_id, job, stage, status, cap_units, created_at, counted_at)
values ('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract', 'succeeded', 5,
        (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') - interval '1 day',
        (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') - interval '1 day');
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select results_eq(
  $$select job, stage, status, attempts, cap_units, plan_id, source_id, input
      from public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract',
             '{"cursor_page": 1}', 'd1000000-0000-4000-8000-000000000009', 'b1000000-0000-4000-8000-000000000001',
             1, 3)$$,
  $$values ('study_builder', 'extract', 'queued', 0, 1, 'd1000000-0000-4000-8000-000000000009'::uuid,
            'b1000000-0000-4000-8000-000000000001'::uuid, '{"cursor_page": 1}'::jsonb)$$,
  'enqueue under the free limit queues the job with its plan, source, stage and one cap unit'
);
select throws_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract', '{}',
      p_free_limit => 1, p_paid_limit => 3)$$,
  'P0001', 'monthly limit reached for extract',
  'a second source this month is over the free limit'
);
select is(
  pg_temp.error_of($$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder',
      'extract', '{}', p_free_limit => 1, p_paid_limit => 3)$$) - 'message',
  jsonb_build_object('code', 'P0001', 'hint', 'dualrep_cap_reached',
                     'detail', jsonb_build_object('stage', 'extract', 'used', 1, 'limit', 1,
                                                  'resets_at', pg_temp.next_month())),
  'the refusal says which cap, how much is used and when it resets (first of next month, UTC)'
);
select results_eq(
  $$select status, cap_units from public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222',
      'study_builder', 'extract', '{"cursor_page": 21}', p_source_id => 'b1000000-0000-4000-8000-000000000001')$$,
  $$values ('queued', 0)$$,
  'a job queued without limits (the next window of the same PDF, outline, cards) is neither capped nor counted'
);
select lives_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'handwriting', 'transcribe',
      '{"pages": [1, 2, 3, 4]}', p_free_limit => 5, p_paid_limit => 50, p_units => 4)$$,
  'transcribe counts pages: 4 of 5'
);
select throws_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'handwriting', 'transcribe',
      '{"pages": [5, 6]}', p_free_limit => 5, p_paid_limit => 50, p_units => 2)$$,
  'P0001', 'monthly limit reached for transcribe',
  '2 more pages would pass the limit, so nothing is queued'
);
select lives_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'handwriting', 'transcribe',
      '{"pages": [5]}', p_free_limit => 5, p_paid_limit => 50, p_units => 1)$$,
  '1 more page fits exactly; each stage has its own count (the extract cap is already full)'
);
reset role;
update public.tracy_events set status = 'cancelled', attempts = 1
 where user_id = '22222222-2222-4222-8222-222222222222' and stage = 'extract' and cap_units = 1;
set local role service_role;
select throws_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract', '{}',
      p_free_limit => 1, p_paid_limit => 3)$$,
  'P0001', 'monthly limit reached for extract',
  'a job cancelled after the worker had started it still counts'
);
reset role;
update public.tracy_events set attempts = 0
 where user_id = '22222222-2222-4222-8222-222222222222' and stage = 'extract' and cap_units = 1;
set local role service_role;
select lives_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract', '{}',
      p_free_limit => 1, p_paid_limit => 3)$$,
  'a job cancelled before it ever ran gives its unit back'
);
select throws_ok(
  $$select * from public.requeue_tracy_event(
      (select id from public.tracy_events where user_id = '22222222-2222-4222-8222-222222222222' and stage = 'extract'
          and status = 'cancelled'), 1, 3)$$,
  'P0001', 'monthly limit reached for extract',
  'retrying a job whose unit was given back (cancelled before it ran) goes through the cap again'
);
reset role;
update public.entitlements set tier = 'subscription', expires_at = null
 where user_id = '22222222-2222-4222-8222-222222222222';
set local role service_role;
select lives_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract', '{}',
      p_free_limit => 1, p_paid_limit => 3)$$,
  'a subscriber gets the paid limit'
);
reset role;
update public.tracy_events set input = input || '{"previous_errors": ["topics[0] is missing"]}'
 where user_id = '22222222-2222-4222-8222-222222222222' and stage = 'extract' and status = 'cancelled';
set local role service_role;
select results_eq(
  $$select status, attempts, error, locked_at, releases, cap_units, input from public.requeue_tracy_event(
      (select id from public.tracy_events where user_id = '22222222-2222-4222-8222-222222222222' and stage = 'extract'
          and status = 'cancelled'), 1, 3)$$,
  $$values ('queued', 0, null::text, null::timestamptz, 0, 1, '{"cursor_page": 1}'::jsonb)$$,
  'under the limit the same job is queued again: fresh attempts, its unit taken again, no old notes'
);
select is_empty(
  $$select * from public.requeue_tracy_event(
      (select id from public.tracy_events where user_id = '22222222-2222-4222-8222-222222222222' and stage = 'extract'
          and input = '{"cursor_page": 1}'), 1, 3)$$,
  'only a failed or cancelled job can be queued again'
);
select results_eq(
  $$select cap_units from public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder',
      'extract', '{}', p_free_limit => 1, p_paid_limit => null)$$,
  $$values (1)$$,
  'no limit for the user''s tier: the job is counted but never refused'
);
select throws_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'study_builder', 'extract', '{}',
      p_free_limit => 1, p_paid_limit => 3, p_units => -1)$$,
  '22023', null,
  'a negative number of units is refused'
);
select throws_ok(
  $$select public.enqueue_tracy_event('22222222-2222-4222-8222-222222222222', 'handwriting', 'outline', '{}')$$,
  '23514', null,
  'enqueue refuses a stage that does not belong to the job'
);
reset role;
-- A unit counts in the month it was taken (Ada, free tier, a page limit of 1). Two pages queued and
-- cancelled before they ran last month gave their units back; "Try again" after the 1st takes them
-- again, in this month.
insert into public.tracy_events (id, user_id, job, stage, status, cap_units, created_at, counted_at)
select ('93000000-0000-4000-8000-00000000000' || n)::uuid, '11111111-1111-4111-8111-111111111111',
       'handwriting', 'transcribe', 'cancelled', 1, last_month, last_month
  from generate_series(1, 2) n,
       lateral (select (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') - interval '2 days'
                  as last_month) m;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select results_eq(
  $$select status, counted_at = now() from public.requeue_tracy_event('93000000-0000-4000-8000-000000000001', 1, 50)$$,
  $$values ('queued', true)$$,
  'retrying a page cancelled before it ran last month takes its unit again, counted in this month ...'
);
select throws_ok(
  $$select * from public.requeue_tracy_event('93000000-0000-4000-8000-000000000002', 1, 50)$$,
  'P0001', 'monthly limit reached for transcribe',
  '... so the second one no longer fits under the limit of 1 ...'
);
select throws_ok(
  $$select public.enqueue_tracy_event('11111111-1111-4111-8111-111111111111', 'handwriting', 'transcribe', '{}',
      p_free_limit => 1, p_paid_limit => 50)$$,
  'P0001', 'monthly limit reached for transcribe',
  '... and neither does a new page'
);
reset role;
-- A job that ran stays counted. The worker ran page 1 and it was cancelled while Tracy read it.
update public.tracy_events set status = 'cancelled', attempts = 1 where id = '93000000-0000-4000-8000-000000000001';
set local role service_role;
select results_eq(
  $$select status, attempts, ran from public.requeue_tracy_event('93000000-0000-4000-8000-000000000001', 1, 50)$$,
  $$values ('queued', 0, true)$$,
  '"Try again" on a job that ran starts its attempts over but keeps that it ran ...'
);
reset role;
update public.tracy_events set status = 'cancelled' where id = '93000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $$select public.enqueue_tracy_event('11111111-1111-4111-8111-111111111111', 'handwriting', 'transcribe', '{}',
      p_free_limit => 1, p_paid_limit => 50)$$,
  'P0001', 'monthly limit reached for transcribe',
  '... so cancelling it again while it waits (attempts 0) does not give its unit back'
);
select results_eq(
  $$select status from public.requeue_tracy_event('93000000-0000-4000-8000-000000000001', 1, 50)$$,
  $$values ('queued')$$,
  '... and trying it once more needs no room: its unit is still taken'
);
reset role;

-- Approving an outline: all of it in one transaction ------------------------------------------------------
insert into public.topics (id, plan_id, title, position, status) values
  ('e2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Draft A', 3, 'draft'),
  ('e2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'Draft B', 4, 'draft'),
  ('e2000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', 'Studied', 0, 'ready');
insert into public.cards (id, topic_id, question, answer)
values ('f2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000003', 'Q?', 'A.');
insert into public.tracy_events (id, user_id, job, stage, status, plan_id, source_id, output) values
  ('92000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'study_builder', 'outline', 'succeeded',
   'd1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   '{"phase": "saved", "topics": [], "approved_at": null}');
set local role service_role;
select throws_ok(
  $$select public.apply_outline_approval('d1000000-0000-4000-8000-000000000001',
      '[{"id": "e2000000-0000-4000-8000-000000000001", "title": "Cells", "position": 5}]',
      array['e2000000-0000-4000-8000-000000000002']::uuid[],
      '[{"id": "92000000-0000-4000-8000-000000000002", "user_id": "11111111-1111-4111-8111-111111111111", "job": "study_builder",
         "stage": "cards", "plan_id": "d1000000-0000-4000-8000-000000000001",
         "source_id": "a1000000-0000-4000-8000-000000000001",
         "input": {"topic_id": "e2000000-0000-4000-8000-000000000001"}},
        {"id": "92000000-0000-4000-8000-000000000003", "user_id": "11111111-1111-4111-8111-111111111111", "job": "study_builder",
         "stage": "cards", "plan_id": "d1000000-0000-4000-8000-000000000001",
         "source_id": "a1000000-0000-4000-8000-000000000001",
         "input": {"topic_id": "e2000000-0000-4000-8000-000000000001"}},
        {"id": "92000000-0000-4000-8000-000000000004", "user_id": "11111111-1111-4111-8111-111111111111", "job": "handwriting",
         "stage": "cards"}]',
      array['92000000-0000-4000-8000-000000000001']::uuid[], '2026-10-09T12:00:00.000Z', '{}')$$,
  '23514', null,
  'a write that fails halfway (here a bad job row) ...'
);
select results_eq(
  $$select id, title, status from public.topics where id::text like 'e2000000%' order by id$$,
  $$values ('e2000000-0000-4000-8000-000000000001'::uuid, 'Draft A', 'draft'),
           ('e2000000-0000-4000-8000-000000000002'::uuid, 'Draft B', 'draft'),
           ('e2000000-0000-4000-8000-000000000003'::uuid, 'Studied', 'ready')$$,
  '... changes nothing: the drafts are still there for the phone to send the review again'
);
select lives_ok(
  $$select public.apply_outline_approval('d1000000-0000-4000-8000-000000000001',
      '[{"id": "e2000000-0000-4000-8000-000000000001", "title": "Cells", "position": 5}]',
      array['e2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000003']::uuid[],
      '[{"id": "92000000-0000-4000-8000-000000000002", "user_id": "11111111-1111-4111-8111-111111111111", "job": "study_builder",
         "stage": "cards", "plan_id": "d1000000-0000-4000-8000-000000000001",
         "source_id": "a1000000-0000-4000-8000-000000000001",
         "input": {"topic_id": "e2000000-0000-4000-8000-000000000001"}},
        {"id": "92000000-0000-4000-8000-000000000003", "user_id": "11111111-1111-4111-8111-111111111111", "job": "study_builder",
         "stage": "cards", "plan_id": "d1000000-0000-4000-8000-000000000001",
         "source_id": "a1000000-0000-4000-8000-000000000001",
         "input": {"topic_id": "e2000000-0000-4000-8000-000000000001"}}]', array['92000000-0000-4000-8000-000000000001']::uuid[],
      '2026-10-09T12:00:00.000Z', array['a1000000-0000-4000-8000-000000000001']::uuid[])$$,
  'the review is applied in one call'
);
select results_eq(
  $$select id, title, position, status from public.topics where id::text like 'e2000000%' order by id$$,
  $$values ('e2000000-0000-4000-8000-000000000001'::uuid, 'Cells', 5, 'confirmed'),
           ('e2000000-0000-4000-8000-000000000003'::uuid, 'Studied', 0, 'ready')$$,
  'the kept draft is confirmed with its name and place; the cut draft is gone; a topic that is no longer a draft is never cut'
);
select is(
  (select count(*) from public.cards where id = 'f2000000-0000-4000-8000-000000000001'), 1::bigint,
  '... so its cards stay'
);
select results_eq(
  $$select id, status, attempts, created_at - now() from public.tracy_events
     where id::text like '92000000%' and stage = 'cards' order by created_at$$,
  $$values ('92000000-0000-4000-8000-000000000002'::uuid, 'queued', 0, interval '0'),
           ('92000000-0000-4000-8000-000000000003'::uuid, 'queued', 0, interval '1 millisecond')$$,
  'the cards jobs are queued in order'
);
select results_eq(
  $$select output ->> 'approved_at', output ->> 'phase' from public.tracy_events
     where id = '92000000-0000-4000-8000-000000000001'$$,
  $$values ('2026-10-09T12:00:00.000Z', 'saved')$$,
  'the outline is marked approved and keeps the rest of its saved answer'
);
select is(
  (select status from public.sources where id = 'a1000000-0000-4000-8000-000000000001'), 'ready',
  'a source with nothing kept is ready'
);
select lives_ok(
  $$select public.apply_outline_approval('d1000000-0000-4000-8000-000000000001',
      '[{"id": "e2000000-0000-4000-8000-000000000001", "title": "Cells", "position": 5}]', '{}',
      '[{"id": "92000000-0000-4000-8000-000000000002", "user_id": "11111111-1111-4111-8111-111111111111", "job": "study_builder",
         "stage": "cards", "plan_id": "d1000000-0000-4000-8000-000000000001",
         "source_id": "a1000000-0000-4000-8000-000000000001",
         "input": {"topic_id": "e2000000-0000-4000-8000-000000000001"}},
        {"id": "92000000-0000-4000-8000-000000000003", "user_id": "11111111-1111-4111-8111-111111111111", "job": "study_builder",
         "stage": "cards", "plan_id": "d1000000-0000-4000-8000-000000000001",
         "source_id": "a1000000-0000-4000-8000-000000000001",
         "input": {"topic_id": "e2000000-0000-4000-8000-000000000001"}}]', array['92000000-0000-4000-8000-000000000001']::uuid[],
      '2026-10-09T12:00:00.000Z', '{}')$$,
  'sending the same review again ...'
);
select is(
  (select count(*) from public.tracy_events where id::text like '92000000%' and stage = 'cards'), 2::bigint,
  '... queues nothing twice'
);
reset role;

-- Privileges ---------------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'public.claim_tracy_events(integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.release_tracy_event(uuid, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.requeue_tracy_event(uuid, integer, integer)', 'EXECUTE'),
  'the phone cannot claim, release or requeue jobs'
);
select ok(
  not has_function_privilege('authenticated',
    'public.apply_outline_approval(uuid, jsonb, uuid[], jsonb, uuid[], text, uuid[])', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.apply_outline_approval(uuid, jsonb, uuid[], jsonb, uuid[], text, uuid[])', 'EXECUTE'),
  'the phone cannot apply an outline review directly (only the study function can, after checking ownership)'
);
select ok(
  not has_function_privilege('authenticated',
    'public.enqueue_tracy_event(uuid, text, text, jsonb, uuid, uuid, integer, integer, integer)', 'EXECUTE'),
  'the phone cannot queue jobs (only the study function can, after checking ownership)'
);
select ok(
  not has_function_privilege('authenticated', 'public.orphaned_source_objects(integer)', 'EXECUTE'),
  'the phone cannot list other people''s files'
);
select ok(
  not has_function_privilege('service_role', 'private.kick_tracy_worker(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.kick_tracy_worker(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.kick_tracy_worker(text)', 'EXECUTE'),
  'only the database (cron) runs the kick'
);
select ok(
  not has_function_privilege('service_role', 'private.check_tracy_cap(uuid, text, integer, integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.check_tracy_cap(uuid, text, integer, integer, integer)', 'EXECUTE'),
  'the cap check runs only inside the queue functions'
);
select ok(
  not has_schema_privilege('anon', 'private', 'USAGE')
  and not has_schema_privilege('authenticated', 'private', 'USAGE')
  and not has_schema_privilege('service_role', 'private', 'USAGE'),
  'no API role may use the private schema'
);
select ok(
  not has_function_privilege('authenticated', 'public.copy_card_source_id()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.keep_server_source_status()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.copy_card_source_id()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.keep_server_source_status()', 'EXECUTE'),
  'nobody executes the new trigger functions directly'
);

-- Orphaned files ----------------------------------------------------------------------------------------
update storage.objects set created_at = now() - interval '4 days'
 where name like '%/1.pdf' or name like '%/2.jpg';
insert into storage.objects (bucket_id, name, owner_id) values
  ('sources', '11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000003/9.jpg',
   '11111111-1111-4111-8111-111111111111');
set local role service_role;
select results_eq(
  $$select name from public.orphaned_source_objects(100) order by name$$,
  $$values ('11111111-1111-4111-8111-111111111111/a1000000-0000-4000-8000-000000000001/2.jpg'),
           ('22222222-2222-4222-8222-222222222222/b1000000-0000-4000-8000-000000000001/1.pdf')$$,
  'files older than 3 days that no file row points at are listed for removal (not newer ones)'
);
reset role;
select throws_ok(
  $$delete from storage.objects$$,
  '42501', 'Direct deletion from storage tables is not allowed. Use the Storage API instead.',
  'SQL deletes on storage.objects are refused, so the sweep goes through the Storage API'
);

-- The cron kick ------------------------------------------------------------------------------------------
-- Queued work exists now (the enqueue tests), but Vault does not hold the worker's URL and secret yet.
set local client_min_messages = error;
select is(private.kick_tracy_worker(), null, 'before the Deploy backend workflow has run, the kick does nothing');
reset client_min_messages;
do $$
begin
  perform vault.create_secret('https://example.supabase.co/', 'dualrep_project_url');
  perform vault.create_secret('s3cret', 'dualrep_worker_secret');
end;
$$;
create temp table kicked on commit drop as
  select private.kick_tracy_worker() as jobs, private.kick_tracy_worker('sweep') as sweep;
select results_eq(
  $$select q.url, q.headers ->> 'x-dualrep-worker-secret', pg_temp.request_body(q.id) ->> 'reason'
      from net.http_request_queue q join kicked k on q.id in (k.jobs, k.sweep) order by q.id$$,
  $$values ('https://example.supabase.co/functions/v1/tracy-worker', 's3cret', 'jobs'),
           ('https://example.supabase.co/functions/v1/tracy-worker', 's3cret', 'sweep')$$,
  'with work queued (or files to sweep) and Vault set, the kick posts to the worker with the shared secret'
);
select throws_ok(
  $$select private.kick_tracy_worker('nap')$$,
  '22023', null,
  'the kick knows only jobs and sweep'
);
select results_eq(
  $$select jobname, schedule, command from cron.job where jobname like 'dualrep-%' order by jobname$$,
  $$values ('dualrep-cron-history-cleanup', '17 3 * * *',
            'delete from cron.job_run_details where end_time < now() - interval ''7 days'''),
           ('dualrep-storage-sweep', '23 4 * * *', 'select private.kick_tracy_worker(''sweep'')'),
           ('dualrep-tracy-worker', '* * * * *', 'select private.kick_tracy_worker(''jobs'')')$$,
  'cron kicks the worker every minute, sweeps daily and trims its own history'
);

select * from finish();
rollback;
