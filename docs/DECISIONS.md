# Decisions

A short log of the technical decisions behind DualRep, and when to look at each one again. Add a new
entry when a decision changes; don't rewrite history. Newest entries go at the bottom.

Each entry: **Decision**, **Why**, **Alternatives considered**, **Revisit when**.

---

## D1. DualRep lives in its own repo (2026-10-08)

- **Decision:** DualRep is its own repository, not a folder inside the Tracy (`tracy-ai`) monorepo.
- **Why:** different stack (Expo app + Supabase vs. Tracy's Node server), different release cycle
  (Play Store builds vs. Render deploys), and a clean data boundary: DualRep data never needs to touch
  Tracy's code or database. DualRep talks to Tracy only over HTTP.
- **Alternatives:** a `dualrep/` folder in the Tracy monorepo.
- **Revisit when:** the two need shared TypeScript packages that are painful to publish separately.

## D2. Expo SDK 57, not the SDK 58 beta (2026-10-08)

- **Decision:** start on Expo SDK **57** (`expo@57.0.27`, React Native 0.86.3, React 19.2.3).
- **Why:** it is the current stable release; it targets Android API 36, which Google Play requires
  today; PowerSync and RevenueCat are tested against it. SDK 58 is still beta (built on a React Native
  0.88 release candidate) and moves to AGP 9.2.1 and Kotlin 2.2, a bigger toolchain jump.
- **Alternatives:** SDK 58 beta.
- **Revisit when:** SDK 58 is stable and the native libraries (PowerSync, op-sqlite, Reanimated) list
  support for it. Expect this soon after Phase 0. Upgrade on its own branch, then rerun the Sync Check
  on a phone.

## D3. PowerSync Sync Streams (edition 3) (2026-10-08)

- **Decision:** the sync config uses **Sync Streams** with `config: edition: 3`
  ([`powersync/sync-config.yaml`](../powersync/sync-config.yaml)), with millisecond timestamps.
- **Why:** Sync Streams became generally available in May 2026 and are the current engine; the older
  Sync Rules are legacy. Streams allow joins, subqueries and CTEs in filters, which DualRep needs for
  "plans visible through my groups". Legacy parameter queries can't join, so the group → plan → card
  chain would need even more copied columns.
- **Watch out:** edition 3 compiles a query without `id` without any warning, and the phone then keeps
  one arbitrary row per table. `npm run validate:sync` checks this.
- **Alternatives:** legacy Sync Rules (`bucket_definitions:`).
- **Revisit when:** never for the engine; re-check the config whenever the schema changes.

## D4. op-sqlite as the on-device database driver (2026-10-08)

- **Decision:** `@powersync/react-native` 2.3.1 with `@op-engineering/op-sqlite` 18.2.5, and nothing
  else for local data.
- **Why:** in PowerSync's React Native SDK v2, op-sqlite is the only native adapter and is built in.
  The separate `@powersync/op-sqlite` package is stuck on the v1 core and must not be installed.
  `expo-sqlite` is left out so the app doesn't carry a second SQLite engine.
- **Consequence:** the app needs a **development build**. Expo Go can't load the native module.
- **Alternatives:** `@powersync/adapter-sql-js` (alpha, development only, rewrites the whole database
  file on every write); WatermelonDB (the plan already replaced it).
- **Revisit when:** PowerSync ships a new adapter, or the app needs SQLCipher encryption (op-sqlite
  supports it through a `package.json` option).
- **Confirmed (2026-10-08):** the GitHub Actions Android APK build compiles PowerSync's and
  op-sqlite's native modules cleanly under Expo SDK 57 (the release APK). That answers the plan's
  "the PowerSync native module builds cleanly" check; running it on the phone is still the Phase 0
  gate.

## D5. Sign in with an emailed one-time code (2026-10-08)

- **Decision:** Supabase Auth email **one-time code**: the user types their email, gets a 6-digit code,
  and types it into the app. No passwords and no links.
- **Why:** nothing to remember or leak; no deep-link or redirect setup (links in emails are fragile on
  Android: they open the wrong browser, or a different device than the one signing in); works the same
  for new and returning users. The emails are templated to show only the code
  ([`supabase/templates/`](../supabase/templates/), set up in [SETUP.md](SETUP.md)).
- **Alternatives:** magic links (deep links), email + password, Google Sign-In (needs SHA-1/SHA-256
  fingerprints for three signing keys and more Play setup).
- **Revisit when:** Phase 5, if testers ask for Google Sign-In. Supabase's built-in email sender is
  rate-limited and meant for development: set up a custom SMTP sender before the closed beta
  (**verify** the current limits in the Supabase dashboard).
- **Planned exception:** Google Play's reviewers need a login that works without a one-time code, so
  Phase 5 adds one password account and a hidden "Sign in with password" path for it
  ([ANDROID.md 5.8](ANDROID.md#58-reviewer-login-app-access)).

## D6. Session stored in SecureStore, in chunks (2026-10-08)

- **Decision:** the Supabase session (access and refresh tokens) is stored with `expo-secure-store`
  (Android Keystore-backed), split into chunks by a small adapter (`src/lib/secureStorage.ts`).
- **Why:** tokens are credentials, so they belong in the Keystore, not in plain-text AsyncStorage.
  Older SecureStore docs mention a ~2 KB value limit and a Supabase session can be larger, so the
  adapter splits values instead of relying on the limit being gone.
- **Alternatives:** AsyncStorage (plain text on disk); Expo's `expo-sqlite/localStorage` (a second
  SQLite engine next to op-sqlite); Supabase's "LargeSecureStore" pattern (encrypted AsyncStorage with
  the key in SecureStore).
- **Revisit when:** a device shows sign-in loops or lost sessions after an app update.

## D7. DualRep owns the AI job queue (2026-10-08)

- **Decision:** long Tracy jobs (study builder, weekly review) are rows in DualRep's `tracy_events`
  table, claimed by a DualRep worker Edge Function that calls Tracy's task lane and writes the results
  with DualRep's own service role. Tracy stays stateless.
- **Why:** the plan's wording ("queued jobs on Tracy's server that write to DualRep's database") would
  put DualRep's service-role key, which bypasses all row security, on Tracy. DualRep data would also
  sit in Tracy's database, and Tracy's cold starts would stall jobs. Syncing `tracy_events` gives the
  phone a progress view for free.
- **Alternatives:** a queue on Tracy's server; Tracy returning `202` and calling back a signed DualRep
  webhook (acceptable later, still without the service key).
- **Revisit when:** Phase 2, when the worker is built. Details: [TRACY_INTEGRATION.md](TRACY_INTEGRATION.md).

## D8. Focus timer without a foreground service (recommendation; final call in Phase 1) (2026-10-08)

- **Decision (proposed):** keep time from the clock and alert with a scheduled notification:
  store `endsAt`, show `endsAt - now` on screen, and schedule a local notification for `endsAt` on a
  high-importance channel. No foreground service. Optional exact alarms through the user-granted
  `SCHEDULE_EXACT_ALARM` permission.
- **Why:** this differs from the plan's "the focus timer runs in a foreground service". A timer that
  derives remaining time from the clock needs no running code while the screen is off, so there is
  nothing to keep alive. A foreground service would need the `specialUse` type (the only one that fits
  a study timer), a Play Console declaration with a demonstration video, and review risk, because Play
  rejects foreground services whose work "can be interrupted or deferred". Notification sounds are
  played by the system, so Android 17's background-audio rules don't silence them.
- **Trade-off:** without the exact-alarm permission, Android may deliver the end-of-block alert a
  little late in Doze. That delay must be measured on the founder's phone with the screen off for
  25+ minutes.
- **Alternatives:** a `specialUse` foreground service; `USE_EXACT_ALARM` (reserved for alarm-clock and
  calendar apps, likely rejected for DualRep).
- **Revisit when:** Phase 1, after measuring the alert delay. Audio study mode (Phase 2) is different:
  it does need `mediaPlayback` and `microphone` foreground services. See
  [ANDROID.md](ANDROID.md#phase-1-core-loop).

## D9. Exercise dataset: structured fields only, for now (2026-10-08)

- **Decision:** the Phase 1 import of free-exercise-db brings in the structured fields only (name,
  muscles, equipment, level, force, mechanic, category) plus DualRep's own curated fields. The dataset's
  `instructions` text and photos are **not** imported until their license is cleared. Every row keeps
  `origin = 'dataset'` and `dataset_id`, and starts with `reviewed = false`.
- **Why:** the repo's license file is the Unlicense, which talks only about "software"; nothing covers
  the data or the photos. The one instruction text checked matches bodybuilding.com, so the authors may
  not hold the rights they gave away. The plan's own check ("the license covers both the data and the
  images") is not met. Factual classifications are low risk; copied prose and photos are not. See
  [research/exercise-data-and-fsrs.md](research/exercise-data-and-fsrs.md) §A2.
- **Alternatives:** import everything and hope; pay for an exercise API; write every entry by hand.
- **Revisit when:** someone signs off legally, or DualRep has its own instructions (Claude drafts, a
  person reviews) and clearly licensed or self-made images.

## D10. Explicit grants on every table (2026-10-08)

- **Decision:** the migration revokes everything from `anon` and `authenticated` on each table, then
  grants exactly what the phone may do. Helper functions are not executable by `anon`.
- **Why:** Supabase projects created since 2026-05-30 no longer grant the Data API access to new tables
  automatically, and existing projects are reported to switch later (**verify** the date). Writing the
  grants out makes old and new projects behave the same and documents the client's exact rights. Some
  rights are column-level: `groups` allows updating only `name`; `tracy_events` only `accepted`.
- **Watch out:** a missing grant fails with 42501, the same code as an RLS denial. The connector drops
  such writes (42501 with HTTP 403) into the local `upload_failures` table, which the Sync Check
  screen shows. A 42501 with HTTP 401 means "not signed in" and is retried instead (D19).
- **Alternatives:** relying on default grants.
- **Revisit when:** every new table (copy the pattern).

## D11. No R8 minification yet (2026-10-08)

- **Decision:** release builds don't turn on R8 code shrinking (`enableMinifyInReleaseBuilds` in
  `expo-build-properties`) for now.
- **Why:** shrinking can strip classes that native libraries reach by reflection or JNI (PowerSync's
  SQLite core, op-sqlite), which shows up only as a crash in a release build on a device. The gain is a
  smaller download, which doesn't matter until the Play launch. One less thing to debug while proving
  the sync path.
- **Alternatives:** turn it on now with `extraProguardRules` keep rules and test every release build.
- **Revisit when:** Phase 5, before the first Play release: enable it, add keep rules as needed, and
  run the full loop on a release build.

## D12. tracy-ai is left unchanged in Phase 0 (2026-10-08)

- **Decision:** Phase 0 only reviewed the `tracy-ai` repo (at commit `88f4201`). No Tracy code changed.
- **Why:** Phase 0 has no AI features, and the right changes depend on decisions made in Phase 2
  (models, task list, per-caller secret, logging). The proposed changes are written down in
  [TRACY_INTEGRATION.md](TRACY_INTEGRATION.md#10-tracy-ai-changes-for-phase-2-proposed-not-made).
- **Revisit when:** Phase 2 starts.

## D13. Deleting never depends on anyone else's data (2026-10-08)

- **Decision:** no foreign key restricts a delete. Every foreign key is CASCADE or SET NULL, and a
  reference that can point at another person's row is SET NULL. Sets keep a copy of the exercise's
  name (`exercise_sets.exercise_name`), and `exercise_sets.exercise_id` became nullable. Deleting a
  group unshares the exercises, sources and plans members shared into it instead of deleting them
  (`exercises.group_id` is SET NULL, like sources and study plans).
- **Why:** with `exercise_id ... on delete restrict`, any set someone else logged against your
  exercise (even an outsider who only knew its id) made your account deletion fail, and a group
  owner could not delete their group. Google Play requires working account deletion. Deleting a
  group also silently deleted members' own exercises.
- **Alternatives:** keep RESTRICT and block cross-user references (deletion would still depend on
  others' rows); soft deletes.
- **Revisit when:** a new table links to rows other people own. `00_schema.test.sql` fails if a
  foreign key restricts deletes.

## D14. Optional references and shares are normalized, not refused (2026-10-08)

- **Decision:** a write made offline is never dropped because of something someone else did before
  it uploaded. BEFORE triggers rewrite what the server may not store, for client requests only:
  - an optional reference to a row the writer may not use, or that no longer exists, is stored as
    null. References to rows someone else may own (a session's plan, a set's exercise, a card's
    source chunk) are judged only when a write sets or changes them, so a stored value survives the
    row becoming unreadable. References to your own rows (presets, setups, sessions, blocks) are
    judged on every write that sets them.
  - a row shared into a group its owner is not a member of is stored unshared. This trigger fires on
    every client insert and update, not only ones that send `group_id`, so a row left shared by a
    race with leaving is unshared by its owner's next edit.
  - required (NOT NULL) parent references are still refused (42501).

  Details: [DATA_MODEL.md](DATA_MODEL.md#writes-the-server-normalizes-instead-of-refusing).
- **Why:** PowerSync uploads in order and the phone drops a write the server refuses for good
  (42501, 23503). Someone leaving a group, unsharing or deleting a row while you were offline would
  otherwise get your queued sets, sessions or cards dropped before they reached the server. Refusing would also tell a writer whether someone
  else's row exists; storing null for both a missing and an unreadable id doesn't.
- **Alternatives:** refuse with 42501 (the first version of these checks did; a review showed that a
  set logged offline was then dropped when the exercise's owner left the group before the upload);
  check references on every write (old rows would become uneditable after someone left a group).
- **Revisit when:** a new optional reference a client can write is added: it needs a normalizing
  trigger (`00_schema.test.sql` checks this).

## D15. Leaving or being removed from a group unshares your content (2026-10-08)

- **Decision:** when a membership is deleted, the leaver's own exercises, sources (with their files
  and chunks) and study plans in that group get `group_id = null`. Other members keep their own rows
  that point at that content, but no longer see it.
- **Why:** otherwise the content stayed visible to people the owner no longer shares a group with,
  and every later edit of it failed the "share only into your own groups" rule.
- **Alternatives:** delete the content (loses the owner's data); leave it shared (a privacy leak).
- **Revisit when:** Phase 4 adds per-member sharing settings.

## D16. The server picks invite codes; removing a member is one atomic RPC (2026-10-08)

- **Decision:** the phone has no privilege on `groups.invite_code`, so the server always picks it.
  Only the owner changes it: `regenerate_invite_code()` rotates it, and `remove_group_member()`
  deletes a membership and rotates the code in one transaction, returning the new code. The
  `group_members` DELETE policy admits only leaving (your own non-owner membership). `join_group()`
  locks the group row while it looks up the code. There is no ban list.
- **Why:** a code chosen by the phone could be guessable. Every member can read the code, so a
  removal without a rotation lets the removed person re-join, and a rotation before the removal lets
  them read the new code first; doing both in one locked transaction, with joins taking the same
  lock, closes both gaps. A queued, offline "remove" of someone else could not be made safe, so the
  app calls the RPC online.
- **Alternatives:** a ban table (more state to sync and explain); removal as a plain DELETE followed
  by a separate rotation (racy).
- **Revisit when:** Phase 4, if invite links need longer-lived or per-person codes.

## D17. card_states ids are derived and enforced (2026-10-08)

- **Decision:** a `card_states` id must be UUIDv5(`CARD_STATE_ID_NAMESPACE`, `user_id:card_id`). A
  CHECK enforces it (23514 otherwise), and there is no default.
- **Why:** two offline devices of one user then write the same row instead of colliding. Without the
  CHECK the id would be predictable but unprotected: a group mate could insert a row under your
  future id, and every upload of your real state for that card would fail.
- **Alternatives:** random ids plus a merge step; a composite primary key (PowerSync needs a single
  `id`).
- **Revisit when:** never for existing rows: the namespace must not change.

## D18. Library integrity checks on exercises (2026-10-08)

- **Decision:** two CHECKs on `exercises`: only `dataset` rows have a `dataset_id`, and a `user` row
  is never `reviewed = true`. They apply to the service role too.
- **Why:** `dataset_id` is the import's idempotency key and free-exercise-db ids are public; a user
  row holding one would make the import fail, skip the exercise, or merge into the user's row. And
  `reviewed` marks curated library content, which a user row must not claim.
- **Alternatives:** trust the RLS insert rules alone.
- **Revisit when:** Phase 1, when the import script is written.

## D19. HTTP 401 is retried, and nothing uploads without a session (2026-10-08)

- **Decision:** the connector treats any HTTP 401 as temporary (retried, never dropped), and it
  checks for a signed-in session before sending anything. Without one it stops with
  `NoSessionError` and the queue stays on the phone until the same user signs in again. A 42501
  with HTTP 403 is still a real denial: dropped and logged in `upload_failures`.
- **Why:** without a session supabase-js sends the publishable key, the request runs as `anon`, and
  PostgREST answers 401 with code 42501. Treating that as a permission error dropped the whole
  offline queue after a lost sign-in.
- **Alternatives:** drop a 401 like a 403 (loses the offline queue); sign out and clear the phone on
  a 401 (also loses it).
- **Revisit when:** the app adds account switching.

## D20. A strict Sync Check gate (2026-10-08)

- **Decision:** the Sync Check creates its test row only after checking that the server is
  unreachable at that moment, and PASS also requires PowerSync's sync stream to be connected.
- **Why:** Android can keep Wi-Fi on in airplane mode, so "airplane mode is on" didn't prove the row
  was written offline. And the upload goes through the Supabase API, which works even when PowerSync
  is misconfigured, so a row in Postgres alone didn't prove that sync works.
- **Alternatives:** trust the user's tap; check only that the row reached Postgres.
- **Revisit when:** the gate has passed; the screen can stay as a diagnostic.
