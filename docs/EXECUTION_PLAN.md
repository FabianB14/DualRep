# DualRep: Execution Plan

Oct 8, 2026 · Fabian Brooks

> This is the source plan, transcribed from [DualRep_Execution_Plan.pdf](DualRep_Execution_Plan.pdf).

## Summary

Interverse is building DualRep, one Android-first app that alternates
evidence-based study blocks with strength training blocks, guided by Tracy, and
shareable with friends.

Decisions made in this plan:

- **Name:** DualRep, an Interverse product. Study reps and lifting reps in one loop.
- **Companion:** Tracy, Interverse's AI, expanded with a DualRep surface on her existing backend.
- **Client:** React Native with Expo and TypeScript. One codebase for Android, then iOS.
- **Local-first data:** PowerSync on top of Supabase Postgres, replacing WatermelonDB.
- **AI:** Rules on the device for in-set adjustments. Claude through Tracy for plans, study material, grading, and weekly reviews. No on-device LLM in version 1.
- **Study method:** Quiz-first blocks, spaced repetition, and concept linking, built from uploaded PDFs, docs, links, and photos of handwritten notes.
- **Study scope:** A plan covers a single source or is cumulative across every source in a subject.
- **On the go:** An audio study mode for walking and other light movement.
- **Training:** An exercise library seeded from an open dataset and extended by hand, focus presets from all lower body to mostly cardio, and gym or home setups.
- **Pricing:** A free tier and one paid subscription. Beta testers get full access free until the beta ends.
- **Glasses:** A companion feature through Meta's Wearables Device Access Toolkit, after the phone app ships.
- **Claims:** We say strength training supports executive function and memory. We do not say it builds new neurons.

## Name

The name is **DualRep**. A rep is the unit of progress in both halves of the
app: one more lift, one more recall. Tagline option: "Reps for your mind. Reps
for your body."

A web search on 2026-10-08 found no app using DualRep. That search is not a
trademark clearance.

| Name | Status |
| --- | --- |
| DualRep | Chosen. No conflicting app found in search. |
| Superset | Ruled out. At least four fitness apps already use it. |
| Repwise | Ruled out. A sales app owns the name and a lifting app uses RepWiser. |
| Recall & Rep | Alternate. Not yet searched. |
| Engram | Alternate. Not yet searched. |

Before any branding work (all done):

- [x] Search Google Play and the App Store for DualRep
- [x] Search the USPTO trademark database, classes 9 and 41
- [x] Check dualrep.com and dualrep.app
- [x] Check the handle on Instagram, TikTok, and X

The companion keeps the name Tracy.

## Evidence base

The research supports the study-then-move loop, and it corrects three
assumptions in the original brief: the neuron claim, the handwriting claim, and
the deadlift swap.

| Topic | What the research says | What we build |
| --- | --- | --- |
| Strength training and the brain | A meta-analysis of randomized trials in healthy people found every exercise type improved overall cognition, with resistance training showing the largest effect. The benefit was strongest in adults 60 and older and much smaller in younger adults. | Resistance training stays the core movement mode. |
| "Builds new neuron pathways" | BDNF is the usual mechanism cited. In young adults, a meta-analysis found a single aerobic bout raised BDNF, while resistance training results were inconsistent. | Public claim: "supports executive function and memory." We do not claim new neurons. The mostly cardio preset and short aerobic finishers cover the aerobic side. |
| Moving between study blocks | In adults with ADHD, a 2025 meta-analysis found acute and chronic exercise improved inhibitory control. A separate systematic review rated the acute effect small and the certainty low. | Movement after a focus block is the default. The app measures each user's next-block focus so the claim is tested on their own data. |
| Studying while walking | In two experiments, people who learned vocabulary by audio while walking slowly recalled more later than when they learned it sitting still. The task was vocabulary only. | On-the-go mode: audio recall and audio summaries during walks. The weekly review compares each user's recall on the move with their seated recall. |
| Best study methods | The Dunlosky review of 10 techniques rated practice testing and distributed practice highest. Interleaving rated moderate. Rereading and highlighting rated low. | Quiz-first study blocks, spaced repetition scheduling, and mixed-topic review. No passive reread mode. |
| Handwriting | The 2014 "pen beats keyboard" result did not hold in direct replications. A 2024 meta-analysis of 24 studies found a small handwriting edge that shows up mainly when notes are reviewed later. | Handwriting is an option, not the foundation. Photos of handwritten notes upload as study sources. "Write it from memory" step: write on paper, snap a photo, Tracy checks it against the source. Typed and spoken recall count the same. |
| Relationship learning | This maps to elaborative interrogation and self-explanation, both covered in the Dunlosky review as moderate-utility techniques. | Tracy asks "why is this true?" and "how does this connect to what you studied last week?" Cards link into a concept map. User-made analogies are saved on the card. |
| Hard study, then heavy lifting | A systematic review found mental fatigue hurts endurance performance through higher perceived effort. Maximal strength, power, and anaerobic work were not affected. | Tracy does not auto-swap heavy lifts after hard study. It trims conditioning and total volume, asks for an effort rating, and learns the user's own pattern. |

