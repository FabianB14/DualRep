-- groups and group_members: only subscribers create groups; the owner becomes the first member;
-- the server always picks the invite code and only the owner can rotate it; join_group() by invite
-- code (case-insensitive, idempotent, max 8 members); leaving (a plain DELETE of your own membership)
-- and removing (only through remove_group_member(), which rotates the code in the same transaction);
-- who sees groups, rosters, profiles and group-shared exercises; deleting a group unshares (never
-- deletes) members' exercises.
begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

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

-- Olive (subscriber, hosts the group), Fred (free), Xena (outsider), Nate (the would-be 9th member)
-- and Mia1..Mia7 (members).
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'fred@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'xena@example.com'),
  ('10000000-0000-4000-8000-000000000004', 'nate@example.com');
insert into auth.users (id, email)
select ('20000000-0000-4000-8000-00000000000' || i)::uuid, 'mia' || i || '@example.com'
from generate_series(1, 7) as i;
update public.entitlements set tier = 'subscription', source = 'store'
where user_id = '10000000-0000-4000-8000-000000000001';

-- Creating a group --------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select throws_ok(
  $$insert into public.groups (id, owner_id, name)
    values ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Fred''s')
    on conflict (id) do nothing$$,
  '42501', null,
  'a free user cannot create a group'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';

-- The connector uploads groups as insert-ignore: PostgREST's upsert would list owner_id (and id) in
-- DO UPDATE SET, which the update(name) column grant refuses even when nothing conflicts.
select throws_ok(
  $$insert into public.groups (id, owner_id, name)
    values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Lifters')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, name = excluded.name$$,
  '42501', null,
  'a DO UPDATE upsert of a group is refused by the column grants (hence insert-ignore for groups)'
);

select lives_ok(
  $$insert into public.groups (id, owner_id, name)
    values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Lifters')
    on conflict (id) do nothing$$,
  'PUT: a subscriber can create a group'
);

select lives_ok(
  $$insert into public.groups (id, owner_id, name)
    values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Lifters')
    on conflict (id) do nothing$$,
  'a retried group upload is a harmless no-op'
);

select results_eq(
  $$select user_id::text, role from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001'$$,
  $$values ('10000000-0000-4000-8000-000000000001', 'owner')$$,
  'the creator becomes the group''s owner member'
);

select matches(
  (select invite_code from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$',
  'a new group gets an 8-character invite code without look-alike characters'
);

select throws_ok(
  $$insert into public.groups (id, owner_id, name, invite_code)
    values ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Easy code', 'AAAAAAAA')
    on conflict (id) do nothing$$,
  '42501', null,
  'a client cannot choose the invite code (no INSERT privilege on it; the server picks it)'
);

select throws_ok(
  $$insert into public.groups (id, owner_id, name)
    values ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'For Fred')
    on conflict (id) do nothing$$,
  '42501', null,
  'a subscriber cannot create a group owned by someone else'
);

select is(
  pg_temp.affected($$update public.groups set name = 'Lifters & Learners'
    where id = '30000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: the owner can rename the group'
);

select throws_ok(
  $$update public.groups set invite_code = 'AAAAAAAA' where id = '30000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the owner cannot set the invite code'
);

select throws_ok(
  $$update public.groups set owner_id = '10000000-0000-4000-8000-000000000003'
    where id = '30000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the owner cannot hand the group to someone else'
);

reset role;
-- A known code for the rest of the file (the generated one is random).
update public.groups set invite_code = 'ABCD2345' where id = '30000000-0000-4000-8000-000000000001';

-- Joining -----------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is(
  public.join_group(' abcd2345 '),
  '30000000-0000-4000-8000-000000000001'::uuid,
  'join_group finds the group by code, ignoring case and surrounding spaces'
);

select results_eq(
  $$select role from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000001'$$,
  $$values ('member')$$,
  'a free user who joins becomes a member'
);

select is(
  public.join_group('ABCD2345'),
  '30000000-0000-4000-8000-000000000001'::uuid,
  'joining a group you are already in returns the same group'
);

select is(
  (select count(*) from public.group_members
   where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000001'),
  1::bigint,
  '... without adding a second membership'
);

select throws_ok(
  $$select public.join_group('ZZZZZZZZ')$$,
  'P0001', 'invalid_invite_code',
  'an unknown code raises invalid_invite_code'
);

select is(
  (select count(*) from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  1::bigint,
  'a member sees the group'
);

select is(
  (select count(*) from public.group_members where group_id = '30000000-0000-4000-8000-000000000001'),
  2::bigint,
  'a member sees the whole roster'
);

select throws_ok(
  $$update public.groups set invite_code = 'AAAAAAAA' where id = '30000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a member cannot change the invite code'
);

select throws_ok(
  $$select public.regenerate_invite_code('30000000-0000-4000-8000-000000000001')$$,
  '42501', 'not_group_owner',
  'a member cannot rotate the invite code'
);

select is(
  pg_temp.affected($$update public.groups set name = 'Mia''s now' where id = '30000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a member cannot rename the group'
);

select is(
  pg_temp.affected($$delete from public.groups where id = '30000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a member cannot delete the group'
);

select throws_ok(
  $$insert into public.group_members (group_id, user_id, role)
    values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'member')$$,
  '42501', null,
  'nobody adds memberships directly (joining goes through join_group)'
);

select is(
  (select count(*) from public.profiles where id = '10000000-0000-4000-8000-000000000001'),
  1::bigint,
  'a member sees the profiles of the other members'
);

-- The outsider sees nothing.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select is(
  (select count(*) from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a non-member cannot see the group'
);
select is(
  (select count(*) from public.group_members where group_id = '30000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a non-member cannot see the roster'
);
select is(
  (select count(*) from public.profiles where id = '10000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a non-member cannot see the members'' profiles'
);
select throws_ok(
  $$select public.regenerate_invite_code('30000000-0000-4000-8000-000000000001')$$,
  '42501', 'not_group_owner',
  'a non-member cannot rotate the invite code'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select count(*) from public.profiles where id = '20000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the owner sees the members'' profiles'
);

-- At most 8 members -------------------------------------------------------------------------------
reset role;
insert into public.group_members (group_id, user_id, role)
select '30000000-0000-4000-8000-000000000001', ('20000000-0000-4000-8000-00000000000' || i)::uuid, 'member'
from generate_series(2, 7) as i;

select is(
  (select count(*) from public.group_members where group_id = '30000000-0000-4000-8000-000000000001'),
  8::bigint,
  'the group now has 8 members'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select throws_ok(
  $$select public.join_group('ABCD2345')$$,
  'P0001', 'group_full',
  'a 9th member is rejected with group_full'
);

reset role;
select throws_ok(
  $$insert into public.group_members (group_id, user_id, role)
    values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'member')$$,
  'P0001', 'group_full',
  'the limit holds for every insert path, not just join_group'
);

-- Leaving and removing ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'DELETE: a member can leave'
);
select is(
  (select count(*) from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  0::bigint,
  'after leaving, the group is no longer visible'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'the owner cannot leave their own group (they delete it instead)'
);
select is(
  pg_temp.affected($$delete from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000002'$$),
  0::bigint,
  'the owner cannot remove a member with a plain DELETE (removal goes through remove_group_member)'
);
select throws_ok(
  $$select public.remove_group_member('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'cannot_remove_owner',
  'the owner cannot remove themselves'
);
-- Removing someone who already left (or never joined) is not an error: the code still rotates, so a
-- member who left seconds before the owner tapped Remove cannot re-join with the code they know.
select matches(
  public.remove_group_member('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003'),
  '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$',
  'removing someone who is not (or no longer) a member succeeds and returns a new code'
);
select isnt(
  (select invite_code from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  'ABCD2345',
  '... and the old code is replaced even though nobody was removed'
);
reset role;
-- Back to the known code for the rest of the file.
update public.groups set invite_code = 'ABCD2345' where id = '30000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';

-- Mia2 can read the current code while she is a member.
set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  (select invite_code from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  'ABCD2345',
  'a member can read the invite code'
);

-- Removing for good: one call deletes the membership and rotates the code (the Phase 4 remove flow).
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select matches(
  public.remove_group_member('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'),
  '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$',
  'the owner removes a member with remove_group_member(), which returns the new invite code'
);
select results_eq(
  $$select (select count(*) from public.group_members
            where group_id = '30000000-0000-4000-8000-000000000001'
              and user_id = '20000000-0000-4000-8000-000000000002'),
           (select invite_code <> 'ABCD2345' from public.groups where id = '30000000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, true)$$,
  '... in the same call the membership is gone and the code is replaced'
);

set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select throws_ok(
  $$select public.join_group('ABCD2345')$$,
  'P0001', 'invalid_invite_code',
  'the removed member cannot rejoin with the code they knew'
);
select is(
  (select count(*) from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  0::bigint,
  '... and cannot read the group, so never sees the new code (no window where they could)'
);

-- The owner can also rotate the code without removing anyone.
reset role;
update public.groups set invite_code = 'EFGH6789' where id = '30000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select matches(
  public.regenerate_invite_code('30000000-0000-4000-8000-000000000001'),
  '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$',
  'the owner can rotate the invite code'
);
select isnt(
  (select invite_code from public.groups where id = '30000000-0000-4000-8000-000000000001'),
  'EFGH6789',
  '... which replaces the old code'
);

reset role;
-- A known code again for the rest of the file.
update public.groups set invite_code = 'EFGH6789' where id = '30000000-0000-4000-8000-000000000001';
set local role authenticated;

set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000004'$$),
  0::bigint,
  'a member cannot delete another member''s membership'
);
select throws_ok(
  $$select public.remove_group_member('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004')$$,
  '42501', 'not_group_owner',
  '... nor remove them through remove_group_member'
);
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$select public.remove_group_member('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004')$$,
  '42501', 'not_group_owner',
  'a non-member cannot remove anyone either'
);
reset role;
select is(
  (select count(*) from public.group_members
   where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '20000000-0000-4000-8000-000000000004'),
  1::bigint,
  '... so that member is still in the group'
);
set local role authenticated;

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(
  public.join_group('efgh6789'),
  '30000000-0000-4000-8000-000000000001'::uuid,
  'once there is room again, joining works'
);

-- Group-shared exercises --------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, group_id)
    values ('b0000000-0000-4000-8000-000000000001', 'Stair sprint', 'user', '20000000-0000-4000-8000-000000000003',
            '30000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, group_id = excluded.group_id$$,
  'a member can share their own exercise with the group'
);

set local request.jwt.claims to '{"sub": "20000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(
  (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000001'),
  1::bigint,
  'other members see exercises shared with the group'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000001'),
  0::bigint,
  'non-members do not see exercises shared with the group'
);

-- The group RPCs need a signed-in user.
set local request.jwt.claims to '';
select throws_ok(
  $$select public.join_group('EFGH6789')$$,
  '42501', 'not_authenticated',
  'join_group refuses a request without a user'
);
select throws_ok(
  $$select public.regenerate_invite_code('30000000-0000-4000-8000-000000000001')$$,
  '42501', 'not_authenticated',
  'regenerate_invite_code refuses a request without a user'
);
select throws_ok(
  $$select public.remove_group_member('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004')$$,
  '42501', 'not_authenticated',
  'remove_group_member refuses a request without a user'
);

-- Deleting the group ------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.groups where id = '30000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'DELETE: the owner can delete the group'
);

reset role;
select is(
  (select count(*) from public.group_members where group_id = '30000000-0000-4000-8000-000000000001'),
  0::bigint,
  'deleting a group removes its memberships'
);
select results_eq(
  $$select owner_id::text, group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000001'$$,
  $$values ('20000000-0000-4000-8000-000000000003', null::uuid)$$,
  '... but only unshares the exercises shared with it (they belong to their owners)'
);

select * from finish();
rollback;
