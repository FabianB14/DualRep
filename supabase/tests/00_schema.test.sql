-- Schema-wide guarantees: every table has RLS, policies, the updated_at trigger and indexed foreign
-- keys; the API roles hold exactly the privileges the spec lists (anon: none at all); the powersync
-- publication lists every synced table and nothing else.
begin;
create extension if not exists pgtap with schema extensions;
select plan(67);

-- Tables ------------------------------------------------------------------------------------------
select set_eq(
  $$select c.relname::text from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'$$,
  array[
    'card_links', 'card_states', 'cards', 'entitlements', 'equipment_setups', 'exercise_sets',
    'exercises', 'group_members', 'groups', 'interval_blocks', 'plan_sources', 'presets', 'profiles',
    'reviews', 'source_chunks', 'source_files', 'sources', 'study_plans', 'study_sessions', 'topics',
    'tracy_events', 'transitions', 'workout_sessions'
  ],
  'public contains exactly the Phase 0 tables'
);

select is_empty(
  $$select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity$$,
  'every public table has row level security enabled'
);

select is_empty(
  $$select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)$$,
  'every public table has at least one policy'
);

select is_empty(
  $$select c.relname || ': ' || p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace
      and p.polroles <> array['authenticated'::regrole::oid]$$,
  'every policy applies to the authenticated role only'
);

select is_empty(
  $$select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not exists (
        select 1 from pg_trigger t
        where t.tgrelid = c.oid and not t.tgisinternal
          and t.tgfoid = 'public.set_updated_at()'::regprocedure
      )$$,
  'every public table maintains updated_at with set_updated_at()'
);

select is_empty(
  $$select con.conrelid::regclass::text || '.' || con.conname from pg_constraint con
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index i
        where i.indrelid = con.conrelid and i.indkey[0] = con.conkey[1]
      )$$,
  'every foreign key column leads an index'
);

select is_empty(
  $$select c.relname || '.' || a.attname from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and a.atttypid = 'numeric'::regtype$$,
  'no numeric columns (PowerSync would sync them as text)'
);

-- Privileges --------------------------------------------------------------------------------------
select is_empty(
  $$select c.relname, p.privilege from pg_class c
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and has_table_privilege('anon', c.oid, p.privilege)$$,
  'anon has no table privileges in public'
);

select is_empty(
  $$select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')$$,
  'anon has no column privileges in public'
);

select set_eq(
  $$select c.relname::text, p.privilege from pg_class c
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and has_table_privilege('authenticated', c.oid, p.privilege)$$,
  $$select t, p
    from unnest(array[
      'card_links', 'card_states', 'cards', 'equipment_setups', 'exercise_sets', 'exercises',
      'interval_blocks', 'plan_sources', 'presets', 'source_files', 'sources', 'study_plans',
      'study_sessions', 'topics', 'transitions', 'workout_sessions'
    ]) as t
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p
    union all
    values ('profiles', 'SELECT'), ('profiles', 'INSERT'), ('profiles', 'UPDATE'),
           ('entitlements', 'SELECT'),
           ('groups', 'SELECT'), ('groups', 'INSERT'), ('groups', 'DELETE'),
           ('group_members', 'SELECT'), ('group_members', 'DELETE'),
           ('source_chunks', 'SELECT'),
           ('reviews', 'SELECT'), ('reviews', 'INSERT'),
           ('tracy_events', 'SELECT')$$,
  'authenticated has exactly the table privileges the spec grants'
);

select set_eq(
  $$select c.relname::text, a.attname::text from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not has_table_privilege('authenticated', c.oid, 'UPDATE')
      and has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')$$,
  $$values ('groups', 'name'), ('tracy_events', 'accepted')$$,
  'the only column-level updates are groups.name and tracy_events.accepted'
);

select is_empty(
  $$select c.relname, p.privilege from pg_class c
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege)
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not has_table_privilege('service_role', c.oid, p.privilege)$$,
  'service_role can read and write every public table'
);

select is_empty(
  $$select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE')$$,
  'anon cannot execute any public function'
);

select set_eq(
  $$select p.proname::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')$$,
  array[
    'can_edit_plan', 'can_edit_source', 'can_read_card', 'can_read_plan', 'can_read_source',
    'generate_invite_code', 'has_paid_access', 'is_group_member', 'is_group_owner', 'is_valid_split',
    'join_group', 'shares_group_with'
  ],
  'authenticated can execute exactly the RLS helpers and join_group (no trigger functions)'
);

select is_empty(
  $$select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and not coalesce(p.proconfig, '{}') @> array['search_path=""']$$,
  'every security definer function pins an empty search_path'
);

-- Publication -------------------------------------------------------------------------------------
select set_eq(
  $$select tablename::text from pg_publication_tables where pubname = 'powersync' and schemaname = 'public'$$,
  array[
    'card_links', 'card_states', 'cards', 'entitlements', 'equipment_setups', 'exercise_sets',
    'exercises', 'group_members', 'groups', 'interval_blocks', 'plan_sources', 'presets', 'profiles',
    'reviews', 'source_files', 'sources', 'study_plans', 'study_sessions', 'topics', 'tracy_events',
    'transitions', 'workout_sessions'
  ],
  'the powersync publication lists every synced table'
);

select is_empty(
  $$select 1 from pg_publication_tables where pubname = 'powersync' and tablename = 'source_chunks'$$,
  'source_chunks (embeddings) is not published'
);

select ok(
  (select pubinsert and pubupdate and pubdelete and pubtruncate and not pubviaroot and not puballtables
   from pg_publication where pubname = 'powersync'),
  'powersync publishes inserts, updates, deletes and truncates of an explicit table list'
);

-- anon in practice: every table refuses reads and writes ------------------------------------------
set local role anon;

select throws_ok(
  format('select * from public.%I', c.relname), '42501', null,
  format('anon cannot select from %s', c.relname)
)
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by c.relname;

select throws_ok(
  format('insert into public.%I default values', c.relname), '42501', null,
  format('anon cannot insert into %s', c.relname)
)
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by c.relname;

select throws_ok(
  $$select public.join_group('ABCD2345')$$, '42501', null,
  'anon cannot call join_group'
);

reset role;

-- updated_at --------------------------------------------------------------------------------------
insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'ada@example.com');
insert into public.presets (id, owner_id, name, split, created_at, updated_at)
values ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Old name',
        '{"lower": 50, "upper": 50, "core": 0, "cardio": 0}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z');

set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

-- The client also sends an old updated_at; the trigger overrides it.
update public.presets set name = 'New name', updated_at = '1999-01-01T00:00:00Z'
where id = 'a0000000-0000-4000-8000-000000000001';

select is(
  (select updated_at from public.presets where id = 'a0000000-0000-4000-8000-000000000001'),
  now(),
  'an update sets updated_at to the transaction time, whatever the client sends'
);
select is(
  (select created_at from public.presets where id = 'a0000000-0000-4000-8000-000000000001'),
  '2000-01-01T00:00:00Z'::timestamptz,
  'an update leaves created_at alone'
);

reset role;

select * from finish();
rollback;
