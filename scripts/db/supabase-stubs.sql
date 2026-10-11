-- The parts of a Supabase database that DualRep's migrations and tests rely on, recreated on a
-- vanilla Postgres 16 so `npm run db:test` needs neither Docker nor the Supabase CLI.
--
-- Only scripts/db-test.sh applies this file, before the migrations. It mirrors Supabase's own setup
-- (supabase/postgres init scripts and the auth service's schema) closely enough that a test passing
-- here also passes under `supabase test db`:
--   * the API roles anon / authenticated / service_role (BYPASSRLS) and the authenticator login role;
--   * the `extensions` schema and the database search_path "$user", public, extensions (pgTAP is
--     preinstalled there; the migration itself creates pgvector and uuid-ossp in it, as it does on
--     Supabase, where uuid-ossp is already installed and that line is a no-op);
--   * `auth.users` with the columns the migration's trigger and the tests touch;
--   * auth.uid() / auth.role() / auth.email() / auth.jwt() with Supabase's exact definitions, which read
--     the JWT claims PostgREST puts in `request.jwt.claims` (tests set that GUC directly);
--   * Supabase's long-standing default privileges, which grant everything in `public` to the API
--     roles. Projects created since 2026-05-30 no longer do that, but keeping the old behaviour here is
--     the stricter test: the migration must revoke and re-grant explicitly to pass either way;
--   * (Phase 2, the study engine) the parts of Storage, pg_cron, pg_net and Vault that
--     20261009120000_study_engine.sql and its tests touch: the `sources` bucket lives in
--     storage.buckets, its folder policies use storage.foldername(), the worker's schedule calls
--     cron.schedule() and net.http_post(), and reads its URL and secret from vault.decrypted_secrets.
--     On Supabase (and under `supabase db start` in CI) the real ones exist, so the migration only
--     creates pg_cron and pg_net when their schema is missing, which here it is not. The stubs never
--     run a job or send a request: cron.schedule() stores the job, net.http_post() records the request.
--
-- Deliberately absent: everything the schema must not depend on (realtime, the Storage API itself,
-- encryption in Vault, ...).

-- Roles ---------------------------------------------------------------------------------------------
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
-- On Supabase `postgres` is a member of the API roles, which is what lets tests `set role`.
-- (Here it is a superuser anyway; the grant documents the dependency.)
grant anon, authenticated, service_role to postgres;

-- Schemas -------------------------------------------------------------------------------------------
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's database default; new sessions (every psql run of the harness) pick it up.
do $$
begin
  execute format('alter database %I set search_path to "$user", public, extensions', current_database());
end;
$$;

-- Extensions ----------------------------------------------------------------------------------------
-- pgTAP is preinstalled for convenience; each test file still runs
-- `create extension if not exists pgtap with schema extensions`, as it must on real Supabase.
create extension if not exists pgtap with schema extensions;

-- auth.users (subset of the GoTrue table) -----------------------------------------------------------
-- Like the real table, `id` has no default: GoTrue always supplies it, and so do the tests.
create table auth.users (
  instance_id uuid,
  id uuid not null primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  phone text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- auth helper functions (Supabase's definitions, verbatim in behaviour) ------------------------------
create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.email() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

-- Storage (a subset of supabase/storage migrations/tenant: 0002, 0008, 0013/0014, 0018, 0046, 0055,
-- 0060) ----------------------------------------------------------------------------------------------
-- Only the columns, grants and functions the migration and the tests use. file_size_limit is a bigint
-- number of bytes (0014). RLS is on for both tables and the API roles hold every privilege (0046), so
-- the policies alone decide what a signed-in user may do, as on Supabase.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  owner_id text,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index bname on storage.buckets (name);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text,
  user_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now()
);
create unique index bucketid_objname on storage.objects (bucket_id, name);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- storage.foldername() and storage.filename() as defined in 0060-optimize-existing-functions-again.sql.
create function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $function$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$function$;

create function storage.filename(name text)
returns text
language plpgsql
immutable
as $function$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$function$;

-- 0055-prevent-direct-deletes.sql: SQL deletes are refused unless storage.allow_delete_query = 'true'
-- (the Storage API sets it), because a deleted row would leave the file itself behind. Files must be
-- removed through the Storage API; the tests check the migration never tries anything else.
create function storage.protect_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), 'false') != 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
      using hint = 'This prevents accidental data loss from orphaned objects.', errcode = '42501';
  end if;
  return null;
end;
$$;
create trigger protect_objects_delete before delete on storage.objects
  for each statement execute function storage.protect_delete();
create trigger protect_buckets_delete before delete on storage.buckets
  for each statement execute function storage.protect_delete();

-- pg_cron: cron.schedule() / cron.unschedule() by job name (pg_cron 1.6). Jobs never run here. -------
create schema cron;
create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport integer not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);
-- Like pg_cron, scheduling a job name again replaces its schedule and command.
create function cron.schedule(job_name text, schedule text, command text)
returns bigint
language sql
as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid;
$$;
create function cron.unschedule(job_name text)
returns boolean
language sql
as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d);
$$;

-- pg_net: net.http_post() records the request instead of sending it (the real queue stores the body as
-- bytea; jsonb here is easier to assert on). -------------------------------------------------------
create schema net;
grant usage on schema net to public;
create table net.http_request_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb,
  body jsonb,
  timeout_milliseconds integer not null
);
create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
)
returns bigint
language sql
as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds)
  returning id;
$$;

-- Vault (supabase/vault sql/supabase_vault--0.3.0.sql, without the encryption) -----------------------
-- The same table, view and function signatures; EXECUTE on the functions is revoked from PUBLIC.
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);
create unique index secrets_name_idx on vault.secrets using btree (name) where name is not null;
create view vault.decrypted_secrets as
  select s.id, s.name, s.description, s.secret, s.secret as decrypted_secret, s.key_id, s.nonce,
         s.created_at, s.updated_at
  from vault.secrets s;
create function vault.create_secret(
  new_secret text, new_name text = null, new_description text = '', new_key_id uuid = null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description)
  returning id;
$$;
create function vault.update_secret(
  secret_id uuid, new_secret text = null, new_name text = null, new_description text = null,
  new_key_id uuid = null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update vault.secrets
     set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
         description = coalesce(new_description, description), updated_at = now()
   where id = secret_id;
$$;
revoke all on function vault.create_secret(text, text, text, uuid) from public;
revoke all on function vault.update_secret(uuid, text, text, text, uuid) from public;
