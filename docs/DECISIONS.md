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
  such writes into the local `upload_failures` table, which the Sync Check screen shows.
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
