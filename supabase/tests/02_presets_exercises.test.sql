-- presets (system rows read-only, own rows CRUD, split validation) and exercises (library rows
-- visible only once reviewed and never client-writable; user rows owner-only and never able to pass
-- as library rows: no dataset_id, never reviewed).
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

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

-- Ada and Bob.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');

-- presets as Ada ----------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select results_eq(
  $$select id::text, name, kind, split from public.presets where owner_id is null order by id$$,
  $$values
    ('00000000-0000-4000-8000-0000000000a1', 'All lower body', 'all_lower', '{"lower": 100, "upper": 0, "core": 0, "cardio": 0}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a2', 'Mostly lower body', 'mostly_lower', '{"lower": 70, "upper": 15, "core": 15, "cardio": 0}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a3', 'Full body', 'full_body', '{"lower": 25, "upper": 50, "core": 25, "cardio": 0}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a4', 'Mostly upper body', 'mostly_upper', '{"lower": 15, "upper": 70, "core": 15, "cardio": 0}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a5', 'All upper body', 'all_upper', '{"lower": 0, "upper": 100, "core": 0, "cardio": 0}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a6', 'Mostly cardio', 'mostly_cardio', '{"lower": 10, "upper": 10, "core": 10, "cardio": 70}'::jsonb)$$,
  'every user sees the six system presets'
);

select is(
  pg_temp.affected($$update public.presets set name = 'Mine now' where id = '00000000-0000-4000-8000-0000000000a1'$$),
  0::bigint,
  'a user cannot update a system preset'
);

select is(
  pg_temp.affected($$delete from public.presets where id = '00000000-0000-4000-8000-0000000000a1'$$),
  0::bigint,
  'a user cannot delete a system preset'
);

select throws_ok(
  $$insert into public.presets (id, owner_id, name, kind, split)
    values ('a0000000-0000-4000-8000-000000000009', null, 'Fake system', 'custom',
            '{"lower": 100, "upper": 0, "core": 0, "cardio": 0}')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name,
      kind = excluded.kind, split = excluded.split$$,
  '42501', null,
  'a user cannot create a system preset'
);

select throws_ok(
  $$insert into public.presets (id, owner_id, name, kind, split)
    values ('00000000-0000-4000-8000-0000000000a1', '11111111-1111-4111-8111-111111111111', 'Taken', 'custom',
            '{"lower": 100, "upper": 0, "core": 0, "cardio": 0}')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name,
      kind = excluded.kind, split = excluded.split$$,
  '42501', null,
  'a user cannot take over a system preset with an upsert'
);

select lives_ok(
  $$insert into public.presets (id, owner_id, name, kind, split)
    values ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Leg day', 'custom',
            '{"lower": 80, "upper": 0, "core": 20, "cardio": 0}')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name,
      kind = excluded.kind, split = excluded.split$$,
  'PUT: a user can create their own preset'
);

select lives_ok(
  $$insert into public.presets (id, owner_id, name, kind, split)
    values ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Leg day v2', 'custom',
            '{"lower": 75, "upper": 0, "core": 25, "cardio": 0}')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name,
      kind = excluded.kind, split = excluded.split$$,
  'PUT again (a retried upload): the upsert updates the row'
);

select results_eq(
  $$select name, split from public.presets where id = 'a0000000-0000-4000-8000-000000000001'$$,
  $$values ('Leg day v2', '{"lower": 75, "upper": 0, "core": 25, "cardio": 0}'::jsonb)$$,
  'the preset holds the latest upload'
);

