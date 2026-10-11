# Roadmap

The eight phases from the [execution plan](EXECUTION_PLAN.md#roadmap), turned into checklists. Each
phase has a **gate** that must pass before the next phase starts. Week counts are the plan's estimates
for one developer.

How to use this page:

- Tick a box when the work is merged (or, for manual steps, done).
- **Android** tasks link to [ANDROID.md](ANDROID.md); **Tracy** tasks link to
  [TRACY_INTEGRATION.md](TRACY_INTEGRATION.md).
- **Decisions to make** are open questions for that phase. Record the answer in
  [DECISIONS.md](DECISIONS.md).

---

## Where we are now

*Updated 2026-10-09.*

- **Phase 0 passed its gate on 2026-10-08** on Fabian's Android phone (a preview APK from GitHub
  Actions, the hosted Supabase project and PowerSync Cloud), and its code is on `main` (pull request
  #2).
- **Phase 1 is built and on `main`** (pull request #3, merged 2026-10-08): the study → move → study
  loop, offline, with a focus timer and its alert, a zero-tap handoff into a circuit, a one-tap set
  logger with the spotter, 90 Interverse starter exercises, setups, presets, the library, history,
  settings and a Timer check. **Its gate on the phone is not recorded here yet**
  ([Phase 1 manual steps](#your-manual-steps-for-the-gate-in-order)).
- **Phase 2 (the study engine) is built in both repos**, on the branch `claude/bold-fermi-oglgch`
  in `DualRep` and in `tracy-ai` until their pull requests are merged:
  - study plans (one source or a growing course), material from PDFs, Word files, web pages and
    photos of handwritten notes, a transcription check, an outline review, cards with page
    references, a concept map;
  - the quiz-first study panel inside the focus block, FSRS scheduling on the phone (offline), and a
    daily review reminder;
  - the server side: a private Storage bucket, the `study` and `tracy-worker` Edge Functions, a job
    queue with monthly caps, a pg_cron schedule, and Tracy's new DualRep lane;
  - a **Deploy backend** GitHub workflow, so database changes no longer go through the SQL Editor.
- **Tests:** 2,528 app tests in 65 suites (one runs a full week of study blocks), 46 script tests,
  626 database tests in 15 files, 78 Deno tests for the Edge Functions, and 123 tests in `tracy-ai`.
  A cross-repo check also ran the real Tracy server against the real worker and `study` code, with
  a fake Anthropic: a PDF with a scanned page and a photo of notes, all the way to cards.
- **Not yet run for real:** nothing in Phase 2 has touched the hosted Supabase project, Tracy on
  Render, Anthropic or a phone. That is the Phase 2 gate, and it is yours
  ([your manual steps](#your-manual-steps-for-the-phase-2-gate-in-order): about an hour of setup, an
  hour or two on day 1, then about 10 minutes a day for a week).
- **Audio study mode moved to Phase 2B** ([DECISIONS.md](DECISIONS.md) D49): a spike first, after
  the Phase 2 gate.
- Phase 0 leftovers still open below: the PowerSync free-tier check, the Play Console decision, and
  the edge-to-edge look on the phone.

| Phase | Est. weeks | Status |
|---|---|---|
| 0. Foundation | 1–2 | **Gate passed** (2026-10-08) |
| 1. Core loop | 4–5 | **Built**, on `main`; gate result not recorded yet |
| 2. Study engine | 4–6 | **Built**; gate not yet run (manual steps below) |
| 2B. Audio study mode | — | Not started (spike first; moved out of Phase 2) |
| 3. Tracy coaching | 2–3 | Not started |
| 4. Friends | 2–3 | Not started |
| 5. Android launch | 2–4 per round | Not started |
| 6. iOS | 2–3 | Not started |
| 7. Glasses | 3–4 | Not started |

---

## Phase 0: Foundation

**Scope (plan):** Expo development build, Supabase project, PowerSync, auth, first migration, design
tokens.

**Gate:** a row created offline on a phone appears in Postgres after reconnecting.

### Built in the repo
- [x] Expo SDK 57 project (React Native 0.86, TypeScript strict, expo-router), development-build
      config in `app.config.ts` and `eas.json`
- [x] CI: typecheck, lint, unit tests and the sync-config check (`.github/workflows/ci.yml`), the
      database tests on Postgres 16 and on the Supabase CLI, and an installable APK build with a
      16 KB page-size check (`scripts/check-16kb.sh`: zip and ELF alignment; the build fails if either
      is off) and permission list (`.github/workflows/android.yml`)
- [x] First migration: all 23 tables, RLS on every table, explicit grants, triggers, the six system
      presets, the group RPCs (`join_group`, `regenerate_invite_code`, `remove_group_member`) and the
      `powersync` publication ([DATA_MODEL.md](DATA_MODEL.md)). Deleting an account or a group never
      depends on anyone else's data, and offline writes are never refused because of what someone
      else did meanwhile ([normalized writes](DATA_MODEL.md#writes-the-server-normalizes-instead-of-refusing))
- [x] pgTAP tests for every table and policy (`npm run db:test`: 13 files, 523 tests)
- [x] Supabase local config and email templates that show the 6-digit code (`supabase/`)
- [x] PowerSync Sync Streams config and instance config (`powersync/`), checked offline by
      `npm run validate:sync`
- [x] Client database: table registry, PowerSync schema, Supabase connector, `upload_failures` log
      (`src/db/`)
- [x] Sign-in with an emailed 6-digit code; session kept in SecureStore
- [x] Design tokens and theme (`src/theme/`)
- [x] "Setup needed" screen when the `.env` values are missing
- [x] Sync Check screen for the gate
- [x] Docs: this roadmap, [SETUP.md](SETUP.md), [ANDROID.md](ANDROID.md), [DATA_MODEL.md](DATA_MODEL.md),
      [DECISIONS.md](DECISIONS.md), [TRACY_INTEGRATION.md](TRACY_INTEGRATION.md)

### Your manual steps (in [SETUP.md](SETUP.md) order)
- [x] Create the accounts: GitHub, Supabase, PowerSync, Resend ([SETUP §1](SETUP.md#1-create-your-accounts)); Expo
      only when you start using EAS builds
- [ ] Set up the Windows PC ([SETUP §2](SETUP.md#2-set-up-your-windows-pc)): not needed for the gate (it
      used the GitHub-built APK), needed before Phase 1 coding
- [x] Merge the Phase 0 branch (`claude/bold-fermi-oglgch`) into `main` on GitHub with a pull request
      ([SETUP §4](SETUP.md#first-put-the-phase-0-code-on-main)): done 2026-10-08 (pull request #2)
- [ ] Clone the repo and run `npm ci` and `npm run check` ([SETUP §4](SETUP.md#4-get-the-code)). The first
      time you use the Supabase CLI on the project, run
      `npx supabase migration repair 20261008000000 --status applied` (the migration went in through the
      SQL Editor). Once Phase 1's migration is in too, name both (Phase 1, step 11). Since Phase 2 the
      **Deploy backend** workflow records them itself, so this is only needed if you use the CLI first
- [x] Create the Supabase project and apply the migration ([SETUP §5](SETUP.md#5-create-the-supabase-project-and-push-the-database)), through the SQL Editor
- [x] Set up the sign-in emails ([SETUP §6](SETUP.md#6-set-up-sign-in-emails-and-check-the-signing-keys)): custom SMTP with Resend (test
      mode), code templates, OTP length 6
- [x] Create the PowerSync replication role ([SETUP §7](SETUP.md#7-create-the-powersync-database-role))
- [x] Create the PowerSync instance and deploy the sync config ([SETUP §8](SETUP.md#8-create-the-powersync-instance))
- [x] Build and install the app: the preview APK from GitHub Actions with the three repository
      variables ([SETUP §10](SETUP.md#10-optional-the-github-actions-apk)). The development build (`.env`,
      [SETUP §9](SETUP.md#9-build-the-app-and-put-it-on-your-phone)) comes with the PC setup
- [x] Sign in on the phone and run the Sync Check ([SETUP §12](SETUP.md#12-run-the-sync-check-the-phase-0-gate)): **PASS**
- [ ] Optional: look at the row in the Supabase table editor ([SETUP §13](SETUP.md#13-confirm-the-row-in-postgres)); the
      Sync Check's PASS already asked Postgres directly
- [x] Run the Sync Check on a **preview** (release) APK against the hosted project (that is the build
      the gate passed on)
- [ ] Confirm the PowerSync free-tier limits on powersync.com/pricing (the plan asks for this before
      Phase 0 ends; see [SETUP §8](SETUP.md#8-create-the-powersync-instance))
- [x] Confirm the native modules build (the plan's second check): **confirmed by CI.** The GitHub
      Actions Android APK build compiled the release APK on 2026-10-08 with PowerSync's and op-sqlite's
      native modules under Expo SDK 57. Installing and running a build on your phone is still yours:
      that is the Sync Check above, the actual gate

### Android
- [ ] [0.1 Development build, not Expo Go](ANDROID.md#01-development-build-not-expo-go)
- [x] [0.2 Leave the SDK levels alone](ANDROID.md#02-leave-the-sdk-levels-alone)
- [ ] [0.3 Edge-to-edge and insets](ANDROID.md#03-edge-to-edge-and-insets-in-the-design-tokens): check
      on the phone with gesture and 3-button navigation
- [x] [0.4 Keep the manifest lean](ANDROID.md#04-keep-the-manifest-lean): the Phase 0 preview APK
      requested only `INTERNET` and `VIBRATE` (plus the app's own internal receiver permission). The
      Phase 1 packages add the notification permissions; their push, install-referrer and
      launcher-badge extras are blocked in `app.config.ts`: see the
      [permission ledger](ANDROID.md#permission-ledger) and the Phase 1 decision below
- [ ] [0.5 Play Console account: decide now](ANDROID.md#05-play-console-account-decide-now)
- [x] [0.7 16 KB page size check](ANDROID.md#07-16-kb-page-size-check) runs in CI (zip and ELF
      alignment; the APK build fails if either is off). EAS builds: check by hand (0.7)
- [x] [0.8 Schema ready for account deletion](ANDROID.md#08-schema-ready-for-account-deletion)
      (tested in `supabase/tests/09_deletion.test.sql`)

### Tracy
- [x] Review the `tracy-ai` repo and answer the plan's open question
      ([TRACY_INTEGRATION.md §1](TRACY_INTEGRATION.md#1-the-answer-to-the-plans-open-question)). No
      Tracy code changes in Phase 0.

### Decisions to make
- [ ] Personal or organization Play Console account (D-U-N-S takes up to 28 days)
- [ ] Supabase region and PowerSync region (pick the same area; PowerSync's can't change later)
- [ ] Who are the first 20 testers? (open question in the plan)

---

## Phase 1: Core loop

**Scope (plan):** focus timer, set logger, seeded and curated exercise library, focus presets, gym and
home setups, rules-based spotter, default micro circuits, zero-tap handoff.

**Gate:** a full study, lift, study cycle works in airplane mode, with a home setup and a gym setup.

### Built in the repo
- [x] Focus timer screen: block length 10–50 minutes (default from `profiles.default_block_minutes`),
      Pause, Resume, **End block early**, a ring that shows the time left. Writes `study_sessions`
      and `interval_blocks`. The 1–5 effort rating of the block is offered during the move block and
      the countdown after it
- [x] End-of-block alert: a scheduled notification, so the phone rings with the screen off or the app
      closed ([DECISIONS.md](DECISIONS.md) D28). A **Timer check** screen measures how late it rings
- [x] Exercise import tooling: free-exercise-db structured fields only, mapped with the rules in
      [research/exercise-data-and-fsrs.md §A6](research/exercise-data-and-fsrs.md), loaded as
      `origin = 'dataset'`, `reviewed = false`, pinned by upstream commit and sha256. A manual GitHub
      workflow (**Exercise import SQL**) builds and checks the SQL for the SQL Editor
      ([`scripts/exercise-import/`](../scripts/exercise-import/README.md), D27). It relies on no user
      row holding a `dataset_id` (D18), and sets `reviewed`, `images` and `instructions` explicitly
- [x] Interverse originals: a starter library of 90 exercises written by us (desk-side, small-space,
      home equipment and gym), seeded by the migration `20261008120000_starter_library.sql` and
      bundled in the app, so it works before the first sync (D21)
- [ ] Curation pass of the imported dataset rows (start with `movement_pattern = 'other'` and `gym`),
      setting `reviewed = true`. Not needed for the gate: the starter library covers every setup
- [x] Equipment setups: gym and home, a gear checklist, templates, more than one setup, a default
- [x] Focus presets: the six system presets or a custom split (steps of 5, must total 100). Chosen
      per cycle on the start screen, with a default in the profile. "Per study plan" waits for study
      plans (Phase 2)
- [x] Default circuits for every preset × location × 5/10/15 minutes (and full sessions of 30/45/60),
      built on the phone and available offline (D22)
- [x] Set logger: one tap per set; writes `workout_sessions` and `exercise_sets` (targets, actuals,
      rest, effort), and copies the exercise's name into `exercise_sets.exercise_name`. History shows
      that name whenever `exercise_id` is null or its exercise isn't on the phone (see
      [normalized writes](DATA_MODEL.md#writes-the-server-normalizes-instead-of-refusing))
- [x] Spotter rules engine in TypeScript with unit tests: drop sets, rest-pause, cut a set, longer
      rest, and raise, hold or lower next session, with the 5% cap (D24)
- [x] Location swap: `swapForSetup` replaces each exercise with one of the same movement pattern that
      fits a setup, and the **Swap** button offers up to 5 alternatives. (Each circuit is built for the
      chosen setup, so there is no "change setup mid-workout" button yet)
- [x] Zero-tap handoff: the timer ring morphs into the first exercise card (Reanimated; a cross-fade
      when Reduce motion is on), with a haptic. A `transitions` row links the block to the workout
      (D26)
- [x] The other screens: Home ("Today"), Setups, Presets, Exercise library (browse, search, add your
      own exercise), History, Settings (block length, units, alerts, sync, sign out), Timer check
- [ ] Airplane-mode test of the full cycle, once with a home setup and once with a gym setup: yours,
      below. (A unit test already plays both runs offline:
      `src/features/cycle/__tests__/airplaneLoop.test.ts`)

### Good to know
- The screen only updates while the cycle screen is open, but the timers don't depend on it. During
  a focus block the alert rings, and tapping it opens the cycle. The next block after a workout starts
  when the 30-second countdown ends even if you lock the phone or leave for another app, and its
  alert rings at its end; only if you come back more than 5 minutes after that does the cycle finish
  instead (D23).
- **Close** on the cycle screen goes to Home and leaves the cycle running; Home then shows
  "Back to your …". **Finish** ends the cycle and shows a summary.
- No new tables or columns in Phase 1. The only new migration is the starter library.

### Your manual steps for the gate (in order)
Details for each step are in [SETUP §16](SETUP.md#16-phase-1-the-core-loop-on-your-phone).

1. [ ] **Apply the new migration** `20261008120000_starter_library.sql`: Supabase dashboard → **SQL
       Editor** → **New query** → paste and **Run** each of the 7 parts in
       `supabase/sql-editor/starter-library/` (the whole file is too long for one paste), then check
       the count is 90 ([SETUP §16 step 1](SETUP.md#step-1-add-the-starter-library-to-the-database)).
       Do this **before** the gate, so the sets you log can link to their exercises on the server
2. [ ] **PowerSync: nothing to do.** The sync config already sends reviewed library exercises to every
       phone, so the 90 new rows arrive by themselves. No redeploy
3. [ ] **Build the preview APK** with GitHub Actions: **Actions → Android APK → Run workflow**, pick
       the branch `claude/bold-fermi-oglgch` (or `main` once the Phase 1 pull request is merged) and
       `preview` ([SETUP §16 step 2](SETUP.md#step-2-build-and-install-the-phase-1-app))
4. [ ] **Install** it over the old app (you stay signed in). Open it once online: Settings → **Sync**
       should say **Connected: Yes**
5. [ ] **Gate run 1, home:** airplane mode on; Start a study block with a home setup; let the timer
       end (the phone must ring); do the circuit; let the next block start by itself (it does even
       if the screen turns off during the 30-second countdown); then Finish
       ([SETUP §16 step 3](SETUP.md#step-3-the-gate-run-1-with-a-home-setup))
6. [ ] **Gate run 2, gym:** add a gym setup, then the same run with it in airplane mode
       ([SETUP §16 step 4](SETUP.md#step-4-the-gate-run-2-with-a-gym-setup))
7. [ ] **Back online:** wait for **Waiting to upload: 0**, then check the rows in the SQL Editor
       ([SETUP §16 step 5](SETUP.md#step-5-check-the-rows-reached-postgres)). Both runs pass → tick
       the airplane-mode item above
8. [ ] **Timer check:** 25 minutes, phone unplugged, locked and left alone; tap the alert when it
       rings (don't swipe it away). Write the delay here
       ([SETUP §16 step 6](SETUP.md#step-6-measure-the-alert-delay-the-timer-check)).
       Result: _not measured yet_ (date, phone, delay)
9. [ ] Optional: build the exercise-import SQL and run it in the SQL Editor (after the Phase 1 pull
       request is merged; [SETUP §16 step 7](SETUP.md#step-7-optional-load-the-exercise-dataset)).
       Nothing changes in the app until rows are reviewed
10. [x] Merge the Phase 1 pull request into `main`: done 2026-10-08 (pull request #3)
11. [ ] ~~The first time you use the Supabase CLI on the hosted project, mark both migrations as
        applied~~: no longer needed by hand. Phase 2's **Deploy backend** workflow records them
        itself, the first time it runs ([SETUP §17 step 5](SETUP.md#step-5-deploy-the-backend-a-dry-run-then-for-real))

### Android
- [x] [1.1 Focus timer: scheduled notification, not a foreground service](ANDROID.md#11-the-focus-timer-scheduled-notification-not-a-foreground-service):
      built; the delay measurement is manual step 8
- [x] [1.2 Notification permission and channels](ANDROID.md#12-notification-permission-and-channels):
      asked when the first study block starts; channel `timers-v1`
- [ ] [1.3 Exact alarms (optional)](ANDROID.md#13-exact-alarms-optional): deferred; only if the Timer
      check shows the alert comes too late
- [x] [1.4 Screen on during sets](ANDROID.md#14-screen-on-during-sets): only during the move block
- [ ] [1.5 Live countdown in the notification shade (optional)](ANDROID.md#15-live-countdown-in-the-notification-shade-optional):
      deferred (polish)
- [ ] [1.6 Test through Play's internal testing track](ANDROID.md#16-test-through-plays-internal-testing-track):
      needs the Play Console app first (0.5)

### Tracy
- None. The transition planner comes in Phase 3; Phase 1 uses the default circuits.

### Decisions to make
- [ ] Final timer approach after measuring the alert delay with the screen off
      ([DECISIONS.md](DECISIONS.md) D8, D28)
- [ ] Ask for exact alarms or not (follows from the measurement; [ANDROID.md 1.3](ANDROID.md#13-exact-alarms-optional))
- [ ] Exercise dataset license: keep the structured-fields-only import, or clear the text and images
      ([DECISIONS.md](DECISIONS.md) D9)
- [x] New packages for this phase: `expo-notifications` 57.0.22, `expo-keep-awake` 57.0.2 and
      `react-native-svg` 15.15.4 (added 2026-10-08). `ts-fsrs` waits for Phase 2
- [x] The extra permissions that come with `expo-notifications` (Firebase push, install referrer,
      16 launcher badges): **decided, blocked** in `app.config.ts`; unblock the push one in Phase 4
      ([DECISIONS.md](DECISIONS.md) D30, [ANDROID.md permission ledger](ANDROID.md#permission-ledger)).
      Gate runs 1 and 2 double as the check that the end-of-block alert still rings
- [ ] Confirm or tune our own circuit rules: at most 2 heavy lifts per full session, and no warm-up
      sets in the time estimate (D22)
- [ ] Timed sets keep their seconds in `exercise_sets.reps`: add a proper column at the next schema
      change? (D25)
- [ ] When the imported dataset gets curated, and by whom (not needed for the gate)

---

## Phase 2: Study engine

**Scope (plan):** DualRep surface on Tracy with the study builder; upload of PDFs, docs, links and
photos of handwritten notes; single-source and cumulative plans; FSRS scheduling; quiz-first blocks;
concept links; on-the-go audio mode. **Audio mode moved to [Phase 2B](#phase-2b-audio-study-mode)**
([DECISIONS.md](DECISIONS.md) D49).

**Gate:** a real course PDF and a page of handwritten notes become one cumulative plan, and a week of
reviews runs correctly.

### Built in the repo
- [x] A private Storage bucket, `sources` (25 MiB per file; PDF, Word, JPEG, PNG, WebP), where each
      person reads and writes only their own folder. `source_files.storage_path` must stay inside
      its own source's folder (D40, D41)
- [x] Upload flow: **Add material** → a file (PDF or Word), photos (gallery or camera) or a web link
      → the `study` Edge Function, which writes `sources`, `source_files` and `plan_sources` and
      queues the first job ([Android 2.7](ANDROID.md#27-camera-and-photo-access), D32, D41)
- [x] `tracy-worker` Edge Function and a `pg_cron` schedule (every minute, only when work is
      queued), with `claim_tracy_events`, `release_tracy_event` and `enqueue_tracy_event` (D31, D37)
- [x] Per-page text extraction (Tracy's `POST /ai/extract`) and chunking into `source_chunks`.
      Embeddings (Gemini, 1536 dimensions) are built but **off** until a `GEMINI_API_KEY` is set
      (D35)
- [x] Handwriting: transcription draft → the person checks it and taps **Confirm**
      (`source_files.confirmed`) → only then the outline and cards. Scanned PDF pages are
      transcribed too (D38)
- [x] Outline review (keep or cut, rename, move up or down) → `topics`, then `cards` with page
      references and links between cards (D38, D48)
- [x] Single and cumulative plans (Plan settings switches between them any time); the "everything
      so far / newest source" filter on the cycle's start panel (D45)
- [x] FSRS with `ts-fsrs` 5.4.2: `card_states` and `reviews` written in one local transaction, with
      the derived `card_states` id; a review uploads the whole FSRS state (D43)
- [x] Cards and sessions cope with links the server stored as null: a card without a readable
      source shows "Made by hand" or "A source you can't see", and the study panel copes with a
      plan that has left the phone
- [x] Quiz-first block: due cards → new material → closing self-test, inside the focus block, with
      the timer, alert and handoff unchanged (D45, D46)
- [x] Concept links and the map view (`card_links`, D48)
- [x] Daily "reviews due" reminder (D47)
- [x] Monthly caps per user: 5 sources and 20 pages (photos of notes and scanned PDF pages) a month free, 30 and 200 paid (D36)
- [x] **Deploy backend** workflow (D39), and a CI job that type-checks, lints and tests the Edge
      Functions with Deno
- [ ] ~~On-the-go audio mode~~: moved to [Phase 2B](#phase-2b-audio-study-mode)
- [ ] The gate on the phone: yours, below

### Good to know
- **Building a plan needs the internet; studying never does.** Adding material, confirming a
  transcription, saving an outline and **Try again** call the server. Answering cards, the
  reminder and the cycle work in airplane mode.
- **What the plan screen shows for each source**, in order: "Waiting to start" → "Reading your
  material" → "Check the transcription" (photos of notes only) → "Making the outline" → "Review the
  outline" (when it proposes new topics) → "Making cards (2 of 5)" → "Ready". A failure shows
  "Couldn't finish" with a short reason and **Try again**.
- Each step runs in the background on the server, one AI call at a time. Expect minutes, not
  seconds. (Tracy is on Render's Starter instance, which never sleeps.)
- "Due" now means **due today**: a review card is due for its whole day (D46).
- The cycle's saved state is still version 1: a cycle saved by the Phase 1 app loads unchanged.

### Your manual steps for the Phase 2 gate (in order)
Details for each step are in [SETUP §17](SETUP.md#17-phase-2-the-study-engine-on-your-phone).

1. [ ] **Check Tracy is up:** open its `/health` page in a browser
       ([step 1](SETUP.md#step-1-check-that-tracy-is-up))
2. [ ] **Make the Tracy secret** and save it in your password manager
       ([step 2](SETUP.md#step-2-make-the-tracy-secret))
3. [ ] **Render:** add `SERVICE_SECRET_DUALREP`, `DUALREP_STORAGE_HOSTS`, `TRACY_TASK_MODEL_STRONG`
       and `NODE_VERSION` to the Tracy service, merge the `tracy-ai` pull request, and check
       `/diag` ([step 3](SETUP.md#step-3-set-up-tracy-on-render-then-merge-its-pull-request))
4. [ ] **GitHub (DualRep):** secrets `SUPABASE_ACCESS_TOKEN` and `TRACY_SERVICE_SECRET`, variable
       `TRACY_URL`; optional secret `GEMINI_API_KEY` only with Gemini billing on
       ([step 4](SETUP.md#step-4-add-the-github-secrets-and-variables))
5. [ ] **Merge the DualRep Phase 2 pull request, then Deploy backend:** a dry run first, then for
       real ([step 5](SETUP.md#step-5-deploy-the-backend-a-dry-run-then-for-real))
6. [ ] **PowerSync:** paste the updated sync config and deploy. Needed this time: `tracy_events`
       sends three more columns ([step 6](SETUP.md#step-6-update-the-powersync-sync-config))
7. [ ] **Build and install** the Phase 2 preview APK; check the permission list
       ([step 7](SETUP.md#step-7-build-and-install-the-phase-2-app))
8. [ ] **Gate, day 1:** a growing course from a real course PDF and a page of handwritten notes;
       check the transcription, review the outline, study one block
       ([step 8](SETUP.md#step-8-the-gate-day-1-one-plan-from-a-pdf-and-a-page-of-notes))
9. [ ] **Gate, days 2 to 7:** one study block with the plan each day
       ([step 9](SETUP.md#step-9-the-gate-days-2-to-7-a-week-of-reviews)).
       Result: _not run yet_ (dates, phone, anything odd)
10. [ ] **Check the rows** in the SQL Editor
        ([step 10](SETUP.md#step-10-check-the-rows-in-postgres)). Both parts pass → tick the gate
11. [ ] Optional: try `claude-haiku-5-5` on the same material and compare the cards
        ([what Phase 2 costs](SETUP.md#what-phase-2-costs-each-month))

### Android
- [x] [2.5 Review reminders and background sync](ANDROID.md#25-review-reminders-and-background-sync):
      the reminder is built; no background sync (not needed)
- [x] [2.7 Camera and photo access](ANDROID.md#27-camera-and-photo-access): `CAMERA` is the only new
      permission; **Take a photo** is hidden below Android 10; the camera is "not required" on Play
      (D42)
- [ ] Check the permission list of the Phase 2 APK against the
      [permission ledger](ANDROID.md#permission-ledger) (manual step 7)
- Moved to [Phase 2B](#phase-2b-audio-study-mode): 2.1, 2.2, 2.3, 2.4 and 2.6

### Tracy
All of [TRACY_INTEGRATION.md §10](TRACY_INTEGRATION.md#10-tracy-ai-changes-for-phase-2-done), on the
`tracy-ai` branch `claude/bold-fermi-oglgch` until its pull request is merged:
- [x] `runTask` changes: per-task model tier, `max_tokens`, effort and time budget; structured
      outputs; no `temperature` on 5.x models; server-side fallback on Sonnet 5.5 (change 1, D33)
- [x] DualRep tasks with validators: `dualrep_build_outline`, `dualrep_build_cards`,
      `dualrep_transcribe_notes`, `dualrep_transcribe_pdf_pages` (change 2)
- [x] Per-caller secret, metadata-only logs and no Groq fallback for DualRep (changes 3–4, D34,
      [§7](TRACY_INTEGRATION.md#7-data-boundary-keep-dualrep-data-out-of-tracys-stores))
- [x] `prompts/surfaces/dualrep.md` (change 5)
- [x] Stateless per-page `POST /ai/extract` (change 6)
- [x] Tests (123 in all), `.env.example`, the README's DualRep lane section and the `TRACY.md`
      test line (changes 7–9)
- [ ] SDK bump as its own PR (change 10): not needed for Phase 2, because the installed 0.32.1
      passes the new fields through

### Decisions to make
- [x] Models for the strong tasks: `claude-sonnet-5-5` by default, `claude-haiku-5-5` one Render
      variable away (D33). **Still open:** compare the two on a real course after the gate
- [x] Gemini API key and project owned by DualRep: optional, off by default, and only with billing on
      (D35)
- [x] Monthly upload caps for the free tier: 5 sources and 20 pages (photos of notes and scanned PDF pages) a month to start (D36).
      **Still open:** set them from beta usage (Phase 5)
- [ ] Keep syncing `reviews` down to the phone, or make it upload-only later to save space
- [ ] New cards in the early self-test: a card answered "Got it" seconds after it was first shown
      moves straight to a 2-day review. Keep that, or make new cards wait for their 10-minute
      learning step? (D45)
- [ ] Before real users upload a lot: `halfvec(1536)` and no global HNSW index for `source_chunks`,
      if embeddings are turned on (D35)
- [ ] A separate Anthropic workspace with its own spend limit for DualRep (today it shares
      Tracy's account and monthly limit, D34)

---

## Phase 2B: Audio study mode

**Scope:** on-the-go mode from the plan: questions read aloud and answered by voice, with the screen
off. Moved out of Phase 2 so the study engine could ship first ([DECISIONS.md](DECISIONS.md) D49).

**Gate (proposed):** a 10-minute audio session with the screen locked, answered by voice or headset
buttons, on an Android 14+ phone.

### Build
- [ ] A one-day spike: screen-off speech recognition and text-to-speech on Android 14–17
- [ ] The audio mode itself, then the Play declarations

### Android
- [ ] [2.1 Foreground services for audio study mode](ANDROID.md#21-foreground-services-for-audio-study-mode)
- [ ] [2.2 The expo-audio defaults trap](ANDROID.md#22-the-expo-audio-defaults-trap)
- [ ] [2.3 Android 17 background audio](ANDROID.md#23-android-17-background-audio)
- [ ] [2.4 Speech in the background: spike first](ANDROID.md#24-speech-in-the-background-spike-first)
- [ ] [2.6 Play declarations for audio mode](ANDROID.md#26-play-declarations-for-audio-mode)

### Decisions to make
- [ ] On-device speech recognition, or clips sent to Tracy for speech-to-text

---

## Phase 3: Tracy coaching

**Scope (plan):** transition planner, answer grading, explanations, weekly review, proposal log.

**Gate:** the planner returns a valid circuit in under 3 seconds, with fallback when offline.

### Build
- [ ] Planner Edge Function: checks session, tier and monthly cap, calls Tracy while the focus block
      runs, records the job in `tracy_events`
- [ ] The app validates every proposal (only allowed exercises, load cap, ask before replacing a main
      lift) and falls back to the default circuit on timeout or offline
- [ ] Answer grader: on-device match first, Tracy for open answers, self-grading when offline
- [ ] One-line explanations with the source page
- [ ] Weekly review: SQL aggregates + queued Tracy summary; no patterns before 4 weeks; never a cause
- [ ] Proposal log: `tracy_events.accepted` set by the user's choice
- [ ] Monthly caps for the planner and the grader: reuse `enqueue_tracy_event`'s per-stage caps
      (Phase 2, [DECISIONS.md](DECISIONS.md) D36), and record `tracy_events.usage` for real costs
- [ ] Measure the 3-second gate on the phone

### Android
- [ ] [3.1 Report button on AI output](ANDROID.md#31-report-button-on-ai-output)
- [ ] [3.2 Health claims and the disclaimer](ANDROID.md#32-health-claims-and-the-disclaimer)
- [ ] [3.3 Health apps declaration](ANDROID.md#33-health-apps-declaration)
- [ ] [3.4 Health Connect (optional)](ANDROID.md#34-health-connect-optional)

### Tracy
- [ ] Tasks `dualrep_plan_transition`, `dualrep_grade_answer`, `dualrep_explain`,
      `dualrep_weekly_review` ([TRACY_INTEGRATION.md §4](TRACY_INTEGRATION.md#which-lane-and-model-per-dualrep-job))
- [ ] Eval Claude Haiku 5.5 against Haiku 4.5 for the planner and the grader
      ([§5](TRACY_INTEGRATION.md#5-models-what-breaks-and-what-it-costs))
- [ ] Check Tracy's hosting plan: a sleeping free instance would break the 3-second gate

### Decisions to make
- [ ] Fast model: Haiku 4.5 or Haiku 5.5
- [ ] Health Connect now or later
- [ ] Load-increase cap per session (plan starts at 5%; Phase 1 uses 5%, [DECISIONS.md](DECISIONS.md) D24)

---

## Phase 4: Friends

**Scope (plan):** groups, shared plans, live sessions, group digest.

**Gate:** two phones run a synced session and private data stays private.

### Build
- [ ] Create a group (subscribers only), show and share the invite code
- [ ] Join by code through `join_group`; show the roster
- [ ] Leave a group: a plain DELETE of your own membership (it syncs like any other write). The owner
      can't leave; they delete the group instead
- [ ] Remove a member (owner): call the `remove_group_member()` RPC **online**; it removes the member
      and rotates the invite code in one step and returns the new code, which the app shows so the
      owner can share it with the people who stay. Never queue a local DELETE of someone else's
      membership (the server ignores it and the row comes back). `regenerate_invite_code()` rotates
      the code without removing anyone ([DATA_MODEL.md](DATA_MODEL.md#groups))
- [ ] Share sources, study plans and exercises into a group. Leaving or being removed unshares that
      member's content, and a share into a group you aren't in comes back unshared: show such rows as
      private
- [ ] Live session: synced timer and presence with Supabase Realtime; everyone breaks to the move block
      together
- [ ] Group digest with totals each member chose to share (needs sharing settings: a new migration)
- [ ] Privacy test with two phones and two accounts: weights, quiz scores and effort ratings stay
      private
- [ ] Account deletion flow (needed for Phase 5)

### Android
- [ ] [4.1 User-generated content controls](ANDROID.md#41-user-generated-content-controls)
- [ ] [4.2 Push notifications for friend activity](ANDROID.md#42-push-notifications-for-friend-activity)
- [ ] [4.3 Data safety additions and the deletion flow](ANDROID.md#43-data-safety-additions-and-the-deletion-flow)
- [ ] [4.4 Invite links](ANDROID.md#44-invite-links-only-if-verified-app-links-are-chosen) (only if
      verified App Links are chosen)

### Tracy
- [ ] Group digest text (optional; reuse the weekly-review pattern)

### Decisions to make
- [ ] Invite by link: which deep-link format (custom scheme or verified App Links)
- [ ] What group members see by default (the plan: private until a member turns sharing on)

---

## Phase 5: Android launch

**Scope (plan):** one or more closed beta rounds with full access for testers, free and subscription
tiers, store listing, Play release.

**Gate:** beta users complete the loop without help, and beta usage sets the caps and the price.
Feedback decides whether another round runs before release.

### Build
- [ ] Beta entitlements for testers until the beta end date ([SETUP §14](SETUP.md#14-give-yourself-beta-access-for-testing) shows the SQL)
- [ ] In-app notice before the beta ends
- [ ] RevenueCat: subscription product, webhook Edge Function that writes `entitlements`
- [ ] Account deletion: in the app and on a web page
- [ ] Privacy policy and terms (users upload only material they have the right to use)
- [ ] Custom SMTP for sign-in emails (Supabase's built-in sender is for development)
- [ ] Production backend: a second Supabase project (for example `dualrep-prod`) with custom SMTP and
      the sign-in email templates, the migrations and Edge Functions deployed with the **Deploy backend**
      workflow pointed at it ([DECISIONS.md](DECISIONS.md) D39), and its own
      PowerSync instance with the sync config deployed (set up like
      [SETUP §5–8](SETUP.md#5-create-the-supabase-project-and-push-the-database); in
      `powersync/service.yaml` use `name: dualrep-prod` and `allow_temporary_tokens: false`). Then
      store its public values in the EAS `production` environment
      ([Android 5.2](ANDROID.md#52-signing-and-eas-submit), step 4)
- [ ] Reviewer login for Play's App access check: one password account and a small "Sign in with
      password" path ([Android 5.8](ANDROID.md#58-reviewer-login-app-access))
- [ ] Brand icon, splash and store listing assets ([Android 5.9](ANDROID.md#59-brand-art-and-store-listing-assets))
- [ ] Crash reports and analytics (Sentry, PostHog in the plan)
- [ ] Production build, EAS Submit to the internal track, then closed testing

### Android
- [ ] [5.1 Production access](ANDROID.md#51-production-access)
- [ ] [5.2 Signing and EAS Submit](ANDROID.md#52-signing-and-eas-submit)
- [ ] [5.3 Billing through RevenueCat](ANDROID.md#53-billing-through-revenuecat)
- [ ] [5.4 App content declarations](ANDROID.md#54-app-content-declarations)
- [ ] [5.5 Data safety draft](ANDROID.md#55-data-safety-draft)
- [ ] [5.6 Account deletion](ANDROID.md#56-account-deletion-required)
- [ ] [5.7 Release checks](ANDROID.md#57-release-checks-every-production-build)
- [ ] [5.8 Reviewer login (App access)](ANDROID.md#58-reviewer-login-app-access)
- [ ] [5.9 Brand art and store listing assets](ANDROID.md#59-brand-art-and-store-listing-assets)

### Tracy
- [ ] Rate limits for DualRep at the Edge Function (protects Tracy's other surfaces)

### Decisions to make
- [ ] Subscription price and free-tier caps, from beta usage (open question in the plan)
- [ ] Beta end date; whether another round runs
- [ ] R8 shrinking on or off for release ([DECISIONS.md](DECISIONS.md) D11)

---

## Phase 6: iOS

**Scope (plan):** iOS build, HealthKit, Live Activity, App Store release.

**Gate:** feature parity with Android.

### Build
- [ ] Apple developer account; iOS settings in `app.config.ts`; EAS iOS builds
- [ ] HealthKit behind the same interface as Health Connect
- [ ] Live Activity for the running timer
- [ ] Notifications and audio sessions on iOS
- [ ] RevenueCat on the App Store; App Store review

### Android
- [ ] [Phase 6 notes](ANDROID.md#phase-6-ios-android-side-notes): thin platform branches, same
      disclaimer, aligned app variants

### Decisions to make
- [ ] iOS bundle ids for the development, preview and production variants

---

## Phase 7: Glasses

**Scope (plan):** Expo module for the Meta SDK, voice logging, audio cards.

**Gate:** voice logging works end to end on the Mock Device Kit, then on hardware.

### Build
- [ ] Local Expo module wrapping Meta's Wearables Device Access Toolkit
- [ ] A separate glasses build variant
- [ ] Voice set logging ("Tracy, eight reps at 185"), then audio quiz cards between sets
- [ ] Later: photo capture of notes, timer and next set on Display glasses

### Android
- [ ] [7.1 The SDK and its Android needs](ANDROID.md#71-the-sdk-and-its-android-needs)
- [ ] [7.2 Keep it out of production builds](ANDROID.md#72-keep-it-out-of-production-builds)

### Decisions to make
- [ ] What Meta allows for public release (open item in the plan)