ADHD-specific design choices have less direct evidence, so they ship as
defaults we measure: adjustable block lengths (10 to 50 minutes), one action per
screen, the next step always visible, instant feedback on every answer, and
shared sessions with friends for accountability.

The app gives training and study guidance. It does not diagnose or treat ADHD
or any condition, and store listings should say so.

## Product loop

The loop is study, move, repeat, and the handoff between the two takes zero taps.

1. **Plan.** The user uploads PDFs, docs, links, or photos of handwritten notes, picks a single-source or cumulative plan, and sets a goal and a date. Tracy turns the material into topics, quiz cards, and a schedule.
2. **Focus block.** A timer runs for 10 to 50 minutes. The block opens with recall questions on due cards, then new material, then a closing self-test. On-the-go mode runs the same block by audio.
3. **Handoff.** Tracy prepares the movement block while the timer is still running. When the timer ends, the timer ring morphs into the first exercise card.
4. **Move block.** A micro circuit of 5 to 15 minutes, or the day's full session, built from the focus preset and the gym or home setup in use. Sets are logged with one tap or by voice.
5. **Return.** The last rest timer rolls into the next focus block, which opens with a quiz on the previous block.
6. **Review.** Once a week Tracy shows what was studied, what was lifted, and what patterns show up between them.

### Study scope: single source or cumulative

Every plan is either single source or cumulative, and the user can switch a plan
from one to the other at any time.

| Scope | What it covers | How review works |
| --- | --- | --- |
| Single source | One PDF, doc, link, or set of handwritten notes | Questions come only from that source |
| Cumulative | Every source added to a subject, such as a whole course | Each block mixes due cards from every source, so earlier material keeps returning |

- A new upload to a cumulative plan folds into the existing outline. Tracy places its topics next to related ones and links new cards to earlier cards.
- Any single block can be narrowed with a filter: everything so far, or only the newest source.
- Review history belongs to the card, so switching scope never resets progress.

### Turning uploads into a study plan

1. The file or photo goes to Supabase Storage. Photos can be taken in the app or picked from the gallery. Links are fetched on the server.
2. Tracy extracts the text and splits it into chunks with page references.
3. Photos of handwritten notes are read by a vision model. The user checks the transcription and fixes mistakes before any cards are made.
4. Chunks are embedded and stored in Postgres with pgvector.
5. Claude drafts the topic outline, then cards for each topic. Every card stores the page it came from.
6. The user reviews the outline and can cut or reorder topics before the plan is saved.
7. The spaced repetition scheduler runs on the device and decides which cards are due in each block.

### Study features that replace rereading

- **Recall first:** every block starts with questions, not content.
- **Spacing:** the FSRS algorithm schedules each card by the user's own answer history.
- **Interleaving:** review mixes topics from different sources.
- **Why prompts:** Tracy asks the user to explain a fact and link it to an earlier card.
- **Concept map:** linked cards form a map the user can browse.
- **Write from memory:** the user writes on paper, takes a photo, and Tracy marks what was missed.
- **Audio cards:** questions read aloud during rest periods, answered by voice.

### On-the-go study

On-the-go mode turns any focus block into an audio session for walking,
commuting, or chores, with the screen off.

