-- =================================================================================================
-- DualRep — study engine (Phase 2)
--
-- What the study pipeline needs in the database: course material goes into a private Storage bucket,
-- the `study` Edge Function queues jobs in tracy_events, the `tracy-worker` Edge Function works them
-- off with Tracy, and the phone follows along through the synced rows. Conventions as in
-- 20261008000000_initial_schema.sql (its header explains them); every object is schema-qualified.
--
--   1. Extensions (pg_cron, pg_net) and the `private` schema
--   2. Columns the phone reads: topics.status, cards.source_id, tracy_events.stage / plan_id /
--      source_id (+ the server-only cap_units); sources.status becomes server-owned
--   3. source_files.storage_path must stay inside its own source's folder
--   4. The private Storage bucket `sources` and its folder policies
--   5. The job queue: claim, release and enqueue (with the monthly caps), and the list of orphaned files
--   6. The schedule: pg_cron wakes the worker every minute when work is queued, plus daily chores
--   7. Grants
--
-- Applied by the Deploy backend workflow (`supabase db push`), not pasted into the SQL Editor.
-- Tests: supabase/tests/14_study_engine.test.sql. Storage, pg_cron, pg_net and Vault are Supabase's;
-- scripts/db/supabase-stubs.sql recreates the parts used here for `npm run db:test`.
-- No secrets in this file: the worker's URL and shared secret live in Vault (names
-- dualrep_project_url and dualrep_worker_secret), written by the Deploy backend workflow and read
-- each time the cron job runs.
-- =================================================================================================


-- =================================================================================================
-- 1. Extensions and the private schema
-- =================================================================================================

-- On Supabase pg_cron lives in pg_catalog and creates the schema `cron`; pg_net lives in `extensions`
-- and creates the schema `net`; Vault is preinstalled. Each is created only when its schema is missing:
-- under the test stubs the schemas already exist (and the real extensions are not installed there).
-- Checking the schema rather than pg_available_extensions also copes with a machine that has the
-- pg_cron package installed but not preloaded.
do $$
begin
  if pg_catalog.to_regnamespace('cron') is null then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
  if pg_catalog.to_regnamespace('net') is null then
    create extension if not exists pg_net with schema extensions;
  end if;
end;
$$;

-- Functions only the database itself calls (from pg_cron). The Data API serves `public` and
-- `graphql_public` only (supabase/config.toml), and nobody but the owner may use this schema.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;


-- =================================================================================================
-- 2. Columns the phone reads
--    PowerSync does not replicate a new column's default to rows that already exist until each row
--    changes, so a new synced column is nullable, or (topics.status) the existing rows are touched.
-- =================================================================================================

-- topics.status: draft (proposed by the study builder's outline; the owner reviews it) -> confirmed
-- (kept by the owner; the worker is making its cards) -> ready. A topic made by hand is ready at once,
-- hence the default. The plan owner may write it like any other topic column (RLS as before): the
-- worker builds cards only for a confirmed topic that has none yet, then sets ready, so flipping a topic
-- back can never duplicate cards.
alter table public.topics
  add column status text not null default 'ready'
    check (status in ('draft', 'confirmed', 'ready'));
-- Touch the rows that already exist (none in production when this shipped) so PowerSync replicates
-- their new status; otherwise devices would hold null there until each topic changed.
update public.topics set status = status;

-- cards.source_id: the card's source, DERIVED from source_chunk_id and never chosen by a writer. The
-- phone never receives source_chunks, so this is how it filters "newest source" and cites "p. 12 of
-- Lecture 3". ON DELETE SET NULL like source_chunk_id: the source may be a group mate's.
alter table public.cards
  add column source_id uuid references public.sources (id) on delete set null;
create index cards_source_id_idx on public.cards (source_id);

-- Fires after clear_source_chunk_reference (same event; triggers fire in name order), so a chunk the
-- writer may not read is already null here. security definer: the chunk may belong to a group member's
-- source, which the writer's RLS may hide. On INSERT the value always comes from the chunk (a sent
-- source_id is ignored, and a hand-made card has none). On UPDATE a new chunk re-derives it; otherwise
-- the stored value is kept: a writer (or an ON DELETE SET NULL) may clear it, never repoint it. It never
-- copies back a value an ON DELETE SET NULL is clearing: deleting a source cascades to its chunks and
-- nulls cards.source_id in an undefined order, and both orders end with null.
-- (Cards that existed before this migration keep null: none had a source chunk yet.)
create function public.copy_card_source_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.source_id := (select sc.source_id from public.source_chunks sc where sc.id = new.source_chunk_id);
  elsif new.source_chunk_id is not null and new.source_chunk_id is distinct from old.source_chunk_id then
    new.source_id := (select sc.source_id from public.source_chunks sc where sc.id = new.source_chunk_id);
  elsif new.source_id is not null then
    new.source_id := old.source_id;
  end if;
  return new;
