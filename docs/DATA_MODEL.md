# Data model

What is in the database, who writes each table, how each table reaches the phone, and how it is
protected. It describes the first migration as built:
[`supabase/migrations/20261008000000_initial_schema.sql`](../supabase/migrations/20261008000000_initial_schema.sql).
When this page and the migration disagree, the migration wins.

Related files:

| File | What it is |
|---|---|
| [`supabase/migrations/`](../supabase/migrations/) | The schema, RLS policies, grants, triggers, system presets and the `powersync` publication |
| [`supabase/tests/`](../supabase/tests/) | pgTAP tests for every table and policy (`npm run db:test`, or `supabase test db`) |
| [`supabase/schema.snapshot.json`](../supabase/schema.snapshot.json) | Column list per table, written by `npm run db:test`, read by `npm run validate:sync` |
| [`powersync/sync-config.yaml`](../powersync/sync-config.yaml) | The Sync Streams: which rows each phone receives |
| [`src/db/tables.ts`](../src/db/tables.ts) | The app's registry of synced tables: columns, local indexes and what the device may write |

---

## 1. Ground rules (every table)

- **Names:** schema `public`, lowercase plural table names.
- **Primary key:** `id uuid primary key default gen_random_uuid()`. The phone makes its own UUIDs
  (`expo-crypto` `randomUUID()`) so rows can be created offline; the default serves rows made on the
  server.
- **Timestamps:** `created_at` and `updated_at timestamptz not null default now()`. The server owns
  `updated_at`: a shared `set_updated_at()` trigger sets it on every update, and the device never
  uploads it.
- **Enumerations:** `text` plus a `CHECK`, not Postgres enum types (adding a value is a one-line
  migration).
- **JSON and lists:** `jsonb`. Lists are `jsonb` arrays with `CHECK (jsonb_typeof(x) = 'array')`.
- **Numbers with fractions:** `double precision`, never `numeric` (PowerSync would deliver `numeric` as
  TEXT).
- **Account deletion:** every user reference is `references auth.users (id) on delete cascade`.
  Deleting the auth user deletes all of that person's data, which Google Play requires.
- **Indexes:** every foreign key and every column used by RLS or a sync filter is indexed.
- **RLS is on for all 23 tables.** Policies are `to authenticated` and use `(select auth.uid())`, so
  Postgres evaluates it once per statement. Checks that read other tables go through
  `security definer` helper functions with `set search_path = ''`.
- **Grants are explicit.** Supabase projects created since 2026-05-30 grant nothing on new tables by
  default (older projects granted everything). Each table starts with
  `revoke all ... from anon, authenticated` and then grants exactly what the device may do. `anon` gets
  nothing. `service_role` (Edge Functions, webhooks) gets everything and bypasses RLS. A missing grant
  shows up as error **42501**, the same code as an RLS denial.

### What the phone sees

PowerSync stores synced rows in on-device SQLite with three column types:

| Postgres | On the phone | Watch out |
|---|---|---|
| `uuid`, `text`, `date`, `timestamptz` | TEXT | Timestamps arrive as `2026-10-08T09:30:00.123Z`, the same format as `new Date().toISOString()` (the sync config sets millisecond precision) |
| `boolean` | INTEGER 1/0 | Compare with `= 1` / `= 0` |
| `smallint`, `integer` | INTEGER | |
| `double precision` | REAL | |
| `jsonb` | TEXT holding JSON | `JSON.parse` when reading |

The upload code ([`src/db/upload.ts`](../src/db/upload.ts)) converts 1/0 back to booleans and parses
JSON text back to JSON before sending, so app code writes the same shapes it reads.

### How a phone write reaches Postgres

The phone writes to local SQLite only. PowerSync queues each change, and the connector
([`src/db/connector.ts`](../src/db/connector.ts)) replays it through the Supabase Data API (PostgREST),
so every write passes the same grants and RLS as any other request:

| Local change | Sent as | Needs |
|---|---|---|
| Insert (PUT), "upsert" tables | `INSERT ... ON CONFLICT (id) DO UPDATE` | SELECT + INSERT + UPDATE grants and policies |
| Insert (PUT), "insert-ignore" tables (`reviews`, `groups`) | `INSERT ... ON CONFLICT (id) DO NOTHING` | INSERT (and SELECT on `id`) |
| Update (PATCH) | `UPDATE ... SET <changed columns> WHERE id = ...` (never `updated_at`) | UPDATE on those columns |
| Delete | `DELETE ... WHERE id = ...` | DELETE |