- **Turning it on:** a toggle on the focus block, or an action on the timer notification.
- **Review:** Tracy reads each question aloud. The user answers by voice, or marks the card with a headset button or one large on-screen button.
- **New material:** short audio summaries of a topic, each followed by recall questions.
- **Grading:** short factual answers are matched on the device. Open answers are graded by Tracy when online. Offline, the user self-grades.
- **Offline:** audio summaries are generated ahead of time and cached. Speech uses the phone's own voices.
- **Walks count:** the user can tag the session as a walk, and its minutes log as light cardio.
- **Safety:** the mode never requires reading or typing. Anything visual, such as a diagram or the concept map, waits for a seated block.

## Training library and presets

The exercise library uses both sources: an open dataset as the seed and
hand-written entries on top. Every workout is then built from a focus preset and
a location.

### Exercise library

| Layer | What it holds | Who writes it |
| --- | --- | --- |
| Seed | 800+ exercises from free-exercise-db, a public domain dataset with muscles, equipment, level, instructions, and images | Imported once by script |
| Curation | Our own fields on each seeded exercise: body region, movement pattern, demand level, location, and whether it fits a micro block | Interverse |
| Originals | Exercises the dataset lacks, such as desk-side and small-space movements for study breaks | Interverse |
| Custom | Exercises a user adds for themselves or their group | Users |

Tracy only picks exercises marked as reviewed, plus the user's own custom
entries. Confirm that the dataset's license file covers both the data and the
images before import.

### Focus presets

| Preset | Starting split of working sets |
| --- | --- |
| All lower body | 100% lower |
| Mostly lower body | 70% lower, 30% upper and core |
| Full body | Even across push, pull, legs, and core |
| Mostly upper body | 70% upper, 30% lower and core |
| All upper body | 100% upper |
| Mostly cardio | 70% conditioning, 30% strength |
| Custom | The user sets the split |

- A preset can be set for the whole plan, for a day, or for a single block.
- Presets apply to micro circuits and to full sessions.
- The splits are starting values and can be tuned in settings.
- The weekly review shows sets per muscle group, so the user can see what a preset is producing.

### Gym or home

| Location | Equipment | Example for a squat pattern |
| --- | --- | --- |
| Gym | Barbells, racks, machines, cables, cardio machines | Barbell back squat |
| Home | Whatever the user checks off: bodyweight, dumbbells, kettlebell, bands, pull-up bar, bench | Goblet squat or split squat |

- The user sets up each location once by checking off equipment, and can save more than one setup.
- Location is chosen per block. A study day at home uses home micro circuits, and a gym day uses the full session.
- Switching location swaps each exercise for one with the same movement pattern that fits the equipment. Progress is tracked per exercise.
- Cardio at home covers options that need no machine, such as jump rope, stairs, or a walk.

## Tracy

Tracy is Interverse's AI, expanded here with five DualRep jobs, and each job
runs where it is fastest and cheapest. Tracy is not an open chat window. It
reads app state, proposes a structured change, and the app validates that
change before anything is saved.

| Job | When it runs | Where it runs | Inputs | Output |
| --- | --- | --- | --- | --- |
| Spotter | During a set | On the device, rules only | Target reps and weight, actual reps, effort rating, rest time | Drop set, rest-pause, cut a set, or hold or raise the weight next session |
| Transition planner | While a focus block runs | Tracy, fast model | Block length, interruptions, effort rating, quiz accuracy, time available, today's lifts, focus preset, location, equipment | A circuit built only from exercise IDs in the library |
| Study builder | On upload and on plan changes | Tracy, strong model, queued job | Source chunks or note photos, plan scope, goal, deadline | Transcriptions to confirm, topic outline, cards with page references, schedule |
| Answer grader | During quizzes and on-the-go study | On-device match first, Tracy's fast model for open answers | The card, the expected answer, and the typed, spoken, or handwritten answer | Right, partly right, or missed, with what was left out |
| Analyst | Weekly, scheduled | SQL computes the numbers, Tracy's strong model writes the summary | Focus minutes, interruption rate, quiz accuracy, weekly volume (sets x reps x weight) | A short review with patterns and one suggested change |

### Why the spotter is rules, not a model

In-set calls must work with no signal and return in under 50 ms. The logic is
well defined: miss the target by two or more reps and the next set drops 10 to
20 percent, and so on. A rules engine in TypeScript does this exactly and can be
unit tested. When the phone is online, Tracy can add a one-line explanation. An
on-device LLM is worth revisiting for voice on the glasses, not for version 1.

### How Tracy is expanded

