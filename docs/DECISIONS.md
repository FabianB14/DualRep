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
    exercises marked for short circuits, at demand level 1 or 2.
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
    A return countdown that ran out while you were on another screen starts the next block when you
    come back, or finishes the cycle if that was more than 5 minutes later.
  - Signing out stops the cycle first (it waits for a write in progress) and withdraws every alert,
    before the phone's data is cleared.
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
    the spotter already eased (a drop or a rest-pause) comes up 2 or more short again. The weight
    never goes up within a session.
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
  - Its id is `block-end-<block id>`, so scheduling it again replaces it. Pause, **End block early**,
    **Finish** and the handoff cancel it and clear it from the shade.
  - Tapping it opens the cycle screen. Only paths inside the app are ever opened from a notification.
  - While the cycle screen is open, the alert stays silent (the screen hands off with a haptic). On
    any other screen it shows, so a block never ends unnoticed.
  - No foreground service and no exact alarms yet.
  - The **Timer check** screen measures the real delay with the phone locked: it schedules a test
    alert in 1 or 25 minutes and compares when Android posted it with when it was due.
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
  again).
- **Why:** on Android 13 and later an app gets few chances to ask. Asking at the moment the alert
  matters gets more yeses, and the timer works without it
  ([ANDROID.md 1.2](ANDROID.md#12-notification-permission-and-channels)).
- **Alternatives:** ask at first launch (no context, more refusals); never ask (no alerts).
- **Revisit when:** Phase 2 adds review reminders (a second reason to ask).
