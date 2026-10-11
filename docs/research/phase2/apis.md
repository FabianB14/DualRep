# Phase 2 research: external API facts (track `apis`)

- **Date:** 2026-10-09. Read-only research. Neither repo was changed.
- **Scope:** Gemini embeddings, the Anthropic API calls Tracy will make for DualRep, the Render free
  tier, and the Supabase Free plan quotas (including how many pgvector chunks fit).
- **Context read first:** `docs/ROADMAP.md` Phase 2 (lines 273-327), `docs/EXECUTION_PLAN.md` study
  and Tracy sections, all of `docs/TRACY_INTEGRATION.md`, the study and Tracy sections of
  `docs/DATA_MODEL.md` (lines 517-619), `supabase/migrations/20261008000000_initial_schema.sql`
  (`source_chunks` 310-326, `tracy_events` 557-577, grants 2020-2058, publication 2144-2173), and
  `powersync/sync-config.yaml`. Also Tracy's `src/aitasks.js:126-168`, `src/embeddings.js`, and
  `src/server.js:414, 686-711, 715-740`.

### How much to trust each fact

| Tag | Meaning |
|---|---|
| **[V]** | Verified today against a primary source: an official docs page fetched in full, the Gemini API's machine-readable REST discovery document, an official SDK's published source, or Supabase's docs source on GitHub `master`. |
| **[S]** | From an official page, but read only through a web-search summary. This sandbox's egress proxy blocks `ai.google.dev`, `docs.cloud.google.com`, `render.com` and `supabase.com`, so the page itself could not be fetched. Treat these as likely but re-check them before launch. |
| **[U]** | **Unverified**: an estimate, a derived number, or a community report. |

No Anthropic or Gemini API key was available in the sandbox, so no live API call was made. Request
shapes come from the docs and SDK source, not from a test call.

---

## 0. Key findings in brief

1. **`gemini-embedding-2` ignores `taskType` and `title`.** **[S]** Put the task in the text instead:
   queries become `task: search result | query: {q}` and chunks become `title: {t or none} | text: {c}`.
   This changes how TRACY_INTEGRATION §8 should be implemented. Record the prefix scheme in
   `embed_model`, because changing the prefix changes the vectors.
2. **Turn on billing for DualRep's Gemini project before real user material is embedded.** On the
   free tier, Google may use prompts to improve its products, and human reviewers may read them
   **[S]**. Paid embedding costs about **$0.012 per 100-page PDF** **[S]** for prices, **[U]** for the
   token count.
3. **The Supabase Free database (500 MB) holds only about 25-30k chunks** with `vector(1536)` plus
   HNSW, which is about 85 course PDFs across all users **[U]**, derived below. Before any data is
   written, consider `halfvec(1536)` and/or dropping the global HNSW index. The table is empty today,
   so changing it now is cheap.
4. **Sonnet 5.5 JSON tasks:** use `output_config: {effort, format: {type: "json_schema", schema}}`.
   Send no `temperature`, no forced `tool_choice` and no `thinking` field (adaptive is the default).
   Set `max_tokens: 16000`, because thinking counts toward it. The 4096/8192 values in
   TRACY_INTEGRATION §10 are too small. **[V]**
5. **Server-side fallback barely helps a study app.** On Sonnet 5.5 it takes only the scalar form
   `fallbacks: "default"` with the beta header `server-side-fallback-2026-07-01`. It retries only
   `cyber` and `frontier_llm` declines. A biology or medicine course that trips the `bio` classifier
   is not retried, so DualRep needs its own refusal path. **[V]**
6. **Expected cost** for a 100-page course PDF (outline plus cards from extracted text) **[U]**:
   about **$1.10 on Sonnet 5.5**, **$0.06 on Haiku 5.5**, **$0.34 on Haiku 4.5**. One handwritten
   page costs about **$0.03 / $0.002 / $0.006** on the same three models. Do not send the whole PDF
   as a `document` block: page images cost 5-10 times more, and Haiku 4.5 cannot take it at all.
7. **Render free tier:** a service spins down after 15 minutes idle and takes about a minute to spin
   up **[S]**. The workspace gets 750 free instance hours a month, and Hobby includes 5 GB of
   outbound bandwidth **[S]**. The worker should call Tracy's `GET /health` first with a 5-second
   timeout. If Tracy is waking, the worker should requeue the job for the next `pg_cron` tick rather
   than wait inside the 150-second Edge Function budget.
8. **Supabase Edge Function limits, read from the docs source today [V]:** 150 s wall clock on Free
   (400 s on paid plans), 2 s of CPU per request, 256 MB of memory, and a 504 if no response arrives
   within 150 s. Free quotas: 500k invocations a month, 1 GB storage, 50 MB per file, 5 GB egress
   plus 5 GB cached egress, 500 MB database per project, and pausing after 7 days of low activity.

---

## 1. Google Gemini embeddings

### 1.1 Models and their lifecycle

| Model ID | Status | Default dimensions | Input limit | Notes |
|---|---|---|---|---|
| `gemini-embedding-2` | Stable ID, live **[S]**. It shipped first as `gemini-embedding-2-preview` (about 2026-03-10) **[S]**. | 3072 **[S]** | **8,192 tokens**; longer input is silently truncated **[S]** | Multimodal. Ignores `taskType` and `title`; use prefixes in the text (§1.4). Output at non-default sizes is already L2-normalized **[S]**. |
| `gemini-embedding-001` | Live **[S]**. Released 2025-07-14. The current deprecations table lists a shutdown date of **2028-05-14**, with `gemini-embedding-2` as the replacement **[S]**. | 3072 **[S]** | **2,048 tokens** **[S]** | Uses the `taskType` field. Only 3072-dimensional output is normalized; other sizes must be L2-normalized by the caller **[S]** (from third-party docs only). |

- Google calls these shutdown dates the *earliest possible* dates and promises advance notice **[S]**.
- **Conflict:** Tracy's comment at `src/embeddings.js:9` says `gemini-embedding-001` "died 2026-07-14".
  That disagrees with the current deprecations table (2028-05-14). The table is likely right; an
  older edition of the schedule showed 2026-07-14 **[S]**. This does not affect DualRep, which pins
  `gemini-embedding-2`.

### 1.2 REST endpoints, auth and request shapes **[V]**

Source: the Gemini API discovery document,
`https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`, revision `20261008`
(fetched today), plus `@google/genai` 2.28.0 (npm latest, published 2026-10-07).

