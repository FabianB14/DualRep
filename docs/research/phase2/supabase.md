# Phase 2 research: Supabase infrastructure (track `supabase`)

*Researched 2026-10-09. Read-only: neither repo was changed and nothing was committed. Drafts and
evidence are in `scratchpad/phase2-research/scratch/`.*

## How this was checked

`supabase.com` and `docs.powersync.com` are blocked by this sandbox's egress proxy, so "official docs"
means the **source** of those sites, cloned from GitHub:

| Source | Revision | Used for |
|---|---|---|
| `supabase/supabase` `apps/docs/content/**` (+ `apps/docs/spec/api_v1_openapi.json`) | `1ee88e0`, 2026-10-08 | Edge Functions, Storage, Cron, pg_net, Vault, connection strings, limits, Management API |
| `supabase/cli` at tag **v2.119.0** (the version pinned in `.github/workflows/ci.yml:59`) | `3cb948c`, 2026-09-30 | `db push`, `migration repair/list`, `db query`, `functions deploy`, `secrets set` |
| Supabase CLI **2.119.0 release binary**, run locally (`checksums.txt` sha256 matched) | – | `--help` output and flag parsing for every command in the workflow |
| `supabase/storage` `migrations/tenant/*` | `db42280`, 2026-10-08 | `storage.buckets/objects` columns, `foldername()`, grants, the delete guard |
| `supabase/vault` `sql/supabase_vault--0.3.0.sql` | HEAD | Vault table, view and function signatures |
| `supabase/postgres` `ansible/files/postgresql_config/supautils.conf.j2` | `develop` | Which Supabase-owned tables `postgres` may put policies on |
| `supabase/edge-runtime` v1.77.1 `deno/Cargo.toml` | tag | The Deno version in the CLI's local runtime |
| `powersync-ja/powersync-docs` | `9be8d90`, 2026-10-08 | Schema changes and redeploys |
| npm: `@supabase/server@1.9.1`, `expo-file-system@57.0.7`; installed `@supabase/*@2.117.3` | – | Signatures |

On top of reading, **the draft SQL in this report was run.** A scratch copy of `scripts/db-test.sh`,
the stubs, the two migrations and all 14 test files was run against local Postgres 16.15 (with pgvector
0.6.0 and pgTAP). The draft stubs, the draft migration and a new draft test file were added, and the
existing tests were patched where the draft needs it (section 6). All **15 files and 568 tests pass**,
and `supabase/schema.snapshot.json` comes out byte-identical.

Not run: the real Supabase image (`supabase db start`; there is no Docker daemon here) and the hosted
project. Anything that depends on them is marked **unverified**.

---

## 0. Summary

1. **Edge Functions (Free plan).** Limits: 150 s wall clock, 2 s CPU per request, 256 MB of memory,
   500,000 invocations a month and 100 functions. The platform's `verify_jwt` check also accepts the
   publishable key, which ships inside the APK. So **a user-facing function must verify the user's
   JWT in code**; the gateway check alone is not enough.
2. **Deploying needs no Docker and no database password.** CLI 2.119 is a TypeScript rewrite. Given
   `SUPABASE_ACCESS_TOKEN` and `--project-ref`, `db push` and `migration repair` do two things on
   their own:
   - they mint a temporary login role through the Management API;
   - when the IPv6-only direct host can't be reached, as on GitHub's runners, they fall back to the
     session pooler (port 5432).

   `db query --linked` runs SQL through the Management API with no database connection at all.
   `functions deploy --use-api` bundles on Supabase's side.
3. **Hand-applied migrations can be detected safely.** The workflow runs `migration repair` only when
   both of these hold:
   - the remote migration history is empty;
   - `public.tracy_events` exists, plus 90 starter exercises for the second version.
4. **The cron secret lives in Vault.** pg_cron and pg_net run every minute, but call the worker only
   when work is queued, with a secret read from Vault. `[db.vault]` in `config.toml` is **not** a
   rotation tool: the CLI writes it only when `db push` has pending migrations. So the workflow
   rotates through the Management API query endpoint, passing the secret as a bind parameter.
5. **Storage files can't be deleted with SQL.** `storage.protect_delete()` refuses SQL deletes on
   `storage.objects`, and such a delete would orphan the file anyway. Removal must go through the
   Storage API, so a sweep in the worker removes orphaned files. React Native uploads must pass an
   `ArrayBuffer` **and** an explicit `contentType`. The default is `text/plain;charset=UTF-8`, which the
   bucket's MIME allow-list would refuse.
6. **Security gap to close.** The worker downloads `source_files.storage_path` with the secret key. A
   user could point that column at someone else's file. Fix: a CHECK that the path starts with
   `<owner_id>/<source_id>/`. It is tested, and costs 5 fixture edits.
7. **PowerSync: probably nothing to redeploy.** Phase 2's server outputs (`sources.status`,
   `source_files.transcript`, `topics`, `cards`, `tracy_events.status/error`) are already synced. The
   draft migration adds no public table or column, and the snapshot is unchanged.

---

## 1. Edge Functions today

### 1.1 Runtime and limits

From `guides/functions/limits.mdx` and `troubleshooting/edge-function-wall-clock-time-limit-reached-Nk38bW.mdx`.

| Limit | Free | Paid | Note |
|---|---|---|---|
| Wall clock (worker lifetime) | **150 s** | 400 s | Background work in `EdgeRuntime.waitUntil()` counts toward it. A worker shut down this way logs 546 |
| Request idle timeout | 150 s | 150 s | No response by then → **504** |
| CPU time | **2 s per request** | 2 s | Async I/O does not count, so parsing PDFs here is out (TRACY_INTEGRATION §8 agrees) |
| Memory | 256 MB | 256 MB | |
| Function size | 20 MB bundled by the CLI with Docker; **5 MB bundled server-side** (`--use-api`, Dashboard) | same | Keep dependencies small. Call Gemini with `fetch`, not `@google/genai` (**the size of the SDK bundle is unverified**) |
| Functions per project | 100 | 1,000 (Pro) | |
| Nested or recursive calls | 30 requests per trace within 60 s | | Don't chain worker → worker. pg_cron re-kicks every minute instead |
| Secrets | 100 per project, 48 KiB each, names may not start with `SUPABASE_` | | |
| Outbound ports | 25 and 587 blocked | | |
| Not available | Web Workers, Node `vm`, multithreaded native libraries (sharp, libvips) | | |
| Request and response body size | **not documented** on the limits page | | **unverified**. Uploads go to Storage directly, never through a function |
| Invocations | **500,000 a month** on Free; 2 million on Pro and Team, then $2 per million | | `_partials/billing/pricing/pricing_edge_functions.mdx` |