Postgres checks the SELECT policy against a row being upserted too, so every SELECT policy admits any
row its INSERT policy admits. A write the server rejects for good (codes `22xxx`, `23xxx`, `42501`) is
recorded in the local-only **`upload_failures`** table and dropped from the queue so later writes keep
flowing. The Sync Check screen shows that table.

### The sync streams (who receives what)

From [`powersync/sync-config.yaml`](../powersync/sync-config.yaml). Every stream subscribes
automatically; the app never subscribes by hand.

| Stream | Bucket | Contents |
|---|---|---|
| `user_private` (priority 1) | One per user | The user's `profiles` row, `entitlements`, `study_sessions`, `interval_blocks`, `equipment_setups`, `workout_sessions`, `exercise_sets`, `transitions`, `card_states`, `reviews`, and `tracy_events` (light columns only) |
| `library` (priority 1) | One shared by everyone | Reviewed library `exercises` (`owner_id IS NULL AND reviewed = true`) and the six system `presets` |
| `user_owned` | One per user | Rows the user owns in shareable tables: `exercises`, `presets`, `sources`, `source_files`, `study_plans`, `groups` |
| `group_shared` | One per group the user is in | That group's `groups` row, `group_members`, fellow members' `profiles`, and group-shared `exercises`, `sources`, `source_files`, `study_plans` |
| `plan_content` | One per study plan the user can read | `plan_sources`, `topics`, `cards`, `card_links` |

`source_chunks` is never synced and is not in the `powersync` publication. Each stream mirrors an RLS
SELECT policy, so a phone never receives a row its user could not read through the API.

---

## 2. Tables at a glance

"Device may" is what the phone can do through PowerSync (from [`src/db/tables.ts`](../src/db/tables.ts));
RLS narrows it further to the user's own rows.

| Table | What it holds | Device may | Stream(s) |
|---|---|---|---|
| `profiles` | One row per user: name, units, defaults, FSRS settings | create, edit | `user_private`, `group_shared` |
| `entitlements` | Free or subscription tier | read only | `user_private` |
| `presets` | Focus presets (system and custom) | create, edit, delete own | `library`, `user_owned` |
| `equipment_setups` | Gym and home equipment lists | create, edit, delete | `user_private` |
| `exercises` | Library plus user and group exercises | create, edit, delete own | `library`, `user_owned`, `group_shared` |
| `study_sessions` | A sitting of focused study | create, edit, delete | `user_private` |
| `interval_blocks` | One focus block | create, edit, delete | `user_private` |
| `workout_sessions` | One training session | create, edit, delete | `user_private` |
| `exercise_sets` | One logged set | create, edit, delete | `user_private` |
| `transitions` | Focus block → move block handoff | create, edit, delete | `user_private` |
| `groups` | Friend groups | create (insert-ignore), rename, delete | `user_owned`, `group_shared` |
| `group_members` | Who is in which group | delete (leave / remove) | `group_shared` |
| `sources` | Uploaded study material | create, edit, delete | `user_owned`, `group_shared` |
| `source_files` | Files and photos of a source | create, edit, delete | `user_owned`, `group_shared` |
| `source_chunks` | Embedded text chunks | nothing (server only) | never synced |
| `study_plans` | Single or cumulative plans | create, edit, delete | `user_owned`, `group_shared` |
| `plan_sources` | Which sources a plan uses | create, edit, delete | `plan_content` |
| `topics` | A plan's outline | create, edit, delete | `plan_content` |
| `cards` | Quiz cards | create, edit, delete | `plan_content` |
| `card_links` | Concept map links | create, edit, delete | `plan_content` |
| `card_states` | Current FSRS state per user per card | create, edit, delete | `user_private` |
| `reviews` | Append-only answer log | create (insert-ignore) | `user_private` |
| `tracy_events` | Tracy job queue and audit log | set `accepted` only | `user_private` (light columns) |

---

## 3. Table by table