select is(
  pg_temp.affected($$update public.presets set name = 'Legs' where id = 'a0000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: a user can update their own preset'
);

-- Split validation (CHECK is_valid_split).
select throws_ok(
  $$update public.presets set split = '{"lower": 50, "upper": 40, "core": 0, "cardio": 0}'
    where id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a split must add up to 100'
);
select throws_ok(
  $$update public.presets set split = '{"lower": 50, "upper": 50, "core": 0}'
    where id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a split needs all four keys'
);
select throws_ok(
  $$update public.presets set split = '{"lower": 50, "upper": 50, "core": 0, "cardio": 0, "arms": 0}'
    where id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a split has no other keys'
);
select throws_ok(
  $$update public.presets set split = '{"lower": -10, "upper": 110, "core": 0, "cardio": 0}'
    where id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'each split value is between 0 and 100'
);
select throws_ok(
  $$update public.presets set split = '{"lower": "100", "upper": 0, "core": 0, "cardio": 0}'
    where id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'split values are numbers'
);
select throws_ok(
  $$update public.presets set split = '[100, 0, 0, 0]' where id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a split is an object'
);
select ok(
  public.is_valid_split('{"lower": 33.5, "upper": 33.5, "core": 33, "cardio": 0}'),
  'fractional split values are allowed'
);

-- presets as Bob ----------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';

select is(
  (select count(*) from public.presets where id = 'a0000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a user cannot see someone else''s preset'
);
select is(
  pg_temp.affected($$update public.presets set name = 'Bob''s' where id = 'a0000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a user cannot update someone else''s preset'
);
select is(
  pg_temp.affected($$delete from public.presets where id = 'a0000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a user cannot delete someone else''s preset'
);
select throws_ok(
  $$insert into public.presets (id, owner_id, name, kind, split)
    values ('a0000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Mine', 'custom',
            '{"lower": 100, "upper": 0, "core": 0, "cardio": 0}')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name,
      kind = excluded.kind, split = excluded.split$$,
  '42501', null,
  'a user cannot take over someone else''s preset with an upsert'
);
select throws_ok(
  $$insert into public.presets (id, owner_id, name, kind, split)
    values ('a0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'For Ada', 'custom',
            '{"lower": 100, "upper": 0, "core": 0, "cardio": 0}')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name,
      kind = excluded.kind, split = excluded.split$$,
  '42501', null,
  'a user cannot create a preset owned by someone else'
);

set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.presets where id = 'a0000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'DELETE: a user can delete their own preset'
);

reset role;

-- exercises ---------------------------------------------------------------------------------------
-- The library import (service role): two reviewed rows and one awaiting review. Bob hosts a group.
insert into public.exercises (id, name, origin, dataset_id, reviewed, movement_pattern) values
  ('b0000000-0000-4000-8000-000000000001', 'Barbell Squat', 'dataset', 'Barbell_Squat', true, 'squat'),
  ('b0000000-0000-4000-8000-000000000002', 'Odd Lift', 'dataset', 'Odd_Lift', false, 'other'),
  ('b0000000-0000-4000-8000-000000000003', 'Desk Squat', 'interverse', null, true, 'squat');
insert into public.groups (id, owner_id, name)
values ('c0000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Bob''s crew');

set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select results_eq(
  $$select id::text from public.exercises order by id$$,
  $$values ('b0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000003')$$,
  'reviewed library exercises are visible and unreviewed ones are hidden'
);
select is(
  pg_temp.affected($$update public.exercises set name = 'Squat!' where id = 'b0000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a user cannot update a library exercise'
);
select is(
  pg_temp.affected($$delete from public.exercises where id = 'b0000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a user cannot delete a library exercise'
);
select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id)
    values ('b0000000-0000-4000-8000-000000000010', 'Fake', 'dataset', '11111111-1111-4111-8111-111111111111')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id$$,
  '42501', null,
  'a user cannot insert an exercise with origin dataset'
);
select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id, reviewed)
    values ('b0000000-0000-4000-8000-000000000011', 'Fake', 'interverse', null, true)
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, reviewed = excluded.reviewed$$,
  '42501', null,
  'a user cannot insert a library exercise'
);
select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id)
    values ('b0000000-0000-4000-8000-000000000002', 'Mine', 'user', '11111111-1111-4111-8111-111111111111')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id$$,
  '42501', null,
  'a user cannot take over a library exercise with an upsert'
);
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, equipment, location, movement_pattern, micro_ok)
    values ('b0000000-0000-4000-8000-000000000020', 'Backpack Row', 'user', '11111111-1111-4111-8111-111111111111',
            '["backpack"]', 'home', 'horizontal_pull', true)
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, equipment = excluded.equipment, location = excluded.location,
      movement_pattern = excluded.movement_pattern, micro_ok = excluded.micro_ok$$,
  'PUT: a user can create their own exercise'
);
select is(
  pg_temp.affected($$update public.exercises set demand_level = 2 where id = 'b0000000-0000-4000-8000-000000000020'$$),
  1::bigint,
  'PATCH: a user can update their own exercise'
);

