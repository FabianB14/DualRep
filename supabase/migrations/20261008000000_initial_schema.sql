-- =================================================================================================
-- DualRep — initial schema (Phase 0)
--
-- The whole data model from the execution plan (all 23 tables), with row level security, explicit
-- grants, the system presets and the `powersync` publication. Tests: supabase/tests/*.test.sql
-- (`npm run db:test` locally, `supabase test db` in CI).
--
-- Conventions
--   * Tables live in `public`, are lowercase plurals, and have `id uuid primary key default
--     gen_random_uuid()` (devices send their own UUIDs; the default serves server-created rows),
--     `created_at` and `updated_at timestamptz not null default now()`. On INSERT the device's values
--     are kept (a row made offline keeps its real creation time); on every UPDATE
--     public.set_updated_at() overwrites updated_at with the server's clock. The one id without a
--     default is card_states.id, which must be derived from (user_id, card_id).
--   * Enumerations are text + CHECK (adding a value is a one-line migration; no enum types).
--     JSON is jsonb; lists are jsonb arrays. No `numeric` columns: PowerSync would sync them as TEXT,
--     so fractional values use double precision.
--   * Every user reference is `references auth.users (id) on delete cascade`: deleting an account
--     deletes its data (Google Play requires account deletion).
--   * Deleting a row or an account never depends on anyone else's data. No foreign key restricts a
--     delete, and a reference that can point at another person's row (a set's exercise, a session's
--     plan, a card's source chunk, a shared row's group, ...) is `on delete set null`, so their
--     delete detaches your row instead of failing or deleting it. 00_schema.test.sql enforces this.
--   * A write made offline is never dropped because of something someone else did meanwhile (left
--     or was removed from a group, unshared or deleted a row). So the server NORMALIZES what it may
--     not store instead of refusing the write (BEFORE triggers, section 4; client requests only):
--       - an optional (nullable) reference to a row the caller may not use, or that no longer
--         exists, is stored as null (a set keeps exercise_name as its label);
--       - a row shared into a group the caller is not a member of is stored unshared.
--     Required (NOT NULL) parent references are still refused by RLS (42501): a child of a parent
--     you cannot use is meaningless. The exception is a user's private study history (reviews,
--     card_states): it is stored as long as the card still exists, even if the user can no longer
--     read it, and skipped silently if the card was deleted (the cascade would have removed it).
--   * Every foreign key and every column used by RLS or by a sync stream filter is indexed.
--   * RLS is enabled on every table. Policies are `to authenticated` and call `(select auth.uid())`
--     so Postgres evaluates it once per statement instead of once per row. Checks that read other
--     tables go through `security definer` helpers with `set search_path = ''`, which avoids policy
--     recursion (group_members reading group_members) and search_path hijacking.
--   * Grants are explicit. Older Supabase projects grant everything in `public` to anon and
--     authenticated by default; projects created since 2026-05-30 grant nothing. Each table therefore
--     starts with `revoke all ... from anon, authenticated` and then grants exactly what the client
--     may do, so both kinds of project end up identical. anon gets nothing at all.
--   * Devices write through PowerSync's Supabase connector, i.e. PostgREST:
--       PUT    -> INSERT ... ON CONFLICT (id) DO UPDATE SET <every sent column>   (upsert)
--                 or INSERT ... ON CONFLICT (id) DO NOTHING for insert-only tables (reviews, groups)
--       PATCH  -> UPDATE ... SET <changed columns> WHERE id = $1
--       DELETE -> DELETE ... WHERE id = $1
--     An upsert needs SELECT + INSERT + UPDATE privileges and policies. Any ON CONFLICT (id), even
--     DO NOTHING, needs SELECT on `id`, and Postgres then checks the SELECT policy against the new
--     row. Every SELECT policy below therefore admits any row its INSERT policy admits.
--   * Columns copied from a parent (source_files/source_chunks.owner_id + group_id, cards.plan_id,
--     card_links.plan_id) are set by BEFORE triggers, so whatever a device sends is overwritten and
--     cannot be forged. They exist so PowerSync can bucket rows per user / per plan.
--   * Every object is schema-qualified, so this file does not depend on the session search_path.
-- =================================================================================================

create extension if not exists vector with schema extensions;
-- uuid_generate_v5() for the card_states id rule (section 2). Supabase preinstalls uuid-ossp in
-- `extensions`, so there this is a no-op.
create extension if not exists "uuid-ossp" with schema extensions;


-- =================================================================================================
-- 1. Functions the table definitions use (no table access)
-- =================================================================================================

-- Shared BEFORE UPDATE trigger: the server owns updated_at.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- A preset split: an object with exactly the numeric keys lower, upper, core and cardio, each
-- between 0 and 100, adding up to 100. Used by a CHECK constraint, hence immutable.
create function public.is_valid_split(s jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  total numeric := 0;
  part jsonb;
begin
  if s is null or jsonb_typeof(s) <> 'object' then
    return false;
  end if;
  if not (s ?& array['lower', 'upper', 'core', 'cardio'])
     or (select count(*) from jsonb_object_keys(s)) <> 4 then
    return false;
  end if;
  for part in select value from jsonb_each(s) loop
    if jsonb_typeof(part) <> 'number' or part::numeric < 0 or part::numeric > 100 then
      return false;
    end if;
    total := total + part::numeric;
  end loop;
  return total = 100;
end;
$$;

-- Default for groups.invite_code (and the new code made by regenerate_invite_code() and
-- remove_group_member()): 8 characters
-- from an alphabet without look-alikes (no I, L, O, 0, 1), so a code read aloud or copied by hand
-- still works. Randomness comes from gen_random_uuid() (core Postgres), so there is no pgcrypto
-- dependency. Bytes >= 248 are skipped so each of the 31 characters is equally likely (248 = 8 * 31).
-- 31^8 ~ 8.5e11 codes; the unique constraint catches the (negligible) chance of a collision.
create function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  random_bytes bytea;
  byte_value integer;
  -- Byte positions of a version-4 UUID that are fully random (6 and 8 hold version/variant bits).
  random_positions constant integer[] := array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15];
  pos integer;
  code text := '';
begin
  while length(code) < 8 loop
    random_bytes := uuid_send(gen_random_uuid());
    foreach pos in array random_positions loop
      byte_value := get_byte(random_bytes, pos);
      if byte_value < 248 then
        code := code || substr(alphabet, byte_value % 31 + 1, 1);
        exit when length(code) = 8;
      end if;
    end loop;
  end loop;
  return code;
end;
$$;


-- =================================================================================================
-- 2. Tables (in foreign-key order), their indexes, RLS switch and updated_at trigger
-- =================================================================================================

-- Groups of friends (max 8 members). Subscribers create and host; anyone can join with the code.
-- The server always picks the invite code: clients have no INSERT or UPDATE privilege on it
-- (section 7), and only the owner can replace it, through regenerate_invite_code() or
-- remove_group_member() (section 6).
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique default public.generate_invite_code()
    check (invite_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index groups_owner_id_idx on public.groups (owner_id);

-- Membership. Rows are created by the groups trigger (owner) and by join_group() (members). The
-- client can only delete its own membership (leave); the owner removes a member with
-- remove_group_member() (section 6).
create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, user_id)
);
-- (group_id, user_id) is covered by the unique index.
create index group_members_user_id_idx on public.group_members (user_id);

-- Training focus presets. owner_id null = system preset (seeded below, read-only to clients).
create table public.presets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null default 'custom'
    check (kind in ('all_lower', 'mostly_lower', 'full_body', 'mostly_upper', 'all_upper',
                    'mostly_cardio', 'custom')),
  split jsonb not null check (public.is_valid_split(split)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index presets_owner_id_idx on public.presets (owner_id);

-- Equipment available at a place the user trains.
create table public.equipment_setups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  location text not null check (location in ('gym', 'home')),
  equipment jsonb not null default '[]' check (jsonb_typeof(equipment) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index equipment_setups_user_id_idx on public.equipment_setups (user_id);

-- One row per user, created by handle_new_user() when the auth user is created.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  unit_pref text not null default 'lb' check (unit_pref in ('lb', 'kg')),
  default_block_minutes integer not null default 25 check (default_block_minutes between 10 and 50),
  default_preset_id uuid references public.presets (id) on delete set null,
  default_setup_id uuid references public.equipment_setups (id) on delete set null,
  fsrs_params jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_default_preset_id_idx on public.profiles (default_preset_id);
create index profiles_default_setup_id_idx on public.profiles (default_setup_id);

-- What the user has paid for. Written only by the service role (store webhook / beta tooling).
create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'subscription')),
  source text not null default 'none' check (source in ('none', 'store', 'beta')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Exercise library (origin dataset/interverse, service-role only, visible once reviewed) plus each
-- user's own exercises (origin user), optionally shared with a group.
create table public.exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  muscle_group text,
  secondary_muscles jsonb not null default '[]' check (jsonb_typeof(secondary_muscles) = 'array'),
  body_region text check (body_region in ('lower', 'upper', 'core', 'full', 'cardio')),
  category text check (category in ('strength', 'power', 'conditioning', 'mobility')),
  dataset_category text,
  equipment jsonb not null default '[]' check (jsonb_typeof(equipment) = 'array'),
  location text not null default 'both' check (location in ('gym', 'home', 'both')),
  movement_pattern text
    check (movement_pattern in ('squat', 'hinge', 'lunge', 'horizontal_push', 'vertical_push',
                                'horizontal_pull', 'vertical_pull', 'carry', 'core', 'conditioning',
                                'mobility', 'other')),
  demand_level smallint check (demand_level between 1 and 3),
  level text check (level in ('beginner', 'intermediate', 'expert')),
  force text check (force in ('push', 'pull', 'static')),
  mechanic text check (mechanic in ('compound', 'isolation')),
  micro_ok boolean not null default false,
  instructions jsonb not null default '[]' check (jsonb_typeof(instructions) = 'array'),
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array'),
  origin text not null check (origin in ('dataset', 'interverse', 'user')),
  dataset_id text unique,
  reviewed boolean not null default false,
  owner_id uuid references auth.users (id) on delete cascade,
  -- The exercise belongs to its owner, not to the group: deleting the group only unshares it (as
  -- for sources and study plans), so a group delete never destroys a member's own exercise.
  group_id uuid references public.groups (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- User exercises always have an owner; library rows never do.
  constraint exercises_owner_matches_origin check ((origin = 'user') = (owner_id is not null)),
  -- Only user exercises can be shared with a group.
  constraint exercises_group_only_for_user_rows check (group_id is null or origin = 'user'),
  -- dataset_id is the library import's idempotency key (free-exercise-db ids are public). A user row
  -- holding one would make the import fail, skip the exercise, or merge into the user's row.
  constraint exercises_dataset_id_only_for_dataset check (dataset_id is null or origin = 'dataset'),
  -- `reviewed` is the library's human-review flag; a user row can never claim it.
  constraint exercises_user_rows_unreviewed check (origin <> 'user' or reviewed = false)
);
create index exercises_owner_id_idx on public.exercises (owner_id);
create index exercises_group_id_idx on public.exercises (group_id);

-- Study material: an uploaded PDF/doc, a link, or typed notes.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid references public.groups (id) on delete set null,
  kind text not null check (kind in ('pdf', 'doc', 'link', 'notes')),
  title text not null default '',
  url text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sources_owner_id_idx on public.sources (owner_id);
create index sources_group_id_idx on public.sources (group_id);

-- Files (pages, photos of handwritten notes) of a source. owner_id/group_id are copied from the
-- source by a trigger.
create table public.source_files (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid references public.groups (id) on delete set null,
  storage_path text not null,
  page integer,
  transcript text,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index source_files_source_id_idx on public.source_files (source_id);
create index source_files_owner_id_idx on public.source_files (owner_id);
create index source_files_group_id_idx on public.source_files (group_id);

-- SERVER ONLY: embedded chunks of a source for retrieval. Never synced to devices and not in the
-- powersync publication (embeddings are large). Written by Edge Functions with the service role.
create table public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid references public.groups (id) on delete set null,
  page integer,
  content text not null,
  embedding extensions.vector(1536),
  embed_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index source_chunks_source_id_idx on public.source_chunks (source_id);
create index source_chunks_owner_id_idx on public.source_chunks (owner_id);
create index source_chunks_group_id_idx on public.source_chunks (group_id);
create index source_chunks_embedding_idx on public.source_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- A study plan: one exam/subject (single) or a growing body of material (cumulative).
create table public.study_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid references public.groups (id) on delete set null,
  title text not null default '',
  scope text not null check (scope in ('single', 'cumulative')),
  goal text not null default '',
  target_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index study_plans_owner_id_idx on public.study_plans (owner_id);
create index study_plans_group_id_idx on public.study_plans (group_id);

-- Which sources a plan is built from.
create table public.plan_sources (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, source_id)
);
-- plan_id is covered by the unique index.
create index plan_sources_source_id_idx on public.plan_sources (source_id);

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans (id) on delete cascade,
  title text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index topics_plan_id_idx on public.topics (plan_id);

-- Quiz cards. plan_id is copied from the topic by a trigger so cards sync in one bucket per plan.
create table public.cards (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics (id) on delete cascade,
  plan_id uuid not null references public.study_plans (id) on delete cascade,
  -- The passage the card came from. It may be in a group member's source; one the writer cannot
  -- read is stored as null (clear_source_chunk_reference, section 4).
  source_chunk_id uuid references public.source_chunks (id) on delete set null,
  page integer,
  question text not null,
  answer text not null,
  card_type text not null default 'basic'
    check (card_type in ('basic', 'cloze', 'why', 'write_from_memory')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cards_topic_id_idx on public.cards (topic_id);
create index cards_plan_id_idx on public.cards (plan_id);
create index cards_source_chunk_id_idx on public.cards (source_chunk_id);

-- Concept links between cards. plan_id is copied from from_card by a trigger.
create table public.card_links (
  id uuid primary key default gen_random_uuid(),
  from_card_id uuid not null references public.cards (id) on delete cascade,
  to_card_id uuid not null references public.cards (id) on delete cascade,
  plan_id uuid not null references public.study_plans (id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  relation text not null default 'related'
    check (relation in ('related', 'why', 'analogy', 'prerequisite', 'contrast')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint card_links_not_self check (from_card_id <> to_card_id)
);
create index card_links_from_card_id_idx on public.card_links (from_card_id);
create index card_links_to_card_id_idx on public.card_links (to_card_id);
create index card_links_plan_id_idx on public.card_links (plan_id);
create index card_links_created_by_idx on public.card_links (created_by);

-- One sitting of focused study, made of interval blocks.
create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- May be a group plan someone else owns; one the writer cannot read is stored as null
  -- (clear_plan_reference, section 4).
  plan_id uuid references public.study_plans (id) on delete set null,
  focus_subject text not null default '' check (char_length(focus_subject) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index study_sessions_user_id_idx on public.study_sessions (user_id);
create index study_sessions_plan_id_idx on public.study_sessions (plan_id);

-- One focus block. user_id is denormalized from the session so blocks sync in the per-user bucket.
create table public.interval_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  study_session_id uuid not null references public.study_sessions (id) on delete cascade,
  planned_minutes integer not null check (planned_minutes between 1 and 120),
  started_at timestamptz,
  ended_at timestamptz,
  interrupted boolean not null default false,
  effort_rating smallint check (effort_rating between 1 and 5),
  mode text not null default 'seated' check (mode in ('seated', 'on_the_go')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index interval_blocks_user_id_idx on public.interval_blocks (user_id);
create index interval_blocks_study_session_id_idx on public.interval_blocks (study_session_id);

-- Current FSRS state per user per card, with ts-fsrs `Card` field names. The device computes the id
-- from (user_id, card_id), so two offline devices converge on one row (Phase 2):
--   id = uuid_generate_v5('c4cae30d-9668-4354-adc3-2ee1071432e7', '<user_id>:<card_id>')
-- (both uuids in Postgres' lowercase text form; the namespace is CARD_STATE_ID_NAMESPACE in
-- src/db/constants.ts). The server enforces the derivation with a CHECK. Otherwise the id would be
-- predictable but unprotected: a group mate who knows your user id and a shared card id could insert
-- a row under YOUR future id (with their own user_id and card), and every upload of your real state
-- for that card would then hit their row and fail. No default: a random id can never be valid.
create table public.card_states (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null references public.cards (id) on delete cascade,
  state smallint not null default 0 check (state between 0 and 3),
  due timestamptz not null,
  stability double precision not null default 0 check (stability >= 0),
  difficulty double precision not null default 0 check (difficulty between 0 and 10),
  scheduled_days integer not null default 0 check (scheduled_days >= 0),
  learning_steps integer not null default 0 check (learning_steps >= 0),
  reps integer not null default 0 check (reps >= 0),
  lapses integer not null default 0 check (lapses >= 0),
  last_review timestamptz,
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, card_id),
  -- Also stops an UPDATE from moving a row to another user or card.
  constraint card_states_id_derived check (
    id = extensions.uuid_generate_v5('c4cae30d-9668-4354-adc3-2ee1071432e7'::uuid,
                                     user_id::text || ':' || card_id::text)
  )
);
-- The due list: WHERE user_id = ? AND due <= ? ORDER BY due. (user_id alone is covered by the unique index.)
create index card_states_user_id_due_idx on public.card_states (user_id, due);
create index card_states_card_id_idx on public.card_states (card_id);

-- Append-only answer log. The state columns hold the result AFTER the review (ts-fsrs
-- RecordLogItem.card); prev_state is the state before it. Needed for FSRS optimisation and for
-- rebuilding card_states after a two-device conflict.
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null references public.cards (id) on delete cascade,
  interval_block_id uuid references public.interval_blocks (id) on delete set null,
  rating smallint not null check (rating between 1 and 4),
  answer_mode text not null check (answer_mode in ('typed', 'spoken', 'handwritten', 'self_graded')),
  reviewed_at timestamptz not null,
  duration_ms integer check (duration_ms >= 0),
  prev_state smallint not null check (prev_state between 0 and 3),
  elapsed_days integer not null default 0 check (elapsed_days >= 0),
  state smallint not null check (state between 0 and 3),
  due_at timestamptz not null,
  stability double precision not null,
  difficulty double precision not null,
  scheduled_days integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reviews_user_id_reviewed_at_idx on public.reviews (user_id, reviewed_at);
create index reviews_card_id_reviewed_at_idx on public.reviews (card_id, reviewed_at);
create index reviews_interval_block_id_idx on public.reviews (interval_block_id);

create table public.workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  logged_at timestamptz not null default now(),
  kind text not null check (kind in ('micro', 'full', 'walk')),
  preset_id uuid references public.presets (id) on delete set null,
  setup_id uuid references public.equipment_setups (id) on delete set null,
  duration_minutes integer check (duration_minutes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workout_sessions_user_id_idx on public.workout_sessions (user_id);
create index workout_sessions_preset_id_idx on public.workout_sessions (preset_id);
create index workout_sessions_setup_id_idx on public.workout_sessions (setup_id);

-- One logged set. user_id is denormalized from the workout session (per-user sync bucket).
create table public.exercise_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workout_session_id uuid not null references public.workout_sessions (id) on delete cascade,
  -- The exercise may be someone else's (shared with a group), so it must not pin that row: when the
  -- exercise or its owner's account is deleted the set is kept with exercise_id = null (a RESTRICT
  -- here let any set, even an outsider's, block another person's account deletion). An exercise the
  -- writer cannot read is stored as null (clear_exercise_reference, section 4).
  exercise_id uuid references public.exercises (id) on delete set null,
  -- The exercise's name, copied by the device when the set is logged, so the history still reads
  -- "Goblet squat" after the exercise is deleted, unshared or no longer visible to this user.
  exercise_name text,
  set_index integer not null check (set_index >= 0),
  reps integer check (reps >= 0),
  weight_lbs double precision check (weight_lbs >= 0),
  rpe double precision check (rpe between 1 and 10),
  target_reps integer check (target_reps >= 0),
  target_weight_lbs double precision check (target_weight_lbs >= 0),
  rest_seconds integer check (rest_seconds >= 0),
  set_type text not null default 'normal' check (set_type in ('normal', 'drop', 'rest_pause')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index exercise_sets_user_id_idx on public.exercise_sets (user_id);
create index exercise_sets_workout_session_id_idx on public.exercise_sets (workout_session_id);
create index exercise_sets_exercise_id_idx on public.exercise_sets (exercise_id);

-- The handoff from a focus block to a training block (Tracy's proposal and whether it was taken).
create table public.transitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  interval_block_id uuid not null references public.interval_blocks (id) on delete cascade,
  workout_session_id uuid references public.workout_sessions (id) on delete set null,
  proposal jsonb not null default '{}',
  accepted boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transitions_user_id_idx on public.transitions (user_id);
create index transitions_interval_block_id_idx on public.transitions (interval_block_id);
create index transitions_workout_session_id_idx on public.transitions (workout_session_id);

-- Job queue + audit log for Tracy calls (rows are created by Edge Functions with the service role;
-- the device only records whether the user accepted a result).
create table public.tracy_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job text not null
    check (job in ('transition_planner', 'study_builder', 'answer_grader', 'analyst', 'handwriting')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input jsonb not null default '{}',
  output jsonb,
  error text,
  accepted boolean,
  attempts integer not null default 0,
  locked_at timestamptz,
  model text,
  usage jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tracy_events_user_id_created_at_idx on public.tracy_events (user_id, created_at);
-- The worker claims the oldest queued job.
create index tracy_events_queued_idx on public.tracy_events (created_at) where status = 'queued';

-- RLS on every table (policies are in section 5) -----------------------------------------------------
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.presets enable row level security;
alter table public.equipment_setups enable row level security;
alter table public.profiles enable row level security;
alter table public.entitlements enable row level security;
alter table public.exercises enable row level security;
alter table public.sources enable row level security;
alter table public.source_files enable row level security;
alter table public.source_chunks enable row level security;
alter table public.study_plans enable row level security;
alter table public.plan_sources enable row level security;
alter table public.topics enable row level security;
alter table public.cards enable row level security;
alter table public.card_links enable row level security;
alter table public.card_states enable row level security;
alter table public.reviews enable row level security;
alter table public.study_sessions enable row level security;
alter table public.interval_blocks enable row level security;
alter table public.workout_sessions enable row level security;
alter table public.exercise_sets enable row level security;
alter table public.transitions enable row level security;
alter table public.tracy_events enable row level security;

-- updated_at on every table -------------------------------------------------------------------------
create trigger set_updated_at before update on public.groups
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.group_members
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.presets
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.equipment_setups
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.entitlements
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.exercises
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.sources
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.source_files
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.source_chunks
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.study_plans
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.plan_sources
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.topics
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.cards
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.card_links
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.card_states
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.reviews
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.study_sessions
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.interval_blocks
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.workout_sessions
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.exercise_sets
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.transitions
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.tracy_events
  for each row execute function public.set_updated_at();


-- =================================================================================================
-- 3. Access helpers used by RLS policies and the normalizing triggers in section 4
--    security definer: they read tables the caller may not see (and group_members' own policy
--    would otherwise recurse). stable + search_path '' + fully-qualified names.
-- =================================================================================================

-- Is the caller a member of the group?
create function public.is_group_member(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = (select auth.uid())
  );
$$;

-- Is the caller the group's owner?
create function public.is_group_owner(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and g.owner_id = (select auth.uid())
  );
$$;

-- Do the caller and `uid` belong to a common group? (Profiles are visible to group mates.)
create function public.shares_group_with(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = uid
  );
$$;

-- Does `uid` have an active subscription? A signed-in user can only ask about themselves (so the
-- RPC cannot be used to probe other people's billing status); server contexts without a user JWT
-- (service role, SQL) can ask about anyone.
create function public.has_paid_access(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = uid
      and e.tier = 'subscription'
      and (e.expires_at is null or e.expires_at > now())
      and ((select auth.uid()) is null or uid = (select auth.uid()))
  );
$$;

-- Can the caller read the plan? (owner, or member of the plan's group)
create function public.can_read_plan(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.study_plans p
    where p.id = pid
      and (
        p.owner_id = (select auth.uid())
        or (p.group_id is not null and exists (
          select 1 from public.group_members m
          where m.group_id = p.group_id and m.user_id = (select auth.uid())
        ))
      )
  );
$$;

-- Can the caller edit the plan and its content? (owner only; group members read)
create function public.can_edit_plan(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.study_plans p
    where p.id = pid and p.owner_id = (select auth.uid())
  );
$$;

-- Can the caller read the source? (owner, or member of the source's group)
create function public.can_read_source(sid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sources s
    where s.id = sid
      and (
        s.owner_id = (select auth.uid())
        or (s.group_id is not null and exists (
          select 1 from public.group_members m
          where m.group_id = s.group_id and m.user_id = (select auth.uid())
        ))
      )
  );
$$;

-- Can the caller edit the source and its files? (owner only)
create function public.can_edit_source(sid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sources s
    where s.id = sid and s.owner_id = (select auth.uid())
  );
$$;

-- Can the caller read the card? (through the card's plan)
create function public.can_read_card(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cards c
    where c.id = cid and public.can_read_plan(c.plan_id)
  );
$$;

-- Can the caller read the exercise? The same rule as the exercises SELECT policy: a reviewed library
-- row, the caller's own row, or a row shared with one of the caller's groups.
create function public.can_read_exercise(eid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.exercises e
    where e.id = eid
      and (
        (e.owner_id is null and e.reviewed)
        or e.owner_id = (select auth.uid())
        or (e.group_id is not null and exists (
          select 1 from public.group_members m
          where m.group_id = e.group_id and m.user_id = (select auth.uid())
        ))
      )
  );
$$;


-- =================================================================================================
-- 4. Triggers
-- =================================================================================================

-- New auth user -> profile + free entitlement. Runs inside GoTrue's insert, so it must never fail
-- on ordinary input: both inserts are `on conflict do nothing` and the name is trimmed to fit.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        ''
      ),
      80
    )
  )
  on conflict do nothing;

  insert into public.entitlements (user_id, tier, source)
  values (new.id, 'free', 'none')
  on conflict do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A new group's owner is its first member.
create function public.add_group_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.group_members (group_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$$;

create trigger add_owner_membership
  after insert on public.groups
  for each row execute function public.add_group_owner_membership();

-- At most 8 members per group, whichever path inserts the row.
create function public.enforce_group_member_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock the group row first so concurrent joins to the same group take turns; otherwise two joins
  -- could both count 7 members and both insert.
  perform 1 from public.groups g where g.id = new.group_id for update;
  if (select count(*) from public.group_members m where m.group_id = new.group_id) >= 8 then
    raise exception 'group_full'
      using errcode = 'P0001', detail = 'A group can have at most 8 members.';
  end if;
  return new;
end;
$$;

create trigger enforce_member_limit
  before insert on public.group_members
  for each row execute function public.enforce_group_member_limit();

-- Leaving a group, or being removed from it, unshares that person's own content from the group:
-- their exercises, sources (the source's files and chunks follow through
-- propagate_source_ownership below) and study plans in that group get group_id = null.
-- Why: otherwise the rows would stay visible to people they no longer share a group with, and every
-- later edit of them would fail the "share only into your own groups" WITH CHECK (dropped on the
-- device as a fatal 42501). Uploads that still carry the old group_id afterwards (a retried PUT,
-- content created offline as shared) are stored unshared by clear_group_unless_member (below).
-- Other members keep their own rows that point at the unshared content (sets keep exercise_id and
-- exercise_name, study sessions keep plan_id); they just no longer see the rows themselves.
-- Skipped when the membership goes because the whole group or the member's account is being
-- deleted: the foreign-key actions (set null / cascade) already handle every one of those rows.
create function public.unshare_after_leaving_group()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.groups g where g.id = old.group_id)
     or not exists (select 1 from auth.users u where u.id = old.user_id) then
    return null;
  end if;
  update public.exercises e set group_id = null
   where e.owner_id = old.user_id and e.group_id = old.group_id;
  update public.sources s set group_id = null
   where s.owner_id = old.user_id and s.group_id = old.group_id;
  update public.study_plans p set group_id = null
   where p.owner_id = old.user_id and p.group_id = old.group_id;
  return null;
end;
$$;

create trigger unshare_after_leaving
  after delete on public.group_members
  for each row execute function public.unshare_after_leaving_group();

-- source_files / source_chunks: owner_id and group_id always come from the parent source.
create function public.copy_source_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_owner uuid;
  parent_group uuid;
begin
  select s.owner_id, s.group_id into parent_owner, parent_group
  from public.sources s
  where s.id = new.source_id;
  if not found then
    return new;  -- the foreign key reports the missing source
  end if;
  new.owner_id := parent_owner;
  -- When a group is deleted, ON DELETE SET NULL can reach this row before it reaches the parent
  -- source (the order of FK actions is not defined); never copy back a group that is being deleted.
  new.group_id := case
    when parent_group is not null and exists (select 1 from public.groups g where g.id = parent_group)
      then parent_group
  end;
  return new;
end;
$$;

create trigger copy_source_ownership
  before insert or update on public.source_files
  for each row execute function public.copy_source_ownership();
create trigger copy_source_ownership
  before insert or update on public.source_chunks
  for each row execute function public.copy_source_ownership();

-- A source changing owner or group carries its files and chunks along (they sync and are read by
-- their own owner_id/group_id). security definer: the source owner cannot write source_chunks.
-- The trigger has no column list (`update of owner_id, group_id` would not fire when a BEFORE trigger
-- such as clear_group_unless_member changes group_id in an UPDATE that did not set it); the WHEN
-- clause keeps it to real changes.
create function public.propagate_source_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.source_files f
     set owner_id = new.owner_id, group_id = new.group_id
   where f.source_id = new.id;
  update public.source_chunks c
     set owner_id = new.owner_id, group_id = new.group_id
   where c.source_id = new.id;
  return null;
end;
$$;

create trigger propagate_source_ownership
  after update on public.sources
  for each row
  when (old.owner_id is distinct from new.owner_id or old.group_id is distinct from new.group_id)
  execute function public.propagate_source_ownership();

-- cards.plan_id always comes from the card's topic.
create function public.copy_card_plan_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  topic_plan uuid;
begin
  select t.plan_id into topic_plan from public.topics t where t.id = new.topic_id;
  if found then
    new.plan_id := topic_plan;
  end if;
  return new;
end;
$$;

create trigger copy_plan_id
  before insert or update of topic_id, plan_id on public.cards
  for each row execute function public.copy_card_plan_id();

-- A topic moved to another plan takes its cards along.
create function public.propagate_topic_plan_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.cards c set plan_id = new.plan_id where c.topic_id = new.id;
  return null;
end;
$$;

create trigger propagate_plan_id
  after update of plan_id on public.topics
  for each row when (old.plan_id is distinct from new.plan_id)
  execute function public.propagate_topic_plan_id();

-- card_links.plan_id always comes from the link's from_card.
create function public.copy_card_link_plan_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  card_plan uuid;
begin
  select c.plan_id into card_plan from public.cards c where c.id = new.from_card_id;
  if found then
    new.plan_id := card_plan;
  end if;
  return new;
end;
$$;

create trigger copy_plan_id
  before insert or update of from_card_id, plan_id on public.card_links
  for each row execute function public.copy_card_link_plan_id();

-- A card whose plan changed takes the links that start at it along.
create function public.propagate_card_plan_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.card_links l set plan_id = new.plan_id where l.from_card_id = new.id;
  return null;
end;
$$;

create trigger propagate_plan_id
  after update of plan_id on public.cards
  for each row when (old.plan_id is distinct from new.plan_id)
  execute function public.propagate_card_plan_id();

-- card_states: only accept newer FSRS state. If the same user reviewed a card on two offline
-- devices, the older upload arrives second; it is skipped (the statement still succeeds, so the
-- device's upload queue keeps moving). The reviews log keeps both answers for a later rebuild.
create function public.skip_stale_card_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.last_review is not null
     and (new.last_review is null or new.last_review < old.last_review) then
    return null;
  end if;
  return new;
end;
$$;

create trigger skip_stale_write
  before update on public.card_states
  for each row execute function public.skip_stale_card_state();

-- Optional references and sharing are NORMALIZED, never refused.
-- A device may upload a write long after it was made. Meanwhile someone else may have left or been
-- removed from a group, unshared a row or deleted it, so a value that was fine on the device can now
-- name a row the writer may not use, or nothing at all. Refusing the write (42501 from a check, 23503
-- from the foreign key) would drop it on the device for good. These BEFORE triggers rewrite the row
-- instead, before RLS and the foreign keys look at it:
--   * an optional reference to a row the writer may not use, or to a row that does not exist, is
--     stored as null. A missing id and an unreadable id give the same stored row, so nothing about
--     other people's rows is revealed. (A set keeps exercise_name as its label.)
--   * a row shared into a group its writer is not a member of is stored unshared (group_id null).
-- Only client requests are rewritten: current_user = 'authenticated', i.e. a Data API request made
-- with a user's JWT (the functions are security invoker, so current_user is the caller). The service
-- role (Edge Functions), SQL run as postgres, security definer functions and foreign-key actions (ON
-- DELETE SET NULL runs as the table owner) are trusted and left alone.
-- Required (NOT NULL) parent references are not rewritten: RLS refuses them (42501).

-- References to rows someone else may own (a group plan, a group-shared exercise, a chunk of a group
-- member's source) are judged when a client SETS or CHANGES them, and never re-judged afterwards: a
-- session, set or card that already holds one keeps it after the row becomes unreadable (the link
-- works again if the row is shared again), and re-sending the stored value keeps it too.
--   * On UPDATE, an unchanged value is kept.
--   * PowerSync uploads a new row as an upsert (INSERT ... ON CONFLICT (id) DO UPDATE) and re-sends
--     it unchanged when a half-uploaded transaction is retried. Postgres fires BEFORE INSERT on the
--     proposed row even when the id already exists, so an INSERT counts as unchanged when the stored
--     row with that id already holds this reference (looked up under the caller's RLS, so only a row
--     they can see counts; whether they may overwrite it is still up to the UPDATE policy). The DO
--     UPDATE half then fires BEFORE UPDATE with old = the stored row, which also sees no change.
--   * Any other value the caller cannot read (or that does not exist) is cleared.

-- study_sessions.plan_id: a plan the caller can read (own, or shared with one of their groups).
create function public.clear_unreadable_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or new.plan_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.plan_id is not distinct from old.plan_id then
      return new;
    end if;
  elsif exists (
    select 1 from public.study_sessions s where s.id = new.id and s.plan_id = new.plan_id
  ) then
    return new;  -- a re-sent upsert of the caller's own row
  end if;
  if not public.can_read_plan(new.plan_id) then
    new.plan_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_plan_reference
  before insert or update of plan_id on public.study_sessions
  for each row execute function public.clear_unreadable_plan();

-- exercise_sets.exercise_id: an exercise the caller can read (reviewed library, own, or shared with
-- one of their groups). Without this, anyone who knew an exercise's id could attach sets to it.
create function public.clear_unreadable_exercise()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or new.exercise_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.exercise_id is not distinct from old.exercise_id then
      return new;
    end if;
  elsif exists (
    select 1 from public.exercise_sets s where s.id = new.id and s.exercise_id = new.exercise_id
  ) then
    return new;  -- a re-sent upsert of the caller's own row
  end if;
  if not public.can_read_exercise(new.exercise_id) then
    new.exercise_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_exercise_reference
  before insert or update of exercise_id on public.exercise_sets
  for each row execute function public.clear_unreadable_exercise();

-- cards.source_chunk_id: a chunk whose source the caller can read. (Only the plan owner writes
-- cards. The chunk lookup runs under RLS, which shows a chunk exactly when its source is readable,
-- because a chunk's owner_id/group_id are copied from its source.)
create function public.clear_unreadable_source_chunk()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or new.source_chunk_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.source_chunk_id is not distinct from old.source_chunk_id then
      return new;
    end if;
  elsif exists (
    select 1 from public.cards c where c.id = new.id and c.source_chunk_id = new.source_chunk_id
  ) then
    return new;  -- a re-sent upsert of the caller's own row
  end if;
  if not exists (
    select 1 from public.source_chunks sc
    where sc.id = new.source_chunk_id and public.can_read_source(sc.source_id)
  ) then
    new.source_chunk_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_source_chunk_reference
  before insert or update of source_chunk_id on public.cards
  for each row execute function public.clear_unreadable_source_chunk();

-- References that may only name the caller's own rows (or a system preset). Such a row never becomes
-- someone else's, and deleting it nulls every stored reference to it (ON DELETE SET NULL), so a
-- stored value always passes and is kept on a re-send. What gets cleared is a value naming someone
-- else's row, or a row deleted while the device was offline (which the foreign key would refuse).
-- Group mates can read profiles, so a profile must never name a row its owner cannot see either.

-- workout_sessions.preset_id (a system preset or the caller's own) and setup_id (the caller's own).
create function public.clear_foreign_workout_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.preset_id is not null and not exists (
    select 1 from public.presets p
    where p.id = new.preset_id and (p.owner_id is null or p.owner_id = (select auth.uid()))
  ) then
    new.preset_id := null;
  end if;
  if new.setup_id is not null and not exists (
    select 1 from public.equipment_setups s
    where s.id = new.setup_id and s.user_id = (select auth.uid())
  ) then
    new.setup_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_preset_and_setup_references
  before insert or update of preset_id, setup_id on public.workout_sessions
  for each row execute function public.clear_foreign_workout_refs();

-- profiles.default_preset_id (a system preset or the caller's own) and default_setup_id (own).
create function public.clear_foreign_profile_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.default_preset_id is not null and not exists (
    select 1 from public.presets p
    where p.id = new.default_preset_id and (p.owner_id is null or p.owner_id = (select auth.uid()))
  ) then
    new.default_preset_id := null;
  end if;
  if new.default_setup_id is not null and not exists (
    select 1 from public.equipment_setups s
    where s.id = new.default_setup_id and s.user_id = (select auth.uid())
  ) then
    new.default_setup_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_default_references
  before insert or update of default_preset_id, default_setup_id on public.profiles
  for each row execute function public.clear_foreign_profile_defaults();

-- transitions.workout_session_id: one of the caller's own workout sessions.
create function public.clear_foreign_workout_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and new.workout_session_id is not null and not exists (
    select 1 from public.workout_sessions w
    where w.id = new.workout_session_id and w.user_id = (select auth.uid())
  ) then
    new.workout_session_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_workout_session_reference
  before insert or update of workout_session_id on public.transitions
  for each row execute function public.clear_foreign_workout_session();

-- reviews.interval_block_id: one of the caller's own interval blocks. (Clients only insert reviews.)
create function public.clear_foreign_interval_block()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and new.interval_block_id is not null and not exists (
    select 1 from public.interval_blocks b
    where b.id = new.interval_block_id and b.user_id = (select auth.uid())
  ) then
    new.interval_block_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_interval_block_reference
  before insert or update of interval_block_id on public.reviews
  for each row execute function public.clear_foreign_interval_block();

-- reviews / card_states.card_id: a user's private study history. An answer given offline must not be
-- lost because the card's plan was unshared, its owner left, or the user was removed meanwhile, so
-- RLS only checks that the row is the caller's own (it is never visible to anyone else). If the card
-- was deleted while the device was offline, the row is skipped (no error, nothing stored): the
-- cascade would have removed it anyway, and refusing it would make the device drop it as a failure.
-- Security definer because the card may no longer be visible to the caller under RLS.
create function public.skip_study_row_without_card()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.cards c where c.id = new.card_id) then
    return null;
  end if;
  return new;
end;
$$;

create trigger skip_without_card
  before insert on public.reviews
  for each row execute function public.skip_study_row_without_card();
create trigger skip_without_card
  before insert on public.card_states
  for each row execute function public.skip_study_row_without_card();

-- exercises / sources / study_plans.group_id: a row can only be shared into a group its owner is a
-- member of. A client row naming any other group is stored unshared instead of being refused: e.g.
-- content created offline as shared and uploaded after its owner left or was removed, or a retried
-- PUT that still carries the old group_id. The content itself is kept, and so are its topics,
-- cards, files and sets (their RLS checks the owner, not the group).
-- It fires on every client INSERT and UPDATE, not only on writes that send group_id: then even a row
-- left shared by a race with leaving (a new row committed just after the leave's unshare ran) is
-- unshared by its owner's next edit instead of failing it. The membership WITH CHECK in section 5
-- stays as a second line of defence and, after this trigger, always passes for client rows.
create function public.clear_group_unless_member()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and new.group_id is not null
     and not public.is_group_member(new.group_id) then
    new.group_id := null;
  end if;
  return new;
end;
$$;

create trigger clear_group_unless_member
  before insert or update on public.exercises
  for each row execute function public.clear_group_unless_member();
create trigger clear_group_unless_member
  before insert or update on public.sources
  for each row execute function public.clear_group_unless_member();
create trigger clear_group_unless_member
  before insert or update on public.study_plans
  for each row execute function public.clear_group_unless_member();


-- =================================================================================================
-- 5. Row level security policies (all `to authenticated`; anon has no grants at all)
-- =================================================================================================

-- profiles: own row, plus group mates' rows (display names). The defaults may only name a system
-- preset or the user's own preset / equipment setup (group mates can read the profile, so it must
-- not name rows the user cannot see); anything else is stored as null by clear_default_references
-- (section 4).
create policy "profiles: read own and group mates" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_group_with(id));
create policy "profiles: insert own" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- entitlements: read own; written by the service role only.
create policy "entitlements: read own" on public.entitlements
  for select to authenticated
  using (user_id = (select auth.uid()));

-- presets: system presets are readable by everyone and writable by no client.
create policy "presets: read system and own" on public.presets
  for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy "presets: insert own" on public.presets
  for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "presets: update own" on public.presets
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "presets: delete own" on public.presets
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- equipment_setups: own rows only.
create policy "equipment_setups: read own" on public.equipment_setups
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "equipment_setups: insert own" on public.equipment_setups
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "equipment_setups: update own" on public.equipment_setups
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "equipment_setups: delete own" on public.equipment_setups
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- exercises: reviewed library rows, own rows, and rows shared with the caller's groups.
-- Clients may only write their own `user` rows; library rows are service-role only.
create policy "exercises: read library, own and group" on public.exercises
  for select to authenticated
  using (
    (owner_id is null and reviewed)
    or owner_id = (select auth.uid())
    or (group_id is not null and public.is_group_member(group_id))
  );
create policy "exercises: insert own" on public.exercises
  for insert to authenticated
  with check (
    origin = 'user' and owner_id = (select auth.uid())
    and (group_id is null or public.is_group_member(group_id))
  );
-- Sharing INTO a group requires membership, on insert and on every update. clear_group_unless_member
-- (section 4) has already stored a client row naming any other group as unshared, so for client
-- writes this is a second line of defence that always passes: leaving or being removed never makes
-- the owner's own rows unwritable, and an upload that still names the old group is kept, unshared.
-- Same for sources and study_plans.
create policy "exercises: update own" on public.exercises
  for update to authenticated
  using (origin = 'user' and owner_id = (select auth.uid()))
  with check (
    origin = 'user' and owner_id = (select auth.uid())
    and (group_id is null or public.is_group_member(group_id))
  );
create policy "exercises: delete own" on public.exercises
  for delete to authenticated
  using (origin = 'user' and owner_id = (select auth.uid()));

-- groups: owner and members read; only subscribers create; only the owner renames or deletes.
-- The SELECT policy includes owner_id so an upsert's new row passes before the AFTER INSERT trigger
-- has added the owner's membership.
create policy "groups: read as owner or member" on public.groups
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_group_member(id));
create policy "groups: subscribers create" on public.groups
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.has_paid_access((select auth.uid())));
create policy "groups: owner updates" on public.groups
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "groups: owner deletes" on public.groups
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- group_members: members see the roster. Joining goes through join_group(). The only DELETE a client
-- may make is leaving: deleting its own membership (the owner cannot, they delete the group instead).
-- The owner removes someone else only through remove_group_member() (section 6), which deletes the
-- membership and rotates the invite code in one transaction, because the removed member still
-- knows the old code. A direct DELETE of another member's row matches no row (0 rows, no error).
-- Either way the departed member's shared content is unshared by unshare_after_leaving_group().
-- (There is no ban list: join_group() only admits holders of the current code.)
create policy "group_members: read own groups" on public.group_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_group_member(group_id));
create policy "group_members: leave" on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) and role <> 'owner');

-- sources: owner and group members read; the owner writes and may share only with own groups.
create policy "sources: read own and group" on public.sources
  for select to authenticated
  using (owner_id = (select auth.uid()) or (group_id is not null and public.is_group_member(group_id)));
create policy "sources: insert own" on public.sources
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (group_id is null or public.is_group_member(group_id))
  );
create policy "sources: update own" on public.sources
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (group_id is null or public.is_group_member(group_id))
  );
create policy "sources: delete own" on public.sources
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- source_files: read like the source (via the copied owner_id/group_id); the source owner writes.
create policy "source_files: read own and group" on public.source_files
  for select to authenticated
  using (owner_id = (select auth.uid()) or (group_id is not null and public.is_group_member(group_id)));
create policy "source_files: insert by source owner" on public.source_files
  for insert to authenticated
  with check (public.can_edit_source(source_id));
create policy "source_files: update by source owner" on public.source_files
  for update to authenticated
  using (public.can_edit_source(source_id))
  with check (public.can_edit_source(source_id));
create policy "source_files: delete by source owner" on public.source_files
  for delete to authenticated
  using (public.can_edit_source(source_id));

-- source_chunks: read-only to clients (never synced; read through the API for retrieval).
create policy "source_chunks: read own and group" on public.source_chunks
  for select to authenticated
  using (owner_id = (select auth.uid()) or (group_id is not null and public.is_group_member(group_id)));

-- study_plans: like sources.
create policy "study_plans: read own and group" on public.study_plans
  for select to authenticated
  using (owner_id = (select auth.uid()) or (group_id is not null and public.is_group_member(group_id)));
create policy "study_plans: insert own" on public.study_plans
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (group_id is null or public.is_group_member(group_id))
  );
create policy "study_plans: update own" on public.study_plans
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (group_id is null or public.is_group_member(group_id))
  );
create policy "study_plans: delete own" on public.study_plans
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- plan_sources: readable with the plan; the plan owner links sources they can read.
-- USING checks the plan only, so a link to a source that is no longer readable can still be removed.
create policy "plan_sources: read with plan" on public.plan_sources
  for select to authenticated
  using (public.can_read_plan(plan_id));
create policy "plan_sources: insert by plan owner" on public.plan_sources
  for insert to authenticated
  with check (public.can_edit_plan(plan_id) and public.can_read_source(source_id));
create policy "plan_sources: update by plan owner" on public.plan_sources
  for update to authenticated
  using (public.can_edit_plan(plan_id))
  with check (public.can_edit_plan(plan_id) and public.can_read_source(source_id));
create policy "plan_sources: delete by plan owner" on public.plan_sources
  for delete to authenticated
  using (public.can_edit_plan(plan_id));

-- topics: readable with the plan; written by the plan owner.
create policy "topics: read with plan" on public.topics
  for select to authenticated
  using (public.can_read_plan(plan_id));
create policy "topics: insert by plan owner" on public.topics
  for insert to authenticated
  with check (public.can_edit_plan(plan_id));
create policy "topics: update by plan owner" on public.topics
  for update to authenticated
  using (public.can_edit_plan(plan_id))
  with check (public.can_edit_plan(plan_id));
create policy "topics: delete by plan owner" on public.topics
  for delete to authenticated
  using (public.can_edit_plan(plan_id));

-- cards: readable with the plan; written by the plan owner (plan_id is trigger-copied from the topic;
-- a source_chunk_id the writer cannot read is stored as null by clear_source_chunk_reference in
-- section 4).
create policy "cards: read with plan" on public.cards
  for select to authenticated
  using (public.can_read_plan(plan_id));
create policy "cards: insert by plan owner" on public.cards
  for insert to authenticated
  with check (public.can_edit_plan(plan_id));
create policy "cards: update by plan owner" on public.cards
  for update to authenticated
  using (public.can_edit_plan(plan_id))
  with check (public.can_edit_plan(plan_id));
create policy "cards: delete by plan owner" on public.cards
  for delete to authenticated
  using (public.can_edit_plan(plan_id));

-- card_links: anyone who can read the plan may link its cards (to cards they can read); each
-- person edits and deletes only their own links.
create policy "card_links: read with plan" on public.card_links
  for select to authenticated
  using (public.can_read_plan(plan_id));
create policy "card_links: insert own" on public.card_links
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_read_plan(plan_id)
    and public.can_read_card(to_card_id)
  );
create policy "card_links: update own" on public.card_links
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (
    created_by = (select auth.uid())
    and public.can_read_plan(plan_id)
    and public.can_read_card(to_card_id)
  );
create policy "card_links: delete own" on public.card_links
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- card_states: private per user. Only ownership is checked (not can_read_card): a state reviewed
-- offline must still upload after the card became unreadable (skip_study_row_without_card, section 4,
-- handles a deleted card). The derived-id CHECK still stops anyone from taking another user's id.
create policy "card_states: read own" on public.card_states
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "card_states: insert own" on public.card_states
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "card_states: update own" on public.card_states
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "card_states: delete own" on public.card_states
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- reviews: append-only (no update or delete policies, and no such grants). Private per user; like
-- card_states only ownership is checked, so an offline answer uploads even after the card became
-- unreadable. An interval block that is not one of the caller's own is stored as null
-- (clear_interval_block_reference, section 4).
create policy "reviews: read own" on public.reviews
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "reviews: insert own" on public.reviews
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- study_sessions: own rows. A session may point at any plan the user can read, but that is judged
-- only when plan_id is set (clear_plan_reference, section 4, stores an unreadable one as null), not
-- here: after leaving a group, a session that pointed at the group's plan must stay editable (and
-- re-uploadable).
create policy "study_sessions: read own" on public.study_sessions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "study_sessions: insert own" on public.study_sessions
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "study_sessions: update own" on public.study_sessions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "study_sessions: delete own" on public.study_sessions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- interval_blocks: own rows whose study session is also the caller's (the denormalized user_id
-- must agree with the parent).
create policy "interval_blocks: read own" on public.interval_blocks
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "interval_blocks: insert own" on public.interval_blocks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.study_sessions s
      where s.id = study_session_id and s.user_id = (select auth.uid())
    )
  );
create policy "interval_blocks: update own" on public.interval_blocks
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.study_sessions s
      where s.id = study_session_id and s.user_id = (select auth.uid())
    )
  );
create policy "interval_blocks: delete own" on public.interval_blocks
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- workout_sessions: own rows. The preset is a system preset or the user's own and the equipment setup
-- is the user's own; any other value is stored as null (clear_preset_and_setup_references,
-- section 4).
create policy "workout_sessions: read own" on public.workout_sessions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "workout_sessions: insert own" on public.workout_sessions
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "workout_sessions: update own" on public.workout_sessions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "workout_sessions: delete own" on public.workout_sessions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- exercise_sets: own rows whose workout session is also the caller's. The exercise is judged when
-- exercise_id is set (clear_exercise_reference, section 4, stores an unreadable one as null), not
-- here, because a shared exercise can later become unreadable (its owner leaves the group) and the
-- set must stay editable.
create policy "exercise_sets: read own" on public.exercise_sets
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "exercise_sets: insert own" on public.exercise_sets
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.workout_sessions w
      where w.id = workout_session_id and w.user_id = (select auth.uid())
    )
  );
create policy "exercise_sets: update own" on public.exercise_sets
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.workout_sessions w
      where w.id = workout_session_id and w.user_id = (select auth.uid())
    )
  );
create policy "exercise_sets: delete own" on public.exercise_sets
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- transitions: own rows whose interval block is also the caller's. The workout session it led to, if
-- any, is one of the caller's own; any other value is stored as null
-- (clear_workout_session_reference, section 4).
create policy "transitions: read own" on public.transitions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "transitions: insert own" on public.transitions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.interval_blocks b
      where b.id = interval_block_id and b.user_id = (select auth.uid())
    )
  );
create policy "transitions: update own" on public.transitions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.interval_blocks b
      where b.id = interval_block_id and b.user_id = (select auth.uid())
    )
  );
create policy "transitions: delete own" on public.transitions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- tracy_events: read own; update own (the column grant limits that to `accepted`).
create policy "tracy_events: read own" on public.tracy_events
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "tracy_events: update own" on public.tracy_events
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


-- =================================================================================================
-- 6. Group RPCs: join by invite code (the only way a client adds a membership), remove a member
--    (the only way to delete someone else's membership) and rotate the code
-- =================================================================================================

-- Returns the group id. Errors (P0001, which PostgREST returns as HTTP 400; P0002 would be a 500):
-- invalid_invite_code (P0001) when no group has the code,
-- group_full (P0001, from the member-limit trigger) at 8 members. Joining a group you are already in
-- returns its id without changes, so a retried call is harmless.
-- The group row is locked while joining. remove_group_member() and regenerate_invite_code() update
-- that row, so a join racing with them waits for them to commit and then re-reads the code: a
-- removed member can never slip back in with the code that was current when the removal started.
create function public.join_group(p_invite_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_group uuid;
begin
  if caller is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Codes are stored upper case (CHECK on groups.invite_code), so this uses the unique index.
  select g.id into target_group
  from public.groups g
  where g.invite_code = upper(btrim(coalesce(p_invite_code, '')))
  for update;
  if target_group is null then
    raise exception 'invalid_invite_code' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.group_members m
    where m.group_id = target_group and m.user_id = caller
  ) then
    return target_group;
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (target_group, caller, 'member')
  on conflict (group_id, user_id) do nothing;  -- a concurrent duplicate join
  return target_group;
end;
$$;

-- Gives the group a new invite code and returns it; the old code stops working at once (people who
-- already joined stay members). Owner only: anyone else gets not_group_owner (42501).
-- (Removing a member rotates the code by itself; see remove_group_member() below.)
create function public.regenerate_invite_code(p_group_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  new_code text;
begin
  if caller is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  update public.groups g
     set invite_code = public.generate_invite_code()
   where g.id = p_group_id and g.owner_id = caller
  returning g.invite_code into new_code;
  if new_code is null then
    raise exception 'not_group_owner' using errcode = '42501';
  end if;
  return new_code;
end;
$$;

-- Removes a member from the group for good and returns the group's new invite code (Phase 4).
-- Owner only. In ONE transaction it deletes the member's group_members row (which unshares their
-- content, see unshare_after_leaving_group) and gives the group a new invite code. Both must happen
-- together: every member can read the code, so a removal without a rotation lets the removed member
-- re-join with the code they know, and a rotation before the removal lets them read the new code
-- and re-join with that. The app calls this online; it never queues a local DELETE of someone else's
-- membership (the DELETE policy only lets a member leave, so such a DELETE would change nothing and
-- the row would come back with the next sync). Share the returned code with the people who should
-- still have it.
-- Errors: not_authenticated (42501) without a user; not_group_owner (42501) when the caller does not
-- own the group (also when it does not exist); cannot_remove_owner (P0001) when the owner names
-- themselves (they delete the group instead). Removing someone who is not (or no longer) a member is
-- not an error: the code is rotated anyway, so a member who left seconds before the owner tapped
-- Remove cannot re-join with the code they still know.
create function public.remove_group_member(p_group_id uuid, p_user_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  new_code text;
begin
  if caller is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Lock the group row (join_group() locks it too), so no join can interleave with the removal.
  perform 1 from public.groups g where g.id = p_group_id and g.owner_id = caller for update;
  if not found then
    raise exception 'not_group_owner' using errcode = '42501';
  end if;
  if p_user_id is not distinct from caller then
    raise exception 'cannot_remove_owner'
      using errcode = 'P0001', detail = 'The owner cannot leave their own group; they delete it instead.';
  end if;

  delete from public.group_members m
   where m.group_id = p_group_id and m.user_id = p_user_id;

  update public.groups g
     set invite_code = public.generate_invite_code()
   where g.id = p_group_id
  returning g.invite_code into new_code;
  return new_code;
end;
$$;


-- =================================================================================================
-- 7. Grants
--    Tables: revoke everything from the API roles, then grant exactly what the device may do.
--    service_role (Edge Functions, webhooks) gets everything and bypasses RLS.
-- =================================================================================================

revoke all on public.profiles from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

revoke all on public.entitlements from anon, authenticated;
grant select on public.entitlements to authenticated;
grant all on public.entitlements to service_role;

revoke all on public.presets from anon, authenticated;
grant select, insert, update, delete on public.presets to authenticated;
grant all on public.presets to service_role;

revoke all on public.equipment_setups from anon, authenticated;
grant select, insert, update, delete on public.equipment_setups to authenticated;
grant all on public.equipment_setups to service_role;

revoke all on public.exercises from anon, authenticated;
grant select, insert, update, delete on public.exercises to authenticated;
grant all on public.exercises to service_role;

revoke all on public.study_sessions from anon, authenticated;
grant select, insert, update, delete on public.study_sessions to authenticated;
grant all on public.study_sessions to service_role;

revoke all on public.interval_blocks from anon, authenticated;
grant select, insert, update, delete on public.interval_blocks to authenticated;
grant all on public.interval_blocks to service_role;

revoke all on public.workout_sessions from anon, authenticated;
grant select, insert, update, delete on public.workout_sessions to authenticated;
grant all on public.workout_sessions to service_role;

revoke all on public.exercise_sets from anon, authenticated;
grant select, insert, update, delete on public.exercise_sets to authenticated;
grant all on public.exercise_sets to service_role;

revoke all on public.transitions from anon, authenticated;
grant select, insert, update, delete on public.transitions to authenticated;
grant all on public.transitions to service_role;

-- invite_code is never chosen by the phone: there is no INSERT or UPDATE privilege on it, so it always
-- comes from the column default, and only regenerate_invite_code() and remove_group_member() replace
-- it (a client-chosen code could be guessable, and a code the owner cannot change cannot shut a
-- removed member out). The
-- registry marks it serverGenerated, so the connector never sends it. A column added to groups later
-- must be added to this INSERT grant if the device creates it.
-- owner_id is not client-updatable either. Because PostgREST's upsert puts every sent column in its
-- DO UPDATE SET list (and Postgres checks those privileges even when nothing conflicts), the device
-- creates groups with INSERT ... ON CONFLICT (id) DO NOTHING instead.
revoke all on public.groups from anon, authenticated;
grant select, delete on public.groups to authenticated;
grant insert (id, owner_id, name, created_at, updated_at) on public.groups to authenticated;
grant update (name) on public.groups to authenticated;
grant all on public.groups to service_role;

-- DELETE is for leaving (the policy admits only the caller's own membership); removing someone else
-- goes through remove_group_member().
revoke all on public.group_members from anon, authenticated;
grant select, delete on public.group_members to authenticated;
grant all on public.group_members to service_role;

revoke all on public.sources from anon, authenticated;
grant select, insert, update, delete on public.sources to authenticated;
grant all on public.sources to service_role;

revoke all on public.source_files from anon, authenticated;
grant select, insert, update, delete on public.source_files to authenticated;
grant all on public.source_files to service_role;

revoke all on public.source_chunks from anon, authenticated;
grant select on public.source_chunks to authenticated;
grant all on public.source_chunks to service_role;

revoke all on public.study_plans from anon, authenticated;
grant select, insert, update, delete on public.study_plans to authenticated;
grant all on public.study_plans to service_role;

revoke all on public.plan_sources from anon, authenticated;
grant select, insert, update, delete on public.plan_sources to authenticated;
grant all on public.plan_sources to service_role;

revoke all on public.topics from anon, authenticated;
grant select, insert, update, delete on public.topics to authenticated;
grant all on public.topics to service_role;

revoke all on public.cards from anon, authenticated;
grant select, insert, update, delete on public.cards to authenticated;
grant all on public.cards to service_role;

revoke all on public.card_links from anon, authenticated;
grant select, insert, update, delete on public.card_links to authenticated;
grant all on public.card_links to service_role;

revoke all on public.card_states from anon, authenticated;
grant select, insert, update, delete on public.card_states to authenticated;
grant all on public.card_states to service_role;

-- Append-only: no UPDATE, so the device uploads with ON CONFLICT (id) DO NOTHING and a retried upload
-- is harmless. (That still needs SELECT: the conflict target reads `id`.)
revoke all on public.reviews from anon, authenticated;
grant select, insert on public.reviews to authenticated;
grant all on public.reviews to service_role;

-- The device may only record whether the user accepted a result.
revoke all on public.tracy_events from anon, authenticated;
grant select on public.tracy_events to authenticated;
grant update (accepted) on public.tracy_events to authenticated;
grant all on public.tracy_events to service_role;

-- Functions --------------------------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default (and older Supabase projects to anon/authenticated).
-- Policy helpers, the CHECK helper and the column-default helper run with the caller's privileges,
-- so authenticated needs them; anon never does.
revoke all on function public.is_group_member(uuid) from public, anon;
grant execute on function public.is_group_member(uuid) to authenticated, service_role;
revoke all on function public.is_group_owner(uuid) from public, anon;
grant execute on function public.is_group_owner(uuid) to authenticated, service_role;
revoke all on function public.shares_group_with(uuid) from public, anon;
grant execute on function public.shares_group_with(uuid) to authenticated, service_role;
revoke all on function public.has_paid_access(uuid) from public, anon;
grant execute on function public.has_paid_access(uuid) to authenticated, service_role;
revoke all on function public.can_read_plan(uuid) from public, anon;
grant execute on function public.can_read_plan(uuid) to authenticated, service_role;
revoke all on function public.can_edit_plan(uuid) from public, anon;
grant execute on function public.can_edit_plan(uuid) to authenticated, service_role;
revoke all on function public.can_read_source(uuid) from public, anon;
grant execute on function public.can_read_source(uuid) to authenticated, service_role;
revoke all on function public.can_edit_source(uuid) from public, anon;
grant execute on function public.can_edit_source(uuid) to authenticated, service_role;
revoke all on function public.can_read_card(uuid) from public, anon;
grant execute on function public.can_read_card(uuid) to authenticated, service_role;
revoke all on function public.can_read_exercise(uuid) from public, anon;
grant execute on function public.can_read_exercise(uuid) to authenticated, service_role;
revoke all on function public.is_valid_split(jsonb) from public, anon;
grant execute on function public.is_valid_split(jsonb) to authenticated, service_role;
revoke all on function public.generate_invite_code() from public, anon;
grant execute on function public.generate_invite_code() to authenticated, service_role;

-- The RPCs are for signed-in users only (they need auth.uid()).
revoke all on function public.join_group(text) from public, anon, service_role;
grant execute on function public.join_group(text) to authenticated;
revoke all on function public.regenerate_invite_code(uuid) from public, anon, service_role;
grant execute on function public.regenerate_invite_code(uuid) to authenticated;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon, service_role;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

-- Trigger functions are never called directly (Postgres does not check EXECUTE when a trigger
-- fires), so nobody gets EXECUTE.
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function public.add_group_owner_membership() from public, anon, authenticated, service_role;
revoke all on function public.enforce_group_member_limit() from public, anon, authenticated, service_role;
revoke all on function public.copy_source_ownership() from public, anon, authenticated, service_role;
revoke all on function public.propagate_source_ownership() from public, anon, authenticated, service_role;
revoke all on function public.copy_card_plan_id() from public, anon, authenticated, service_role;
revoke all on function public.propagate_topic_plan_id() from public, anon, authenticated, service_role;
revoke all on function public.copy_card_link_plan_id() from public, anon, authenticated, service_role;
revoke all on function public.propagate_card_plan_id() from public, anon, authenticated, service_role;
revoke all on function public.skip_stale_card_state() from public, anon, authenticated, service_role;
revoke all on function public.unshare_after_leaving_group() from public, anon, authenticated, service_role;
revoke all on function public.clear_unreadable_plan() from public, anon, authenticated, service_role;
revoke all on function public.clear_unreadable_exercise() from public, anon, authenticated, service_role;
revoke all on function public.clear_unreadable_source_chunk() from public, anon, authenticated, service_role;
revoke all on function public.clear_foreign_workout_refs() from public, anon, authenticated, service_role;
revoke all on function public.clear_foreign_profile_defaults() from public, anon, authenticated, service_role;
revoke all on function public.clear_foreign_workout_session() from public, anon, authenticated, service_role;
revoke all on function public.clear_foreign_interval_block() from public, anon, authenticated, service_role;
revoke all on function public.clear_group_unless_member() from public, anon, authenticated, service_role;
revoke all on function public.skip_study_row_without_card() from public, anon, authenticated, service_role;


-- =================================================================================================
-- 8. System presets (production needs them, so they live in the migration, not seed.sql)
--    Splits are lower/upper/core/cardio percentages. Full body is even across push, pull, legs and
--    core, so push + pull = upper 50.
-- =================================================================================================

insert into public.presets (id, owner_id, name, kind, split) values
  ('00000000-0000-4000-8000-0000000000a1', null, 'All lower body', 'all_lower',
   '{"lower": 100, "upper": 0, "core": 0, "cardio": 0}'),
  ('00000000-0000-4000-8000-0000000000a2', null, 'Mostly lower body', 'mostly_lower',
   '{"lower": 70, "upper": 15, "core": 15, "cardio": 0}'),
  ('00000000-0000-4000-8000-0000000000a3', null, 'Full body', 'full_body',
   '{"lower": 25, "upper": 50, "core": 25, "cardio": 0}'),
  ('00000000-0000-4000-8000-0000000000a4', null, 'Mostly upper body', 'mostly_upper',
   '{"lower": 15, "upper": 70, "core": 15, "cardio": 0}'),
  ('00000000-0000-4000-8000-0000000000a5', null, 'All upper body', 'all_upper',
   '{"lower": 0, "upper": 100, "core": 0, "cardio": 0}'),
  ('00000000-0000-4000-8000-0000000000a6', null, 'Mostly cardio', 'mostly_cardio',
   '{"lower": 10, "upper": 10, "core": 10, "cardio": 70}');


-- =================================================================================================
-- 9. PowerSync publication
--    The name `powersync` is hard-coded in the PowerSync service. Tables are listed explicitly so
--    source_chunks (embeddings) never enters PowerSync's replication stream. Later migrations:
--    `alter publication powersync add table public.<new_table>;`
--    The replication role needs a password, so it is created by hand (docs/SETUP.md), not here.
-- =================================================================================================

create publication powersync for table
  public.profiles,
  public.entitlements,
  public.presets,
  public.equipment_setups,
  public.exercises,
  public.study_sessions,
  public.interval_blocks,
  public.workout_sessions,
  public.exercise_sets,
  public.transitions,
  public.groups,
  public.group_members,
  public.sources,
  public.source_files,
  public.study_plans,
  public.plan_sources,
  public.topics,
  public.cards,
  public.card_links,
  public.card_states,
  public.reviews,
  public.tracy_events;
