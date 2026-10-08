-- Optional references a client writes are NORMALIZED, never refused: a reference to a row the writer
-- may not use, or to a row that does not exist, is stored as null (an offline write must never be
-- dropped because of something someone else did meanwhile).
-- * Judged when SET (and never again): exercise_sets.exercise_id, study_sessions.plan_id and
--   cards.source_chunk_id may name someone else's shared row, which can later become unreadable. A
--   row that already holds such a reference keeps it on every later PATCH and on a PowerSync PUT
--   re-send; a NEW or CHANGED unreadable reference is stored as null.
-- * Own rows only (always judged; a stored value is always valid): workout_sessions.preset_id /
--   setup_id, profiles.default_preset_id / default_setup_id, transitions.workout_session_id,
--   reviews.interval_block_id.
-- * A missing id and an unreadable id are stored alike (nothing is revealed about other people's
--   rows), and server-side writers (service role, SQL) are not rewritten.
-- * Required (NOT NULL) parent references are still refused (42501).
-- The offline scenarios (leave / unshare / removal / delete before the upload) are in
-- 12_offline_uploads.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

-- Runs one write and returns how many rows it changed.
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

-- Olive hosts group G with Mia; Xena is an outsider. Everyone's own rows are set up directly.
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'mia@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'xena@example.com');
insert into public.groups (id, owner_id, name)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'G');
insert into public.group_members (group_id, user_id, role)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member');

insert into public.exercises (id, name, origin, owner_id, group_id, dataset_id, reviewed) values
  ('b0000000-0000-4000-8000-000000000001', 'Push-up', 'dataset', null, null, 'Pushups', true),
  ('b0000000-0000-4000-8000-000000000002', 'Odd lift', 'dataset', null, null, 'Odd_Lift', false),
  ('b0000000-0000-4000-8000-000000000011', 'Olive secret', 'user', '10000000-0000-4000-8000-000000000001', null, null, false),
  ('b0000000-0000-4000-8000-000000000012', 'Olive press', 'user', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', null, false);
insert into public.presets (id, owner_id, name, split) values
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Olive''s',
   '{"lower": 50, "upper": 50, "core": 0, "cardio": 0}'),
  ('a0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'Xena''s',
   '{"lower": 50, "upper": 50, "core": 0, "cardio": 0}');
