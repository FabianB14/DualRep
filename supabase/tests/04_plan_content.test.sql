-- Study plans and their content (plan_sources, topics, cards, card_links): the owner writes, group
-- members read, everyone else sees nothing; cards.plan_id and card_links.plan_id always come from
-- the parent (and follow it when a topic moves); card_links are per creator.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

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

-- Olive owns group G and its plan, Mia is a member, Xena is an outsider.
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'mia@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'xena@example.com');
insert into public.groups (id, owner_id, name)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Study crew');
insert into public.group_members (group_id, user_id, role)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member');

-- Olive builds a group plan ------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind, title)
    values ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001', 'pdf', 'Biology notes')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id,
      group_id = excluded.group_id, kind = excluded.kind, title = excluded.title$$,
  'PUT: the owner creates a group source'
);
select lives_ok(
  $$insert into public.study_plans (id, owner_id, group_id, title, scope)
    values ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001', 'Bio midterm', 'single')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id,
      group_id = excluded.group_id, title = excluded.title, scope = excluded.scope$$,
  'PUT: the owner creates a group plan'
);
select lives_ok(
  $$insert into public.plan_sources (id, plan_id, source_id)
    values ('51000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
            '40000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, plan_id = excluded.plan_id, source_id = excluded.source_id$$,
  'PUT: the owner links a source to the plan'
);
select lives_ok(
  $$insert into public.topics (id, plan_id, title, position)
    values ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Cells', 0)
    on conflict (id) do update set id = excluded.id, plan_id = excluded.plan_id, title = excluded.title,
      position = excluded.position$$,
  'PUT: the owner creates a topic'
);
select lives_ok(
  $$insert into public.cards (id, topic_id, plan_id, question, answer)
    values ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000001', 'What makes ATP?', 'Mitochondria'),
           ('70000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000001', 'Why do cells need ATP?', 'Energy currency')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, plan_id = excluded.plan_id,
      question = excluded.question, answer = excluded.answer$$,
  'PUT: the owner creates cards'
);
select lives_ok(
  $$insert into public.card_links (id, from_card_id, to_card_id, plan_id, created_by, relation)
    values ('80000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
            '70000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', 'why')
    on conflict (id) do update set id = excluded.id, from_card_id = excluded.from_card_id,
      to_card_id = excluded.to_card_id, plan_id = excluded.plan_id, created_by = excluded.created_by,
      relation = excluded.relation$$,
  'PUT: the owner links two cards'
);

-- A private plan (P2 / topic T2 / card C3).
insert into public.study_plans (id, owner_id, title, scope)
values ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Private', 'cumulative')
on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, title = excluded.title,
  scope = excluded.scope;
insert into public.topics (id, plan_id, title)
values ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'Secrets')
on conflict (id) do update set id = excluded.id, plan_id = excluded.plan_id, title = excluded.title;
insert into public.cards (id, topic_id, plan_id, question, answer)
values ('70000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000002',
        '50000000-0000-4000-8000-000000000002', 'Q3', 'A3')
on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, plan_id = excluded.plan_id,
  question = excluded.question, answer = excluded.answer;

