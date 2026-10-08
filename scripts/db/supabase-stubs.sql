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
--     the stricter test: the migration must revoke and re-grant explicitly to pass either way.
--
-- Deliberately absent: everything the schema must not depend on (storage, realtime, pg_net, ...).

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