Tracy already runs as a backend with a Claude tool-use loop, model routing,
confidence gating, and a prompt file per surface. DualRep is added as one more
surface, not a second assistant.

- **Prompt:** a DualRep surface file in `prompts/surfaces/` extends the universal `tracy_system.md`.
- **Tools:** new tools for building a circuit, building a study plan, reading handwritten notes, grading an answer, and writing the weekly review. Each returns JSON that matches a fixed schema.
- **Request path:** the app calls a Supabase Edge Function. It checks the user's session, tier, and monthly cap, then forwards the request to Tracy. Tracy's address and API key never reach the phone.
- **Long jobs:** the study builder and the weekly review run as queued jobs on Tracy's server and write their results to DualRep's database. The app shows progress through sync.
- **Data boundary:** study sources and training data stay in DualRep's database. They are not added to the Brain.
- **Models:** Claude Haiku 4.5 for the transition planner, grading, and explanations. Claude Sonnet 5.5 for the study builder, handwriting, and the weekly review. Embeddings reuse the model already wired into Tracy's pgvector setup if there is one, otherwise Gemini or Voyage.

Confirm the surface folder, the tool registration pattern, and how existing
surfaces authenticate in the Tracy repo before wiring.

### Guardrails

- Tracy can only pick exercises that are reviewed in the library or added by that user.
- Load increases are capped per session, starting at 5 percent.
- The planner changes volume and exercise order. It asks before it replaces a main lift.
- A report of pain stops the block and Tracy suggests seeing a professional.
- Study answers must cite a page from the user's own sources. Low confidence means Tracy says it does not know.
- Handwritten notes become cards only after the user confirms the transcription.
- On-the-go mode is audio only and never asks the user to read or type.
- The weekly review reports patterns after at least 4 weeks of data and never states a cause.
- Every proposal is logged with whether the user accepted it, so the rules can be tuned from real use.

### Offline behavior

Every focus preset and location has pre-built default circuits for 5, 10, and 15
minutes. If the planner cannot be reached when a focus block ends, the default
loads and the handoff still takes zero taps.

## Tech stack

The recommended build keeps React Native, Expo, and Supabase from the original
brief and changes two things: PowerSync replaces WatermelonDB, and the on-device
LLM is dropped from version 1.

```
Phone app: React Native and Expo
  ├─ Screens and motion   (timer, set logger, quiz cards)
  ├─ On-device logic      (spotter rules, FSRS scheduler)
  └─ SQLite               (every read and write is local)
        │                                  │
   API calls when online            PowerSync (two-way sync when online)
        │                                  │
Supabase
  ├─ Auth, Storage, Realtime   (sign-in, uploads, live groups)
  ├─ Edge Functions            (session, tier, and cap checks)
  └─ Postgres and pgvector     (source of truth, row security)
        │
Tracy, Interverse AI (DualRep surface and tools) ──> Claude and Gemini (API keys stay on the server)

Meta glasses (voice, audio, camera via SDK) ──> phone app
```

The app reads and writes only to SQLite on the phone, so the study and lifting
loop works with no signal. PowerSync and the Edge Functions are used when the
phone is online.

| Layer | Choice | Why | Considered instead |
| --- | --- | --- | --- |
| Mobile client | React Native, Expo, TypeScript, development builds | One codebase for Android then iOS. Matches the React and TypeScript already used on other projects. Native SDKs can be wrapped as Expo modules. | Kotlin Multiplatform (best glasses access, more iOS work), Flutter |
| Motion and UI | Reanimated, Gesture Handler, Skia, Expo Router, haptics | Animations run off the JavaScript thread, which is what makes the timer-to-workout morph smooth. | Stock Animated API |
| Local database | PowerSync with on-device SQLite | Syncs Supabase Postgres to SQLite in both directions with an official Expo and Supabase path. | WatermelonDB (requires writing our own sync endpoints), Legend-State (weaker for relational queries) |
| Backend | Supabase: Postgres, Auth, Storage, Edge Functions, Realtime, pgvector | One service covers auth, files, vector search, group presence, and row-level security. | Tracy's own Postgres or a custom FastAPI service, neither with built-in auth, storage, and realtime |
| Spaced repetition | FSRS, open source TypeScript library, on device | Works offline and adapts to each user. | SM-2 |
| AI | Tracy's existing backend with a new DualRep surface, reached through Edge Functions | Reuses Tracy's tool loop, prompts, routing, and API key. Keys never ship in the app. | A separate AI service for DualRep, direct calls from the client |
| Handwriting and photos | Claude vision through Tracy, with the user confirming the result | Handles messy handwriting and mixed text and diagrams. | On-device text recognition, which targets printed text |
| Voice and audio | On-device text-to-speech and speech recognition, background audio with headset and notification controls | On-the-go study works with the screen off and without a signal. | Cloud speech services |
| Exercise data | free-exercise-db as the seed, our own fields and entries in Postgres | Hundreds of exercises on day one, with our curation on top. | Paid exercise APIs, writing every entry by hand |
| Timers and alerts | Android foreground service plus local notifications | The timer survives the screen turning off. | JavaScript timers only |
| Health data | Health Connect on Android, HealthKit on iOS | Optional import of heart rate and sleep in a later phase. | None in version 1 |
| Billing | RevenueCat over Google Play and App Store billing | One entitlement model for free, subscription, and beta access. | Building store billing by hand |
| Ops | EAS Build, Sentry, PostHog | Builds, crash reports, product analytics. | |

