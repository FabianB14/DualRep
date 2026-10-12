# Voice notes: the pipeline track (server and data side)

Research for DualRep, 2026-10-12. Both repos were only read. Every change below was built and run in a
scratch copy (`voice-research/scratch/pipeline/`), never in `/home/user/DualRep` or
`/home/user/tracy-ai`. `git status` is clean in both repos.

**Labels used here:** **[verified]** means I ran it (pgTAP, deno, jest, tsc, node) or read the primary
source. **[from code]** means I read it in the DualRep or tracy-ai code. **[estimate]** is a derived
number. **[unverified]** means I couldn't confirm it.

---

## 0. Recommendation in one paragraph

Add a **new source kind, `'text'`**, and **one nullable column, `sources.body`**, in a **new migration**
(`20261012120000_text_sources.sql`). The app sends the reviewed text inside the existing
`submit_source` action (`kind: 'text'`, a new `text` field, `files: []`). The function stores the text
on the source row and queues the **same counted `extract` job a PDF or link gets**, which uses 1 of
the monthly *sources*. The worker's `extract` step does not call Tracy for a text source. It chunks
`sources.body` itself, with the same chunker used for confirmed transcripts, and the existing gate
starts the outline. From there everything is unchanged: outline, outline review, cards, retry and
cancel. There is no "Check the transcription" step, because that branch of `sourceStep` only runs for
`kind === 'notes'`.

`sources` is already published and synced with `SELECT *`, so the phone gets `body` with no
sync-config change and no PowerSync redeploy. Unsent notes are kept as a per-plan draft in the
phone's `local_state` until it is online. **Tracy does not change.**

Size of the change:
- Server: 1 migration of about 40 lines of SQL; roughly 60 changed lines of TypeScript in 9 files.
- App: about 6 small data-layer edits, plus the screens.
- Tests: pgTAP, Deno and Jest tests are written. All of them pass in the scratch copy (section 8).

---

## 1. What Phase 2 does today (the facts this design rests on)

| Fact | Where |
|---|---|
| `sources.kind text not null check (kind in ('pdf','doc','link','notes'))`, an inline CHECK, which Postgres names `sources_kind_check` (the migration below drops it by that name, and that runs) | `20261008000000_initial_schema.sql:276-285` [verified] |
| The original comment calls `sources` "an uploaded PDF/doc, a link, or **typed notes**", but Phase 2 uses `notes` for photos of handwritten notes | same file [from code] |
| `source_files.storage_path text not null` plus the CHECK `^<owner_id>/<source_id>/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` | `20261009120000_study_engine.sql` §3 [from code] |
| `sources.status` belongs to the server: trigger `keep_server_status` runs `keep_server_source_status()`. A client INSERT is stored as `pending` and a client UPDATE keeps the stored value, so a phone's value is ignored rather than refused | same, §2 [from code] |
| Caps: `enqueue_tracy_event` → `private.check_tracy_cap` adds up `cap_units` per **stage**. `extract` = sources (1 unit per PDF, doc or link); `transcribe` = pages. Outline, cards and embed are not counted. A job cancelled before it ran gives its units back (`attempts = 0 and not ran`). `requeue_tracy_event` checks the cap again only for a job whose units were given back | same, §5; D36 [from code] |
| `submit_source`: checks the plan as the user; reuses the existing source (`already_submitted`) or returns `conflict` on a kind mismatch; checks files against Storage; inserts `sources`, `plan_sources` and `source_files`; enqueues **one counted `extract` job** for pdf, doc or link (input `{source_id, plan_id, kind, cursor_page: 1}`), or one `transcribe` job per photo; sets `processing`; wakes the worker. On `cap_reached` it rolls back | `study/handlers.ts:118-219` [from code] |
| `confirm_transcripts` chunks the confirmed text in the function with `chunkPageText`, writes `source_chunks` (ids derived from `(source, page, ordinal)`), then calls `startOutline` | `study/handlers.ts:223-277` [from code] |
| Gates: `afterJob` → `maybeStartOutline` skips `kind === 'notes'` and calls `outlineGate` (extract succeeded and no open or failed transcribe → `ready`). `failsSource('extract')` marks the source `failed` | `_shared/followups.ts`, `_shared/pipeline.ts` [from code] |
| The worker calls Tracy's `/health` before any stage where `STAGE_INFO[stage].needsTracy` (extract, transcribe, outline, cards), and releases the job uncounted if Tracy doesn't answer | `tracy-worker/worker.ts:529-536` [from code] |
| Phone progress: `sourceStep()` has only one kind-specific branch, `source.kind === 'notes'`, which produces "Check the transcription". Every other kind goes reading → outlining → review_outline → making_cards → ready | `src/features/study/sourceProgress.ts:120-133` [from code] |
| Sync: `SELECT * FROM sources WHERE owner_id = auth.user_id()` and `… WHERE group_id IN my_groups`. The publication lists `public.sources` with **no column list** | `powersync/sync-config.yaml`; initial schema §9 [from code] |
| Client registry: `TABLES.sources` columns are owner_id, group_id, kind, title, url, status, plus timestamps. `serverGenerated` columns are never uploaded, and a PATCH that touches one is refused | `src/db/tables.ts` [from code] |
| The phone never inserts or updates `sources`. It only deletes them, when a plan is deleted | `studyRepo.ts:298-320` [from code] |
| Tracy limits: outline ≤ 300 entries (the worker sends ≤ 200), `max_topics` ≤ 40, excerpt ≤ 400 chars; cards ≤ 40 chunks per call, each ≤ 6,000 chars, ≤ 100,000 chars in total, `max_cards` ≤ 20 | `tracy-ai/src/tasks/dualrep.js:41,289-304,410-422` [from code] |
| Edge Functions: 2 s **CPU** per request, 150 s wall clock (Free plan), 256 MB memory. The docs give **no request-body limit** | supabase docs `functions/limits.mdx` at commit cb4307f [verified] |

