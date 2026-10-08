-- A write made offline is never dropped because of something someone else did before it was
-- uploaded. Each scenario below queues writes "offline", lets other people (or the user's other
-- device) change things, then uploads the queue as PowerSync would (PUT = upsert, PATCH = update).
-- Every upload must succeed (no 42501, no 23503); what the writer may no longer use is normalized:
--   * a set on a shared exercise that became unreadable (its owner left the group, unshared it, was
--     removed, or deleted it) is stored with exercise_id null and keeps exercise_name;
--   * a card citing a chunk that became unreadable or was deleted is stored with source_chunk_id null;
--   * every other optional reference to a row deleted meanwhile is stored as null;
--   * a PUT re-send of the user's own content with the group_id of a group they left is stored
--     unshared;
--   * content created offline as shared, uploaded after its owner was removed from the group, is
--     stored unshared together with its topics, cards, files and sets.
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

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

-- Olive hosts G. Carol logs sets with exercises Bob, Dan, Eve, Fay and Olive shared with G.
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'carol@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'bob@example.com'),
  ('10000000-0000-4000-8000-000000000004', 'dan@example.com'),
  ('10000000-0000-4000-8000-000000000005', 'eve@example.com'),
  ('10000000-0000-4000-8000-000000000006', 'fay@example.com');
insert into public.groups (id, owner_id, name)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'G');
insert into public.group_members (group_id, user_id, role)
select '30000000-0000-4000-8000-000000000001', ('10000000-0000-4000-8000-00000000000' || i)::uuid, 'member'
from generate_series(2, 6) as i;

insert into public.exercises (id, name, origin, owner_id, group_id) values
  ('b0000000-0000-4000-8000-000000000001', 'Olive deadlift', 'user', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000003', 'Bob goblet squat', 'user', '10000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000004', 'Dan row', 'user', '10000000-0000-4000-8000-000000000004',
   '30000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000005', 'Eve lunge', 'user', '10000000-0000-4000-8000-000000000005',
   '30000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000006', 'Fay press', 'user', '10000000-0000-4000-8000-000000000006',
   '30000000-0000-4000-8000-000000000001');

-- Bob shares two sources (with one chunk each) and a plan with G.
insert into public.sources (id, owner_id, group_id, kind, title) values
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', 'pdf', 'Bob PDF'),
  ('40000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', 'pdf', 'Bob other PDF');
insert into public.source_chunks (id, source_id, content) values
  ('42000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', 'Passage.'),
  ('42000000-0000-4000-8000-000000000013', '40000000-0000-4000-8000-000000000013', 'Other passage.');
insert into public.study_plans (id, owner_id, group_id, title, scope) values
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', 'Bob plan', 'single');

-- Olive's group plans (cards cite Bob's chunks; Carol studies the second one).
insert into public.study_plans (id, owner_id, group_id, title, scope) values
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'Olive plan', 'single'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'Olive old plan', 'single');
insert into public.topics (id, plan_id, title)
values ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'T');

-- Carol's own rows, all uploaded before she went offline.
insert into public.presets (id, owner_id, name, split) values
  ('a0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Carol''s',
   '{"lower": 50, "upper": 50, "core": 0, "cardio": 0}');
insert into public.equipment_setups (id, user_id, name, location) values
  ('e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Carol gym', 'gym');
update public.profiles
   set default_preset_id = 'a0000000-0000-4000-8000-000000000002',
       default_setup_id = 'e1000000-0000-4000-8000-000000000002'
 where id = '10000000-0000-4000-8000-000000000002';