Two things to confirm before Phase 0 ends: PowerSync's current free tier limits,
and that the PowerSync native module builds cleanly in the Expo development
build. Expo Go will not work with this stack.

## Data model

The five original tables stay, with added columns, and seventeen tables are
added for study material, training setup, the handoff, groups, billing, and
Tracy's log. Every primary key is a UUID created on the device so rows can be
made offline.

| Table | Key columns | Notes |
| --- | --- | --- |
| profiles | id, display_name, unit_pref, default_block_minutes, default_preset_id, default_setup_id | One row per auth user |
| entitlements | user_id, tier, source, expires_at | Tier is free or subscription. Source is store or beta. A beta row expires on the beta end date, which is set at beta launch and moved if another round runs. |
| study_sessions | id, user_id, plan_id, focus_subject, created_at | Original table plus plan_id |
| interval_blocks | id, study_session_id, planned_minutes, started_at, ended_at, interrupted, effort_rating, mode | Mode is seated or on_the_go. Effort rating (1 to 5) feeds the planner. |
| exercises | id, name, muscle_group, body_region, category, equipment, location, movement_pattern, demand_level, micro_ok, origin, reviewed, owner_id, group_id | Origin is dataset, interverse, or user. Location is gym, home, or both. |
| presets | id, name, split, owner_id | Split is the share of sets for lower, upper, core, and cardio. System presets have no owner. |
| equipment_setups | id, user_id, name, location, equipment | A user's gym and home setups |
| workout_sessions | id, user_id, logged_at, kind, preset_id, setup_id | Kind is micro, full, or walk |
| exercise_sets | id, workout_session_id, exercise_id, set_index, reps, weight_lbs, rpe, set_type | Set type is normal, drop, or rest_pause |
| transitions | id, interval_block_id, workout_session_id, proposal, accepted | Links a focus block to the move block that followed |
| sources | id, owner_id, group_id, kind, title, url | Kind is pdf, doc, link, or notes |
| source_files | id, source_id, storage_path, page, transcript, confirmed | One row per file or photo. Note photos hold the transcription and whether the user confirmed it. |
| source_chunks | id, source_id, page, content, embedding | Embedding is a pgvector column. Stays on the server. |
| study_plans | id, owner_id, group_id, scope, goal, target_date | Scope is single or cumulative. A plan belongs to a user or a group. |
| plan_sources | plan_id, source_id, added_at | One row for a single-source plan, many for a cumulative plan |
| topics | id, plan_id, title, position | Outline for a plan |
| cards | id, topic_id, source_chunk_id, question, answer, card_type | Every card points to its source page |
| card_links | id, from_card_id, to_card_id, relation, note | The concept map and user analogies |
| reviews | id, card_id, user_id, rating, answer_mode, reviewed_at, due_at, stability, difficulty | FSRS state. Always per user. Answer mode is typed, spoken, handwritten, or self_graded. |
| groups, group_members | id, name, invite_code; group_id, user_id, role | Role is owner or member |
| tracy_events | id, user_id, job, status, input, output, accepted, created_at | Job queue and audit log for tuning rules and prompts |

Postgres names are lowercase and plural. Row-level security is on for every
table from the first migration.

## Shared plans