---

## 2. The options compared

| | (1) **kind `'text'` + `sources.body`, chunked by the worker's extract step** (recommended) | (1b) kind `'text'`, chunked in the `study` function, outline queued directly (no extract job) | (2) upload a `.txt` to Storage; Tracy's `/ai/extract` reads it | (3) reuse kind `'notes'` with one `source_files` row holding the text |
|---|---|---|---|---|
| Migration | Kind CHECK, one column with a CHECK, one trigger | Same | Bucket `allowed_mime_types` gains `text/plain` (an upsert on `storage.buckets`); kind CHECK, or reuse `doc` | None, but `storage_path` is NOT NULL and has a CHECK, so the row would need a made-up path to a file that doesn't exist |
| Monthly cap | **The existing `extract` row, 1 source unit.** No SQL change; retry and cancel give-back work as they do today | Needs a counted row anyway: either a fake `extract` job that is queued and then immediately succeeded (races with the worker's claim), or a counted `outline` job (another stage, which `retry_job` passes as uncounted, so a cancel/retry would bypass the cap) | Same as (1) | Notes are counted per photo on `transcribe`. With no transcribe job, the text is **never counted** |
| Retry, cancel, "Try again", source `failed` | Unchanged (extract stage semantics) | New paths to write | Unchanged | Unclear: there is no job to retry |
| Tracy | Not called for the text. Runs while Tracy is asleep or restarting | Not called | **Works today without a Tracy change** [verified: `extractFromBuffer` with `contentType: 'text/plain', kind: 'doc'` returns `format 'text'` and the chunks]. But it costs a Storage upload and download, `/health`, and a possible 503 `busy` (Tracy reads one file at a time), and a text that starts with `%PDF-` is sniffed as a PDF (→ 422 `pdf_unreadable`) [verified] | Not called |
| Phone sees the text again | Yes, synced with the row (works offline) | Yes | Only through a signed URL when online (or a separate local copy) | Yes (`transcript` syncs) |
| `sourceProgress` | No change needed [verified by a jest test] | No change | No change | Would show "Check the transcription" unless `confirmed = true`. The photo review screen would expect a photo |
| PowerSync redeploy | No | No | No | No |
| Verdict | **Smallest correct change** | One fewer worker hop, but the cap bypass and the race make it worse | More moving parts for no gain: the same chunker runs either way | Mixes two meanings into one kind; the cap is wrong |

**Where the text lives.** I compared four places:
- **A column on `sources`** (chosen).
- A new `source_texts` table: needs a publication change, a new sync stream (so a PowerSync redeploy), RLS, grants and a registry entry.
- A `.txt` file in Storage: not readable offline, adds a bucket MIME change.
- Only in `tracy_events.input`: never synced, so the phone can't show the text again.

The column wins on every count: it needs no new RLS or grant, and the phone already receives the row.

---

## 3. Data model: the new migration

File `supabase/migrations/20261012120000_text_sources.sql`. Its timestamp is after `20261009120000`,
which the founder's Deploy backend run will already have applied to the hosted database. It was
applied on top of the three existing migrations and the seed, and the **whole pgTAP suite passes:
16 files, 678 tests** [verified]. The full file is at
`scratch/pipeline/db/supabase/migrations/20261012120000_text_sources.sql`. The SQL part:

```sql
-- 1. sources.kind gains 'text' (one ALTER, so the table is never without the check)
alter table public.sources
  drop constraint sources_kind_check,
  add constraint sources_kind_check check (kind in ('pdf', 'doc', 'link', 'notes', 'text'));

-- 2. sources.body: the text as it was added, 1–30,000 characters (char_length = code points),
--    only for kind 'text'. Nullable, no default: nothing for PowerSync to backfill.
alter table public.sources
  add column body text,
  add constraint sources_body_check
    check (body is null or (kind = 'text' and char_length(body) between 1 and 30000));

-- body belongs to the server (same rule as keep_server_source_status): a phone's value is
-- ignored, never refused. Client INSERT -> null; client UPDATE -> keeps the stored text.
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
    end if;
  end if;
  return new;
end;
$$;

create trigger keep_server_body
  before insert or update of body on public.sources
  for each row execute function public.keep_server_source_body();

-- 3. Grants: the column is covered by the table's grants; the trigger function is never called.
revoke all on function public.keep_server_source_body() from public, anon, authenticated, service_role;
```

Why each piece:
- **`body is null or kind = 'text'`, without `kind = 'text' ⇒ body not null`.** A client INSERT of a
  `text` source (the app never does this; D32) has its body nulled by the trigger. A stricter CHECK
  would then refuse it, and a refused write is dropped on the device. Such a row simply fails at
  extract with "No readable text was found."
- **The trigger rather than column grants.** Postgres can't take UPDATE away from one column while
  the table-level grant exists, and changing `sources`' grants would touch every existing write path.
  The trigger mirrors `keep_server_status` exactly, and the app also marks `body` as `serverGenerated`
  (§7).
- **The order is right.** CHECK constraints run after BEFORE triggers, so the CHECK sees the nulled
  value. An upsert's `DO UPDATE SET body = excluded.body` fires the trigger again with `old` = the
  stored row. This is covered by pgTAP [verified].
- **What the migration doesn't need:**
  - no `alter publication`: no column list, and `pg_publication_tables.attnames` includes `body`
    [verified];
  - no `UPDATE … SET x = x` touch: the column is nullable with no default;
  - no RLS change: group members read the body through the `sources` select policy, as they already
    read `source_files.transcript` [verified];
  - no new grants;
  - no queue-function change.
- **Postgres rejects NUL.** `('{"t":"a\u0000b"}'::jsonb) ->> 't'` raises **22P05** [verified], so the
  function strips control characters before it writes (§4).
- **Lock and scan.** Adding the CHECK scans `sources` under an ACCESS EXCLUSIVE lock. The table is
  tiny, so this takes milliseconds; `NOT VALID` isn't needed.

---

## 4. The `study` function: contract and code

### 4.1 Contract (the new text for the `submit_source` block in `supabase/functions/study/index.ts`)

```
submit_source: …
  { "action": "submit_source", "plan_id": "…", "source_id": "<made on the phone>",
    "kind": "pdf" | "doc" | "link" | "notes" | "text", "title": "Lecture 3" (1-200 chars),
    "url": "https://…" (kind link only, else null or absent),
    "text": "…" (kind text only, else null or absent): the notes the person spoke or typed and
            read through on the phone. After clean-up (\r\n -> \n, control characters other than
            tab and line break removed, a lone surrogate -> U+FFFD, outer whitespace trimmed)
            1 to 30,000 characters (JavaScript length).
    "files": [...] }
  files: … link and text -> [].
  kind text: nothing is uploaded first. The text is stored with the source (sources.body, synced to the
  phone) and one extraction is queued: 1 source of the monthly limit, like a PDF or a link. The worker
  turns the text into passages itself (no Tracy call); then the outline -> approve_outline -> cards, as
  for any source. No transcription step: the person has already checked the text.
  -> 202 { ok, source_id, status: 'processing', job_ids: [extract], already_submitted: false }
  The same request again -> 200 already_submitted. The same source id with OTHER text ->
  409 conflict "These notes were already added before your last changes. Add them again as new notes
  to keep the changes." (the first text stays; the app adds the changed version under a new id).
  400 bad_request errors[]: "text must be 1 to 30000 characters", "text is only for kind text",
  "files must have exactly 0 entries for kind text".
```

Backward compatible: `text` is optional on the wire, so the current app's requests still validate
[verified: the existing `validate_test` cases still pass]. The `cap_reached` body is unchanged
(`stage: 'extract'`), and the app's `describeCap` already says "sources".

### 4.2 Changes, file by file

The full diff is in `scratch/pipeline/fn-src.diff` (code) and `fn-all.diff` (with tests).

| File | Change |
|---|---|
| `_shared/contracts.ts` | `SOURCE_KINDS` gains `'text'`; `STUDY_LIMITS.maxTextChars = 30000`; `KIND_FILE_TYPES.text = {}`; `SubmitSourceRequest.text: string \| null` |
| `_shared/validate.ts` | New pure `cleanStudyText()` (below). `checkSubmit`: for kind `text` the text is required, 1–30,000 after cleaning; for other kinds it must be absent or null; the files range for `text` is `[0, 0]`; the value carries `text` |
| `_shared/store.ts` | `type NewSource = SourceRow & { body?: string \| null }`; `insertSource(row: NewSource)`; new `sourceBody(id): Promise<string \| null>`. `getSource` stays light: the 30 KB body is never read by the many followup calls |
| `_shared/supabase.ts` | `insertSource` passes `body` through; `sourceBody` = `select('body').eq('id', id).maybeSingle()` |
| `study/handlers.ts` | `insertSource({ …, ...(r.kind === 'text' ? { body: r.text } : {}) })`. On a repeat with a different text → 409 `conflict` (3 lines). Everything else (plan check, `plan_sources`, counted `extract` enqueue, cap rollback, `processing`, kick) is **the existing code path** |
| `_shared/pipeline.ts` | `ExtractInput.kind` gains `'text'`; new `needsTracy(stage, job)` (a text extract skips `/health`) |
| `_shared/chunker.ts` | New `breakLongLines(text, width = 800)`: a pre-pass that breaks over-long lines at the last space (§5.2). `chunkPageText` stays a line-by-line port of Tracy's (the golden test is untouched) |
| `tracy-worker/worker.ts` | `stepExtract`: `if (source.kind === 'text') return await readText(deps, source, input)`. `runOneStep` uses `needsTracy(stage, job)` instead of `STAGE_INFO[stage].needsTracy` |
| `_shared/testing/fake_store.ts` | `bodies` map, `sourceBody`, and the `sources_body_check` simulated in `insertSource` |
| `_shared/followups.ts`, `retry_job`, `cancel_job`, `approve_outline`, `confirm_transcripts`, `claim/enqueue/requeue` SQL | **No change** (`maybeStartOutline` only skips `notes`) |

The key code, as prototyped and passing deno check, lint and test:

```ts
// _shared/validate.ts
export function cleanStudyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .trim();
}
// in checkSubmit, after the url check:
  let text: string | null = null;
  if (kind === 'text') {
    const cleaned = typeof b.text === 'string' ? cleanStudyText(b.text) : '';
    if (!cleaned || cleaned.length > STUDY_LIMITS.maxTextChars) {
      errors.push(`text must be 1 to ${STUDY_LIMITS.maxTextChars} characters`);
    } else text = cleaned;
  } else if (b.text !== undefined && b.text !== null) {
    errors.push('text is only for kind text');
  }
// range: text: [0, 0]
```

```ts
// study/handlers.ts (submitSource)
  if (existing) {
    if (existing.owner_id !== userId) throw new StudyError('conflict', 'This source id is already used.');
    if (existing.kind !== r.kind) throw new StudyError('conflict', 'This source id is already used.');
    if (r.kind === 'text' && (await store.sourceBody(existing.id)) !== r.text) {
      throw new StudyError('conflict', 'These notes were already added before your last changes. Add them again as new notes to keep the changes.');
    }
  }
  …
    await store.insertSource({
      id: r.source_id, owner_id: userId, kind: r.kind, title: r.title,
      url: r.kind === 'link' ? r.url : null, status: 'pending',
      ...(r.kind === 'text' ? { body: r.text } : {}),
    });
  // unchanged: the `else if (!earlierJobs.some((j) => j.stage === 'extract'))` branch queues
  // { stage: 'extract', input: { source_id, plan_id, kind: 'text', cursor_page: 1 } }, counted on
  // caps.sources, 1 unit.
```

```ts
// tracy-worker/worker.ts
async function readText(deps: WorkerDeps, source: SourceRow, input: ExtractInput): Promise<Outcome> {
  const body = await deps.store.sourceBody(source.id);
  const drafts = chunkPageText(breakLongLines(body ?? ''))
    .map((c, ordinal) => ({ page: null, ordinal, content: c.content }));
  if (!drafts.length) return { kind: 'fail', message: MESSAGES.noText };
  await deps.store.upsertChunks(await chunkRows(source.id, source.owner_id, drafts));
  return {
    kind: 'done',
    input: { source_id: input.source_id, plan_id: input.plan_id, kind: 'text', cursor_page: 1 },
    output: { format: 'text', total_pages: null, scanned_pages: 0, skipped_pages: 0, chunks: drafts.length },
  };
}
// _shared/pipeline.ts
export const needsTracy = (stage: Stage, job: Pick<JobRow, 'input'>) =>
  STAGE_INFO[stage].needsTracy && !(stage === 'extract' && job.input?.kind === 'text');
```

**Why the conflict on changed text.** Without it, here is what happens:
1. A response is lost (time-out on a weak connection).
2. The person edits the notes and taps again.
3. The app gets `already_submitted`, clears the draft, and the edit is silently gone. Cards come from
   the first text.

The 409 lets the app say so and offer "Add as new notes" with a new source id. The cost is one extra
`select body` on a repeated text submit only.

---

## 5. Worker and pipeline behaviour

### 5.1 The sequence, as run end to end in `worker_test.ts` [verified]

1. `submit_source(kind text)` stores the source (`body`) and `plan_sources`, queues `extract`
   (`cap_units 1`), sets `processing`, and kicks the worker.
2. The worker claims `extract`. `needsTracy` is false, so there is no `/health` call and it runs even
   while Tracy is asleep [tested: `healthChecks === 0`, no `/ai/extract` call]. `readText` writes
   chunks with `page = null` and ids `chunkId(source, null, i)`. Outcome `done`.
3. `afterJob('extract', 'succeeded')` → `maybeStartOutline` → `outlineGate = ready` → `startOutline`
   queues the outline (and `embed` if Gemini is on).
4. The outline waits for Tracy like any other job (tested: `release` while Tracy is asleep, then
   `done`). It writes draft topics.
5. The phone shows **Review the outline** → `approve_outline` → cards jobs → topics `ready` → source
   `ready`. Cards have `page: null`, so `citation()` shows just "Spoken notes".

Failure paths, all existing machinery:
- **Empty text.** Extract fails with `MESSAGES.noText`, the source is `failed`, and **Try again** works
  (tested). This case can only happen for a row a phone made itself.
- **Cancel while queued.** The source is `failed` and its unit is given back. Retry checks the cap
  again (`requeue_tracy_event`, unchanged).

### 5.2 Chunking dictated text

`chunkPageText` splits on blank lines, then on line breaks or sentence ends, and otherwise **hard
every 1,600 chars, mid-word**. Dictation can come out with no punctuation and no line breaks.
`breakLongLines` is a pre-pass that breaks any line longer than 800 chars at the last space before
800. Measured [verified, `scratch/pipeline/chunkcount.ts`]:

| 30,000-char input | Chunks | Without the pre-pass | Max chunk | Topics asked (`maxTopicsFor`) |
|---|---|---|---|---|
| Typed paragraphs (~450 chars) | 33 | 33 | 858 | ≤ 7 |
| One line per utterance (~110 chars), no punctuation | 35 | 35 | 855 | ≤ 7 |
| One unpunctuated line | 38 | 19 (words cut in half) | 797 | ≤ 8 |
| Two sentences (58 chars) | 1 | 1 | 58 | 1 (2 cards) |

Recommendation for the speech track: join each final recognition result with `\n`, and use `\n\n` for
a pause or a "New paragraph" tap. The server copes either way.

### 5.3 Size limit: 30,000 characters

- **Tracy:** 30,000 chars ≈ 35 chunks. That is far under the outline digest's 200 entries and
  Tracy's 300. `max_topics` is ≤ 8 of 40, and cards jobs take ≤ 40 chunks each (≤ 64,000 chars, under
  Tracy's 100,000) [from code]. The limit could go to about 100,000 later (≈ 115 chunks, still < 200
  entries) by changing only the CHECK and two constants.
