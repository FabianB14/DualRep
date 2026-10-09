# Data model

What is in the database, who writes each table, how each table reaches the phone, and how it is
protected. It describes the migrations as built: the schema,
[`supabase/migrations/20261008000000_initial_schema.sql`](../supabase/migrations/20261008000000_initial_schema.sql),
and the Phase 1 starter-library seed,
[`20261008120000_starter_library.sql`](../supabase/migrations/20261008120000_starter_library.sql)
(rows only, no schema change). When this page and a migration disagree, the migration wins.

Related files:

| File | What it is |
|---|---|
| [`supabase/migrations/`](../supabase/migrations/) | The schema, RLS policies, grants, triggers, system presets and the `powersync` publication (first migration); the 90 starter exercises (second) |
| [`supabase/tests/`](../supabase/tests/) | pgTAP tests for every table and policy, and for the starter library: 14 files, 542 tests (`npm run db:test`, or `supabase test db`) |
| [`scripts/library/starter-library-sql.mjs`](../scripts/library/starter-library-sql.mjs) | Writes the starter-library migration from the app's own list; `npm run check:library` checks it is up to date |
| [`supabase/schema.snapshot.json`](../supabase/schema.snapshot.json) | Column list per table, written by `npm run db:test`, read by `npm run validate:sync` |
| [`powersync/sync-config.yaml`](../powersync/sync-config.yaml) | The Sync Streams: which rows each phone receives |
| [`src/db/tables.ts`](../src/db/tables.ts) | The app's registry of synced tables: columns, local indexes and what the device may write |

---

## 1. Ground rules (every table)

- **Names:** schema `public`, lowercase plural table names.
- **Primary key:** `id uuid primary key default gen_random_uuid()`. The phone makes its own UUIDs
  (`expo-crypto` `randomUUID()`) so rows can be created offline; the default serves rows made on the
  server.
- **Timestamps:** `created_at` and `updated_at timestamptz not null default now()`. When the phone
  creates a row it sends both, from its own clock, so a row made offline keeps the time it was made.
  After that the server owns `updated_at`: a shared `set_updated_at()` trigger sets it on every
  UPDATE (including an upsert that hits an existing row), and the phone never sends it in a PATCH.
- **Enumerations:** `text` plus a `CHECK`, not Postgres enum types (adding a value is a one-line
  migration).
- **JSON and lists:** `jsonb`. Lists are `jsonb` arrays with `CHECK (jsonb_typeof(x) = 'array')`.
- **Numbers with fractions:** `double precision`, never `numeric` (PowerSync would deliver `numeric` as
  TEXT).
- **Account deletion:** every user reference is `references auth.users (id) on delete cascade`.
  Deleting the auth user deletes all of that person's data, which Google Play requires.