Friends join one plan through an invite link, and the same Tracy serves the
whole group with each person's private data kept private.

- **Group:** 2 to 8 people, one owner, invite by link or code. The owner subscribes and members can join free.
- **Shared study plan:** the group shares sources, topics, and cards. Each person's review history and schedule stay their own.
- **Shared training plan:** the group shares the exercise template. Each person keeps their own weights, progression, preset, and location, so one friend can train at a gym and another at home.
- **Study together:** a live session with a synced timer and presence through Supabase Realtime. Everyone breaks into their move block at the same time.
- **Group Tracy:** a weekly group digest with totals each member has chosen to share, such as blocks completed and streaks.
- **Privacy defaults:** weights, quiz scores, and effort ratings are private until a member turns sharing on.

How it works underneath: row-level security policies check group membership,
and PowerSync sync rules give each device one bucket per group the user belongs
to. Uploaded sources shared in a group are visible only to that group's members.

## Pricing and beta

DualRep has a free tier and one paid subscription, and beta testers get
everything in the subscription at no cost until the beta ends.

The split follows one rule: features that run on the phone are free, and
features that cost Interverse money on every use are capped or paid.

| Feature | Free | Subscription |
| --- | --- | --- |
| Focus timer, set logging, spotter rules | Yes | Yes |
| Exercise library, focus presets, gym and home setups | Yes | Yes |
| Spaced repetition, quizzes, concept map | Yes | Yes |
| Single-source and cumulative plans | Yes | Yes |
| Sources turned into study plans, including photos of handwritten notes | Monthly cap | Higher cap |
| Move blocks | Default circuits by preset and location | Planned by Tracy from the study block and training history |
| Weekly review | Charts | Charts plus Tracy's written review |
| On-the-go study | Audio cards with self-grading | Adds spoken answers graded by Tracy and audio summaries |
| Groups | Join | Create and host |
| Glasses features | No | Yes |

### Beta access

- Every beta tester gets the full subscription feature set free until the beta ends.
- The beta end date is set when the beta is ready to launch.
- Feedback may lead to more than one beta round. Each round gets its own end date, and testers keep full access through it.
- A tester's account carries a beta entitlement that expires on the end date. No payment method is asked for during a beta.
- When the last round ends, testers move to the free tier unless they subscribe. Their plans, cards, and training history stay.
- Testers get notice in the app before the end date.
- Beta usage sets the two numbers still open: the free tier caps and the subscription price.

### How it works

Subscriptions run through Google Play and the App Store with RevenueCat.
Entitlements sync to the device, so paid features that run on the phone unlock
offline. The Edge Function checks the tier and the monthly cap before any
request reaches Tracy.

## Platforms

Android ships first, iOS reuses the same codebase, and the glasses are a
companion to the phone app.

### Android

Build and test on Android from day one. The focus timer runs in a foreground
service so it keeps time with the screen off. On-the-go study uses the same
service for background audio, headset buttons, and notification controls. Check
Play Console's current closed-testing requirement for new developer accounts
early, since it can add weeks before a public launch.

### iOS

The same code builds for iOS through EAS. iOS-only work: HealthKit, a Live
Activity for the running timer, App Store review, and an Apple developer
account.

### Meta glasses

Meta's Wearables Device Access Toolkit is in developer preview and supports
Android 10 and later and iOS 15.2 and later. It currently supports Ray-Ban Meta
Gen 1 and Gen 2, Ray-Ban Meta Optics, and Meta Ray-Ban Display glasses. The SDK
is native (Kotlin on Android), so we wrap it in an Expo module. A Mock Device
Kit lets us build without owning the hardware.

Planned glasses features, in order:

1. Hands-free set logging by voice: "Tracy, eight reps at 185."
2. Spoken rest timer, audio quiz cards between sets, and on-the-go study by voice.
3. Photo capture of handwritten notes, as study sources and for the write-from-memory check.
4. Timer and next set on the lens for Display glasses.

Open item: confirm what Meta allows for public release while the toolkit is in preview.

## Roadmap

Eight phases, each with a gate that must pass before the next one starts. Week
counts are estimates for one developer.

