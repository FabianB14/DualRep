# Research reports

The research done on 2026-10-08, before Phase 0 was built. These are background reference: the
guides in `docs/` and the code in the repo are what to follow. Where a report and the repo disagree,
the repo wins.

| Report | What it covers | Used in |
|---|---|---|
| [versions.md](versions.md) | Pinned package versions for Expo SDK 57, React Native 0.86, PowerSync 2.x and Supabase, and what was checked by running them | [DECISIONS.md](../DECISIONS.md), [SETUP.md](../SETUP.md) |
| [powersync.md](powersync.md) | Sync Streams vs Sync Rules, the Supabase side (replication, publication, grants), auth, the client connector, data types, pricing, and how to verify the gate | [DATA_MODEL.md](../DATA_MODEL.md), [SETUP.md](../SETUP.md) |
| [android.md](android.md) | Android and Google Play rules as of October 2026, with a checklist per roadmap phase and sources | [ANDROID.md](../ANDROID.md) |
| [exercise-data-and-fsrs.md](exercise-data-and-fsrs.md) | The free-exercise-db dataset (license, shape, mapping rules to DualRep's columns) and FSRS scheduling with ts-fsrs | [DATA_MODEL.md](../DATA_MODEL.md), [DECISIONS.md](../DECISIONS.md) D9 |

The Tracy review is not copied here: [TRACY_INTEGRATION.md](../TRACY_INTEGRATION.md) replaces it.

Tags used in [android.md](android.md): **[V]** read on the primary page; **[P]** confirmed by unpacking the
published package; **[S]** from a search excerpt or secondary source; **[I]** inference. Treat [S]
and [I] claims as "verify before relying on it".