- **Time to dictate:** ≈ 33 minutes of continuous speech at about 150 words per minute (≈ 900
  chars/min) [estimate].
- **Wire and sync:** ≤ 90 KB of UTF-8 for BMP text (≤ 3 bytes × 30,000 UTF-16 units); far under
  PowerSync's 15 MB per-row limit [verified, `resources/performance-and-limits.mdx`]. Supabase lists
  no request-body limit for Edge Functions; the 2 s CPU limit is not at risk (chunking plus ~40
  SHA-1s). [Body limit unverified; a 10 MB figure appears only on a third-party page.]
- **Counting:** both sides count UTF-16 `length` after `cleanStudyText`. The database counts code
  points, which are never more than UTF-16 units, so the database can never refuse what the function
  accepted (pgTAP checks 30,000 `é`s, which is 60,000 bytes).
- **Cost:** ≈ **$0.13 for a full 30,000-char note, about $0.01 for a short one**, on Sonnet 5.5
  [estimate: D33's ~$1.10 per 100-page PDF ÷ ~300 chunks ≈ $0.004 per chunk; the extract step itself
  makes no model call].

---

## 6. The monthly cap

**A text source counts as 1 *source* (stage `extract`, 1 unit), exactly like a PDF or a link.**
- No SQL change: `enqueue_tracy_event` is called with `caps.sources`, as for pdf, doc and link
  (pgTAP: with a limit of 1, a text source uses it up and the next PDF gets `P0001 dualrep_cap_reached`)
  [verified].