end;
$$;

create trigger copy_source_id
  before insert or update of source_chunk_id, source_id on public.cards
  for each row execute function public.copy_card_source_id();

-- sources.status belongs to the pipeline: pending (the phone made the row) -> processing (the study
-- function queued it) -> ready | failed (the worker). The phone still creates and edits sources, so the
-- column keeps its grant, but a phone's value is ignored rather than refused (a refused write would be
-- dropped on the device): a client INSERT always stores 'pending', and a client UPDATE keeps the stored
-- status. So a retried or late upload can never move a source back to pending or mark it ready, and the
-- next sync shows the phone the server's value again. Same trust rule as the normalizing triggers of
-- the first migration: only client requests (current_user = 'authenticated') are rewritten; the service
-- role and SQL are trusted. Security invoker, so current_user is the caller.
create function public.keep_server_source_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.status := 'pending';
    else
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;

-- An upsert's DO UPDATE half lists status only when the phone sent it, and then fires this again with
-- old = the stored row, which keeps the stored status.
create trigger keep_server_status
  before insert or update of status on public.sources
  for each row execute function public.keep_server_source_status();

-- tracy_events: what a job is for, so the phone can show per-source progress ("Making cards (2 of 5)")
-- and errors, and so the monthly caps can be counted per stage. All server-written: the device's only
-- privilege on tracy_events stays `update (accepted)` (section 7 of the first migration), so these need
-- no normalizing trigger.
--   stage      the step of the pipeline: study_builder runs extract, outline, cards and embed;
--              handwriting runs transcribe. Null for jobs outside the study pipeline.
--   plan_id,   the plan and source the job works on (synced; set null when they are deleted, so a
--   source_id  job of a deleted plan or source stays in the user's history).
--   cap_units  SERVER ONLY (not synced): how much of the user's monthly cap for this stage the job used
--              (1 per source for extract, 1 per page or photo for transcribe; 0 = not counted). See
--              enqueue_tracy_event in section 5.
alter table public.tracy_events
  add column stage text check (stage in ('extract', 'transcribe', 'outline', 'cards', 'embed')),
  add column plan_id uuid references public.study_plans (id) on delete set null,
  add column source_id uuid references public.sources (id) on delete set null,
  add column cap_units integer not null default 0 check (cap_units >= 0),
  add constraint tracy_events_stage_matches_job check (
    stage is null
    or (job = 'study_builder' and stage in ('extract', 'outline', 'cards', 'embed'))
    or (job = 'handwriting' and stage = 'transcribe')
  );
create index tracy_events_plan_id_idx on public.tracy_events (plan_id);
-- The jobs of a source, oldest first: the worker's "is any cards job of this source still open?" and
-- the phone's progress line.
create index tracy_events_source_id_idx on public.tracy_events (source_id, created_at);
-- Running jobs by lock time: the stale-job reap in claim_tracy_events and the cron kick.
create index tracy_events_running_idx on public.tracy_events (locked_at) where status = 'running';


-- =================================================================================================
-- 3. source_files.storage_path stays inside its own source's folder
-- =================================================================================================

-- The worker downloads storage_path with the service role, which bypasses Storage's policies. A path
-- into someone else's folder would therefore turn their file into your cards, so the database only
-- accepts `<owner_id>/<source_id>/<file name>`: the uploader's own folder (section 4) for this very
-- source, with a plain file name (no further folders, no `..`). The app writes `<n>.<ext>`, n = the
-- 1-based file number. owner_id is copied from the source by the copy_source_ownership BEFORE trigger,
-- and CHECK constraints run after BEFORE triggers, so a forged owner_id cannot get around it. A phone
-- that builds a wrong path gets 23514, which the device records in upload_failures.
-- (Limit: a service-role change of a source's owner would now fail on its files; nothing does that.)
alter table public.source_files
  add constraint source_files_storage_path_in_own_folder check (
    storage_path ~ ('^' || owner_id::text || '/' || source_id::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
  );
-- For the orphan sweep (section 5): "does any file row still point at this object?".
create index source_files_storage_path_idx on public.source_files (storage_path);


-- =================================================================================================
-- 4. Storage: the private bucket `sources`
-- =================================================================================================

-- Uploaded course material: PDFs, Word documents and photos of handwritten notes (the app re-encodes
-- photos as JPEG; PNG and WebP are accepted for images that arrive that way). 25 MiB per file, under the
-- Free plan's 50 MB global cap. Private: files are read through the owner's session or a short-lived
-- signed URL, never a public link. Upserted so the settings below are what the bucket ends up with.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sources', 'sources', false, 26214400,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Each user reads and writes only their own top-level folder, `<auth.uid()>/...`. An upsert needs
-- select + insert + update. Group members are deliberately left out: in Phase 2 a source's files are
-- read by their owner and by the worker (service role). storage.objects belongs to Supabase, which lets
-- `postgres` create policies on it (supautils.policy_grants); RLS on it is already enabled.
create policy "dualrep sources: read own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "dualrep sources: upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "dualrep sources: overwrite own files" on storage.objects
  for update to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "dualrep sources: delete own files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);


-- =================================================================================================
-- 5. The job queue (tracy-worker) and the monthly caps
--    Called by the Edge Functions with the service role only (section 7). security definer with an
--    empty search_path, like every other definer function here.
-- =================================================================================================

-- Claims up to p_limit queued jobs (oldest first, at most 10) for one worker run: each becomes
-- 'running', locked now, with its attempt counted. FOR UPDATE SKIP LOCKED lets two workers that run at
-- once take different jobs. The returned `attempts` is the fencing token: the worker finishes a job
-- with `... where id = $1 and status = 'running' and attempts = $2`, so a worker that was presumed
-- dead cannot overwrite a job that has since been retried.
-- First it reaps: a job still 'running' 5 minutes after it was locked means its worker died (an Edge
-- Function lives at most 150 s on the Free plan). It is queued again, or failed after its third attempt
-- with a short, content-free error the phone shows next to "Try again".
create function public.claim_tracy_events(p_limit integer default 1)
returns setof public.tracy_events
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.tracy_events e
     set status = case when e.attempts >= 3 then 'failed' else 'queued' end,
         error = case when e.attempts >= 3 then 'This step took too long. Try again.' else e.error end,
         locked_at = null
   where e.status = 'running' and e.locked_at < now() - interval '5 minutes';

  -- UPDATE ... RETURNING has to sit in a CTE to be returned from plpgsql.
  return query
  with claimed as (
    update public.tracy_events e
       set status = 'running', locked_at = now(), attempts = e.attempts + 1
     where e.id in (
       select q.id
         from public.tracy_events q
        where q.status = 'queued'
        order by q.created_at
        limit least(greatest(coalesce(p_limit, 1), 1), 10)
        for update skip locked
     )
    returning e.*
  )
  select * from claimed order by created_at;
end;
$$;

-- Puts a claimed job back in the queue WITHOUT counting the attempt: for when the job never reached
-- Tracy (Tracy asleep on Render's free plan, a 502/503 page in front of it). The next cron tick, a
-- minute later, tries again. Fenced like a finish: only the run that claimed the job (same attempts)
-- can release it. Returns whether it did.
create function public.release_tracy_event(p_id uuid, p_attempts integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.tracy_events e
     set status = 'queued', attempts = greatest(e.attempts - 1, 0), locked_at = null
   where e.id = p_id and e.status = 'running' and e.attempts = p_attempts;
  return found;
end;
$$;

-- Queues a job, enforcing the user's monthly cap for its stage.
--   * Counted stages (spec decision 5): extract (1 unit per source) and transcribe (1 unit per page or
--     photo). The caller passes the stage's free and paid limits (Edge Function env vars, so a limit
--     change needs no migration) and p_units. The user's tier comes from has_paid_access(), which
--     answers for any user when there is no user JWT (the service role).
--   * Uncounted: leave both limits null (outline, cards, embed, and the worker's own follow-ups such
--     as the next window of a long PDF). The job then stores cap_units = 0.
--   * A limit of null for the user's tier (the other one set) counts the job but never refuses it.
-- Usage this month (UTC) = the cap_units of the user's jobs of that stage. A job cancelled before the
-- worker ever picked it up (attempts = 0) gives its units back; one cancelled later has cost something
-- and still counts. (So a retry should put the same job back in the queue rather than queue a new,
-- counted one.)
-- When used + p_units would pass the limit, nothing is queued and it raises P0001 with
-- hint 'dualrep_cap_reached' and a JSON detail {stage, used, limit, resets_at}, which PostgREST hands
-- the Edge Function (as HTTP 400); the study function answers 429 {code: 'cap_reached'} and the app
-- says when the cap resets. A per-user, per-stage advisory lock makes check-and-insert atomic, so two
-- requests at once cannot both slip under the limit.
create function public.enqueue_tracy_event(
  p_user_id uuid,
  p_job text,
  p_stage text,
  p_input jsonb,
  p_plan_id uuid default null,
  p_source_id uuid default null,
  p_free_limit integer default null,
  p_paid_limit integer default null,
  p_units integer default 1
)
returns public.tracy_events
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  counted boolean := p_free_limit is not null or p_paid_limit is not null;
  units integer := coalesce(p_units, 1);
  month_start timestamptz;
  next_month timestamptz;
  monthly_limit integer;
  used integer;
  ev public.tracy_events;
begin
  if units < 0 then
    raise exception 'p_units must be 0 or more' using errcode = '22023';
  end if;

  if counted then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('dualrep.tracy_cap:' || p_user_id::text || ':' || coalesce(p_stage, ''), 0)
    );
    -- Month boundaries in UTC whatever the session's time zone (timestamptz + '1 month' would be
    -- computed in the session's zone).
    month_start := pg_catalog.date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
    next_month := (pg_catalog.date_trunc('month', now() at time zone 'UTC') + interval '1 month')
                  at time zone 'UTC';
    monthly_limit := case when public.has_paid_access(p_user_id) then p_paid_limit else p_free_limit end;
    select coalesce(sum(e.cap_units), 0) into used
      from public.tracy_events e
     where e.user_id = p_user_id
       and e.stage is not distinct from p_stage
       and (e.status <> 'cancelled' or e.attempts > 0)
       and e.created_at >= month_start;
    if monthly_limit is not null and used + units > monthly_limit then
      raise exception 'monthly limit reached for %', coalesce(p_stage, p_job)
        using errcode = 'P0001',
              detail = pg_catalog.json_build_object(
                'stage', p_stage,
                'used', used,
                'limit', monthly_limit,
                'resets_at',
                pg_catalog.to_char(next_month at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              )::text,
              hint = 'dualrep_cap_reached';
    end if;
  end if;

  insert into public.tracy_events (user_id, job, stage, plan_id, source_id, input, cap_units)
  values (p_user_id, p_job, p_stage, p_plan_id, p_source_id, coalesce(p_input, '{}'::jsonb),
          case when counted then units else 0 end)
  returning * into ev;
  return ev;
end;
$$;

-- Files in the bucket that no source_files row points at any more (the source or the account was
-- deleted, or an upload was abandoned), older than 3 days so a phone that uploaded a file before its
-- row synced is never swept. The worker removes them through the Storage API: SQL deletes on
-- storage.objects are refused, and would leave the file itself behind anyway.
create function public.orphaned_source_objects(p_limit integer default 100)
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'sources'
     and o.created_at < now() - interval '3 days'
     and not exists (select 1 from public.source_files f where f.storage_path = o.name)
   order by o.created_at
   limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;


-- =================================================================================================
-- 6. The schedule (pg_cron + pg_net + Vault)
-- =================================================================================================

-- Wakes the tracy-worker Edge Function, but only when it has something to do, so an idle project
-- spends nothing of the monthly Edge Function invocations:
--   'jobs'   a job is queued, or a running one is stale (the worker reaps it, see claim_tracy_events);
--   'sweep'  a file in the bucket is orphaned (see orphaned_source_objects).
-- It POSTs {"reason": "jobs" | "sweep"} to <dualrep_project_url>/functions/v1/tracy-worker with the
-- header x-dualrep-worker-secret = dualrep_worker_secret, both read from Vault on every run. The secret
-- is a dedicated shared secret, not an API key: a leaked one only wakes the worker, which processes
-- jobs that are already queued. Until the Deploy backend workflow has written both values it raises a
-- WARNING and does nothing. pg_net sends the request after the transaction commits; the worker answers
-- 202 at once and works in the background, so the 5 s timeout never cuts a job short.
create function private.kick_tracy_worker(p_reason text default 'jobs')
returns bigint
language plpgsql
volatile
set search_path = ''
as $$
declare
  base_url text;
  worker_secret text;
begin
  if p_reason = 'jobs' then
    if not exists (select 1 from public.tracy_events e where e.status = 'queued')
       and not exists (
         select 1 from public.tracy_events e
          where e.status = 'running' and e.locked_at < now() - interval '5 minutes'
       ) then
      return null;
    end if;
  elsif p_reason = 'sweep' then
    if not exists (select 1 from public.orphaned_source_objects(1)) then
      return null;
    end if;
  else
    raise exception 'unknown reason %', p_reason using errcode = '22023';
  end if;

  select s.decrypted_secret into base_url
    from vault.decrypted_secrets s where s.name = 'dualrep_project_url';
  select s.decrypted_secret into worker_secret
    from vault.decrypted_secrets s where s.name = 'dualrep_worker_secret';
  if base_url is null or worker_secret is null then
    raise warning 'tracy-worker is not configured yet (run the Deploy backend workflow)';
    return null;
  end if;

  return net.http_post(
    url := pg_catalog.rtrim(base_url, '/') || '/functions/v1/tracy-worker',
    body := pg_catalog.jsonb_build_object('reason', p_reason),
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dualrep-worker-secret', worker_secret
    ),
    timeout_milliseconds := 5000
  );
end;
$$;

-- cron.schedule upserts by job name, so running this again changes nothing. All times are UTC.
--   dualrep-tracy-worker          every minute: the safety net behind the worker's own self-kicks.
--   dualrep-storage-sweep         daily: let the worker remove orphaned files.
--   dualrep-cron-history-cleanup  daily: pg_cron never deletes its own run log.
-- (`perform` inside a DO block, so applying the migration prints no result rows.)
do $$
begin
  perform cron.schedule('dualrep-tracy-worker', '* * * * *',
    $c$select private.kick_tracy_worker('jobs')$c$);
  perform cron.schedule('dualrep-storage-sweep', '23 4 * * *',
    $c$select private.kick_tracy_worker('sweep')$c$);
  perform cron.schedule('dualrep-cron-history-cleanup', '17 3 * * *',
    $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
end;
$$;


-- =================================================================================================
-- 7. Grants
--    The new columns are covered by the tables' existing grants (topics, cards, sources: the owner
--    writes; tracy_events: select, and update (accepted) only). Functions: Postgres grants EXECUTE to
--    PUBLIC by default (and older Supabase projects to anon and authenticated), so each is revoked
--    first.
-- =================================================================================================

-- The queue is the Edge Functions' business: service_role only.
revoke all on function public.claim_tracy_events(integer) from public, anon, authenticated;
grant execute on function public.claim_tracy_events(integer) to service_role;
revoke all on function public.release_tracy_event(uuid, integer) from public, anon, authenticated;
grant execute on function public.release_tracy_event(uuid, integer) to service_role;
revoke all on function
  public.enqueue_tracy_event(uuid, text, text, jsonb, uuid, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function
  public.enqueue_tracy_event(uuid, text, text, jsonb, uuid, uuid, integer, integer, integer)
  to service_role;
revoke all on function public.orphaned_source_objects(integer) from public, anon, authenticated;
grant execute on function public.orphaned_source_objects(integer) to service_role;

-- Trigger functions are never called directly, so nobody gets EXECUTE.
revoke all on function public.copy_card_source_id() from public, anon, authenticated, service_role;
revoke all on function public.keep_server_source_status() from public, anon, authenticated, service_role;

-- Only the database (pg_cron, as the owner) wakes the worker.
revoke all on function private.kick_tracy_worker(text) from public, anon, authenticated, service_role;
