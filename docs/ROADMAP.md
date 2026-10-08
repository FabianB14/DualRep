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

*Updated 2026-10-08.*

- **Phase 0 is built in this repo:** the Expo SDK 57 app, the full database (23 tables with row level
  security, tested), PowerSync sync streams, email-code sign-in, design tokens, and the Sync Check
  screen that proves the gate.
- **The gate is not passed yet.** It needs a real Android phone and the hosted services. Your remaining
  steps are the unticked boxes under "Your manual steps" in Phase 0, in the order of
  [SETUP.md](SETUP.md).
- **Next:** pass the gate, then start Phase 1 (the core loop).

| Phase | Est. weeks | Status |
|---|---|---|
| 0. Foundation | 1–2 | Built; gate pending on a phone |
| 1. Core loop | 4–5 | Not started |
| 2. Study engine | 4–6 | Not started |
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
      16 KB alignment check and permission list (`.github/workflows/android.yml`)
- [x] First migration: all 23 tables, RLS on every table, explicit grants, triggers, the six system
      presets, the `join_group` RPC and the `powersync` publication ([DATA_MODEL.md](DATA_MODEL.md))
- [x] pgTAP tests for every table and policy (`npm run db:test`)
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
- [ ] Create the accounts: GitHub, Expo, Supabase, PowerSync ([SETUP §1](SETUP.md#1-create-your-accounts))
- [ ] Set up the Windows PC and the phone ([SETUP §2](SETUP.md#2-set-up-your-windows-pc), [§3](SETUP.md#3-set-up-your-android-phone))
- [ ] Clone the repo and run `npm ci` and `npm run check` ([SETUP §4](SETUP.md#4-get-the-code))
- [ ] Create the Supabase project, link it and push the migration ([SETUP §5](SETUP.md#5-create-the-supabase-project-and-push-the-database))
- [ ] Set up the sign-in emails and check the JWT signing keys ([SETUP §6](SETUP.md#6-set-up-sign-in-emails-and-check-the-signing-keys))
- [ ] Create the PowerSync replication role ([SETUP §7](SETUP.md#7-create-the-powersync-database-role))
- [ ] Create the PowerSync instance and deploy the sync config ([SETUP §8](SETUP.md#8-create-the-powersync-instance))
- [ ] Fill in `.env`, then build and install the development build ([SETUP §9](SETUP.md#9-build-the-app-and-put-it-on-your-phone))
- [ ] Sign in on the phone and run the Sync Check ([SETUP §12](SETUP.md#12-run-the-sync-check-the-phase-0-gate))
- [ ] Confirm the row in the Supabase table editor ([SETUP §13](SETUP.md#13-confirm-the-row-in-postgres))
- [ ] Repeat the Sync Check once on a **preview** (release) APK against the hosted project
- [ ] Confirm the PowerSync free-tier limits on powersync.com/pricing (the plan asks for this before
      Phase 0 ends; see [SETUP §8](SETUP.md#8-create-the-powersync-instance))
- [ ] Confirm the native modules build in the development build (the plan's second check): a working
      install from EAS, a local build or the CI APK counts

### Android
- [ ] [0.1 Development build, not Expo Go](ANDROID.md#01-development-build-not-expo-go)
- [x] [0.2 Leave the SDK levels alone](ANDROID.md#02-leave-the-sdk-levels-alone)
- [ ] [0.3 Edge-to-edge and insets](ANDROID.md#03-edge-to-edge-and-insets-in-the-design-tokens): check
      on the phone with gesture and 3-button navigation
- [ ] [0.4 Keep the manifest lean](ANDROID.md#04-keep-the-manifest-lean): read the permission list in
      the first CI APK build
- [ ] [0.5 Play Console account: decide now](ANDROID.md#05-play-console-account-decide-now)
- [x] [0.7 16 KB page size check](ANDROID.md#07-16-kb-page-size-check) runs in CI
- [x] [0.8 Schema ready for account deletion](ANDROID.md#08-schema-ready-for-account-deletion)

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

### Build
- [ ] Focus timer screen: block length 10–50 minutes (`profiles.default_block_minutes`), writes
      `study_sessions` and `interval_blocks`, effort rating 1–5 at the end
- [ ] Exercise import script: free-exercise-db structured fields only, mapped with the rules in
      [research/exercise-data-and-fsrs.md §A6](research/exercise-data-and-fsrs.md), loaded with the
      service role as `origin = 'dataset'`, `reviewed = false`, pinned by the file's sha256 (start
      from the research scripts in [`scripts/exercise-import/`](../scripts/exercise-import/README.md))
- [ ] Curation pass: review the imported rows (start with `movement_pattern = 'other'` and `gym`) and
      set `reviewed = true`; add Interverse originals (desk-side and small-space moves)
- [ ] Equipment setups: check off gym and home equipment; more than one setup allowed
- [ ] Focus presets: pick one of the six system presets or make a custom split (per plan, day or block)
- [ ] Default micro circuits for every preset × location × 5/10/15 minutes, available offline
- [ ] Set logger: one tap per set; writes `workout_sessions` and `exercise_sets` (targets, actuals,
      rest)
- [ ] Spotter rules engine in TypeScript with unit tests (for example: miss the target by 2+ reps →
      next set drops 10–20%)
- [ ] Location swap: replace each exercise with one of the same movement pattern that fits the setup
- [ ] Zero-tap handoff: the timer ring morphs into the first exercise card (Reanimated); a
      `transitions` row links the block to the workout
- [ ] Airplane-mode test of the full cycle, once with a home setup and once with a gym setup

### Android
- [ ] [1.1 Focus timer: scheduled notification, not a foreground service](ANDROID.md#11-the-focus-timer-scheduled-notification-not-a-foreground-service)
- [ ] [1.2 Notification permission and channels](ANDROID.md#12-notification-permission-and-channels)
- [ ] [1.3 Exact alarms (optional)](ANDROID.md#13-exact-alarms-optional)
- [ ] [1.4 Screen on during sets](ANDROID.md#14-screen-on-during-sets)
- [ ] [1.5 Live countdown in the notification shade (optional)](ANDROID.md#15-live-countdown-in-the-notification-shade-optional)
- [ ] [1.6 Test through Play's internal testing track](ANDROID.md#16-test-through-plays-internal-testing-track)

### Tracy
- None. The transition planner comes in Phase 3; Phase 1 uses the default circuits.

### Decisions to make
- [ ] Final timer approach after measuring alert delay with the screen off ([DECISIONS.md](DECISIONS.md) D8)
- [ ] Ask for exact alarms or not
- [ ] Exercise dataset license: keep the structured-fields-only import, or clear the text and images
      ([DECISIONS.md](DECISIONS.md) D9)
- [ ] New packages for this phase (`expo-notifications`, `expo-keep-awake`, maybe `ts-fsrs` early):
      add with `npx expo install`

---

## Phase 2: Study engine

**Scope (plan):** DualRep surface on Tracy with the study builder; upload of PDFs, docs, links and
photos of handwritten notes; single-source and cumulative plans; FSRS scheduling; quiz-first blocks;
concept links; on-the-go audio mode.

**Gate:** a real course PDF and a page of handwritten notes become one cumulative plan, and a week of
reviews runs correctly.

### Build
- [ ] Supabase Storage bucket for sources, with paths prefixed by user id and Storage policies
- [ ] Upload flow (file, gallery or camera photo, link) → `sources` and `source_files`
- [ ] `tracy-worker` Edge Function and a `pg_cron` schedule that claims `tracy_events` jobs
- [ ] Per-page text extraction, chunking and embedding (Gemini, 1536 dimensions) into `source_chunks`
- [ ] Handwriting: transcription draft → user confirms (`source_files.confirmed`) → only then cards
- [ ] Outline review screen (cut and reorder topics) → `topics`, then `cards` with page references
- [ ] Single and cumulative plans; switch scope any time; "everything so far / newest source" filter
- [ ] FSRS with `ts-fsrs` (pin 5.4.2): `card_states` (id = UUIDv5 of `user_id:card_id`) and `reviews`
      written in one local transaction
- [ ] Quiz-first block: due cards → new material → closing self-test
- [ ] Concept links and the map view (`card_links`)
- [ ] On-the-go audio mode: spike first, then build
- [ ] Daily "reviews due" reminder

### Android
- [ ] [2.1 Foreground services for audio study mode](ANDROID.md#21-foreground-services-for-audio-study-mode)
- [ ] [2.2 The expo-audio defaults trap](ANDROID.md#22-the-expo-audio-defaults-trap)
- [ ] [2.3 Android 17 background audio](ANDROID.md#23-android-17-background-audio)
- [ ] [2.4 Speech in the background: spike first](ANDROID.md#24-speech-in-the-background-spike-first)
- [ ] [2.5 Review reminders and background sync](ANDROID.md#25-review-reminders-and-background-sync)
- [ ] [2.6 Play declarations for audio mode](ANDROID.md#26-play-declarations-for-audio-mode)

### Tracy
- [ ] `runTask` changes: per-task model tier and `max_tokens`, no `temperature`, `auto` + `strict`
      tool use, fallback and log options ([TRACY_INTEGRATION.md §10](TRACY_INTEGRATION.md#10-tracy-ai-changes-for-phase-2-proposed-not-made), change 1)
- [ ] DualRep tasks with validators: `dualrep_build_outline`, `dualrep_build_cards`,
      `dualrep_transcribe_notes` (change 2)
- [ ] Per-caller secret, metadata-only logs and no Groq fallback for DualRep (changes 3–4,
      [§7](TRACY_INTEGRATION.md#7-data-boundary-keep-dualrep-data-out-of-tracys-stores))
- [ ] `prompts/surfaces/dualrep.md` (change 5)
- [ ] Stateless per-page `POST /ai/extract` (change 6)
- [ ] Tests and `.env.example` updates (changes 7–8); SDK bump as its own PR (change 10)

### Decisions to make
- [ ] Models for the strong tasks (Sonnet 5.5 needs the `runTask` fix first)
- [ ] Gemini API key and project owned by DualRep
- [ ] Monthly upload caps for the free tier (to be set from beta usage)
- [ ] Keep syncing `reviews` down to the phone, or make it upload-only later to save space

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
- [ ] Monthly cap counting from `tracy_events.usage`
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
- [ ] Load-increase cap per session (plan starts at 5%)

---

## Phase 4: Friends

**Scope (plan):** groups, shared plans, live sessions, group digest.

**Gate:** two phones run a synced session and private data stays private.

### Build
- [ ] Create a group (subscribers only), show and share the invite code
- [ ] Join by code through `join_group`; roster, leave, remove a member
- [ ] Share sources, study plans and exercises into a group
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
