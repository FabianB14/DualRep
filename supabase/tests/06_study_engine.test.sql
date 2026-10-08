-- card_states (private FSRS state; the id must be derived from (user_id, card_id), so nobody can
-- squat someone else's row id; a stale write from a second offline device is skipped without an
-- error) and reviews (append-only answer log; a retried upload is a no-op).
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- The card_states id rule (CARD_STATE_ID_NAMESPACE in src/db/constants.ts):
-- id = UUIDv5(namespace, '<user_id>:<card_id>').
create function pg_temp.card_state_id(user_id uuid, card_id uuid) returns uuid
language sql immutable as $$
  select extensions.uuid_generate_v5('c4cae30d-9668-4354-adc3-2ee1071432e7'::uuid,
                                     user_id::text || ':' || card_id::text)
$$;

-- Runs one write and returns how many rows it changed. RLS hides other people's rows from UPDATE
-- and DELETE (0 rows, no error), and the stale-write guard skips rows the same way.
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

-- Ada and Bob each have a private plan with one card; Ada also hosts a group (with Bob) whose plan
-- has a shared card.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');
insert into public.groups (id, owner_id, name)
values ('30000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Pair');
insert into public.group_members (group_id, user_id, role)
values ('30000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'member');
insert into public.study_plans (id, owner_id, group_id, title, scope) values
  ('50000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', null, 'Ada', 'single'),
  ('50000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', null, 'Bob', 'single'),
  ('50000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
   '30000000-0000-4000-8000-000000000001', 'Shared', 'single');
insert into public.topics (id, plan_id, title) values
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'T'),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'T'),
  ('60000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', 'T');
