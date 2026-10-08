-- tracy_events: created and worked by Edge Functions (service role). The device may read its own
-- events and set `accepted` — nothing else, and never on someone else's event.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

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

-- The transition planner finished a job for Ada.
insert into public.tracy_events (id, user_id, job, status, input, output, attempts, model, created_at, updated_at)
values ('f0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'transition_planner',
        'succeeded', '{"block_minutes": 25}', '{"preset": "full_body"}', 1, 'claude-sonnet',
        '2026-10-08T09:00:00Z', '2026-10-08T09:00:00Z');

set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select results_eq(
  $$select job, status, accepted from public.tracy_events$$,
  $$values ('transition_planner', 'succeeded', null::boolean)$$,
  'a user sees their own Tracy events'
);
select is(
  pg_temp.affected($$update public.tracy_events set accepted = true where id = 'f0000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: a user can accept a result'
);
select results_eq(
  $$select accepted, updated_at = now() from public.tracy_events where id = 'f0000000-0000-4000-8000-000000000001'$$,
  $$values (true, true)$$,
  'the acceptance is stored and updated_at is bumped'
);
select throws_ok(
  $$update public.tracy_events set status = 'queued' where id = 'f0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a user cannot change the status'
);
select throws_ok(
  $$update public.tracy_events set output = '{"preset": "all_upper"}' where id = 'f0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a user cannot change the output'
);
select throws_ok(
  $$update public.tracy_events set accepted = false, attempts = 0 where id = 'f0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a PATCH that mixes accepted with another column is refused'
);
select throws_ok(
  $$update public.tracy_events set accepted = false, updated_at = now() where id = 'f0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a PATCH may not send updated_at either (the server maintains it)'
);
select throws_ok(
  $$insert into public.tracy_events (id, user_id, job)
    values ('f0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'analyst')
    on conflict (id) do nothing$$,
  '42501', null,
  'a user cannot queue a Tracy job directly'
);
select throws_ok(
  $$insert into public.tracy_events (id, user_id, job)
    values ('f0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'analyst')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id, job = excluded.job$$,
  '42501', null,
  'a user cannot upsert a Tracy event'
);
select throws_ok(
  $$delete from public.tracy_events where id = 'f0000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a user cannot delete a Tracy event'
);

set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
select is(
  (select count(*) from public.tracy_events where id = 'f0000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a user cannot see someone else''s Tracy events'
);
select is(
  pg_temp.affected($$update public.tracy_events set accepted = false where id = 'f0000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'a user cannot accept or reject someone else''s result'
);

reset role;
select results_eq(
  $$select status, output, accepted, attempts from public.tracy_events where id = 'f0000000-0000-4000-8000-000000000001'$$,
  $$values ('succeeded', '{"preset": "full_body"}'::jsonb, true, 1)$$,
  'only Ada''s acceptance changed the event'
);

select * from finish();
rollback;
