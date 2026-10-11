-- Leaving a group, or being removed from it (remove_group_member), unshares that person's own
-- exercises, sources (with their files) and study plans from the group. Afterwards the group no
-- longer sees them, the owner can keep editing them (PATCH and PUT, even a PUT that still carries
-- the old group_id), and any attempt to share them into the group again stores them unshared
-- instead of failing. Their own rows that point at the group's content (a study session on a group
-- plan) stay editable.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

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

-- Olive hosts G (members Bob and Mia) and G2 (member Bob).
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'bob@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'mia@example.com');
insert into public.groups (id, owner_id, name) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'G'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'G2');
insert into public.group_members (group_id, user_id, role) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member'),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'member'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'member');
-- Olive's plan in G.
insert into public.study_plans (id, owner_id, group_id, title, scope)
values ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001', 'Olive group plan', 'single');

set local role authenticated;

-- Bob shares an exercise, a source with a file and a plan with a card with G, another exercise with
-- G2, and studies with Olive's group plan.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
insert into public.exercises (id, name, origin, owner_id, group_id) values
  ('b0000000-0000-4000-8000-000000000021', 'Bob row', 'user', '10000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000022', 'Bob curl', 'user', '10000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002');
insert into public.sources (id, owner_id, group_id, kind, title)
values ('40000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000001', 'notes', 'Bob notes');
insert into public.source_files (id, source_id, owner_id, storage_path)
values ('41000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021',
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000021/p1.jpg');
insert into public.study_plans (id, owner_id, group_id, title, scope)
values ('50000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000001', 'Bob plan', 'single');
insert into public.topics (id, plan_id, title)
values ('60000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000021', 'T');
insert into public.cards (id, topic_id, question, answer)
values ('70000000-0000-4000-8000-000000000021', '60000000-0000-4000-8000-000000000021', 'Q', 'A');
insert into public.study_sessions (id, user_id, plan_id, focus_subject)
values ('e4000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
        '50000000-0000-4000-8000-000000000001', 'Olive''s plan');

-- Mia shares an exercise with G.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
insert into public.exercises (id, name, origin, owner_id, group_id)
values ('b0000000-0000-4000-8000-000000000031', 'Mia lunge', 'user', '10000000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000001');

select results_eq(
  $$select (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000021'),
           (select count(*) from public.sources where id = '40000000-0000-4000-8000-000000000021'),
           (select count(*) from public.source_files where id = '41000000-0000-4000-8000-000000000021'),
           (select count(*) from public.study_plans where id = '50000000-0000-4000-8000-000000000021'),
           (select count(*) from public.cards where id = '70000000-0000-4000-8000-000000000021')$$,
  $$values (1::bigint, 1::bigint, 1::bigint, 1::bigint, 1::bigint)$$,
  'while Bob is a member, the group sees what he shared'
);

-- Bob leaves G ----------------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.group_members
    where group_id = '30000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'$$),
  1::bigint,
  'DELETE: Bob leaves the group'
);
select results_eq(
  $$select (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000021'),
           (select group_id from public.sources where id = '40000000-0000-4000-8000-000000000021'),
           (select group_id from public.source_files where id = '41000000-0000-4000-8000-000000000021'),
           (select group_id from public.study_plans where id = '50000000-0000-4000-8000-000000000021')$$,
  $$values (null::uuid, null::uuid, null::uuid, null::uuid)$$,
  'leaving unshares his exercise, source (and its files) and plan'
);
select is(
  (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000022'),
  '30000000-0000-4000-8000-000000000002'::uuid,
  '... but only from the group he left (his exercise in G2 stays shared)'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select results_eq(
  $$select (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000021'),
           (select count(*) from public.sources where id = '40000000-0000-4000-8000-000000000021'),
           (select count(*) from public.source_files where id = '41000000-0000-4000-8000-000000000021'),
           (select count(*) from public.study_plans where id = '50000000-0000-4000-8000-000000000021'),
           (select count(*) from public.cards where id = '70000000-0000-4000-8000-000000000021')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'the group no longer sees any of it'
);
select is(
  (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000031'),
  '30000000-0000-4000-8000-000000000001'::uuid,
  'other members'' shared content is untouched'
);

-- Bob keeps editing his former group content.
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  pg_temp.affected($$update public.exercises set name = 'Bob row v2' where id = 'b0000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: Bob can rename his formerly shared exercise'
);
select is(
  pg_temp.affected($$update public.sources set title = 'Bob notes v2' where id = '40000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: ... retitle his formerly shared source'
);
select is(
  pg_temp.affected($$update public.study_plans set title = 'Bob plan v2' where id = '50000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: ... and edit his formerly shared plan'
);
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, group_id)
    values ('b0000000-0000-4000-8000-000000000021', 'Bob row v3', 'user', '10000000-0000-4000-8000-000000000002', null)
    on conflict (id) do update set id = excluded.id, name = excluded.name, origin = excluded.origin,
      owner_id = excluded.owner_id, group_id = excluded.group_id$$,
  'PUT: Bob can upload his exercise again'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind, title)
    values ('40000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002', null, 'notes',
            'Bob notes v3')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      kind = excluded.kind, title = excluded.title$$,
  'PUT: ... his source'
);
select lives_ok(
  $$insert into public.study_plans (id, owner_id, group_id, title, scope)
    values ('50000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002', null, 'Bob plan v3',
            'single')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      title = excluded.title, scope = excluded.scope$$,
  'PUT: ... and his plan'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, question, answer)
    values ('70000000-0000-4000-8000-000000000022', '60000000-0000-4000-8000-000000000021', 'New Q', 'A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, question = excluded.question,
      answer = excluded.answer$$,
  'Bob can keep adding cards to his plan'
);

-- ... but nothing he writes can share it into G again: such writes are kept, unshared (an upload
-- from a device that has not heard about the leave yet must not be dropped).
select is(
  pg_temp.affected($$update public.exercises set group_id = '30000000-0000-4000-8000-000000000001'
    where id = 'b0000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: Bob re-sharing his exercise into the group he left is accepted ...'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind, title)
    values ('40000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000001', 'notes', 'Bob notes')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      kind = excluded.kind, title = excluded.title$$,
  'PUT: ... so is a PUT of his source that still carries the group (a retried upload)'
);
select is(
  pg_temp.affected($$update public.study_plans set group_id = '30000000-0000-4000-8000-000000000001'
    where id = '50000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: ... and re-sharing his plan'
);
select lives_ok(
  $$insert into public.exercises (id, name, origin, owner_id, group_id)
    values ('b0000000-0000-4000-8000-000000000023', 'New', 'user', '10000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000001')$$,
  '... and a new exercise shared with the group'
);
select results_eq(
  $$select (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000021'),
           (select group_id from public.sources where id = '40000000-0000-4000-8000-000000000021'),
           (select group_id from public.source_files where id = '41000000-0000-4000-8000-000000000021'),
           (select group_id from public.study_plans where id = '50000000-0000-4000-8000-000000000021'),
           (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000023')$$,
  $$values (null::uuid, null::uuid, null::uuid, null::uuid, null::uuid)$$,
  '... but all of it is stored unshared: nothing is shared into a group he is not in'
);

-- His study session on Olive's group plan (which he can no longer read) stays editable.
select is(
  pg_temp.affected($$update public.study_sessions set focus_subject = 'Revision'
    where id = 'e4000000-0000-4000-8000-000000000021'$$),
  1::bigint,
  'PATCH: Bob''s study session on the group plan stays editable'
);
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id, focus_subject)
    values ('e4000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000001', 'Revision 2')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id,
      focus_subject = excluded.focus_subject$$,
  'PUT: ... and re-uploadable with its plan_id unchanged'
);
select results_eq(
  $$select plan_id::text, focus_subject from public.study_sessions where id = 'e4000000-0000-4000-8000-000000000021'$$,
  $$values ('50000000-0000-4000-8000-000000000001', 'Revision 2')$$,
  '... and still records which plan it was for'
);
select is(
  (select count(*) from public.study_plans where id = '50000000-0000-4000-8000-000000000001'),
  0::bigint,
  '(Bob can no longer read that plan)'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (select count(*) from public.cards where id = '70000000-0000-4000-8000-000000000022'),
  0::bigint,
  'cards Bob adds after leaving do not reach the group'
);

-- Olive removes Mia ---------------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select matches(
  public.remove_group_member('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003'),
  '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$',
  'the owner removes Mia (remove_group_member)'
);
select is(
  (select count(*) from public.exercises where id = 'b0000000-0000-4000-8000-000000000031'),
  0::bigint,
  'being removed unshares the member''s exercise too'
);
select results_eq(
  $$select id::text, group_id from public.study_plans where owner_id = '10000000-0000-4000-8000-000000000001'$$,
  $$values ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'::uuid)$$,
  'the owner''s own content stays shared with the group'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select results_eq(
  $$select name, group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000031'$$,
  $$values ('Mia lunge', null::uuid)$$,
  'Mia still has her exercise, unshared'
);
select is(
  pg_temp.affected($$update public.exercises set name = 'Mia lunge v2' where id = 'b0000000-0000-4000-8000-000000000031'$$),
  1::bigint,
  'PATCH: Mia can edit it after being removed'
);
select is(
  pg_temp.affected($$update public.exercises set group_id = '30000000-0000-4000-8000-000000000001'
    where id = 'b0000000-0000-4000-8000-000000000031'$$),
  1::bigint,
  '... and an attempt to share it back into the group is accepted ...'
);
select is(
  (select group_id from public.exercises where id = 'b0000000-0000-4000-8000-000000000031'),
  null::uuid,
  '... but leaves it unshared'
);

-- Group and account deletion still work with the trigger in place ---------------------------------------
reset role;
select lives_ok(
  $$delete from auth.users where id = '10000000-0000-4000-8000-000000000002'$$,
  'a member''s account can be deleted (their memberships go without touching anyone else''s rows)'
);
select is(
  (select count(*) from public.group_members where group_id = '30000000-0000-4000-8000-000000000002'),
  1::bigint,
  '... leaving G2 with only its owner'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.affected($$delete from public.groups where id = '30000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'the owner can still delete the group'
);
reset role;
select results_eq(
  $$select (select group_id from public.study_plans where id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.group_members where group_id = '30000000-0000-4000-8000-000000000001')$$,
  $$values (null::uuid, 0::bigint)$$,
  'deleting the group unshares the rest and removes the memberships'
);
select lives_ok(
  $$delete from auth.users where id = '10000000-0000-4000-8000-000000000001'$$,
  'the owner''s account can be deleted'
);

select * from finish();
rollback;