select is(
  pg_temp.affected($$update public.sources set title = 'Bio notes', status = 'ready'
    where id = '40000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'PATCH: the owner updates the source'
);
select is(
  pg_temp.affected($$update public.study_plans set goal = 'A grade', target_date = '2026-12-01'
    where id = '50000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'PATCH: the owner updates the plan'
);
select is(
  pg_temp.affected($$update public.plan_sources set added_at = '2026-10-08T10:00:00.000Z'
    where id = '51000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'PATCH: the owner updates a plan source'
);
select is(
  pg_temp.affected($$update public.topics set position = 1 where id = '60000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'PATCH: the owner updates a topic'
);
select is(
  pg_temp.affected($$update public.cards set card_type = 'why' where id = '70000000-0000-4000-8000-000000000002'$$),
  1::bigint, 'PATCH: the owner updates a card'
);
select is(
  pg_temp.affected($$update public.card_links set note = 'ATP is the why' where id = '80000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'PATCH: the creator updates their card link'
);

-- Mia (member) reads but cannot write -------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select is((select count(*) from public.study_plans where id = '50000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member sees the group plan');
select is((select count(*) from public.sources where id = '40000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member sees the group source');
select is((select count(*) from public.plan_sources where plan_id = '50000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member sees the plan''s sources');
select is((select count(*) from public.topics where plan_id = '50000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member sees the plan''s topics');
select is((select count(*) from public.cards where plan_id = '50000000-0000-4000-8000-000000000001'),
  2::bigint, 'a member sees the plan''s cards');
select is((select count(*) from public.card_links where plan_id = '50000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member sees the plan''s card links');
select results_eq(
  $$select (select count(*) from public.study_plans where id = '50000000-0000-4000-8000-000000000002'),
           (select count(*) from public.topics where id = '60000000-0000-4000-8000-000000000002'),
           (select count(*) from public.cards where id = '70000000-0000-4000-8000-000000000003')$$,
  $$values (0::bigint, 0::bigint, 0::bigint)$$,
  'a member does not see the owner''s private plan, topics or cards'
);

select throws_ok(
  $$insert into public.cards (id, topic_id, plan_id, question, answer)
    values ('70000000-0000-4000-8000-000000000009', '60000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000001', 'Mia''s Q', 'Mia''s A')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, plan_id = excluded.plan_id,
      question = excluded.question, answer = excluded.answer$$,
  '42501', null,
  'a member cannot add cards to a group plan'
);
select is(
  pg_temp.affected($$update public.cards set answer = 'wrong' where id = '70000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot update the plan''s cards'
);
select is(
  pg_temp.affected($$delete from public.cards where id = '70000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot delete the plan''s cards'
);
select throws_ok(
  $$insert into public.topics (id, plan_id, title)
    values ('60000000-0000-4000-8000-000000000009', '50000000-0000-4000-8000-000000000001', 'Mia''s topic')
    on conflict (id) do update set id = excluded.id, plan_id = excluded.plan_id, title = excluded.title$$,
  '42501', null,
  'a member cannot add topics to a group plan'
);
select is(
  pg_temp.affected($$update public.study_plans set title = 'Mine' where id = '50000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot update the group plan'
);
select throws_ok(
  $$insert into public.plan_sources (id, plan_id, source_id)
    values ('51000000-0000-4000-8000-000000000009', '50000000-0000-4000-8000-000000000001',
            '40000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, plan_id = excluded.plan_id, source_id = excluded.source_id$$,
  '42501', null,
  'a member cannot change the group plan''s sources'
);

-- Mia's own plan (PM / topic TM).
insert into public.study_plans (id, owner_id, title, scope)
values ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Mia''s', 'single')
on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, title = excluded.title,
  scope = excluded.scope;

select throws_ok(
  $$insert into public.cards (id, topic_id, plan_id, question, answer)
    values ('70000000-0000-4000-8000-000000000006', '60000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000003', 'Smuggled', 'In')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, plan_id = excluded.plan_id,
      question = excluded.question, answer = excluded.answer$$,
  '42501', null,
  'a card cannot be smuggled into someone else''s topic by sending one''s own plan_id'
);

select lives_ok(
  $$insert into public.card_links (id, from_card_id, to_card_id, plan_id, created_by, relation)
    values ('80000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002',
            '70000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003',
            '10000000-0000-4000-8000-000000000002', 'analogy')
    on conflict (id) do update set id = excluded.id, from_card_id = excluded.from_card_id,
      to_card_id = excluded.to_card_id, plan_id = excluded.plan_id, created_by = excluded.created_by,
      relation = excluded.relation$$,
  'a member can link cards of a plan they can read'
);
select is(
  (select plan_id from public.card_links where id = '80000000-0000-4000-8000-000000000002'),
  '50000000-0000-4000-8000-000000000001'::uuid,
  'card_links.plan_id is taken from the from-card, not from the client'
);
select throws_ok(
  $$insert into public.card_links (id, from_card_id, to_card_id, created_by)
    values ('80000000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000002',
            '70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, from_card_id = excluded.from_card_id,
      to_card_id = excluded.to_card_id, created_by = excluded.created_by$$,
  '42501', null,
  'a link cannot be created in someone else''s name'
);
select is(
  pg_temp.affected($$update public.card_links set note = 'mine now' where id = '80000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot update the owner''s link'
);
select is(
  pg_temp.affected($$delete from public.card_links where id = '80000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot delete the owner''s link'
);
select is(
  pg_temp.affected($$update public.card_links set note = 'like a battery' where id = '80000000-0000-4000-8000-000000000002'$$),
  1::bigint, 'a member can update their own link'
);

select throws_ok(
  $$insert into public.study_sessions (id, user_id, plan_id)
    values ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id$$,
  '42501', null,
  'a study session cannot point at a plan the user cannot read'
);
select lives_ok(
  $$insert into public.study_sessions (id, user_id, plan_id)
    values ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, plan_id = excluded.plan_id$$,
  'a member''s study session can point at the group plan'
);

-- Xena (outsider) sees nothing ----------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select results_eq(
  $$select (select count(*) from public.study_plans where id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.sources where id = '40000000-0000-4000-8000-000000000001'),
           (select count(*) from public.plan_sources where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.topics where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.cards where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.card_links where plan_id = '50000000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)$$,
  'a non-member sees none of the group plan''s content'
);
select throws_ok(
  $$insert into public.card_links (id, from_card_id, to_card_id, created_by)
    values ('80000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000001',
            '70000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003')
    on conflict (id) do update set id = excluded.id, from_card_id = excluded.from_card_id,
      to_card_id = excluded.to_card_id, created_by = excluded.created_by$$,
  '42501', null,
  'a non-member cannot link cards of a plan they cannot read'
);

-- Xena's own plan with one card (CX).
insert into public.study_plans (id, owner_id, title, scope)
values ('50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 'Xena''s', 'single');
insert into public.topics (id, plan_id, title)
values ('60000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', 'X');
insert into public.cards (id, topic_id, question, answer)
values ('70000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000004', 'QX', 'AX');

-- Olive: parent-derived plan_id -------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select lives_ok(
  $$insert into public.cards (id, topic_id, plan_id, question, answer)
    values ('70000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000001', 'Q4', 'A4')
    on conflict (id) do update set id = excluded.id, topic_id = excluded.topic_id, plan_id = excluded.plan_id,
      question = excluded.question, answer = excluded.answer$$,
  'a card upload that names the wrong plan still succeeds'
);
select is(
  (select plan_id from public.cards where id = '70000000-0000-4000-8000-000000000004'),
  '50000000-0000-4000-8000-000000000002'::uuid,
  'cards.plan_id is forced to the topic''s plan'
);

update public.cards set plan_id = '50000000-0000-4000-8000-000000000001'
where id = '70000000-0000-4000-8000-000000000004';
select is(
  (select plan_id from public.cards where id = '70000000-0000-4000-8000-000000000004'),
  '50000000-0000-4000-8000-000000000002'::uuid,
  'a PATCH of cards.plan_id is overridden by the topic''s plan too'
);

insert into public.card_links (id, from_card_id, to_card_id, plan_id, created_by)
values ('80000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003',
        '70000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001')
on conflict (id) do update set id = excluded.id, from_card_id = excluded.from_card_id,
  to_card_id = excluded.to_card_id, plan_id = excluded.plan_id, created_by = excluded.created_by;
select is(
  (select plan_id from public.card_links where id = '80000000-0000-4000-8000-000000000003'),
  '50000000-0000-4000-8000-000000000002'::uuid,
  'card_links.plan_id is forced to the from-card''s plan'
);

select throws_ok(
  $$insert into public.card_links (id, from_card_id, to_card_id, created_by)
    values ('80000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000003',
            '70000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001')
    on conflict (id) do update set id = excluded.id, from_card_id = excluded.from_card_id,
      to_card_id = excluded.to_card_id, created_by = excluded.created_by$$,
  '42501', null,
  'a link cannot point at a card the user cannot read'
);
select throws_ok(
  $$insert into public.card_links (id, from_card_id, to_card_id, created_by)
    values ('80000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000003',
            '70000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001')$$,
  '23514', null,
  'a card cannot link to itself'
);
select is(
  (select count(*) from public.card_links where id = '80000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the plan owner sees links members made'
);

-- Moving a topic to another plan carries its cards and their links along.
insert into public.study_plans (id, owner_id, title, scope)
values ('50000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Final', 'cumulative');
update public.topics set plan_id = '50000000-0000-4000-8000-000000000005'
where id = '60000000-0000-4000-8000-000000000002';

select results_eq(
  $$select id::text, plan_id::text from public.cards where topic_id = '60000000-0000-4000-8000-000000000002' order by id$$,
  $$values ('70000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000005'),
           ('70000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000005')$$,
  'a topic moved to another plan takes its cards along'
);
select is(
  (select plan_id from public.card_links where id = '80000000-0000-4000-8000-000000000003'),
  '50000000-0000-4000-8000-000000000005'::uuid,
  '... and the links starting at those cards'
);
select throws_ok(
  $$update public.topics set plan_id = '50000000-0000-4000-8000-000000000004'
    where id = '60000000-0000-4000-8000-000000000002'$$,
  '42501', null,
  'a topic cannot be moved into someone else''s plan'
);

-- Deletes -----------------------------------------------------------------------------------------
select is(pg_temp.affected($$delete from public.card_links where id = '80000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the creator deletes their card link');
select is(pg_temp.affected($$delete from public.cards where id = '70000000-0000-4000-8000-000000000002'$$),
  1::bigint, 'DELETE: the owner deletes a card');
select is(pg_temp.affected($$delete from public.plan_sources where id = '51000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the owner deletes a plan source');
select is(pg_temp.affected($$delete from public.topics where id = '60000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the owner deletes a topic');
select is(pg_temp.affected($$delete from public.study_plans where id = '50000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the owner deletes a plan');
select is(pg_temp.affected($$delete from public.sources where id = '40000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the owner deletes a source');

reset role;
select results_eq(
  $$select (select count(*) from public.topics where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.cards where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.card_links where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.study_sessions where plan_id = '50000000-0000-4000-8000-000000000001'),
           (select count(*) from public.study_sessions where id = '90000000-0000-4000-8000-000000000002')$$,
  $$values (0::bigint, 0::bigint, 0::bigint, 0::bigint, 1::bigint)$$,
  'deleting a plan deletes its content and detaches (but keeps) study sessions'
);

select * from finish();
rollback;
