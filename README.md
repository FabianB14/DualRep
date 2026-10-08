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

**Phase 0 (Foundation) is built; the gate is pending on a real phone.** The app,
the database (23 tables with row level security, 518 pgTAP tests), PowerSync sync,
email-code sign-in, design tokens and the Sync Check screen are in this repo. The
gate, "a row created offline on a phone appears in Postgres after reconnecting",
passes once the hosted services are set up and the Sync Check is run on a phone:
follow [docs/SETUP.md](docs/SETUP.md). Progress: [docs/ROADMAP.md](docs/ROADMAP.md).

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

The Phase 0 code is on the branch `claude/bold-fermi-oglgch` until its pull
request is merged into `main` ([docs/SETUP.md §4](docs/SETUP.md#first-put-the-phase-0-code-on-main)).
Until then, add `-b claude/bold-fermi-oglgch` to the `git clone` line below.

```powershell
git clone https://github.com/FabianB14/DualRep.git dualrep
cd dualrep
npm ci
Copy-Item .env.example .env   # then fill in the three EXPO_PUBLIC_ values
npm run check                 # typecheck, lint, unit tests, sync-config check
npm run android               # build + install the development build on a USB-connected phone
npm start                     # afterwards: start Metro for the installed development build
```

`.env` holds public client settings only (they are baked into the app):

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
| `npm run check` | Everything below except `db:test`, in one go |
| `npm run typecheck` | TypeScript, strict |
| `npm run lint` | ESLint (`expo lint`) |
| `npm test` | Unit tests (jest-expo) |
| `npm run validate:sync` | Compiles `powersync/sync-config.yaml` with PowerSync's compiler against the schema snapshot and checks it against the app's table registry |
| `npm run db:test` | Applies the migrations to a throwaway Postgres 16 and runs the pgTAP tests; rewrites `supabase/schema.snapshot.json` (Linux or WSL, with pgvector and pgTAP; CI runs it) |

## Repo layout

| Path | What's there |
|---|---|
| `src/app/` | Screens and navigation (expo-router) |
| `src/auth/` | Sign-in with an emailed 6-digit code; session state |
| `src/db/` | The on-device database: table registry, PowerSync schema, Supabase connector, Sync Check helpers |
| `src/features/` | Feature code: sync status, the Sync Check, "Setup needed" |
| `src/components/`, `src/theme/` | Shared UI and design tokens |
| `src/lib/` | Configuration, the Supabase client, secure session storage, ids |
| `supabase/` | Migrations, pgTAP tests, email templates, local CLI config, schema snapshot |
| `powersync/` | Sync Streams config and PowerSync instance config |
| `scripts/` | The database test harness, the sync-config validator, and the 16 KB page-size check for APKs (`check-16kb.sh`) |
| `.github/workflows/` | CI (`ci.yml`) and the installable APK build (`android.yml`) |
| `docs/` | Plan, roadmap, setup and guides |

## Docs

- [Execution plan](docs/EXECUTION_PLAN.md): the product, evidence, data model,
  pricing, and the 8-phase roadmap with gates.
- [Roadmap](docs/ROADMAP.md): every phase as a checklist, and where we are now.
- [Setup](docs/SETUP.md): from a fresh Windows PC and an Android phone to the
  Phase 0 gate.
- [Android guide](docs/ANDROID.md): platform rules and a checklist per phase.
- [Data model](docs/DATA_MODEL.md): every table, who writes it, how it syncs,
  and what changed from the plan.
- [Decisions](docs/DECISIONS.md): what was decided, why, and when to revisit.
- [Tracy integration](docs/TRACY_INTEGRATION.md): how DualRep calls Tracy.
- [Research](docs/research/README.md): the Phase 0 research reports
  (2026-10-08), kept for reference.

---

An Interverse product. All rights reserved.