insert into public.workout_sessions (id, user_id, kind) values
  ('e2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'full'),
  ('e2000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002', 'micro');
insert into public.study_sessions (id, user_id) values
  ('e4000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'),
  ('e4000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002');
insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes) values
  ('e5000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'e4000000-0000-4000-8000-000000000002', 25),
  ('e5000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002',
   'e4000000-0000-4000-8000-000000000012', 25);
insert into public.study_plans (id, owner_id, title, scope)
values ('50000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002', 'Carol plan', 'single');
insert into public.topics (id, plan_id, title)
values ('60000000-0000-4000-8000-000000000012', '50000000-0000-4000-8000-000000000012', 'T');
insert into public.cards (id, topic_id, question, answer)
values ('70000000-0000-4000-8000-000000000012', '60000000-0000-4000-8000-000000000012', 'Q', 'A');

-- While Carol (and Olive's tablet) are offline, other people change things ------------------------------
set local role authenticated;

-- Bob leaves G (his exercise, sources and plan are unshared), then deletes his other source.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000003'$$),
  1::bigint,
  'Bob leaves the group'
);
delete from public.sources where id = '40000000-0000-4000-8000-000000000013';

-- Dan unshares his exercise.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000004", "role": "authenticated"}';
update public.exercises set group_id = null where id = 'b0000000-0000-4000-8000-000000000004';

-- Olive removes Eve and deletes her old plan.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select ok(
  public.remove_group_member('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005')
    is not null,
  'Olive removes Eve'
);
delete from public.study_plans where id = '50000000-0000-4000-8000-000000000002';

-- Fay deletes her exercise.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000006", "role": "authenticated"}';
delete from public.exercises where id = 'b0000000-0000-4000-8000-000000000006';

-- Carol's other device deletes her preset, setup, a workout session and a study session (with its block).
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
delete from public.presets where id = 'a0000000-0000-4000-8000-000000000002';
delete from public.equipment_setups where id = 'e1000000-0000-4000-8000-000000000002';
delete from public.workout_sessions where id = 'e2000000-0000-4000-8000-000000000012';
delete from public.study_sessions where id = 'e4000000-0000-4000-8000-000000000012';

-- Carol reconnects: her offline-logged sets go up ---------------------------------------------------------
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs)
    values ('e3000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003', 'Bob goblet squat', 0, 8, 95)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs$$,
  'a set on an exercise whose owner LEFT the group uploads'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs)
    values ('e3000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', 'Dan row', 1, 10, 60)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs$$,
  'a set on an exercise its owner UNSHARED uploads'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs)
    values ('e3000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000005', 'Eve lunge', 2, 12, 40)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs$$,
  'a set on an exercise whose owner was REMOVED from the group uploads'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs)
    values ('e3000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000006', 'Fay press', 3, 5, 70)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs$$,
  'a set on an exercise its owner DELETED uploads (no 23503 from the foreign key)'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs)
    values ('e3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Olive deadlift', 4, 3, 185)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs$$,
  'a set on an exercise that is still shared uploads'
);
select results_eq(
  $$select exercise_id, exercise_name, reps, weight_lbs from public.exercise_sets
    where workout_session_id = 'e2000000-0000-4000-8000-000000000002' order by set_index$$,
  $$values (null::uuid, 'Bob goblet squat', 8, 95::double precision),
           (null::uuid, 'Dan row', 10, 60::double precision),
           (null::uuid, 'Eve lunge', 12, 40::double precision),
           (null::uuid, 'Fay press', 5, 70::double precision),
           ('b0000000-0000-4000-8000-000000000001'::uuid, 'Olive deadlift', 3, 185::double precision)$$,
  'every set is stored with its reps and weight; an exercise she can no longer read (or that is gone) is null, its name kept'
);