- The give-back, re-check, `counted_at` and `ran` rules all hold unchanged.
- The app's message is already right: "You've used all 5 sources for this month."
- Not as *pages*: the page cap pays for vision transcription and its message says "handwritten and
  scanned pages".
- Not uncounted: the outline and cards calls cost real money and are what the caps protect.
- Not weighted by size: a 100-page PDF is also 1 unit.

**Revisit when** testers dictate daily and 5 free sources a month feels tight. A separate text cap
can't be done with limits alone, because `check_tracy_cap` sums by stage. It would need a new stage
value (the CHECK on `tracy_events.stage`, `tracy_events_stage_matches_job`, `STAGES`, and
`sourceProgress`), or a `kind` filter in `check_tracy_cap`.

---

## 7. Sync, RLS and the phone

- **PowerSync:** no change to `sync-config.yaml`, so **no PowerSync redeploy**. `validate:sync`
  passes against the regenerated snapshot [verified]. PowerSync's docs say:
  - "Column changes such as adding … are not automatically detected"; "Adding a column with a `NULL`
    default value will generally not cause issues. Existing records will have a missing value instead
    of `NULL`…";
  - "client-side schema is just a view … no client-side migrations required";
  - unknown columns "stored internally, but not accessible" to old builds
  (`maintenance-ops/implementing-schema-changes.mdx`, powersync-docs commit 0e54249) [verified].
  New text rows are inserted after the migration, so they replicate whole.