**Deno version: unverified for the hosted runtime.** The evidence:

- `guides/functions/wasm.mdx:113` still says "Deno 1.46", which looks stale.
- CLI 2.119's config template sets `[edge_runtime] deno_version = 2`
  (`apps/cli-go/pkg/config/templates/config.toml:384`); the CLI rejects anything but 1 or 2
  (`config.go:1219`).
- Its local image is `supabase/edge-runtime:v1.77.1` (`packages/stack/src/Artifacts.ts:289`), whose
  embedded `deno` crate is **2.1.4** (`deno/Cargo.toml`).

Write for Deno 2.1: `Deno.serve`, `npm:`/`jsr:` specifiers, `EdgeRuntime.waitUntil`.

Free-plan neighbours that matter for Phase 2:

- **Storage:** 1 GB (`pricing_storage_size.mdx`), a 50 MB maximum file size (`uploads/file-limits.mdx`),
  and 5 GB uncached plus 5 GB cached egress (`manage-your-usage/egress.mdx`).
- **Database:** 500 MB, after which the project goes read-only (`platform/database-size.mdx:110`).
- **Pausing:** a Free project is paused after a week of low "user database activity"
  (`platform/free-project-pausing.mdx`). Whether pg_cron runs count as activity is **unverified**.

### 1.2 `verify_jwt` and `config.toml`

- It is set per function, as `[functions.<slug>] verify_jwt = true|false`
  (`guides/functions/function-configuration.mdx`, `auth-headers.mdx`). The default is `true`.
  `supabase functions deploy --no-verify-jwt` overrides it for that deploy.
- **What the check accepts** (`auth-headers.mdx`): legacy HS256 JWTs, JWTs signed with the asymmetric
  keys, and also *"for migration compatibility, `verify_jwt` accepts publishable and secret keys on
  either header … The check alone doesn't authenticate a caller that sends only an API key."* The
  publishable key is in every APK, so **`verify_jwt = true` is not authentication**. The handler
  must verify the user JWT itself (1.3).
- **What deploy sends** (CLI source, `shared/functions/deploy.ts:1155` and `:1994-1997`):
  - if `config.toml` sets `verify_jwt`, that value;
  - otherwise the value the deployed function already has;
  - for a new function, the platform default (`true`).

  So always write it out per function.
- **Which folders deploy picks up** (`deploy.ts:1915-1950`): only folders named
  `^[A-Za-z][A-Za-z0-9_-]*$` that contain an `index.ts`. `_shared` is therefore never deployed as a
  function. A plain `supabase functions deploy` deploys every such folder.

Proposed additions to `supabase/config.toml`. Today it has no `[edge_runtime]` and no `[functions.*]`
sections; adding them also documents the intent.

```toml
[edge_runtime]
enabled = true
# Deno major version for `supabase functions serve` and Docker bundling (CLI 2.119 accepts 1 or 2).
deno_version = 2

# Called by pg_cron through pg_net with the x-dualrep-worker-secret header, never with a user JWT.
[functions.tracy-worker]
verify_jwt = false

# Called from the app with supabase.functions.invoke (user JWT). The handler verifies the JWT itself.
[functions.study-request]
verify_jwt = true
```

The function names are proposals. Another track may choose different ones.

### 1.3 Verifying the caller, then acting with the secret key

**Option A (current docs, `guides/functions/auth.mdx`):** `npm:@supabase/server`. 1.9.1 is the latest
on npm, published 2026-10-05.

```ts
import { withSupabase } from 'npm:@supabase/server@1.9.1'

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    // ctx.userClaims.id: the verified caller (checked against the project's JWKS).
    // ctx.supabase: RLS-scoped to the caller. ctx.supabaseAdmin: the `default` secret key (bypasses RLS).
    const { source_id } = await req.json()
    const { data: src } = await ctx.supabase.from('sources').select('id').eq('id', source_id).maybeSingle()
    if (!src) return Response.json({ error: 'not_found' }, { status: 404 }) // RLS decided
    const { data, error } = await ctx.supabaseAdmin.rpc('enqueue_tracy_event', {
      p_user_id: ctx.userClaims!.id, p_job: 'study_builder', p_input: { source_id },
      p_free_limit: Number(Deno.env.get('DUALREP_CAP_FREE_STUDY') ?? 5),
      p_paid_limit: Number(Deno.env.get('DUALREP_CAP_PAID_STUDY') ?? 50),
    })
    if (error?.hint === 'dualrep_cap_reached') return Response.json({ error: 'cap' }, { status: 429 })
    if (error) throw error
    return Response.json({ event_id: data.id }, { status: 202 })
  }),
}
```

- The modes are `'user'`, `'secret'`, `'secret:<name>'`, `'secret:*'`, `'publishable[:name]'` and
  `'none'`. An array tries them in order.
- **Requirement:** `@supabase/server` only accepts the new API keys and **asymmetric** JWT signing
  keys. It rejects HS256 user tokens, which have no `kid` (`docs/auth-modes.md:231-234` in the
  package).
- SETUP.md §6 asks the founder to check which kind of key the project uses. The result is not
  recorded anywhere. **unverified**

**Option B (works with HS256 too):** plain supabase-js 2.117.3.
`supabase.auth.getClaims(jwt?, { allowExpired?, jwks? })` (`auth-js` `GoTrueClient.d.ts:2563`)
verifies locally against the JWKS for asymmetric keys. For a symmetric secret it falls back to a
request to the Auth server.

```ts
import { createClient } from 'npm:@supabase/supabase-js@2.117.3'
const url = Deno.env.get('SUPABASE_URL')!
const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default
  ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!          // legacy fallback
const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}').default
  ?? Deno.env.get('SUPABASE_ANON_KEY')!
Deno.serve(async (req) => {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '')
  const anon = createClient(url, publishable, { auth: { persistSession: false } })
  const { data: claims, error } = await anon.auth.getClaims(jwt)
  if (error || !claims || claims.claims.role !== 'authenticated') return new Response('unauthorized', { status: 401 })
  const userId = claims.claims.sub
  const asUser = createClient(url, publishable, { global: { headers: { Authorization: `Bearer ${jwt}` } },
                                                 auth: { persistSession: false } })   // RLS as the caller
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  // ...
})
```

