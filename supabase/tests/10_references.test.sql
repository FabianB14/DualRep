-- References to other rows must be rows the caller may use.
-- * Checked when SET (BEFORE triggers): exercise_sets.exercise_id, study_sessions.plan_id and
--   cards.source_chunk_id may point at someone else's shared row, which can later become unreadable;
--   the user's existing rows must then stay editable, and a PowerSync PUT re-sending the unchanged
--   reference must still pass.
-- * Plain WITH CHECK (always readable): workout_sessions.preset_id / setup_id,
--   profiles.default_preset_id / default_setup_id, transitions.workout_session_id,
--   reviews.interval_block_id.
-- A refused reference is 42501, also for ids that do not exist (no existence oracle).
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

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

select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000011', 0)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index$$,
  '42501', null,
  'a set cannot use someone else''s private exercise'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000012', 0)$$,
  '42501', null,
  'a set cannot use an exercise shared with a group the user is not in'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 0)$$,
  '42501', null,
  'a set cannot use an unreviewed library exercise'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-0000000000ff', 0)$$,
  '42501', null,
  'an id that does not exist gets the same 42501 (no existence oracle)'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index)
    values ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'Push-up', 0),
           ('e3000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', null, 'Something I did', 1)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index$$,
  'a set can use a reviewed library exercise, or no exercise at all'
);
select throws_ok(
  $$update public.exercise_sets set exercise_id = 'b0000000-0000-4000-8000-000000000011'
    where id = 'e3000000-0000-4000-8000-000000000031'$$,
  '42501', null,
  'PATCH: a set cannot be pointed at an exercise the user cannot read'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000003',
            'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000011', 1)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index$$,
  '42501', null,
  'PUT over an existing set cannot change its exercise to an unreadable one either'
);

-- exercise_sets.exercise_id as Mia (member): checked when set, not forever -------------------------------
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
  '... and the set holds the latest upload'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000023', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000012', 2)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index$$,
  '42501', null,
  'a new set cannot use the exercise any more'
);
select throws_ok(
  $$update public.exercise_sets set exercise_id = 'b0000000-0000-4000-8000-000000000012'
    where id = 'e3000000-0000-4000-8000-000000000022'$$,
  '42501', null,
  '... nor can another set be pointed at it'
);

-- Server-side writers are trusted: the service role and SQL run as postgres are not checked.
reset role;
select lives_ok(
  $$insert into public.exercise_sets (user_id, workout_session_id, exercise_id, set_index)
    values ('10000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002',
            'b0000000-0000-4000-8000-000000000011', 3)$$,
  'server-side writes are not reference-checked'
);
set local role authenticated;

-- study_sessions.plan_id -----------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$update public.study_sessions set plan_id = '50000000-0000-4000-8000-000000000001'
    where id = 'e4000000-0000-4000-8000-000000000003'$$,
  '42501', null,
  'PATCH: a study session cannot be pointed at a plan the user cannot read'
);
select throws_ok(
  $$insert into public.study_sessions (id, user_id, plan_id)
    values ('e4000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
            '50000000-0000-4000-8000-000000000002')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id$$,
  '42501', null,
  'PUT: a new study session cannot point at a group plan of a group the user is not in'
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
select throws_ok(
  $$insert into public.study_sessions (id, user_id, plan_id)
    values ('e4000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002')$$,
  '42501', null,
  'a new session cannot point at the plan any more'
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
select throws_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000033', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-000000000001', 'From a private PDF', 'A')$$,
  '42501', null,
  'a card cannot cite a chunk of a source the user cannot read'
);
select throws_ok(
  $$update public.cards set source_chunk_id = '42000000-0000-4000-8000-000000000001'
    where id = '70000000-0000-4000-8000-000000000032'$$,
  '42501', null,
  'PATCH: a card cannot be pointed at such a chunk either'
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
select throws_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000034', '60000000-0000-4000-8000-000000000003',
            '42000000-0000-4000-8000-000000000002', 'New', 'A')$$,
  '42501', null,
  'a new card cannot cite the chunk any more'
);