- **Large values:** the body is TOASTed (> 2 KB). PowerSync merges unchanged TOAST values from its
  stored row, with a targeted re-snapshot for edge cases (`WalStream.ts` `ToastableSqliteRow` and
  `resnapshot`, powersync-service commit 4df5d45) [verified, from source]. `source_files.transcript`
  (up to 20,000 chars) already takes this path in Phase 2.
- **Registry:** `src/db/tables.ts`, under `sources`, gets `body: 'text'` and
  `writes: { ...OWNER_WRITES, serverGenerated: ['body'] }`. The registry-drift test **fails without
  it** ("sources: every Postgres column is synced or explicitly server-only", `+ "body"`) and passes
  with it [verified]. `serverGenerated` strips `body` from any PUT and refuses a PATCH of it
  (`DUALREP_WRITE_NOT_ALLOWED`) [verified with a new test].
- **RLS:** unchanged. The owner and group members read the body; outsiders see nothing (pgTAP)
  [verified].
- **Old app builds:**
  - A `text` source shows as "Material" (`sourceKindLabel` fallback) with the right progress line,
    since `sourceStep` has no `text`-specific branch [from code].
  - Their `submit_source` calls are unchanged and still valid.

---

## 8. App changes (data layer prototyped and tested; screens specified)

The diff of the prototyped part is at `scratch/pipeline/app-src.diff`. **`tsc --noEmit` passes, eslint
reports 0 problems on the changed files, and jest for `src/db` and `src/features/study` passes:
23 suites, 584 tests** [verified].