`supabase.functions.invoke()` sends the session JWT in `Authorization` and the publishable key in
`apikey` (`auth-headers.mdx`), so the app needs no extra code. The admin client must always filter by
the verified `userId`.

### 1.4 Environment variables injected

From `guides/functions/secrets.mdx`, the "Default secrets" table.

| Variable | Value |
|---|---|
| `SUPABASE_URL` | API gateway URL |
| `SUPABASE_DB_URL` | Postgres URL for a direct connection (not needed here: use PostgREST RPC) |
| `SUPABASE_PUBLISHABLE_KEYS` | **JSON dictionary** `{"default":"sb_publishable_…", …}` |
| `SUPABASE_SECRET_KEYS` | **JSON dictionary** `{"default":"sb_secret_…", …}`; bypasses RLS |
| `SUPABASE_JWKS` | The project's JWKS, the same as `/auth/v1/.well-known/jwks.json` |
| Legacy: `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | JWT-style keys, still provided |
| Hosted only: `SB_REGION`, `SB_EXECUTION_ID`, `DENO_DEPLOYMENT_ID` | |

Your own secrets: `supabase secrets set NAME=value` or `--env-file`. *"Your functions read a new secret
immediately, so you don't need to redeploy."* Changing them needs the Owner or Administrator role.

### 1.5 Imports and shared code

- **Imports:**
  - `npm:pkg@x.y.z` is recommended;
  - `jsr:@std/path@1.0.8` and `node:` built-ins also work;
  - a per-function `deno.json` with `"imports"` is "recommended for deployment";
  - a global `supabase/functions/deno.json` is discouraged (`guides/functions/dependencies.mdx`).
- **Shared code:** a folder starting with `_` (`supabase/functions/_shared/…`), imported relatively
  (`guides/functions/development-tips.mdx`). With API deploys, imports outside the workdir but inside
  the git root are still uploaded (`functions/deploy/SIDE_EFFECTS.md`, "Notes"). Use full `npm:`
  specifiers inside `_shared`, so they don't depend on each function's import map.
- **Repo gotchas:**
  - `tsconfig.json` has `"include": ["**/*.ts", …]`, so `npm run typecheck` would type-check the Deno
    code and fail on `Deno` and `npm:`. Add
    `"exclude": ["node_modules", "supabase/functions"]`.
  - ESLint already ignores `supabase/functions/*` (`eslint.config.js`).
  - Jest's `testPathIgnorePatterns` doesn't cover the folder. Name Deno tests `*_test.ts`, not
    `*.test.ts`, or add the folder to the ignore list.

---

## 2. Deploying from GitHub Actions (no Docker, IPv4-only runners)

### 2.1 What CLI 2.119.0 actually does

The release archive has two binaries, `supabase` (TypeScript) and `supabase-go`. The commands below
are native TypeScript ports.

| Command | Verified behaviour |
|---|---|
| `supabase functions deploy [names] --project-ref <ref> --use-api` | Docker bundling is the default (a hidden `--use-docker`). `--use-api` bundles on Supabase's side, and a stopped Docker daemon also falls back to the API. Calls `POST /v1/projects/{ref}/functions/deploy`. Needs only `SUPABASE_ACCESS_TOKEN`, no link. `--prune` deletes remote functions that are missing locally. Static files can't be deployed with `--use-api` (`limits.mdx`). |
| `supabase secrets set --project-ref <ref> [--env-file f] [NAME=VALUE…]` | Management API `POST /v1/projects/{ref}/secrets` |
| `supabase db push --project-ref <ref> [--dry-run] [--yes]` | **Linked path**, `db-config.layer.ts:296-389`. (1) Tries the direct host `db.<ref>.supabase.co:5432`. (2) If unreachable, which is the case on IPv4-only runners, it gets the pooler settings from the Management API and **forces port 5432, the session pooler** (`db-config.parse.ts:416-421`). (3) With no password (`--password` / `SUPABASE_DB_PASSWORD`), it mints a temporary role through `POST /v1/projects/{ref}/cli/login-role` (`initLoginRole`, `:108-121`), retrying up to 9 times and clearing network bans. It runs `SET SESSION ROLE postgres` around each migration, so new objects are owned by `postgres` and the PowerSync role's default privileges apply. Each migration and its history row is written in one batch. `--project-ref` never implies `--db-url`. |
| `supabase db push --db-url <uri>` | Alternative: a percent-encoded URI, with no Management API involved |
| `supabase migration list --project-ref <ref> --output-format json` | stdout is `{"migrations":[{"local","remote","time"}],"message":"Migrations listed"}`. A missing history table gives empty `remote` values. |
| `supabase migration repair <v…> --status applied --project-ref <ref>` | Creates the history table if missing, then upserts each version from the **local file** (name and statements) in one transaction. Repair-all, with no versions, prompts and defaults to **No**. |
| `supabase db query --linked --project-ref <ref> --agent no -o json "<sql>"` | Runs through `POST /v1/projects/{ref}/database/query` with **no database connection**. Prints a plain JSON array of rows. `--project-ref` without `--linked` is an error. |

Flag parsing for all of the above was checked against the real 2.119.0 binary. Every command reached
"Access token not provided", so no flag was rejected.

The CLI loads **and validates the whole `supabase/config.toml`** on every one of these commands.
Without `supabase/templates/*.html` it failed with `Invalid config for
auth.email.template.magic_link.content_path`. So the workflow must check out the full repository.

**Session pooler URI** (for `--db-url`, or psql). From `guides/database/connecting-to-postgres.mdx`
lines 72, 129-140:

```
postgresql://postgres.<PROJECT_REF>:<PERCENT-ENCODED-DB-PASSWORD>@aws-<INDEX>-<REGION>.pooler.supabase.com:5432/postgres
```

- The shared pooler is IPv4 on every plan.
- The user is `postgres.<ref>`.
- Port 5432 is session mode; 6543 is transaction mode, which has no prepared statements.
- Copy the exact host from Dashboard → Connect → "Session pooler".
- GitHub Actions is on Supabase's list of IPv4-only platforms
  (`troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP.mdx:37`).

**Recommendation:** use `--project-ref` with the access token only. It needs no database password in
GitHub. Keep `--db-url` with a `SUPABASE_DB_URL` GitHub secret as the fallback if minting the
temporary role fails. That path has never been run against DualRep's project, so the first run uses
`--dry-run`: **unverified**.

### 2.2 The migrations applied by hand

The hosted project ran `20261008000000` and `20261008120000` through the SQL Editor, the second as 7
pasted parts (SETUP.md §5 Option 1, §16 step 1). So `supabase_migrations.schema_migrations` is
missing or empty. A plain `db push` would re-run the first migration and fail on
`relation … already exists`. SETUP.md already gives the manual fix at lines 300-303 and 1007. The
workflow automates it with a guard:

1. Read the remote history (`migration list … --output-format json`). If it has any version, do
   nothing: the CLI already manages it.
2. Otherwise ask the database:
   `select to_regclass('public.tracy_events') is not null` (through `db query --linked`, so no
   connection is needed).
   - false → an empty project: `db push` applies everything.
   - true → record `20261008000000`.
3. If `select count(*) from public.exercises where origin = 'interverse'` ≥ 90 (the check SETUP §16
   uses), also record `20261008120000`. Otherwise leave it pending. It is an idempotent upsert, so
   `db push` can safely re-apply it.
4. `migration repair <versions> --status applied`, then `db push --dry-run`, then `db push --yes`.

Every later run sees a non-empty history and skips step 2. New migrations must have timestamps later
than `20261008120000`. An older pending version makes `db push` demand `--include-all`
(`db/push/SIDE_EFFECTS.md`, exit codes).

### 2.3 Draft `.github/workflows/deploy-backend.yml`

The full draft is `scratch/deploy-backend.yml`. It parses as YAML (checked with the repo's `yaml`
2.9.1); it has not been run. The core of it:

```yaml
name: Deploy backend
on:
  workflow_dispatch:
    inputs:
      dry_run: { description: Only show what would change, type: boolean, default: true }
      rotate_worker_secret: { description: Make a new cron -> tracy-worker secret, type: boolean, default: false }
concurrency: { group: deploy-backend, cancel-in-progress: false }
permissions: { contents: read }
jobs:
  deploy:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    env:
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}
      DRY_RUN: ${{ inputs.dry_run }}
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with: { version: 2.119.0 }
      - name: Record migrations applied by hand
        run: |
          remote=$(supabase migration list --project-ref "$PROJECT_REF" --output-format json \
                   | jq -r '[.migrations[] | select(.remote != "") | .remote] | join(" ")')
          [ -n "$remote" ] && exit 0
          q() { supabase db query --linked --project-ref "$PROJECT_REF" --agent no -o json "$1"; }
          [ "$(q "select to_regclass('public.tracy_events') is not null as v" | jq -r '.[0].v')" = true ] || exit 0
          versions=20261008000000
          [ "$(q "select count(*)::int as v from public.exercises where origin = 'interverse'" | jq -r '.[0].v')" -ge 90 ] \
            && versions="$versions 20261008120000"
          [ "$DRY_RUN" = true ] && { echo "would record $versions"; exit 0; }
          supabase migration repair $versions --status applied --project-ref "$PROJECT_REF" --yes
      - name: Database migrations
        run: |
          supabase db push --project-ref "$PROJECT_REF" --dry-run
          [ "$DRY_RUN" = true ] || supabase db push --project-ref "$PROJECT_REF" --yes
      - name: Edge Function secrets          # TRACY_URL, TRACY_SERVICE_SECRET, GEMINI_API_KEY from GitHub secrets
        if: ${{ !inputs.dry_run }}
        run: |   # written to a 0600 temp file, then: supabase secrets set --project-ref "$PROJECT_REF" --env-file "$f"
      - name: Worker secret (Edge Function secret + Vault)   # section 3.3
        if: ${{ !inputs.dry_run }}
      - name: Edge Functions
        run: |
          [ "$DRY_RUN" = true ] && { supabase functions list --project-ref "$PROJECT_REF"; exit 0; }
          supabase functions deploy --project-ref "$PROJECT_REF" --use-api
      - name: Smoke test           # wrong secret must get 403 (a 401 means verify_jwt was left on)
        if: ${{ !inputs.dry_run }}
```

What the founder sets once, under GitHub → Settings → Secrets and variables → Actions:

- **Secrets:**
  - `SUPABASE_ACCESS_TOKEN` (Supabase → Account → Access Tokens);
  - `TRACY_URL`;
  - `TRACY_SERVICE_SECRET`;
  - `GEMINI_API_KEY`.
- **Variable:** `SUPABASE_PROJECT_REF`.

The personal access token reaches the whole Supabase account, which is why the workflow is
`workflow_dispatch` only, gated to `main`, and has `contents: read`.

The order is deliberate: migrations, then secrets, then Vault, then functions. Functions can rely on
new SQL, and the worker never runs without its secret. GitHub Environments with required reviewers on a
private repo depend on the GitHub plan: **unverified**. The `dry_run` input defaulting to true is the
safety net.

---

## 3. pg_cron, pg_net and Vault on the Free plan

### 3.1 Enabling them

- **pg_cron.** `create extension pg_cron with schema pg_catalog;` (`guides/cron/install.mdx`). Supabase
  forces that schema through `supautils.extensions_parameter_overrides`.
  - Signatures: `cron.schedule(job_name text, schedule text, command text) → bigint`, which upserts
    by name; `cron.unschedule(job_name text) → boolean`; `cron.alter_job(…)`.
  - Sub-minute schedules (`'30 seconds'`) need Postgres 15.1.1.61 or later. DualRep is on 17.
  - The docs recommend at most 8 concurrent jobs, each at most 10 minutes (`guides/cron.mdx`).
  - `cron.job_run_details` is **never cleaned up**; schedule a delete (`cron/quickstart.mdx`).
- **pg_net.** `create extension pg_net with schema extensions;` (`database/extensions/pg_net.mdx`).
  - Signature: `net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default
    2000) → bigint`.
  - Requests are sent only after the transaction commits.
  - Responses are kept 6 h in `net._http_response`.
  - About 200 requests per second at most.
  - The `net` schema gives `USAGE` to `PUBLIC` but isn't exposed by the Data API.
- **Plan and permissions.** Both are on Supabase's `supautils.privileged_extensions` list, so
  `postgres` may create them. Nothing in the docs limits them to paid plans.
- **Vault** is preinstalled (`supabase_vault`).
  - `vault.create_secret(new_secret text, new_name text = NULL, new_description text = '',
    new_key_id uuid = NULL) → uuid`.
  - `vault.update_secret(secret_id uuid, new_secret text = NULL, new_name text = NULL,
    new_description text = NULL, new_key_id uuid = NULL) → void`.
  - Names are unique when present. Reads go through the `vault.decrypted_secrets` view.
  - EXECUTE is revoked from `PUBLIC` (`supabase_vault--0.3.0.sql:16-31, 53-126`).
- **Never put a secret value in a migration;** it would land in git.

### 3.2 The documented pattern, adapted

`guides/functions/schedule-functions.mdx` stores `project_url` and a key in Vault, then:

```sql
select cron.schedule('invoke-function-every-minute', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/function-name',
    headers := jsonb_build_object('Content-type', 'application/json',
                                  'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')),
    body := concat('{"time": "', now(), '"}')::jsonb) as request_id;
$$);
```

That example sends the **publishable** key, which is no protection for a worker. `functions/auth.mdx`
says service-to-service and cron calls should send a **secret key on `apikey`**, with
`verify_jwt = false` and `withSupabase({ auth: 'secret' })` or `'secret:<name>'`.

DualRep's draft (full text in the appendix) differs in three ways:

- **It calls the worker only when there is work.** `private.kick_tracy_worker()` runs `exists(queued,
  or running and stale)`, and only then calls `net.http_post` with headers built from Vault. An idle
  project spends nothing against the 500,000-invocation quota.
- **It uses a dedicated shared secret, `dualrep_worker_secret`,** not an `sb_secret_…` key. A leaked
  cron secret then only lets someone wake the worker, which can only process jobs that are already
  queued. It can't bypass RLS. The deploy workflow can also create it with no dashboard step.
- **It accepts no-op runs.** If Vault isn't set up yet, the function raises a WARNING and returns
  NULL. The cron run is recorded and nothing breaks.

The worker answers `202` at once and does the work in `EdgeRuntime.waitUntil()` (`background-tasks.mdx`).
So the 5 s `timeout_milliseconds` in pg_net never cuts it off. Whether a client disconnect would abort
a function that is still running synchronously is **unverified**. `waitUntil` sidesteps the question.

For lower latency, an `AFTER INSERT … FOR EACH STATEMENT` trigger on `tracy_events` can call the same
kick function, so a new job starts at once instead of within 60 s. pg_net sends only after commit, and
the claim uses SKIP LOCKED, so duplicate kicks are harmless.

### 3.3 Rotating the secret from the workflow

- **`[db.vault]` in `config.toml` is not enough.** It supports `env(VAR)` values, and `db push` upserts
  them (`command-internal/vault.ts`, with bind parameters). But **only when migrations are pending**:
  `db-push-core.ts:236-251` calls `upsertVaultSecrets` inside `if (pending.length > 0)`. A
  rotation-only run would silently do nothing.
- **Use the Management API query endpoint instead.** It takes `{query, parameters[]}`
  (`api_v1_openapi.json`, `V1RunQueryBody`), so the secret is bound as `$2` and never appears in the
  SQL text:

```bash
api() {  # api <sql> [params...]
  curl -fsS -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "$1" '{query: $q, parameters: $ARGS.positional}' --args "${@:2}")"
}
upsert() {
  api 'select vault.create_secret($2, $1) where not exists (select 1 from vault.secrets where name = $1)' "$1" "$2"
  api 'select vault.update_secret(id, $2) from vault.secrets where name = $1' "$1" "$2"
}
upsert dualrep_project_url "https://$PROJECT_REF.supabase.co"
secret=$(openssl rand -hex 32); echo "::add-mask::$secret"
supabase secrets set --project-ref "$PROJECT_REF" "DUALREP_WORKER_SECRET=$secret"   # function first
upsert dualrep_worker_secret "$secret"                                              # then Vault
```

- **When it runs:** on the first run, or when `rotate_worker_secret` is ticked.
- **The mismatch window** lasts the few seconds between the two writes. At worst one minute's kick gets
  403, and the next minute picks the job up.
- **Not tested:** whether the endpoint binds `parameters` as described. **unverified**.
- **Fallback:** inline the value in the SQL. It still never touches git or the logs (`add-mask`), but
  it reaches Postgres as statement text.
- **The worker's side:** a constant-time comparison of `x-dualrep-worker-secret` against
  `Deno.env.get('DUALREP_WORKER_SECRET')`.
- **Alternative:** a named secret API key (`POST /v1/projects/{ref}/api-keys` with
  `{type:'secret', name:'cron'}`) and `withSupabase({auth:'secret:cron'})`. It is supported, but the
  key bypasses RLS and lives in Vault.

---

## 4. Storage

### 4.1 Creating the bucket in a migration

`storage.buckets` columns (storage migrations 0002, 0008, 0013, **0014: `file_size_limit` is
`bigint`, in bytes**, 0018, 0038, 0068):

- `id`, `name`, `owner`, `owner_id`;
- `public` (default false);
- `avif_autodetection`;
- `file_size_limit bigint`;
- `allowed_mime_types text[]`;
- `type`, `created_at`, `updated_at`, and later columns.

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sources', 'sources', false, 26214400,   -- 25 MiB, under the Free plan's 50 MB global cap
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
              'text/plain','text/markdown',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;
```

- **Why it can't be checked locally:** `supabase db start` runs the storage service's migrations
  *before* user migrations (`db-bootstrap/db-setup.ts:539-567`, `startInitSchema15`), so the CI
  `supabase` job sees these columns. Locally they come from the stubs.
- **Upload limits:** standard uploads are "ideal" up to 6 MB, work up to 5 GB, and TUS resumable
  upload is recommended above 6 MB (`uploads/standard-uploads.mdx`). Free plan: 50 MB per file,
  1 GB in total.

### 4.2 Policies: each user in their own folder

```sql
create policy "dualrep sources: read own folder" on storage.objects for select to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "dualrep sources: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "dualrep sources: overwrite own files" on storage.objects for update to authenticated
  using (…same…) with check (…same…);
create policy "dualrep sources: delete own files" on storage.objects for delete to authenticated
  using (…same…);
```

- **Helper:** `storage.foldername(name)` is
  `string_to_array(name,'/')[1 : array_length-1]`, plpgsql, IMMUTABLE (storage migration 0060).
- **Path layout:** `<auth.uid>/<source_id>/<source_files.id>.<ext>`. Server-chosen names also avoid
  Storage's file-name character rules (`uploads/file-limits.mdx`).
- **Upsert** needs SELECT, INSERT and UPDATE (`security/access-control.mdx`).
- **Why `postgres` can create these:** `CREATE POLICY` needs table ownership, and `storage.objects`
  is owned by Supabase. Supabase allows it through `supautils.policy_grants`, which lists
  `storage.objects` and `storage.buckets` for `postgres` (`supautils.conf.j2:2`). So this works in a
  migration and in the SQL Editor. Don't `ALTER TABLE storage.objects`: RLS is already on, and
  `ALTER` needs ownership.
- **Group members are deliberately left out.** Phase 2 files are read by their owner and by the worker
  through the secret key. If group members ever need the original file, add a SELECT branch using
  `public.can_read_source()` on folder segment 2, with a safe uuid parse.

### 4.3 Security fix: `storage_path` must stay inside the source's folder

`source_files.storage_path` is device-writable today (`20261008000000_initial_schema.sql:292-306`,
policies at `:1543-1556` only check `can_edit_source`). The worker downloads the path with the
**secret key**. A malicious user could set it to `<victim>/<source>/<file>` and get the victim's notes
turned into their own cards. Fix, run and tested:

```sql
alter table public.source_files add constraint source_files_storage_path_in_own_folder
  check (storage_path like owner_id::text || '/' || source_id::text || '/%');
create index source_files_storage_path_idx on public.source_files (storage_path);  -- for the sweep
```

- `owner_id` is set by the `copy_source_ownership` BEFORE trigger, and CHECK constraints run after
  BEFORE triggers.
- A bad path from a phone fails with **23514**, which the connector drops into `upload_failures`. A
  correct app never produces one.
- **Cost:** 5 fixture paths in the existing tests must become real paths: `05_sources.test.sql:47,
  116, 241`, `11_leaving_groups.test.sql:55` and `12_offline_uploads.test.sql:389`.
- **Limitation:** a service-role change of a source's owner would now fail on its files. That doesn't
  happen today.
- **Defence in depth:** the worker should also check the prefix before it downloads.

### 4.4 Signed URLs

- **Read link:** `createSignedUrl(path: string, expiresIn: number /* seconds */, { download?,
  transform?, cacheNonce?, versionId? })` → `{ data: { signedUrl } }`. Needs SELECT on the object, or
  the secret key (`storage-js` 2.117.3, `index.d.mts:1348`).
- **Upload link:** `createSignedUploadUrl(path, { upsert })` makes a URL "valid for 2 hours"; upload
  to it with `uploadToSignedUrl(path, token, body)`.
- **For Tracy:** the worker uses the secret key and passes `createSignedUrl(path, 600)` to Tracy for
  `/ai/extract` or vision. Ten minutes covers a Render cold start. No document gives a maximum
  expiry.

### 4.5 Uploading from React Native (supabase-js 2.117.3)

- **The storage-js doc comment:** *"For React Native, using either `Blob`, `File` or `FormData` does
  not work as intended. Upload file using `ArrayBuffer` from base64 file data instead"*
  (`index.d.mts:1024`).
- **Why `contentType` matters:** with a non-Blob body, storage-js sends the raw bytes with
  `content-type: options.contentType`, and the **default is `"text/plain;charset=UTF-8"`**
  (`index.mjs:598-623`). The bucket's MIME allow-list checks that header, so pass it explicitly.
- **Where the bytes come from:** `expo-file-system@57.0.7` (the SDK 57 dist-tag; **not yet in
  `package.json`**, so adding it is a native change and needs a new APK). Its `File` class has
  `arrayBuffer(): Promise<ArrayBuffer>` (`build/File.d.ts:105`).

```ts
import { File } from 'expo-file-system'
const path = `${userId}/${sourceId}/${fileId}.${ext}`
const body = await new File(localUri).arrayBuffer()          // never pass the File itself
const { error } = await supabase.storage.from('sources')
  .upload(path, body, { contentType: mime, upsert: true })   // upsert → retries are idempotent