insert into public.equipment_setups (id, user_id, name, location) values
  ('e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Olive gym', 'gym'),
  ('e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'Xena home', 'home');
insert into public.workout_sessions (id, user_id, kind) values
  ('e2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'full'),
  ('e2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'full'),
  ('e2000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'micro');
insert into public.study_sessions (id, user_id) values
  ('e4000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  ('e4000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');
insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes) values
  ('e5000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'e4000000-0000-4000-8000-000000000001', 25),
  ('e5000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   'e4000000-0000-4000-8000-000000000003', 25);
insert into public.study_plans (id, owner_id, group_id, title, scope) values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null, 'Olive private', 'single'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'Olive group', 'single'),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', null, 'Mia''s', 'single'),
  ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', null, 'Xena''s', 'single');
insert into public.topics (id, plan_id, title) values
  ('60000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', 'Mia T'),
  ('60000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', 'Xena T');
insert into public.cards (id, topic_id, question, answer)
values ('70000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000004', 'Q', 'A');
insert into public.sources (id, owner_id, group_id, kind) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null, 'notes'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'pdf');
insert into public.source_chunks (id, source_id, content) values
  ('42000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Private passage.'),
  ('42000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'Shared passage.');

set local role authenticated;

-- exercise_sets.exercise_id as Xena (outsider) ----------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index)
    values ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000011', 'Olive secret', 0),
           ('e3000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000012', 'Olive press', 1),
           ('e3000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'Odd lift', 2),
           ('e3000000-0000-4000-8000-000000000034', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-0000000000ff', 'Made up', 3),
           ('e3000000-0000-4000-8000-000000000035', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'Push-up', 4),
           ('e3000000-0000-4000-8000-000000000036', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', null, 'Something I did', 5)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index$$,
  'PUT: sets naming exercises the user cannot read are accepted (no 42501, no 23503)'
);
select results_eq(
  $$select id::text, exercise_id, exercise_name from public.exercise_sets
    where user_id = '10000000-0000-4000-8000-000000000003' order by id$$,
  $$values ('e3000000-0000-4000-8000-000000000031', null::uuid, 'Olive secret'),
           ('e3000000-0000-4000-8000-000000000032', null::uuid, 'Olive press'),
           ('e3000000-0000-4000-8000-000000000033', null::uuid, 'Odd lift'),
           ('e3000000-0000-4000-8000-000000000034', null::uuid, 'Made up'),
           ('e3000000-0000-4000-8000-000000000035', 'b0000000-0000-4000-8000-000000000001'::uuid, 'Push-up'),
           ('e3000000-0000-4000-8000-000000000036', null::uuid, 'Something I did')$$,
  '... someone else''s private exercise, a group''s she is not in, an unreviewed library row and a missing id are stored as null with the name kept; a reviewed library exercise is kept'
);
select results_eq(
  $$select exercise_id from public.exercise_sets
    where id in ('e3000000-0000-4000-8000-000000000031', 'e3000000-0000-4000-8000-000000000034') order by id$$,
  $$values (null::uuid), (null::uuid)$$,
  'a missing id and an existing unreadable id give the same stored row (no existence oracle)'
);
select is(
  pg_temp.affected($$update public.exercise_sets set exercise_id = 'b0000000-0000-4000-8000-000000000011'
    where id = 'e3000000-0000-4000-8000-000000000035'$$),
  1::bigint,
  'PATCH: pointing a set at an exercise the user cannot read is accepted ...'
);
select is(
  (select exercise_id from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000035'),
  null::uuid,
  '... and stores no exercise (not the unreadable one, not the old one)'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index)
    values ('e3000000-0000-4000-8000-000000000036', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000011', 'Olive secret', 5)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index$$,
  'PUT over an existing set that changes its exercise to an unreadable one is accepted ...'
);
select is(
  (select exercise_id from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000036'),
  null::uuid,
  '... and stores no exercise either'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000037', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 0)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index$$,
  '42501', null,
  'a REQUIRED parent reference (someone else''s workout session) is still refused'
);

-- exercise_sets.exercise_id as Mia (member): judged when set, never again ------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps)
    values ('e3000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000012', 'Olive press', 0, 8),
           ('e3000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Push-up', 1, 8)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps$$,
  'a member can log a set with an exercise shared with the group'
);
select is(
  (select exercise_id from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000021'),
  'b0000000-0000-4000-8000-000000000012'::uuid,
  '... and the set keeps it'
);

-- Olive unshares her exercise: Mia can no longer read it.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
update public.exercises set group_id = null where id = 'b0000000-0000-4000-8000-000000000012';
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select is(
  pg_temp.affected($$update public.exercise_sets set reps = 9 where id = 'e3000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: the set stays editable after its exercise became unreadable'
);
select is(
  pg_temp.affected($$update public.exercise_sets set exercise_id = 'b0000000-0000-4000-8000-000000000012', reps = 10
    where id = 'e3000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH that re-sends the unchanged exercise_id passes'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps)
    values ('e3000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000012', 'Olive press', 0, 11)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps$$,
  'PUT (a retried upload) re-sending the unchanged exercise_id passes'
);
select results_eq(
  $$select exercise_id::text, reps from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000021'$$,
  $$values ('b0000000-0000-4000-8000-000000000012', 11)$$,
  '... and the set holds the latest upload and still its exercise (an existing reference is never re-judged)'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index)
    values ('e3000000-0000-4000-8000-000000000023', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000012', 'Olive press', 2)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index$$,
  'a new set naming the exercise is accepted ...'
);
select is(
  pg_temp.affected($$update public.exercise_sets set exercise_id = 'b0000000-0000-4000-8000-000000000012'
    where id = 'e3000000-0000-4000-8000-000000000022'$$),
  1::bigint,
  '... and so is re-pointing another set at it ...'
);
select results_eq(
  $$select id::text, exercise_id, exercise_name from public.exercise_sets
    where id in ('e3000000-0000-4000-8000-000000000022', 'e3000000-0000-4000-8000-000000000023') order by id$$,
  $$values ('e3000000-0000-4000-8000-000000000022', null::uuid, 'Push-up'),
           ('e3000000-0000-4000-8000-000000000023', null::uuid, 'Olive press')$$,
  '... but neither gets the exercise'
);

-- Server-side writers are trusted: the service role and SQL run as postgres are not rewritten.
reset role;
set local role service_role;
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000024', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000011', 3)$$,
  'the service role can write any reference ...'
);
reset role;
select is(
  (select exercise_id from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000024'),
  'b0000000-0000-4000-8000-000000000011'::uuid,
  '... and it is stored as written (server-side writes are not rewritten)'
);
set local role authenticated;

-- study_sessions.plan_id -----------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  pg_temp.affected($$update public.study_sessions set plan_id = '50000000-0000-4000-8000-000000000001'
    where id = 'e4000000-0000-4000-8000-000000000003'$$),
  1::bigint,
  'PATCH: pointing a study session at a plan the user cannot read is accepted ...'
);
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id)
    values ('e4000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
            '50000000-0000-4000-8000-000000000002')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id$$,
  'PUT: ... so is a new session naming a group plan of a group the user is not in ...'
);
select results_eq(
  $$select id::text, plan_id from public.study_sessions
    where user_id = '10000000-0000-4000-8000-000000000003' order by id$$,
  $$values ('e4000000-0000-4000-8000-000000000003', null::uuid),
           ('e4000000-0000-4000-8000-000000000033', null::uuid)$$,
  '... but neither session gets the plan'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id, focus_subject)
    values ('e4000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002', 'Group plan')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id,
      focus_subject = excluded.focus_subject$$,
  'a member''s study session can point at the group plan'
);

-- Olive takes the plan out of the group.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
update public.study_plans set group_id = null where id = '50000000-0000-4000-8000-000000000002';
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select is(
  pg_temp.affected($$update public.study_sessions set focus_subject = 'Still studying'
    where id = 'e4000000-0000-4000-8000-000000000002'$$),
  1::bigint,
  'PATCH: the session stays editable after its plan became unreadable'
);
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id, focus_subject)
    values ('e4000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002', 'Retried')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id,
      focus_subject = excluded.focus_subject$$,
  'PUT re-sending the unchanged plan_id passes'
);
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id)
    values ('e4000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002')$$,
  'a new session naming the plan is accepted ...'
);
select results_eq(
  $$select id::text, plan_id, focus_subject from public.study_sessions
    where user_id = '10000000-0000-4000-8000-000000000002' order by id$$,
  $$values ('e4000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002'::uuid, 'Retried'),
           ('e4000000-0000-4000-8000-000000000022', null::uuid, '')$$,
  '... the old session keeps its plan; the new one is stored without it'
);