| Item | Value |
|---|---|
| Single text | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent` |
| Batch (synchronous) | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents` |
| Async batch (50% price, slow) | `POST .../v1beta/models/{model}:asyncBatchEmbedContent` (returns an `Operation`) |
| Auth | Header **`x-goog-api-key: <key>`** (`GOOGLE_API_KEY_HEADER = 'x-goog-api-key'` in `@google/genai` 2.28.0). The discovery document also accepts `?key=`. Use the header so the key stays out of URLs and logs. |
| `EmbedContentRequest` | `model` (`"models/gemini-embedding-2"`), `content` (`{parts:[{text}]}`; only `parts.text` counts), `embedContentConfig` {`taskType`, `title`, `outputDimensionality`, `autoTruncate`, `documentOcr`, `audioTrackExtraction`}. Top-level `taskType`, `title` and `outputDimensionality` still exist but are marked "**Deprecated: Please use EmbedContentConfig…**". |
| `taskType` enum | `TASK_TYPE_UNSPECIFIED, RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, SEMANTIC_SIMILARITY, CLASSIFICATION, CLUSTERING, QUESTION_ANSWERING, FACT_VERIFICATION, CODE_RETRIEVAL_QUERY` |
| `outputDimensionality` | "Reduced dimension for the output embedding. If set, excessive values in the output embedding are truncated from the end." |
| Response (single) | `{ embedding: { values: number[] }, usageMetadata: { promptTokenCount } }` |
| Response (batch) | `{ embeddings: [{ values }...], usageMetadata }`, "in the same order as provided" |

**What the official JS SDK actually sends [V]:** `@google/genai` 2.28.0, in Gemini Developer API
mode, always posts to `{model}:batchEmbedContents`. Each request in `requests[]` carries `model`,
`content`, and the **top-level** `taskType`, `title` and `outputDimensionality` (`index.mjs:18610-18638,
23414-23416`). The Vertex-only options (`autoTruncate`, `documentOcr`, `audioTrackExtraction`,
`mimeType`) throw in Developer API mode. The top-level fields therefore still work today, even
though the discovery document marks them deprecated.

**Batch size:** at most **100 requests per `batchEmbedContents` call**. More returns a
400 `INVALID_ARGUMENT` **[U]** (reported in several GitHub issues; no official page was readable).