```

- **Large files:** for photos, compress first. For files much over 6 MB, consider
  `createSignedUploadUrl` with expo-file-system's native `UploadTask` (progress, no ArrayBuffer in
  JS). Whether that pairing works is **unverified**.
- **Write order:** create the `sources` and `source_files` rows first (PowerSync, offline is fine).
  Upload when online. Then call the user-facing function to queue processing. Keep the local URI
  until the upload succeeds, in a new local-only table, like `upload_failures`.

### 4.6 Removing files when a source is deleted

- **SQL can't do it.** Storage migration `0055-prevent-direct-deletes.sql` adds BEFORE DELETE
  statement triggers on `storage.objects` and `storage.buckets`. They raise **42501** *"Direct
  deletion from storage tables is not allowed. Use the Storage API instead."* unless
  `storage.allow_delete_query = 'true'`.
- **A SQL delete would orphan the file anyway** (`management/delete-objects.mdx`). So a trigger on
  `sources` can't do it, and the account-deletion cascade leaves files behind.
- **Recommended: a sweep.** `public.orphaned_source_objects(p_limit)` (security definer,
  `service_role` only) lists bucket objects older than 3 days that no `source_files.storage_path`
  points at. This catches deleted sources, deleted accounts and abandoned uploads. The worker removes
  them with `admin.storage.from('sources').remove(names)`, up to 1,000 per call, on each run (or from
  a daily cron kick).
- **Grace period:** 3 days covers a phone that uploads the file before its row syncs. Write it into
  the privacy policy's deletion wording (Play account deletion).
- **Optional:** the app also calls `remove()` itself when it deletes a source while online.
- **Account deletion works:** the `objects_owner_fkey` constraint was dropped in storage migration
  0017, so deleting a user who owns files no longer fails.

---

## 5. Claim with `FOR UPDATE SKIP LOCKED`, and the monthly cap

Both are tested in the scratch run (section 6).

```sql
create function public.claim_tracy_events(p_limit integer default 1)
returns setof public.tracy_events language plpgsql volatile security definer set search_path = '' as $$
begin
  -- Reap: a job 'running' for 5 min means its worker died (150 s wall clock). Retry queued kinds
  -- (< 3 attempts); fail everything else, so a synchronous planner/grader call is never re-run.
  update public.tracy_events
     set status = case when attempts >= 3 or job not in ('study_builder','handwriting','analyst') then 'failed' else 'queued' end,
         error  = case when attempts >= 3 or job not in ('study_builder','handwriting','analyst')
                       then 'worker timed out (attempt ' || attempts || ')' else error end,
         locked_at = null
   where status = 'running' and locked_at < now() - interval '5 minutes';
  return query
  with claimed as (
    update public.tracy_events e set status = 'running', locked_at = now(), attempts = e.attempts + 1
     where e.id in (select q.id from public.tracy_events q where q.status = 'queued'
                    order by q.created_at limit least(greatest(coalesce(p_limit,1),1),10)
                    for update skip locked)
    returning e.*)
  select * from claimed order by created_at;
