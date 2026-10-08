-- The per-user activity tables: equipment_setups, workout_sessions, exercise_sets, study_sessions,
-- interval_blocks, transitions. Owner PUT/PATCH/DELETE; nobody else sees or changes them; a child
-- row's denormalized user_id must match a parent the user owns; deleting the account deletes it all.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- Runs one write and returns how many rows it changed. RLS hides other people's rows from UPDATE
-- and DELETE (0 rows, no error), so that is how "cannot modify" is asserted.
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

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');
insert into public.exercises (id, name, origin, dataset_id, reviewed)
values ('b0000000-0000-4000-8000-000000000001', 'Push-up', 'dataset', 'Pushups', true);

-- Ada: PUT and PATCH on every table ---------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select lives_ok(
  $$insert into public.equipment_setups (id, user_id, name, location, equipment)
    values ('e1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Home', 'home',
            '["dumbbells", "mat"]')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, name = excluded.name,
      location = excluded.location, equipment = excluded.equipment$$,
  'PUT: equipment_setups'
);
select lives_ok(
  $$insert into public.workout_sessions (id, user_id, logged_at, kind, preset_id, setup_id, duration_minutes)
    values ('e2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '2026-10-08T09:30:00.000Z', 'micro', '00000000-0000-4000-8000-0000000000a3',
            'e1000000-0000-4000-8000-000000000001', 6)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, logged_at = excluded.logged_at,
      kind = excluded.kind, preset_id = excluded.preset_id, setup_id = excluded.setup_id,
      duration_minutes = excluded.duration_minutes$$,
  'PUT: workout_sessions'
);
select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps,
                                      weight_lbs, rpe)
    values ('e3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            'e2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Push-up', 0, 12, 0, 7.5)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs, rpe = excluded.rpe$$,
  'PUT: exercise_sets (with the exercise''s name copied onto the set)'
);
select lives_ok(
  $$insert into public.study_sessions (id, user_id, focus_subject)
    values ('e4000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Sync check')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      focus_subject = excluded.focus_subject$$,
  'PUT: study_sessions'
);
select lives_ok(
  $$insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes, started_at, mode)
    values ('e5000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            'e4000000-0000-4000-8000-000000000001', 25, '2026-10-08T09:00:00.000Z', 'seated')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      study_session_id = excluded.study_session_id, planned_minutes = excluded.planned_minutes,
      started_at = excluded.started_at, mode = excluded.mode$$,
  'PUT: interval_blocks'
);
select lives_ok(
  $$insert into public.transitions (id, user_id, interval_block_id, workout_session_id, proposal)
    values ('e6000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            'e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
            '{"preset": "full_body", "minutes": 6}')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      interval_block_id = excluded.interval_block_id, workout_session_id = excluded.workout_session_id,
      proposal = excluded.proposal$$,
  'PUT: transitions'
);

select is(pg_temp.affected($$update public.equipment_setups set equipment = '["dumbbells", "mat", "band"]'
  where id = 'e1000000-0000-4000-8000-000000000001'$$), 1::bigint, 'PATCH: equipment_setups');
select is(pg_temp.affected($$update public.workout_sessions set duration_minutes = 7
  where id = 'e2000000-0000-4000-8000-000000000001'$$), 1::bigint, 'PATCH: workout_sessions');
select is(pg_temp.affected($$update public.exercise_sets set reps = 10, set_type = 'drop'
  where id = 'e3000000-0000-4000-8000-000000000001'$$), 1::bigint, 'PATCH: exercise_sets');
select is(pg_temp.affected($$update public.study_sessions set focus_subject = 'Biology'
  where id = 'e4000000-0000-4000-8000-000000000001'$$), 1::bigint, 'PATCH: study_sessions');
select is(pg_temp.affected($$update public.interval_blocks set ended_at = '2026-10-08T09:25:00.000Z', effort_rating = 4
  where id = 'e5000000-0000-4000-8000-000000000001'$$), 1::bigint, 'PATCH: interval_blocks');
select is(pg_temp.affected($$update public.transitions set accepted = true
  where id = 'e6000000-0000-4000-8000-000000000001'$$), 1::bigint, 'PATCH: transitions');

