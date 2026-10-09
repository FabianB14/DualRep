-- The Interverse starter library (supabase/migrations/20261008120000_starter_library.sql, generated
-- from src/features/training/starterLibraryData.ts): every row is a reviewed, ownerless library row in
-- the reserved id range, every signed-in user can read it and nobody can change it, and a set logged
-- against a starter exercise keeps its exercise_id. Applying the migration at all proves every value
-- passes the CHECK constraints on public.exercises.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- Runs one write and returns how many rows it changed. RLS hides rows from UPDATE and DELETE
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

-- The starter rows, as the migration left them (read as the table owner, past RLS).
create temp view starter as
  select * from public.exercises where id::text like '00000000-0000-4000-8000-0000000e%';

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');

-- The seed ---------------------------------------------------------------------------------------
select is((select count(*) from starter), 90::bigint, 'the migration seeds the 90 starter exercises');

select is(
  (select count(*) from starter
   where not (origin = 'interverse' and reviewed and owner_id is null and group_id is null
              and dataset_id is null and dataset_category is null and images = '[]'::jsonb)),
  0::bigint,
  'every starter row is a reviewed Interverse library row with no owner, group, dataset id or images'
);

select is(
  (select count(*) from public.exercises where origin = 'interverse'
     and id not in (select id from starter)),
  0::bigint,
  'every Interverse row is in the reserved starter id range'
);

select is(
  (select count(*) from starter
   where muscle_group is null or body_region is null or category is null or movement_pattern is null
      or demand_level is null or level is null or jsonb_array_length(equipment) = 0
      or jsonb_array_length(instructions) not between 2 and 4),
  0::bigint,
  'every starter row has its curated fields, some equipment and 2 to 4 instruction steps'
);

select is(
  (select count(distinct lower(name)) from starter),
  90::bigint,
  'starter exercise names are unique'
);

select is(
  (select count(*) from starter
   where (location = 'gym') <> (equipment ?| array['barbell', 'rack', 'ez_bar', 'trap_bar', 'cable', 'machine',
                                                   'cardio_machine', 'dip_station', 'hyperextension_bench',
                                                   'sled', 'battle_rope', 'climbing_rope',
                                                   'strongman_implement', 'other'])),
  0::bigint,
  'a starter exercise is gym-only exactly when it needs gym-only equipment'
);

select is(
  (select count(*) from starter where location = 'home' and equipment <> '["bodyweight"]'::jsonb),
  0::bigint,
  'home-only (desk-side) starter exercises need no equipment'
);

select is(
  (select count(*) from starter where micro_ok and demand_level = 3),
  0::bigint,
  'no demand-3 starter exercise is offered for micro circuits'
);

select results_eq(
  $$select name, equipment, location, movement_pattern, body_region, demand_level, micro_ok
    from starter
    where id in ('00000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0010',
                 '00000000-0000-4000-8000-0000000e002a', '00000000-0000-4000-8000-0000000e0042')
    order by id$$,
  $$values
    ('Chair squat', '["bodyweight"]'::jsonb, 'home', 'squat', 'lower', 1::smallint, true),
    ('Doorframe row', '["bodyweight"]'::jsonb, 'home', 'horizontal_pull', 'upper', 1::smallint, true),
    ('Goblet squat', '["dumbbell"]'::jsonb, 'both', 'squat', 'lower', 2::smallint, true),
    ('Barbell back squat', '["barbell", "rack"]'::jsonb, 'gym', 'squat', 'lower', 3::smallint, false)$$,
  'spot checks: a desk-side squat, a no-gear pull, a home dumbbell squat and a heavy gym lift'
);

-- Ada: reads, cannot change, logs sets ------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select is(
  (select count(*) from public.exercises where id::text like '00000000-0000-4000-8000-0000000e%'),
  90::bigint,
  'a signed-in user can read every starter exercise'
);

select is(
  array[
    pg_temp.affected($$update public.exercises set name = 'Mine' where id = '00000000-0000-4000-8000-0000000e002a'$$),
    pg_temp.affected($$delete from public.exercises where id = '00000000-0000-4000-8000-0000000e002a'$$)
  ],
  array[0, 0]::bigint[],
  'a user cannot update or delete a starter exercise'
);

select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id)
    values ('00000000-0000-4000-8000-0000000e002a', 'Mine', 'user', '11111111-1111-4111-8111-111111111111')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id$$,
  '42501', null,
  'a user cannot take over a starter exercise with an upsert'
);

select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id)
    values ('00000000-0000-4000-8000-0000000effff', 'Squat', 'interverse', null)
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id$$,
  '42501', null,
  'a user cannot add an exercise to the starter library'
);

select lives_ok(
  $$insert into public.workout_sessions (id, user_id, logged_at, kind, preset_id)
    values ('e2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '2026-10-08T10:00:00.000Z', 'micro', '00000000-0000-4000-8000-0000000000a3')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, logged_at = excluded.logged_at,
      kind = excluded.kind, preset_id = excluded.preset_id$$,
  'PUT: a micro workout'
);

select lives_ok(
  $$insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps,
                                      weight_lbs, target_reps, target_weight_lbs, rest_seconds, set_type)
    values ('e3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            'e2000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000e002a', 'Goblet squat', 0,
            10, 25, 10, 25, 10, 'normal')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      workout_session_id = excluded.workout_session_id, exercise_id = excluded.exercise_id,
      exercise_name = excluded.exercise_name, set_index = excluded.set_index, reps = excluded.reps,
      weight_lbs = excluded.weight_lbs, target_reps = excluded.target_reps,
      target_weight_lbs = excluded.target_weight_lbs, rest_seconds = excluded.rest_seconds,
      set_type = excluded.set_type$$,
  'PUT: a set of a starter exercise'
);

select results_eq(
  $$select s.exercise_id::text, coalesce(e.name, s.exercise_name)
    from public.exercise_sets s left join public.exercises e on e.id = s.exercise_id
    where s.id = 'e3000000-0000-4000-8000-000000000001'$$,
  $$values ('00000000-0000-4000-8000-0000000e002a', 'Goblet squat')$$,
  'the set keeps its starter exercise_id (a readable library row) and history shows its name'
);

-- Bob and anon -------------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';

select is(
  (select count(*) from public.exercises where id::text like '00000000-0000-4000-8000-0000000e%'),
  90::bigint,
  'every signed-in user sees the same starter library'
);

reset role;
set local role anon;
select throws_ok(
  $$select count(*) from public.exercises$$,
  '42501', null,
  'signed-out clients cannot read the library'
);

reset role;
select results_eq(
  $$select name, reviewed, owner_id from public.exercises where id = '00000000-0000-4000-8000-0000000e002a'$$,
  $$values ('Goblet squat', true, null::uuid)$$,
  'the starter row is unchanged'
);

select * from finish();
rollback;