-- Carol's other offline writes name rows deleted meanwhile ----------------------------------------------
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id, focus_subject)
    values ('e4000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002', 'Old plan')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id,
      focus_subject = excluded.focus_subject$$,
  'a study session on a plan deleted meanwhile uploads'
);
select lives_ok(
  $$insert into public.workout_sessions (id, user_id, kind, preset_id, setup_id)
    values ('e2000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'full',
            'a0000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind,
      preset_id = excluded.preset_id, setup_id = excluded.setup_id$$,
  'a workout session with a preset and setup deleted meanwhile uploads'
);
select is(
  pg_temp.affected($$update public.profiles set default_preset_id = 'a0000000-0000-4000-8000-000000000002',
      default_setup_id = 'e1000000-0000-4000-8000-000000000002', display_name = 'Carol C.'
    where id = '10000000-0000-4000-8000-000000000002'$$),
  1::bigint,
  'a profile edit re-sending defaults deleted meanwhile uploads'
);
select lives_ok(
  $$insert into public.transitions (id, user_id, interval_block_id, workout_session_id, accepted)
    values ('e6000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
            'e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000012', true)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      interval_block_id = excluded.interval_block_id, workout_session_id = excluded.workout_session_id,
      accepted = excluded.accepted$$,
  'a transition into a workout session deleted meanwhile uploads'
);
select lives_ok(
  $$insert into public.reviews (id, user_id, card_id, interval_block_id, rating, answer_mode, reviewed_at,
                                prev_state, state, due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
            '70000000-0000-4000-8000-000000000012', 'e5000000-0000-4000-8000-000000000012', 3, 'typed', now(),
            0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  'a review from an interval block deleted meanwhile uploads'
);
select results_eq(
  $$select (select plan_id from public.study_sessions where id = 'e4000000-0000-4000-8000-000000000003'),
           (select preset_id from public.workout_sessions where id = 'e2000000-0000-4000-8000-000000000003'),
           (select setup_id from public.workout_sessions where id = 'e2000000-0000-4000-8000-000000000003'),
           (select default_preset_id from public.profiles where id = '10000000-0000-4000-8000-000000000002'),
           (select default_setup_id from public.profiles where id = '10000000-0000-4000-8000-000000000002'),
           (select workout_session_id from public.transitions where id = 'e6000000-0000-4000-8000-000000000002'),
           (select interval_block_id from public.reviews where id = 'd0000000-0000-4000-8000-000000000002')$$,
  $$values (null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid)$$,
  '... and each reference to a deleted row is stored as null'
);
select results_eq(
  $$select (select focus_subject from public.study_sessions where id = 'e4000000-0000-4000-8000-000000000003'),
           (select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000002'),
           (select accepted::text from public.transitions where id = 'e6000000-0000-4000-8000-000000000002'),
           (select rating::text from public.reviews where id = 'd0000000-0000-4000-8000-000000000002')$$,
  $$values ('Old plan', 'Carol C.', 'true', '3')$$,
  '... while the rest of each write is kept'
);

-- Olive's tablet uploads cards citing Bob's chunks -------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select lives_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
            '42000000-0000-4000-8000-000000000003', 'From Bob''s PDF', 'A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id,
      source_chunk_id = excluded.source_chunk_id, question = excluded.question, answer = excluded.answer$$,
  'a card citing a chunk that became unreadable (its owner left) uploads'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, source_chunk_id, question, answer)
    values ('70000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001',
            '42000000-0000-4000-8000-000000000013', 'From Bob''s other PDF', 'A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id,
      source_chunk_id = excluded.source_chunk_id, question = excluded.question, answer = excluded.answer$$,
  'a card citing a chunk deleted meanwhile uploads'
);
select results_eq(
  $$select id::text, source_chunk_id, question from public.cards
    where topic_id = '60000000-0000-4000-8000-000000000001' order by id$$,
  $$values ('70000000-0000-4000-8000-000000000001', null::uuid, 'From Bob''s PDF'),
           ('70000000-0000-4000-8000-000000000002', null::uuid, 'From Bob''s other PDF')$$,
  '... and both are stored with source_chunk_id null'
);

-- Bob's device retries uploads made while he was still in the group -------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select lives_ok(
  $$insert into public.study_plans (id, owner_id, group_id, title, scope)
    values ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
            '30000000-0000-4000-8000-000000000001', 'Bob plan v2', 'single')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      title = excluded.title, scope = excluded.scope$$,
  'PUT re-send of his own plan with the old group_id succeeds after leaving'
);
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, group_id)
    values ('b0000000-0000-4000-8000-000000000003', 'Bob goblet squat v2', 'user',
            '10000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, group_id = excluded.group_id$$,
  '... so does a re-send of his exercise'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind, title)
    values ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
            '30000000-0000-4000-8000-000000000001', 'pdf', 'Bob PDF v2')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      kind = excluded.kind, title = excluded.title$$,
  '... and of his source'
);
select results_eq(
  $$select (select title || ' / ' || coalesce(group_id::text, 'unshared') from public.study_plans
            where id = '50000000-0000-4000-8000-000000000003'),
           (select name || ' / ' || coalesce(group_id::text, 'unshared') from public.exercises
            where id = 'b0000000-0000-4000-8000-000000000003'),
           (select title || ' / ' || coalesce(group_id::text, 'unshared') from public.sources
            where id = '40000000-0000-4000-8000-000000000003'),
           (select coalesce(group_id::text, 'unshared') from public.source_chunks
            where id = '42000000-0000-4000-8000-000000000003')$$,
  $$values ('Bob plan v2 / unshared', 'Bob goblet squat v2 / unshared', 'Bob PDF v2 / unshared', 'unshared')$$,
  '... each stores the new content and stays unshared'
);