| Phase | Est. weeks | Ships | Gate |
| --- | --- | --- | --- |
| 0. Foundation | 1 to 2 | Expo development build, Supabase project, PowerSync, auth, first migration, design tokens | A row created offline on a phone appears in Postgres after reconnecting |
| 1. Core loop | 4 to 5 | Focus timer, set logger, seeded and curated exercise library, focus presets, gym and home setups, rules-based spotter, default micro circuits, zero-tap handoff | A full study, lift, study cycle works in airplane mode, with a home setup and a gym setup |
| 2. Study engine | 4 to 6 | DualRep surface on Tracy with the study builder, upload of PDFs, docs, links, and photos of handwritten notes, single-source and cumulative plans, FSRS scheduling, quiz-first blocks, concept links, on-the-go audio mode | A real course PDF and a page of handwritten notes become one cumulative plan, and a week of reviews runs correctly |
| 3. Tracy coaching | 2 to 3 | Transition planner, answer grading, explanations, weekly review, proposal log | Planner returns a valid circuit in under 3 seconds, with fallback when offline |
| 4. Friends | 2 to 3 | Groups, shared plans, live sessions, group digest | Two phones run a synced session and private data stays private |
| 5. Android launch | 2 to 4 per round | One or more closed beta rounds with full access for testers, free and subscription tiers, store listing, Play release | Beta users complete the loop without help, and beta usage sets the caps and the price. Feedback decides whether another round runs before release |
| 6. iOS | 2 to 3 | iOS build, HealthKit, Live Activity, App Store release | Feature parity with Android |
| 7. Glasses | 3 to 4 | Expo module for the Meta SDK, voice logging, audio cards | Voice logging works end to end on the Mock Device Kit, then on hardware |

The first thing to build after this doc is Phase 0: the repo, the schema
migration, and the sync check.

## Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Scope: study app, lifting app, AI, social, and glasses in one product | Phase gates. Nothing in Phase 2 or later starts until the offline core loop works. |
| AI cost per user, including the free tier | Rules on device for the most frequent calls, the fast model for planning, cached card generation, and monthly caps by tier set from beta usage |
| Health and learning claims | Use the wording in the evidence section. No treatment claims. Disclaimer in onboarding and store listings. |
| Copyrighted uploads | Sources are private to the user or their group and never enter the Brain. Terms state users upload only material they have the right to use. |
| Handwriting is misread | The user confirms every transcription before cards are made. |
| Studying on the move pulls attention from surroundings | On-the-go mode is audio only and never needs the screen. |
| Exercise dataset license | Confirm the license file covers data and images before import. Keep the seed replaceable. |
| DualRep load slows Tracy's other surfaces | Queue long jobs and rate limit DualRep requests at the Edge Function. |
| Glasses SDK is in preview | Glasses come last and are built against the mock device first. |
| Sync vendor dependency | Data lives in our own Postgres. PowerSync can be self-hosted or swapped. |
| Name conflict | Run the four checks in the Name section before any branding work. |

Open questions:

- [x] Confirm the proposed free and subscription split
- [ ] Subscription price and free tier caps, set from beta usage
- [x] Beta end: a date, set when the beta is ready to launch. More rounds may follow depending on feedback.
- [ ] Who are the first 20 testers?
- [ ] Does DualRep live in its own repo or inside the Tracy monorepo?
- [ ] How do existing Tracy surfaces authenticate, and which endpoint does a new surface call?

## Sources

Findings are taken from the abstracts and summaries linked in the original PDF
(the links are in [the PDF](DualRep_Execution_Plan.pdf)). Read the full papers before quoting numbers in
marketing.

- Exercise and cognition in healthy people, meta-analysis summary
- Exercise and BDNF in young adults, meta-analysis
- Physical activity and inhibitory control in adult ADHD, meta-analysis
- Exercise in adults with ADHD, systematic review
- Treadmill walking during vocabulary learning, Schmidt-Kassow et al. 2014
- Dunlosky et al. 2013 on study techniques, APS summary
- Replication of the handwriting study, APS summary
- Morehead, Dunlosky, and Rawson 2019 replication
- Review citing the 2024 handwriting meta-analysis
- Mental fatigue and physical performance, systematic review
- Meta Wearables Device Access Toolkit setup
- Meta Wearables toolkit for Android, GitHub
- [PowerSync documentation](https://docs.powersync.com/)
- Expo on PowerSync and Supabase
- [free-exercise-db, open exercise dataset](https://github.com/yuhonas/free-exercise-db)
