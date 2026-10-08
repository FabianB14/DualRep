# Tracy integration

How DualRep should talk to Tracy, Interverse's AI backend. Read this before any Phase 2 or Phase 3
work that calls Tracy.

- **Reviewed:** 2026-10-08, against the `tracy-ai` repo at commit **`88f4201`**.
- **Read-only:** nothing in `tracy-ai` was changed in Phase 0. The changes in
  [section 10](#10-tracy-ai-changes-for-phase-2-proposed-not-made) are proposals.
- **References:** every `path:line` below points into the `tracy-ai` repo at that commit. If Tracy has
  moved on, search for the function name instead of trusting the line number.

---

## 1. The answer to the plan's open question

> *"How do existing Tracy surfaces authenticate, and which endpoint does a new surface call?"*
> ([EXECUTION_PLAN.md](EXECUTION_PLAN.md), open questions)

**Short answer.** People (the web app, PartOut) sign in with an access key and get a session token.
Servers use a shared secret. DualRep is a server-to-server caller: a Supabase Edge Function calls
**`POST /ai/tasks/<task>`** with the header **`X-Service-Secret`**. DualRep does not use `/chat`.

How each kind of caller authenticates today:

| Mechanism | Where in tracy-ai | Who uses it |
|---|---|---|
| Access key exchanged for a session token: `POST /auth {key}` returns an HMAC token valid for 180 days. The key is re-checked against `ACCESS_KEYS` plus the `access_keys` table (cached 60 s). | `src/auth.js:20-21, 28-45, 68-88, 137-159` | Web app; PartOut from the browser (`integrations/partout/tracy-mechanic.js:52-75`) |
| The whole gate is **off** unless `AUTH_SECRET` is set | `src/auth.js:23, 150` | — |
| Verified identity: a key made with `--user/--role` sets `req.authUser` | `src/auth.js:104-132`, used at `src/server.js:171-173` | Vault and admin tools |
| Self-declared `userId` in the request body (not verified) | `src/server.js:115, 155-157` | Memory, knowledge scope, logging |
| Bring-your-own-key headers `X-Anthropic-Key` / `X-Gemini-Key` | `src/server.js:142-152` | Team members, PartOut users |
| Admin allow-list `ADMIN_USER_IDS`, matched against the verified identity | `src/tools.js:683-704` | Admin surface |
| `X-Tasks-Secret` (plain string compare) | `src/server.js:647-650` | Daily digest cron |
| **`X-Service-Secret`** | `src/aitasks.js:177-186` | INTERVERSE backend → `/ai/tasks` |

**Why the task lane and not `/chat`:**

- `/ai/tasks` is the only server-to-server lane. It checks one shared secret, forces JSON output,
  validates that output before returning it, and touches no memory, Brain or knowledge cache.
- `/chat` is built for people. It needs a person's access key turned into a 180-day token, it returns
  prose, it may answer word for word from cached knowledge, and it reads and writes memory, Brain and
  knowledge. That would break DualRep's data boundary ([section 7](#7-data-boundary-keep-dualrep-data-out-of-tracys-stores)).

**Who calls Tracy.** Never the phone. The app calls a DualRep Edge Function. The function checks the
user's session, tier and monthly cap, then calls Tracy. Tracy's address and secret live only in
Supabase Edge Function secrets, never in the APK.

---

## 2. The recommendations in one list

1. **Use the task lane (`POST /ai/tasks/:task`) for all five DualRep jobs. Do not use `/chat`.**
2. **DualRep owns the job queue.** Long jobs are rows in DualRep's `tracy_events` table. A worker Edge
   Function claims them, calls Tracy one short step at a time, and writes the results with DualRep's
   own service role. Tracy stays stateless and never holds DualRep's service-role key. This changes one
   sentence in the plan ([section 6](#6-long-jobs-dualrep-owns-the-queue)).
3. **One secret per caller.** Give DualRep its own secret (for example `SERVICE_SECRET_DUALREP`) so it
   can be revoked and logged on its own and limited to `dualrep_*` tasks.
4. **No Groq fallback for DualRep tasks,** and **metadata-only logs** (task, caller, model, usage,
   latency, ok/error, request id; never the input or output).
5. **The plan's "Claude Sonnet 5.5" will fail on today's task lane.** The lane always sends
   `temperature: 0` and a forced `tool_choice`. Sonnet 5.5 rejects both with a 400. Haiku 5.5 rejects
   the temperature. Fix: drop `temperature`, and use `tool_choice: {type: "auto"}` with `strict: true`
   on the tool, or structured outputs via `output_config.format`
   ([section 5](#5-models-what-breaks-and-what-it-costs)).
6. **Embeddings: `vector(1536)` pinned in DualRep.** Call Gemini `gemini-embedding-2` with 1536
   dimensions from DualRep's own worker. Do not reuse Tracy's env-driven `embed()`
   ([section 8](#8-embeddings-and-page-references)).
7. **Per-page PDF extraction.** Tracy's PDF reader throws away page numbers. "Every card cites a page"
   needs a small per-page extraction path ([section 8](#8-embeddings-and-page-references)).

---

## 3. What the plan assumed vs. what exists

The plan says Tracy has "model routing, confidence gating, and pgvector". The code is simpler:

| Plan says | What the code does |
|---|---|
| Model routing | No Haiku-vs-Sonnet routing. Each lane uses one model from an env var: `/chat` uses `TRACY_MODEL` (default `claude-sonnet-4-6`, `src/server.js:60`); tasks use `TRACY_TASK_MODEL` (default `claude-haiku-4-5`, `src/aitasks.js:128-130`). The only real router picks Claude Code or Codex for coding agents (`src/agents.js:93-120`). |
| Confidence gating | Knowledge-cache similarity for `/chat` only, not model confidence (`src/server.js:213-235`): cosine ≥ 0.95 returns the saved answer word for word; ≥ 0.88 lets Gemini `gemini-2.5-flash` answer; otherwise Claude answers. |
| pgvector | None. Embeddings are stored as JSONB (`src/knowledge.js:41`, `src/brain.js:119`) and compared with cosine in JavaScript over at most 2,000 rows (`src/knowledge.js:51-83`). |
| Queued jobs on Tracy's server | Only coding tasks have a queue (`agent_tasks`, `src/agents.js:23-60`). `/ai/tasks` is synchronous request and response. |

None of this blocks DualRep. It means DualRep should not count on Tracy for routing, retrieval or
queuing, and should own those pieces itself.

---

## 4. The task lane in detail

### How a task is defined

Tasks are registered in `TASKS` (`src/aitasks.js:34-125`). Each task has four parts:

- `buildSystem(input)`: the system prompt with the job and its hard rules.
- `buildUser(input)`: a short framing line plus the input as JSON. Untrusted data stays inside the
  JSON (`:58-60`); a test enforces this (`tests/aitasks.test.js:138-145`).
- `tool`: the forced tool. Its `input_schema` *is* the output shape (`:61-86`).
- `checkOutput(out)`: a hand-written validator that returns a list of error strings (`:87-123`).

### What `runTask` does (`src/aitasks.js:134-168`)

| Situation | Result |
|---|---|
| Unknown task, or input is not a plain object | **400** (`:136-137`) |
| Model call | `messages.create` with `max_tokens: 1024`, `temperature: 0`, one tool, `tool_choice: {type: "tool", name}` (`:140-150`) |
| The model call throws | **502** `model call failed: …`; the upstream status is never passed through (`:151-157`) |
| No `tool_use` block in the reply | **502** (`:159-162`) |
| The validator finds errors | **502** `model output failed validation: a; b` (`:163-166`) |
| Success | `{ output, model, usage }` (`:167`) |

Tracy does **not** retry. The caller retries and passes `input.previous_errors`; the system prompt
tells the model to fix them (`:9`, `:55`).

### The route (`src/server.js:686-711`)

- Request body: `{ input, request_id? }`.
- Success: `200 { ok: true, task, output, model, usage, request_id? }`.
- Failure: `{ ok: false, error }` with status 400 or 502. A missing or wrong secret gets
  `403 { error: "forbidden" }`.
- Every call is logged with its **full input and output** to Tracy's `conversations` table as
  `userId: "service:interverse"` (`:693-699`). That must change for DualRep (section 7).

### The secret check (`requireServiceSecret`, `src/aitasks.js:177-186`)

It compares SHA-256 digests with `timingSafeEqual` and fails closed: if `SERVICE_SECRET` is unset,
nobody gets in. Today there is **one secret for every caller**, so DualRep would share it with the
INTERVERSE backend. `SERVICE_SECRET` and `TRACY_TASK_MODEL` are documented in `README.md:86-99` but
missing from `.env.example`.

### The hidden Groq fallback

- The route wraps the Anthropic client in `withGroqFallback` (`src/server.js:689`). When
  `GROQ_API_KEY` is set and the failure is "worth falling back", the call goes to Groq instead
  (`src/groq.js:173`).
- "Worth falling back" means anything except `too_large` (`src/apierrors.js:144-146`). An unexplained
  400 is classified as `unknown` (`src/apierrors.js:133-140`), so **a 400 from a newer Claude model
  silently sends the request to Groq.**
- For DualRep that would send study material and private notes to a third provider. DualRep tasks
  need fallback turned off.

### Timeouts

There is no Anthropic timeout in Tracy's code, so the SDK default applies (10 minutes, 2 retries). The
Groq call has a 20-second timeout (`src/groq.js:44`). In practice the DualRep Edge Function's own
timeout is the real limit.

### Calling it from a DualRep Edge Function (Phase 2 sketch)

```ts
// supabase/functions/<name>/index.ts (Deno). TRACY_URL and TRACY_SERVICE_SECRET are Edge Function
// secrets: `npx supabase secrets set TRACY_URL=... TRACY_SERVICE_SECRET=...`
const r = await fetch(`${Deno.env.get('TRACY_URL')}/ai/tasks/dualrep_grade_answer`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Service-Secret': Deno.env.get('TRACY_SERVICE_SECRET')!,
  },
  body: JSON.stringify({ request_id: eventId, input }), // eventId = the tracy_events row id
  signal: AbortSignal.timeout(8_000),
});
```

How to handle each status:

| Status | Meaning | What DualRep does |
|---|---|---|
| 200 | Valid output | Validate it again in DualRep before saving (the plan says the app validates every proposal). Record `model` and `usage` in `tracy_events`. |
| 400 | Bug on DualRep's side | Don't retry. Mark the job `failed`. |
| 403 | Wrong or missing secret | Configuration problem. Alert; don't retry. |
| 502 | Model failed or output invalid | Retry once with `input.previous_errors`, then fall back (default circuit, or self-grading). |

### Which lane and model per DualRep job

| Job | Proposed task(s) | Model tier | Sync or queued | Why |
|---|---|---|---|---|
| Transition planner | `dualrep_plan_transition` | fast | Sync. Call it *while* the focus block runs to hide latency; the default circuit covers failure. | Output is a structured circuit. The validator can enforce "only allowed exercise IDs", "load increase ≤ cap", "replacing a main lift needs confirmation". |
| Answer grader | `dualrep_grade_answer` | fast | Sync | Fixed verdict (`right` / `partly` / `missed`) plus `missing_points[]`. Low confidence falls back to self-grading. |
| Handwriting | `dualrep_transcribe_notes`, one photo per call | strong (vision) | Sync per photo, or queued for batches | Needs image input, so `buildUser` must be able to return content blocks. Output is a draft; `source_files.confirmed` stays false until the user confirms. |
| Study builder | `dualrep_build_outline`, then `dualrep_build_cards` per topic | strong | **Queued** | Too long for one call. Splitting keeps each call short. The validator checks every card's `source_chunk_id` and page come from the input. |
| Analyst (weekly review) | `dualrep_weekly_review` | strong | **Queued** (weekly) | SQL computes the numbers; Tracy only writes text. The validator enforces "fewer than 4 weeks of data → no patterns" and flags causal wording. |
| (Optional) explanations | `dualrep_explain` | fast | Sync | One line, with the page it came from. |

No `/chat` lane in Phase 2.

---

## 5. Models: what breaks and what it costs

Checked by the lead against Anthropic's current model reference on 2026-10-08:

| `TRACY_TASK_MODEL` | `temperature: 0` | Forced `tool_choice` (`any` / `tool`) | Works on today's task lane? |
|---|---|---|---|
| `claude-haiku-4-5` (Tracy's default) | Accepted | Accepted | Yes |
| `claude-haiku-5-5` | **400** (only the default temperature is accepted) | Accepted | No, until `temperature` is dropped |
| `claude-sonnet-5-5` (the plan's "strong" model) | **400** | **400** | No |

Current prices per 1 million tokens (input / output):

| Model | Input | Output | Note |
|---|---|---|---|
| Claude Haiku 4.5 (`claude-haiku-4-5`) | $1.00 | $5.00 | |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 | $0.50 | For prompts up to 100K tokens ($0.50 / $2.50 above that) |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2.00 | $10.00 | |

**The fix** (proposed change 1 in section 10):

1. Stop sending `temperature` unless a task sets it explicitly. Tracy's existing `convert_asset` task
   can keep `temperature: 0` while it runs on Haiku 4.5.
2. Replace the forced tool with one of these:
   - `tool_choice: {type: "auto"}` plus `strict: true` on the tool definition (a top-level field next
     to `name`, `description` and `input_schema`; the schema needs `additionalProperties: false` and
     `required`). Check that a `tool_use` block came back, and retry once if not.
   - Or structured outputs: `output_config: {format: {...}}` on `messages.create`.
3. Make `max_tokens` a per-task setting instead of the fixed 1024 (`src/aitasks.js:143`).
4. Use one code path for every model, so switching `TRACY_TASK_MODEL` never breaks the lane.

**Worth an eval in Phase 3:** Claude Haiku 5.5 for the planner and the grader. It is a tenth of the
price of Haiku 4.5. It also runs adaptive thinking by default, so measure latency against the plan's
3-second planner gate before switching.

**Tracy's SDK is old.** `@anthropic-ai/sdk` is pinned at `^0.32.0` with 0.32.1 installed
(`package.json:18`, `package-lock.json:35-36`); npm's latest was 0.132.1 on 2026-10-08. Bump it (as its
own PR) before relying on `strict`, `output_config` or URL image sources. **Verify** whether 0.32.1
passes these fields through; it was not tested.

---

## 6. Long jobs: DualRep owns the queue

### What the plan says, and why to change it

The plan says the study builder and the weekly review "run as queued jobs on Tracy's server and write
their results to DualRep's database". That would put **DualRep's service-role key on Tracy**. The
service role bypasses every RLS policy, so a Tracy breach would expose all DualRep data. It would also
leave DualRep data at rest in Tracy's Postgres, and Tracy's cold starts would stall jobs.

**Suggested wording:** "run as queued jobs in DualRep's `tracy_events` table; a worker Edge Function
calls Tracy and writes the results."

### The design

The `tracy_events` table already exists in the first migration (see [DATA_MODEL.md](DATA_MODEL.md)):

| Column | Use |
|---|---|
| `job` | `transition_planner`, `study_builder`, `answer_grader`, `analyst`, `handwriting` |
| `status` | `queued` → `running` → `succeeded` / `failed` / `cancelled` |
| `input`, `output` | The job's JSON. **Server only:** never synced to the phone. |
| `error` | Short error text (synced, so the app can show it) |
| `accepted` | Whether the user took the result. The **only** column the device may change. |
| `attempts`, `locked_at` | Worker bookkeeping for claiming and retrying |
| `model`, `usage` | What Tracy reports, for the monthly cap |

The flow (Phase 2):

1. An Edge Function inserts a `tracy_events` row with `status = 'queued'`, `job`, `input` and
   `user_id`. (Devices cannot insert into this table; only the service role can.)
2. A worker Edge Function, `tracy-worker`, is woken every minute by `pg_cron` through `pg_net`, and/or
   by a database webhook on insert.
3. It claims rows with `FOR UPDATE SKIP LOCKED`, the same pattern Tracy uses for coding tasks
   (`src/agents.js:183-190`). The partial index `tracy_events_queued_idx` makes finding the oldest
   queued job cheap.
4. It calls `POST /ai/tasks/...` one short step at a time:
   - Study builder: the outline first, then one cards call per topic, each well under 60 seconds.
   - Weekly review: a `pg_cron` job runs the SQL aggregates and enqueues one review per user.
5. It writes results into DualRep's tables with **its own** service role, and sets
   `status = 'succeeded'` (or `failed` with `error`).
6. PowerSync syncs `status`, `error` and the result rows to the phone. That is the progress UI.

Use the `tracy_events.id` as Tracy's `request_id`, so a log line on either side can be matched.

Supabase Queues (pgmq) could replace the hand-written claim step later. Keep `tracy_events` as the
audit log either way.

### Limits that shape this

- **Supabase Edge Functions:** 150 s wall clock on Free and 400 s on paid plans; a 504 if no response
  arrives within 150 s; 2 s of CPU (waiting on network does not count); 256 MB memory. (Read from
  Supabase's docs source during research; **verify** on the current limits page.)
- **Render free tier** (if Tracy runs there): sleeps after 15 minutes idle and takes about a minute to
  wake. That threatens the planner's 3-second gate. Calling the planner during the focus block and
  keeping the default circuit as a fallback covers it. Tracy's actual Render plan was not visible.

If Tracy-side async is ever wanted: `POST` returns `202 { job_id }` and Tracy calls back a DualRep
Edge Function webhook with an HMAC-signed body. Still never give Tracy the service key.

---

## 7. Data boundary: keep DualRep data out of Tracy's stores

How each Tracy store fills up:

- **Brain.** Curated `brain/entities/*.md` files are synced to `brain_entities` at boot
  (`src/server.js:734-739`, `src/brain.js:134-176`) and injected into `/chat`
  (`src/server.js:187-194`). The **`brain_note`** tool, which every surface has
  (`src/tools.js:62-69, 75-90`), writes to `brain_raw_notes` (`src/brain.js:337-350`). Raw notes are
  immutable ("Never edit, never delete", `brain/CLAUDE.md:39`), so anything that leaks in stays in git
  history.
- **Knowledge.** Scoped `global` or per `userId` (`src/knowledge.js:31-47`). `/chat` reads both and may
  answer word for word from them (`src/server.js:198-207, 223-225`). Fresh answers of 40+ characters
  are written back to the user's scope, **or to `global` when no userId was sent**
  (`src/server.js:386-393`).
- **Memory.** Per user, shared across every surface (`src/memory.js:3-5`), injected into `/chat`
  (`src/server.js:175-182`).
- **Conversation logs.** Every `/chat` **and every `/ai/tasks` call**, with full input and output, goes
  to `conversations` (`src/server.js:367-373, 693-699`; `src/logging.js:99-114`). Only secret-shaped
  strings are masked. The code calls these logs "future fine-tuning fuel".
- **Groq.** When the fallback fires, prompts go to Groq.

The task lane touches none of memory, Brain or knowledge. Its only leaks are the logs and Groq. So:

1. DualRep calls **only** `/ai/tasks/dualrep_*`. Never `/chat`, `/kb/upload` or `/threads/*`.
2. **Metadata-only logs** for DualRep tasks: task, caller, model, usage, latency, ok/error and
   `request_id`. Never the input or output.
3. **`allowFallback: false`** for DualRep tasks, so copyrighted uploads and private notes never go to
   Groq. Also stop 400 errors from triggering any fallback.
4. **A separate secret per caller** (`service:dualrep`).
5. **Opaque IDs only.** Send the Supabase user UUID (or a hash), never names or emails. Send images as
   short-lived signed Storage URLs.
6. If a `dualrep` chat surface ever ships, it must be **isolated**: no memory, Brain or knowledge reads;
   no knowledge write-back and no cached-answer shortcut; none of the core tools (`remember`,
   `brain_note`, `correct_knowledge`/`forget_knowledge`, `code_task` and friends, vault,
   `create_document`, check-ins); metadata-only logs.
7. Add a Tracy test that proves points 2, 3 and 6.

---

## 8. Embeddings and page references

### What Tracy uses

- Google Gemini through `@google/genai`. The model is `GEMINI_EMBED_MODEL`, default
  `gemini-embedding-2`; `GEMINI_EMBED_DIM` is optional and the model default is used when it is unset
  (`src/embeddings.js:17-19, 45-46`). Input is cut to 8,000 characters (`:41`).
- The stored model marker is `model` or `model@dim` (`:25`). At boot, Tracy re-embeds everything when
  the model changes (`src/knowledge.js:206-233`, `src/server.js:724-733`).
- The deployed `GEMINI_EMBED_DIM` was not visible. If it is unset, Tracy's vectors are 3072-dimensional.

### What DualRep does instead

- `gemini-embedding-2` defaults to **3072** dimensions and can return 768, 1536 or 3072 (from Google's
  docs via search summaries; **verify**). pgvector's HNSW and IVFFlat indexes support the `vector` type
  only up to **2,000** dimensions.
- So the first migration already has **`source_chunks.embedding extensions.vector(1536)`** with an HNSW
  index (`vector_cosine_ops`), plus an **`embed_model`** column (for example
  `'gemini-embedding-2@1536'`). Google retires embedding models on a schedule
  (`src/embeddings.js:7-12`), and `embed_model` says which rows to re-embed.
- **Pin the model and the size in DualRep.** The DualRep worker calls Gemini `embedContent` directly
  with `outputDimensionality: 1536` and a DualRep-owned key in Supabase secrets. Do not reuse Tracy's
  env-driven `embed()`: if Tracy's `GEMINI_EMBED_MODEL` or `GEMINI_EMBED_DIM` changed, DualRep's stored
  vectors would silently stop matching new queries.
- `source_chunks` never syncs to the phone and is not in the `powersync` publication.

### Page numbers

- Tracy's `extractPdfText` joins all pages and strips the page markers (`src/pdf.js:27-30`).
- The `pdf-parse` 2.4.5 it uses already returns `pages: [{ num, text }]`, so a per-page version is
  about five lines.
- `chunkText` (`src/knowledge.js:176-186`, about 900-character chunks with the nearest heading) can
  then run per page, so every chunk, and every card made from it, keeps its page number.
- PDF parsing should **not** run in an Edge Function (2-second CPU cap). A small, stateless Tracy
  endpoint is the natural home: proposed change 6 below.

---

## 9. Surfaces (only if DualRep ever needs open chat)

A surface is an entry in `SURFACES` (`src/surfaces.js:33-52`):

```js
dualrep: { prompt: "dualrep", toolSets: [] },
```

- `prompt` names `prompts/surfaces/<prompt>.md`. The file is optional and read lazily
  (`src/surfaces.js:57-65`).
- `resolveSurface()` (`src/surfaces.js:72-103`) builds the system prompt from the core
  `prompts/tracy_system.md`, a "Current surface" note, then the surface file.
- `buildToolkit()` (`src/tools.js:1128-1164`) always adds the core tools. **A surface cannot opt out
  of them**, which is why open chat would need the isolation flag in section 7.

**Recommendation for Phase 2:** create `prompts/surfaces/dualrep.md` as the one place for DualRep's
voice and guardrails, and have the DualRep **task** prompts read it. Skip the `SURFACES` entry until a
chat feature exists. The task lane never uses surfaces: `runTask` sends only `task.buildSystem(input)`
(`src/aitasks.js:145`), not `tracy_system.md`, which is good; that core prompt is about 180 lines on
vaults, check-ins and code tasks.

One core rule needs care: "Do not give medical, legal, or financial advice"
(`prompts/tracy_system.md:149-150`). `dualrep.md` should say plainly that general strength-programming
guidance is in scope, and carry the plan's rule that a report of pain stops the block and Tracy
suggests seeing a professional.

---

## 10. tracy-ai changes for Phase 2 (proposed, not made)

1. **`src/aitasks.js` → `runTask`:** per-task settings, keeping the file dependency-free.
   - `tier` (`fast` / `strong`) using `TRACY_TASK_MODEL` / `TRACY_TASK_MODEL_STRONG`.
   - `maxTokens` instead of the fixed 1024. Suggested: planner 1024, grader 512, transcription 2048,
     outline 4096, cards 8192, review 1500.
   - No `temperature` unless the task sets one.
   - Output mode: `tool_choice: {type: "auto"}` + `strict: true` + one retry when no `tool_use` came
     back, or `output_config.format`.
   - `allowFallback` and `log` options.
   - `buildUser` may return a content-block array, so an image can be sent by URL.
   - Its own Anthropic timeout below the Edge Function budget (about 60 s).
   - Attach `err.validationErrors` so the route can return `errors: []` as a list.
2. **New `src/tasks/dualrep.js`** (Node built-ins only) merged into `TASKS`: `dualrep_plan_transition`,
   `dualrep_grade_answer`, `dualrep_transcribe_notes`, `dualrep_build_outline`, `dualrep_build_cards`,
   `dualrep_weekly_review`, optionally `dualrep_explain`. Each `buildSystem` reads
   `prompts/surfaces/dualrep.md`. Each `checkOutput` enforces the plan's guardrails: exercise IDs come
   from `input.allowed_exercises`; `load_change_pct` ≤ `input.load_cap_pct`; a replaced main lift needs
   `needs_confirmation: true`; each card's `source_chunk_id` and page come from the input; fewer than 4
   weeks of data means no patterns; the grader verdict is `right`, `partly` or `missed`.
3. **`requireServiceSecret`:** one secret per caller (for example `SERVICE_SECRET_DUALREP`, keeping
   `SERVICE_SECRET` for the existing caller). Set `req.serviceCaller` and allow each caller only its
   own task prefix.
4. **`src/server.js:686-711` and `src/apierrors.js`:** per-task model, fallback and log settings; log
   as `service:${caller}`, metadata only for DualRep; add `latency_ms` and `errors[]` to the response;
   classify a non-billing 400 as `bad_request` and exclude it from `worthFallingBack`. (That also stops
   the silent Groq switch for `/chat`, so review that side effect.)
5. **`prompts/surfaces/dualrep.md`:** DualRep's voice and scope (general strength programming is
   allowed); pain means stop and see a professional; answers cite a page or say "I don't know";
   transcriptions are drafts until confirmed; on-the-go mode is audio only; weekly reviews never state
   a cause.
6. **New stateless route `POST /ai/extract`** (service-secret gated): takes a short-lived signed
   Storage URL, extracts **per-page** text with `pdf-parse`'s `pages[]` (a new `extractPdfPages` next
   to `src/pdf.js:23`), returns `[{ page, chunks: [...] }]` using `chunkText`, and stores nothing.
   Pages with no text (scans) are marked for the vision transcription task.
7. **`tests/dualrep-tasks.test.js`**, zero dependencies, in the style of `tests/aitasks.test.js`: each
   validator rejects bad output; no `temperature` or forced `tool_choice` is sent on 5.5 models; no
   Groq call when `allowFallback` is false; logging is metadata-only; the caller-scoped secret refuses
   other tasks.
8. **`.env.example`:** add `SERVICE_SECRET` / `SERVICE_SECRET_DUALREP`, `TRACY_TASK_MODEL`,
   `TRACY_TASK_MODEL_STRONG`.
9. **`README.md`:** a DualRep lane section. **`TRACY.md`:** fix the out-of-date "There is no test suite
   yet" line (`TRACY.md:25-26`).
10. **Separate PR:** bump `@anthropic-ai/sdk` from 0.32.x.

**Deliberately not changed:** `/chat`, memory, knowledge, Brain, and the Groq and Gemini chat paths.

---

## 11. Working in the tracy-ai repo

- **Tests:** `npm test` runs `node --test tests/*.test.js` (`package.json:10`). Tests use only
  `node:test` and `node:assert/strict` with fake clients (`tests/aitasks.test.js:1-44`), and restore
  env vars in `try/finally`. A module that reads env at import gets its own test file
  (`tests/admin-gate.test.js:1-11`).
- `src/aitasks.js` imports only Node built-ins on purpose (`src/aitasks.js:11-14`), so its tests run
  without `node_modules`. In a scratch copy with no `node_modules`, the `aitasks`, `groq` and
  `apierrors` tests passed 44 of 44; the full suite needs `npm install` first (it needs `pg`).
- **Style** (`TRACY.md:14-31`): small modules in `src/`; comments explain *why*; ESM, 2-space indent,
  mostly double quotes; anything calling an external service degrades gracefully when its env var is
  unset; no secrets in git; run `node --check` on changed files; don't push, don't touch deploy config,
  don't hand-edit `brain/`; finish with a `SUMMARY:`.

---

## 12. Not verified

- Tracy's deployed settings on Render: `SERVICE_SECRET`, `TRACY_TASK_MODEL`, `GEMINI_EMBED_DIM`,
  whether `GROQ_API_KEY` and `AUTH_SECRET` are set, and whether the Render plan is free or paid.
- Gemini embedding specs (dimensions, input limit): from search summaries only. Tracy's code comment
  says `gemini-embedding-001` "died 2026-07-14"; a search summary of Google's guide says 001 is still
  available for text.
- Whether SDK 0.32.1 passes `strict`, `output_config` and URL image sources through.
- Supabase Edge Function limits: read from the docs' source, not the live page.