insert into public.cards (id, topic_id, question, answer) values
  ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'Ada Q', 'A'),
  ('70000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 'Bob Q', 'A'),
  ('70000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000003', 'Shared Q', 'A');

-- card_states as Ada --------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

-- 57743c5a-... is the worked example in src/db/constants.ts (Ada 1111...1111 + card 7000...0001), so
-- this also proves the documented derivation is the one the server enforces. The rest of the file
-- uses it as the id of Ada's state for card 1.
select is(
  pg_temp.card_state_id('11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000001'),
  '57743c5a-f966-538b-bccb-0919027b21c9'::uuid,
  'the card_states id of (Ada, card 1) is the documented test vector'
);
select lives_ok(
  $$insert into public.card_states (id, user_id, card_id, state, due, stability, difficulty, scheduled_days,
                                    learning_steps, reps, lapses, last_review, suspended)
    values ('57743c5a-f966-538b-bccb-0919027b21c9', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 2, '2026-10-05T10:00:00.000Z', 3.1, 5.2, 3, 0, 1, 0,
            '2026-10-02T10:00:00.000Z', false)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      state = excluded.state, due = excluded.due, stability = excluded.stability,
      difficulty = excluded.difficulty, scheduled_days = excluded.scheduled_days,
      learning_steps = excluded.learning_steps, reps = excluded.reps, lapses = excluded.lapses,
      last_review = excluded.last_review, suspended = excluded.suspended$$,
  'PUT: a user stores their state for a card'
);

-- A second device that reviewed the card earlier uploads its older state.
select lives_ok(
  $$insert into public.card_states (id, user_id, card_id, state, due, stability, difficulty, scheduled_days,
                                    learning_steps, reps, lapses, last_review, suspended)
    values ('57743c5a-f966-538b-bccb-0919027b21c9', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 1, '2026-10-01T11:00:00.000Z', 0.5, 7, 0, 1, 9, 2,
            '2026-10-01T10:00:00.000Z', false)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      state = excluded.state, due = excluded.due, stability = excluded.stability,
      difficulty = excluded.difficulty, scheduled_days = excluded.scheduled_days,
      learning_steps = excluded.learning_steps, reps = excluded.reps, lapses = excluded.lapses,
      last_review = excluded.last_review, suspended = excluded.suspended$$,
  'a stale upsert from another device does not error (the upload queue keeps moving)'
);
select results_eq(
  $$select state, reps, lapses, last_review from public.card_states where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$,
  $$values (2::smallint, 1, 0, '2026-10-02T10:00:00.000Z'::timestamptz)$$,
  '... and leaves the newer state unchanged'
);
select is(
  pg_temp.affected($$update public.card_states set reps = 9, last_review = '2026-10-01T10:00:00.000Z'
    where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  0::bigint,
  'a stale PATCH changes nothing and does not error'
);
select is(
  pg_temp.affected($$update public.card_states set last_review = null
    where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  0::bigint,
  'a PATCH that clears last_review counts as stale'
);
select lives_ok(
  $$insert into public.card_states (id, user_id, card_id, state, due, stability, difficulty, scheduled_days,
                                    learning_steps, reps, lapses, last_review, suspended)
    values ('57743c5a-f966-538b-bccb-0919027b21c9', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 2, '2026-10-12T10:00:00.000Z', 8.4, 5.0, 9, 0, 2, 0,
            '2026-10-03T10:00:00.000Z', false)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      state = excluded.state, due = excluded.due, stability = excluded.stability,
      difficulty = excluded.difficulty, scheduled_days = excluded.scheduled_days,
      learning_steps = excluded.learning_steps, reps = excluded.reps, lapses = excluded.lapses,
      last_review = excluded.last_review, suspended = excluded.suspended$$,
  'PUT: a newer review state uploads'
);
select results_eq(
  $$select reps, scheduled_days, last_review from public.card_states
    where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$,
  $$values (2, 9, '2026-10-03T10:00:00.000Z'::timestamptz)$$,
  '... and replaces the older one'
);
select is(
  pg_temp.affected($$update public.card_states set suspended = true
    where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  1::bigint,
  'PATCH: a change that does not touch last_review applies'
);
select is(
  pg_temp.affected($$update public.card_states set reps = 2, last_review = '2026-10-03T10:00:00.000Z'
    where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  1::bigint,
  'a retried PATCH with the same last_review applies'
);
select throws_ok(
  $$insert into public.card_states (id, user_id, card_id, due)
    values (pg_temp.card_state_id('11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000002'),
            '11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000002',
            '2026-10-05T10:00:00.000Z')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due$$,
  '42501', null,
  'a user cannot keep state for a card they cannot read'
);
select throws_ok(
  $$insert into public.card_states (id, user_id, card_id, due)
    values (pg_temp.card_state_id('22222222-2222-4222-8222-222222222222', '70000000-0000-4000-8000-000000000001'),
            '22222222-2222-4222-8222-222222222222', '70000000-0000-4000-8000-000000000001',
            '2026-10-05T10:00:00.000Z')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due$$,
  '42501', null,
  'a user cannot write state in someone else''s name'
);
select throws_ok(
  $$update public.card_states set difficulty = 11 where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$,
  '23514', null,
  'difficulty stays between 0 and 10'
);

-- The id rule.
select throws_ok(
  $$insert into public.card_states (id, user_id, card_id, due)
    values ('c5000000-0000-4000-8000-000000000009', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000003', '2026-10-05T10:00:00.000Z')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due$$,
  '23514', null,
  'a card state whose id is not derived from (user_id, card_id) is refused'
);
select throws_ok(
  $$update public.card_states set card_id = '70000000-0000-4000-8000-000000000003'
    where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$,
  '23514', null,
  'a card state cannot be moved to another card (its id would no longer match)'
);

-- card_states as Bob ------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';

-- Bob knows Ada's user id (group roster) and the shared card's id, so he can compute the id Ada's
-- device will use for that card. Taking it first would block every upload of Ada's state for it.
select throws_ok(
  $$insert into public.card_states (id, user_id, card_id, due)
    values (pg_temp.card_state_id('11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000003'),
            '22222222-2222-4222-8222-222222222222',
            '70000000-0000-4000-8000-000000000002', '2026-10-05T10:00:00.000Z')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due$$,
  '23514', null,
  'nobody can take another user''s derived id with their own card'
);
select throws_ok(
  $$insert into public.card_states (id, user_id, card_id, due)
    values (pg_temp.card_state_id('11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000003'),
            '22222222-2222-4222-8222-222222222222',
            '70000000-0000-4000-8000-000000000003', '2026-10-05T10:00:00.000Z')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due$$,
  '23514', null,
  '... nor with the same shared card'
);

select is((select count(*) from public.card_states where id = '57743c5a-f966-538b-bccb-0919027b21c9'),
  0::bigint, 'a user cannot see someone else''s card state');
select is(
  pg_temp.affected($$update public.card_states set reps = 0 where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  0::bigint, 'a user cannot update someone else''s card state'
);
select is(
  pg_temp.affected($$delete from public.card_states where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  0::bigint, 'a user cannot delete someone else''s card state'
);
select lives_ok(
  $$insert into public.card_states (id, user_id, card_id, due)
    values (pg_temp.card_state_id('22222222-2222-4222-8222-222222222222', '70000000-0000-4000-8000-000000000003'),
            '22222222-2222-4222-8222-222222222222', '70000000-0000-4000-8000-000000000003',
            '2026-10-05T10:00:00.000Z')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due$$,
  'a group member keeps their own state for a shared card'
);

set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select is((select count(*) from public.card_states
           where id = pg_temp.card_state_id('22222222-2222-4222-8222-222222222222', '70000000-0000-4000-8000-000000000003')),
  0::bigint, 'the plan owner cannot see a member''s state for a shared card');
select lives_ok(
  $$insert into public.card_states (id, user_id, card_id, due, last_review, reps)
    values (pg_temp.card_state_id('11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000003'),
            '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000003', '2026-10-06T10:00:00.000Z', '2026-10-05T10:00:00.000Z', 1)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      due = excluded.due, last_review = excluded.last_review, reps = excluded.reps$$,
  'the owner of a derived id can always upload their state under it'
);
select is(
  pg_temp.affected($$delete from public.card_states where id = '57743c5a-f966-538b-bccb-0919027b21c9'$$),
  1::bigint, 'DELETE: a user deletes their own card state'
);

-- reviews -----------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.reviews (id, user_id, card_id, rating, answer_mode, reviewed_at, duration_ms, prev_state,
                                elapsed_days, state, due_at, stability, difficulty, scheduled_days)
    values ('d0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 3, 'typed', '2026-10-03T10:00:00.000Z', 5400, 2, 1, 2,
            '2026-10-12T10:00:00.000Z', 8.4, 5.0, 9)
    on conflict (id) do nothing$$,
  'PUT (insert-ignore): a user logs a review'
);
select lives_ok(
  $$insert into public.reviews (id, user_id, card_id, rating, answer_mode, reviewed_at, duration_ms, prev_state,
                                elapsed_days, state, due_at, stability, difficulty, scheduled_days)
    values ('d0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 1, 'typed', '2026-10-03T10:00:00.000Z', 5400, 2, 1, 2,
            '2026-10-12T10:00:00.000Z', 8.4, 5.0, 9)
    on conflict (id) do nothing$$,
  'a retried review upload does not error'
);
select is(
  (select rating from public.reviews where id = 'd0000000-0000-4000-8000-000000000001'),
  3::smallint,
  '... and does not change the logged answer'
);
select throws_ok(
  $$update public.reviews set rating = 4 where id = 'd0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'reviews cannot be updated'
);
select throws_ok(
  $$delete from public.reviews where id = 'd0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'reviews cannot be deleted'
);
select throws_ok(
  $$insert into public.reviews (id, user_id, card_id, rating, answer_mode, reviewed_at, prev_state, state,
                                due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 4, 'typed', '2026-10-03T10:00:00.000Z', 2, 2,
            '2026-10-12T10:00:00.000Z', 8.4, 5.0)
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, card_id = excluded.card_id,
      rating = excluded.rating, answer_mode = excluded.answer_mode, reviewed_at = excluded.reviewed_at,
      prev_state = excluded.prev_state, state = excluded.state, due_at = excluded.due_at,
      stability = excluded.stability, difficulty = excluded.difficulty$$,
  '42501', null,
  'a DO UPDATE upsert of a review is refused (append-only, hence insert-ignore)'
);
select throws_ok(
  $$insert into public.reviews (id, user_id, card_id, rating, answer_mode, reviewed_at, prev_state, state,
                                due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000002', 3, 'typed', now(), 0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  '42501', null,
  'a user cannot log a review of a card they cannot read'
);
select throws_ok(
  $$insert into public.reviews (id, user_id, card_id, rating, answer_mode, reviewed_at, prev_state, state,
                                due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 5, 'typed', now(), 0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  '23514', null,
  'a rating is 1 to 4'
);

set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
select is((select count(*) from public.reviews where id = 'd0000000-0000-4000-8000-000000000001'),
  0::bigint, 'a user cannot see someone else''s reviews');
select throws_ok(
  $$insert into public.reviews (id, user_id, card_id, rating, answer_mode, reviewed_at, prev_state, state,
                                due_at, stability, difficulty)
    values ('d0000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
            '70000000-0000-4000-8000-000000000001', 1, 'self_graded', now(), 0, 1, now(), 1, 5)
    on conflict (id) do nothing$$,
  '42501', null,
  'a user cannot log a review in someone else''s name'
);

reset role;

select * from finish();
rollback;
