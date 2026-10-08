# PowerSync + Supabase setup for DualRep, Phase 0 (research report)

> Research date: 2026-10-08. Reference copy of a Phase 0 research report, kept as background. Where it disagrees with the repo (migration, sync config, code) or with the guides in `docs/`, the repo and the guides win.

## How this was researched

- **Sites that could not be opened.** `docs.powersync.com`, `powersync.com`, `releases.powersync.com` and `supabase.com` could not be fetched during research. Claims about what the docs and blogs say therefore come from search result extracts, cited by URL. Treat those as "per docs, not re-read".
- **Code-level claims.** Statements about behaviour come from the source code of the npm-published packages I downloaded and read. These are newer and more authoritative than the docs:
  - `powersync` CLI 0.10.2
  - `@powersync/service-sync-rules` 0.43.0
  - `@powersync/service-core` / `service-image` 1.27.0
  - `@powersync/service-module-postgres` 0.23.2
  - `@powersync/service-jpgwire` 0.21.25
  - `@powersync/common` / `@powersync/react-native` 2.3.1
- **What I actually ran (offline):**
  1. **Sync config.** Compiled the DualRep sync config below with the real Sync Streams compiler (`@powersync/service-sync-rules@0.43.0`). It produced 0 diagnostics, and I inspected the compiled bucket plan.
  2. **Reference TypeScript.** Type-checked it with `tsc --strict` against `@powersync/react-native@2.3.1`, `@supabase/supabase-js@2.117.3` and `react-native@0.87.1`.
  3. **SQL and RLS.** Ran the SQL/RLS excerpt and the PostgREST-style JSON coercions on Postgres 18 (PGlite 0.5.8 + pgvector).
- **Current versions (npm, today):**

| Package | Version |
|---|---|
| `@powersync/react-native` | 2.3.1 (2026-10-01) |
| `@powersync/common` | 2.3.1 |
| `@powersync/react` | 2.0.2 |
| `@op-engineering/op-sqlite` | 18.2.5 (RN SDK peer range is `>=17.1.0 <19`) |
| `powersync` (CLI) | 0.10.2 |
| `@powersync/service-image` | 1.27.0 (2026-09-30) |
| `@supabase/supabase-js` | 2.117.3 |
| `expo` | 57.0.27 |

---

## 1. Sync Rules vs Sync Streams

### Status and recommendation

