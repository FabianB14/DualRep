# DualRep

**Reps for your mind. Reps for your body.**

DualRep is an Interverse app that alternates evidence-based study blocks with
strength training blocks, guided by Tracy (Interverse's AI), and shareable with
friends. Android first, then iOS, then Meta glasses.

- Study: quiz-first blocks, FSRS spaced repetition, concept links, built from
  your own PDFs, docs, links, and photos of handwritten notes.
- Move: micro circuits or full sessions from focus presets and your gym or home
  equipment, with a rules-based spotter on the phone.
- Handoff: when the focus timer ends, the next exercise is already on screen.
  Zero taps.

## Status

**Phase 2 (Study engine) is built; its gate is next.** Your own course material becomes quiz cards
inside the focus block:

- study plans (one source, or a growing course), built from PDFs, Word files, web pages and photos
  of handwritten notes;
- a transcription check for the notes, an outline review, cards with the page they came from, and a
  concept map;
- quiz-first focus blocks (due reviews, then new cards, then a closing self-test) with FSRS
  scheduling on the phone, offline, and a daily review reminder;
- on the server: a private Storage bucket, two Supabase Edge Functions (`study` and
  `tracy-worker`), a job queue with monthly caps, and Tracy's new DualRep lane in `tracy-ai`;
- a **Deploy backend** GitHub workflow that applies database changes and deploys the functions.

The code is on the branch `claude/bold-fermi-oglgch` (in both repos) until the pull requests are
merged. Nothing in Phase 2 has run against the real services or a phone yet. The gate (a real course
PDF and a page of handwritten notes become one plan, then a week of reviews) is run by hand:
[docs/SETUP.md §17](docs/SETUP.md#17-phase-2-the-study-engine-on-your-phone). Audio study mode moved
to Phase 2B.

**Phase 1 (Core loop) is built and on `main`.** The study → move → study loop runs on the phone,
offline: a focus timer with an end-of-block alert, a workout that appears by itself when the timer
ends, a one-tap set logger with a rules-based spotter, 90 starter exercises written by Interverse,
setups, presets, the library, history, settings and a Timer check. Its gate (a cycle in airplane
mode with a home setup and a gym setup):
[docs/SETUP.md §16](docs/SETUP.md#16-phase-1-the-core-loop-on-your-phone).

**Phase 0 (Foundation) passed its gate on 2026-10-08** on a real Android phone: a row created
offline appeared in Postgres after reconnecting. The database has 23 tables with row level security
(626 pgTAP tests). Progress and next steps: [docs/ROADMAP.md](docs/ROADMAP.md).

## Stack

React Native + Expo (TypeScript, development builds) · PowerSync on-device
SQLite · Supabase (Postgres, Auth, Storage, Edge Functions, Realtime, pgvector)
· Tracy for AI (Claude, keys stay on the server) · RevenueCat · EAS Build.

Pinned: Expo SDK 57, React Native 0.86 (New Architecture), `@powersync/react-native`
2.3 with op-sqlite, `@supabase/supabase-js` 2.117. Node 22.13 or newer.

## Android first

DualRep is built and tested on Android from day one, on a real phone. It needs a
**development build** (PowerSync's database is native code), so **Expo Go does
not work**. Builds target Android 16 (API 36), which Google Play requires. The
platform rules, permissions and a checklist for every phase are in
[docs/ANDROID.md](docs/ANDROID.md).

## Quick start

Full step-by-step setup for Windows, including the hosted services:
[docs/SETUP.md](docs/SETUP.md).

Prerequisites: Node.js 22.13+, Git, and for local Android builds JDK 17 plus the
Android SDK (Platform 36, Build-Tools 36.0.0, NDK 27.1.12297006, CMake 3.30.5).

Phases 0 and 1 are on `main`. The Phase 2 code is on the branch `claude/bold-fermi-oglgch` until
its pull request is merged
([docs/SETUP.md §17 step 5](docs/SETUP.md#step-5-deploy-the-backend-a-dry-run-then-for-real)).
Until then, add `-b claude/bold-fermi-oglgch` to the `git clone` line below.

```powershell
git clone https://github.com/FabianB14/DualRep.git dualrep
cd dualrep
npm ci
Copy-Item .env.example .env   # then fill in the three EXPO_PUBLIC_ values
npm run check                 # typecheck, lint, all tests, sync-config and library checks
npm run android               # build + install the development build on a USB-connected phone
npm start                     # afterwards: start Metro for the installed development build
```

`.env` holds public client settings only (they are baked into the app). The server's secrets (the
Tracy secret, the Supabase access token) live only in GitHub, Render and Supabase, never in `.env`
or the app ([docs/SETUP.md §17](docs/SETUP.md#before-you-start-the-secrets-in-this-phase)):

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The `sb_publishable_…` key (or the legacy anon key). Never a secret or service_role key. |
| `EXPO_PUBLIC_POWERSYNC_URL` | The PowerSync instance URL, no trailing slash |

Without them the app opens on a "Setup needed" screen instead of crashing.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Starts Metro for an installed development build (`expo start --dev-client`) |
| `npm run android` | Builds the native app and installs it on a connected phone or emulator (`expo run:android`) |
| `npm run prebuild:android` | Regenerates the `android/` folder from `app.config.ts` (it is generated, never edited) |
| `npm run check` | `typecheck`, `lint`, `test`, `test:scripts`, `validate:sync` and `check:library` below, in one go |
| `npm run typecheck` | TypeScript, strict |
| `npm run lint` | ESLint (`expo lint`) |
| `npm test` | App tests (jest-expo), including a full study → move → study cycle played offline and a week of study blocks |
| `npm run test:scripts` | Tests for the Node scripts in `scripts/` (the exercise import), with Node's built-in test runner |
| `npm run validate:sync` | Compiles `powersync/sync-config.yaml` with PowerSync's compiler against the schema snapshot and checks it against the app's table registry |
| `npm run check:library` | Fails if the starter-library migration, or its 7 SQL Editor parts in `supabase/sql-editor/starter-library/`, is out of date with the app's list (`src/features/training/starterLibraryData.ts`) |
| `node scripts/library/starter-library-sql.mjs` | Rewrites the starter-library migration from that list (after changing it; see [DECISIONS.md](docs/DECISIONS.md) D21) |
| `npm run db:test` | Applies the migrations to a throwaway Postgres 16 (with stand-ins for Supabase's Storage, pg_cron, pg_net and Vault) and runs the pgTAP tests (15 files); rewrites `supabase/schema.snapshot.json` (Linux or WSL, with pgvector and pgTAP; CI runs it) |
| `deno check study/index.ts tracy-worker/index.ts`, `deno lint`, `deno test` | Run inside `supabase/functions/` with Deno 2: type-check, lint and test the Edge Functions (CI's **Edge Functions** job runs them; the app's TypeScript and jest leave that folder out) |

## Repo layout

| Path | What's there |
|---|---|
| `src/app/` | Screens and navigation (expo-router) |
| `src/auth/` | Sign-in with an emailed 6-digit code; session state |
| `src/db/` | The on-device database: table registry, PowerSync schema, Supabase connector, Sync Check helpers |
| `src/features/` | Feature code: the study → move → study cycle (`cycle/`), the study engine (`study/`: FSRS, the block's queue, typed-answer matching, uploads, the `study` function's client, the reminder, the study panel), the timer and its alerts (`timer/`), training (starter library, circuits, spotter, units, swaps), setups, presets, the user's own exercises, history, settings, sync status, the Sync Check, "Setup needed" |
| `src/components/`, `src/theme/` | Shared UI and design tokens |
| `src/lib/` | Configuration, the Supabase client, secure session storage, ids, timestamps |
| `supabase/` | Migrations (the schema, the starter library, the study engine), the Edge Functions `study` and `tracy-worker` (`functions/`, Deno), the starter library split into parts for the SQL Editor (`sql-editor/`), pgTAP tests, email templates, local CLI config, schema snapshot |
| `powersync/` | Sync Streams config and PowerSync instance config |
| `scripts/` | The database test harness, the sync-config validator, the 16 KB page-size check for APKs (`check-16kb.sh`), the starter-library generator (`library/`) and the exercise dataset import (`exercise-import/`) |
| `.github/workflows/` | CI (`ci.yml`), the installable APK build (`android.yml`), **Deploy backend** (`deploy-backend.yml`, run by hand: migrations, Edge Functions and their secrets) and the exercise import SQL (`exercise-import.yml`, run by hand) |
| `docs/` | Plan, roadmap, setup and guides |

## Docs

- [Execution plan](docs/EXECUTION_PLAN.md): the product, evidence, data model,
  pricing, and the 8-phase roadmap with gates.
- [Roadmap](docs/ROADMAP.md): every phase as a checklist, and where we are now.
- [Setup](docs/SETUP.md): from a fresh Windows PC and an Android phone to the
  Phase 0 gate, then the Phase 1 gate (§16) and the Phase 2 gate (§17).
- [Android guide](docs/ANDROID.md): platform rules and a checklist per phase.
- [Data model](docs/DATA_MODEL.md): every table, who writes it, how it syncs,
  and what changed from the plan.
- [Decisions](docs/DECISIONS.md): what was decided, why, and when to revisit.
- [Tracy integration](docs/TRACY_INTEGRATION.md): how DualRep calls Tracy, and the
  changes made to Tracy in Phase 2.
- [Research](docs/research/README.md): the Phase 0 research reports
  (2026-10-08), kept for reference.

---

An Interverse product. All rights reserved.