| File | Change |
|---|---|
| `src/db/tables.ts` | `sources.columns.body = 'text'`; `serverGenerated: ['body']` (above) |
| `supabase/schema.snapshot.json` | Regenerated by `npm run db:test` (adds `sources.body text nullable`) |
| `src/features/study/studyApi.ts` | `SOURCE_KINDS` + `'text'`; `STUDY_API_LIMITS.maxTextChars = 30000`; `KIND_FILE_TYPES.text = {}`; `SubmitSourceRequest.text?: string \| null`; `cleanStudyText()`, the same rules as the server's, so the editor's counter matches |
| `src/features/study/upload.ts` | `MaterialInput` gains `{ kind: 'text'; text: string; title?: string \| null }`; `validateText()` (`no_text` and `too_long` `UploadError`s); `addMaterial` text branch: no prepare or upload, title defaults to `notesTitle(now)` ("Notes, 12 Oct"), and the request carries `text`. The same `beforeSubmit` (`waitForUploads`), the same retry on 404 "plan not there yet", the same source id reused across attempts |
| `src/features/study/textDrafts.ts` (new) | One draft per plan in `local_state` (key `study-text-draft:<planId>`, `{v:1, planId, sourceId, title, text, updatedAt}`); `parseTextDraft` / `draftToSave` (cut at 2× the limit) / `read`, `save`, `clearTextDraft` / `useTextDraft(planId)` |
| `src/components/studyText.ts` | `SOURCE_KIND_LABELS.text = 'Spoken or typed notes'` |
| `src/features/study/sourceProgress.ts` | **No change.** The new jest test shows a `text` source goes reading → outlining → review_outline → making_cards → ready, and a failed extract shows its error with Try again; never `check_transcripts` |
| `src/features/study/studyQueries.ts` + `hooks.ts` (to write) | `SOURCE_TEXT_SQL = SELECT s.id, s.title, s.kind, s.body, s.status, s.created_at FROM sources s WHERE s.id = ?` and `useSourceText(sourceId)`. Keep `body` **out of** `PLAN_SOURCES_SQL`, so the list stays light |
| `src/app/(app)/plans/[id]/add.tsx` (to write) | A 4th mode: `{ value: 'text', label: 'Text', accessibilityLabel: 'Speak or type your notes' }`, with a section titled "Speak or type your notes" (more on this mode below) |
| `src/app/(app)/plans/[id]/index.tsx` (to write) | (a) When `useTextDraft(planId).draft` exists, a card "Unsent notes · Saved on this phone. Add them when you're online." with **Continue** → `/plans/[id]/add?mode=text`. (b) `SourceCard`: for `kind === 'text'`, a **View notes** button → the new route. (c) The empty-state line gains "…, or speak or type your notes". The steps and the footer need no change |
| `src/app/(app)/plans/[id]/notes/[sourceId].tsx` (new, to write) | Read-only: title, "Spoken or typed notes · Added 12 Oct", the step pill, and `body` as selectable text, read from synced rows, so it **works offline**. Editing after adding is out of scope; adding the corrected version as new notes covers it |