end $$;
revoke all on function public.claim_tracy_events(integer) from public, anon, authenticated;
grant execute on function public.claim_tracy_events(integer) to service_role;
```

- **Two pitfalls hit while testing:**
  - `RETURN QUERY UPDATE … RETURNING` must be wrapped in a CTE.
  - In the tests, the effect of a function call is invisible to the same statement's snapshot.
- **How the worker calls it:** `admin.rpc('claim_tracy_events', { p_limit: 1 })`. PostgREST runs each
  RPC POST in its own transaction, so the claim commits at once.
- **The fencing token:** the returned `attempts`. Finish with
  `.update({status:'succeeded', output, model, usage, locked_at:null}).eq('id',id).eq('status','running').eq('attempts',n)`,
  so a late zombie can't overwrite a retried job.
- **Index:** the partial index `tracy_events_queued_idx` (`initial_schema.sql:577`) serves the claim.
  Add `(locked_at) where status = 'running'` if the reap ever shows up in query plans.
- **Security definer is not strictly needed:** `service_role` has BYPASSRLS and full grants. It is
  kept, with `search_path = ''`, as the task asked. `00_schema.test.sql:187` then needs the new names
  in its `service_role` function list.

**The monthly cap** is atomic per user through an advisory lock, so two concurrent requests can't
both slip under the limit:

```sql
create function public.enqueue_tracy_event(p_user_id uuid, p_job text, p_input jsonb,
  p_free_limit integer, p_paid_limit integer, p_run_now boolean default false)