-- cards.source_chunk_id (Mia writes cards in her own plan) ---------------------------------------------
select lives_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000031', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-000000000002', 'From the shared PDF', 'A'),
           ('70000000-0000-4000-8000-000000000032', '60000000-0000-4000-8000-000000000003', null, 'Mine', 'A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id,
      source_chunk_id = excluded.source_chunk_id, question = excluded.question, answer = excluded.answer$$,
  'a card can cite a chunk of a source shared with the user''s group'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000033', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-000000000001', 'From a private PDF', 'A'),
           ('70000000-0000-4000-8000-000000000035', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-0000000000ff', 'From nowhere', 'A')$$,
  'a card citing a chunk the user cannot read, or one that does not exist, is accepted ...'
);
select is(
  pg_temp.affected($$update public.cards set source_chunk_id = '42000000-0000-4000-8000-000000000001'
    where id = '70000000-0000-4000-8000-000000000032'$$),
  1::bigint,
  'PATCH: ... and so is pointing a card at such a chunk ...'
);
select results_eq(
  $$select id::text, source_chunk_id from public.cards where topic_id = '60000000-0000-4000-8000-000000000003' order by id$$,
  $$values ('70000000-0000-4000-8000-000000000031', '42000000-0000-4000-8000-000000000002'::uuid),
           ('70000000-0000-4000-8000-000000000032', null::uuid),
           ('70000000-0000-4000-8000-000000000033', null::uuid),
           ('70000000-0000-4000-8000-000000000035', null::uuid)$$,
  '... but only the readable citation is stored'
);

