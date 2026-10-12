-- =================================================================================================
-- DualRep — text sources: notes the person speaks or types (voice notes, 2026-10-12)
--
-- A new kind of study material: a block of text the person dictated (Android's speech recognition,
-- on the phone), typed or pasted, and read through on the phone before adding it. It goes through
-- the pipeline like a PDF: the `study` function's submit_source (kind 'text', the text in the
-- request body) stores it and queues one counted `extract` job (1 source of the monthly cap); the
-- worker chunks the text itself, without calling Tracy; the outline, its review and the cards follow
-- as for any other source. There is no "Check the transcription" step: the person already checked
-- the text. Conventions as in 20261008000000_initial_schema.sql; every object is schema-qualified.
--
--   1. sources.kind gains 'text'
--   2. sources.body: the text as it was added (synced, so the phone can show it again), owned by the
--      server like sources.status
--   3. Grants
--
-- Nothing else changes: `sources` is already in the powersync publication (no column list, so the
-- new column is published) and synced with SELECT *, so the sync config stays as it is (no PowerSync
-- redeploy); body is nullable without a default, so PowerSync has nothing to backfill (existing rows
-- read as null on the phone either way); RLS is unchanged (whoever can read a source can read its
-- text, as with source_files.transcript); the cap, the job, its retries and its cancel are the
-- extract stage's, so the queue functions are unchanged too.
-- Applied by the Deploy backend workflow (`supabase db push`) after 20261009120000, not pasted into
-- the SQL Editor. Tests: supabase/tests/15_text_sources.test.sql.
-- =================================================================================================


-- =================================================================================================
-- 1. sources.kind gains 'text'
--    The inline CHECK of the first migration is named sources_kind_check by Postgres. Dropped and
--    added in one ALTER, so the table is never without the check.
-- =================================================================================================

alter table public.sources
  drop constraint sources_kind_check,
  add constraint sources_kind_check check (kind in ('pdf', 'doc', 'link', 'notes', 'text'));


-- =================================================================================================
-- 2. sources.body
-- =================================================================================================

-- The text of a 'text' source, as the person added it: 1 to 30,000 characters. char_length counts
-- characters (code points), not bytes; the study function checks the same limit in UTF-16 code units
-- (JavaScript's length), which are never fewer, so the database never refuses what the function
-- accepted. Null for every other kind. The worker chunks it into source_chunks; the phone shows it on
-- the source's page.
-- The CHECK does not also require a body for every 'text' source: a phone's insert has its body
-- removed by the trigger below, and a CHECK refusing that row would get the write dropped on the
-- device. Such a source (the app never makes one) simply fails at extraction with "No readable text
-- was found.".
alter table public.sources
  add column body text,
  add constraint sources_body_check
    check (body is null or (kind = 'text' and char_length(body) between 1 and 30000));

-- body belongs to the server: the cards are made from the text the study function stored, so a phone
-- must never change it afterwards. Same rule as keep_server_source_status: a phone's value is ignored
-- rather than refused (a refused write would be dropped on the device), only for client requests
-- (current_user = 'authenticated'; the service role and SQL are trusted). A client INSERT stores no
-- text, and a client UPDATE keeps the stored text. A source that has text also keeps its kind: a
-- phone changing it would otherwise break sources_body_check, and that write would be refused.
-- (Postgres can't take UPDATE of one column away while the table-level grant exists, and changing the
-- grants of `sources` would touch every existing write path, hence a trigger.) CHECK constraints run
-- after BEFORE triggers, so the check sees the values that will be stored. Security invoker, so
-- current_user is the caller.
create function public.keep_server_source_body()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.body := null;
    else
      new.body := old.body;
      if old.body is not null then
        new.kind := old.kind;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- An upsert's DO UPDATE half lists body (or kind) only when the phone sent it, and then fires this
-- again with old = the stored row, which keeps the stored text and kind.
create trigger keep_server_body
  before insert or update of body, kind on public.sources
  for each row execute function public.keep_server_source_body();


-- =================================================================================================
-- 3. Grants
--    The new column is covered by the table's existing grants (authenticated: select, insert, update,
--    delete, with the trigger above ignoring body; service_role: all). The trigger function is never
--    called directly, so nobody gets EXECUTE (Postgres grants it to PUBLIC by default).
-- =================================================================================================

revoke all on function public.keep_server_source_body() from public, anon, authenticated, service_role;