select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index, reps, weight_lbs, rpe)
    values ('e3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            'e2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 0, 11, 0, 8)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index, reps = excluded.reps, weight_lbs = excluded.weight_lbs, rpe = excluded.rpe$$,
  'PUT of an existing row (a retried upload) succeeds'
);
select results_eq(
  $$select reps, rpe, set_type from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000001'$$,
  $$values (11, 8::double precision, 'drop')$$,
  '... updating the sent columns and keeping the rest'
);

-- Bob cannot see or change any of it ----------------------------------------------------------------
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';

select results_eq(
  $$select (select count(*) from public.equipment_setups), (select count(*) from public.workout_sessions),
           (select count(*) from public.exercise_sets), (select count(*) from public.study_sessions),
           (select count(*) from public.interval_blocks), (select count(*) from public.transitions)$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'a user sees none of someone else''s activity rows'
);
select is(
  array[
    pg_temp.affected($$update public.equipment_setups set name = 'x' where id = 'e1000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$update public.workout_sessions set kind = 'full' where id = 'e2000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$update public.exercise_sets set reps = 0 where id = 'e3000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$update public.study_sessions set focus_subject = 'x' where id = 'e4000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$update public.interval_blocks set interrupted = true where id = 'e5000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$update public.transitions set accepted = false where id = 'e6000000-0000-4000-8000-000000000001'$$)
  ],
  array[0, 0, 0, 0, 0, 0]::bigint[],
  'a user cannot update someone else''s activity rows'
);
select is(
  array[
    pg_temp.affected($$delete from public.transitions where id = 'e6000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$delete from public.interval_blocks where id = 'e5000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$delete from public.study_sessions where id = 'e4000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$delete from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$delete from public.workout_sessions where id = 'e2000000-0000-4000-8000-000000000001'$$),
    pg_temp.affected($$delete from public.equipment_setups where id = 'e1000000-0000-4000-8000-000000000001'$$)
  ],
  array[0, 0, 0, 0, 0, 0]::bigint[],
  'a user cannot delete someone else''s activity rows'
);
select throws_ok(
  $$insert into public.equipment_setups (id, user_id, name, location)
    values ('e1000000-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111', 'Gym', 'gym')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, name = excluded.name,
      location = excluded.location$$,
  '42501', null,
  'a user cannot create rows in someone else''s name'
);
select throws_ok(
  $$insert into public.workout_sessions (id, user_id, kind)
    values ('e2000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'walk')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, kind = excluded.kind$$,
  '42501', null,
  'a user cannot take over someone else''s row with an upsert'
);

-- Bob's own parents.
insert into public.study_sessions (id, user_id) values
  ('e4000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222');
insert into public.workout_sessions (id, user_id, kind) values
  ('e2000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'full');
insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes) values
  ('e5000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222',
   'e4000000-0000-4000-8000-000000000002', 25);

select throws_ok(
  $$insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes)
    values ('e5000000-0000-4000-8000-000000000009', '22222222-2222-4222-8222-222222222222',
            'e4000000-0000-4000-8000-000000000001', 25)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      study_session_id = excluded.study_session_id, planned_minutes = excluded.planned_minutes$$,
  '42501', null,
  'an interval block must belong to one of the user''s own study sessions'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index)
    values ('e3000000-0000-4000-8000-000000000009', '22222222-2222-4222-8222-222222222222',
            'e2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 0)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index$$,
  '42501', null,
  'an exercise set must belong to one of the user''s own workout sessions'
);
select throws_ok(
  $$insert into public.transitions (id, user_id, interval_block_id)
    values ('e6000000-0000-4000-8000-000000000009', '22222222-2222-4222-8222-222222222222',
            'e5000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      interval_block_id = excluded.interval_block_id$$,
  '42501', null,
  'a transition must belong to one of the user''s own interval blocks'
);
select throws_ok(
  $$update public.interval_blocks set study_session_id = 'e4000000-0000-4000-8000-000000000001'
    where id = 'e5000000-0000-4000-8000-000000000002'$$,
  '42501', null,
  'a row cannot be re-parented onto someone else''s row either'
);
select throws_ok(
  $$insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes)
    values ('e5000000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111',
            'e4000000-0000-4000-8000-000000000001', 25)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      study_session_id = excluded.study_session_id, planned_minutes = excluded.planned_minutes$$,
  '42501', null,
  'a user cannot add children to someone else''s rows in their name'
);

-- Value checks on Bob's own rows.
select throws_ok(
  $$update public.interval_blocks set planned_minutes = 0 where id = 'e5000000-0000-4000-8000-000000000002'$$,
  '23514', null, 'planned_minutes is 1 to 120'
);
select throws_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, set_index, rpe)
    values ('e3000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222',
            'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 0, 11)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      set_index = excluded.set_index, rpe = excluded.rpe$$,
  '23514', null, 'rpe is 1 to 10'
);
select throws_ok(
  $$update public.interval_blocks set mode = 'running' where id = 'e5000000-0000-4000-8000-000000000002'$$,
  '23514', null, 'mode is seated or on_the_go'
);
select throws_ok(
  $$insert into public.equipment_setups (id, user_id, name, location, equipment)
    values ('e1000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Gym', 'gym', '{}')$$,
  '23514', null, 'equipment is a JSON array'
);

-- Ada: DELETE on every table ----------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select is(pg_temp.affected($$delete from public.transitions where id = 'e6000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: transitions');
select is(pg_temp.affected($$delete from public.interval_blocks where id = 'e5000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: interval_blocks');
select is(pg_temp.affected($$delete from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: exercise_sets');
select is(pg_temp.affected($$delete from public.workout_sessions where id = 'e2000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: workout_sessions');
select is(pg_temp.affected($$delete from public.study_sessions where id = 'e4000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: study_sessions');
select is(pg_temp.affected($$delete from public.equipment_setups where id = 'e1000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: equipment_setups');

-- Account deletion ----------------------------------------------------------------------------------
reset role;
-- Ada logs a full day again, including a set of her own exercise (09_deletion.test.sql covers sets
-- that other people logged against her exercises).
insert into public.presets (id, owner_id, name, split)
values ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Mine',
        '{"lower": 50, "upper": 50, "core": 0, "cardio": 0}');
insert into public.equipment_setups (id, user_id, name, location)
values ('e1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Gym', 'gym');
update public.profiles set default_preset_id = 'a0000000-0000-4000-8000-000000000001',
  default_setup_id = 'e1000000-0000-4000-8000-000000000003'
where id = '11111111-1111-4111-8111-111111111111';
insert into public.exercises (id, name, origin, owner_id)
values ('b0000000-0000-4000-8000-000000000002', 'Ada''s lift', 'user', '11111111-1111-4111-8111-111111111111');
insert into public.workout_sessions (id, user_id, kind)
values ('e2000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'full');
insert into public.exercise_sets (user_id, workout_session_id, exercise_id, set_index) values
  ('11111111-1111-4111-8111-111111111111', 'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 0),
  ('11111111-1111-4111-8111-111111111111', 'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 1);
insert into public.study_sessions (id, user_id)
values ('e4000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111');
insert into public.interval_blocks (id, user_id, study_session_id, planned_minutes)
values ('e5000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
        'e4000000-0000-4000-8000-000000000003', 25);
insert into public.transitions (user_id, interval_block_id, workout_session_id)
values ('11111111-1111-4111-8111-111111111111', 'e5000000-0000-4000-8000-000000000003',
        'e2000000-0000-4000-8000-000000000003');

select lives_ok(
  $$delete from auth.users where id = '11111111-1111-4111-8111-111111111111'$$,
  'an account with data can be deleted'
);
select results_eq(
  $$select (select count(*) from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.entitlements where user_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.presets where owner_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.equipment_setups where user_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.exercises where owner_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.workout_sessions where user_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.exercise_sets where user_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.study_sessions where user_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.interval_blocks where user_id = '11111111-1111-4111-8111-111111111111'),
           (select count(*) from public.transitions where user_id = '11111111-1111-4111-8111-111111111111')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'deleting the account deletes all of its rows'
);
select results_eq(
  $$select (select count(*) from public.study_sessions where user_id = '22222222-2222-4222-8222-222222222222'),
           (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000001')$$,
  $$values (1::bigint, 1::bigint)$$,
  'other users'' rows and the library are untouched'
);

select * from finish();
rollback;