What the new "Text" mode on the Add material screen holds:
- a multiline `TextField` (the speech track's mic button feeds it);
- a live counter "12,345 of 30,000" using `cleanStudyText(text).length`;
- a hint: "Counts as one source this month. You'll review the outline before cards are made.";
- the Name field.

How the "Text" mode behaves:
- **Draft:** it autosaves the draft (debounced about 1 s, and on blur or background) and restores it
  on open. It honours `?mode=text`.
- **Add to plan:** calls `addMaterial(ctx, { kind: 'text', text, title }, { ...common, sourceId: draft.sourceId })`.
  On success or `already_submitted` it clears the draft.
- **Conflict:** on `conflict` from a text submit, it says the server message and **mints a new
  `sourceId`** for the draft, so the next tap adds the changed version.
- **Offline or time-out:** it keeps the draft and the same `sourceId`; the existing
  `OfflineNotice action="Adding material"` covers the warning.

**Offline behaviour.**
- Dictation and typing work offline. Whether recognition itself works offline is the speech track's
  question.
- **Adding needs the internet**, as for every material (D32/D41). The draft lives in `local_state`:
  it survives app restarts, is never uploaded, and **is lost on sign-out**, because local-only tables
  are cleared then. Worth a line in the sign-out confirmation if testers write long notes offline.
- Not chosen: letting the phone insert a `sources` row through PowerSync's upload queue, with a
  trigger to enqueue the job. D32 rejected exactly that: there's no clean place for the cap, and a
  retried upload could undo the pipeline.
- A later nicety: auto-add when the connection returns while the screen is open.

---

## 9. Tests

### Written and passing in the scratch copy [verified]

- **pgTAP** `supabase/tests/15_text_sources.test.sql`, **25 tests**:
  - `body` is text, nullable, with no default, and is in the publication's `attnames`;
  - the service role stores a text source;
  - kind `'audio'` → 23514; a body on a pdf → 23514; `''` → 23514; 30,001 chars → 23514; 30,000
    `é`s accepted;
  - a JSON NUL → 22P05;
  - the service role may update `body`;
  - phone PUT with a body on notes → stored null; phone PUT of a text source → body null and
    `pending`;
  - phone PATCH of title + body → title stored, body kept; phone upsert with `body null` → the text
    is kept;
  - shared with a group: a member reads the body, an outsider sees nothing;
  - `enqueue_tracy_event(extract, kind text)` uses the source cap, and the next PDF gets P0001.
  - **The full suite:** 16 files, 678 tests, all pass; `00_schema` is unchanged and passes (the new
    trigger function is executable by nobody).
- **Deno (100 tests pass; `deno check` and `deno lint` are clean):**
  - `validate_test`: the text rules, cleaning, other kinds refusing `text`, and an older app without
    `text`. One existing expectation gains `text: null`.
  - `chunker_test`: `breakLongLines` keeps whole words, nothing is lost, and short lines are
    untouched. The golden test for the Tracy port is untouched.
  - `handlers_test`: a text submit stores the rows and body, the job is
    `extract`/`cap_units 1`/`kind text`, a repeat gives `already_submitted`, changed text gives 409,
    and a kind mismatch gives 409.
  - `handlers_test`: over the source cap → 429 `stage extract`, and neither the source nor the body is
    kept.
  - `worker_test`: text → chunks with no `/health` call and no `/ai/extract` call while Tracy is
    asleep → outline released, then done → approve → cards → source `ready`, with `page null`
    throughout.
  - `worker_test`: a missing body fails with `noText`, and Try again → done → outline queued.
- **Jest:**
  - `sourceProgress.test` (the text steps);
  - `upload.test` (no Storage call and the exact wire body; `validateText` bounds);
  - `db/__tests__/upload.test` (`body` stripped from a PUT and refused in a PATCH; the
    `serverGenerated` list updated);
  - `textDrafts.test` (3 tests);
  - `registry-drift` (passes with the new snapshot and fails without the registry entry).

### Still to add with the screens

- `studyApi.test`: the wire format with `text`.
- `add.tsx`:
  - the Text mode renders;
  - the counter and over-limit state;
  - offline: the notice shows and the draft is kept;
  - a draft is restored from `local_state`;
  - success clears the draft;
  - `conflict` mints a new id.
- `plans/[id]/index.tsx`: the "Unsent notes" card, and **View notes** only for `text`.
- `notes/[sourceId]`: renders the body offline; handles a source that isn't on the phone.
- `studyQueries.test`: `SOURCE_TEXT_SQL` against the fake DB.

---

## 10. Deploy order and compatibility

1. Merge the server changes (migration, functions, tests) and the app changes on one branch.
2. **Deploy backend** (dry run first: it should list exactly one pending migration,
   `20261012120000_text_sources.sql`, then the functions). There is **no Tracy step, no
   `sync-config.yaml` change and no PowerSync redeploy.**
3. Build the app. If the app shipped first, a text submit would get the old function's 400 ("kind
   must be one of …"), which the app shows as "Update the app", and the draft would survive. So the
   backend goes first, as DATA_MODEL §6 says.
4. The current app keeps working against the new backend, since `text` is optional.

---

## 11. Docs to update

- **`docs/DATA_MODEL.md`:**
  - the `sources` row: kind list + `text`; the new `body` column and `keep_server_body`;
  - "The study pipeline": the `extract` row reads "for a PDF, Word file, link **or spoken/typed
    notes** (counted: 1 source)", with the input `kind` and "text: chunked by the worker, no Tracy
    call";
  - "How the phone follows it": `sources.body`;
  - §4 triggers: add `keep_server_source_body`;
  - §5: a row for the text source.
- **`docs/DECISIONS.md`:**
  - **D50 "Spoken or typed notes are a `text` source"**: the column vs. Storage vs. table choice, the
    cap = 1 source, chunking without Tracy, `breakLongLines`, the 30,000 limit, the 409 on changed
    text. Revisit when a separate text cap or editing after adding is wanted.
  - **D51 "Unsent notes stay on the phone"**: `local_state` drafts and why not PowerSync's upload
    queue.
  - D48: the route list gains `/plans/[id]/notes/[sourceId]` and `add?mode=text`.
  - D32: the `submit_source` field list.
  - The voice side (`RECORD_AUDIO`, the recognizer) is the speech track's D-entry; it amends D42 and
    D49.
- **`supabase/functions/study/index.ts` header and `_shared/contracts.ts`:** the contract in §4.1.
  `studyApi.ts` mirrors it.
- **`docs/SETUP.md`:** a short "Voice and typed notes" step: Deploy backend (dry run, then for real),
  no PowerSync step, build the app. Also a troubleshooting line for "Not added: … update the app".
- **`docs/ROADMAP.md`:** a "Voice notes" item (pipeline: done; dictation UI: the speech track).
- **`docs/TRACY_INTEGRATION.md`:** one line saying text sources never reach Tracy's `/ai/extract`
  (Tracy is unchanged).
- **`docs/ANDROID.md`:** nothing from this track.
- **The migration header comment** carries its own rationale (above).

---

## 12. Risks, open points and what I couldn't verify

- **Request-body limit for Edge Functions:** not in Supabase's limits page [unverified].
  ≤ ~90 KB is very unlikely to matter.
- **The cost per note** is an estimate from D33's figure, not measured.
- **The "Text" segment label** and the "Unsent notes" card are product choices. Four segments at a
  360 dp width should fit "File · Photos · Link · Text", but check on a device.
- **Sign-out loses unsent drafts** (`local_state` is cleared). This is acceptable for v1; mention it
  in the sign-out confirmation if needed.
- **Editing notes after they're added** isn't offered. The body is server-owned so it always matches
  the cards; "add the corrected version as new notes" is the path. There is no "remove a source from a
  plan" yet either (D48).
- **Monthly sources cap:** dictation competes with PDFs for the 5 free sources a month (§6).

---

## 13. Evidence and scratch files

All paths are under `/tmp/claude-0/-home-user/62f77bed-a0b7-5151-a1ee-47d5a2113a96/scratchpad/voice-research/scratch/pipeline/`:

- `db/supabase/migrations/20261012120000_text_sources.sql`: the migration.
- `db/supabase/tests/15_text_sources.test.sql`: the pgTAP tests.
- `db/supabase/schema.snapshot.json` and `snapshot.diff`: the regenerated snapshot (adds
  `sources.body`).
- `db/`: the copy of `scripts/db-test.sh`. Run with `cd db && bash scripts/db-test.sh` →
  "all 16 test files passed (678 tests)".
- `fn/`: the patched copy of `supabase/functions`. `fn-src.diff` holds the code changes;
  `fn-all.diff` adds the tests. Run with deno 2.2.15 (the CI version) and `DENO_DIR=deno-dir`:
  `deno test` gives 100 passed; `deno lint` and `deno check study/index.ts tracy-worker/index.ts`
  are clean.
- `app/`: the patched copy of the app (`node_modules` symlinked). `app-src.diff` holds the changes.
  Results: `npx jest src/db src/features/study` gives 584 passed; `npx tsc --noEmit` exits 0;
  `node scripts/validate-sync-config.mjs` reports OK.
- `chunkcount.ts`: the chunk counts in §5.2.
- `tracyprobe/probe.mjs`: Tracy's `extractFromBuffer` on `text/plain` (option 2 works without a Tracy
  change; the `%PDF-` pitfall).