-- Eve, removed while offline, uploads content she created as shared --------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select lives_ok(
  $$insert into public.study_plans (id, owner_id, group_id, title, scope)
    values ('50000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
            '30000000-0000-4000-8000-000000000001', 'Eve plan', 'single')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      title = excluded.title, scope = excluded.scope$$,
  'Eve''s plan, created offline as shared with G, uploads after her removal'
);
select lives_ok(
  $$insert into public.topics (id, plan_id, title)
    values ('60000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', 'Cells')
    on conflict (id) do update set id = excluded.id, plan_id = excluded.plan_id, title = excluded.title$$,
  '... its topic'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, plan_id, question, answer)
    values ('70000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000005',
            '50000000-0000-4000-8000-000000000005', 'Q', 'A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, plan_id = excluded.plan_id,
      question = excluded.question, answer = excluded.answer$$,
  '... its card'
);
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, group_id)
    values ('b0000000-0000-4000-8000-000000000015', 'Eve hop', 'user', '10000000-0000-4000-8000-000000000005',
            '30000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, group_id = excluded.group_id$$,
  '... her exercise shared with G'
);
select lives_ok(
  $$insert into public.workout_sessions (id, user_id, kind)
    values ('e2000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005', 'micro')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind$$,
  '... a workout session'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps)
    values ('e3000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000005',
            'e2000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000015', 'Eve hop', 0, 20)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps$$,
  '... a set with that exercise'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind, title)
    values ('40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
            '30000000-0000-4000-8000-000000000001', 'notes', 'Eve notes')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      kind = excluded.kind, title = excluded.title$$,
  '... a source shared with G'
);
select lives_ok(
  $$insert into public.source_files (id, source_id, owner_id, group_id, storage_path)
    values ('41000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000005',
            '10000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001', 'eve/notes/p1.jpg')
    on conflict (id) do update set id = excluded.id, source_id = excluded.source_id,
      owner_id = excluded.owner_id, group_id = excluded.group_id, storage_path = excluded.storage_path$$,
  '... and its file'
);
select results_eq(
  $$select (select group_id from public.study_plans where id = '50000000-0000-4000-8000-000000000005'),
           (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000015'),
           (select group_id from public.sources where id = '40000000-0000-4000-8000-000000000005'),
           (select group_id from public.source_files where id = '41000000-0000-4000-8000-000000000005')$$,
  $$values (null::uuid, null::uuid, null::uuid, null::uuid)$$,
  'all of it is stored unshared'
);
select results_eq(
  $$select (select count(*) from public.topics where plan_id = '50000000-0000-4000-8000-000000000005'),
           (select count(*) from public.cards where plan_id = '50000000-0000-4000-8000-000000000005'),
           (select exercise_id::text from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000015')$$,
  $$values (1::bigint, 1::bigint, 'b0000000-0000-4000-8000-000000000015')$$,
  '... with its topic, its card and its set (which keeps her own exercise)'
);

-- The group sees none of it -----------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select results_eq(
  $$select (select count(*) from public.study_plans
            where id in ('50000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000005')),
           (select count(*) from public.cards where id = '70000000-0000-4000-8000-000000000005'),
           (select count(*) from public.exercises
            where id in ('b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000015')),
           (select count(*) from public.sources
            where id in ('40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000005')),
           (select count(*) from public.source_files where id = '41000000-0000-4000-8000-000000000005')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'a group member sees none of the content of the people who left or were removed'
);
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select results_eq(
  $$select (select count(*) from public.groups where id = '30000000-0000-4000-8000-000000000001'),
           (select count(*) from public.group_members
            where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000005')$$,
  $$values (0::bigint, 0::bigint)$$,
  'Eve is out of the group and cannot read it (or its new invite code)'
);

-- A row left shared with a group its owner is no longer in (e.g. a new row committed just after the
-- leave's unshare ran) is unshared by the owner's next edit of ANY column, files and chunks included,
-- instead of that edit failing the membership WITH CHECK.
reset role;
update public.sources set group_id = '30000000-0000-4000-8000-000000000001'
where id = '40000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  pg_temp.affected($$update public.sources set title = 'Bob PDF v3' where id = '40000000-0000-4000-8000-000000000003'$$),
  1::bigint,
  'PATCH (title only) of a source still shared with a group its owner left succeeds ...'
);
select results_eq(
  $$select (select group_id from public.sources where id = '40000000-0000-4000-8000-000000000003'),
           (select group_id from public.source_chunks where id = '42000000-0000-4000-8000-000000000003')$$,
  $$values (null::uuid, null::uuid)$$,
  '... and unshares it, its chunks included'
);

-- Uploading again changes nothing (the device re-sends after a lost response) ----------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs)
    values ('e3000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003', 'Bob goblet squat', 0, 8, 95)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs$$,
  'a re-sent PUT of the normalized set succeeds'
);
select results_eq(
  $$select exercise_id, exercise_name, reps from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000003'$$,
  $$values (null::uuid, 'Bob goblet squat', 8)$$,
  '... and leaves it as it was'
);

select * from finish();
rollback;
