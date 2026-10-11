-- Schema-wide guarantees: every table has RLS, policies, the updated_at trigger and indexed foreign
-- keys; no foreign key can make a delete depend on another row; every optional reference a client
-- writes is normalized by a trigger instead of being refused; the API roles hold exactly the
-- privileges the spec lists (anon: none at all); the powersync publication lists every synced table
-- and nothing else.
begin;
create extension if not exists pgtap with schema extensions;
select plan(76);

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

-- Deleting a row (or an account) must never depend on anyone else's rows: no RESTRICT / NO ACTION.
select is_empty(
  $$select con.conrelid::regclass::text || '.' || con.conname from pg_constraint con
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace
      and con.confdeltype not in ('c', 'n')$$,
  'every foreign key either cascades or sets null on delete (none can block a delete)'
);

-- The ones that point at rows another person may own detach instead of deleting.
select set_eq(
  $$select con.conrelid::regclass::text || '.' || a.attname from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace and con.confdeltype = 'n'$$,
  array[
    'cards.source_chunk_id', 'cards.source_id', 'exercise_sets.exercise_id', 'exercises.group_id',
    'profiles.default_preset_id', 'profiles.default_setup_id', 'reviews.interval_block_id',
    'source_chunks.group_id', 'source_files.group_id', 'sources.group_id', 'study_plans.group_id',
    'study_sessions.plan_id', 'tracy_events.plan_id', 'tracy_events.source_id',
    'transitions.workout_session_id', 'workout_sessions.preset_id', 'workout_sessions.setup_id'
  ],
  'references that may cross users (and group links) are ON DELETE SET NULL'
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
           ('groups', 'SELECT'), ('groups', 'DELETE'),
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

select set_eq(
  $$select c.relname::text, a.attname::text from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not has_table_privilege('authenticated', c.oid, 'INSERT')
      and has_column_privilege('authenticated', c.oid, a.attnum, 'INSERT')$$,
  $$values ('groups', 'id'), ('groups', 'owner_id'), ('groups', 'name'), ('groups', 'created_at'),
           ('groups', 'updated_at')$$,
  'the only column-level inserts are on groups, and invite_code is not among them (the server picks it)'
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
    'can_edit_plan', 'can_edit_source', 'can_read_card', 'can_read_exercise', 'can_read_plan',
    'can_read_source', 'generate_invite_code', 'has_paid_access', 'is_group_member', 'is_group_owner',
    'is_valid_split', 'join_group', 'regenerate_invite_code', 'remove_group_member', 'shares_group_with'
  ],
  'authenticated can execute exactly the access helpers and the group RPCs (no trigger functions)'
);

select set_eq(
  $$select p.proname::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and has_function_privilege('service_role', p.oid, 'EXECUTE')$$,
  array[
    'can_edit_plan', 'can_edit_source', 'can_read_card', 'can_read_exercise', 'can_read_plan',
    'apply_outline_approval', 'can_read_source', 'claim_tracy_events', 'enqueue_tracy_event',
    'generate_invite_code', 'has_paid_access', 'is_group_member', 'is_group_owner', 'is_valid_split',
    'orphaned_source_objects', 'release_tracy_event', 'requeue_tracy_event', 'shares_group_with'
  ],
  'service_role can execute the access helpers and the job queue, but not the user-only RPCs or trigger functions'
);

select is_empty(
  $$select p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and not coalesce(p.proconfig, '{}') @> array['search_path=""']$$,
  'every security definer function pins an empty search_path'
);

-- Optional references and sharing are normalized, never refused (section 4 of the migration) ------
-- The functions must run as the caller: they tell client requests (current_user = 'authenticated')
-- from trusted server-side writes, which a security definer function could not.
select set_eq(
  $$select p.proname::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'clear\_%' and not p.prosecdef$$,
  array[
    'clear_foreign_interval_block', 'clear_foreign_profile_defaults', 'clear_foreign_workout_refs',
    'clear_foreign_workout_session', 'clear_group_unless_member', 'clear_unreadable_exercise',
    'clear_unreadable_plan', 'clear_unreadable_source_chunk'
  ],
  'the normalizing trigger functions exist and are security invoker'
);

-- Every optional reference a client can write (other than to auth.users, which RLS pins to the
-- caller): pinned here so the next test cannot pass vacuously.
select set_eq(
  $$select c.relname || '.' || a.attname from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace
      and con.confrelid <> 'auth.users'::regclass and not a.attnotnull
      and (has_column_privilege('authenticated', c.oid, a.attnum, 'INSERT')
           or has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE'))$$,
  array[
    'cards.source_chunk_id', 'cards.source_id', 'exercise_sets.exercise_id', 'exercises.group_id',
    'profiles.default_preset_id', 'profiles.default_setup_id', 'reviews.interval_block_id',
    'source_files.group_id', 'sources.group_id', 'study_plans.group_id', 'study_sessions.plan_id',
    'transitions.workout_session_id', 'workout_sessions.preset_id', 'workout_sessions.setup_id'
  ],
  'the optional references clients can write'
);

-- ... and each one is rewritten by a BEFORE INSERT and UPDATE row trigger that covers the column
-- (a clear_* function, the copy from the parent source for source_files.group_id, or the derivation
-- from the source chunk for cards.source_id), so a value the writer may not use is stored as null (or
-- replaced) instead of failing RLS (42501) or the foreign key (23503).
select is_empty(
  $$select c.relname || '.' || a.attname from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace
      and con.confrelid <> 'auth.users'::regclass and not a.attnotnull
      and (has_column_privilege('authenticated', c.oid, a.attnum, 'INSERT')
           or has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE'))
      and not exists (
        select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = c.oid and not t.tgisinternal
          and t.tgtype & (1 | 2 | 4 | 16) = (1 | 2 | 4 | 16)  -- row, before, insert, update
          and (p.proname like 'clear\_%' or p.proname in ('copy_source_ownership', 'copy_card_source_id'))
          and (cardinality(t.tgattr::int2[]) = 0 or a.attnum = any (t.tgattr::int2[]))
      )$$,
  'every optional reference a client can write is normalized by a BEFORE trigger'
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
select throws_ok(
  $$select public.regenerate_invite_code('30000000-0000-4000-8000-000000000001')$$, '42501', null,
  'anon cannot call regenerate_invite_code'
);
select throws_ok(
  $$select public.remove_group_member('30000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'anon cannot call remove_group_member'
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