- `web/psdocs` (powersync-docs @0e54249), `web/pssvc` (powersync-service @4df5d45) and `web/sbdocs`
  (supabase docs @cb4307f): sparse clones of the primary sources. `docs.powersync.com` and
  `supabase.com` were blocked by the proxy, so I read the docs from their GitHub sources.

### Sources

- PowerSync docs: [Implementing Schema Changes](https://docs.powersync.com/maintenance-ops/implementing-schema-changes),
  read from github.com/powersync-ja/powersync-docs `maintenance-ops/implementing-schema-changes.mdx`.
- PowerSync docs: [Performance and Limits](https://docs.powersync.com/resources/performance-and-limits),
  the 15 MB row limit.
- PowerSync service source: github.com/powersync-ja/powersync-service
  `modules/module-postgres/src/replication/WalStream.ts` (TOAST handling).
- Supabase docs: [Edge Functions limits](https://supabase.com/docs/guides/functions/limits.md),
  read from github.com/supabase/supabase `apps/docs/content/guides/functions/limits.mdx`.
- Local Postgres 16.15 + pgTAP: the NUL rejection (22P05), `char_length`, triggers vs CHECK, the
  publication's `attnames`.
- tracy-ai `src/extract.js` (`sniff`, `extractFromBuffer`) and `src/tasks/dualrep.js` (outline and
  cards limits).