Every table also has `id`, `created_at` and `updated_at`. A `?` marks a nullable column.

### Account and billing

**`profiles`**: `id` (= `auth.users.id`, no default), `display_name` text (≤ 80, default `''`),
`unit_pref` text (`lb`/`kg`, default `lb`), `default_block_minutes` integer (10–50, default 25),
`default_preset_id` uuid? → presets (set null), `default_setup_id` uuid? → equipment_setups (set null),
`fsrs_params` jsonb? (null = ts-fsrs defaults).
- **Written by:** the `handle_new_user()` trigger when an auth user is created (name from
  `raw_user_meta_data.display_name`, else the email's local part); then the user.
- **RLS:** read own row and group mates' rows (`shares_group_with`); insert and update own; no delete
  (deletion cascades from `auth.users`). **Grants:** select, insert, update.

**`entitlements`**: `user_id` uuid (unique) → auth.users, `tier` text (`free`/`subscription`, default
`free`), `source` text (`none`/`store`/`beta`, default `none`), `expires_at` timestamptz?.
- **Written by:** the service role only (the RevenueCat webhook in Phase 5, beta tooling by hand).
  `handle_new_user()` creates a `free`/`none` row for every new user.
- **RLS:** read own. **Grants:** select only.
- `public.has_paid_access(uid)` is true when `tier = 'subscription'` and `expires_at` is null or in the
  future. A signed-in user can only ask about themselves; the service role and plain SQL can ask about
  anyone. See [SETUP.md](SETUP.md#14-give-yourself-beta-access-for-testing) for granting beta access.

### Training

**`presets`**: `owner_id` uuid? (null = system preset), `name` text (1–60), `kind` text
(`all_lower`, `mostly_lower`, `full_body`, `mostly_upper`, `all_upper`, `mostly_cardio`, `custom`),
`split` jsonb (an object with exactly `lower`, `upper`, `core`, `cardio`, each 0–100, summing to 100;
checked by `is_valid_split`).
- **System presets** are inserted by the migration with fixed ids, so every environment has them and
  the app can refer to them before the first sync (`SYSTEM_PRESET_IDS` in
  [`src/db/constants.ts`](../src/db/constants.ts)):

  | id | Name | lower / upper / core / cardio |
  |---|---|---|
  | `00000000-0000-4000-8000-0000000000a1` | All lower body | 100 / 0 / 0 / 0 |
  | `00000000-0000-4000-8000-0000000000a2` | Mostly lower body | 70 / 15 / 15 / 0 |
  | `00000000-0000-4000-8000-0000000000a3` | Full body | 25 / 50 / 25 / 0 |
  | `00000000-0000-4000-8000-0000000000a4` | Mostly upper body | 15 / 70 / 15 / 0 |
  | `00000000-0000-4000-8000-0000000000a5` | All upper body | 0 / 100 / 0 / 0 |
  | `00000000-0000-4000-8000-0000000000a6` | Mostly cardio | 10 / 10 / 10 / 70 |

  Full body is "even across push, pull, legs and core", so push + pull = upper 50.
- **RLS:** read system and own; insert, update, delete own only (system rows are read-only).

**`equipment_setups`**: `user_id`, `name` text (1–60), `location` text (`gym`/`home`), `equipment`
jsonb array of equipment keys (default `[]`).
- **RLS:** own rows only, all operations.

**`exercises`**: `name` text, `muscle_group` text?, `secondary_muscles` jsonb array, `body_region` text?
(`lower`, `upper`, `core`, `full`, `cardio`), `category` text? (`strength`, `power`, `conditioning`,
`mobility`), `dataset_category` text?, `equipment` jsonb array (items the exercise needs), `location`
text (`gym`, `home`, `both`; default `both`), `movement_pattern` text? (`squat`, `hinge`, `lunge`,
`horizontal_push`, `vertical_push`, `horizontal_pull`, `vertical_pull`, `carry`, `core`,
`conditioning`, `mobility`, `other`), `demand_level` smallint? (1–3), `level` text? (`beginner`,
`intermediate`, `expert`), `force` text? (`push`, `pull`, `static`), `mechanic` text? (`compound`,
`isolation`), `micro_ok` boolean, `instructions` jsonb array, `images` jsonb array, `origin` text
(`dataset`, `interverse`, `user`), `dataset_id` text? (unique), `reviewed` boolean (default false),
`owner_id` uuid?, `group_id` uuid? → groups (cascade).
- Two checks: a row has an owner exactly when `origin = 'user'`, and only `user` rows can belong to a
  group.
- **Written by:** library rows (`dataset`, `interverse`) by the service role only (the Phase 1 import
  script and curation); `user` rows by their owner.
- **RLS:** read reviewed library rows, own rows, and rows of the user's groups. Insert own `user` rows
  (into a group only if a member). Update and delete check ownership only, so an owner who left a
  group can still edit or delete their exercise; the new row must still pass the insert rules.
- Library rows sync only once `reviewed = true`. The dataset import arrives with `reviewed = false`.

**`workout_sessions`**: `user_id`, `logged_at` timestamptz (default now), `kind` text (`micro`, `full`,
`walk`), `preset_id` uuid? → presets (set null), `setup_id` uuid? → equipment_setups (set null),
`duration_minutes` integer? (≥ 0).
- **RLS:** own rows only.

**`exercise_sets`**: `user_id` (copy of the session's owner), `workout_session_id` → workout_sessions
(cascade), `exercise_id` → exercises (**restrict**: an exercise with logged sets cannot be deleted),
`set_index` integer (≥ 0), `reps` integer?, `weight_lbs` double precision?, `rpe` double precision?
(1–10), `target_reps` integer?, `target_weight_lbs` double precision?, `rest_seconds` integer?,
`set_type` text (`normal`, `drop`, `rest_pause`).
- **RLS:** own rows, and on write the parent workout session must also be the user's.

### Study sessions and the handoff

**`study_sessions`**: `user_id`, `plan_id` uuid? → study_plans (set null), `focus_subject` text
(≤ 200).
- **RLS:** own rows; on write, `plan_id` must be null or a plan the user can read.
- The Phase 0 **Sync Check** writes its probe rows here, with `focus_subject` starting
  `Sync check ` (see [SETUP.md](SETUP.md#12-run-the-sync-check-the-phase-0-gate)).

**`interval_blocks`**: `user_id` (copy of the session's owner), `study_session_id` → study_sessions
(cascade), `planned_minutes` integer (1–120), `started_at` timestamptz?, `ended_at` timestamptz?,
`interrupted` boolean, `effort_rating` smallint? (1–5), `mode` text (`seated`, `on_the_go`).
- **RLS:** own rows, and on write the parent study session must also be the user's.

**`transitions`**: `user_id` (copy), `interval_block_id` → interval_blocks (cascade),
`workout_session_id` uuid? → workout_sessions (set null), `proposal` jsonb (default `{}`), `accepted`
boolean?.
- **RLS:** own rows, and on write the parent interval block must also be the user's.

### Groups

**`groups`**: `owner_id` → auth.users, `name` text (1–60), `invite_code` text (unique, 8 characters
from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, made by `generate_invite_code()`).
- An AFTER INSERT trigger adds the owner to `group_members` with role `owner`.
- **RLS:** read as owner or member; create only if `owner_id` is you **and** `has_paid_access` (free
  users join, subscribers create and host); rename and delete as owner.
- **Grants:** select, insert, delete, and `update (name)` only, so `owner_id` and `invite_code` can't
  be changed by the device. Because of that column grant, the device uploads a new group as
  insert-ignore (`ON CONFLICT DO NOTHING`); an upsert would fail with 42501.

**`group_members`**: `group_id` → groups (cascade), `user_id` → auth.users, `role` text (`owner`,
`member`); unique `(group_id, user_id)`.
- **Joining** goes only through the RPC **`join_group(p_invite_code)`**: case-insensitive code lookup,
  returns the group id; error `invalid_invite_code` (P0002) for an unknown code, `group_full` (P0001)
  at 8 members, `not_authenticated` (42501) without a user; joining twice is harmless. Only
  `authenticated` may call it.
- A BEFORE INSERT trigger enforces **at most 8 members**, locking the group row first so two people
  joining at once can't both take the last seat.
- **RLS:** read own memberships and the rosters of your groups; delete: a member can leave (the owner
  can't; they delete the group instead), and the owner can remove others. **Grants:** select, delete.

### Study material

**`sources`**: `owner_id`, `group_id` uuid? → groups (set null), `kind` text (`pdf`, `doc`, `link`,
`notes`), `title` text, `url` text?, `status` text (`pending`, `processing`, `ready`, `failed`).
- **RLS:** read own and group-shared; write own, and share only into a group you belong to.
- Changing a source's owner or group carries its files and chunks along (trigger).

**`source_files`**: `source_id` → sources (cascade), `owner_id` and `group_id` (**copied from the
source by a trigger**; whatever the device sends is overwritten), `storage_path` text, `page`
integer?, `transcript` text?, `confirmed` boolean (default false).
- **RLS:** read by the copied owner/group; write only if you can edit the source.
- Photos of handwritten notes keep `confirmed = false` until the user checks the transcription.

**`source_chunks`** (server only): `source_id` → sources (cascade), `owner_id`, `group_id` (copied
from the source), `page` integer?, `content` text, `embedding` `extensions.vector(1536)`?,
`embed_model` text? (for example `gemini-embedding-2@1536`). HNSW index on `embedding`
(`vector_cosine_ops`).
- **Written by:** Edge Functions with the service role (Phase 2).
- **RLS:** read like sources (for retrieval through the API). **Grants:** select only.
- **Never synced** to phones and not in the `powersync` publication: embeddings are large.

**`study_plans`**: `owner_id`, `group_id` uuid? → groups (set null), `title` text, `scope` text
(`single`, `cumulative`), `goal` text, `target_date` date?.
- **RLS:** like sources. Group members read; only the owner edits the plan and its content.

**`plan_sources`**: `plan_id` → study_plans (cascade), `source_id` → sources (cascade), `added_at`
timestamptz; unique `(plan_id, source_id)`.
- **RLS:** read with the plan; insert and update require editing the plan **and** reading the source;
  update and delete only check the plan, so the owner can remove a link to a source that is no longer
  readable.

**`topics`**: `plan_id` → study_plans (cascade), `title` text, `position` integer.
- **RLS:** read with the plan; write as plan owner. Moving a topic to another plan moves its cards (and
  their outgoing links) too.

**`cards`**: `topic_id` → topics (cascade), `plan_id` (**copied from the topic by a trigger**),
`source_chunk_id` uuid? → source_chunks (set null), `page` integer?, `question` text, `answer` text,
`card_type` text (`basic`, `cloze`, `why`, `write_from_memory`).
- **RLS:** read with the plan; write as plan owner.

**`card_links`**: `from_card_id`, `to_card_id` → cards (cascade; not the same card), `plan_id`
(**copied from `from_card`**), `created_by` uuid (default `auth.uid()`), `relation` text (`related`,
`why`, `analogy`, `prerequisite`, `contrast`), `note` text?.
- **RLS:** read with the plan. Anyone who can read the plan may link its cards to cards they can read.
  Each person edits and deletes only their own links (and an edit must still point at readable
  cards).

**`card_states`**: `user_id`, `card_id` → cards (cascade), `state` smallint (0–3), `due` timestamptz,
`stability`, `difficulty` (0–10) double precision, `scheduled_days`, `learning_steps`, `reps`,
`lapses` integer, `last_review` timestamptz?, `suspended` boolean; unique `(user_id, card_id)`. Field
names match ts-fsrs's `Card`, so a row can be passed to ts-fsrs directly.
- From Phase 2 the phone computes `id = UUIDv5(user_id:card_id)`, so two offline devices write the
  same row instead of colliding on the unique constraint.
- **Stale-write guard:** a BEFORE UPDATE trigger skips an update whose `last_review` is older than (or
  missing compared with) the stored one. The statement still succeeds, so the upload queue keeps
  moving; the `reviews` log keeps both answers.
- **RLS:** own rows; on write, the card must be readable.

**`reviews`** (append-only): `user_id`, `card_id` → cards (cascade), `interval_block_id` uuid? →
interval_blocks (set null), `rating` smallint (1–4), `answer_mode` text (`typed`, `spoken`,
`handwritten`, `self_graded`), `reviewed_at` timestamptz, `duration_ms` integer?, `prev_state`
smallint (state before), `elapsed_days` integer, then the state **after** the review: `state`,
`due_at`, `stability`, `difficulty`, `scheduled_days`.
- **RLS:** read own; insert own for readable cards; no update or delete policies. **Grants:** select,
  insert. The device uploads with `ON CONFLICT DO NOTHING`, so a retried upload is harmless.

### Tracy

**`tracy_events`**: `user_id`, `job` text (`transition_planner`, `study_builder`, `answer_grader`,
`analyst`, `handwriting`), `status` text (`queued`, `running`, `succeeded`, `failed`, `cancelled`),
`input` jsonb, `output` jsonb?, `error` text?, `accepted` boolean?, `attempts` integer, `locked_at`
timestamptz?, `model` text?, `usage` jsonb?.
- **Written by:** Edge Functions with the service role (Phase 2/3). It is DualRep's job queue and the
  audit log of every proposal and whether the user accepted it. See
  [TRACY_INTEGRATION.md](TRACY_INTEGRATION.md#6-long-jobs-dualrep-owns-the-queue).
- **Synced columns:** `id`, `user_id`, `job`, `status`, `error`, `accepted`, `created_at`,
  `updated_at`. `input`, `output`, `attempts`, `locked_at`, `model` and `usage` stay on the server.
- **RLS:** read own, update own. **Grants:** select, and `update (accepted)` only.

---

## 4. Helper functions and triggers

Policy helpers (`security definer`, `stable`, `search_path = ''`; `authenticated` and `service_role`
may execute them, `anon` may not):

| Function | True when |
|---|---|
| `is_group_member(gid)` | The caller is in the group |
| `is_group_owner(gid)` | The caller owns the group |
| `shares_group_with(uid)` | The caller and `uid` share any group |
| `has_paid_access(uid)` | `uid` has an unexpired subscription entitlement (a signed-in caller can only ask about themselves) |
| `can_read_plan(pid)` / `can_edit_plan(pid)` | Owner or group member / owner only |
| `can_read_source(sid)` / `can_edit_source(sid)` | Owner or group member / owner only |
| `can_read_card(cid)` | The card's plan is readable |
| `is_valid_split(s)` | A preset split is valid (used by a CHECK) |

Triggers: `set_updated_at` (every table); `handle_new_user` (new auth user → profile + free
entitlement); `add_group_owner_membership`; `enforce_group_member_limit` (8);
`copy_source_ownership` and `propagate_source_ownership` (source_files, source_chunks);
`copy_card_plan_id`, `propagate_topic_plan_id`, `copy_card_link_plan_id`, `propagate_card_plan_id`;
`skip_stale_card_state`. Nobody may execute trigger functions directly.

---

## 5. Changes from the plan

The plan's data model table lists key columns for 22 tables. The migration has 23. These are the
differences and why.

| Plan | Built | Why |
|---|---|---|
| `entitlements` keyed by `user_id` | Surrogate `id` plus `unique (user_id)` | PowerSync needs a text `id` on every synced row. Sync Streams (edition 3) do not warn when a query lacks `id`; the phone would silently keep one arbitrary row per table. |
| `plan_sources (plan_id, source_id, added_at)` | Surrogate `id` plus `unique (plan_id, source_id)` | Same `id` rule. The phone writes this table offline and needs a stable id for later updates and deletes. |
| `group_members (group_id, user_id, role)` | Surrogate `id` plus `unique (group_id, user_id)` | Same `id` rule. |
| Child rows found through their parent | Denormalized `user_id` on `interval_blocks`, `exercise_sets`, `transitions` | Filtering a child through its parent gives one sync bucket **per parent row**, not per user, and PowerSync allows 1,000 buckets per connection. RLS `WITH CHECK` makes sure the copy matches the parent. |
| `cards`, `card_links` reach the plan through `topics` | Denormalized `plan_id` on `cards` and `card_links`, copied by triggers | One bucket per plan instead of per topic or per card. Triggers set it, so it can't be forged. |
| `source_files` reach the owner through `sources` | `owner_id` and `group_id` on `source_files` and `source_chunks`, copied by triggers | Per-user and per-group sync and simple RLS without joins. |
| `reviews` holds "FSRS state" | **New `card_states` table** (current state per user per card) plus `reviews` as an **append-only** log | The due list must be a cheap indexed query (`user_id, due`). Group members share cards but each schedule is private. The log is kept for FSRS optimisation, the weekly Analyst, auditing, and rebuilding state after a two-device conflict. |
| `reviews`: `rating, answer_mode, reviewed_at, due_at, stability, difficulty` | Adds `interval_block_id`, `duration_ms`, `prev_state`, `elapsed_days`, `state`, `scheduled_days`; the state columns are the values **after** the review | Enough to replay history with ts-fsrs and link answers to the focus block. |
| Weights, RPE, FSRS numbers (types not stated) | `double precision` everywhere | `numeric` would arrive on the phone as TEXT. |
| `equipment` lists (types not stated) | `jsonb` arrays with an array CHECK (also `secondary_muscles`, `instructions`, `images`) | The phone stores lists as JSON text either way. One JSON type means one upload rule (`JSON.parse`); a Postgres `text[]` sent as a string fails with 22P02. |
| `groups (id, name, invite_code)` | Adds `owner_id`; `invite_code` generated on the server (8 characters, no look-alikes) | The plan says the owner subscribes and members join free: RLS needs the owner to allow create (subscribers only), rename and delete. The code is never chosen by the phone. |
| Joining a group (not specified) | `join_group()` RPC; the phone cannot insert into `group_members` | Enforces the code check and the 8-member limit in one place. |
| `exercises` key columns | Adds `secondary_muscles`, `dataset_category`, `level`, `force`, `mechanic`, `instructions`, `images`, `dataset_id` (unique) | Fields from the free-exercise-db research. `dataset_id` makes the import idempotent. `instructions` and `images` stay empty until the dataset license question is settled ([DECISIONS.md](DECISIONS.md)). |
| `exercise_sets (…, reps, weight_lbs, rpe, set_type)` | Adds `target_reps`, `target_weight_lbs`, `rest_seconds` | The spotter's inputs in the plan are "target reps and weight, actual reps, effort rating, rest time". |
| `tracy_events (id, user_id, job, status, input, output, accepted, created_at)` | Adds `error`, `attempts`, `locked_at`, `model`, `usage`; fixed `job` and `status` values; only light columns sync | DualRep owns the job queue ([TRACY_INTEGRATION.md](TRACY_INTEGRATION.md)). The large JSON stays on the server; the phone may only set `accepted`. |
| `source_chunks.embedding` (pgvector, size not stated) | `vector(1536)` plus `embed_model`; HNSW cosine index; never synced | pgvector indexes stop at 2,000 dimensions and Gemini's default is 3072, so the size is pinned. `embed_model` says which rows to re-embed after a model change. |
| Smaller additions | `profiles.fsrs_params`; `presets.kind`; `sources.status`; `study_plans.title`; `cards.page`; `card_links.created_by`; `workout_sessions.duration_minutes`; `created_at`/`updated_at` everywhere | Per-user FSRS settings; a stable name for each system preset; upload processing state; a plan name; "every card stores the page it came from"; who may edit a link; walk minutes. |
| Postgres conventions (not stated) | `text` + CHECK instead of enums; `on delete cascade` from `auth.users`; explicit grants | Easy to extend; Play's account-deletion rule; Supabase's 2026 grant change. |

---

## 6. Changing the schema

1. Add a **new** migration file in `supabase/migrations/` (never edit one that has been pushed).
   Name it `<UTC timestamp>_<what>.sql`, for example `20261101120000_add_streaks.sql`.
2. Follow the ground rules above: RLS on, explicit grants, indexes, cascades, no `numeric`.
3. If the phone should receive the table: `alter publication powersync add table public.<name>;` in
   the same migration, add it to [`src/db/tables.ts`](../src/db/tables.ts), and add a query to
   [`powersync/sync-config.yaml`](../powersync/sync-config.yaml) that selects `id`.
4. Add pgTAP tests in `supabase/tests/`.
5. Run `npm run db:test` (this regenerates `supabase/schema.snapshot.json`), then `npm run check`.
   The registry-drift test fails if `tables.ts`, the snapshot and the publication disagree.
6. Apply it to the hosted project with `npx supabase db push`, and redeploy the sync config if it
   changed (see [SETUP.md](SETUP.md)).