- **Use Sync Streams with `config: edition: 3`. Do not start a new project on Sync Rules.**
- **Release history:**
  - Early alpha in Sept 2025.
  - Beta (Feb/Mar 2026) was declared production-ready and "recommended for new projects".
  - **GA on May 14, 2026.** The release note says the APIs are stable. Sync Rules remain supported but are "legacy" and will be deprecated, with an LTS plan to be announced. ([GA note](https://releases.powersync.com/announcements/sync-streams-are-now-generally-available), [beta note](https://releases.powersync.com/announcements/sync-streams-are-now-in-beta), [May 2026 changelog](https://powersync.com/blog/powersync-changelog-may-2026))
- **The service source is blunter than the docs.** The `@powersync/service-sync-rules` README says Sync Streams (`streams:`) are "the current engine. Requires `config: edition: 3`". It calls Sync Rules (`bucket_definitions:`) "deprecated… kept only so that existing deployments keep working" ([npm](https://www.npmjs.com/package/@powersync/service-sync-rules)).
- **The scaffold already uses Streams.** The CLI's own `powersync init cloud` template is edition 3 with `streams:`.
- **Docs inconsistency.** Some docs pages (the Sync Streams overview) may still say "Beta". The release note and package README supersede them.

### What edition 3 adds over Sync Rules

These were all checked against the compiler:

- `INNER JOIN` in data queries.
- Subqueries: `x IN (SELECT …)`, nested.
- CTEs, both global (a top-level `with:`) and per-stream.
- Multiple queries per stream; queries in one stream that share the same parameter collapse into one bucket.
- `OR` on row filters.
- `CASE` / `BETWEEN`, per the docs.
- Per-stream `priority` (0–3).
- `auto_subscribe`.
- On-demand subscriptions with `subscription.parameter()` and TTL.

([Supported SQL](https://docs.powersync.com/sync/supported-sql), [Writing queries](https://docs.powersync.com/sync/streams/queries), [Grammar](https://docs.powersync.com/sync/grammar/sync-streams))

### Request functions

| Sync Streams | Legacy Sync Rules | Meaning |
|---|---|---|
| `auth.user_id()` | `request.user_id()` (older: `token_parameters.user_id`) | JWT `sub`. The compiler desugars it to `auth.parameters() ->> '$.sub'`. |
| `auth.parameter('$.app_metadata.x')`, `auth.parameters()` | `request.jwt()` | Signed JWT claims, safe for authorization. |
| `subscription.parameter('k')` | n/a | Per-subscription client value. **Unauthenticated**; the compiler warns. |
| `connection.parameter('k')` | `request.parameters()` | `db.connect(…, { params })`. **Unauthenticated.** |

With Supabase, authorize only on `sub` or `app_metadata`. Never authorize on `user_metadata`, because the user can edit it.

### DualRep `powersync/sync-config.yaml`

This compiles with 0 diagnostics. It is written against the plan's 22-table model, with the denormalized columns noted in the comments.

```yaml
config:
  edition: 3
  timestamp_max_precision: milliseconds   # timestamps arrive as 2026-10-08T09:30:00.123Z (same as JS toISOString)
  fixed_booleans_in_json: true            # bool[] / composite booleans stay true/false instead of 1/0

# Global CTE: the groups the signed-in user belongs to (one column, so `IN my_groups` works).
with:
  my_groups: SELECT group_id FROM group_members WHERE user_id = auth.user_id()

streams:
  # (a) Private per-user data. One bucket per user.
  user_private:
    auto_subscribe: true
    priority: 1
    queries:
      - SELECT * FROM profiles WHERE id = auth.user_id()
      - SELECT * FROM entitlements WHERE user_id = auth.user_id()
      - SELECT * FROM study_sessions WHERE user_id = auth.user_id()
      - SELECT * FROM interval_blocks WHERE user_id = auth.user_id()
      - SELECT * FROM equipment_setups WHERE user_id = auth.user_id()
      - SELECT * FROM workout_sessions WHERE user_id = auth.user_id()
      - SELECT * FROM exercise_sets WHERE user_id = auth.user_id()
      - SELECT * FROM transitions WHERE user_id = auth.user_id()
      - SELECT * FROM reviews WHERE user_id = auth.user_id()
      # Explicit column list: the large input/output JSON stays on the server.
      - SELECT id, user_id, job, status, accepted, created_at FROM tracy_events WHERE user_id = auth.user_id()

  # (c) Global read-only library. One bucket shared by every user.
  library:
    auto_subscribe: true
    priority: 1
    queries:
      - SELECT * FROM exercises WHERE reviewed = true AND (origin = 'dataset' OR origin = 'interverse')
      - SELECT * FROM presets WHERE owner_id IS NULL

  # (d) Things the user created for themselves (incl. custom exercises). One bucket per user.
  user_owned:
    auto_subscribe: true
    queries:
      - SELECT * FROM exercises WHERE owner_id = auth.user_id()
      - SELECT * FROM presets WHERE owner_id = auth.user_id()
      - SELECT * FROM sources WHERE owner_id = auth.user_id()
      - SELECT * FROM source_files WHERE owner_id = auth.user_id()
      - SELECT * FROM study_plans WHERE owner_id = auth.user_id()

  # (b) Group-shared data. One bucket per group the user is a member of.
  group_shared:
    auto_subscribe: true
    queries:
      - SELECT * FROM groups WHERE id IN my_groups
      - SELECT * FROM group_members WHERE group_id IN my_groups
      - SELECT * FROM exercises WHERE group_id IN my_groups
      - SELECT * FROM sources WHERE group_id IN my_groups
      - SELECT * FROM source_files WHERE group_id IN my_groups
      - SELECT * FROM study_plans WHERE group_id IN my_groups

  # Plan content (personal or group plans). One bucket per visible plan.
  plan_content:
    auto_subscribe: true
    with:
      visible_plans: >-
        SELECT id FROM study_plans
        WHERE owner_id = auth.user_id()
           OR group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.user_id())
    queries:
      - SELECT * FROM plan_sources WHERE plan_id IN visible_plans
      - SELECT * FROM topics WHERE plan_id IN visible_plans
      - SELECT * FROM cards WHERE plan_id IN visible_plans
      - SELECT * FROM card_links WHERE plan_id IN visible_plans
```

**Compiled plan (inspected):**

- Five bucket definitions:
  - `user_private` and `user_owned`, partitioned by user.
  - `library`, a single global bucket.
  - `group_shared`, partitioned by `group_id`, through a lookup on `group_members.user_id`.
  - `plan_content`, partitioned by `plan_id`, with two queriers: owner plans, and group plans through a two-stage lookup.
- **Per-device bucket count:** 3 + #groups + #visible plans. That is far below the service default of **1000 buckets and 1000 parameter results per connection** (`DEFAULT_MAX_BUCKETS_PER_CONNECTION` / `DEFAULT_MAX_PARAMETER_QUERY_RESULTS` in service-core).
- **Group membership changes need no client code.** Joining or leaving a group adds or removes that group's bucket automatically.
- The plan document's phrase "PowerSync sync rules give each device one bucket per group" is satisfied by the `group_shared` stream above.

### Restrictions (verified compiler messages)

| Query pattern | Result |
|---|---|
| `origin IN ('dataset','interverse')` (literal list) | **fatal** "This expression is not supported by PowerSync". Use `OR`, `!= 'user'`, or `IN (SELECT value FROM json_each('[…]'))`. |
| `logged_at > subscription.parameter('since')` | **fatal**: comparisons against request or subscription values must be `=` (also `IN`, `IS NULL` per docs). Ranges are allowed only against literals. |
| `SELECT a.*, b.col FROM a JOIN b …` | **fatal** "Sync streams can only select from a single table". The output columns must come from one table; the join may only filter. |
| `LEFT JOIN`, `JOIN … USING` | **fatal** (only `INNER JOIN … ON`). |
| `LIKE`, `ORDER BY`, `LIMIT`, `GROUP BY` | **fatal** "… is not supported". |
| A filter on `subscription.parameter()` alone | **warning**: unsuitable for authorization. Add an `auth.user_id()` subquery. |
| Aliasing the primary table in a join (`FROM cards c JOIN …`) | Rows sync under the alias name (warning since service 1.23.3). Don't alias, or quote the alias on purpose. |
| `*` after an aliased column | Warning: `*` may overwrite the alias. |
| More than 100 buckets from one stream definition (OR expansion) | **fatal**. |
| CTEs | Cannot reference other CTEs (use nested subqueries). `IN cte` needs a one-column CTE. Global CTE names must not shadow tables ([Supported SQL](https://docs.powersync.com/sync/supported-sql)). |
| Functions | Expressions must be deterministic: no `now()`, no aggregates ([docs](https://docs.powersync.com/sync/supported-sql)). |

### The `id` rule (critical)

- **The client requires a text `id` on every synced row.** Postgres `uuid` arrives as text.
- **Legacy Sync Rules catch a missing id:** they fail with `Query must return an "id" column`.
- **Edition-3 Sync Streams do not.** A query without `id` compiles with **no diagnostic**. At runtime, `idFromData()` falls back to a blank id, so the device ends up with **one arbitrary row per table** (see `dist/cast.js`). Every stream query must select `id`.

**Composite or one-row-per-user tables:**

- **`plan_sources (plan_id, source_id)` and `group_members (group_id, user_id)`.** Add `id uuid primary key default gen_random_uuid()` plus `unique(plan_id, source_id)` / `unique(group_id, user_id)`.
  - The client writes `plan_sources` offline and needs a stable id for PATCH and DELETE.
  - If two devices add the same pair offline, the second upload hits 23505 and is discarded, which is effectively de-duplication.
  - Optional: derive the id deterministically (uuid v5 of `plan_id:source_id`) so both uploads upsert the same row.
- **`entitlements (user_id)`.** Add an `id` column; this is what the SQL in section 2 does. Because the table is server-written and read-only on the device, `SELECT user_id AS id, user_id, tier, source, expires_at FROM entitlements WHERE user_id = auth.user_id()` also compiles cleanly and works.
- **A synthetic `plan_id || ':' || source_id AS id`** compiles but makes uploads awkward, because the connector must map DELETE back to two columns. Not recommended for client-written tables.

### Bucket fan-out: denormalize owner columns onto children

Filtering a child table through its parent does **not** produce one bucket per user; it produces **one bucket per parent row**. I verified this in the compiled plan for:

```sql
SELECT exercise_sets.* FROM exercise_sets
INNER JOIN workout_sessions ON exercise_sets.workout_session_id = workout_sessions.id
WHERE workout_sessions.user_id = auth.user_id()
```

The result is partitioned by `workout_session_id`. A user with more than 1000 sessions would hit the per-connection limit.

The plan document's tables need these extra columns:

- **`user_id`** on `interval_blocks`, `exercise_sets` and `transitions` (bucket per user).
- **`plan_id`** on `cards` and `card_links`. Otherwise they are bucketed per topic.
- **`owner_id` and `group_id`** on `source_files`, copied from `sources`.

Enforce the denormalized columns in RLS `WITH CHECK` (see section 2) or with a trigger.

### Legacy Sync Rules equivalent (for comparison only)

This compiles with 0 diagnostics.

```yaml
bucket_definitions:
  user_private:
    parameters: SELECT request.user_id() AS user_id
    data:
      - SELECT * FROM workout_sessions WHERE user_id = bucket.user_id
  library:
    data:
      - SELECT * FROM exercises WHERE reviewed = true AND origin != 'user'
      - SELECT * FROM presets WHERE owner_id IS NULL
  by_group:
    parameters: SELECT group_id FROM group_members WHERE user_id = request.user_id()
    data:
      - SELECT * FROM exercises WHERE group_id = bucket.group_id
```

Legacy parameter queries cannot join. `SELECT study_plans.id … JOIN group_members …` fails with "Must SELECT from a single table". The group → plan → topic chain is therefore impossible without more denormalization. That is the concrete reason to use Streams for DualRep.

**On-demand option (not needed for Phase 0).** Streams without `auto_subscribe` sync only while subscribed:

```ts
const sub = await db.syncStream('x', { plan_id }).subscribe({ ttl: 3600 });
await sub.waitForFirstSync();
```

DualRep is offline-first, so every stream above uses `auto_subscribe: true`, which behaves like Sync Rules ([client usage](https://docs.powersync.com/sync/streams/client-usage)).

---

## 2. Postgres / Supabase side

### Logical replication

- Supabase runs `wal_level = logical` by default ([PowerSync Supabase guide](https://docs.powersync.com/integrations/supabase/guide)).
- The service checks three settings at startup:
  - `wal_level = 'logical'`
  - `max_replication_slots >= 1`
  - `max_wal_senders >= 1`

  (`sql/check-source-configuration.plpgsql`.)

### Connection

- **Use the Direct connection string** (`db.<ref>.supabase.co:5432`). Logical replication does not work through Supavisor or the pooler ([Supabase replication FAQ](https://supabase.com/docs/guides/database/replication/faq), [PowerSync self-hosted config](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances)).
- **IPv6.** The direct host is IPv6. Self-hosted PowerSync on an IPv4-only network needs Supabase's IPv4 add-on (about $4/month) ([Supabase IPv4](https://supabase.com/docs/guides/platform/ipv4-address)).
- **TLS.** Keep `sslmode: verify-full`; the PowerSync guide says Supabase's CA is bundled.

### Publication

- **The name is hard-coded:** `export const PUBLICATION_NAME = 'powersync'` (`WalStream.js`).
- **Startup errors:**
  - Missing publication: `Publication 'powersync' does not exist. Run: CREATE PUBLICATION powersync FOR ALL TABLES`.
  - The publication must publish insert, update, delete and truncate.
  - `publish_via_partition_root` is rejected.
- **Not every table needs to be in it.** Tables referenced by the sync config but missing from the publication are skipped with a log line, and diagnostics say `Run: ALTER PUBLICATION powersync ADD TABLE …`.
- **List the 21 synced tables explicitly instead of `FOR ALL TABLES`**, so `source_chunks` (pgvector embeddings) never streams through PowerSync's WAL consumer. The docs also warn that listing every table can cause memory spikes ([setup guide](https://docs.powersync.com/intro/setup-guide)).

### pgvector

- Do not sync `embedding`. Unknown and extension types replicate as TEXT (`[0.1,…]`), which is huge.
- `SELECT *` would include the column, so if you ever sync `source_chunks`, list its columns explicitly (`SELECT id, source_id, page, content FROM …`).
- For Phase 0, keep `source_chunks` out of both the publication and the sync config.

### Replica identity and RLS

- **Replica identity.** The default (primary key) is fine; PowerSync handles TOASTed columns itself.
- **RLS.** The replication role must bypass RLS, or the service logs `PSYNC_S1145 … run: ALTER ROLE … BYPASSRLS`.

### Supabase grant change

- New Supabase projects (rollout from **May 30, 2026**) no longer auto-grant Data API access to new `public` tables. Each table needs explicit `GRANT … TO authenticated`.
- Existing projects reportedly switch on **Oct 30, 2026**; that date comes only from secondary sources.
- A missing grant returns **42501**, the same code as an RLS denial ([Supabase changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [discussion](https://github.com/orgs/supabase/discussions/45329)).

### Migration excerpt

This ran cleanly on Postgres 18 (PGlite + pgvector) with a mocked `auth.uid()`. The RLS behaviour was exercised: own writes succeed, unreviewed library rows are hidden, and a self-granted entitlement is rejected with 42501.

```sql
-- Composite/one-row tables get a surrogate id
create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null, role text not null check (role in ('owner','member')),
  unique (group_id, user_id));
create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique, tier text not null check (tier in ('free','subscription')),
  source text not null check (source in ('store','beta')), expires_at timestamptz);
create table public.plan_sources (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  added_at timestamptz not null default now(), unique (plan_id, source_id));
create table public.exercise_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                     -- denormalized owner
  workout_session_id uuid not null references public.workout_sessions(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id),
  set_index int not null, reps int,
  weight_lbs double precision, rpe double precision,   -- REAL on device; numeric would arrive as TEXT
  set_type text not null default 'normal' check (set_type in ('normal','drop','rest_pause')));
create table public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  page int, content text not null, embedding vector(1536));   -- server-only

-- Must be created AFTER group_members (SQL function bodies are validated at CREATE time;
-- creating it first fails with 42P01 - verified)
create or replace function public.is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m
                 where m.group_id = gid and m.user_id = (select auth.uid()));
$$;

alter table public.exercise_sets enable row level security;   -- ...on EVERY table
grant select, insert, update, delete on public.workout_sessions, public.exercise_sets to authenticated;
grant select on public.entitlements, public.groups, public.group_members to authenticated;

-- PowerSync PUT -> PostgREST upsert = INSERT ... ON CONFLICT DO UPDATE, which needs SELECT + INSERT + UPDATE
-- policies. Verified: with only INSERT+UPDATE policies even a brand-new upsert fails with 42501.
create policy "own sessions" on public.workout_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own sets" on public.exercise_sets for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.workout_sessions ws
    where ws.id = workout_session_id and ws.user_id = (select auth.uid())));
create policy "read library, own and group exercises" on public.exercises for select to authenticated
  using ((reviewed and origin in ('dataset','interverse')) or owner_id = (select auth.uid())
         or (group_id is not null and public.is_group_member(group_id)));
create policy "read system and own presets" on public.presets for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy "own entitlement" on public.entitlements for select to authenticated
  using (user_id = (select auth.uid()));          -- no write policy: server/RevenueCat writes it

-- PowerSync replication role (per PowerSync's Supabase guide)
create role powersync_role with replication bypassrls login password '<long random>';
grant usage on schema public to powersync_role;
grant select on all tables in schema public to powersync_role;
alter default privileges in schema public grant select on tables to powersync_role;

-- Publication: exact name "powersync"; everything synced, NOT source_chunks
create publication powersync for table
  public.profiles, public.entitlements, public.study_sessions, public.interval_blocks,
  public.exercises, public.presets, public.equipment_setups, public.workout_sessions,
  public.exercise_sets, public.transitions, public.sources, public.source_files,
  public.study_plans, public.plan_sources, public.topics, public.cards, public.card_links,
  public.reviews, public.groups, public.group_members, public.tracy_events;
-- later migrations: alter publication powersync add table public.<new>;
```

### Replication slot hygiene

- If you delete or let lapse a PowerSync instance (Free instances are deprovisioned after 7 days idle), its slot can pin WAL on Supabase.
- Check with `select slot_name, active, wal_status from pg_replication_slots;` and drop orphaned slots with `pg_drop_replication_slot(...)`.
- The service code handles invalidated slots (`PSYNC_S1146`) by re-replicating.

---

## 3. Auth: Supabase JWTs in PowerSync

### How validation works (`@powersync/service-core` 1.27.0, `compound-config-collector.js` and `auth/utils.js`)

- **Asymmetric signing keys (JWKS).** With `client_auth.supabase: true`, the service derives the JWKS URL from the replication connection's hostname. It must match `^db\.(\w+)\.supabase\.co$`, and becomes `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`.
  - These keys use `requiresAudience: ['authenticated']` and a maximum token lifetime of 7 days + 20 minutes.
  - If you connect through any other hostname, auto-detection logs "Supabase Auth is enabled, but no Supabase connection string found". You must then set `jwks_uri` yourself and add `authenticated` to `additional_audiences`.
- **Legacy HS256.** Used only if `supabase_jwt_secret` is set (the "Supabase JWT Secret (optional) Legacy" dashboard field). It accepts any `kid`.
- **Claims required on every token:** `sub`, `iat`, `exp` and `aud`.
- **Debug messages.** A token that fails verification gets a specific message, for example "Token is a Supabase Legacy HS256 token, but Supabase JWT secret is not configured" or "Supabase project id mismatch".

### Supabase side

- New projects sign with asymmetric keys (RS256 or ES256); the legacy secret is "no longer recommended" ([Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys), [blog](https://supabase.com/blog/jwt-signing-keys)).
- Sources disagree on when this became the default (May 2025 vs Oct 1, 2025). Either way it predates DualRep. Confirm under Project Settings → JWT Keys.
- With asymmetric keys, leave the legacy secret field empty.

### Dashboard steps

1. Open Client Auth.
2. Tick **Use Supabase Auth**.
3. Leave the legacy secret empty.
4. Optionally tick **Development tokens**.
5. Click **Save and Deploy** ([PowerSync Supabase Auth](https://docs.powersync.com/configuration/auth/supabase-auth)).

### Config-as-code equivalent

```yaml
client_auth:
  supabase: true
  allow_temporary_tokens: true   # dev only
```

- **User id.** `auth.user_id()` (Streams) or `request.user_id()` (legacy) equals JWT `sub`, which equals `auth.users.id`.
- **Dev tokens:** `powersync generate token --subject=<auth.users uuid>`. They need `allow_temporary_tokens` and last 12 hours by default ([dev tokens](https://docs.powersync.com/configuration/auth/development-tokens)).

---

## 4. Client: React Native / Expo (Android)

### Install

```bash
npx expo install @powersync/react-native @op-engineering/op-sqlite @supabase/supabase-js @react-native-async-storage/async-storage
npx expo install @azure/core-asynciterator-polyfill   # only if you use async-iterator watch()/getCrudTransactions()
npx expo run:android          # or: eas build --profile development --platform android
```

- **Native module.** op-sqlite is native, so **Expo Go cannot run this; use a development build**. op-sqlite must be a direct dependency for autolinking.
- **HTTP streaming.** The RN SDK picks `expo/fetch` when it is present and uses HTTP streaming; without Expo it falls back to WebSocket (`src/sync/stream/fetch.ts`, `PowerSyncDatabase.ts`).
- **Endpoint.** It must have **no trailing slash**; the SDK throws otherwise.

### JS SDK v2 changes (released 2026-07-21; affects older tutorials)

- React-native-quick-sqlite dropped; op-sqlite is the built-in default.
- `AbstractPowerSyncDatabase` is now a deprecated type alias of `CommonPowerSyncDatabase`.
- The v1 table syntax is removed.
- `CrudEntry` is an interface.
- Logging uses `createConsoleLogger` / `PowerSyncLogger`.
- `SyncStatus.dataFlowStatus` is deprecated; use `status.uploading`, `status.uploadError` and so on.

([RN SDK changelog](https://releases.powersync.com/announcements/react-native-client-sdk), [June–July 2026 changelog](https://powersync.com/blog/powersync-changelog-june-july-2026))

### Schema API (verified in `@powersync/common` 2.3.1)

- **Columns.** `new Table({ col: column.text | column.integer | column.real }, { indexes: { name: ['colA','colB'] }, localOnly?, insertOnly?, trackPrevious?, trackMetadata?, ignoreEmptyUpdates?, viewName? })`.
- **`id` is implicit TEXT.** Never declare it.
- **Limits.** At most 1999 columns. Table names must not contain `" ' % , . # [ ]` or whitespace.
- **`localOnly`.** Never synced or uploaded. Stored in `ps_data_local__<name>`.
- **`insertOnly`.** Writes are uploaded but not kept locally; suits telemetry.
- **Raw tables** (`schema.withRawTables`) exist for advanced cases.
- **Generating the schema.** `powersync generate schema --output=ts --output-path=src/powersync/AppSchema.ts` builds the schema from the instance plus sync config. It also generates typed stream helpers (a `typedStreams(db)` wrapper) for streams that take parameters.

### `src/powersync/AppSchema.ts` (abridged; full 22-table version type-checked)

```ts
import { column, Schema, Table } from '@powersync/react-native';

const workout_sessions = new Table(
  { user_id: column.text, logged_at: column.text, kind: column.text, preset_id: column.text, setup_id: column.text },
  { indexes: { by_user_logged: ['user_id', 'logged_at'] } }
);
const exercise_sets = new Table(
  { user_id: column.text, workout_session_id: column.text, exercise_id: column.text, set_index: column.integer,
    reps: column.integer, weight_lbs: column.real, rpe: column.real, set_type: column.text },
  { indexes: { by_session: ['workout_session_id', 'set_index'], by_exercise: ['exercise_id'] } }
);
const exercises = new Table(
  { name: column.text, muscle_group: column.text, body_region: column.text, category: column.text,
    equipment: column.text /* text[] -> JSON text */, location: column.text, movement_pattern: column.text,
    demand_level: column.integer, micro_ok: column.integer /* bool 0/1 */, origin: column.text,
    reviewed: column.integer, owner_id: column.text, group_id: column.text },
  { indexes: { by_pattern: ['movement_pattern', 'location'], by_owner: ['owner_id'] } }
);
const reviews = new Table(
  { card_id: column.text, user_id: column.text, rating: column.integer, answer_mode: column.text,
    reviewed_at: column.text, due_at: column.text, stability: column.real, difficulty: column.real },
  { indexes: { due: ['user_id', 'due_at'], by_card: ['card_id'] } }
);
const entitlements = new Table({ user_id: column.text, tier: column.text, source: column.text, expires_at: column.text });
const presets = new Table({ name: column.text, split: column.text /* jsonb */, owner_id: column.text });
// ...profiles, study_sessions, interval_blocks(+user_id), equipment_setups, transitions(+user_id), sources,
// source_files(+owner_id,+group_id), study_plans, plan_sources, topics, cards(+plan_id), card_links(+plan_id),
// groups, group_members, tracy_events (light columns only)

// Local-only dead-letter log for uploads the connector had to discard
const upload_failures = new Table(
  { table_name: column.text, row_id: column.text, op: column.text, op_data: column.text,
    error_code: column.text, error_message: column.text, created_at: column.text },
  { localOnly: true }
);

export const AppSchema = new Schema({ workout_sessions, exercise_sets, exercises, reviews, entitlements, presets, upload_failures /*, ...*/ });
export type Database = (typeof AppSchema)['types'];
```

### `src/powersync/SupabaseConnector.ts` (type-checks clean)

```ts
import { type CommonPowerSyncDatabase, type CrudEntry, type PowerSyncBackendConnector,
         type PowerSyncCredentials, UpdateType } from '@powersync/react-native';
import type { SupabaseClient } from '@supabase/supabase-js';

// Retrying cannot fix these; re-throwing would block the FIFO queue forever.
const FATAL_RESPONSE_CODES = [/^22...$/, /^23...$/, /^42501$/]; // data exception, integrity violation, RLS/privilege

// JSON-text columns that must go back to Postgres as real JSON (verified: text[] as a string -> 22P02
// "malformed array literal", jsonb as a string -> silently stored as a JSON *string*).
const JSON_COLUMNS: Record<string, readonly string[]> = {
  exercises: ['equipment'], equipment_setups: ['equipment'], presets: ['split'], transitions: ['proposal']
};
const READ_ONLY_TABLES = new Set(['entitlements', 'tracy_events', 'groups']);

function toPostgres(table: string, data: Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = { ...(data ?? {}) };
  for (const col of JSON_COLUMNS[table] ?? []) {
    const v = out[col];
    if (typeof v === 'string') { try { out[col] = JSON.parse(v); } catch { /* let Postgres reject */ } }
  }
  return out; // booleans as 1/0 are fine: Postgres accepts them for boolean columns (verified)
}

export class SupabaseConnector implements PowerSyncBackendConnector {
  constructor(private readonly supabase: SupabaseClient, private readonly powersyncUrl: string) {}

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const { data, error } = await this.supabase.auth.getSession(); // refreshes an expired token
    if (error) throw error;                 // transient -> SDK retries
    if (!data.session) return null;         // signed out -> stay disconnected
    return {
      endpoint: this.powersyncUrl,          // https://<instance>.powersync.journeyapps.com, no trailing '/'
      token: data.session.access_token,
      expiresAt: data.session.expires_at ? new Date(data.session.expires_at * 1000) : undefined
    };
  }

  async uploadData(database: CommonPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction(); // SDK loops until the queue is empty
    if (!transaction) return;
    let lastOp: CrudEntry | null = null;
    try {
      for (const op of transaction.crud) {
        lastOp = op;
        if (READ_ONLY_TABLES.has(op.table))
          throw Object.assign(new Error(`read-only table ${op.table}`), { code: '42501' });
        const table = this.supabase.from(op.table);
        let result: { error: { code?: string; message: string } | null };
        switch (op.op) {
          case UpdateType.PUT:    // full row: upsert keeps a retried, half-uploaded tx idempotent
            result = await table.upsert({ ...toPostgres(op.table, op.opData), id: op.id }); break;
          case UpdateType.PATCH:  // changed columns only
            result = await table.update(toPostgres(op.table, op.opData)).eq('id', op.id); break;
          case UpdateType.DELETE:
            result = await table.delete().eq('id', op.id); break;
        }
        if (result.error) throw result.error;
      }
      await transaction.complete();
    } catch (ex: unknown) {
      const code = (ex as { code?: unknown })?.code;
      if (typeof code === 'string' && FATAL_RESPONSE_CODES.some((re) => re.test(code))) {
        console.error('PowerSync upload discarded', code, lastOp, ex);
        await database.execute(
          `INSERT INTO upload_failures (id, table_name, row_id, op, op_data, error_code, error_message, created_at)
           VALUES (uuid(), ?, ?, ?, ?, ?, ?, ?)`,
          [lastOp?.table ?? null, lastOp?.id ?? null, lastOp?.op ?? null, JSON.stringify(lastOp?.opData ?? null),
           code, String((ex as { message?: unknown })?.message ?? ex), new Date().toISOString()]);
        await transaction.complete();     // drop it so later writes can flow
      } else {
        throw ex;                          // network/5xx/expired JWT: SDK retries after retryDelayMs (5 s default)
      }
    }
  }
}
```

- **Where the pattern comes from.** It matches the canonical powersync-js Supabase demo connector and PowerSync's guidance against blocking the queue ([writing data](https://docs.powersync.com/client-sdks/writing-data), [connector performance](https://docs.powersync.com/integrations/supabase/connector-performance)).
- **What I couldn't check.** GitHub could not be opened, so the exact upstream file was not re-read.
- **What I added and why:**
  - **JSON parsing.** The text[] and jsonb columns are re-parsed before upload; without this, uploads fail or store the wrong JSON type.
  - **Dead-letter log.** Discarded operations are written to the local-only `upload_failures` table so they are not lost silently.
  - **Read-only guard.** Writes to server-owned tables are rejected locally.

### SDK upload behaviour (`@powersync/shared-internals`)

- The SDK calls `uploadData` repeatedly while the queue has items.
- If the same first item is still queued after a call, it logs "Potentially previously uploaded CRUD entries are still present" and backs off.
- Defaults: `retryDelayMs` 5000, `crudUploadThrottleMs` 1000.
- A 401 from PowerSync invalidates the credentials and calls `fetchCredentials()` again.

### `src/powersync/db.ts`

```ts
import { createConsoleLogger, LogLevels, PowerSyncDatabase } from '@powersync/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { AppSchema } from './AppSchema';
import { SupabaseConnector } from './SupabaseConnector';

export const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
AppState.addEventListener('change', (s) => (s === 'active' ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh()));

export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'dualrep.sqlite' },  // or { factory: new OPSqliteOpenFactory({...}) } for SQLCipher etc.
  logger: createConsoleLogger({ minLevel: __DEV__ ? LogLevels.debug : LogLevels.warn })
});
export const connector = new SupabaseConnector(supabase, process.env.EXPO_PUBLIC_POWERSYNC_URL!);

export async function startSync() { await db.init(); await db.connect(connector); }      // all streams auto_subscribe
export async function signOut() { await db.disconnectAndClear(); await supabase.auth.signOut(); }
```

- **React hooks.** `@powersync/react` (re-exported by the RN package) provides `PowerSyncContext`, `useQuery`, `useStatus`, `useSyncStream` and `useSuspenseQuery`.
- **Fast first render.** `db.waitForFirstSync({ priority: 1 })` resolves once the `priority: 1` streams (`user_private` and `library`) are in, before the rest have synced.

---

## 5. Data representation on the client

The mapping below is verified in code (`ExpressionType.expressionTypeFromPostgresType`, `jpgwire PgType.decode`, `utils.filterJsonData`) and matches [Types](https://docs.powersync.com/sync/types) and [JSON, arrays and custom types](https://docs.powersync.com/client-sdks/advanced/custom-types-arrays-and-json).

| Postgres | SQLite on device | Notes |
|---|---|---|
| `uuid`, `text`, enum, `date` (`YYYY-MM-DD`) | TEXT | |
| `bool` | INTEGER 1/0 | Query with `= 1`. Writing 1/0 back through PostgREST works (verified). |
| `int2/4/8` | INTEGER | |
| `float4/8` | REAL | |
| `numeric` | **TEXT** | Use `double precision` for `weight_lbs`, `rpe`, `stability` and `difficulty`. |
| `json` / `jsonb` | TEXT (JSON passed through) | Read with `->>` / `json_extract('$.x')`. **`JSON.parse` before upload.** |
| arrays (`text[]`) | TEXT JSON array `["a","b"]` | Read with `json_each`. **`JSON.parse` before upload** (22P02 otherwise). |
| `timestamptz` | TEXT ISO-8601 UTC | Format depends on edition and precision; see below. |
| `bytea` | blob | Docs say it doesn't sync usefully; convert to hex or base64. |
| `vector` / unknown | TEXT | Don't sync. |

**Timestamp format, verified by running the converter:** for source value `2026-10-08 09:30:00.123456+00`:

| Config | Output |
|---|---|
| edition 1 | `2026-10-08 09:30:00.123456Z` |
| edition 3 | `2026-10-08T09:30:00.123456Z` (always 6 fractional digits) |
| edition 3 + `timestamp_max_precision: milliseconds` | `2026-10-08T09:30:00.123Z` |

**Recommendation:**

- Store `timestamptz` in Postgres.
- Write `new Date().toISOString()` on the client.
- Set `timestamp_max_precision: milliseconds`, as in the config above.

Server-synced and locally written values then share one format, so `ORDER BY`, string comparison and `Date` parsing behave the same. Mixing `.123Z` with `.123000Z` breaks lexicographic order.

**Booleans inside JSON.** Even in edition 3, booleans inside source arrays or composites become 1/0 unless `fixed_booleans_in_json: true` is set (verified). jsonb column text passes through untouched either way.

---

## 6. Pricing, self-hosting, and 2025–2026 changes

### PowerSync Cloud plans

Numbers come from search extracts of [powersync.com/pricing](https://powersync.com/pricing) and the [billing FAQ](https://docs.powersync.com/resources/usage-and-billing/usage-and-billing-faq); I could not open those pages directly.

| Plan | Price | Data synced | Hosted | Peak concurrent connections | Other |
|---|---|---|---|---|---|
| Free | $0 | 2 GB/month | 500 MB | 50 | 2 instances. **Deprovisioned after 7 days without deploys or client connections.** |
| Pro | from $49/month | 30 GB (then $1/GB) | 10 GB (then $1/GB) | 1,000 (then $30 per 1,000) | No deactivation. |
| Team | from $599/month | | | | Roles, SLA, SOC 2/HIPAA. |
| Enterprise | custom | | | | |

- **How data synced is counted.** It is the uncompressed bytes sent to devices; the same row sent to N users counts N times.
- **When the connection cap is reached,** new connections get HTTP 429.
- **Conflict to resolve before budgeting.** One FAQ snippet says Pro is capped at 3,000 concurrent connections.
- **Pricing change on 2025-09-12.** Data synced became the only throughput metric, and the connection overage went from $15 to $30 per 1,000 ([blog](https://powersync.com/blog/simplified-cloud-pricing-based-on-data-synced)).

### Self-hosting (Open Edition)

- **Licence.** Source-available under FSL-1.1-ALv2; each release converts to Apache 2.0 after 2 years. The client SDKs are Apache/MIT ([licensing](https://powersync.com/legal/licensing-terms), [Open Edition](https://powersync.com/blog/powersync-open-edition-release)).
- **Image.** Docker `journeyapps/powersync-service`, current 1.27.0. Bucket storage can be MongoDB or Postgres.
- **CLI.** `powersync init self-hosted`, then `powersync docker configure --database postgres --storage postgres`, then `powersync docker start`. Self-hosted instances support `status`, `validate`, `generate schema` and `generate token`, but not `deploy` ([local dev](https://docs.powersync.com/tools/local-development)).
- **Security fix.** Pin to at least 1.20.1 because of CVE-2026-30870: in service 1.20.0, edition-3 subquery filters were ignored ([advisory](https://github.com/advisories/GHSA-q6wc-xx4m-92fj)).

### What changed in 2025–2026

- **Sync Streams:** alpha (Sept 2025), then beta (Feb/Mar 2026), then GA (May 2026). The edition-3 compiler added JOINs, CTEs and multiple queries per stream; GA added global CTEs and typed client wrappers. Sync Rules became legacy, with `powersync migrate sync-rules` or a dashboard button to convert.
- **New CLI** (`powersync` npm package, 0.9.0 on 2026-03-04; not compatible with 0.8): config-as-code with `deploy`, `validate`, `generate schema`, `migrate` and `docker`. The CLI is still marked beta. Its README points to `@powersync/cli@0.8.0` for the old CLI, but that name returns 404 on npm.
- **JS SDK v2** (July 2026): see section 4.
- **Supabase auth:** automatic JWKS support for Supabase's asymmetric signing keys.
- **Pricing:** the Sept 2025 change above.
- **Storage:** storage version 4 rolling out to Free instances (beta).
- **Supabase:** asymmetric JWT keys became the default (2025), and the explicit-grants default for new projects started May 30, 2026.

---

## 7. Verifying the Phase 0 gate on Android

1. **Before testing.**
   - Run `powersync validate`, then `powersync deploy`.
   - Run `powersync status`; it should show connections green and replication active.
   - In Supabase, `select * from pg_replication_slots;` should list an active PowerSync slot.
2. **First sync.** Install the dev build on a physical Android phone. Sign in, `await db.waitForFirstSync()`, and confirm library rows exist: `select count(*) from exercises`.
3. **Go offline.**
   - Turn on airplane mode. On an emulator, `adb shell cmd connectivity airplane-mode enable` should work (unverified); alternatively run `adb shell svc wifi disable; adb shell svc data disable`.
   - Confirm `db.currentStatus.connected === false`.
4. **Write offline.**
   - Insert: `INSERT INTO workout_sessions (id, user_id, logged_at, kind) VALUES (uuid(), ?, ?, 'micro')`. `uuid()` is provided by the PowerSync SQLite extension.
   - `await db.getUploadQueueStats(true)` should show `count >= 1` (pass `true` to also get the byte size).
   - The row is readable locally.
   - Optional: force-quit and relaunch while offline, and confirm the queue count survives.
5. **Reconnect.**
   - Disable airplane mode. The SDK reconnects on its own (about 5 s retry).
   - Watch `db.registerListener({ statusChanged: s => … })`, or `useStatus()`, for `uploading` → false, `uploadError` undefined, and `connected` true.
   - Poll until `getUploadQueueStats().count === 0`.
   - Check that `upload_failures` is empty.
   - Read logs with `adb logcat -s ReactNativeJS`.
6. **Check Postgres.** In the Supabase SQL editor: `select id, user_id, kind, logged_at from public.workout_sessions where id = '<probe id>';`.
7. **Check the round trip (optional).** Update the row server-side and confirm the change appears on the phone.
8. **If the row never reaches Postgres.** An empty queue with no row usually means 42501: a missing GRANT, or a missing SELECT/INSERT/UPDATE policy. The connector discarded it, so check `upload_failures`.

**Testing sync config:**

- **Locally:** `powersync validate` (schema, connections and sync config; `--output=json` for CI) and `powersync deploy --dry-run`.
- **Dashboard:** the dashboard validates on deploy, and its **Sync Test** page launches the Sync Diagnostics Client ([diagnostic app](https://docs.powersync.com/usage/tools/diagnostic-app), [diagnostics-app.powersync.com](https://diagnostics-app.powersync.com/)).
- **Testing as a real user:** generate a dev token with `--subject=<real auth.users uuid>`, then check tables, buckets and stream subscriptions per user.
- **Offline compile check:** I ran `@powersync/service-sync-rules`' `SqlSyncRules.fromYaml()` directly. It is an internal package, "not intended to be used directly", and needs Node 24 or `--js-explicit-resource-management` on Node 22. Use it only as a supplement.

---

## 8. Config as code (in the DualRep repo)

`powersync init cloud` scaffolds this layout. All files support `!env VAR` (or `!env VAR::number`).

```
powersync/
  service.yaml        # instance config (connections, client_auth)
  sync-config.yaml    # the Sync Streams YAML from section 1
  cli.yaml            # written by `powersync link cloud` (instance link; no secrets)
```

```yaml
# powersync/service.yaml
_type: cloud
name: dualrep-dev
region: eu            # or us; cannot be changed after first deploy
replication:
  connections:
    - type: postgresql
      uri: postgresql://powersync_role@db.<project-ref>.supabase.co:5432/postgres   # hostname enables Supabase JWKS auto-detect
      password:
        secret: !env POWERSYNC_DATABASE_PASSWORD   # after first deploy you may switch to: secret_ref: default_password
      sslmode: verify-full
client_auth:
  supabase: true
  allow_temporary_tokens: true                     # dev instance only
```

**Workflow (CI uses `PS_ADMIN_TOKEN` and `INSTANCE_ID`):**

```sh
npx powersync login
npx powersync link cloud --create --project-id=<id>      # or: powersync pull instance --instance-id=<id>
npx powersync validate && npx powersync deploy            # deploy sync-config / service-config also exist
npx powersync generate schema --output=ts --output-path=src/powersync/AppSchema.ts
```

- **Self-hosted equivalent:** `_type: self-hosted` with `api.tokens`.
- **Commit and secrets.** Commit everything except secrets; the password and admin token stay in environment variables.

([CLI README / npm](https://www.npmjs.com/package/powersync), [CLI docs](https://docs.powersync.com/tools/cli))

---

## Sources

- **PowerSync docs:**
  - [Sync Streams overview](https://docs.powersync.com/sync/streams/overview)
  - [Queries](https://docs.powersync.com/sync/streams/queries)
  - [Examples](https://docs.powersync.com/sync/streams/examples)
  - [Client usage](https://docs.powersync.com/sync/streams/client-usage)
  - [Supported SQL](https://docs.powersync.com/sync/supported-sql)
  - [Grammar](https://docs.powersync.com/sync/grammar/sync-streams)
  - [Compatibility](https://docs.powersync.com/sync/advanced/compatibility)
  - [Types](https://docs.powersync.com/sync/types)
  - [JSON / arrays](https://docs.powersync.com/client-sdks/advanced/custom-types-arrays-and-json)
  - [Supabase guide](https://docs.powersync.com/integrations/supabase/guide)
  - [Supabase Auth](https://docs.powersync.com/configuration/auth/supabase-auth)
  - [Dev tokens](https://docs.powersync.com/configuration/auth/development-tokens)
  - [Setup guide](https://docs.powersync.com/intro/setup-guide)
  - [RN & Expo SDK](https://docs.powersync.com/client-sdks/reference/react-native-and-expo)
  - [Writing data](https://docs.powersync.com/client-sdks/writing-data)
  - [Connector performance](https://docs.powersync.com/integrations/supabase/connector-performance)
  - [CLI](https://docs.powersync.com/tools/cli)
  - [Local dev](https://docs.powersync.com/tools/local-development)
  - [Self-hosted config](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances)
  - [Billing FAQ](https://docs.powersync.com/resources/usage-and-billing/usage-and-billing-faq)
  - [Diagnostic app](https://docs.powersync.com/usage/tools/diagnostic-app)
- **PowerSync releases and blog:**
  - [Sync Streams GA](https://releases.powersync.com/announcements/sync-streams-are-now-generally-available)
  - [Sync Streams beta](https://releases.powersync.com/announcements/sync-streams-are-now-in-beta)
  - [May 2026 changelog](https://powersync.com/blog/powersync-changelog-may-2026)
  - [June–July 2026 changelog](https://powersync.com/blog/powersync-changelog-june-july-2026)
  - [RN SDK changelog](https://releases.powersync.com/announcements/react-native-client-sdk)
  - [Pricing](https://powersync.com/pricing)
  - [Pricing change 2025-09](https://powersync.com/blog/simplified-cloud-pricing-based-on-data-synced)
  - [Licensing](https://powersync.com/legal/licensing-terms)
  - [Open Edition](https://powersync.com/blog/powersync-open-edition-release)
  - [CVE-2026-30870](https://github.com/advisories/GHSA-q6wc-xx4m-92fj)
- **npm (source read directly):**
  - [powersync CLI](https://www.npmjs.com/package/powersync)
  - [@powersync/service-sync-rules](https://www.npmjs.com/package/@powersync/service-sync-rules)
  - [@powersync/service-core](https://www.npmjs.com/package/@powersync/service-core)
  - [@powersync/service-module-postgres](https://www.npmjs.com/package/@powersync/service-module-postgres)
  - [@powersync/service-jpgwire](https://www.npmjs.com/package/@powersync/service-jpgwire)
  - [@powersync/common](https://www.npmjs.com/package/@powersync/common)
  - [@powersync/react-native](https://www.npmjs.com/package/@powersync/react-native)
  - [@powersync/cli-plugin-docker](https://www.npmjs.com/package/@powersync/cli-plugin-docker)
- **Supabase:**
  - [JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
  - [Signing keys blog](https://supabase.com/blog/jwt-signing-keys)
  - [Replication FAQ](https://supabase.com/docs/guides/database/replication/faq)
  - [Connecting](https://supabase.com/docs/guides/database/connecting-to-postgres)
  - [IPv4 add-on](https://supabase.com/docs/guides/platform/ipv4-address)
  - [Data API grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
  - [Securing your API](https://supabase.com/docs/guides/api/securing-your-api)

## Open risks
- docs.powersync.com, powersync.com, releases.powersync.com and supabase.com could not be opened during research. Every doc, pricing and release claim comes from search-engine extracts. Code-level behaviour was verified from the npm package sources instead.
- Pricing and free-tier numbers ($0 with 2 GB synced, 500 MB hosted, 50 connections, 7-day deprovisioning; Pro from $49) were not read from powersync.com/pricing directly. One FAQ snippet also mentions a 3,000-connection cap on Pro. Confirm on the pricing page before budgeting.
- In edition-3 Sync Streams, a query that does not select an `id` column compiles with no diagnostic. At runtime it syncs only one arbitrary row per table. Every stream query must include `id`; consider a CI check for this.
- The connector discards transactions that fail with 42501. Since May 30, 2026, new Supabase projects need explicit GRANTs, and upserts need SELECT + INSERT + UPDATE policies. A missing grant or policy therefore drops offline writes without visible errors. Watch the local `upload_failures` table and test every client-written table.
- Uploading JSON-text array or jsonb columns without JSON.parse either fails with 22P02 (then silently discarded) or stores a JSON string instead of an object. This was verified on Postgres 18 via json_populate_recordset; that PostgREST takes the same code path is an assumption.
- Supabase JWKS auto-detection only works when the replication connection hostname is db.<ref>.supabase.co (the direct connection). Any other hostname needs a manual jwks_uri plus `authenticated` in additional_audiences.
- The Supabase direct connection is IPv6. A self-hosted PowerSync on an IPv4-only network needs the Supabase IPv4 add-on. Whether PowerSync Cloud connects over IPv6 was not directly confirmed.
- Free-plan PowerSync instances are deprovisioned after 7 idle days. An orphaned replication slot can then pin WAL on Supabase. Monitor pg_replication_slots.
- Child tables need denormalized owner columns (user_id on interval_blocks, exercise_sets and transitions; plan_id on cards and card_links; owner_id and group_id on source_files). Otherwise they get one bucket per parent row and can exceed the 1000 buckets per connection limit. These columns are not in the plan's data model yet.
- @powersync/react-native 2.x (July 2026) is a new major version. The Android development build with op-sqlite 18.x could not be compiled during research (no Android SDK was available). Confirm `npx expo run:android` builds early in Phase 0.
- Whether Hermes parses ISO timestamps with 6 fractional digits was not verified. Setting timestamp_max_precision: milliseconds avoids the question.
- The Sync Streams GA date (May 14, 2026) comes from a release note seen only through search. Some docs pages may still say Beta. The PowerSync CLI itself is still beta, and its README references @powersync/cli@0.8.0, which returns 404 on npm.
- The Oct 30, 2026 date when Supabase applies the explicit-grants default to existing projects comes only from secondary sources. Sources also disagree on when asymmetric JWT keys became the default for new projects. Check the DualRep project's JWT Keys page.
- The adb airplane-mode command (`cmd connectivity airplane-mode enable`) is unverified. Fall back to `svc wifi/data disable` or the quick-settings toggle.
- Self-hosted PowerSync must be version 1.20.1 or later because of CVE-2026-30870; the current release is 1.27.0.