returns public.tracy_events language plpgsql volatile security definer set search_path = '' as $$
declare monthly_limit integer; used integer; ev public.tracy_events;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dualrep.tracy_cap:' || p_user_id::text, 0));
  monthly_limit := case when public.has_paid_access(p_user_id) then p_paid_limit else p_free_limit end;
  select count(*) into used from public.tracy_events e
   where e.user_id = p_user_id and e.job = p_job and e.status <> 'cancelled'
     and e.created_at >= pg_catalog.date_trunc('month', now(), 'UTC');
  if monthly_limit is not null and used >= monthly_limit then
    raise exception 'monthly limit reached for %', p_job using errcode = 'P0001',
      detail = format('used=%s limit=%s', used, monthly_limit), hint = 'dualrep_cap_reached';
  end if;
  insert into public.tracy_events (user_id, job, status, input, attempts, locked_at)
  values (p_user_id, p_job, case when p_run_now then 'running' else 'queued' end, coalesce(p_input,'{}'),
          case when p_run_now then 1 else 0 end, case when p_run_now then now() end)
  returning * into ev;
  return ev;
end $$;
```

- **Tier:** `has_paid_access(uid)` (`initial_schema.sql:706`) answers for any uid when there is no
  user JWT. That is the service-role case, and beta testers hold a `subscription` entitlement.
- **Where the limits live:** in Edge Function secrets, for example `DUALREP_CAP_FREE_STUDY`, so the
  "set from beta usage" decision needs no migration. NULL means no limit.
- **Synchronous jobs:** `p_run_now = true` stores the job as `running`, so the cron worker never
  claims it.
- **Errors:** PostgREST returns `{code:'P0001', details, hint:'dualrep_cap_reached'}` as HTTP 400. The
  function maps that to 429 for the app.
- **Counting:** it uses `(user_id, created_at)`, which `tracy_events_user_id_created_at_idx`
  (`:575`) covers. A token budget could sum `usage` instead, once Tracy's `usage` shape is fixed.
- **One security check stays with the caller:** before enqueueing a job for a source, the
  user-facing function must check that the user can read that source, using the RLS client (1.3).
  Otherwise a service-role worker would happily process any `source_id`.

---

## 6. The local test harness (`npm run db:test`)

Today `scripts/db/supabase-stubs.sql:18` says *"Deliberately absent: everything the schema must not
depend on (storage, realtime, pg_net, ...)"*. Phase 2 makes the schema depend on storage, pg_cron,
pg_net and Vault, so that line and the stubs must change. The draft is `scratch/phase2-stubs.sql`,
181 lines appended to the stubs.

| Stub | Contents (mirrors) |
|---|---|
| `storage` | Schema with USAGE for the API roles. `storage.buckets(id, name, owner, owner_id, public, avif_autodetection, file_size_limit bigint, allowed_mime_types text[], created_at, updated_at)`. `storage.objects(id, bucket_id → buckets, name, owner, owner_id text, metadata, path_tokens, version, user_metadata, …)` with a unique `(bucket_id, name)`. RLS on both; `grant all … to anon, authenticated, service_role` (storage 0046). `storage.foldername()` and `storage.filename()` (0060). `storage.protect_delete()` and its trigger (0055), so tests catch SQL deletes. |
| `cron` | `cron.job` (jobname unique); `cron.schedule(job_name, schedule, command)`, which upserts and never runs anything; `cron.unschedule(job_name)` |
| `net` | `net.http_request_queue`; `net.http_post(url, body, params, headers, timeout_milliseconds)`, which records the request instead of sending it |
| `vault` | `vault.secrets` (unique name), a `vault.decrypted_secrets` view (plaintext), `create_secret` and `update_secret` with the real signatures, revoked from `PUBLIC` |

How the migration copes with both environments: it creates the extensions only if their schema is
missing (`if to_regnamespace('cron') is null then create extension pg_cron …`, the same for `net`).

- On Supabase, and under `supabase db start`, the real extensions are created.
- Under the stubs the schemas already exist, so the step is skipped.

That is more robust than checking `pg_available_extensions`: a developer who has `postgresql-16-cron`
installed but not preloaded doesn't fail. (pg_cron 1.6.2 is in Ubuntu noble; pg_net and Vault are
not.)

**The scratch run** (scripts and tests copied to `scratch/sim/`):

- Baseline: 542 tests in 14 files pass.
- With the stubs, the draft migration (`scratch/20261009120000_study_backend.sql`, 210 lines) and the
  draft `scratch/14_study_backend.test.sql` (26 tests): **568 tests in 15 files pass**, after two
  changes to existing tests:
  - `00_schema.test.sql:181-188` adds `claim_tracy_events`, `enqueue_tracy_event` and
    `orphaned_source_objects` to the `service_role` function list;
  - the 5 fixture paths from 4.3.
- The draft tests cover:
  - the bucket settings;
  - own-folder upload and read;
  - refusing another user's folder and the bucket root;
  - the `storage_path` CHECK;
  - claim order, SKIP LOCKED, the reap and the failure after 3 attempts;
  - the cap: free, paid, per job, and run-now;
  - privileges;
  - the orphan list;
  - the SQL-delete guard;
  - the kick: nothing without work or Vault, the URL with them, and the cron entry.

The two `cron.schedule` calls are wrapped in `do $$ … perform …` so the migration prints no result
rows. **Not run:** the same test file under `supabase test db` in the real image, where storage has
more triggers (**unverified**). The CI `supabase` job will be the check.

The 210-line migration is over the ~150-line SQL Editor paste limit. Ship it through the Deploy
backend workflow. If it must be pasted, split it into `supabase/sql-editor/<name>/part-N-of-M.sql`, as
the starter library was.

---

## 7. PowerSync

- **The draft needs no PowerSync change.** It adds no public table and no column. The storage bucket,
  the `private` schema, functions, a CHECK and an index don't reach the snapshot, which only covers
  `public` (`scripts/db-test.sh` snapshot query). The snapshot diff is empty, so `npm run
  validate:sync` and the registry-drift test are unaffected.
- **Phase 2's outputs are already synced:**

  | Data | Synced through |
  |---|---|
  | `sources.status` | `SELECT *` in `user_owned` and `group_shared` |
  | `source_files.transcript` and `confirmed` | same |
  | `topics`, `cards` (`page`, `source_chunk_id`), `card_links` | `plan_content` |
  | `card_states`, `reviews` | `user_private` |
  | `tracy_events` `status` and `error` | an explicit light column list (`sync-config.yaml:60`) |

  `source_chunks` stays out, which the validator enforces.
- **New columns on a `SELECT *` table** (for example `sources.error text`, `source_files.mime_type
  text`, `source_files.size_bytes bigint`, which the snapshot maps to `integer`):
  - add them to `src/db/tables.ts`. The validator fails with "outputs X, which src/db/tables.ts does
    not declare", and the jest registry-drift test fails too;
  - ship a new APK;
  - **no sync config redeploy** is needed.
  - PowerSync docs (`maintenance-ops/implementing-schema-changes.mdx`): column changes are not
    detected. *"Adding a column with a NULL default will generally not cause issues"*, but a
    non-null default **is not replicated to existing rows** until each row is updated. So keep new
    synced columns nullable, or touch the rows.
- **A new column on `tracy_events`** (for example `source_id`, so progress can be shown per source)
  needs three changes, then the redeploy below:
  - `sync-config.yaml:60` (the explicit column list);
  - `TABLES.tracy_events` (and `SERVER_ONLY_COLUMNS` if it stays server-only);
  - an FK with `on delete set null`, and the `00_schema.test.sql` FK lists.
- **A new synced table** needs `alter publication powersync add table public.x;` in the migration,
  plus registry, sync-config and redeploy. Adding a table to the publication makes PowerSync
  re-snapshot it, which blocks replication while it runs.
- **New public tables are readable by PowerSync.** `powersync_role` has
  `alter default privileges in schema public grant select on tables` from SETUP §7, which covers
  tables owned by `postgres`, and `db push` creates them as `postgres`.
- **The founder's redeploy, when `powersync/sync-config.yaml` changes:**
  1. PowerSync dashboard → instance `dualrep-dev` → the Sync Streams / Sync Config editor → paste the
     whole file → Validate → Deploy (SETUP §8A step 6). Or `npx powersync deploy sync-config` (§8B).
  2. Wait for reprocessing to finish.
  3. Only then install the new APK.

  PowerSync's order (`maintenance-ops/deploying-schema-changes.mdx`, "Additive Changes"): migrations,
  then the backend, then the sync config, then wait for reprocessing, then the app. A deploy also
  resets the 7-day inactivity timer on the free instance.

---

## 8. Open risks and unverified items

1. **HS256 or asymmetric signing keys on the hosted project.** Unknown (SETUP §6 is not recorded).
   `@supabase/server` rejects HS256. Use `auth.getClaims` (Option B) or migrate the keys first.
2. **The CLI's temporary-role and pooler path** hasn't been exercised against DualRep's project.
   Neither have the Management API's `parameters` binding nor `db query --linked` row-JSON parsing.
   Run once with `dry_run`; keep the `--db-url` session-pooler fallback ready.
3. **The real Supabase image hasn't run the draft migration or tests** (no Docker here). Storage's
   extra triggers and `private` schema behaviour there are **unverified**. The CI `supabase` job
   will show it.
4. **The 500 MB database cap.** `vector(1536)` is about 6 KB per chunk plus the HNSW index, so roughly
   30,000 chunks fit across all users. `halfvec` would halve that, but Ubuntu noble's pgvector 0.6.0
   (used by `npm run db:test` and CI) has no `halfvec`.
5. **Deno version on hosted Edge Functions.** **unverified**: the docs page says 1.46, which is stale.
   The CLI runtime is Deno 2.1.4.
6. **Whether pg_cron activity prevents Free-plan pausing.** **unverified**.
7. **Edge Function request and response size limits.** Not documented; **unverified**.
8. **The 5 MB server-side bundle limit** with `--use-api`. Keep functions on `fetch` plus
   supabase-js.
9. **Render cold start** (about 1 minute) plus a long Tracy step could exceed the 150 s wall clock.
   Make one Tracy call per worker run, with an `AbortSignal.timeout` under about 100 s.
10. **The storage_path CHECK** changes 5 test fixtures and refuses (23514) any phone write that
    builds the path wrongly. The app must build paths exactly as
    `<uid>/<source_id>/<file_id>.<ext>`.
11. **`tsconfig.json` and Jest** will pick up `supabase/functions/**` unless excluded (1.5).
12. **The personal access token in GitHub** has account-wide scope. Use `workflow_dispatch` on `main`
    only. Whether required reviewers on Environments are available for this private repo's plan is
    **unverified**.

---

## Appendix: draft files (scratch; nothing committed)

| File | What |
|---|---|
| `scratch/20261009120000_study_backend.sql` | The migration: extensions, bucket and policies, the `storage_path` CHECK and index, `claim_tracy_events`, `enqueue_tracy_event`, `orphaned_source_objects`, `private.kick_tracy_worker`, and 2 cron jobs |
| `scratch/phase2-stubs.sql` | Additions for `scripts/db/supabase-stubs.sql` (storage, cron, net, vault) |
| `scratch/14_study_backend.test.sql` | 26 pgTAP tests |
| `scratch/deploy-backend.yml` | The full Deploy backend workflow |
| `scratch/sim/` | The scratch harness run (568 tests pass), including the patched `00/05/11/12` tests |
