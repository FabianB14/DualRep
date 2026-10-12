# Research reports

The research done on 2026-10-08, before Phase 0 was built, on 2026-10-09, before Phase 2, and on
2026-10-12, before voice notes. These are background reference: the
guides in `docs/` and the code in the repo are what to follow. Where a report and the repo disagree,
the repo wins.

| Report | What it covers | Used in |
|---|---|---|
| [versions.md](versions.md) | Pinned package versions for Expo SDK 57, React Native 0.86, PowerSync 2.x and Supabase, and what was checked by running them | [DECISIONS.md](../DECISIONS.md), [SETUP.md](../SETUP.md) |
| [powersync.md](powersync.md) | Sync Streams vs Sync Rules, the Supabase side (replication, publication, grants), auth, the client connector, data types, pricing, and how to verify the gate | [DATA_MODEL.md](../DATA_MODEL.md), [SETUP.md](../SETUP.md) |
| [android.md](android.md) | Android and Google Play rules as of October 2026, with a checklist per roadmap phase and sources | [ANDROID.md](../ANDROID.md) |
| [exercise-data-and-fsrs.md](exercise-data-and-fsrs.md) | The free-exercise-db dataset (license, shape, mapping rules to DualRep's columns) and FSRS scheduling with ts-fsrs | [DATA_MODEL.md](../DATA_MODEL.md), [DECISIONS.md](../DECISIONS.md) D9 |

## Phase 2 (2026-10-09)

Research done before the study engine was built. File paths inside them that point into a
"scratchpad" were the researchers' working copies; the prototypes they describe are now in the repos.

| Report | What it covers | Used in |
|---|---|---|
| [phase2/tracy.md](phase2/tracy.md) | The tracy-ai changes: structured outputs on Sonnet 5.5, per-caller secrets, the four `dualrep_*` tasks and their validators, `/ai/extract` | [TRACY_INTEGRATION.md](../TRACY_INTEGRATION.md) §10 |
| [phase2/supabase.md](phase2/supabase.md) | Edge Function limits, deploying from GitHub Actions, pg_cron + pg_net + Vault, the `sources` bucket and its policies, the job claim and monthly cap | [DATA_MODEL.md](../DATA_MODEL.md), [SETUP.md](../SETUP.md) |
| [phase2/study.md](phase2/study.md) | FSRS with ts-fsrs 5.4.2 on Hermes, the quiz-first block inside the focus phase, the queue, answer modes, reminders, screens | [DECISIONS.md](../DECISIONS.md) |
| [phase2/expo.md](phase2/expo.md) | Picking and uploading files and photos on Android, the packages' permissions, resizing photos | [ANDROID.md](../ANDROID.md) |
| [phase2/apis.md](phase2/apis.md) | Claude and Gemini request shapes and costs, Render's free tier, Supabase Free plan quotas, pgvector capacity | [SETUP.md](../SETUP.md) |

The Tracy review is not copied here: [TRACY_INTEGRATION.md](../TRACY_INTEGRATION.md) replaces it.

## Voice notes (2026-10-12)

Research done before voice notes (Phase 2.1) were built. Paths into a "scratchpad" were the
researchers' working copies; the prototypes they describe were ported into the repo and reviewed.
Where the repo differs (for example the screen is its own route, not a fourth segment on Add
material, and punctuation is asked for only with on-device recognition), the repo and
[DECISIONS.md](../DECISIONS.md) D50–D57 win.

| Report | What it covers | Used in |
|---|---|---|
| [voice/speech.md](voice/speech.md) | Speech-to-text on Android with `expo-speech-recognition` 57.1.1: why that version, the JS API, Android 13+ versus older, on-device versus Google's online service, error codes, the manifest and `RECORD_AUDIO`, Play Data safety, the keyboard-microphone fallback, the screen, the jest mock, and the phone checks (S1–S10) | [DECISIONS.md](../DECISIONS.md) D50, D51, D56, D57; [ANDROID.md](../ANDROID.md) 2.8 |
| [voice/pipeline.md](voice/pipeline.md) | The server and data side: kind `text` and `sources.body` (options compared), the migration, `submit_source` with `text`, the worker chunking the text without Tracy, `breakLongLines`, the 30,000-character limit, the monthly cap, sync, drafts on the phone | [DECISIONS.md](../DECISIONS.md) D52–D55; [DATA_MODEL.md](../DATA_MODEL.md) |

Tags used in the voice reports: speech.md uses **[S]** read in the package itself, **[D]** read in
Android's documentation or source, **[R]** run in the sandbox, **[U]** unverified; pipeline.md uses
**[verified]**, **[from code]**, **[estimate]** and **[unverified]**. Nothing in either was run on
a phone.

Tags used in [android.md](android.md): **[V]** read on the primary page; **[P]** confirmed by unpacking the
published package; **[S]** from a search excerpt or secondary source; **[I]** inference. Treat [S]
and [I] claims as "verify before relying on it".