**Aggregation pitfall [S]:** for `gemini-embedding-2`, several inputs placed in one `content` (or a
plain list passed to the SDK's `contents`) come back as **one aggregated vector**. To get one vector
per chunk, give every chunk its own request with its own `content`.

**Suggested Deno call from the DualRep worker** (raw `fetch`, no SDK; secrets are set with
`npx supabase secrets set GEMINI_API_KEY=...`):

```ts
const EMBED_MODEL = 'gemini-embedding-2';
const EMBED_DIM = 1536;
const EMBED_MARKER = 'gemini-embedding-2@1536#p1'; // p1 = prefix scheme v1 (see §1.4)

async function embedDocs(chunks: { title: string | null; text: string }[]): Promise<number[][]> {
  if (chunks.length > 100) throw new Error('max 100 per batchEmbedContents');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': Deno.env.get('GEMINI_API_KEY')!,
      },
      body: JSON.stringify({
        requests: chunks.map((c) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: `title: ${c.title ?? 'none'} | text: ${c.text}` }] },
          outputDimensionality: EMBED_DIM, // what @google/genai 2.28.0 sends; or embedContentConfig.outputDimensionality
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const { embeddings } = await r.json();
  return embeddings.map((e: { values: number[] }) => {
    if (e.values.length !== EMBED_DIM) throw new Error(`got ${e.values.length} dims`);
    const n = Math.hypot(...e.values); // re-normalize anyway (idempotent, cheap)
    return e.values.map((v) => v / n);
  });
}
// Insert: embedding = JSON.stringify(vec) — pgvector accepts the '[1,2,3]' text form.
```

Notes:

- `Math.hypot(...arr)` with 1,536 arguments is fine. If you prefer, use a loop.
- The `vector(1536)` column is a safety net. If Gemini ever ignored `outputDimensionality`, the insert
  would fail with "expected 1536 dimensions".
- Keep each call to 100 or fewer chunks. A 100-page PDF has about 300 chunks, so it needs about 3
  calls **[U]**.
- CPU stays well under the 2-second Edge Function cap per batch **[U]**: about 2 MB of JSON to parse
  and about 150k numbers to turn into strings.

### 1.3 Dimensions and normalization

- **1536 is supported.** For `gemini-embedding-2` the range is "128 - 3072, Recommended: 768, 1536,
  3072" **[S]**. The value 1536 fits pgvector's 2,000-dimension HNSW cap for `vector`
  (pgvector README) **[V]**.
- **Normalization:** `gemini-embedding-2` returns L2-normalized vectors at non-default sizes **[S]**.
  `gemini-embedding-001` does not below 3072 **[S]** (third-party only). L2-normalize in the worker in
  either case. It is idempotent, protects against a model switch, and makes cosine distance
  (`<=>`) equivalent to the inner product (`<#>`, which is cheaper).

### 1.4 Task types: prefixes on `gemini-embedding-2` **[S]**

- The Vertex AI docs, as quoted in search results, say: "You cannot use the task_type field to specify
  an embedding task for the gemini-embedding-2 model". The batch docs add that `task_type` and `title`
  inside `embed_content_config` "are silently ignored".
- A LlamaIndex issue (#21535) reports that two task types returned **identical vectors** **[U]**.
- The prefixes Google's embeddings guide recommends for text-only work **[S]**:

| Use | Text to embed |
|---|---|
| Stored chunk (document side of search) | `title: {title} \| text: {content}` (use `title: none` when there is no title) |
| Search query | `task: search result \| query: {content}` |
| Question answering query | `task: question answering \| query: {content}` |
| Fact checking query | `task: fact checking \| query: {content}` |
| Symmetric (classification, clustering, similarity) | `task: classification \| query: {content}`, `task: clustering \| query: …`, `task: sentence similarity \| query: …` ("Do not use this for search or retrieval") |

- **What this means for DualRep:**
  - Embed every `source_chunks.content` with the document form. A good title is the nearest heading
    from `chunkText` (TRACY_INTEGRATION §8), or the source title.
  - Embed retrieval queries with `task: search result | query: …`.
  - Make the prefix scheme part of `embed_model`, for example `gemini-embedding-2@1536#p1`.
    Changing the scheme changes every vector, exactly like a model change.
- **On `gemini-embedding-001`**, use `taskType: "RETRIEVAL_DOCUMENT"` (with `title`) for chunks and
  `"RETRIEVAL_QUERY"` for queries.

### 1.5 Rate limits (free tier)

- **[U]** There is no reliable figure for `gemini-embedding-2`'s free RPM, TPM or RPD. Third-party
  numbers disagree (for example "~1,500 req/day" and "10M TPM"). Google shows the actual limits per
  project in Google AI Studio's rate-limit view; check there after creating the project.
- Batch-mode (async) enqueued-token limits for "Gemini Embedding" are 500,000 on Tier 1 and
  5,000,000 on Tier 2 **[S]**. Batch mode has no free tier.
- DualRep's volume is small. Each upload is a few hundred requests in 3-4 batch calls. Retry 429s
  with backoff.

### 1.6 Pricing **[S]** (Gemini Developer API pricing page)

| Model | Free tier | Paid, standard | Paid, batch (asynchronous) |
|---|---|---|---|
| `gemini-embedding-2` (text input) | Free of charge | **$0.20 / 1M tokens** | $0.10 / 1M tokens (no free tier) |
| `gemini-embedding-2` (image / audio / video input) | — | $0.45 / $6.50 / $12.00 per 1M | half of those |
| `gemini-embedding-001` (2025 launch price, for reference) | Free | $0.15 / 1M | $0.075 / 1M |

A 100-page, 45k-word PDF is about 60k tokens, which is about **$0.012** to embed on the paid tier
**[U]** (token count assumed). Query embeddings cost a negligible amount.

### 1.7 Privacy: free-tier data is used by Google **[S]** (Gemini API Additional Terms)

- "Unpaid Services", meaning AI Studio and unpaid quota in the Gemini API: Google uses submitted
  content and responses "to provide, improve, and develop Google products and services and machine
  learning technologies". **Human reviewers** may read, annotate and process input and output, after
  it is disconnected from the account. The terms say "Do not submit sensitive, confidential, or
  personal information to the Unpaid Services."
- A project with billing enabled is a **Paid Service** when you are charged for it. Google then does
  not use prompts or responses to improve its products. It logs them for a limited period only to
  detect Prohibited Use Policy violations.
- **EEA, Switzerland and UK users:** the paid-service data terms apply even to unpaid use.
- **Recommendation:** DualRep embeds users' private notes and (often copyrighted) course material.
  Enable billing on a DualRep-owned Google Cloud project before any beta tester uploads. The cost is
  cents (§1.6). Restrict the API key to the Generative Language API. This settles the ROADMAP
  Phase 2 decision "Gemini API key and project owned by DualRep" (`ROADMAP.md:323`).
- For contrast, Anthropic's vision FAQ says "Anthropic does not use uploaded images to train models"
  **[V]**. Wider Anthropic API data-use terms were not re-checked today **[U]**.

---

## 2. Anthropic API for Tracy's DualRep tasks

Sources: the `claude-api` skill (`shared/model-migration.md` sections on Sonnet 5.5 and Haiku 5.5
and the refusal and fallbacks sections, `shared/tool-use-concepts.md` § Structured Outputs,
`typescript/claude-api/tool-use.md`, `shared/prompt-caching.md`), plus these live pages fetched
today: `platform.claude.com/docs/en/about-claude/pricing`, `.../build-with-claude/vision`,
`.../build-with-claude/pdf-support` and `.../api/rate-limits`. All **[V]** unless tagged.

### 2.1 Models, prices and tokenizers (live pricing page, 2026-10-09) **[V]**

| Model ID | Context / max output | Input | Output | Cache read | 5-min cache write | Batch input / output | Tokenizer |
|---|---|---|---|---|---|---|---|
| `claude-sonnet-5-5` | 1M / 128K | $2.00 | $10.00 | **$0.10** (0.05×) | $2.50 | $1.00 / $5.00 | New (~30% more tokens than Haiku 4.5 for the same text) |
| `claude-haiku-5-5` (prompt ≤ 100K tokens) | 1M / 128K | $0.10 | $0.50 | $0.01 | $0.125 | $0.05 / $0.25 | New |
| `claude-haiku-5-5` (prompt > 100K tokens) | | $0.50 | $2.50 | $0.05 | $0.625 | $0.25 / $1.25 | |
| `claude-haiku-4-5` | 200K / 64K | $1.00 | $5.00 | $0.10 | $1.25 | $0.50 / $2.50 | Old |

- Prices are USD per million tokens. The skill's cached table lists Sonnet 5.5 cache reads at $0.20;
  the live pricing page says $0.10 (0.05×), and the live page wins.
- **Haiku 5.5 is priced by prompt length:** a request whose prompt is over 100,000 tokens is billed
  at the higher card. Cache reads and writes count toward that length.
- **Tool-use system prompt overhead** (added when `tools` is present): Sonnet 5.5 286 tokens,
  Haiku 5.5 286 (406 with forced choice), Haiku 4.5 496 (588 with forced choice).
- **Prompt-caching minimum prefix:** 512 tokens on Sonnet 5.5 and Haiku 5.5, 4,096 on Haiku 4.5
  (skill `prompt-caching.md`).

### 2.2 (a) JSON output on `claude-sonnet-5-5`

What the model accepts **[V]**:

- `temperature` or `top_p` at non-default values: **400**.
- `tool_choice` of `any` or `tool`: **400** ("tool_choice: type "tool" and "any" are not supported for
  this model.").
- `thinking: {type:"disabled"}`: **400**. Leaving `thinking` out runs adaptive thinking. The text of
  `thinking` blocks is omitted by default (`display: "omitted"`), so a response can begin with a
  `thinking` block whose text is empty.
- Effort levels are `low` to `max`, with **default `high`**. The levels are recalibrated from
  Sonnet 5. Suggested starting points: `medium` for multistep work, `low` for content generation,
  extraction and classification.
- No assistant prefill.

**Recommended effort [U]** (starting points to measure on a real course PDF):

- Outline: **`medium`**. It reads about 85k tokens and makes structural judgments.
- Cards: **`low`** (content generation). Raise to `medium` only if an eval shows missed or shallow
  cards.
- Transcription: **`low`**, compared against `medium`. For dense images the skill notes that crop
  and zoom tools help more than higher effort.
- Pin effort per task. Changing it between requests invalidates the prompt cache.

**`max_tokens`:**

- Thinking counts toward `max_tokens`.
- The skill's default for non-streaming calls is about 16,000, which keeps calls under SDK HTTP
  timeouts.
- **Use 16,000 for both outline and cards** on 5.5 models, instead of 4096/8192
  (`TRACY_INTEGRATION.md:401`).
- On `stop_reason: "max_tokens"`, do not parse the JSON. Split the topic and retry.

**Request: structured outputs (preferred over a tool for pure JSON) [V]**

```http
POST https://api.anthropic.com/v1/messages
x-api-key: $ANTHROPIC_API_KEY
anthropic-version: 2023-06-01
anthropic-beta: server-side-fallback-2026-07-01        # only if `fallbacks` is sent (§2.6)
content-type: application/json

{
  "model": "claude-sonnet-5-5",
  "max_tokens": 16000,
  "fallbacks": "default",
  "output_config": {
    "effort": "medium",
    "format": { "type": "json_schema", "schema": OUTLINE_SCHEMA }
  },
  "system": "<prompts/surfaces/dualrep.md + task rules>",
  "messages": [
    { "role": "user", "content": "Build the topic outline for this source. Input JSON:\n{\"plan\":{...},\"chunks\":[{\"ref\":\"c1\",\"page\":1,\"text\":\"...\"}, ...]}" }
  ]
}
```

- There is no `temperature`, no `tools`, no `tool_choice` and no `thinking` field.
- Reading the reply: check `stop_reason` first. Then `content.find(b => b.type === "text").text` holds
  the JSON string. Ignore the `thinking` blocks, and the `fallback` block if one is present.
- The **strict-tool alternative** is equally valid: send `tools: [{name, description, strict: true,
  input_schema: {…, additionalProperties: false, required: [...]}}]` with `tool_choice` omitted
  (that is, `auto`). Tell the model to call the tool, and retry once if no `tool_use` block comes back.
  Structured outputs avoid that "no call" failure, so prefer them for these JSON-only tasks.

**Tracy, `@anthropic-ai/sdk` 0.32.1 (what is installed) [V]:** `resources/messages.js` posts `body`
unchanged (`this._client.post('/v1/messages', { body, ... })`). `resources/beta/messages/messages.js`
removes `betas` from the body and sends it as the `anthropic-beta` header. Per-request
`{ timeout, maxRetries, headers, signal }` options exist (`core.d.ts` `RequestOptions`). So
`output_config`, `strict`, `fallbacks`, URL sources and the new block types pass through at runtime,
even on 0.32.1. Tracy is plain JavaScript, so no types get in the way. A bump to 0.132.1 (npm latest,
2026-10-08) is still worth doing for typed `stop_details` and helpers. Sketch:

```js
const resp = await client.beta.messages.create(
  { betas: ["server-side-fallback-2026-07-01"], model: "claude-sonnet-5-5", max_tokens: 16000,
    fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system, messages: [{ role: "user", content: userText }] },
  { timeout: 90_000, maxRetries: 0 }, // stay inside the caller's 150 s Edge Function budget
);
if (resp.stop_reason === "refusal") throw refusalError(resp.stop_details);     // §2.7
if (resp.stop_reason === "max_tokens") throw httpError(502, "output truncated");
const out = JSON.parse(resp.content.find((b) => b.type === "text").text);
```

Two notes on that sketch:

- `client.beta.messages.create` goes around `withGroqFallback` (`src/server.js:689`), which wraps
  only `messages.create`. That is what DualRep wants (no Groq).
- The SDK default is a 10-minute timeout with 2 retries, so one call could last about 30 minutes.
  Always override it.

### 2.3 (b) The same on `claude-haiku-4-5`, and on `claude-haiku-5-5`

**`claude-haiku-4-5` [V]:**

- Structured outputs are supported.
- `temperature: 0` is still accepted.
- **`output_config.effort` returns an error on Haiku 4.5**, so do not send it.
- Thinking is off unless you send `{type:"enabled", budget_tokens:N}`. Leave it off for JSON.
- Forced `tool_choice` is accepted, so today's task lane works unchanged.
- No server-side fallback: there are no Haiku 4.5 entries in the fallback docs, so do not send
  `fallbacks` **[U]**.
- Context window 200K, max output 64K. A request with a PDF `document` is capped at 100 pages.

```json
{ "model": "claude-haiku-4-5", "max_tokens": 8192, "temperature": 0,
  "output_config": { "format": { "type": "json_schema", "schema": CARDS_SCHEMA } },
  "system": "...", "messages": [{ "role": "user", "content": "..." }] }
```

**`claude-haiku-5-5` [V]** (for the Phase 3 eval, and an option for cards):

- Any non-default `temperature`, `top_p` or `top_k` returns a 400. Prefill returns a 400.
- Thinking is adaptive and on by default. **Default effort is `medium`**; set it explicitly.
- **Never send `fallbacks`.** With `"default"` a decline stays declined, and a list of models
  returns a 400.
- Refusal categories: `cyber`, `bio`, `frontier_llm`, `general_harms`.
- Keep prompts at or under 100K tokens to stay on the $0.10 / $0.50 card.
- The skill warns that with thinking turned off, a JSON format combined with tools can skip a needed
  tool call. DualRep tasks use no tools, so this does not apply.

```json
{ "model": "claude-haiku-5-5", "max_tokens": 16000,
  "output_config": { "effort": "low", "format": { "type": "json_schema", "schema": CARDS_SCHEMA } },
  "system": "...", "messages": [{ "role": "user", "content": "..." }] }
```

**One code path for every model:** build the request from a per-model capability table:

| Capability | Sonnet 5.5 | Haiku 5.5 | Haiku 4.5 |
|---|---|---|---|
| Send `effort` | Yes | Yes | No |
| Send `temperature` | No | No | Optional |
| Send `fallbacks` | Yes | No | No |
| Structured outputs | Yes | Yes | Yes |

### 2.4 Structured-output schema rules, and suggested schemas

**Rules [V]:**

- Supported: `object, array, string, integer, number, boolean, null`, `enum`, `const`, `anyOf`,
  `allOf`, `$ref`/`$def`, and string formats including `uuid`.
- **`additionalProperties: false` is required on every object.**
- Not supported: recursion, numeric constraints (`minimum`, `maximum`, `multipleOf`), string length
  (`minLength`, `maxLength`), "complex array constraints", and `additionalProperties` other than
  false.
- The Python and TypeScript SDK helpers strip unsupported constraints and check them client-side.
  Tracy's dependency-free `aitasks.js` does not use them, so keep schemas within the supported subset
  and enforce the rest in `checkOutput`.
- New schemas pay a one-time compilation latency, then are cached for 24 hours.
- Structured outputs cannot be combined with citations (400).

**Design advice [U]:**

- **Use short chunk refs (`c1`…`cN`), not UUIDs.** The worker maps them back to
  `source_chunks.id`, and Tracy's validator rejects any ref that was not in the input. This saves
  roughly 20 output tokens per card and removes UUID-copying errors.
- **Do not ask the model for page numbers.** Take `cards.page` from the chunk the card cites, so a
  page can never be hallucinated. This meets "every card cites a page" by construction.

```jsonc
// OUTLINE_SCHEMA
{ "type": "object", "additionalProperties": false, "required": ["topics", "skipped_refs"],
  "properties": {
    "topics": { "type": "array", "items": { "type": "object", "additionalProperties": false,
      "required": ["title", "summary", "chunk_refs"],
      "properties": { "title": {"type":"string"}, "summary": {"type":"string"},
                      "chunk_refs": {"type":"array","items":{"type":"string"}} } } },
    "skipped_refs": { "type": "array", "items": {"type":"string"} } } }

// CARDS_SCHEMA — enums match DATA_MODEL.md cards.card_type and card_links.relation
{ "type": "object", "additionalProperties": false, "required": ["cards", "links"],
  "properties": {
    "cards": { "type": "array", "items": { "type": "object", "additionalProperties": false,
      "required": ["chunk_ref", "card_type", "question", "answer"],
      "properties": { "chunk_ref": {"type":"string"},
        "card_type": {"type":"string","enum":["basic","cloze","why","write_from_memory"]},
        "question": {"type":"string"}, "answer": {"type":"string"} } } },
    "links": { "type": "array", "items": { "type": "object", "additionalProperties": false,
      "required": ["from_index", "to_index", "relation"],
      "properties": { "from_index": {"type":"integer"}, "to_index": {"type":"integer"},
        "relation": {"type":"string","enum":["related","why","analogy","prerequisite","contrast"]} } } } } }
```

### 2.5 (c) Image by URL and PDF by URL

**Request shapes [V]:**

- `{"type":"image","source":{"type":"url","url":"https://…"}}` (`URLImageSource`)
- `{"type":"document","source":{"type":"url","url":"https://…"}}` (`URLPDFSource`)
- Base64 and Files API (`{"type":"file","file_id":…}`) are the alternatives.
- Put the image or document **before** the text block.
- On Amazon Bedrock and Google Cloud only base64 works. DualRep uses the Claude API, so URL sources
  are available.

**Image limits [V]:**

- Formats: JPEG, PNG, GIF, WebP.
- Up to **10 MB** (base64) per image on the Claude API, and up to 8000×8000 px.
- Up to 600 images per request (100 on 200k-context models such as Haiku 4.5).
- With more than 20 images in one request, each image must be at most **2000 px** per side.
- The whole request is capped at 32 MB.

**Image tokens [V]:** `ceil(w/28) × ceil(h/28)` visual tokens, capped per tier:

| Tier | Models | Max long edge | Max tokens per image |
|---|---|---|---|
| High-resolution | "Claude 4.7 and later" (includes Sonnet 5.5 and Haiku 5.5) | 2576 px | 4,784 |
| Standard | All other models (includes **Haiku 4.5**) | 1568 px | 1,568 |

Examples from the docs: 2000×1500 is 3,888 tokens on the high-resolution tier and 1,564 on the
standard tier (downsized to 1269×952). Oversized images are downscaled unless the block sets
`"transformations"` / `oversized_image: "error"`.

**PDF limits [V]:**

- **32 MB** per request.
- **600 pages** per request, or **100** when the request's context window is under 1M (so 100 on
  Haiku 4.5).
- Each page is sent both as extracted text (typically 1,500-3,000 tokens) **and** as an image, priced
  as above.
- "Dense PDFs … can fill the context window before reaching the page limit."

**Signed Supabase URL: [U]**

- Anthropic's servers fetch `url` sources. The docs say nothing about fetch timeouts, size caps,
  redirects or query-string-signed URLs.
- A Supabase signed URL (`…/storage/v1/object/sign/<bucket>/<path>?token=<jwt>`) is a public HTTPS
  GET with no extra headers, so it **should** work while the token is valid. This could not be
  verified without an API key.
- Generate the URL with an expiry of at least 10 minutes, to cover retries and the model's queue.
- Test once with a real key: a phone photo plus a 100-page PDF.
- If the URL fetch fails, fall back to base64. Tracy downloads the file and sends
  `source:{type:"base64", media_type, data}`.
- **Caveat:** today a 400 from the model call makes Tracy switch silently to Groq
  (TRACY_INTEGRATION §4). Turn that off for DualRep tasks before the first URL test.

**Bandwidth trade-off [U]:**

- **URL source:** Anthropic downloads directly from Supabase. That counts toward Supabase egress
  (5 GB free) and uses no Render bandwidth.
- **Base64 path:** Tracy downloads the file (Supabase egress) and then uploads it to Anthropic, which
  is Render outbound traffic (5 GB/month on Hobby, if it counts; §3).
- **Either way, resize photos on the device** to a long edge of about 2,000 px, JPEG quality around
  80 (roughly 0.3-0.7 MB instead of 3-5 MB for a 12 MP photo). That size is under the
  20-or-more-image rule's 2000 px limit, still high-resolution for the 5.5 models, and spares
  Supabase's 1 GB of free storage.

**Do not send the whole course PDF as a `document` [U]:**

- 100 pages × (about 2k text tokens + 1.6-4.8k image tokens) is about 360k-680k tokens per pass.
- That is about $0.72-$1.36 of input per pass on Sonnet 5.5, and above 100K on Haiku 5.5 (the 5× card).
- It does not fit Haiku 4.5's 200K window at all.
- Use per-page text extraction (TRACY_INTEGRATION §8, proposed `POST /ai/extract`). Use vision only
  for pages without a text layer and for photos of notes.

### 2.6 (d) Server-side fallbacks for Sonnet 5.5 **[V]**

- **Form:** the top-level body field `"fallbacks": "default"` plus the header
  **`anthropic-beta: server-side-fallback-2026-07-01`** (with the SDK, `betas:
  ["server-side-fallback-2026-07-01"]` on `client.beta.messages.create`).
  - For `claude-sonnet-5-5`, **only the `"default"` form** is accepted, and **only on the Claude
    API**.
  - The array form (`fallbacks: [{model}]`) uses a different header, `server-side-fallback-2026-06-01`.
    Sending either header with the other form returns a 400.
  - `fallbacks` is rejected on the Batches API.
- **What it retries:** on Sonnet 5.5 it retries **`cyber` and `frontier_llm`** declines on Claude
  Sonnet 5. It does **not** retry `bio`, `reasoning_extraction` or `general_harms`.
  - It acts only on policy declines. Rate limits, overloads and 5xx errors come back unchanged.
  - If the fallback model is itself rate-limited, you get the refusal with
    `stop_details.recommended_model`.
- **Reading the result:**
  - A `{"type":"fallback","from":{model},"to":{model}}` content block marks each switch.
  - `usage.iterations[]` holds a `fallback_message` entry when a fallback model served the reply.
  - Top-level `model` names the model that served it. **Store `response.model` in
    `tracy_events.model`.**
  - The **request with overrides merged in must be valid on the fallback model.** Sonnet 5 accepts
    `output_config.effort` and `format`, so DualRep's request is fine.
- **Billing:** each attempt is in `usage.iterations` (top-level `usage` covers only the final
  attempt). A decline before any output may or may not be billed, depending on the category, and
  counts against rate limits either way. Fallback attempts bill at the fallback model's rates.
- **Sticky routing:** after a fallback, later requests in the same conversation go to the fallback
  model for about an hour. DualRep's tasks are single-turn, so this does not matter.

### 2.7 (e) Handling `refusal`

**What a refusal looks like [V]:**

- HTTP **200** with `stop_reason: "refusal"`. Check it **before** reading `content`.
- `content` can be empty (declined before any output) or partial (declined mid-stream). Never parse
  partial JSON.
- `stop_details` = `{type:"refusal", category, explanation}`, and it **may be `null`**. Branch on
  `stop_reason`, not on `stop_details`.
- Sonnet 5.5 categories: `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`.
  Haiku 5.5 has the same set without `reasoning_extraction`. The skill says these classifiers are new compared with
  Haiku 4.5.
- With structured outputs, "If Claude refuses … the output may not match your schema".

**What DualRep should do [U]** (design):

| Situation | Tracy returns | DualRep worker |
|---|---|---|
| `refusal` after the server fallback (`cyber` / `frontier_llm` already retried) | Distinct error, for example `422 {ok:false, error:"refused", category}`, **not** 502. Today's code turns it into "model returned no tool_use block" (502), which the caller retries. | Do **not** retry the same request: it wastes money and rate limit. |
| `refusal`, category `bio` or `general_harms` (for example microbiology, pharmacology or toxicology courses) | Same | Retry **once** on a model without these classifiers, for example `claude-haiku-4-5` (temperature 0, no effort). If that also fails, mark the topic "couldn't generate" and keep the rest of the plan. |
| `refusal`, category `reasoning_extraction` | Same | A prompt bug: remove any "explain your reasoning in the output" instruction. |
| `stop_reason: "max_tokens"` | 502 "truncated" | Split the topic in two and requeue. |

Add `stop_reason` and `stop_details.category` to Tracy's metadata-only log line.

### 2.8 Anthropic rate limits and spend caps **[V]**

- **Start tier:** Sonnet 5.5, Haiku 5.5 and Haiku 4.5 each get **1,000 RPM, 2,000,000 ITPM and
  400,000 OTPM**. Cache reads do not count toward ITPM.
- "New organizations … may start in the Evaluation tier, with limits below the standard limits"
  **[U]** (no published numbers).
- **Monthly spend caps:** Start $500, Build $1,000, Scale $200,000. At the cap you get a 429 with
  `error.details.error_code: "enforced_spend_limit_reached"` and **no `retry-after`**. Do not retry
  it; mark the job `failed` with a clear error.
- DualRep shares Tracy's Anthropic organization, so its usage counts against Interverse's cap.
  Consider a separate **workspace** with its own spend limit for DualRep. Over a self-set limit the
  API returns `400 invalid_request_error` "You have reached your specified workspace API usage
  limits".

### 2.9 (f) Cost estimates **[U]** (method shown so it can be re-run with real `usage`)

**Assumptions:**

- 45,000 words ≈ **60k tokens** on Haiku 4.5's tokenizer, and **×1.3 ≈ 78k** on the newer tokenizer
  that Sonnet 5.5 and Haiku 5.5 use (pricing page: "approximately 30% more tokens").
- About 300 chunks of 900 characters, each wrapped as `{"ref":"c12","page":4,"text":…}` (about 12 /
  15 tokens of overhead each).
- A system prompt plus schema of about 2k / 2.5k tokens.
- An outline of 15 topics. Cards: one call per topic, about 350 cards in total, about 85 / 110 tokens
  per card.
- Thinking tokens (5.5 models only): about 4k for the outline at `medium`, about 1.5k per cards call
  at `low`. This is the most uncertain input; it can easily double.

| Stage | Tokens (Haiku 4.5) | Tokens (Sonnet 5.5 / Haiku 5.5) |
|---|---|---|
| Outline: input | ~66k | ~85k (under Haiku 5.5's 100K threshold, but a 120-page PDF would cross it) |
| Outline: output | ~1.3k | ~1.7k + ~4k thinking |
| Cards, 15 calls: input | ~113k | ~146k |
| Cards, 15 calls: output | ~30k | ~39k + ~22k thinking |
| **Total** | **~179k in / ~31k out** | **~231k in / ~67k out** |

**Outline plus cards for one 100-page course PDF:**

| Model | Input $ | Output $ | **Total** | Batch API (−50%) |
|---|---|---|---|---|
| Sonnet 5.5 | 231k × $2 = $0.46 | 67k × $10 = $0.67 | **≈ $1.13** (likely range $0.8-$1.8) | ≈ $0.57 |
| Haiku 5.5 | 231k × $0.10 = $0.023 | 67k × $0.50 = $0.033 | **≈ $0.06** | ≈ $0.03 |
| Haiku 4.5 | 179k × $1 = $0.18 | 31k × $5 = $0.16 | **≈ $0.34** | ≈ $0.17 |

Add about $0.012 for Gemini embeddings (paid tier).

**One handwritten page:** the photo is resized on the device to 2000×1500; the prompt is about 1.3k
tokens; the transcript is about 350 words.

| Model | Image tokens | Input | Output | **Total** |
|---|---|---|---|---|
| Sonnet 5.5 (high-res) | 3,888 | ~5.2k × $2 = $0.010 | ~0.7k + ~1.5k thinking = 2.2k × $10 = $0.022 | **≈ $0.03** (a 12 MP original costs about 4,784 image tokens, adding about $0.002) |
| Haiku 5.5 (high-res) | 3,888 | ~5.2k × $0.10 = $0.0005 | ~2.2k × $0.50 = $0.0011 | **≈ $0.002** |
| Haiku 4.5 (standard, downsized to 1269×952) | 1,564 | ~2.6k × $1 = $0.0026 | ~0.6k × $5 = $0.0029 | **≈ $0.006** (lower resolution: check legibility of small handwriting) |

**Takeaways:**

- On Haiku 5.5, a whole course costs about 6 cents. That makes "Haiku 5.5 for cards, Sonnet 5.5 only
  for the outline (and handwriting)" worth evaluating in Phase 2, not just Phase 3. A mixed run is
  about $0.25 + $0.06 ≈ **$0.30 per PDF**.
- A free-tier monthly cap of, say, 3 sources costs Interverse about $1-3 per active free user on
  Sonnet 5.5, and about $0.20 on Haiku 5.5 or a mixed setup.

### 2.10 Prompt caching (brief) **[V]**

- Cache order is `tools`, then `system`, then `messages`. Any change in the prefix invalidates
  everything after it. Up to 4 breakpoints. Top-level `cache_control: {type:"ephemeral"}` turns on
  automatic caching.
- **For the cards fan-out:** put a frozen system prompt (`dualrep.md` + card rules + schema) first,
  with `cache_control`. Then the outline. Then the topic's chunks.
  - With 15 calls started less than 5 minutes apart, the shared prefix is written once (1.25×) and
    read 14 times (0.05× on Sonnet 5.5).
  - The saving is small at about 4k tokens of shared prefix (about $0.10 per PDF on Sonnet 5.5
    **[U]**). It grows if each cards call also includes the full outline or neighbouring chunks
    for linking.
  - On Haiku 4.5, prefixes under 4,096 tokens are not cached at all.
- Changing `effort` or `thinking` between requests invalidates the cache, so pin them per task.
- Check `usage.cache_read_input_tokens` to confirm hits.

---

## 3. Render free tier (Tracy's host) **[S]**

The Render docs could not be fetched (proxy block). Every item below comes from search summaries of
`render.com/docs/free`, `/docs/outbound-bandwidth`, `/docs/faq` and community threads.

| Item | Value |
|---|---|
| Spin-down | After **15 minutes** with no inbound HTTP requests or WebSocket messages. Requests to `/robots.txt` do not wake it. |
| Spin-up | "**about one minute**". Browsers see a loading page. |
| What an API client sees while it wakes | Not documented. Community reports describe both a held request that succeeds after about a minute, and **503** "Service not ready" or timeouts **[U]**. Plan for both. |
| Free instance hours | **750 per workspace per calendar month**, shared by all free services. A spun-down service uses none. When they run out, **all free web services are suspended** until the next month. One always-awake service uses up to 744 hours. |
| Outbound bandwidth (Hobby) | **5 GB/month** included, then $0.15/GB. With no payment method, services spin down until the next month. Whether Tracy's calls to Anthropic count as outbound bandwidth: **[U]** (probably yes). |
| HTTP request duration | Up to about **100 minutes** for web services (Render comparison page). Not confirmed for free instances **[U]**. Not the limit that matters here; Supabase's 150 s is. |
| Other | Local filesystem lost on spin-down. Outbound SMTP ports 25, 465 and 587 blocked. Hobby: 1 member, 25 services. A "keep-alive" cron ping to stop spin-down was called **abuse** by Render staff on the community forum. Paid instances never spin down (price not checked) **[U]**. |

Tracy's actual plan is still unknown (TRACY_INTEGRATION §12). Its boot maintenance (re-embed and
brain sync) runs **off** the request path (`src/server.js:717-740`), so a cold start should cost
only Node start-up plus Render's own spin-up.

**What this means for `tracy-worker`** (design **[U]**):

1. **Wake check first.** `GET ${TRACY_URL}/health` (exists at `src/server.js:414`) with
   `AbortSignal.timeout(5_000)`.
   - If it answers 200, go ahead.
   - If it times out or returns 502/503/504, the request itself has started the spin-up. Put the job
     back to `queued` with `locked_at = null`, **without** counting an attempt, and exit.
   - The next `pg_cron` tick, 60 s later, normally finds Tracy awake. This uses no Edge Function wall
     clock waiting and costs one extra invocation.
2. **Retry classifier for each Tracy call:**
   - If the response body parses as Tracy JSON (`{ok:false,error}`), follow the status table in
     TRACY_INTEGRATION §4.
   - Otherwise (HTML, empty body, connection reset, or a 502/503/504 that is not JSON) it is
     infrastructure. Back off 2 s, 4 s, then 8 s, with total sleep capped at about 30 s, then
     requeue.
3. **Time budget inside the 150 s Free wall clock:**
   - Tracy's Anthropic call: `timeout: 90_000, maxRetries: 0`.
   - The worker's fetch to Tracy: `AbortSignal.timeout(110_000)`.
   - One Tracy call per invocation for the long steps (outline, then each topic's cards).
   - Use `EdgeRuntime.waitUntil()` so the `pg_net` caller gets a 202 immediately. pg_net is
     fire-and-forget **[U]**: confirm its default timeout does not cancel the function.
4. **Latency risk [U]:** a cards call producing about 4k visible tokens plus about 1.5k thinking
   could take 60-120 s at unmeasured throughput. Keep topics small (about 20-25 cards per call), and
   measure.
   - If calls approach 100 s, either move cards to the **Message Batches API** (50% off,
     asynchronous; the worker submits on one tick and collects on a later tick; but `fallbacks`
     cannot be used there), or move to Supabase Pro (400 s wall clock).
5. **Phase 3's 3-second planner gate cannot be met against a sleeping free instance.** The default
   circuit already covers this. Note it in the Phase 3 decisions.

---

## 4. Supabase Free plan quotas and pgvector capacity

Source: Supabase docs **source** on GitHub `master`, fetched today (`supabase.com` itself is blocked):
`apps/docs/content/guides/functions/limits.mdx`,
`guides/platform/billing-on-supabase.mdx`,
`guides/platform/manage-your-usage/{edge-function-invocations,egress,storage-size,disk-size}.mdx`,
`guides/platform/database-size.mdx`, `guides/storage/uploads/file-limits.mdx`,
`guides/platform/free-project-pausing.mdx`, and `_partials/billing/pricing/*`. All **[V]** against
that source. The live pricing page could not be compared.

| Quota | Free | Pro ($25/mo) | Notes for DualRep |
|---|---|---|---|
| Edge Function invocations | **500,000 / month** | 2M included, then $2 per 1M | Billed whatever the status code; OPTIONS preflights are free. `pg_cron` every minute is 43,200 a month (about 9%). |
| Edge Function runtime | 150 s wall clock, **2 s CPU** per request, 256 MB, 150 s idle timeout (504) | 400 s wall clock | 100 functions per project (Free). 100 secrets, each at most 48 KiB. No outbound ports 25 or 587. |
| Database size | **500 MB per project**, then **read-only** (SQLSTATE `25006`). The organization can also get a Fair Use restriction (HTTP **402**). | 8 GB disk per project, then $0.125/GB | A new project already uses about 40-60 MB. |
| Storage size | **1 GB** (organization-wide) | 100 GB, then $0.021/GB | Photos dominate; resize on the device. |
| Max upload file size | **50 MB** global cap | Up to 500 GB | Course PDFs above 50 MB are rejected. Set a per-bucket limit plus `allowed_mime_types`. |
| Egress | **5 GB uncached + 5 GB cached** | 250 GB + 250 GB, then $0.09 / $0.03 per GB | Downloads of PDFs and photos by Tracy or Anthropic count. |
| Monthly active users | 50,000 | 100,000 | |
| Realtime | 2M messages, 200 peak connections | 5M, 500 | |
| Projects | 2 active free projects per owner/admin | | |
| Pausing | Paused after low "user database activity" over 7 days; warning email about a week before; can be restored for up to 1 year | Never paused | `pg_cron` jobs probably do not count as "user" activity **[U]**. A beta with real users keeps it active. |

### pgvector storage per chunk

**Facts [V]:**

- pgvector README: "Each vector takes `4 * dimensions + 8` bytes", so `vector(1536)` = **6,152 B**.
  `halfvec(1536)` = **3,080 B**.
- `vector` and `halfvec` are declared `STORAGE = external` in `sql/vector.sql`. Values over about
  2 KB are TOASTed out of line, uncompressed.
- HNSW supports `vector` up to 2,000 dimensions and `halfvec` up to 4,000.
- With HNSW, filtering happens **after** the index scan. "If a condition matches 10% of rows … only
  4 rows will match on average" unless `SET hnsw.iterative_scan = strict_order | relaxed_order`
  (0.8.0+).

**Derived per-row estimate [U]** (measure with the SQL below):

| Part | `vector(1536)` + HNSW (current migration) | `vector(1536)`, no HNSW | `halfvec(1536)` + HNSW | `halfvec(1536)`, no HNSW |
|---|---|---|---|---|
| Heap row (about 900 chars of content, 4 uuids, page, timestamps, `embed_model`, TOAST pointer) | ~1.1 KB | ~1.1 KB | ~1.1 KB | ~1.1 KB |
| TOAST (vector + chunk headers) | ~6.3 KB | ~6.3 KB | ~3.2 KB | ~3.2 KB |
| HNSW (an element of about 6.2 KB plus neighbor lists, so about one element per 8 KB page) | ~8 KB | 0 | ~4 KB | 0 |
| B-tree indexes (pkey, source_id, owner_id, group_id) | ~0.2 KB | ~0.2 KB | ~0.2 KB | ~0.2 KB |
| **Total per chunk** | **~15.6 KB** | **~7.6 KB** | **~8.5 KB** | **~4.5 KB** |
| **Chunks in ~400 MB** (500 MB minus the ~50 MB baseline and other tables) | **~25,000** | ~52,000 | ~47,000 | ~88,000 |
| 100-page PDFs (~300 chunks each) | **~85** | ~175 | ~155 | ~290 |

**Recommendations [U]:**

- The `source_chunks` table is empty today, so a Phase 2 migration can change it cheaply.
  1. Switch to `embedding extensions.halfvec(1536)` (pgvector reports little recall loss at half
     precision).
  2. Reconsider the **global** HNSW index. Retrieval is always filtered to one source or plan (a few
     hundred to a few thousand rows). An exact scan after the B-tree filter on `source_id` is fast and
     exactly right, while a global HNSW index with post-filtering loses recall unless iterative scans
     are on. Add HNSW back later (with `hnsw.iterative_scan`) only if cross-plan search appears.
- Either change is a short migration. It fits in one SQL Editor paste: drop the index, then
  `alter table ... alter column embedding type extensions.halfvec(1536)`.

**Measure after the first real PDF:**

```sql
select count(*) as chunks,
  pg_size_pretty(pg_relation_size('public.source_chunks')) as heap,
  pg_size_pretty(pg_total_relation_size('public.source_chunks')
                 - pg_relation_size('public.source_chunks')
                 - pg_indexes_size('public.source_chunks')) as toast,
  pg_size_pretty(pg_relation_size('public.source_chunks_embedding_idx')) as hnsw,
  pg_size_pretty(pg_total_relation_size('public.source_chunks')) as total,
  pg_size_pretty(pg_database_size(current_database())) as whole_db
from public.source_chunks;
```

---

## 5. Corrections and additions to existing DualRep docs

| Where | Current text | Correction |
|---|---|---|
| `TRACY_INTEGRATION.md:343-353` (§8) | Call `embedContent` with `outputDimensionality: 1536` | Also: `gemini-embedding-2` **ignores `taskType`/`title`**, so use text prefixes (§1.4); call `batchEmbedContents` with up to 100 requests and one `content` per chunk; L2-normalize; header `x-goog-api-key`; put the prefix scheme in `embed_model` (`gemini-embedding-2@1536#p1`). |
| `TRACY_INTEGRATION.md:401` (§10, change 1) | `max_tokens` outline 4096, cards 8192 | On 5.5 models thinking counts toward `max_tokens`. Use **16000** for outline, cards and (Sonnet) transcription. Keep 4096-8192 only on Haiku 4.5. |
| `TRACY_INTEGRATION.md:159-162` | Edge Function → Tracy `AbortSignal.timeout(8_000)` | Fine for the sync grader. Queued study-builder calls need about 110 s, a `/health` wake check, and a 90 s Anthropic timeout with `maxRetries: 0` in Tracy (§3). |
| `TRACY_INTEGRATION.md:279-285` (§6 limits) | "verify on the current limits page" | Verified against the docs source on `master` today: 150 s / 400 s, 2 s CPU, 256 MB, 150 s idle → 504. Render: 15 min idle, about 1 min to wake, 750 hours per workspace, 5 GB bandwidth on Hobby. |
| `TRACY_INTEGRATION.md:321` (§7) | "Send images as short-lived signed Storage URLs" | Works in principle for Anthropic `url` sources, but the signed-URL fetch is **[U]**. Use an expiry of at least 10 minutes, fall back to base64, and turn off the Groq-on-400 behaviour first. |
| `TRACY_INTEGRATION.md:466` (§12) | 001 "died 2026-07-14" (per Tracy's comment) | The current deprecations table shows a **2028-05-14** shutdown **[S]**. Tracy's `src/embeddings.js:9` comment is out of date. |
| ROADMAP Phase 2 decisions (`ROADMAP.md:321-325`) | "Gemini API key and project owned by DualRep" | Decide **paid tier (billing on) from day one** for privacy (§1.7). |
| ROADMAP Phase 2 decisions | "Models for the strong tasks" | Add: Haiku 5.5 for cards is about 20 times cheaper than Sonnet 5.5; evaluate it in Phase 2. Refusal path for `bio` and `general_harms` (§2.7). |
| `EXECUTION_PLAN.md` | "Claude Haiku 4.5 for the transition planner…" | Haiku 4.5 works on today's lane. Note it has no `effort`, a 200K context, and the standard 1568 px image tier. |

---

## 6. Open risks and unverified items

1. **[U]** Whether Anthropic's URL fetch accepts Supabase signed URLs, and its size and timeout
   limits. Test with a real key; fall back to base64.
2. **[U]** Real thinking-token volume, and so the latency and cost of Sonnet 5.5 outline and cards
   calls. The estimate could be off by about 2×. The per-call latency against the 150 s Free Edge
   Function wall clock is the main design risk. Measure on one real course PDF before fixing topic
   sizes.
3. **[U]** `bio` and `general_harms` false positives on legitimate course material (biology,
   medicine, chemistry, security). The server fallback does not cover them. DualRep needs the
   client-side retry and a "topic skipped" UX.
4. **[S]/[U]** Gemini free-tier rate limits are unknown; check them in AI Studio. Free-tier data use
   is a privacy problem, so enable billing.
5. **[U]** Supabase Free's 500 MB holds only about 85 course PDFs in total at the current
   `vector(1536)` + HNSW layout. Decide on halfvec and dropping the index **before** the first real
   data. Watch the 1 GB storage quota for photos.
6. **[U]** What a non-browser client receives while Render wakes (a held request or a 503). The
   worker design above handles both. Render's 5 GB outbound bandwidth could matter if Tracy
   base64-uploads many photos.
7. **[S]** All Gemini facts (model status, the 8,192-token limit, normalization, prefixes, prices,
   terms) and all Render facts came through search summaries, because the sandbox blocked the source
   domains. Spot-check `ai.google.dev/gemini-api/docs/embeddings`, `/pricing`, `/rate-limits`,
   `/terms` and `render.com/docs/free` from the Windows PC before relying on them.
8. Tracy's deployed settings (Render plan, `GROQ_API_KEY`, `TRACY_TASK_MODEL`) are still unknown
   (TRACY_INTEGRATION §12).

## Sources

- Anthropic, fetched today: https://platform.claude.com/docs/en/about-claude/pricing ·
  https://platform.claude.com/docs/en/build-with-claude/vision ·
  https://platform.claude.com/docs/en/build-with-claude/pdf-support ·
  https://platform.claude.com/docs/en/api/rate-limits · https://platform.claude.com/docs/en/api/messages/create (schema
  for `URLImageSource` / `URLPDFSource`, `output_config`).
- `claude-api` skill 2.1.295: `shared/model-migration.md` (Sonnet 5.5 and Haiku 5.5 sections, the
  Claude Fable 5.1 refusal section, the Claude Opus 5 fallbacks section), `shared/tool-use-concepts.md`
  § Structured Outputs, `typescript/claude-api/tool-use.md`, `shared/prompt-caching.md`.
- `@anthropic-ai/sdk` 0.32.1 tarball (`resources/messages.js`, `resources/beta/messages/messages.js`,
  `core.d.ts`). npm latest is 0.132.1.
- Gemini: REST discovery document `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`
  (revision 20261008), `@google/genai` 2.28.0 tarball (`dist/index.mjs`, `dist/genai.d.ts`). Search
  summaries of https://ai.google.dev/gemini-api/docs/embeddings ·
  https://ai.google.dev/gemini-api/docs/deprecations · https://ai.google.dev/gemini-api/docs/pricing ·
  https://ai.google.dev/gemini-api/docs/rate-limits · https://ai.google.dev/gemini-api/terms_preview ·
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2 ·
  https://github.com/run-llama/llama_index/issues/21535 · https://github.com/openclaw/openclaw/issues/134015
- Render (search summaries): https://render.com/docs/free · https://render.com/docs/outbound-bandwidth ·
  https://render.com/docs/faq · https://render.com/docs/render-vs-heroku-comparison ·
  https://community.render.com/t/does-my-application-web-service-get-rate-limited/22445
- Supabase docs source (raw GitHub, `supabase/supabase@master`): the files listed in §4.
- pgvector: https://raw.githubusercontent.com/pgvector/pgvector/master/README.md and `sql/vector.sql`.
