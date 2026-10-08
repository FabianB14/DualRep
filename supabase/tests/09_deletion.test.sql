-- Deleting a group, an exercise or an account never depends on anyone else's history (Google Play
-- requires account deletion). Sets other people logged against an exercise are kept with
-- exercise_id = null and keep the name copied onto them; deleting a group only unshares the
-- exercises members shared with it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

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

-- Olive (subscriber) hosts groups G and G2; Mia and Bob are members of both; Xena is an outsider.
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'mia@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'bob@example.com'),
  ('10000000-0000-4000-8000-000000000004', 'xena@example.com');
insert into public.groups (id, owner_id, name) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'G'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'G2');
insert into public.group_members (group_id, user_id, role) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member'),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'member'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'member'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'member');

set local role authenticated;

-- Mia logs a set with her own exercise, then shares the exercise with G. She also shares a second
-- exercise with G2.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
insert into public.exercises (id, name, origin, owner_id) values
  ('b0000000-0000-4000-8000-000000000001', 'Mia lunge', 'user', '10000000-0000-4000-8000-000000000002');
insert into public.workout_sessions (id, user_id, kind) values
  ('e2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'full');
insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index) values
  ('e3000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
   'e2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Mia lunge', 0);
update public.exercises set group_id = '30000000-0000-4000-8000-000000000001'
where id = 'b0000000-0000-4000-8000-000000000001';
insert into public.exercises (id, name, origin, owner_id, group_id) values
  ('b0000000-0000-4000-8000-000000000002', 'Mia step-up', 'user', '10000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002');

-- Olive shares one exercise with G and keeps another private.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
insert into public.exercises (id, name, origin, owner_id, group_id) values
  ('b0000000-0000-4000-8000-000000000011', 'Olive press', 'user', '10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000012', 'Olive secret', 'user', '10000000-0000-4000-8000-000000000001', null);

-- Bob logs sets with all three shared exercises.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
insert into public.workout_sessions (id, user_id, kind) values
  ('e2000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'full');
insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index) values
  ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003',
   'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'Mia lunge', 0),
  ('e3000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000003',
   'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000011', 'Olive press', 1),
  ('e3000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000003',
   'e2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'Mia step-up', 2);

-- Xena holds a set that points at Olive's PRIVATE exercise. Through the API it would be stored as
-- null (10_references.test.sql); it is written directly here to prove that even such a reference
-- cannot block Olive's deletes.
reset role;
insert into public.workout_sessions (id, user_id, kind) values
  ('e2000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'walk');
insert into public.exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index) values
  ('e3000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000004',
   'e2000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000012', 'Olive secret', 0);

-- Deleting a group ------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.groups where id = '30000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'the owner can delete a group whose shared exercises members have logged sets with'
);

reset role;
select results_eq(
  $$select id::text, owner_id::text, group_id from public.exercises
    where id in ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000011') order by id$$,
  $$values ('b0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', null::uuid),
           ('b0000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', null::uuid)$$,
  'deleting the group unshares the members'' exercises instead of deleting them'
);
select is(
  (select exercise_id from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000031'),
  'b0000000-0000-4000-8000-000000000001'::uuid,
  '... so sets logged with them still point at them'
);

-- Deleting an exercise other people used --------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.exercises where id = 'b0000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'the owner can delete an exercise that she and others logged sets with'
);

reset role;
select results_eq(
  $$select id::text, user_id::text, exercise_id, exercise_name from public.exercise_sets
    where id in ('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000031') order by id$$,
  $$values ('e3000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002', null::uuid, 'Mia lunge'),
           ('e3000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000003', null::uuid, 'Mia lunge')$$,
  'the sets are kept, with exercise_id cleared and the copied name intact'
);

-- Deleting accounts (what the delete-account Edge Function will do: one admin call) --------------------
-- Olive owns G2 (holding Mia's exercise that Bob used), an exercise Bob used, and an exercise Xena
-- references.
select lives_ok(
  $$delete from auth.users where id = '10000000-0000-4000-8000-000000000001'$$,
  'a group owner whose exercises other people logged sets with can delete her account'
);
select results_eq(
  $$select (select count(*) from public.groups where id = '30000000-0000-4000-8000-000000000002'),
           (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000002')$$,
  $$values (0::bigint, null::uuid)$$,
  '... her group goes, and the member''s exercise that was shared with it stays (unshared)'
);
select results_eq(
  $$select id::text, exercise_id, exercise_name from public.exercise_sets
    where id in ('e3000000-0000-4000-8000-000000000032', 'e3000000-0000-4000-8000-000000000041') order by id$$,
  $$values ('e3000000-0000-4000-8000-000000000032', null::uuid, 'Olive press'),
           ('e3000000-0000-4000-8000-000000000041', null::uuid, 'Olive secret')$$,
  '... and other people''s sets on her exercises are kept with exercise_id cleared'
);

select lives_ok(
  $$delete from auth.users where id = '10000000-0000-4000-8000-000000000002'$$,
  'a member whose shared exercises others used can delete her account'
);
select results_eq(
  $$select exercise_id, exercise_name from public.exercise_sets where id = 'e3000000-0000-4000-8000-000000000033'$$,
  $$values (null::uuid, 'Mia step-up')$$,
  '... and the sets others logged with them are kept'
);

select lives_ok(
  $$delete from auth.users where id = '10000000-0000-4000-8000-000000000003'$$,
  'a member who logged sets with other people''s exercises can delete his account'
);
select lives_ok(
  $$delete from auth.users where id = '10000000-0000-4000-8000-000000000004'$$,
  'an outsider holding a reference to someone''s exercise can delete her account'
);

select results_eq(
  $$with people(id) as (values ('10000000-0000-4000-8000-000000000001'::uuid),
                               ('10000000-0000-4000-8000-000000000002'::uuid),
                               ('10000000-0000-4000-8000-000000000003'::uuid),
                               ('10000000-0000-4000-8000-000000000004'::uuid))
    select (select count(*) from auth.users where id in (select id from people)),
           (select count(*) from public.exercises where owner_id in (select id from people)),
           (select count(*) from public.exercise_sets where user_id in (select id from people)),
           (select count(*) from public.workout_sessions where user_id in (select id from people)),
           (select count(*) from public.groups where owner_id in (select id from people)),
           (select count(*) from public.group_members where user_id in (select id from people))$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'once everyone has deleted their account, none of their rows remain'
);

select * from finish();
rollback;