-- Plain WITH CHECK references, as Xena -----------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select throws_ok(
  $$insert into public.workout_sessions (id, user_id, kind, preset_id)
    values ('e2000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003', 'micro',
            'a0000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind,
      preset_id = excluded.preset_id$$,
  '42501', null,
  'a workout session cannot use someone else''s preset'
);
select throws_ok(
  $$insert into public.workout_sessions (id, user_id, kind, setup_id)
    values ('e2000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003', 'micro',
            'e1000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind,
      setup_id = excluded.setup_id$$,
  '42501', null,
  'a workout session cannot use someone else''s equipment setup'
);
select lives_ok(
  $$insert into public.workout_sessions (id, user_id, kind, preset_id, setup_id) values
      ('e2000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003', 'micro',
       '00000000-0000-4000-8000-0000000000a3', 'e1000000-0000-4000-8000-000000000003'),
      ('e2000000-0000-4000-8000-000000000034', '10000000-0000-4000-8000-000000000003', 'full',
       'a0000000-0000-4000-8000-000000000003', null)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind,
      preset_id = excluded.preset_id, setup_id = excluded.setup_id$$,
  'a workout session can use a system preset, the user''s own preset and own setup'
);
select throws_ok(
  $$update public.workout_sessions set preset_id = 'a0000000-0000-4000-8000-000000000001'
    where id = 'e2000000-0000-4000-8000-000000000033'$$,
  '42501', null,
  'PATCH: a workout session cannot be switched to someone else''s preset'
);
select throws_ok(
  $$update public.profiles set default_preset_id = 'a0000000-0000-4000-8000-000000000001'
    where id = '10000000-0000-4000-8000-000000000003'$$,
  '42501', null,
  'a profile''s default preset cannot be someone else''s (group mates can read profiles)'
);
select throws_ok(
  $$update public.profiles set default_setup_id = 'e1000000-0000-4000-8000-000000000001'
    where id = '10000000-0000-4000-8000-000000000003'$$,
  '42501', null,
  'a profile''s default setup cannot be someone else''s'
);
select lives_ok(
  $$insert into public.profiles (id, display_name, default_preset_id, default_setup_id)
    values ('10000000-0000-4000-8000-000000000003', 'Xena', 'a0000000-0000-4000-8000-000000000003',
            'e1000000-0000-4000-8000-000000000003')
    on conflict (id) do update set id = excluded.id, display_name = excluded.display_name,
      default_preset_id = excluded.default_preset_id, default_setup_id = excluded.default_setup_id$$,
  'PUT: a profile can default to the user''s own preset and setup'
);
select throws_ok(
  $$insert into public.transitions (id, user_id, interval_block_id, workout_session_id)
    values ('e6000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
            'e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      interval_block_id = excluded.interval_block_id, workout_session_id = excluded.workout_session_id$$,
  '42501', null,
  'a transition cannot lead to someone else''s workout session'
);
select lives_ok(
  $$insert into public.transitions (id, user_id, interval_block_id, workout_session_id)
    values ('e6000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
            'e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000003')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      interval_block_id = excluded.interval_block_id, workout_session_id = excluded.workout_session_id$$,
  'a transition can lead to the user''s own workout session'
);
select throws_ok(
  $$update public.transitions set workout_session_id = 'e2000000-0000-4000-8000-000000000001'
    where id = 'e6000000-0000-4000-8000-000000000033'$$,
  '42501', null,
  'PATCH: a transition cannot be re-pointed at someone else''s workout session'
);
select throws_ok(
  $$insert into public.reviews (id, user_id, card_id, interval_block_id, rating, answer_mode, reviewed_at,
                                prev_state, state, due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            '70000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000001', 3, 'typed', now(),
            0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  '42501', null,
  'a review cannot name someone else''s interval block'
);
select lives_ok(
  $$insert into public.reviews (id, user_id, card_id, interval_block_id, rating, answer_mode, reviewed_at,
                                prev_state, state, due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
            '70000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000003', 3, 'typed', now(),
            0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  'a review can name the user''s own interval block'
);
select throws_ok(
  $$insert into public.workout_sessions (id, user_id, kind, preset_id)
    values ('e2000000-0000-4000-8000-000000000035', '10000000-0000-4000-8000-000000000003', 'walk',
            'a0000000-0000-4000-8000-0000000000ff')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind,
      preset_id = excluded.preset_id$$,
  '42501', null,
  'a preset id that does not exist gets the same 42501 (no existence oracle)'
);

reset role;
select results_eq(
  $$select (select count(*) from public.workout_sessions where preset_id = 'a0000000-0000-4000-8000-000000000001'),
           (select count(*) from public.transitions where workout_session_id = 'e2000000-0000-4000-8000-000000000001'),
           (select count(*) from public.reviews where interval_block_id = 'e5000000-0000-4000-8000-000000000001'),
           (select count(*) from public.exercise_sets where exercise_id = 'b0000000-0000-4000-8000-000000000011'
              and user_id = '10000000-0000-4000-8000-000000000003')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'none of the refused references were stored'
);

select * from finish();
rollback;
