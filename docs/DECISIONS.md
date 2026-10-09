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
- **Built (2026-10-09):** as decided, in Phase 2: the `tracy-worker` Edge Function and the queue
  functions ([D31](#d31-the-study-pipeline-lives-in-dualrep-ai-calls-go-to-tracy-2026-10-09),
  [D37](#d37-the-job-queue-claiming-fencing-retries-and-repeatable-ids-2026-10-09)).

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
- **Status (2026-10-08):** built this way in Phase 1
  ([D28](#d28-phase-1-timer-alerts-a-scheduled-notification-until-measured-2026-10-08)). Still a
  proposal until the Timer check screen has measured the delay on the founder's phone.

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
- **Phase 1 note:** the 90 starter exercises ([D21](#d21-an-interverse-starter-library-ships-with-the-app-2026-10-08))
  have instructions written by Interverse, so this question doesn't touch them. Dataset rows still
  have none.

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
  [TRACY_INTEGRATION.md](TRACY_INTEGRATION.md#10-tracy-ai-changes-for-phase-2-done).
- **Revisit when:** Phase 2 starts.
- **Closed (2026-10-09):** Phase 2 made the changes in `tracy-ai`, on its branch
  `claude/bold-fermi-oglgch` until its pull request is merged
  ([D33](#d33-tracys-models-and-json-output-for-dualrep-2026-10-09),
  [D34](#d34-tracys-dualrep-lane-own-secret-no-groq-metadata-only-logs-2026-10-09)).

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
- **Closed (2026-10-08):** the Phase 1 import relies on it: it matches rows on `dataset_id` alone
  ([D27](#d27-the-exercise-import-pinned-safe-to-run-again-curators-work-kept-2026-10-08)).

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

## D21. An Interverse starter library ships with the app (2026-10-08)

- **Decision:** Phase 1 runs on 90 exercises written by Interverse, not on the imported dataset.
  The migration `20261008120000_starter_library.sql` seeds them (`origin = 'interverse'`,
  `reviewed = true`, no owner, no images, instructions in our own words), and the app bundles the
  same list ([`starterLibraryData.ts`](../src/features/training/starterLibraryData.ts)). So circuits
  work before the first sync and in airplane mode. The free-exercise-db import is built
  ([D27](#d27-the-exercise-import-pinned-safe-to-run-again-curators-work-kept-2026-10-08)), but
  curating its 876 rows is not needed for the gate.
- **Rules for the list:**
  - Ids are fixed: `00000000-0000-4000-8000-0000000e0001` to `…0000000e005a` today, in file order.
    A new exercise takes the next number after the highest one used. A removed id is never reused (a
    logged set may still point at it). The app treats the whole `…0000000eXXXX` range as starter
    ids.
  - Location: `gym` when any item is gym-only; `home` only for desk-side moves that need furniture
    (chair, desk, wall, doorway) and no equipment; otherwise `both`.
  - Heavy barbell lifts are demand level 3 and never go in a short circuit (`micro_ok = false`). Also
    kept out of short circuits: Dip (shoulder strain when tired) and Treadmill intervals (stepping on
    and off a moving belt every station).
  - Measure (counted in reps or in seconds) is "seconds" for conditioning, mobility, carries, wall
    sit, plank and side plank, and "reps" for everything else. It is not a database column: the app
    keeps it with the bundled list.
  - Isolation moves (curls, raises, calf work) use the movement pattern `other`, so a swap matches
    them by muscle instead.
  - Every setup template (home with just your body, home with dumbbells and bands, gym) has at least
    2 short-circuit options per strength pattern, 4 core, 5 conditioning (some low-impact) and 6 per
    body region. A unit test checks this.
- **Changing it:** edit the data file, run `node scripts/library/starter-library-sql.mjs`, and commit
  both (`npm run check:library` fails while they differ). A migration runs only once per database, so
  once this one is on the hosted project, a later change needs a **new** migration file: set
  `MIGRATION` in the script to a new timestamp and leave the old file alone. The new file sets every
  column of every starter row, so it replaces the old one's effect. Retiring an exercise needs a
  hand-written delete.
- **Withdrawing one on the server** (`reviewed = false`, or the delete) works without an app update:
  once the server's starter rows are on a phone, a bundled one the server no longer sends stays
  there for its name in history, but circuits and swaps stop picking it (its sets would otherwise
  lose their `exercise_id` on upload). For the same reason, a starter exercise added to the app is
  only picked once its row has reached the server: apply the new migration before shipping the
  build.
- **Why:** the gate needs circuits for every preset and setup from day one, offline, before any sync.
  Hand-written entries can be checked against the rules the circuit builder relies on, and their
  instructions are ours, so the licence question in D9 doesn't touch them. Curating the dataset is
  weeks of review.
- **Alternatives:** curate the dataset first (blocks the gate, and still no instructions until D9 is
  settled); a library that only arrives by sync (no circuits until the first sync).
- **Revisit when:** the dataset curation pass is done (reviewed dataset rows then join the circuits
  without code changes), or D9 is settled.

## D22. Default circuits are built on the phone, the same way every time (2026-10-08)

- **Decision:** there are no stored circuit tables. `buildDefaultCircuit`
  ([`circuits.ts`](../src/features/training/circuits.ts)) builds each move block on the phone from
  the preset's split, the setup and the library. The same input always gives the same circuit. A
  `variant` (the local day number plus the block number) rotates the choices, so blocks differ
  through a day and across a week.
  - **Short circuits (5, 10 or 15 minutes):** 50-second stations (work, then change-over); 2 rounds
    under 8 minutes, else 3. So 5 min = 3 stations × 2 rounds, 10 = 4 × 3, 15 = 6 × 3. Only
    exercises marked for short circuits, at demand level 1 or 2. As targets move on from session to
    session, a station still fits its 50 seconds: at most 40 s or 13 reps of work, and the
    change-over is worked out again from the new target. Past that, progress comes from the weight.
  - **Full sessions (30, 45 or 60 minutes):** 3 straight sets of each exercise; 120 s rest for demand
    level 3, 60 s otherwise. The number of exercises is picked so the estimate is closest to the time
    asked.
  - Stations are shared out by the split with largest-remainder rounding. A region at 0% never gets
    one.
  - Time model: 3 s per rep plus rest. Warm-up sets are not counted, so a session with heavy lifts
    runs a little longer than its estimate.
  - At most 2 heavy (demand level 3) lifts per full session. This is our own rule, not the plan's:
    confirm or tune it.
  - Default targets never guess a weight. It comes from the last session's sets (the spotter's
    next-session advice, [D24](#d24-the-spotters-rules-and-the-5-cap-with-double-progression-2026-10-08))
    or from the user.
  - **Swap** offers up to 5 alternatives that fit the setup: same movement pattern and muscle first.
  - The six system presets are bundled in the app as well (a test checks them against the first
    migration), so presets also work before the first sync.
- **Why:** the plan asks for default circuits for every preset × location × length, offline.
  Building them is cheap (about 4 ms for a full session from a 990-exercise library, in tests) and
  copes with custom splits, custom setups and the user's own exercises, which a fixed table can't.
  Because the output is predictable it can be tested: every system preset × 3 setups × every length
  is checked for fit, balance and time (estimates land at 92–109% of the time asked).
- **Alternatives:** precomputed tables in the database (don't adapt to custom splits or gear); built
  on the server (needs a connection).
- **Revisit when:** Phase 3, when Tracy's planner proposes circuits (this builder stays as the offline
  fallback), or if testers find the circuits repetitive.

## D23. The running cycle is saved on the phone, in a local-only table (2026-10-08)

- **Decision:** the loop's state lives in `local_state`, a local-only PowerSync table: a key and a
  JSON value, never synced or uploaded, cleared on sign-out. The running cycle is saved under the key
  `cycle`, and the timer check's measurement under `alert-test`.
  - The loop is a pure state machine ([`cycleMachine.ts`](../src/features/cycle/cycleMachine.ts)).
    It never writes anything itself. It lists each database write and each alert as data; the store
    saves that state first, then carries them out one at a time, in order.
  - Every row id is made in advance, and an insert is skipped when the row already exists. So a write
    that runs twice after a crash changes nothing, and a set is never lost or logged twice.
  - A failed write is retried (after 1 s, then doubling, up to 30 s). A write the app itself refuses
    as invalid can never succeed, so it is dropped and shown instead of blocking the loop.
  - Timers keep their end time, not a countdown, so a killed app reopens in the right place. A block
    that ended meanwhile hands off at once.
  - The loop only ticks while the cycle screen is open. The block-end alert covers the focus timer.
    The next block after a workout starts when the 30-second countdown ends, whether or not anyone is
    looking: its alert is scheduled as the countdown starts, and the first tick afterwards starts the
    block from the countdown's end. If nobody is back within 5 minutes after that block would have
    ended (its alert rang meanwhile), the cycle finishes instead.
  - A block's recorded end (`ended_at`) is its start plus the time actually focused, so pauses never
    count as focus time in History or Today. A workout's length runs from its start to its last set,
    and a workout nobody touched for an hour is closed as it stands and the cycle finished. Both end
    at its last set, so the finish screen and History show the same minutes.
  - Signing out finishes a running cycle first, so its block, workout and transition are closed on
    the server instead of left open for good. It first catches up with the clock, exactly as opening
    the cycle screen would: a block that started on its own after the countdown is recorded, and a
    workout left for an hour is closed. So the server ends up with the same rows whether or not the
    app was restarted before signing out. It also sends a closing write still waiting on the phone
    even when the cycle is already over. It waits for those writes, withdraws every alert, and when
    online gives the upload queue up to 10 seconds, before the phone's data is cleared.
- **Why:** an app restart, a killed process or a flat battery must never lose a logged set or write
  it twice, and Phase 1 adds no tables or columns to the database. The cycle belongs to this phone,
  not to the account. Keeping it in the same SQLite file as the loop's rows avoids a second storage
  engine.
- **Alternatives:** AsyncStorage (another package and a second store); a synced table (a schema
  change, and two phones would fight over one cycle); memory only (lost when Android kills the app).
- **Revisit when:** Phase 4 live sessions need a timer shared between phones.

## D24. The spotter's rules, and the 5% cap with double progression (2026-10-08)

- **Decision:** the spotter is plain rules in [`spotter.ts`](../src/features/training/spotter.ts);
  the file's header is the product spec. In short:
  - **The next set:** on target → carry on. 1 rep short → same weight, 30 s more rest (up to 180 s).
    2 or more short → drop the weight 10%, 15% or 20% (2, 3, or 4+ short), rounded down to a real
    weight; with no weight, lower the target to what was done. Last planned set 2+ short → one
    rest-pause mini-set (20 s rest, then the missing reps). Stop the exercise for today when a set
    comes up short and a quarter of the target or less was done, or the effort was 10; or when a set
    the spotter already eased (a drop, a rest-pause or a lowered target) comes up 2 or more short
    again. A lighter weight you picked yourself is not easing, so a miss after it drops the weight as
    usual. The weight never goes up within a session.
  - The spotter goes by the weight you used. A set logged with the weight at **None** is a bodyweight
    set, even if it had a target weight.
  - In a short circuit the next set of an exercise comes a round later, after the other stations. The
    round is its rest, so 1 rep short means the same target next round (no extra rest), and the note
    says "Next round" instead of "Next set".
  - **The next session:** raise only when every normal set hit its target with effort 8 or less (or
    not rated). Lower 10% when more than half the sets were 2+ short. Otherwise hold.
  - Timed sets use the same rules on seconds; every full 5 s short counts as 1 rep short.
  - Weights move in real steps ([`units.ts`](../src/features/training/units.ts)): 5 lb; in kg,
    2.5 kg, or 2 kg for dumbbells; 4 kg for kettlebells in both units.
- **The cap:** the weight rises at most 5% from one session to the next, and only on a raise. When one
  step is more than 5% (20 lb dumbbells: 5 lb is 25%), reps go up instead (double progression: +2
  from 10 reps, +1 below 10, up to 15). At 15 reps the weight goes up one step and the reps reset so
  that the estimated strength the set needs (Epley: weight × (1 + reps / 30)) still rises 5% at most.
  For example, 20 lb × 15 becomes 25 lb × 7. If that would leave fewer than 5 reps, the step is too
  big: hold. A test checks the cap over about 100,000 cases.
- **Why:** the plan asks for "load increases capped per session, starting at 5 percent". A cap on the
  weight alone would freeze anyone on light dumbbells forever. Rules give the same answer every time,
  explain themselves in one line, and work offline in well under a millisecond.
- **Alternatives:** cap the weight only (no progress on small dumbbells); fractional plates (most home
  gyms don't have them); a learned model (needs data and a connection).
- **Revisit when:** the Phase 3 decision on the load cap, or beta feedback on how fast weights climb.

## D25. How a logged set is stored (2026-10-08)

- **Decision:**
  - The effort chips set `exercise_sets.rpe`: Easy = 6, Solid = 8, All out = 10. No chip = null
    (unknown). The 1–5 rating of a focus block is separate (`interval_blocks.effort_rating`).
  - A timed set stores its seconds of work in `reps` and `target_reps`. The exercise's measure says
    how to read them (bundled for starter exercises; worked out from the movement and the name for
    others).
  - `rest_seconds` is the rest taken before the set: the time since the previous set, minus this
    set's work (3 s per rep, or the set's seconds). It is null for the workout's first set.
  - `set_index` counts from 0 across the whole workout. `exercise_name` is always filled.
  - Weights are stored in pounds exactly as converted from kg, never rounded (rounding would make kg
    weights land just under their real step).
  - One tap on **Done** logs the target as done; the − and + buttons change the numbers first.
- **Why:** the schema is frozen in Phase 1, and there is no seconds column. Three chips are quick
  between sets and line up with the spotter's thresholds (8 or less to raise, 10 to stop).
- **Alternatives:** a 1–10 slider (slower between sets); a new `seconds` column (a schema change).
- **Revisit when:** the next schema change: add a `seconds` (or `measure`) column, so reading history
  never depends on working out a custom exercise's measure.

## D26. What transitions.accepted means (2026-10-08)

- **Decision:** a `transitions` row is written when a move block starts after a focus block, with
  `proposal` = the circuit as planned (JSON) and `accepted` null.
  - The first logged set sets `accepted = 1`.
  - Skipping or ending the move block before any set sets `accepted = 0`, deletes the empty workout
    and sets the row's `workout_session_id` to null (what the server's ON DELETE SET NULL would do).
  - After a set, ending the workout early still counts as accepted. Swapping an exercise doesn't
    change it.
  - "Just train" writes no transition.
- **Why:** with a zero-tap handoff the move block always opens, so "opened" means nothing. The first
  set is the clearest sign the user took the proposal, and it gives Phase 3 a clean measure of how
  often a handoff turns into training.
- **Alternatives:** accepted when the block opens (always 1); acceptance per exercise (needs a schema
  change).
- **Revisit when:** Phase 3, when Tracy's proposals and swaps need finer logging
  (`tracy_events.accepted` is separate).

## D27. The exercise import: pinned, safe to run again, curators' work kept (2026-10-08)

- **Decision:** [`build-import-sql.mjs`](../scripts/exercise-import/build-import-sql.mjs) writes one
  SQL statement that loads free-exercise-db into `public.exercises`. A manual GitHub workflow
  (**Exercise import SQL**) builds it, proves it on a throwaway database, and uploads it for pasting
  into the Supabase SQL Editor.
  - Pinned twice: upstream commit `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5` and sha256
    `5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf`. Any other file is refused
    unless `--allow-unpinned` is given.
  - Values the rules don't know (a new muscle, equipment or category) are refused and listed, not
    guessed.
  - Rows match on `dataset_id` only. New rows get `origin = 'dataset'`, `reviewed = false`, no owner,
    empty images and instructions, and curated fields from the research §A6 rules.
  - On a later run: the dataset facts (name, muscles, level, force, mechanic, dataset category) are
    refreshed; curated fields are kept (written on insert only); images and instructions are set to
    empty (D9); `reviewed` stays true only if no fact changed.
  - A row with nothing to change isn't touched, so its `updated_at` stays and phones don't download
    the library again.
  - Rows the file no longer has are kept (a logged set may point at them) and only counted.
  - The statement ends with one summary row: rows in the file, inserted, updated, review reset,
    unchanged, not in the file.
- **Why:** the import must be safe to run again after every upstream update, without undoing
  curators' work or making every phone re-download. A changed fact needs a person to look again.
- **Alternatives:** delete and re-insert (loses reviews, breaks links from logged sets); match by name
  (names change); import only once.
- **Watch out:** proven on Postgres 16 with every migration applied, but the roughly 200 KB statement
  has not yet been pasted into the real SQL Editor (hosted Supabase runs Postgres 15 or 17).
- **Revisit when:** moving to a newer copy of the dataset
  ([the import README](../scripts/exercise-import/README.md#moving-to-a-newer-copy-of-the-dataset)),
  or when D9 is settled.

## D28. Phase 1 timer alerts: a scheduled notification until measured (2026-10-08)

- **Decision:** built as D8 proposed. The timer keeps its end time and the screen shows end − now.
  When a focus block starts, a local notification is scheduled for its end (a DATE trigger) on the
  channel `timers-v1`: high importance, the default sound, vibration, shown on the lock screen.
  - Its id is `block-end-<study session id>-<block number>`, so scheduling it again replaces it.
    Pause, **End block early**, **Finish** and the handoff cancel it and clear it from the shade. The
    next block's alert is scheduled when the countdown after a workout starts (D23), and a running
    block's alert is scheduled again whenever the cycle screen opens or Settings sees notifications
    allowed, so a block started while they were off still rings once they are on.
  - Tapping it opens the cycle screen. Only paths inside the app are ever opened from a notification.
  - While the cycle screen is open, the alert stays silent (the screen hands off with a haptic). On
    any other screen it shows, so a block never ends unnoticed.
  - No foreground service and no exact alarms yet.
  - The **Timer check** screen measures the real delay with the phone locked: it schedules a test
    alert in 1 or 25 minutes and compares when Android posted it with when it was due. Android clears
    a tapped notification by default, so the test alert is posted with `autoDismiss: false`, and a
    tap on it also saves the time it was posted before the screen opens.
- **Why:** see D8. The channel id carries a version because users own a channel's settings once it
  exists, so a different sound later needs a new id.
- **Alternatives:** see D8; a custom alert sound (needs a sound file and a new channel).
- **Revisit when:** the 25-minute Timer check has run on the founder's phone. If the alert comes
  within about a minute, D8 becomes final and exact alarms stay out. If it is regularly later, add the
  optional exact-alarm setting ([ANDROID.md 1.3](ANDROID.md#13-exact-alarms-optional)).

## D29. The notification permission is asked in context (2026-10-08)

- **Decision:** the app asks for `POST_NOTIFICATIONS` only when the user taps **Start focus block**
  and Android still allows asking, after a one-line reason. That "still allowed to ask" state is how
  the app knows it is the first start; nothing extra is stored. **Just train** never asks. If the
  answer is no, the block starts anyway and a quiet "Alerts are off" note shows. Settings shows the
  state, with **Turn on alerts** (asks again) or **Open system settings** (when Android won't ask
  again). A block already running when alerts are turned on gets its alert then (D28).
- **Why:** on Android 13 and later an app gets few chances to ask. Asking at the moment the alert
  matters gets more yeses, and the timer works without it
  ([ANDROID.md 1.2](ANDROID.md#12-notification-permission-and-channels)).
- **Alternatives:** ask at first launch (no context, more refusals); never ask (no alerts).
- **Revisit when:** Phase 2 adds review reminders (a second reason to ask).
- **Phase 2 (2026-10-09):** kept. The review reminder asks in the same way, at its own moment:
  when the user turns on **Remind me when cards are due** in Settings
  ([D47](#d47-the-daily-review-reminder-2026-10-09)).

## D30. expo-notifications' extra permissions are blocked in Phase 1 (2026-10-08)

- **Decision:** `app.config.ts` removes, with `android.blockedPermissions`, the permissions that
  expo-notifications' dependencies declare but DualRep doesn't use: Firebase push
  (`com.google.android.c2dm.permission.RECEIVE`), Google's install referrer
  (`com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`) and 16 launcher-badge
  permissions (`READ_APP_BADGE` and vendor ones). The Phase 1 APK asks for Phase 0's three plus
  `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `ACCESS_NETWORK_STATE` and `WAKE_LOCK`
  ([ANDROID.md permission ledger](ANDROID.md#permission-ledger)).
- **Why:** each permission is a Play declaration or a Data safety answer
  ([ANDROID.md 0.4](ANDROID.md#04-keep-the-manifest-lean)). The end-of-block alert is a local
  notification: it needs none of these. The Phase 1 gate checks that it still rings.
- **Alternatives:** leave them in until push arrives (more to declare, for nothing).
- **Revisit when:** Phase 4 adds push: take `c2dm.permission.RECEIVE` out of the list
  ([ANDROID.md 4.2](ANDROID.md#42-push-notifications-for-friend-activity)).

---

## Phase 2: the study engine (2026-10-09)

D31–D49 record how Phase 2 was built. The founder's steps are in
[SETUP §17](SETUP.md#17-phase-2-the-study-engine-on-your-phone); the tables, functions and jobs are
in [DATA_MODEL.md](DATA_MODEL.md#the-study-pipeline).

## D31. The study pipeline lives in DualRep; AI calls go to Tracy (2026-10-09)

- **Decision:** the work of turning material into cards runs in DualRep, as jobs in `tracy_events`
  ([D7](#d7-dualrep-owns-the-ai-job-queue-2026-10-08)). A `tracy-worker` Edge Function does the work.
  - It does **one step per call**: one Tracy call of at most 110 s, inside the Edge Function's
    150 s limit on the Free plan. Then it calls itself again (with `EdgeRuntime.waitUntil`) while
    more work is queued, at most 20 times in a row (`MAX_HOPS`).
  - `pg_cron` is the safety net: every minute it wakes the worker, but **only when a job is queued**
    or a running one is stale, so an idle project spends none of its monthly function calls.
  - The worker calls Tracy's `POST /ai/extract` and `POST /ai/tasks/dualrep_*` with
    `X-Service-Secret` (Tracy's `SERVICE_SECRET_DUALREP`, kept in Supabase as
    `TRACY_SERVICE_SECRET`), and writes the results with DualRep's own service role.
  - Before a step that needs Tracy it calls `GET /health` (5 s). If Tracy is asleep (Render's free
    plan), the job goes back in the queue without counting an attempt
    (`release_tracy_event`), and the next minute tries again. The health call itself wakes Tracy.
  - Tracy stores nothing on disk and logs only metadata (it keeps the last Storage file it read in
    memory for a few minutes, see D34). DualRep's tasks never fall back to Groq.
- **Why:** DualRep's service-role key never leaves DualRep, and its data never rests on Tracy. One
  short step per call fits the Free plan's limits, and the jobs table doubles as the phone's
  progress view.
- **Alternatives:** a queue on Tracy's server (Tracy would need DualRep's service key); one long
  call per source (doesn't fit in 150 s); Supabase Queues (pgmq), possible later.
- **Revisit when:** a step regularly needs more than 110 s (move to Supabase Pro's 400 s, or the
  Message Batches API), or the queue gets busy enough that one user's long PDF delays others.

## D32. One Edge Function, `study`, starts AI work for the user (2026-10-09)

- **Decision:** everything a person does that starts or steers AI work goes through one Edge
  Function, `study`, with five actions: `submit_source`, `confirm_transcripts`, `approve_outline`,
  `retry_job` and `cancel_job`. The request and response shapes are written at the top of
  [`supabase/functions/study/index.ts`](../supabase/functions/study/index.ts), and the app's copy is
  [`studyApi.ts`](../src/features/study/studyApi.ts).
  - It checks the caller's sign-in itself (`auth.getClaims`, role `authenticated`). The gateway's
    own check (`verify_jwt`) is off, because it also lets in the publishable key, which ships
    inside the app and so proves nothing.
  - It checks ownership as the user (an RLS client), and only then writes with the service role
    and queues jobs.
  - **Building a plan needs the internet; studying never does.** The phone makes the source's id,
    uploads the files, then calls `submit_source`. The function writes the `sources`,
    `source_files` and `plan_sources` rows, and the phone receives them by sync.
  - Every action is safe to send twice: `submit_source` answers `already_submitted`,
    `approve_outline` answers `already_approved`.
  - `approve_outline` takes `source_id: null` to approve every outline of the plan that is waiting,
    because the phone can't tell which source a draft topic came from.
  - `retry_job` puts **the same row** back in the queue (not counted again against the monthly
    cap). `cancel_job` stops a queued or running step; on a failed page transcription it means
    **Skip this page**.
  - Errors are a `code` plus a fixed English sentence the app may show (never the person's
    material). Over the cap it answers 429 `cap_reached` with the reset date.
- **Why:** one place to check the session, the tier and the cap, and the phone never holds a
  secret. The phone writing no source rows itself means a retried upload can never undo what the
  pipeline did.
- **Alternatives:** the phone inserting `sources` and a database trigger queuing the job (no clean
  place for the cap and the file checks); one function per action (five deploys, five copies of the
  same checks).
- **Revisit when:** Phase 3 adds Tracy actions for the user (the planner, the grader): they can be
  new actions here, or their own function if they must answer within 3 seconds.

## D33. Tracy's models and JSON output for DualRep (2026-10-09)

- **Decision:**
  - The four DualRep tasks (outline, cards, handwritten notes, scanned PDF pages) run on Tracy's
    **strong** tier, `TRACY_TASK_MODEL_STRONG`, default **`claude-sonnet-5-5`**. The cheaper
    **`claude-haiku-5-5`** is a one-variable switch on Render. The fast tier,
    `TRACY_TASK_MODEL` (default `claude-haiku-4-5`), is unchanged; `convert_asset` runs there
    exactly as before.
  - JSON comes from **structured outputs** (`output_config.format` with a JSON schema), on every
    model, with no `temperature` and no forced `tool_choice` (Sonnet 5.5 rejects both).
  - On `claude-sonnet-5-5`, `claude-opus-5` and `claude-opus-5-5` only, Tracy also sends
    `fallbacks: "default"` with the header `anthropic-beta: server-side-fallback-2026-07-01`. **In
    plain words:** if Anthropic's safety checks decline a request (for example course material
    about computer security or AI), Anthropic re-runs it on another Claude model in the same call.
    `TRACY_TASK_FALLBACKS=off` on Render turns it off. Haiku 5.5 has no such fallback.
  - A decline that remains comes back as `502 code: "refused"` (with its category), an answer cut
    off at the length limit as `code: "truncated"`. All model errors are 502, so the worker reads
    `code`, not the status.
  - Each task has one time budget that includes preparing its input (downloading and rendering
    scanned pages): 105 s for outline, cards and scanned pages, 90 s for notes, and the model
    always keeps at least 5 s. The worker waits 110 s, so Tracy's answer always arrives first.
  - Tracy wraps a single content block in a list: the Messages API takes a string or a list of
    blocks, and a bare block would have failed every outline and cards call.
- **Why:** the plan names Sonnet 5.5 for the study builder; structured outputs are the one way
  that works on every current model. Costs (estimates from the Phase 2 research, not measured):
  about **$1.10 per 100-page PDF** on Sonnet 5.5 (likely $0.80–$1.80) and **$0.03 per handwritten
  page**; about **$0.06** and **$0.002** on Haiku 5.5
  ([SETUP §17 costs](SETUP.md#what-phase-2-costs-each-month)).
- **Alternatives:** a forced tool with `strict: true` (rejected by Sonnet 5.5); Haiku 5.5 as the
  default (twenty times cheaper, quality on DualRep's material not compared yet); sending whole PDFs
  as documents (page images cost 5–10 times more).
- **Revisit when:** the first real course has run: compare Haiku 5.5 with Sonnet 5.5 on the same
  material, and check the real `usage` against the estimates. If the first live call returns 400,
  set `TRACY_TASK_FALLBACKS=off` (the fallback with structured outputs is not verified live).

## D34. Tracy's DualRep lane: own secret, no Groq, metadata-only logs (2026-10-09)

- **Decision:**
  - **One secret per caller.** `SERVICE_SECRET` is Interverse's, `SERVICE_SECRET_DUALREP` is
    DualRep's. Each caller runs only its own tasks; `/ai/extract` is DualRep's only. A wrong
    secret and another caller's task both get the same 403. If the two secrets are equal, Tracy
    treats the caller as Interverse (DualRep gets 403) and warns at boot.
  - **No Groq** for DualRep: uploads may be private or copyrighted, so they stay with Anthropic.
  - **Metadata-only logs:** one JSON line per call (caller, task, request id, status, code, model,
    token counts, stop reason, latency). Never the material, the answer or an error's text, and
    never a conversation log.
  - **Error texts are content-free:** validator and input errors name fields and indexes only, and
    a failed model call reads "model call failed (upstream 429)" or "(timed out)". The worker still
    stores only its own fixed sentences in `tracy_events.error`, which syncs to the phone
    ([D37](#d37-the-job-queue-claiming-fencing-retries-and-repeatable-ids-2026-10-09)).
  - **`DUALREP_STORAGE_HOSTS` fails closed:** Tracy downloads files only from the hosts it lists
    (`<project-ref>.supabase.co`). Unset, every PDF, Word and photo job is refused, with the same
    code (`bad_url`) whether the call was `/ai/extract` or a transcription, so the phone always says
    "The study builder isn't set up yet" for it. A pasted `https://…/` is reduced to its host, and
    `/diag` says whether every entry looks like a host.
  - **`/ai/extract` pages through long PDFs:** at most 100 pages per call, and it stops starting
    new pages after 60 s (or 3 million characters); `last_page` says where it stopped, and the
    worker continues from there.
  - **Untrusted files are read in a child process** (review fix, 2026-10-09): PDFs and Word files,
    and the rendering of scanned pages, run in a separate Node process that Tracy stops past 350 MB
    of memory (`EXTRACT_MAX_MEMORY_MB`) or its time limit. A 100 KB Word file can unpack to 100 MB
    and a 300 KB PDF to a 300 MB page; read inside Tracy, that took the whole service down (and
    Interverse and `/chat` with it). Such a file now fails with "The file is too large to read." One
    file is read at a time; a second request meanwhile gets 503 `busy`, and the worker tries again
    a minute later without counting it. Scanned pages are rendered one at a time as JPEG (a few
    hundred KB each, about half the CPU of PNG), within 45 s, so the model keeps most of the task's
    time.
  - **The last Storage file stays in Tracy's memory** for up to 10 minutes, and each new request
    for it asks Storage only whether it changed (`If-None-Match`; Storage still checks the signed
    URL). A 200-page scan is transcribed in 50 batches of 4 pages; downloading the whole file each
    time used about 1.3 GB of the project's 5 GB monthly downloads.
- **Why:** [TRACY_INTEGRATION.md §7](TRACY_INTEGRATION.md#7-data-boundary-keep-dualrep-data-out-of-tracys-stores):
  DualRep's material must never land in Tracy's memory, knowledge, logs or a third provider.
- **Alternatives:** sharing Interverse's secret (no way to revoke or limit DualRep alone).
- **Revisit when:** a third caller arrives (copy the pattern), or DualRep gets its own Anthropic
  workspace and spend limit (today it shares Tracy's account and monthly limit).

## D35. Embeddings are optional and off by default (2026-10-09)

- **Decision:** without a `GEMINI_API_KEY` secret, the pipeline skips embeddings and
  `source_chunks.embedding` stays null. With one, an `embed` job runs beside the outline (never
  blocking it): `gemini-embedding-2` at 1536 dimensions, 50 chunks per call, each chunk sent as
  `title: … | text: …` (this model ignores task types), the key in the `x-goog-api-key` header,
  and `embed_model = 'gemini-embedding-2@1536#p1'` (`#p1` names the prefix scheme). Vectors are
  checked and normalised.
- **Why:** Phase 2 needs no search: links between cards come from the card builder seeing the
  plan's existing cards. And on Gemini's free tier Google may use what is sent to improve its
  products, with human reviewers. So **set the key only with Gemini billing turned on** (about
  $0.012 per 100-page PDF).
- **Alternatives:** embed from day one on the free tier (a privacy problem for private notes).
- **Revisit when:** a feature needs search over the material (Phase 3 explanations, perhaps). Also
  decide then about `halfvec(1536)` and the global HNSW index: the Free plan's 500 MB holds only
  about 25,000 chunks at today's layout (an estimate).

## D36. Monthly caps count units per stage (2026-10-09)

- **Decision:** each user has monthly caps, enforced by `enqueue_tracy_event` in the database.
  - Two stages are counted: **sources** (`extract`, 1 unit per PDF, Word file or link) and **pages**
    (`transcribe`, 1 unit per photo or scanned PDF page). Outline, cards and embeddings are not
    counted.
  - The limits come from Edge Function settings: `DUALREP_CAP_SOURCES_FREE` (default 5),
    `_PAID` (30), `DUALREP_CAP_PAGES_FREE` (20), `_PAID` (200). `none` means no limit. They are
    optional GitHub variables that the Deploy backend workflow copies across.
  - Usage is the sum of `tracy_events.cap_units` (a new server-only column) for that user and
    stage since the start of the month, UTC. A job cancelled before it ever ran gives its units
    back; one that ran still counts. An advisory lock per user and stage makes two requests at once
    unable to both slip under the limit.
  - Over the cap the function answers 429 `cap_reached` with `{stage, used, limit, resets_at}`,
    and the app says, for example, "You've used all 5 sources for this month. More can be added
    from November 1." (for pages: "… handwritten and scanned pages …", because PDF pages without a
    text layer use the same limit as photos of notes). Hitting the cap during `submit_source` undoes
    the whole submit (its uploaded files are swept after 3 days). Scanned PDF pages past the page
    cap are skipped, with a note on the source; they are only read by adding the file again.
  - **Try again (`retry_job`) checks the cap too** when the job's units were given back (it was
    cancelled before it ran): `requeue_tracy_event` puts the same job back under the same lock, or
    answers `cap_reached`. Without that, "queue, cancel while queued, add more, then retry the
    cancelled ones" got past the limit (review fix, 2026-10-09).
  - The tier comes from `has_paid_access()`, so beta access ([SETUP §14](SETUP.md#14-give-yourself-beta-access-for-testing))
    gets the paid limits.
- **Why:** each source and page costs real money at Anthropic
  ([D33](#d33-tracys-models-and-json-output-for-dualrep-2026-10-09)). Counting units, not rows,
  because a long PDF re-queues itself once per window and one transcription job can hold 4 pages.
- **Alternatives:** counting rows (wrong for long PDFs); caps in the app (anyone could skip them);
  counting tokens (the bill's real unit, but impossible to show a person in advance).
- **Revisit when:** beta usage shows the real cost per user (a Phase 5 decision sets the free-tier
  caps and the price).

## D37. The job queue: claiming, fencing, retries and repeatable ids (2026-10-09)

- **Decision:**
  - `claim_tracy_events` takes the oldest queued job with `FOR UPDATE SKIP LOCKED` and counts the
    attempt. First it reaps jobs still `running` 5 minutes after they were locked: back to the
    queue, or failed after the third attempt with "This step took too long. Try again."
  - **Fencing:** the worker finishes a job only where `status = 'running'` and `attempts` and
    `locked_at` still match what it claimed. A worker that was presumed dead can't overwrite a job
    that has since been retried. `locked_at` is in the fence so a long PDF can reset `attempts` for
    each new window and get three tries per window.
  - **Retries:** an answer Tracy's checks rejected goes back to Tracy with the findings as
    `previous_errors`; a cut-off answer goes back with "answer more briefly" (and an outline with
    half as many entries, see D38). A refusal, a bad file or a wrong secret fails at once. Network
    errors, timeouts and 5xx retry, up to 3 attempts. Express's own 404/405 page ("the DualRep lane
    isn't deployed yet") fails at once with "The study builder isn't set up yet. Try again later."
  - **Released, not counted:** only a job that never reached Tracy: its `/health` check failed
    (Render's free service asleep), or Tracy answered 503 `busy` (it reads one file at a time). The
    database counts these in a row (`tracy_events.releases`); after 15 (about a quarter of an
    hour) Tracy is down rather than asleep and the job fails with "Tracy couldn't be reached for a
    while. Try again later." Render's HTML 502/503/504 page after a passing `/health` means Tracy
    died with the request (often out of memory) and **is** counted, so a file that crashes Tracy
    fails after three tries. (Before the review fix both were released uncounted: such a file
    crashed Tracy every minute for ever, and as the oldest queued job it held up everyone's.)
  - **One step at a time:** `claim_tracy_events(p_limit, p_max_running)` claims nothing while
    `DUALREP_WORKER_CONCURRENCY` jobs (default 1) are running with a lock under 3 minutes old. The
    every-minute cron and the self-kicks otherwise added a parallel chain each minute during a
    backlog, and two scanned-page renders at once exceed Render's free 512 MB.
  - **Fixed messages:** every `error` the phone shows is one of a fixed list of English sentences
    (`MESSAGES` in [`supabase/functions/_shared/errors.ts`](../supabase/functions/_shared/errors.ts)).
    They never contain the material, a URL or a model's words.
  - **Repeatable ids:** every row and follow-up job the server makes gets a UUIDv5 id worked out
    from what it is (namespace `1689dae2-a02e-4c59-b2ad-51fab8769792`): chunks from
    source, page and position; draft topics, cards, links, and the outline, embed and cards jobs.
    Writing the same thing twice hits the same id, so a retried step never duplicates rows and a
    follow-up job is queued at most once, without locks.
  - **Two-phase outline and cards steps:** Tracy's answer is saved in the job's `output` before any
    rows are written, so a run cut short continues from the saved answer without a second Tracy
    call.
- **Why:** an Edge Function can die mid-step (the 150 s limit, a restart). Every step must be
  safe to repeat and must never cost a second Tracy call when it doesn't have to.
- **Alternatives:** a lease without fencing (a slow old worker could overwrite a new result);
  random ids plus checks (races between two workers).
- **Revisit when:** the first real jobs run: the worker log's `applied` field should be true. If
  finishes come back `applied: false`, the `locked_at` round trip through PostgREST is the suspect.

## D38. How a source moves through the pipeline (2026-10-09)

- **Decision:**
  - `sources.status`: `pending` → `processing` → `ready` or `failed`. It belongs to the server: a
    phone's value is ignored, not refused ([D40](#d40-schema-changes-for-the-study-engine-2026-10-09)).
  - **PDF, Word and links:** `extract` reads the text page by page into `source_chunks`. Scanned
    PDF pages (no text layer) go to `transcribe` jobs of up to 4 pages, and are chunked straight
    away with no review. Whichever of these jobs finishes last queues the outline, so nothing waits
    or polls.
  - **Photos of notes:** one `transcribe` job per photo. The transcripts are drafts
    (`source_files.confirmed = false`) until the person checks them and taps **Confirm**
    (`confirm_transcripts`). Only then are they chunked and outlined. A diagram is kept as a
    `[Diagram: …]` line the person can edit.
  - A page whose transcription failed holds the outline until the person tries it again or skips
    it (**Skip this page** = `cancel_job`).
  - **The outline** writes new topics as `draft`, numbered after the plan's existing topics, and
    keeps which chunks go where. The person keeps, cuts, renames and orders them, then taps **Save
    and make cards** (`approve_outline`). Kept topics become `confirmed`.
  - **An outline that only adds to topics the plan already has** (common in a growing course) has
    no drafts to review, so the worker approves it itself and goes on to cards.
  - `approve_outline` sets aside the drafts of an outline whose job didn't finish; they are
    reviewed with it later. Its writes (confirm kept topics, delete cut drafts, queue the cards
    jobs, mark the outline approved) happen in one transaction (`apply_outline_approval`), and it
    only ever deletes topics that are still drafts. Written one call at a time, a failure halfway
    left kept topics confirmed with no cards job, and the next approval of new material deleted
    them, with their cards and reviews (review fix, 2026-10-09).
  - **Cards:** one job per kept topic (at most 40 chunks each), plus one for each existing topic
    the outline added material to. Up to 300 of the plan's existing cards go along, so the builder
    can link to them and avoid repeats. A topic is `ready` when its cards jobs are done and at least
    one succeeded; a source is `ready` when none of its cards jobs is open. A failed or cancelled
    extract or outline marks the source `failed`, and **Try again** puts it back to `processing`.
  - **Sizes:** at most ceil(chunks / 5) topics (1–30) and ceil(1.5 × chunks) cards per topic
    (2–20); card types question, fill-the-gap and explain-why.
  - **The outline's input is kept small**, because its answer must list every entry once and has
    to fit Tracy's output budget (thinking included, within 105 s): entries are sent as short
    references (`c1`, `c2`, …, about 3 tokens each instead of about 25 for a UUID), at most 200 of
    them (a source of more than 200 chunks, about a 70-page PDF, is outlined in groups of
    neighbouring chunks), and an answer that was cut off or too slow is asked again with half as
    many entries (100, then 50), never with the same input. (Before the review fix a 100-page
    course PDF could never be outlined: 300 UUIDs did not fit.)
  - A failed cards job shows on its source ("Couldn't finish", **Try again**) until it is retried,
    even when other topics' cards were made; notes whose every page was skipped show "Every page
    was skipped" with **Try again**, and the last page that isn't skipped can't be skipped.
  - Signed Storage URLs for Tracy last 600 s, and the worker checks a file's path is inside its
    owner's and source's folder before signing it.
- **Why:** the plan says transcriptions are confirmed before any cards are made, and the outline is
  reviewed before cards. Everything else follows the rule "nothing waits on a person unless a person
  has something to decide".
- **Alternatives:** one cards job per source (too long for one call); asking the person to approve
  outlines that add nothing new (a screen with nothing on it).
- **Revisit when:** `source_chunks` gets a title column (better outline hints for plain PDFs), or
  testers find the outline review a chore.

## D39. The backend is deployed by a GitHub workflow (2026-10-09)

- **Decision:** [`.github/workflows/deploy-backend.yml`](../.github/workflows/deploy-backend.yml),
  **Deploy backend**, run by hand (Actions → Deploy backend → Run workflow). The founder no longer
  pastes migrations into the SQL Editor.
  - **Dry run** is ticked by default: it shows what would change and changes nothing. A real
    deploy runs from `main` only.
  - The project ref comes from the existing `EXPO_PUBLIC_SUPABASE_URL` variable
    (`SUPABASE_PROJECT_REF` overrides it, only needed for a custom domain). Supabase CLI 2.119.0,
    with the `SUPABASE_ACCESS_TOKEN` secret; no database password.
  - The first time, it records the two migrations that were pasted by hand, but only when the
    migration history is empty **and** the tables are really there (the starter library only when
    its 90 exercises are).
  - Then `db push` (dry run first), the functions' secrets, the worker secret, `functions deploy
    --use-api`, and a smoke test: `tracy-worker` must answer a wrong secret with its own 403, and
    `study` a bad sign-in with its own 401. It also reports whether Tracy's `/health` answered.
  - **Secrets:** `TRACY_SERVICE_SECRET` and the optional `GEMINI_API_KEY` from GitHub secrets;
    `TRACY_URL` and the optional caps from GitHub **variables** (an address and numbers are not
    secrets). They reach the CLI through a private temporary file, never a command line. An
    optional setting missing in GitHub is removed from the project, so deleting the
    `GEMINI_API_KEY` secret and re-running turns embeddings off.
  - **The worker secret** (pg_cron → `tracy-worker`) is made by the workflow: `openssl rand -hex
    32`, saved first as the function secret `DUALREP_WORKER_SECRET`, then in Vault as
    `dualrep_worker_secret`, then checked by comparing hashes (never the value). It is made when
    either copy is missing, or when **Make a new cron -> tracy-worker secret** is ticked. Vault also
    gets `dualrep_project_url`.
  - **CI:** a new **Edge Functions** job in `ci.yml` runs `deno check`, `deno lint` and `deno test`
    in `supabase/functions` with Deno 2.2.15 (pinned). `supabase/functions/deno.json` is for that
    tooling only (the CLI never deploys it), and every import names an exact version. The app's
    TypeScript and jest leave `supabase/functions` out.
- **Why:** the founder has a Windows PC and no Docker; GitHub's runners do the work, and the dry
  run shows the plan before anything changes.
- **Alternatives:** the CLI on the founder's PC (needs the database password and more tools); the
  SQL Editor (no history, and the migration is too long for one paste); `[db.vault]` in
  `config.toml` (only applied when a migration is pending, so a rotation would silently do nothing).
- **Revisit when:** a production project arrives (Phase 5): run it per environment, with a GitHub
  Environment for each.

## D40. Schema changes for the study engine (2026-10-09)

- **Decision:** one migration,
  [`20261009120000_study_engine.sql`](../supabase/migrations/20261009120000_study_engine.sql), applied
  by the Deploy backend workflow:
  - `topics.status`: `draft | confirmed | ready`, default `ready` (a topic made by hand is ready at
    once). Existing rows were touched so PowerSync sends the new value.
  - `cards.source_id`: the card's source, **worked out by a trigger** from its source chunk (the
    phone never receives chunks). A writer can clear it but never point it elsewhere. The app marks
    it `serverGenerated`, so it is never uploaded.
  - `sources.status` **belongs to the server.** A phone's INSERT is stored as `pending`, and a
    phone's UPDATE keeps the stored status: ignored, not refused, so old app builds keep working
    and a late upload never undoes the pipeline's progress.
  - `tracy_events` gains `stage` (`extract | transcribe | outline | cards | embed`, and a CHECK
    that ties each stage to its job), `plan_id` and `source_id` (synced, `on delete set null`), and
    the server-only `cap_units`. The phone still may only change `accepted`.
  - `source_files.storage_path` must be `<owner_id>/<source_id>/<plain file name>` (lowercase ids,
    no subfolders or `..`), otherwise 23514. The worker reads files with the service role, which
    skips Storage's own rules, so this stops a path into someone else's folder.
  - The private Storage bucket `sources`, the queue functions (service role only), and the
    pg_cron schedule ([DATA_MODEL.md](DATA_MODEL.md#the-study-pipeline)).
- **Why:** the phone has to show each source's progress, the outline review and "p. 12, Lecture 3"
  from synced rows only.
- **Alternatives:** a separate `jobs` view (more sync config); letting the phone set
  `sources.status` (a retried upload could move a finished source back to pending).
- **Revisit when:** the next schema change: new migrations need timestamps after `20261009120000`.

## D41. Uploads go to a private bucket, prepared on the phone (2026-10-09)

- **Decision:**
  - Files go to the private bucket `sources` at `<user_id>/<source_id>/<n>.<ext>` (`n` = the file's
    number, from 1), with an explicit content type. Each user may read and write only their own
    folder; group members can't read the files in Phase 2.
  - Limits: PDF or Word (`.docx`) up to 25 MiB, one per source; up to 20 photos per set of notes;
    the bucket accepts only PDF, DOCX, JPEG, PNG and WebP.
  - **Photos** are picked at full quality and decoded once: the long edge shrunk to at most 2576 px
    (never enlarged), saved as JPEG at 0.85. That also removes EXIF and GPS data and converts HEIC.
    Photos over 50 megapixels are refused (decoding one needs about 200 MB of memory).
  - Documents up to 5 MiB upload through supabase-js; larger ones stream from disk with
    expo-file-system's `File.upload`.
  - A failed attempt keeps what was picked and reuses the **same source id**, so tapping **Add to
    plan** again overwrites the files instead of adding copies.
  - Before `submit_source`, the app waits up to 15 s for the phone's own pending uploads (a plan
    made offline must reach the server first), and asks again after 2, 4 and 8 s if the server
    says the plan isn't there yet.
  - Files nobody points at any more are swept daily once they are 3 days old.
  - Adding material needs the internet; the app says so plainly.
- **Why:** the worker downloads with the service role, so the path rule and the bucket rules are
  the guard. Shrinking photos on the phone saves upload time, storage (1 GB on the Free plan) and
  model cost, and strips location data before it leaves the phone.
- **Alternatives:** uploading the original photos (larger, and they keep GPS); resumable uploads
  (not needed at 25 MiB).
- **Revisit when:** group sharing of sources (Phase 4) needs members to read files; or uploads of big
  PDFs over mobile data fail often.

## D42. Android: CAMERA is the only new permission (2026-10-09)

- **Decision:** Phase 2 adds exactly one Android permission, `CAMERA` (from expo-image-picker),
  asked when the person taps **Take a photo**.
  - The gallery uses the system Photo Picker and documents the system file picker: no permission.
  - `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` and
    `ACCESS_MEDIA_LOCATION` are blocked in `app.config.ts`, whatever a library declares.
  - A small inline config plugin declares `android.hardware.camera` and `…camera.autofocus` as
    `required="false"`, so Play doesn't hide the app from devices without a camera.
  - `RECORD_AUDIO` stays in `blockedPermissions`. expo-image-picker's `microphonePermission: false`
    option is **not** used: it would remove the microphone app-wide, out of sight, and break audio
    study mode later.
  - **Take a photo** is hidden below Android 10 (API 29), where the camera would also need
    `WRITE_EXTERNAL_STORAGE`, which stays blocked. The gallery works there.
- **Why:** each permission is a Play declaration or a Data safety answer
  ([ANDROID.md permission ledger](ANDROID.md#permission-ledger)).
- **Alternatives:** a small native module that opens the camera app without declaring `CAMERA`
  (more native code to maintain); broad photo access (needs a Play declaration DualRep can't
  justify).
- **Revisit when:** audio study mode (Phase 2B) unblocks `RECORD_AUDIO`.

## D43. FSRS runs on the phone, one transaction per answer (2026-10-09)

- **Decision:**
  - Scheduling uses `ts-fsrs` 5.4.2 on the phone. **DualRep's defaults are ts-fsrs's defaults plus
    fuzz** (`enable_fuzz: true`, seeded from the review, so replaying the log gives the same
    result). `profiles.fsrs_params` null means those defaults. When it is set, each valid field is
    used and each invalid one ignored, so studying always works.
  - **Each answer is one local `writeTransaction`:** check the review id (a repeat writes nothing),
    read the card's state, INSERT the `reviews` row, then UPDATE the `card_states` row or INSERT it
    under its derived UUIDv5 id ([D17](#d17-card_states-ids-are-derived-and-enforced-2026-10-08)).
  - The review time is clamped to `max(now, last_review)`, so a clock that moved back never breaks
    a card. `reviews.elapsed_days` is worked out on the phone in whole UTC days. `duration_ms` runs
    from showing the card to the answer, capped at 10 minutes.
  - **A `card_states` change uploads its whole FSRS state** (the 9 state columns, with their values
    after the change), not only the changed columns. This is new: `patchTogether` in
    [`tables.ts`](../src/db/tables.ts), using PowerSync's `trackPrevious`.
    - The spec asked for the whole row. `suspended` is left out on purpose: it is the person's own
      switch, and sending it with every review would let a review from a second phone turn a pause
      back off.
    - A change queued by an older app version uploads only its changed columns, as before.
- **Why:** two phones studying offline could otherwise leave a mix of two states (stability from
  one review, due date from the other). The server's stale-write guard keeps or skips whole states.
- **Alternatives:** FSRS on the server (studying would need the internet); uploading the full row
  (the pause problem above).
- **Revisit when:** moving to ts-fsrs 6 (the stored columns don't change), or when there are
  enough reviews to fit personal FSRS weights into `profiles.fsrs_params`.

## D44. Answer modes and typed answers (2026-10-09)

- **Decision:**
  - **Two buttons by default:** "Missed it" (Again) and "Got it" (Good). Settings → **Answering
    cards** switches to four (Again, Hard, Good, Easy). Each button says when the card comes back,
    from the real FSRS preview.
  - **Typed answers are opt-in** (Settings → **Type short answers**) and checked on the phone, only
    for short answers. Alternatives in an answer are separated by `;` or `|`. Two rules on top of
    the research version: every number must match exactly (decimal points and minus signs kept, so
    9.8 is not 9.81), and a spelling slip only counts as close when the first letter matches (so
    "affect" for "effect" is wrong). Review fixes: an answer that contains the expected words may
    add only filler words ("it's the mitochondria", "in 1914"); "mitosis or meiosis", "not true" or
    "oxidation and reduction" are wrong, because a close answer is saved as Good at once. And words
    that start with opposite prefixes (hyper/hypo, exo/endo, ab/ad, inter/intra, …) are never a
    spelling slip of each other.
  - A right or close answer is saved as Good ("Counted as right. Spelling: …" for a close one). A
    wrong one shows the answer with **I missed it** (Again) or **Count it as right** (Good). An empty
    answer counts as "I don't know". Typed answers never give Hard or Easy.
  - Known false accepts stay (for example "mitochondrion" for "mitochondria"): the screen shows the
    right spelling, and **Count it as right** covers the opposite mistake.
- **Why:** self-grading is fast and honest enough for spaced repetition; typing helps for short
  facts. Grading open answers needs Tracy (Phase 3).
- **Alternatives:** typed answers by default (slow for long answers); stricter matching (more
  false "wrong"s, which feel unfair).
- **Revisit when:** Phase 3 adds Tracy's answer grader.

## D45. The quiz-first block sits beside the timer, not inside it (2026-10-09)

- **Decision:**
  - **The start panel** offers "Just a timer" plus each study plan ("12 due · 5 new", or "No
    cards yet"). A growing course with more than one source also offers **Everything so far** or
    **Newest source**, for the whole cycle. With a plan, the session's subject is the plan's
    title. The last choice is remembered on this phone. With no plans on the phone, the panel is
    exactly Phase 1's.
  - **The saved cycle stays at version 1.** `CyclePlan` gains two optional fields, `studyPlanId` and
    `studyFilter`, present only when a plan was chosen, so Phase 1's saved cycles load unchanged.
    `study_sessions.plan_id` is written once, when the session is created.
  - **The study panel** reads and writes the phone's database itself; the timer machine, the alert
    and the handoff are untouched. With a plan, the ring shrinks to 120 dp beside the "Next:" line
    and the panel sits below it. Each answer is its own transaction, tagged with the block
    (`reviews.interval_block_id`).
  - **Order in a block:** due learning cards, then due reviews (taking turns between sources or
    topics, the one served least first), then new cards, then a **closing self-test** in the last
    2–5 minutes (12% of the block) of up to 5 of this block's new or missed cards. If a learning
    card is due within a minute the panel waits ("Next card in 0:42", **Ask now**). Then "All caught
    up".
  - **New cards:** about one per 5 minutes of block (2–8; 5 in a 25-minute block) and 20 a day
    (Settings: 5–100). A new card shows its question and answer together, then **Quiz me** hides the
    answer and asks; its `duration_ms` is timed from **Quiz me**. Recall and self-test cards show
    the question alone. With an exam date and unseen cards left, reviews stop after 60% of the block's
    study time so new material still gets in.
  - The card on screen stays until it is answered, even when the queue refreshes. Its answer mode
    is fixed when it appears, and its review id is made at the first save and reused on a retry, so
    a failed save never counts twice. Pause hides it.
    When the block ends, an open card is dropped without a write and stays due, so the handoff stays
    zero-tap.
  - Cards of `draft` topics are never studied; `confirmed` ones are (a slow worker never hides cards
    that exist).
  - Cards made by hand (no source) are in every block of their plan, whichever source it studies.
    The due and new counts on Home, the plan and the reminder count only what a block asks: in a
    single-source plan, its hand-made cards and its studied source's (review fix, 2026-10-09).
  - A card just answered stays out of the queue until both the block's answers and its own due row
    show the answer (the two live queries refresh separately), so a learning card is never asked
    twice in a second.
- **Why:** the plan's quiz-first block (due cards → new material → closing self-test) without
  risking the Phase 1 loop, which is already tested offline end to end.
- **Alternatives:** study steps inside the timer machine (a new state version and every Phase 1
  test touched); a separate study screen (breaks the zero-tap handoff).
- **Revisit when:** a week of real use: tune the constants (about 10 s per review, 40 s per new
  card), and decide whether new cards should wait for their 10-minute learning step instead of
  the early self-test.

## D46. Reviews are due on their day, not their minute (2026-10-09)

- **Decision:** a review card counts as due for the whole local day it falls due on. A block asks
  every review due today from its start, and "due" counts on Home and the plan screen mean **due
  today** ("12 cards due today"). Learning and relearning steps (minutes)
  keep their exact times.
- **Why:** FSRS schedules reviews in whole days, but stores the minute of the last answer. A card
  answered at 09:02 was not due at the next day's 09:00 block: the block said "All caught up" and
  the reminder rang a day late. A test that runs a full week of blocks
  ([`weekOfReviews.test.ts`](../src/features/study/__tests__/weekOfReviews.test.ts)) failed before
  this change.
- **Alternatives:** due at the exact minute (the bug above); rounding the due time when saving it
  (changes the stored FSRS values).
- **Revisit when:** people study across midnight and find "today" confusing.

## D47. The daily review reminder (2026-10-09)

- **Decision:** an optional reminder, off until the person turns it on in Settings → **Daily review
  reminder** (18:00 offered; any time in 15-minute steps). Turning it on asks for the notification
  permission if Android still allows asking
  ([D29](#d29-the-notification-permission-is-asked-in-context-2026-10-08)).
  - Channel `reviews-v1` (default importance), one notification id (`reviews-due`). It says "Cards
    to review: N cards are due. A 10-minute block clears a lot of them." The lock screen shows only
    the count, never a card.
  - If cards are due by the next reminder time: a daily reminder with that count. If not: a
    reminder at the reminder time on the day the first card falls due and on each of the 13 days
    after it (unanswered cards stay due, so a dismissed reminder is not the last one; review fix,
    2026-10-09). If no card will ever be due: none.
  - It is set again when the app starts, when it returns to the foreground, when card states change
    (at most every 30 s), after each study block, and when the setting changes. It never throws.
  - No background sync and no exact alarm: a reminder a little late is fine.
- **Why:** the plan's daily "reviews due" nudge, without a server or push.
- **Alternatives:** push from the server (needs Firebase and Phase 4's push setup); a fixed daily
  reminder whether or not cards are due (noise).
- **Revisit when:** Phase 4 adds push, or testers want more than one reminder a day.

## D48. The study screens (2026-10-09)

- **Decision:**
  - **Routes:** `/plans` (list), `/plans/new`, `/plans/[id]` (plan), `/plans/[id]/edit` (Plan
    settings), `/plans/[id]/add` (Add material), `/plans/[id]/check/[sourceId]` (transcription),
    `/plans/[id]/outline`, `/plans/[id]/cards`, `/plans/[id]/cards/[cardId]` (`new` makes a card by
    hand), `/plans/[id]/map`. Home has a **Study plans** row with the cards due today.
  - **One primary action per screen.** On the plan screen it follows the next step: **Check the
    transcription**, **Review the outline**, **Try again**, **Study now** or **Add material**. While
    material is being prepared there is no button, only a line. **Study now** stays available as a
    second button when cards exist.
  - **Study now** makes this plan the start panel's choice on this phone and opens the cycle.
  - **Add material** keeps one source id per piece of material (a document, a set of photos, a
    link) until it is added, so a retry overwrites instead of duplicating. Several documents picked
    at once each become their own source, added in turn; one that fails stops the rest, which stay
    listed.
  - "Online" on these screens means PowerSync is connected or connecting. The offline notice is
    only a warning; buttons are never disabled for it, and the action's own error has the final
    word.
  - **Transcription review:** each page's photo (from a 600 s signed link; "The photo shows when
    you're online" otherwise) and its text. Edits are saved on the phone when a field loses focus,
    so they survive going offline. **Confirm** sends every page's text.
  - **Outline review:** Keep or Cut, rename, **Move up** / **Move down** (also as screen-reader
    actions, no drag). **Save and make cards** sends every draft in the chosen order in one call,
    and asks first if every topic was cut.
  - **Concept map:** the chosen card in the middle and up to 6 linked cards around it; tap one to
    move it to the middle. Every link is also listed under the map. Relations read from the middle
    card's side ("Learn this first", "Builds on this", "Reason", "Similar idea", "Contrast",
    "Related"). Anyone who can read the plan may link cards and remove their own links.
  - Plan settings, deleting a plan, and editing or deleting cards are owner-only; pausing a card is
    for anyone who can read it.
  - Per-phone study settings live in `local_state`: `study-prefs` (buttons, typed answers, new cards
    a day, reminder), `study-defaults` (the start panel's last plan and filter) and
    `study-self-test` (when the running block's self-test began).
- **Why:** the plan's screen list, with nothing that depends on dragging or on being online except
  the steps that call the server.
- **Alternatives:** drag-to-reorder (not accessible enough alone); settings synced per account (a
  schema change for little gain).
- **Revisit when:** testers use the screens; removing a source from a plan isn't offered yet.

## D49. Audio study mode moves to Phase 2B (2026-10-09)

- **Decision:** on-the-go audio study is **not** in this build. It becomes Phase 2B and starts
  with a spike ([ANDROID.md 2.4](ANDROID.md#24-speech-in-the-background-spike-first)). Until then
  no `expo-audio`, no foreground services, and `RECORD_AUDIO` stays blocked.
- **Why:** background speech on Android 14–17 is unproven, and it brings foreground-service
  declarations with demo videos. The gate (a PDF and handwritten notes → one plan → a week of
  reviews) doesn't need it.
- **Alternatives:** build it now, unproven.
- **Revisit when:** the Phase 2 gate has passed.