- **Deleting never depends on anyone else's data.** No foreign key restricts a delete: every foreign
  key is CASCADE or SET NULL (`00_schema.test.sql` checks this). A reference that can point at
  another person's row is SET NULL, so when that row or its owner's account is deleted, your row is
  kept with the link set to null instead of the delete failing. For example, a set logged against a
  friend's shared exercise keeps its `exercise_name` and gets `exercise_id = null`, and deleting a
  group unshares the exercises, sources and study plans members shared into it instead of deleting
  them. The SET NULL columns are `cards.source_chunk_id`, `exercise_sets.exercise_id`,
  `profiles.default_preset_id` and `default_setup_id`, `reviews.interval_block_id`,
  `study_sessions.plan_id`, `transitions.workout_session_id`, `workout_sessions.preset_id` and
  `setup_id`, and `group_id` on `exercises`, `sources`, `source_files`, `source_chunks` and
  `study_plans`. The cascades that remain never block a delete: a deleted card or plan takes its
  `card_states`, `reviews` and `card_links` with it (other users' too), and a deleted source takes
  its `plan_sources` rows. `09_deletion.test.sql` deletes accounts and groups while other people
  hold references to them.
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

A PUT sends the whole row, including `created_at` and `updated_at` from the phone's clock. Postgres
checks the SELECT policy against a row being upserted too, so every SELECT policy admits any row its
INSERT policy admits.

Columns the server fills in itself are never uploaded. Today that is `groups.invite_code`
(`serverGenerated` in [`src/db/tables.ts`](../src/db/tables.ts)): the connector strips it from
every PUT and refuses a PATCH that includes it (`DUALREP_WRITE_NOT_ALLOWED`). A new group's code
reaches the phone with the next sync.

**When an upload fails** ([`src/db/upload.ts`](../src/db/upload.ts), `isFatalUploadError`):

- **Dropped and logged:** codes `22xxx` (bad data), `23xxx` (a constraint), **42501 with HTTP 403**
  (a missing grant or an RLS denial for a signed-in user), and writes the phone refuses itself
  before sending (`DUALREP_…` codes). Each one is written to the local-only **`upload_failures`**
  table and dropped from the queue so later writes keep flowing. The Sync Check screen shows that
  table.
- **Retried, never dropped:** no connection, server errors (5xx), and **any HTTP 401**. A 401 means
  the request did not run as the signed-in user: an expired token, or no session at all (then
  PostgREST answers 401 with code 42501, because `anon` has no grants). It says nothing about the
  write itself, so the write waits.
- **No session, nothing sent:** before sending anything, the connector checks for a signed-in
  session. Without one it throws `NoSessionError` and sends nothing; the write stays queued.

**When the session is lost** without signing out (for example the refresh token was revoked):
nothing syncs down and nothing is sent. The PowerSync SDK keeps the queue and tries the upload again
later (after its retry delay of about 5 seconds, and when it reconnects or the app writes
something); each time the connector throws `NoSessionError` and sends nothing. When the same user
signs in again, the queue uploads. If a different account signs in, the local database is
cleared first ([`src/features/sync/SyncLifecycle.tsx`](../src/features/sync/SyncLifecycle.tsx)).
Signing out on purpose clears it too.

### Writes the server normalizes instead of refusing

A phone can upload a write long after it was made. Meanwhile someone else may have left a group,
been removed from it, unshared a row or deleted it, so a value that was fine on the phone can now
name a row the writer may not use, or nothing at all. Refusing the write would drop it on the phone
for good. So **a write made offline is never dropped because of something another person did**:
BEFORE triggers rewrite what the server may not store, before RLS and the foreign keys look at it.

| Column | Allowed value | Trigger (function) |
|---|---|---|
| `study_sessions.plan_id` | A plan you can read (`can_read_plan`) | `clear_plan_reference` (`clear_unreadable_plan`) |
| `exercise_sets.exercise_id` | An exercise you can read (`can_read_exercise`: reviewed library, your own, or shared with one of your groups) | `clear_exercise_reference` (`clear_unreadable_exercise`) |
| `cards.source_chunk_id` | A chunk whose source you can read | `clear_source_chunk_reference` (`clear_unreadable_source_chunk`) |
| `workout_sessions.preset_id`, `setup_id` | A system preset or your own; your own equipment setup | `clear_preset_and_setup_references` (`clear_foreign_workout_refs`) |
| `profiles.default_preset_id`, `default_setup_id` | A system preset or your own; your own equipment setup | `clear_default_references` (`clear_foreign_profile_defaults`) |
| `transitions.workout_session_id` | Your own workout session | `clear_workout_session_reference` (`clear_foreign_workout_session`) |
| `reviews.interval_block_id` | Your own interval block | `clear_interval_block_reference` (`clear_foreign_interval_block`) |
| `group_id` on `exercises`, `sources`, `study_plans` | A group you are a member of | `clear_group_unless_member` (same name) |

- **Optional references are stored as null, not refused.** A value that isn't allowed, or that names
  a row that doesn't exist (for example one deleted while the phone was offline), is stored as null
  and the rest of the write is accepted. These columns never cause 42501 or 23503 any more. A missing
  id and an unreadable id give the same stored row, so a write never reveals whether someone else's
  row exists.
- **References to rows someone else may own** (the first three rows) are judged only when a write
  sets or changes them. A stored value is kept on later PATCHes, and on a PUT that re-sends the same
  value, even after the row became unreadable; the link works again if the row is shared again. A
  new row, or a changed value, that names an unreadable or missing row is stored as null (not as the
  previous value).
- **References to your own rows** (presets, setups, workout sessions, interval blocks) are judged
  on every write that sets the column. A stored value is always valid (these rows never become
  someone else's, and deleting one sets stored references to null), so nothing is rewritten
  needlessly.
- **Sharing is normalized too.** When you are not a member of a row's `group_id`, the row is stored
  unshared (`group_id = null`) instead of refused: a retried PUT that still carries a group you left,
  content created offline as shared and uploaded after you were removed (with its topics, cards,
  files and sets), or "sharing" into a group you are not in. This trigger fires on every client
  insert and update, not only ones that send `group_id`, so a row left shared by a race with leaving
  is unshared by its owner's next edit. The membership check in the RLS policies stays as a second
  line of defence and always passes for client rows after the trigger.
- **Only client requests are rewritten** (`current_user = 'authenticated'`). The service role, SQL
  run as `postgres`, security definer functions and foreign-key actions are left alone.
- **Required (NOT NULL) parent references are still refused** with 42501, because a child of a
  parent you can't use means nothing: a set in someone else's workout session, a transition whose
  `interval_block_id` isn't yours, a card in a topic you can't edit, a `plan_sources` row for a plan
  you don't own or a source you can't read, a `card_links` row on a plan you can't read.
- **Private study history is the exception:** `reviews` and `card_states` only need to be your own
  rows. An answer given offline uploads even if the card became unreadable meanwhile (its plan was
  unshared, its owner left, you were removed); it stays private to you. If the card was **deleted**,
  the row is skipped without an error (`skip_study_row_without_card`), the same result the cascade
  would have had, so the device has nothing to drop.
- **What the app must handle:** a normalized write leaves no `upload_failures` entry; the row just
  comes back from the server changed. The app must show a set with `exercise_id = null` (or with an
  `exercise_id` whose exercise is no longer on the phone) by its `exercise_name`, and cope with
  `plan_id = null`, `source_chunk_id = null` and a row that comes back unshared.
- All eight `clear_*` functions are `security invoker` with `search_path = ''`, and nobody may
  execute them directly. `00_schema.test.sql` checks that, and that each of the 13 optional
  foreign-key columns a client can write has a BEFORE INSERT and UPDATE row trigger covering it (the
  twelve above plus `source_files.group_id`, which is copied from its source).
  `10_references.test.sql` and `12_offline_uploads.test.sql` test the behaviour.

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

### Tables that live only on the phone

Two tables exist only in the phone's SQLite database ([`src/db/schema.ts`](../src/db/schema.ts)). They
are PowerSync "local-only" tables: never synced, never uploaded, not in Postgres, and no migration
creates them. Signing out clears them with everything else.

| Table | Since | What it holds |
|---|---|---|
| `upload_failures` | Phase 0 | Uploads the server refused for good, with the error code; the Sync Check screen shows them ([when an upload fails](#how-a-phone-write-reaches-postgres)) |
| `local_state` | Phase 1 | A small key-value store: `id` is the key, `value` is JSON text, plus `updated_at` |

Keys in `local_state`:

| Key | What | Written |
|---|---|---|
| `cycle` | The running study → move → study cycle: the phase, the timers' end times, the circuit, where you are in it, the sets logged so far, the ids of the rows it will write, and the writes not done yet. It holds the user's id, so another account's cycle is never resumed. | Before every write or alert the loop decides on, so an app restart picks up exactly where it was ([DECISIONS.md](DECISIONS.md) D23) |
| `alert-test` | The Timer check's test alert: when it was scheduled, when it was due, and when Android showed it | When a test is scheduled, and when its result is read |

Changing either table is an app change (`schema.ts`), not a migration. A new key needs no change at
all.

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
| `group_members` | Who is in which group | delete (leave only; removing someone is an RPC) | `group_shared` |
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
- **RLS:** read own row and group mates' rows (`shares_group_with`); insert and update own (`id` is
  you); no delete (deletion cascades from `auth.users`). **Grants:** select, insert, update.
- `default_preset_id` must be a system preset or your own, and `default_setup_id` your own setup.
  Group mates can read your profile, so it never names rows you can't see: any other value, or a
  deleted row, is stored as null (`clear_default_references`; see
  [normalized writes](#writes-the-server-normalizes-instead-of-refusing)).

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
`owner_id` uuid?, `group_id` uuid? → groups (set null: deleting a group only unshares its members'
exercises, as for sources and study plans).
- Four checks (a violation is 23514, for the service role too):
  - a row has an owner exactly when `origin = 'user'`;
  - only `user` rows can belong to a group;
  - `exercises_dataset_id_only_for_dataset`: only `dataset` rows have a `dataset_id`;
  - `exercises_user_rows_unreviewed`: a `user` row is never `reviewed = true`.

  Together they mean no phone can claim a free-exercise-db id or pass its own row off as reviewed
  library content.
- **Written by:** library rows (`dataset`, `interverse`) by migrations and the service role only
  (the starter-library migration, the dataset import SQL from
  [`build-import-sql.mjs`](../scripts/exercise-import/README.md), run in the SQL Editor, and
  curation); `user` rows by their owner.
- **The starter library** (Phase 1, [DECISIONS.md](DECISIONS.md) D21): 90 exercises written by
  Interverse, seeded by `20261008120000_starter_library.sql`.
  - `origin = 'interverse'`, `reviewed = true`; `owner_id`, `group_id` and `dataset_id` null;
    `images = []`; 2–4 short instruction steps in our own words.
  - Fixed ids: `00000000-0000-4000-8000-0000000e0001` to `…0000000e005a` today. The whole range
    `00000000-0000-4000-8000-0000000eXXXX` is reserved for them, and an id is never reused.
  - The app bundles the same list
    ([`starterLibraryData.ts`](../src/features/training/starterLibraryData.ts)), so circuits work
    before the first sync. When the synced row arrives it wins over the bundled copy.
  - The migration is an upsert that sets every column, so running it again restores each row
    exactly. A later change to the list needs a new migration file (see
    [changing the schema](#6-changing-the-schema)).
  - They reach phones through the `library` stream like any reviewed library row: no sync-config
    change.
- **Measure** (counted in reps or in seconds) is not a column. The app keeps it with the bundled
  starter list, and works it out for other exercises from the movement pattern and the name (holds,
  planks, carries, conditioning and mobility are timed).
- **The user's own exercises** (the library screen's add form): `origin = 'user'`, `reviewed = false`,
  `owner_id` = you; no `dataset_id`, `group_id`, `level`, `force` or `mechanic`. No gear is stored as
  `["bodyweight"]`; any gym-only item makes it `gym`. The form requires a movement pattern and body
  region, and `micro_ok` starts on, so the exercise can join default circuits at once.
- **RLS:** read reviewed library rows, own rows, and rows shared with your groups. Insert, update and
  delete own `user` rows. A `group_id` naming a group you are not a member of is stored as null
  (`clear_group_unless_member`): the exercise is kept, unshared. Leaving or being removed from a
  group unshares your exercises in it ([`group_members`](#groups)), and you can still edit or delete
  them.
- Library rows sync only once `reviewed = true`. The dataset import arrives with `reviewed = false`.

**`workout_sessions`**: `user_id`, `logged_at` timestamptz (default now), `kind` text (`micro`, `full`,
`walk`), `preset_id` uuid? → presets (set null), `setup_id` uuid? → equipment_setups (set null),
`duration_minutes` integer? (≥ 0).
- Phase 1 writes `micro` (a 5–15 minute circuit) and `full` (a 30–60 minute session) from the loop
  ([what the loop writes](#what-the-core-loop-writes-and-when)). `walk` is not used yet.
- **RLS:** own rows only.
- `preset_id` must be a system preset or your own, and `setup_id` your own setup. Any other value, or
  a deleted row, is stored as null (`clear_preset_and_setup_references`).

**`exercise_sets`**: `user_id` (copy of the session's owner), `workout_session_id` → workout_sessions
(cascade), `exercise_id` uuid? → exercises (set null), `exercise_name` text? (the exercise's name,
copied by the phone when the set is logged), `set_index` integer (≥ 0), `reps` integer?,
`weight_lbs` double precision?, `rpe` double precision? (1–10), `target_reps` integer?,
`target_weight_lbs` double precision?, `rest_seconds` integer?, `set_type` text (`normal`, `drop`,
`rest_pause`).
- Deleting the exercise, or its owner's account, keeps every set (anyone's) with `exercise_id =
  null`. `exercise_name` keeps the history readable after the exercise is deleted, unshared or
  otherwise no longer visible.
- **RLS:** own rows, and on write the parent workout session must also be yours (a set in someone
  else's session is refused, 42501).
- **How Phase 1 fills it** ([DECISIONS.md](DECISIONS.md) D25):
  - `set_index` counts from 0 across the whole workout. `exercise_name` is always filled.
  - A **timed** set (an exercise measured in seconds) stores its seconds of work in `reps` and
    `target_reps`. There is no seconds column; the exercise's measure says how to read them.
  - `rpe` comes from the effort chips: Easy = 6, Solid = 8, All out = 10; null when none was tapped.
  - `rest_seconds` is the rest taken **before** the set (the time since the previous set, minus this
    set's work at 3 s per rep). Null for the workout's first set.
  - `weight_lbs` and `target_weight_lbs` are pounds even when the app shows kg, stored exactly as
    converted (not rounded). Null means no weight (bodyweight).
  - `set_type`: `drop` for sets after the spotter lowered the weight, `rest_pause` for the spotter's
    rest-pause mini-set, otherwise `normal`.
- `exercise_id` is judged when a write sets or changes it: an exercise you can't read, or one that no
  longer exists, is stored as null (`clear_exercise_reference`). A stored `exercise_id` is kept after
  the exercise becomes unreadable (for example its owner left the group); the phone then no longer
  has that exercise row, so show `exercise_name`.

### Study sessions and the handoff

**`study_sessions`**: `user_id`, `plan_id` uuid? → study_plans (set null), `focus_subject` text
(≤ 200).
- **RLS:** own rows (the policies check `user_id` only, so editing an old session never fails).
- `plan_id` is judged when a write sets or changes it: a plan you can't read, or one that no longer
  exists, is stored as null (`clear_plan_reference`). A stored `plan_id` is kept after the plan
  becomes unreadable (for example you left its group).
- The Phase 0 **Sync Check** writes its probe rows here, with `focus_subject` starting
  `Sync check ` (see [SETUP.md](SETUP.md#12-run-the-sync-check-the-phase-0-gate)).

**`interval_blocks`**: `user_id` (copy of the session's owner), `study_session_id` → study_sessions
(cascade), `planned_minutes` integer (1–120), `started_at` timestamptz?, `ended_at` timestamptz?,
`interrupted` boolean, `effort_rating` smallint? (1–5), `mode` text (`seated`, `on_the_go`).
- **RLS:** own rows, and on write the parent study session must also be the user's.

**`transitions`**: `user_id` (copy), `interval_block_id` → interval_blocks (cascade),
`workout_session_id` uuid? → workout_sessions (set null), `proposal` jsonb (default `{}`), `accepted`
boolean?.
- In Phase 1, `proposal` is the circuit as planned at the handoff (`version`, `source: 'default'`,
  `kind`, `minutes`, `rounds`, `items` with each exercise's id, name and targets, `estimatedSeconds`,
  `location`, `split`). `accepted` is null at first, true after the first logged set, false when the
  move block was skipped with no set ([DECISIONS.md](DECISIONS.md) D26).
- **RLS:** own rows, and on write the parent interval block must also be yours (refused otherwise,
  42501).
- `workout_session_id` must be your own workout session; any other value, or a deleted one, is stored
  as null (`clear_workout_session_reference`).

### What the core loop writes, and when

Phase 1's study → move → study loop ([`cycleRepo.ts`](../src/features/cycle/cycleRepo.ts)) writes
only to the phone's database; PowerSync uploads the rows later. Each step is one local transaction.
Every row id is made before the write, and an insert is skipped when the row already exists, so a
step that runs again after a crash writes nothing twice. Timestamps are ISO strings with
milliseconds.

| When | Table | What is written |
|---|---|---|
| First focus block of a cycle starts | `study_sessions` | INSERT: `focus_subject` (what you typed, or `''`), `plan_id` null |
| Every focus block starts | `interval_blocks` | INSERT: `study_session_id`, `planned_minutes` (10–50), `started_at`, `interrupted = false`, `mode = 'seated'` |
| A focus block ends | `interval_blocks` | UPDATE `ended_at` and `interrupted` (true for **End block early**, or **Finish** before the time was up). `ended_at` is `started_at` plus the time actually focused, with pauses left out (there is no column for them), so `ended_at − started_at` is the block's focus time. For a block that ran out without a pause it is the timer's real end, even if the app only noticed later |
| You rate the block (1–5) | `interval_blocks` | UPDATE `effort_rating` (again on each change) |
| The move block starts (the handoff) | `workout_sessions` | INSERT: `kind` (`micro` or `full`), `logged_at`, `preset_id`, `setup_id` |
| … after a focus block | `transitions` | INSERT: `interval_block_id`, `workout_session_id`, `proposal` (the circuit), `accepted` null |
| Each **Done** | `exercise_sets` | INSERT one set ([how sets are filled](#training)) |
| … the workout's first set | `transitions` | UPDATE `accepted = true` |
| The workout ends with sets logged | `workout_sessions` | UPDATE `duration_minutes`: from the handoff to the last logged set, rounded (time after the last set, such as a workout left open, isn't counted) |
| The workout is skipped or ended with no set | `transitions`, `workout_sessions` | UPDATE `accepted = false` and `workout_session_id = null`; DELETE the empty workout |

- **Just train** (a workout without a focus block) writes no `study_sessions`, `interval_blocks` or
  `transitions` rows.
- **Nothing in the loop writes `exercises` or `profiles`.** The loop never creates a profile.
- **Profiles** are written only by Settings (block length, units), Presets (default preset) and
  Setups (default setup; also the one-tap setup on the start screen), and only as an UPDATE of the
  row the server created. Before that row has synced, the app uses the defaults (25-minute blocks,
  lb, Full body) and those controls are off.
- **Deleting** a preset or setup that is your default also clears `profiles.default_preset_id` or
  `default_setup_id` on the phone, in the same transaction (what the server's ON DELETE SET NULL
  does), so the phone never points at a deleted row while offline.
- The running cycle itself (timers, position, pending writes) is in the local-only `local_state`
  table ([tables that live only on the phone](#tables-that-live-only-on-the-phone)).

### Groups

**`groups`**: `owner_id` → auth.users, `name` text (1–60), `invite_code` text (unique, 8 characters
from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, made by `generate_invite_code()`).
- An AFTER INSERT trigger adds the owner to `group_members` with role `owner`.
- **RLS:** read as owner or member; create only if `owner_id` is you **and** `has_paid_access` (free
  users join, subscribers create and host); rename and delete as owner.
- **Grants:** select, delete, `insert (id, owner_id, name, created_at, updated_at)` and
  `update (name)`. So the server always picks the invite code: a write that sends `invite_code`
  gets 42501, and the connector never sends it. `owner_id` can't be changed either. Because of the
  column grants, the device uploads a new group as insert-ignore (`ON CONFLICT DO NOTHING`); an
  upsert would fail with 42501.
- **Changing the code:** only the owner, through **`regenerate_invite_code(p_group_id uuid)`**
  (returns the new code; the old one stops working at once and existing members stay) or
  `remove_group_member()` below. Errors: `not_authenticated` (42501) without a user,
  `not_group_owner` (42501) for anyone but the owner. Only `authenticated` may call it.

**`group_members`**: `group_id` → groups (cascade), `user_id` → auth.users, `role` text (`owner`,
`member`); unique `(group_id, user_id)`.
- **Joining** goes only through the RPC **`join_group(p_invite_code)`**: case-insensitive code lookup,
  returns the group id; error `invalid_invite_code` (P0001) for an unknown code, `group_full` (P0001)
  at 8 members, `not_authenticated` (42501) without a user; joining twice is harmless. Only
  `authenticated` may call it. It locks the group row while it looks up the code, so a join that
  races with a removal or a code change waits for it and then reads the new code: a removed member
  can't get back in with the code they knew.
- A BEFORE INSERT trigger enforces **at most 8 members**, locking the group row first so two people
  joining at once can't both take the last seat.
- **Leaving** is a plain DELETE of your own membership (policy `group_members: leave`: `user_id` is
  you and `role` isn't `owner`). The owner can't leave; they delete the group instead.
- **Removing someone** (owner only) goes through the RPC
  **`remove_group_member(p_group_id uuid, p_user_id uuid)`**, which returns the group's new invite
  code. In one transaction it locks the group row, deletes the member's row and rotates the invite
  code (the removed member knew the old one). Errors: `not_authenticated` (42501) without a user;
  `not_group_owner` (42501) when you don't own the group or it doesn't exist; `cannot_remove_owner`
  (P0001) when the owner names themselves (they delete the group instead). Removing someone who
  already left (or never joined) is not an error: the code is rotated anyway, so a member who left
  seconds before the owner tapped Remove can't re-join with the code they know. Only
  `authenticated` may call it. (The RPC errors use P0001 because PostgREST returns it as HTTP 400;
  P0002 would come back as a 500.)
  - The app calls it **online** and shares the returned code with the people who should keep access.
  - It never queues a local DELETE of someone else's membership: the server's DELETE policy matches
    no row (HTTP 204, no error), and the row comes back with the next sync.
  - There is no ban list: `join_group()` only admits holders of the current code.
- **After leaving or being removed**, the trigger `unshare_after_leaving` (function
  `unshare_after_leaving_group`) sets `group_id = null` on that person's own exercises, sources (their
  files and chunks follow) and study plans in that group. It is skipped while the whole group or the
  person's account is being deleted (the foreign keys handle those rows). Afterwards:
  - their rows stay theirs and editable. An upload that still carries the old `group_id` (a retried
    PUT, or content created offline as shared) is stored unshared, with its topics, cards, files and
    sets ([normalized writes](#writes-the-server-normalizes-instead-of-refusing)). Sharing into a
    group they are no longer in is accepted but stored unshared.
  - their study sessions on the group's plans keep `plan_id` and stay editable.
  - other members keep their own rows that point at the unshared content (sets keep `exercise_id` and
    `exercise_name`, study sessions keep `plan_id`), but no longer see the content itself.
- **RLS:** read own memberships and the rosters of your groups; delete only your own non-owner
  membership. **Grants:** select, delete. In [`src/db/tables.ts`](../src/db/tables.ts) the table is
  `{ put: false, patch: false, delete: true }`, where delete means leaving.

### Study material

**`sources`**: `owner_id`, `group_id` uuid? → groups (set null), `kind` text (`pdf`, `doc`, `link`,
`notes`), `title` text, `url` text?, `status` text (`pending`, `processing`, `ready`, `failed`).
- **RLS:** read own and group-shared; write own. A `group_id` naming a group you are not a member of
  is stored as null (`clear_group_unless_member`): the source is kept, unshared.
- Changing a source's owner or group carries its files and chunks along (trigger
  `propagate_source_ownership`, after any update of `sources` that changes `owner_id` or `group_id`,
  including a `group_id` cleared by `clear_group_unless_member`).

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
- **RLS:** like sources (an unshareable `group_id` is stored as null). Group members read; only the
  owner edits the plan and its content.

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
- `source_chunk_id` may point into a group member's source. It is judged when a write sets or
  changes it: a chunk whose source you can't read, or a deleted chunk, is stored as null
  (`clear_source_chunk_reference`).

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
- **The id is derived, and the server enforces it.** `id` has no default; the CHECK
  `card_states_id_derived` requires
  `id = uuid_generate_v5('c4cae30d-9668-4354-adc3-2ee1071432e7', user_id::text || ':' || card_id::text)`
  (both uuids in lowercase hyphenated form, joined by `:`). Any other id is refused with 23514, and so
  is an UPDATE that changes `user_id` or `card_id`. From Phase 2 the phone computes the same id, so
  two offline devices of one user write the same row instead of colliding on the unique constraint,
  and nobody can take another user's id first. The namespace is `CARD_STATE_ID_NAMESPACE` in
  [`src/db/constants.ts`](../src/db/constants.ts). Worked example: user
  `11111111-1111-4111-8111-111111111111` + card `70000000-0000-4000-8000-000000000001` →
  `57743c5a-f966-538b-bccb-0919027b21c9`. (The migration enables the `uuid-ossp` extension for
  `uuid_generate_v5`; Supabase already has it.)
- **Stale-write guard:** a BEFORE UPDATE trigger skips an update whose `last_review` is older than (or
  missing compared with) the stored one. The statement still succeeds, so the upload queue keeps
  moving; the `reviews` log keeps both answers.
- **RLS:** own rows. Writes only check ownership, not that the card is still readable (see "Private
  study history" above); a state for a deleted card is skipped. The derived-id CHECK still stops
  anyone from taking another user's id.

**`reviews`** (append-only): `user_id`, `card_id` → cards (cascade), `interval_block_id` uuid? →
interval_blocks (set null), `rating` smallint (1–4), `answer_mode` text (`typed`, `spoken`,
`handwritten`, `self_graded`), `reviewed_at` timestamptz, `duration_ms` integer?, `prev_state`
smallint (state before), `elapsed_days` integer, then the state **after** the review: `state`,
`due_at`, `stability`, `difficulty`, `scheduled_days`.
- **RLS:** read own; insert own (ownership only, so an offline answer survives losing access to the
  card; a review of a deleted card is skipped); no update or delete policies.
  **Grants:** select, insert. The device uploads with `ON CONFLICT DO NOTHING`, so a retried upload
  is harmless.
- `interval_block_id` must be your own interval block; any other value, or a deleted one, is stored
  as null (`clear_interval_block_reference`).

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
| `can_read_exercise(eid)` | A reviewed library exercise, your own, or one shared with one of your groups (the same rule as the `exercises` SELECT policy) |
| `is_valid_split(s)` | A preset split is valid (used by a CHECK) |

RPCs (`security definer`; only `authenticated` may call them, not `anon` or `service_role`):

| Function | What it does |
|---|---|
| `join_group(p_invite_code)` | Join a group by its code; returns the group id ([group_members](#groups)) |
| `regenerate_invite_code(p_group_id)` | Owner only: give the group a new code; returns it |
| `remove_group_member(p_group_id, p_user_id)` | Owner only: remove a member and rotate the code in one transaction; returns the new code |

Triggers: `set_updated_at` (every table); `handle_new_user` (new auth user → profile + free
entitlement); `add_group_owner_membership`; `enforce_group_member_limit` (8);
`unshare_after_leaving_group` (a membership deleted → that person's content in the group is
unshared); `copy_source_ownership` and `propagate_source_ownership` (source_files, source_chunks);
`copy_card_plan_id`, `propagate_topic_plan_id`, `copy_card_link_plan_id`, `propagate_card_plan_id`;
`skip_stale_card_state`; and the eight normalizing functions in
[normalized writes](#writes-the-server-normalizes-instead-of-refusing) (`clear_unreadable_plan`,
`clear_unreadable_exercise`, `clear_unreadable_source_chunk`, `clear_foreign_workout_refs`,
`clear_foreign_profile_defaults`, `clear_foreign_workout_session`, `clear_foreign_interval_block`,
`clear_group_unless_member`). Nobody may execute trigger functions directly.

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
| `groups (id, name, invite_code)` | Adds `owner_id`; `invite_code` generated on the server (8 characters, no look-alikes) | The plan says the owner subscribes and members join free: RLS needs the owner to allow create (subscribers only), rename and delete. The code is never chosen by the phone (it has no privilege on the column), and only the owner can replace it. |
| Joining a group (not specified) | `join_group()` RPC; the phone cannot insert into `group_members` | Enforces the code check and the 8-member limit in one place. |
| Removing a member (not specified) | `remove_group_member()` RPC: delete the membership and rotate the code in one transaction; the phone may only delete its own membership (leave) | Every member can read the code, so a removal without a new code would let the removed person re-join. |
| `exercises` key columns | Adds `secondary_muscles`, `dataset_category`, `level`, `force`, `mechanic`, `instructions`, `images`, `dataset_id` (unique) | Fields from the free-exercise-db research. `dataset_id` makes the import idempotent. `instructions` and `images` stay empty until the dataset license question is settled ([DECISIONS.md](DECISIONS.md)). |
| `exercise_sets (…, reps, weight_lbs, rpe, set_type)` | Adds `target_reps`, `target_weight_lbs`, `rest_seconds`, and `exercise_name`; `exercise_id` is nullable (set null) | The spotter's inputs in the plan are "target reps and weight, actual reps, effort rating, rest time". A set must outlive the exercise it was logged with, which may be someone else's: their account deletion must never fail because of your sets, and your history keeps the name. |
| `tracy_events (id, user_id, job, status, input, output, accepted, created_at)` | Adds `error`, `attempts`, `locked_at`, `model`, `usage`; fixed `job` and `status` values; only light columns sync | DualRep owns the job queue ([TRACY_INTEGRATION.md](TRACY_INTEGRATION.md)). The large JSON stays on the server; the phone may only set `accepted`. |
| `source_chunks.embedding` (pgvector, size not stated) | `vector(1536)` plus `embed_model`; HNSW cosine index; never synced | pgvector indexes stop at 2,000 dimensions and Gemini's default is 3072, so the size is pinned. `embed_model` says which rows to re-embed after a model change. |
| Smaller additions | `profiles.fsrs_params`; `presets.kind`; `sources.status`; `study_plans.title`; `cards.page`; `card_links.created_by`; `workout_sessions.duration_minutes`; `created_at`/`updated_at` everywhere | Per-user FSRS settings; a stable name for each system preset; upload processing state; a plan name; "every card stores the page it came from"; who may edit a link; walk minutes. |
| Postgres conventions (not stated) | `text` + CHECK instead of enums; `on delete cascade` from `auth.users`, `on delete set null` (never restrict) for links that can point at other people's rows; explicit grants; optional references and sharing normalized instead of refused | Easy to extend; Play's account-deletion rule (a delete never depends on anyone else's data); Supabase's 2026 grant change; offline writes are never dropped because of what others did. |

---

## 6. Changing the schema

1. Add a **new** migration file in `supabase/migrations/` (never edit one that has been pushed).
   Name it `<UTC timestamp>_<what>.sql`, for example `20261101120000_add_streaks.sql`.
2. Follow the ground rules above: RLS on, explicit grants, indexes, cascades, no `numeric`, no
   `on delete restrict` (a link that can point at someone else's row is `on delete set null`), and a
   BEFORE INSERT and UPDATE trigger that normalizes every optional reference a client can write
   ([normalized writes](#writes-the-server-normalizes-instead-of-refusing)). `00_schema.test.sql`
   fails if a foreign key restricts deletes or an optional client-writable reference has no such
   trigger.
3. If the phone should receive the table: `alter publication powersync add table public.<name>;` in
   the same migration, add it to [`src/db/tables.ts`](../src/db/tables.ts), and add a query to
   [`powersync/sync-config.yaml`](../powersync/sync-config.yaml) that selects `id`.
4. Add pgTAP tests in `supabase/tests/`.
5. Run `npm run db:test` (this regenerates `supabase/schema.snapshot.json`), then `npm run check`.
   The registry-drift test fails if `tables.ts`, the snapshot and the publication disagree.
6. Apply it to the hosted project with `npx supabase db push` (or paste it into the SQL Editor, as
   for the first two), and redeploy the sync config if it changed (see [SETUP.md](SETUP.md)).

**Seed data changes too.** The starter library is a migration. To change it, edit
[`starterLibraryData.ts`](../src/features/training/starterLibraryData.ts), point `MIGRATION` in
[`starter-library-sql.mjs`](../scripts/library/starter-library-sql.mjs) at a **new** timestamped
file, and run the script. Keep the old file as it is: it has already run on the hosted project.