-- Olive takes the source out of the group (its chunks follow).
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
update public.sources set group_id = null where id = '40000000-0000-4000-8000-000000000002';
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select is(
  pg_temp.affected($$update public.cards set question = 'From the PDF we shared'
    where id = '70000000-0000-4000-8000-000000000031'$$),
  1::bigint,
  'PATCH: the card stays editable after its chunk became unreadable'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000031', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-000000000002', 'Retried', 'A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id,
      source_chunk_id = excluded.source_chunk_id, question = excluded.question, answer = excluded.answer$$,
  'PUT re-sending the unchanged source_chunk_id passes'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000034', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-000000000002', 'New', 'A')$$,
  'a new card citing the chunk is accepted ...'
);
select results_eq(
  $$select id::text, source_chunk_id, question from public.cards
    where id in ('70000000-0000-4000-8000-000000000031', '70000000-0000-4000-8000-000000000034') order by id$$,
  $$values ('70000000-0000-4000-8000-000000000031', '42000000-0000-4000-8000-000000000002'::uuid, 'Retried'),
           ('70000000-0000-4000-8000-000000000034', null::uuid, 'New')$$,
  '... the old card keeps its citation; the new one is stored without it'
);

-- References to the user's own rows (or a system preset), as Xena ---------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select lives_ok(
  $$insert into public.workout_sessions (id, user_id, kind, preset_id, setup_id) values
      ('e2000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003', 'micro',
       'a0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001'),
      ('e2000000-0000-4000-8000-000000000034', '10000000-0000-4000-8000-000000000003', 'full',
       '00000000-0000-4000-8000-0000000000a3', 'e1000000-0000-4000-8000-000000000003'),
      ('e2000000-0000-4000-8000-000000000035', '10000000-0000-4000-8000-000000000003', 'full',
       'a0000000-0000-4000-8000-000000000003', null),
      ('e2000000-0000-4000-8000-000000000036', '10000000-0000-4000-8000-000000000003', 'walk',
       'a0000000-0000-4000-8000-0000000000ff', 'e1000000-0000-4000-8000-0000000000ff')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind,
      preset_id = excluded.preset_id, setup_id = excluded.setup_id$$,
  'PUT: workout sessions naming someone else''s or missing presets and setups are accepted'
);
select results_eq(
  $$select id::text, preset_id, setup_id from public.workout_sessions
    where id in ('e2000000-0000-4000-8000-000000000033', 'e2000000-0000-4000-8000-000000000034',
                 'e2000000-0000-4000-8000-000000000035', 'e2000000-0000-4000-8000-000000000036') order by id$$,
  $$values ('e2000000-0000-4000-8000-000000000033', null::uuid, null::uuid),
           ('e2000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-0000000000a3'::uuid,
            'e1000000-0000-4000-8000-000000000003'::uuid),
           ('e2000000-0000-4000-8000-000000000035', 'a0000000-0000-4000-8000-000000000003'::uuid, null::uuid),
           ('e2000000-0000-4000-8000-000000000036', null::uuid, null::uuid)$$,
  '... a system or own preset and an own setup are kept; someone else''s and missing ones are stored as null'
);
select is(
  pg_temp.affected($$update public.workout_sessions set preset_id = 'a0000000-0000-4000-8000-000000000001'
    where id = 'e2000000-0000-4000-8000-000000000034'$$),
  1::bigint,
  'PATCH: switching a workout session to someone else''s preset is accepted ...'
);
select is(
  (select preset_id from public.workout_sessions where id = 'e2000000-0000-4000-8000-000000000034'),
  null::uuid,
  '... and stores no preset'
);
select is(
  pg_temp.affected($$update public.profiles set default_preset_id = 'a0000000-0000-4000-8000-000000000001',
      default_setup_id = 'e1000000-0000-4000-8000-000000000001'
    where id = '10000000-0000-4000-8000-000000000003'$$),
  1::bigint,
  'PATCH: a profile naming someone else''s preset and setup is accepted ...'
);
select results_eq(
  $$select default_preset_id, default_setup_id from public.profiles where id = '10000000-0000-4000-8000-000000000003'$$,
  $$values (null::uuid, null::uuid)$$,
  '... but stores neither (group mates can read profiles, so they never name rows the user cannot see)'
);
select lives_ok(
  $$insert into public.profiles (id, display_name, default_preset_id, default_setup_id)
    values ('10000000-0000-4000-8000-000000000003', 'Xena', 'a0000000-0000-4000-8000-000000000003',
            'e1000000-0000-4000-8000-000000000003')
    on conflict (id) do update set id = excluded.id, display_name = excluded.display_name,
      default_preset_id = excluded.default_preset_id, default_setup_id = excluded.default_setup_id$$,
  'PUT: a profile can default to the user''s own preset and setup ...'
);
select results_eq(
  $$select default_preset_id::text, default_setup_id::text from public.profiles
    where id = '10000000-0000-4000-8000-000000000003'$$,
  $$values ('a0000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003')$$,
  '... and keeps them'
);
select lives_ok(
  $$insert into public.transitions (id, user_id, interval_block_id, workout_session_id) values
      ('e6000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
       'e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001'),
      ('e6000000-0000-4000-8000-000000000034', '10000000-0000-4000-8000-000000000003',
       'e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000003')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      interval_block_id = excluded.interval_block_id, workout_session_id = excluded.workout_session_id$$,
  'PUT: transitions leading to someone else''s or the user''s own workout session are accepted ...'
);
select is(
  pg_temp.affected($$update public.transitions set workout_session_id = 'e2000000-0000-4000-8000-000000000001'
    where id = 'e6000000-0000-4000-8000-000000000034'$$),
  1::bigint,
  'PATCH: ... and so is re-pointing one at someone else''s workout session'
);
select is(
  (select workout_session_id from public.transitions where id = 'e6000000-0000-4000-8000-000000000033'),
  null::uuid,
  '... someone else''s workout session is stored as null on insert'
);
select is(
  (select workout_session_id from public.transitions where id = 'e6000000-0000-4000-8000-000000000034'),
  null::uuid,
  '... and on update'
);
select lives_ok(
  $$insert into public.reviews (id, user_id, card_id, interval_block_id, rating, answer_mode, reviewed_at,
                                prev_state, state, due_at, stability, difficulty) values
      ('d0000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
       '70000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000001', 3, 'typed', now(),
       0, 1, now(), 1, 5),
      ('d0000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000003',
       '70000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000003', 3, 'typed', now(),
       0, 1, now(), 1, 5),
      ('d0000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
       '70000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-0000000000ff', 3, 'typed', now(),
       0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  'reviews naming someone else''s, the user''s own and a missing interval block are accepted ...'
);
select results_eq(
  $$select id::text, interval_block_id from public.reviews
    where user_id = '10000000-0000-4000-8000-000000000003' order by id$$,
  $$values ('d0000000-0000-4000-8000-000000000031', null::uuid),
           ('d0000000-0000-4000-8000-000000000032', 'e5000000-0000-4000-8000-000000000003'::uuid),
           ('d0000000-0000-4000-8000-000000000033', null::uuid)$$,
  '... and only the user''s own block is stored'
);

reset role;
select results_eq(
  $$select (select count(*) from public.workout_sessions where preset_id = 'a0000000-0000-4000-8000-000000000001'),
           (select count(*) from public.workout_sessions where setup_id = 'e1000000-0000-4000-8000-000000000001'),
           (select count(*) from public.profiles where default_preset_id = 'a0000000-0000-4000-8000-000000000001'),
           (select count(*) from public.transitions where workout_session_id = 'e2000000-0000-4000-8000-000000000001'),
           (select count(*) from public.reviews where interval_block_id = 'e5000000-0000-4000-8000-000000000001'),
           (select count(*) from public.study_sessions where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.cards where source_chunk_id = '42000000-0000-4000-8000-000000000001'),
           (select count(*) from public.exercise_sets where exercise_id = 'b0000000-0000-4000-8000-000000000011'
              and user_id <> '10000000-0000-4000-8000-000000000001'
              and id <> 'e3000000-0000-4000-8000-000000000024')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'no client stored a reference to a row it may not use'
);

select * from finish();
rollback;