-- dataset_id is the library import's idempotency key and `reviewed` its review flag: a user row may
-- hold neither (otherwise a user could claim a public free-exercise-db id ahead of the import).
select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id, dataset_id)
    values ('b0000000-0000-4000-8000-000000000023', 'Squat', 'user', '11111111-1111-4111-8111-111111111111',
            'Barbell_Deadlift')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, dataset_id = excluded.dataset_id$$,
  '23514', null,
  'a user exercise cannot claim a library dataset_id'
);
select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id, reviewed, images)
    values ('b0000000-0000-4000-8000-000000000024', 'Squat', 'user', '11111111-1111-4111-8111-111111111111',
            true, '["https://attacker.example/x.png"]')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, reviewed = excluded.reviewed, images = excluded.images$$,
  '23514', null,
  'a user exercise cannot be marked reviewed'
);
select throws_ok(
  $$update public.exercises set dataset_id = 'Barbell_Deadlift' where id = 'b0000000-0000-4000-8000-000000000020'$$,
  '23514', null,
  'PATCH: a user cannot add a dataset_id to their exercise'
);
select throws_ok(
  $$update public.exercises set reviewed = true where id = 'b0000000-0000-4000-8000-000000000020'$$,
  '23514', null,
  'PATCH: a user cannot mark their exercise reviewed'
);
-- Sharing into a group you are not in is not refused (an offline write must not be dropped); the
-- exercise is stored unshared.
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, group_id)
    values ('b0000000-0000-4000-8000-000000000021', 'Shared', 'user', '11111111-1111-4111-8111-111111111111',
            'c0000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, group_id = excluded.group_id$$,
  'PUT: an exercise shared with a group the user is not in is accepted ...'
);
select is(
  pg_temp.affected($$update public.exercises set group_id = 'c0000000-0000-4000-8000-000000000001'
    where id = 'b0000000-0000-4000-8000-000000000020'$$),
  1::bigint,
  'PATCH: ... and so is moving an exercise into such a group ...'
);
select results_eq(
  $$select id::text, group_id from public.exercises
    where id in ('b0000000-0000-4000-8000-000000000020', 'b0000000-0000-4000-8000-000000000021') order by id$$,
  $$values ('b0000000-0000-4000-8000-000000000020', null::uuid),
           ('b0000000-0000-4000-8000-000000000021', null::uuid)$$,
  '... but both are stored unshared (never shared into a group the owner is not in)'
);

-- exercises as Bob ----------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';

select is(
  (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000020'),
  0::bigint,
  'a user cannot see someone else''s private exercise'
);
select is(
  pg_temp.affected($$update public.exercises set name = 'Bob''s row' where id = 'b0000000-0000-4000-8000-000000000020'$$),
  0::bigint,
  'a user cannot update someone else''s exercise'
);
select is(
  pg_temp.affected($$delete from public.exercises where id = 'b0000000-0000-4000-8000-000000000020'$$),
  0::bigint,
  'a user cannot delete someone else''s exercise'
);
select throws_ok(
  $$insert into public.exercises (id, name, origin, owner_id)
    values ('b0000000-0000-4000-8000-000000000022', 'For Ada', 'user', '11111111-1111-4111-8111-111111111111')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id$$,
  '42501', null,
  'a user cannot create an exercise owned by someone else'
);

set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.exercises where id = 'b0000000-0000-4000-8000-000000000020'$$),
  1::bigint,
  'DELETE: a user can delete their own exercise'
);

reset role;

select results_eq(
  $$select name from public.exercises where id = 'b0000000-0000-4000-8000-000000000001'$$,
  $$values ('Barbell Squat')$$,
  'the library row is unchanged'
);

-- The service role (the importer) is held to the same rules.
select throws_ok(
  $$insert into public.exercises (name, origin, dataset_id, reviewed)
    values ('Desk Lunge', 'interverse', 'Desk_Lunge', true)$$,
  '23514', null,
  'only dataset rows carry a dataset_id'
);
select lives_ok(
  $$insert into public.exercises (name, origin, dataset_id, reviewed)
    values ('Barbell Deadlift', 'dataset', 'Barbell_Deadlift', false)
    on conflict (dataset_id) do nothing$$,
  'the import can still claim every dataset id (no user row can hold one)'
);

select * from finish();
rollback;
