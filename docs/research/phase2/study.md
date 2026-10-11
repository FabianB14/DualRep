# DualRep Phase 2: the study engine on the phone (research report)

*Researched 2026-10-09 against `DualRep` at `38a8f25` (Merge PR #3, the Phase 1 core loop on `main`) and
`tracy-ai` at `88f4201`. Read-only: neither repo was changed and nothing was committed. Scratch files
are under `scratch/` next to this report (`scratch/scripts/*`, `scratch/out/*`).*

Track: the on-device study engine and its UX. FSRS with `ts-fsrs`, the quiz-first block inside the
focus phase, answer modes, the daily "reviews due" reminder, the study screens, and what the phone
needs from sync. The backend (Storage, worker, queue, Edge Functions) is the sibling `supabase.md`;
Tracy's tasks are `tracy.md`; Expo packages are `expo.md`.

**How things were checked.**
- `npm pack ts-fsrs@5.4.2`, read `dist/index.d.ts` (594 lines), ran a Node 22.22.0 probe
  (`scratch/scripts/probe.mjs`, output `scratch/out/probe.txt`).
- Compiled the package with the repo's own Hermes compiler. Then ran it on a Hermes VM
  (`hermes-engine-cli@0.12.0`) after a Babel pass, and compared the output with Node.
- Type-checked an import with the repo's TypeScript 6.0.3 and Expo's `tsconfig.base`.
- Built a dependency-free UUIDv5 and checked it against the documented worked example and
  `node:crypto`, in Node and on Hermes.
- Prototyped the typed-answer matcher (`scratch/scripts/match.mjs`).
- Read the `expo-notifications` 57.0.22 types and Android sources, and the `@powersync/common` 2.3.1
  types. Read PowerSync's schema-change doc from its GitHub source (docs.powersync.com is blocked by
  the proxy).

Anything not checked that way is marked **unverified**.

---

## 0. Key findings

1. **`ts-fsrs@5.4.2` is the right pin and works on Hermes.**
   - `latest` is 5.4.2 (2026-09-01); `beta` is 6.0.0-beta.13 (2026-10-03). `FSRSVersion` is
     `"v5.4.2 using FSRS-6.0"`, with 21 weights.
   - The UMD build compiles with the repo's `hermesc` (Hermes 1.0.0, HBC 98).
   - After a Babel class transform, the same probe on a Hermes VM printed the **same** results as
     Node, fuzz included.
   - It has no Node-only APIs. It patches `Date.prototype` (4 methods), and uses `Proxy` and
     `Reflect`.
   - A real Android run is still **unverified**.
2. **A `card_states` row can be passed to `fsrs().next()` directly** (ISO strings, integer state,
   `null` last_review). Three catches:
   - **Extra fields pass through.** `id`, `user_id`, `created_at` and so on come back on the result,
     plus a deprecated `elapsed_days`. So write columns explicitly.
   - **The TypeScript type wants `elapsed_days`.** Map rows through a small `toCardInput()`.
   - **A clock that moved back breaks things.** Reviewing more than a day before `last_review`
     throws `FSRSValidationError: Invalid delta_t "-3"`. Less than a day before, it produces a
     `last_review` older than the stored one, which the server's stale-write guard then silently
     skips. **Clamp the review time to `max(now, last_review)`.**
3. **Each answer is one local `writeTransaction`:** INSERT `reviews`, then UPDATE or INSERT
   `card_states`.
   - The id is UUIDv5(`c4cae30d-…`, `user:card`).
   - A 60-line pure-JS SHA-1/UUIDv5 reproduces `57743c5a-f966-538b-bccb-0919027b21c9`, and matches
     `node:crypto` on 2000 of 2000 random names, on Node and on Hermes. No new dependency is needed.
4. **Mixed `card_states` after two offline devices.** PowerSync PATCH carries "the value of each
   changed column" only (`CrudEntry.d.ts`). Some FSRS fields often don't change between reviews (in
   the probe `stability` stayed 2.3065 across a learning step). A newer PATCH from a second offline
   device can then land on top of the other device's row and leave a **mixed state**.
   - Fix: upload `card_states` PATCHes as the full local row (a small `upload.ts` change), so the
     stale guard decides on whole states.
   - Optionally repair locally when `reps` is less than the number of synced reviews.
5. **The quiz plugs into the focus phase without touching the timer or the handoff.**
   - The machine gains only the plan id and a per-block filter. The study panel is a sibling that
     reads the phone's database. Each answer is its own atomic transaction.
   - The block's progress (new cards introduced, the self-test set) comes from
     `reviews.interval_block_id`, so it survives restarts with no extra saved state.
   - With no plan chosen, the focus screen is exactly today's timer.
6. **Sync covers almost everything the screens need, with three gaps.**
   - **Cards can't be traced to their source on the phone.** `cards.source_chunk_id` points into
     `source_chunks`, which never syncs. That blocks the "newest source" filter and the "p. 12 of
     Lecture 3" citation.
   - **Topics have no draft state** for the outline review.
   - **`tracy_events` rows say nothing about which plan or source** they belong to, so per-source
     progress and errors can't be shown.
   - The smallest fix is one migration (40 lines, one SQL Editor paste) adding `topics.status`, a
     trigger-derived `cards.source_id`, and `tracy_events.plan_id` and `source_id` (section 6).
   - **Run against Postgres 16** with the repo's own `db-test.sh` in a scratch copy: a new 17-test
     file passes, and with 3 small edits to `00_schema.test.sql` all **15 files and 559 tests
     pass**.
7. **Reminder:** `SchedulableTriggerInputTypes.DAILY` is `{ type, hour, minute, channelId? }`
   (verified). The Android code computes the next local hh:mm, survives reboot, and uses an exact
   alarm only when allowed. The text is fixed when scheduled. Rescheduling on start, on foreground
   and after a block keeps it right, and "N cards due" stays a true lower bound if the app isn't
   opened.

---

## 1. FSRS with ts-fsrs 5.4.2

### 1.1 Package facts (verified)

| Fact | Value | Source |
|---|---|---|
| Tags | `latest` 5.4.2 (2026-09-01T02:23Z), `beta` 6.0.0-beta.13 (2026-10-03) | `npm view ts-fsrs` |
| 5.4.x changes | 5.4.2 "clip parameters after migrating"; 5.4.1 sqrt ceiling on w17/w18; 5.4.0 `FSRSError`/`FSRSValidationError`, `checkParameters` rejects NaN | `CHANGELOG.md` in the tarball |
| Version and weights | `FSRSVersion = "v5.4.2 using FSRS-6.0"`, `default_w.length = 21` | probe |
| Module | `"type": "module"`; exports `require → dist/index.cjs`, `import → dist/index.mjs`, `umd`, `default`, `types → dist/index.d.ts`; top-level `"types"` too. MIT, `engines.node >= 20` | `package.json` |
| Tarball | sha1 `7bd23da3d8a35368b813f4064eabe829a46f9901`, 13 files, `index.mjs` 61,245 bytes | `npm pack` |
| TypeScript | With the repo's settings (`moduleResolution: bundler`, `customConditions: ["react-native"]`, TS 6.0.3) it resolves to `dist/index.d.ts`. `tsc` exits 0 | `scratch/tsproj` |
| Metro | `unstable_enablePackageExports: true` (metro-config 0.84.5 defaults). Expo adds `mjs` and `cjs` to `sourceExts` (`@expo/config/build/paths/extensions.js:44-45`, `@expo/metro-config/.../ExpoMetroConfig.js:162`). An `import` should resolve `index.mjs`; a bundle was **not** built here | read |
| Jest | `require('…/dist/index.cjs')` loads in Node and installs the `Date.prototype` patches. jest-expo should take the `require` condition with no `transformIgnorePatterns` change: **unverified** in the repo's jest | Node |

### 1.2 The API (from `dist/index.d.ts`, confirmed by running it)

```ts
enum State  { New = 0, Learning = 1, Review = 2, Relearning = 3 }
enum Rating { Manual = 0, Again = 1, Hard = 2, Good = 3, Easy = 4 }
type Grade = Exclude<Rating, Rating.Manual>;              // Grades = [1, 2, 3, 4]
type DateInput = Date | number | string;

interface Card {
  due: Date; stability: number; difficulty: number;
  /** @deprecated removed in 6.0.0 */ elapsed_days: number;
  scheduled_days: number; learning_steps: number; reps: number; lapses: number;
  state: State; last_review?: Date;
}
interface CardInput extends Omit<Card, 'state' | 'due' | 'last_review'> {   // still needs elapsed_days
  state: StateType | State; due: DateInput; last_review?: DateInput | null;
}
interface ReviewLog {                                       // values from BEFORE the review
  rating: Rating; state: State; due: Date; stability: number; difficulty: number;
  /** @deprecated */ elapsed_days: number; /** @deprecated */ last_elapsed_days: number;
  scheduled_days: number; learning_steps: number; review: Date;
}
type RecordLogItem = { card: Card; log: ReviewLog };
interface FSRSParameters {
  request_retention: number; maximum_interval: number; w: number[] | readonly number[];
  enable_fuzz: boolean; enable_short_term: boolean; learning_steps: Steps; relearning_steps: Steps;
}
const generatorParameters: (props?: Partial<FSRSParameters>) => FSRSParameters;
const checkParameters: (w: number[] | readonly number[]) => number[] | readonly number[]; // throws
function createEmptyCard<R = Card>(now?: DateInput, afterHandler?: (c: Card) => R): R;
const fsrs: (params?: Partial<FSRSParameters>) => FSRS;
class FSRS {
  repeat(card: CardInput | Card, now: DateInput): IPreview;        // keys "1".."4", iterable
  next(card: CardInput | Card, now: DateInput, grade: Grade): RecordLogItem;
  get_retrievability(card, now?, format?: false): number;           // format true → "80.83%"
  rollback(card, log: ReviewLogInput): Card;                          // not an exact inverse in v5
  forget(card, now, reset_count?): RecordLogItem;
  reschedule(current_card, reviews?: FSRSHistory[], options?): { collections; reschedule_item };
}
function dateDiffInDays(last: Date, cur: Date): number;              // UTC calendar days
// FSRSError / FSRSValidationError exist at runtime but are NOT exported in 5.4.2 (neither the d.ts
// nor the module): catch with `error instanceof Error && error.name === 'FSRSValidationError'`.
```

`generatorParameters()` defaults: `request_retention 0.9`, `maximum_interval 36500`,
`enable_fuzz false`, `enable_short_term true`, `learning_steps ['1m','10m']`,
`relearning_steps ['10m']`, and `w` = 21 numbers (`0.212, 1.2931, 2.3065, 8.2956, 6.4133, …, 0.1542`).

### 1.3 What the probe showed

`createEmptyCard(2026-10-09T09:00Z)` → `{ due: Date(t0), stability 0, difficulty 0, elapsed_days 0,
scheduled_days 0, reps 0, lapses 0, learning_steps 0, state 0, last_review: undefined }`.

First answer on a new card (`repeat()`):

| Rating | State after | Due | stability | difficulty | scheduled_days | learning_steps |
|---|---|---|---|---|---|---|
| Again | Learning (1) | +1 min | 0.212 | 6.4133 | 0 | 0 |
| Hard | Learning (1) | +6 min | 1.2931 | 5.11217071 | 0 | 0 |
| Good | Learning (1) | +10 min | 2.3065 | 2.11810397 | 0 | 1 |
| Easy | Review (2) | +8 days | 8.2956 | 1 | 8 | 0 |

Other results:
- **A stored row works as input.**
  - `f.next(row, t1, Good)` with `due` and `last_review` as ISO strings, `state: 1`, extra fields,
    and no `elapsed_days` gave **exactly** the same card as a proper `Card` with `Date` objects and
    `elapsed_days: 999`.
  - So input `elapsed_days` is ignored and recomputed from `last_review` in UTC days.
  - A New row with `last_review: null` works too: `TypeConvert.card` turns a falsy value into
    `undefined`.
- **The result carries the input's fields.** Keys on the result were `id, user_id, card_id, state,
  due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review, suspended,
  created_at, updated_at, elapsed_days`. Never spread the result into an INSERT.
- **`log` holds the values from before the review.** For a Learning card answered at +10m30s,
  `log.state = 1` and `log.due` = the previous `last_review` (09:00), not the previous due (09:10).
- **Second Good** (+10m30s) → Review, due 2026-10-11T09:10:30Z, `scheduled_days 2`,
  `stability 2.3065` (unchanged), `difficulty 2.1112`.
- **A Review card answered Again two days late** → Relearning (3), due +10 min, `lapses 1`,
  `log.elapsed_days 4`, which equals `dateDiffInDays(last_review, now)`.
- **Clock moved back.**
  - −1 hour: no error, `elapsed_days 0`, and the new `last_review` is **earlier than the stored
    one**.
  - −3 days: throws `FSRSValidationError: Invalid delta_t "-3"`.
- **Bad input throws.** `Rating.Manual` → `Cannot review a manual rating`; `5` →
  `Invalid grade "5",expected 1-4`; a bad date → `Invalid date:[not a date]`.
- **Retrievability:** `get_retrievability(reviewCard, due + 5 d, false)` = 0.80830994. New card → 0.
- **Replaying the log rebuilds the state exactly.** `reschedule(createEmptyCard(t0),
  [{rating, review: reviewed_at}…], { skipManual: true, now })` gave the same last card as
  step-by-step `next()`. So `reviews` alone can rebuild `card_states`.
- **Fuzz is deterministic.** With `enable_fuzz: true`, the same input gave the same due date twice
  (2026-11-18 vs 2026-11-17 unfuzzed), and the same on Hermes.
- **Value ranges fit the schema's CHECKs** over a 12-answer sequence:
  - `scheduled_days` was always an integer ≥ 0 (0 in Learning and Relearning).
  - `difficulty` stayed in [1, 10] after the first answer (0 when New).
  - `stability` ≥ 0.001.
- **Speed:** 2000 `next()` calls took 22 ms on Node, so speed is not a concern.

### 1.4 Hermes and React Native

- **Static scan of `dist/index.mjs`:** no `BigInt`, `structuredClone`, `Intl.`, regex lookbehind,
  `.at(`, `Object.hasOwn`, `findLast`, `crypto`, `Buffer`, `WeakRef`, dynamic `import()` or
  `require(`. Its one `process.` is in a comment.
  - It uses `Proxy` (parameters), `Reflect.get/set`, `Symbol.iterator` (the preview) and
    `Error.captureStackTrace?.()`.
  - **Side effect at import:** `Date.prototype.scheduler/diff/format/dueFormat` are assigned
    (removed in 6.0). Harmless, but import ts-fsrs from one module (`src/features/study/fsrs.ts`).
- **Compiled with the repo's Hermes:**
  `node_modules/hermes-compiler/hermesc/linux64-bin/hermesc -emit-binary` on `dist/index.umd.js`.
  Exit 0, 49,462-byte HBC, one warning (`console` undeclared). That is Hermes 1.0.0, the engine RN
  0.86 ships.
- **Executed on a Hermes VM.** `hermes-engine-cli@0.12.0` is an older Hermes without native
  classes, so the UMD build was first passed through `@babel/plugin-transform-classes` and friends
  from the repo's `node_modules` (`scratch/scripts/build-hermes-probe-legacy.cjs`).
  - Output, identical to Node line for line:
    ```
    version v5.4.2 using FSRS-6.0
    r1 2026-10-09T09:10:00.000Z s=2.3065 d=2.11810397 state=1
    r2 2026-10-11T09:10:30.000Z sd=2 state=2
    r3 fuzzed 2026-12-14T09:10:30.000Z sd=34
    repeat iterable count 4
    retrievability 0.66138059
    reschedule 2 2026-10-11T09:10:30.000Z
    clock-back error: FSRSValidationError Invalid delta_t "-3"
    ```
  - **Unverified:** a Metro bundle on a real Android phone. Add a smoke check to the Phase 2 preview
    APK: a hidden "FSRS check" row on the Sync check screen that runs `next()` once and shows the
    due date.

### 1.5 Mapping to `card_states` and `reviews`

Tables: `supabase/migrations/20261008000000_initial_schema.sql:444-470` (`card_states`) and
`:474-495` (`reviews`); registry `src/db/tables.ts:355-402`.

| Column | Value written by the phone | Notes |
|---|---|---|
| `card_states.id` | `uuidV5(CARD_STATE_ID_NAMESPACE, `${userId}:${cardId}`)` | CHECK `card_states_id_derived` (`:461-465`), otherwise 23514 |
| `user_id`, `card_id` | the signed-in user, the card | ownership-only RLS (`:1657-1670`) |
| `state` | `card.state` (0–3) | smallint |
| `due` | `card.due.toISOString()` | TEXT on the phone; ms precision matches the sync config, so text order = time order |
| `stability`, `difficulty` | `card.stability`, `card.difficulty` | REAL; CHECK `difficulty between 0 and 10` holds |
| `scheduled_days`, `learning_steps`, `reps`, `lapses` | from `card` | integers ≥ 0 |
| `last_review` | `card.last_review.toISOString()` | drives the stale guard `skip_stale_card_state` (`:1093-1109`) |
| `suspended` | kept as it was (0 for a new row) | not an FSRS field |
| `created_at` / `updated_at` | review time (INSERT) / review time (UPDATE) | the server owns `updated_at` |
| **Not stored** | `elapsed_days` | recomputed by ts-fsrs; removed in 6.0 |
| `reviews.id` | `newId()` made **when the card is shown** | insert-ignore on upload, so retries are harmless |
| `reviews.rating` | the grade (1–4) | |
| `answer_mode` | `'self_graded'` or `'typed'` in Phase 2 | CHECK also allows `spoken`, `handwritten` |
| `reviewed_at` | the clamped review time (see 1.6) | |
| `duration_ms` | answer time − shown time, clamped to 0..600000, else null | |
| `prev_state` | `log.state` (state before) | |
| `elapsed_days` | `row.last_review ? utcDayDiff(row.last_review, at) : 0` | equals `log.elapsed_days` (verified); compute it yourself so 6.0's removal doesn't matter; CHECK ≥ 0 holds after the clamp |
| `state`, `due_at`, `stability`, `difficulty`, `scheduled_days` | from `card` (**after** the review) | the `log` fields are before-values; don't use them here |
| `interval_block_id` | the running focus block's id | server nulls a foreign one (`clear_interval_block_reference`) |

### 1.6 The answer write (proposed `src/features/study/studyRepo.ts`)

```ts
import { createEmptyCard, fsrs, generatorParameters, type CardInput, type FSRSParameters, type Grade } from 'ts-fsrs';

type CardStateRow = { id: string; state: number; due: string; stability: number; difficulty: number;
  scheduled_days: number; learning_steps: number; reps: number; lapses: number; last_review: string | null;
  suspended: number };

/** ts-fsrs input from a stored row. elapsed_days is required by the 5.x type but ignored. */
export function toCardInput(row: CardStateRow): CardInput {
  return { due: row.due, stability: row.stability, difficulty: row.difficulty, elapsed_days: 0,
    scheduled_days: row.scheduled_days, learning_steps: row.learning_steps, reps: row.reps,
    lapses: row.lapses, state: row.state, last_review: row.last_review };
}

export async function answerCard(input: {
  reviewId: string; userId: string; cardId: string; blockId: string | null; grade: Grade;
  answerMode: 'self_graded' | 'typed'; answeredAt: number; shownAt: number | null;
}, scheduler = defaultScheduler()): Promise<void> {
  const id = cardStateId(input.userId, input.cardId);            // UUIDv5, section 1.7
  await db.writeTransaction(async (tx) => {
    if (await tx.getOptional(`SELECT id FROM ${T.reviews} WHERE id = ?`, [input.reviewId])) return; // replay
    const row = await tx.getOptional<CardStateRow>(`SELECT * FROM ${T.card_states} WHERE id = ?`, [id]);
    const last = row?.last_review ? Date.parse(row.last_review) : null;
    const at = last === null ? input.answeredAt : Math.max(input.answeredAt, last); // clock-back guard
    const { card } = scheduler.next(row ? toCardInput(row) : createEmptyCard(at), at, input.grade);
    const iso = isoTimestamp(at);
    await tx.execute(`INSERT INTO ${T.reviews} (id, user_id, card_id, interval_block_id, rating, answer_mode,
        reviewed_at, duration_ms, prev_state, elapsed_days, state, due_at, stability, difficulty, scheduled_days,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [input.reviewId, input.userId, input.cardId, input.blockId, input.grade, input.answerMode, iso,
       durationMs(input), row ? row.state : 0, last === null ? 0 : utcDayDiff(last, at), card.state,
       card.due.toISOString(), card.stability, card.difficulty, card.scheduled_days, iso, iso]);
    const v = [card.state, card.due.toISOString(), card.stability, card.difficulty, card.scheduled_days,
               card.learning_steps, card.reps, card.lapses, iso];
    if (row) {
      await tx.execute(`UPDATE ${T.card_states} SET state=?, due=?, stability=?, difficulty=?, scheduled_days=?,
          learning_steps=?, reps=?, lapses=?, last_review=?, updated_at=? WHERE id=?`, [...v, iso, id]);
    } else {
      await tx.execute(`INSERT INTO ${T.card_states} (id, user_id, card_id, state, due, stability, difficulty,
          scheduled_days, learning_steps, reps, lapses, last_review, suspended, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`, [id, input.userId, input.cardId, ...v, iso, iso]);
    }
  });
}
```

- **Select, then UPDATE or INSERT**, the same pattern as `localState.ts`: PowerSync tables are
  views, and SQLite UPSERT on them is not proven.
- **What uploads.** One CRUD transaction: `reviews` PUT (insert-ignore) plus `card_states` PUT
  (upsert) or PATCH, sent as separate requests by `connector.ts:83-96`.
- **Server side:**
  - `skip_study_row_without_card` (`:1350-1368`) skips both rows if the card was deleted.
  - The derived-id CHECK and the stale guard protect `card_states`.
- **Parameters.** `defaultScheduler()` = `fsrs(generatorParameters({ ...DUALREP_FSRS_DEFAULTS,
  ...validated(profiles.fsrs_params) }))`, made once and memoized; validate `w` with
  `checkParameters`.
  - Recommended `DUALREP_FSRS_DEFAULTS`: ts-fsrs defaults plus **`enable_fuzz: true`**. Fuzz is
    deterministic (verified), so a replay on the server reproduces the device's result. It also
    spreads out the 20–40 cards a lecture creates, so they don't all fall due on the same day.
  - `DATA_MODEL.md` says `fsrs_params` null means "ts-fsrs defaults". Change it to "DualRep
    defaults", and record the choice as a decision.
- **Undo** (optional): keep the last answer for about 5 s before calling `answerCard`. Don't use
  `rollback()`; v5's is not exact.

**The two-device fix (finding 4).**
- **The problem.** `@powersync/common@2.3.1` `CrudEntry.d.ts:17` documents PATCH as "the id, and
  value of each changed column".
  - Suppose device A (offline) answers a card, and device B (offline, same older base) answers it
    later. A uploads first. B's newer `last_review` passes the stale guard, but B's PATCH leaves out
    columns B didn't change, such as `stability` or `lapses`. The server row keeps A's values for
    those, mixed with B's `due` and `state`.
- **The fix.** Add a write policy `patch: 'full-row'` for `card_states` in `src/db/tables.ts`. On a
  PATCH, `planOperation` sends every registry column from the **current local row** (read in
  `uploadData` before planning). The stale guard then accepts or skips a whole state.
- **Repair** (optional, later): after a sync, if the user's `reviews` for a card number more than
  `card_states.reps`, the log has answers the state missed. Replay them with `reschedule()` and write
  the result.

### 1.7 UUIDv5 on the device (no new dependency)

- **Pure JS, verified.** `scratch/scripts/uuidv5.js` is a 60-line SHA-1 plus UUIDv5 over the 16
  namespace bytes and the ASCII name.
  - It gives `57743c5a-f966-538b-bccb-0919027b21c9` for the worked example, on Node and on Hermes.
  - It matched `node:crypto` for 2000 of 2000 random `uuid:uuid` names.
  - Port it to `src/lib/uuidv5.ts`. It is synchronous and testable in Jest; the existing
    `src/db/__tests__/constants.test.ts` reference implementation can test it.
- **Alternatives:**
  - `expo-crypto` 57.0.3 `digest(CryptoDigestAlgorithm.SHA1, bytes)`. Native and async; Android uses
    `MessageDigest` (`CryptoModule.kt:44-50`). It needs a Jest mock.
  - `uuid@14.0.2` `v5`. It is only a transitive dev dependency today. The package is ESM-only, so
    Jest would need it added to `transformIgnorePatterns`, and its browser build calls `unescape()`
    (`dist/v35.js:4`; Hermes support **unverified**).

---

## 2. The quiz-first block inside the focus phase

### 2.1 What the Phase 1 loop gives us (read)

- **`cycleMachine.ts`** is a pure reducer.
  - Events carry `at` and ids (`:267-318`); effects are queued in `pending`, then saved, performed and
    acknowledged by `cycleStore.ts` (`:499-559`).
  - `FocusState` (`:202-221`) holds the timer, `circuit`, `workoutId`, `transitionId` and
    `notificationId`.
  - The handoff happens in `endFocus` → `handoff` (`:534-614`) with zero taps.
  - `CYCLE_STATE_VERSION = 1` (`:72`). `parseCycleState` (`:1101-1106`) **drops** a saved state of
    another version, and `looksValid` ignores unknown fields.
- **`cycleRepo.startFocusBlock`** (`:66-88`) inserts `study_sessions` **without `plan_id`** and
  `interval_blocks` with `mode 'seated'`.
- **`useCycle`** ticks every second while the screen is open (`useCycle.ts:178-218`). So `FocusView`
  re-renders every second, and a study panel must not re-query on every tick.
- **The morph.** `FocusView` measures the ring (`onRingFrame`). `HandoffMorph` grows from that frame,
  or from the card's center when `from` is null (`HandoffMorph.tsx:36, 68`). A smaller ring therefore
  still morphs.
- **Alerts.** Block-end alerts are silenced only while a timer screen is visible
  (`notifications.ts:92-110`).

### 2.2 Design: the timer machine keeps time, the study panel reads the database

The study block is **not** put into the reducer's effect queue. The reasons:
- An answer is one self-contained, atomic local transaction with an id made in advance. A crash
  before the commit simply leaves the card due, as an un-tapped "Done" would.
- Ordering is already safe: `start_focus_block` is the first effect of a block, so the
  `interval_blocks` row is written (and queued for upload) before any answer. If it ever lost the
  race, the server stores `interval_block_id` as null instead of refusing.
- Everything the queue needs to remember about a block can be rebuilt from the database:
  `SELECT card_id, prev_state, rating, reviewed_at FROM reviews WHERE interval_block_id = ?`.
  So nothing new needs to go into `local_state` for crash safety.

**Machine changes (small, backward-compatible):**

```ts
// cycleMachine.ts
export type StudyFilter = 'all' | 'newest';
export type CyclePlan = { /* …existing… */
  /** The study plan for this cycle (study_plans.id), or null: timer-only focus, as in Phase 1. */
  studyPlanId: string | null;
  /** Default filter for each block of a cumulative plan. */
  studyFilter: StudyFilter;
};
export type FocusState = /* … */ & {
  /** This block's filter (starts as plan.studyFilter); absent in states saved by Phase 1. */
  studyFilter?: StudyFilter;
};
| { type: 'set_study_filter'; at: number; filter: StudyFilter }   // focus phase only; no effect
```

- **`normalizePlan`** (`:340-366`): `studyPlanId` must be a non-empty string, else null.
  `studyFilter` is `'newest'` or `'all'`.
- **`beginFocus`** (`:475-515`): `studyFilter: core.plan.studyFilter`; pass
  `planId: core.plan.studyPlanId` in `StartFocusBlockInput`.
- **`cycleRepo.startFocusBlock`**: `INSERT INTO study_sessions (id, user_id, plan_id, focus_subject, …)`.
  The server's `clear_plan_reference` nulls an unreadable plan.
- **`reduceFocus`**: `set_study_filter` returns `{ ...state, studyFilter }` while the block runs.
  Its value lives in the persisted state, so a restart keeps it.
- **Keep `CYCLE_STATE_VERSION = 1`.** Read a missing `studyPlanId` as null and a missing filter as
  `'all'`. A version bump would make `parseCycleState` drop a cycle that is running during the app
  update, leaving an open `interval_blocks` row. Add a test that a Phase 1 saved state still loads.
- **No change** to the timer, alerts, handoff, move or return logic, stats or `cycleHaptic`.

**UI changes:**
- **`StartPanel`.** "What are you studying?" becomes a plan picker.
  - One chip per plan, with its due count, plus **No plan (just a timer)**. The free-text subject
    stays for "No plan".
  - For a cumulative plan: a filter row, **Everything so far** / **Newest: ‹source title›**.
  - When a plan is chosen, `focusSubject = plan.title` (≤ 200 characters).
  - Remember the last choice in `local_state` (`study-defaults`).
- **`FocusView`.**
  - With `studyPlanId === null`: unchanged (the big ring).
  - Otherwise: a compact ring (about 96 dp) in the top bar area, which still reports `onRingFrame`
    for the morph, and a `StudyPanel` below it.
  - Pause hides the card ("Paused", no peeking).
  - "End block early" and "Finish" are unchanged.
- **`FinishSummary`.** Add "Cards: 18 answered, 15 right, 5 new", read from
  `reviews JOIN interval_blocks ON interval_block_id WHERE study_session_id = ?`.

**Block end while a card is open:** the open card is dropped (no write; it stays due) and the
handoff runs as today. A last-second rating is lost; that is acceptable and keeps the handoff
zero-tap.

### 2.3 Queue algorithm (`src/features/study/queue.ts`, pure and unit-tested)

**Inputs:**
- `userId`, `planId`, `scope`, `filter`, `now`
- the block's `timer` (`remainingMs`)
- the block's own answers (from `reviews WHERE interval_block_id = ?`)
- settings: `newPerBlock`, `dailyNewCap`, `typedAnswers`, `fourButtons`

**Which source the filter means:**
- Scope `single`: the plan's only source. If a plan switched back from cumulative, use the newest
  source with at least one ready card, and say so ("Single source: Lecture 4").
- Scope `cumulative`: filter `all` = every card in the plan; `newest` = cards whose `source_id` is
  the source with the latest `plan_sources.added_at` among sources that have ready cards. If the
  newest upload is still processing, fall back to `all` and say "Lecture 5 isn't ready yet".
- Switching scope or filter never touches `card_states`, so progress is never reset (the plan's
  rule).

**Candidate queries** (PowerSync views; ISO text compares as time). Run them when the block starts,
after each answer, and when `card_states` or `cards` change, through `useQuery(…, { throttleMs: 1000 })`
(`SQLOnChangeOptions.throttleMs`, `@powersync/common` 2.3.1). Never once per tick.

```sql
-- Due and learning candidates up to the block's end (learning steps come due inside the block).
SELECT s.id, s.card_id, s.state, s.due, s.stability, s.difficulty, s.scheduled_days, s.learning_steps,
       s.reps, s.lapses, s.last_review, c.topic_id, c.source_id, t.position AS topic_position
FROM card_states s
JOIN cards c  ON c.id = s.card_id
JOIN topics t ON t.id = c.topic_id
WHERE s.user_id = ?1 AND s.suspended = 0 AND c.plan_id = ?2
  AND (?3 IS NULL OR c.source_id = ?3)
  AND COALESCE(t.status, 'ready') = 'ready'
  AND s.due <= ?4                       -- ?4 = block end (ISO); JS decides what is due "now"
ORDER BY CASE WHEN s.state IN (1, 3) THEN 0 ELSE 1 END, s.due
LIMIT 400;

-- New cards (no state row yet), outline order; newest source first in a cumulative plan.
SELECT c.id AS card_id, c.topic_id, c.source_id, t.position AS topic_position
FROM cards c
JOIN topics t ON t.id = c.topic_id
LEFT JOIN card_states s ON s.card_id = c.id AND s.user_id = ?1
LEFT JOIN plan_sources ps ON ps.plan_id = c.plan_id AND ps.source_id = c.source_id
WHERE c.plan_id = ?2 AND s.id IS NULL AND (?3 IS NULL OR c.source_id = ?3)
  AND COALESCE(t.status, 'ready') = 'ready'
ORDER BY ps.added_at DESC, t.position, c.created_at, c.id
LIMIT 50;

-- New cards already introduced today (daily cap); local midnight from history.ts startOfLocalDay.
SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?1 AND prev_state = 0 AND reviewed_at >= ?2;
```

Indexes used: `card_states.user_due`, `cards.by_plan`, `card_states.by_card`, `topics.by_plan`,
`reviews.user_time` (`tables.ts`). `cards.source_id` and `topics.status` are the section 6 columns;
until they exist, the filter is `all` only.

**Next card** (`nextItem(candidates, blockAnswers, now, remainingMs, settings)`), in priority order:

0. **Closing self-test** once `remainingMs ≤ selfTestMs`, where
   `selfTestMs = clamp(round(0.12 × blockMs), 2 min, 5 min)` (25 min → 3 min).
   - Items: this block's cards answered with `prev_state = 0` or `rating = 1`, not yet answered
     after the self-test began, oldest first, at most 5.
   - Answered and written like any review. FSRS-6 with `enable_short_term: true` models same-day
     reviews (w17–w19).
   - Nothing left: "Nice. Nothing to re-test; free focus until the timer ends."
1. **Learning or relearning** cards (state 1 or 3) with `due ≤ now`, earliest first. The 1-minute
   and 10-minute steps come back inside the same block.
2. **Due reviews** (state 2, `due ≤ now`), **interleaved**: group by `source_id` (cumulative plan,
   filter `all`), otherwise by `topic_id`. Order groups by their most overdue card, then take
   round-robin. Never show the card just answered next if anything else is available.
   - **Review budget:** if unseen new cards remain and the plan's pace needs them (below), stop
     serving reviews once `0.6 × (blockMs − selfTestMs)` has gone to reviews in this block.
   - Otherwise serve reviews until they run out (reviews first, as in Anki).
3. **New cards**, while `newIntroducedThisBlock < newPerBlock` and
   `newToday < dailyNewCap`.
   - Defaults: `newPerBlock = clamp(round(blockMinutes / 5), 2, 8)` (25 min → 5), and
     `dailyNewCap = 20`.
   - **Pace:** with a `target_date`, the needed rate is `ceil(unseen / daysLeft)`. If it is above
     the cap, show one line ("At this pace you'll see 140 of 200 cards before the exam") with a
     **Raise to 30 a day** action.
   - A new card is shown quiz-first: the question, then "Show answer", then the rating.
4. A learning card due within the next 60 s: show "Next card in 0:42" with **Ask now** as a
   secondary action.
5. **Nothing left:** start the self-test early; then "All caught up. Free focus until the timer
   ends." There is no passive reread mode (the plan's rule). Offer **Add a card** as a quiet link.

**Constants to calibrate** after a week: about 10 s per self-graded review and about 40 s per new
card, from the median `reviews.duration_ms`.

**The open card.** Keep `{ blockId, cardId, reviewId, shownAt, revealed }` in React state, and
optionally in `local_state` (`study-current`), so a restart shows the same card. Then killing the app
doesn't skip a hard card.

### 2.4 No plan, group plans, and other cases

| Case | Behavior |
|---|---|
| No plan chosen | Phase 1 focus screen exactly; `study_sessions.plan_id` null |
| Plan with no ready cards (still processing) | Panel shows the plan's next step ("Cards are being made: 2 of 6 topics") and the timer; free focus |
| Paused | Card hidden; answering disabled |
| End block early / Finish / sign-out | Open card dropped; the answers already written stay. Sign-out's `finishAndStop` is unchanged; local-only `study-current` is cleared with the database |
| Group plan (Phase 4) | Members answer shared cards; `card_states` and `reviews` stay private (`user_private`). Members can't edit cards (RLS `can_edit_plan`), so hide editing |
| Plan unshared or deleted mid-block | Cards leave the phone at the next sync; queries return nothing; answers already given upload (ownership-only RLS) or are skipped (deleted card) |
| Clock changed | Review time is clamped to `last_review` (1.6) |

### 2.5 Tests to add

- `queue.test.ts`: priority order, interleaving, the self-test window, caps, pacing, the filter
  fallback.
- `studyRepo.test.ts`, with the mocked `db` the existing repo tests use:
  - one transaction per answer; a replay with the same `reviewId` writes nothing;
  - clamping;
  - the derived id;
  - an existing row → UPDATE, otherwise INSERT.
- `cycleMachine.test.ts`: a Phase 1 saved state loads (version 1, no study fields);
  `set_study_filter` applies only in focus; `startFocusBlock` input carries `planId`.
- `uuidv5.test.ts`: the worked example and agreement with `node:crypto`.
- `airplaneLoop.test.ts`: extend the offline loop with 3 answers in the first block, and check the
  `reviews` and `card_states` rows.

---

## 3. Answer modes for Phase 2

**Recommendation:** self-grading is the default; typed short answers are opt-in; Tracy grading waits
for Phase 3.

**Self-grading** (`answer_mode = 'self_graded'`)
- Default: **two buttons** after "Show answer": **Missed it** (Again = 1) and **Got it** (Good = 3).
  It is one decision per screen and the least friction.
- FSRS copes with pass/fail histories: the difficulty update is `delta_d = -w6 · (g − 3)`
  (`index.d.ts`, `next_difficulty`). Good leaves difficulty to mean reversion; only Again moves it.
- Settings → **Answer buttons: 2 / 4** adds Hard (2) and Easy (4) for experienced users.
- Instant feedback on every answer: a haptic (`select`), the right answer with its page ("p. 12,
  Lecture 3"), and the next interval as a hint ("Back in 10 min" / "in 3 days").

**Typed short answers** (`answer_mode = 'typed'`), on-device matching, prototype in
`scratch/scripts/match.mjs`:
- **When:** Settings → **Type short answers**. Only for cards with `card_type` `basic` or `cloze`
  whose expected answer is at most 5 words and 40 characters after normalizing. Anything else
  silently falls back to self-grading. `why` and `write_from_memory` are always self-graded in
  Phase 2.
- **Normalize:** lowercase.
  - Remove accents with `normalize('NFD').replace(/[̀-ͯ]/g,'')`, but only if
    `'é'.normalize('NFD').length === 2` at runtime. On a Linux Hermes without `Intl`,
    `normalize` was a no-op (verified); Android Hermes ships `Intl`, which is **unverified** here.
  - Unify quotes; turn punctuation into spaces; drop the articles a, an and the; collapse spaces.
  - Don't use `\p{…}` regex escapes: Hermes 0.12 rejects them (verified); Hermes 1.0 compiles them.
- **Alternatives:** split the expected answer on `;` or `|`. This is a convention for Tracy's
  `dualrep_build_cards` output.
- **Match:** Damerau–Levenshtein (OSA) distance against each alternative.
  - Allowed edits: 0 up to 4 characters, 1 up to 8, 2 up to 15, then `floor(0.15 × length)`.
  - Every number must match exactly (`9.8` ≠ `9.81`, `1915` ≠ `1914`).
  - The expected tokens may appear in order inside an answer at most 2 tokens longer ("it's the
    mitochondria").
  - Prototype results: `mitochondira` → close, `mitochondrion` → close, `ADP` vs `ATP` → wrong,
    `cat` vs `car` → wrong (too short for an edit), `citric acid cycle` vs
    `Krebs cycle; citric acid cycle` → exact, `Café` vs `cafe` → exact,
    `mitochondria nucleus ribosome golgi` → wrong.
- **Ratings:**
  - Exact → Good.
  - Close → Good, with "Counted as right. Spelling: ‹expected›".
  - Wrong → shows the answer with **I missed it** (Again, primary) and **Count it as right** (Good).
    The override keeps `answer_mode 'typed'` and the chosen rating.
  - Typed answers never produce Hard or Easy.
- **Keyboard:** the TextField stays above the keyboard; reuse the KeyboardAvoidingView fix from
  Phase 1. Submit = **Check**.
- **Phase 3:** a "partly right" verdict comes from `dualrep_grade_answer` when online. Offline it
  stays self-graded (plan, "On-the-go study").

---

## 4. The daily "reviews due" reminder (expo-notifications 57.0.22)

**Verified in `node_modules/expo-notifications`:**
- **Types.** `SchedulableTriggerInputTypes.DAILY = "daily"`; `DailyTriggerInput = { type:
  SchedulableTriggerInputTypes.DAILY; channelId?: string; hour: number; minute: number }`
  (`build/Notifications.types.d.ts:278-283`).
- **Conversion.** `parseDailyTrigger` validates `hour` and `minute` and passes `channelId` on
  (`build/scheduleNotificationAsync.js:162-178`).
  `getNextTriggerDateAsync(trigger): Promise<number | null>` exists.
- **Android.** `DailyTrigger.nextTriggerDate()` uses `Calendar.getInstance()`: the next local hh:mm,
  tomorrow if already past (`android/.../triggers/NotificationTriggers.kt:31-50`).
  - Alarms use `setExactAndAllowWhileIdle` when `canScheduleExactAlarms()`, otherwise
    `setAndAllowWhileIdle` (`ExpoSchedulingDelegate.kt:105-120`).
  - They are restored after `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED` (`AndroidManifest.xml:21-26`).
  - So no exact-alarm permission is needed (ANDROID.md 2.5).
- **The text is fixed when scheduled.** A DAILY notification repeats it.

**Design** (`src/features/study/reviewReminder.ts`, next to `timer/notifications.ts`):

```ts
export const REVIEWS_CHANNEL_ID = 'reviews-v1';               // versioned like timers-v1
export const REVIEWS_CHANNEL = {
  name: 'Review reminders', description: 'Once a day, when cards are due.',
  importance: Notifications.AndroidImportance.DEFAULT,
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,  // the count only, no card text
  sound: 'default',
} satisfies Notifications.NotificationChannelInput;
const REMINDER_ID = 'reviews-due';                             // one id: scheduling again replaces it
// data: { url: '/', kind: 'reviews-due' }  → Home; useNotificationRouting accepts any app path

export async function rescheduleReviewReminder(userId: string, time: { hour: number; minute: number } | null) {
  await cancelScheduled(REMINDER_ID);
  if (!time || (await getNotificationPermission()) !== 'granted') return;
  const next = nextLocal(time, Date.now());                    // next hh:mm in local time
  const n = await dueCount(userId, next);
  if (n > 0) {
    await Notifications.scheduleNotificationAsync({ identifier: REMINDER_ID,
      content: { title: 'Cards to review', body: `${n} cards are due. A 10-minute block clears a lot of them.`,
                 data: { url: '/', kind: 'reviews-due' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, ...time, channelId: REVIEWS_CHANNEL_ID } });
  } else {
    const first = await firstDueAfter(userId, next);           // MIN(due) of readable, unsuspended cards
    if (first === null) return;                                // nothing scheduled at all
    const at = nextLocal(time, first);                         // first reminder slot on/after it
    await Notifications.scheduleNotificationAsync({ identifier: REMINDER_ID, content: { /* count at `at` */ },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: REVIEWS_CHANNEL_ID } });
  }
}
```

```sql
-- dueCount: JOIN cards so states for cards no longer on the phone (left group, deleted) don't count.
SELECT COUNT(*) AS n FROM card_states s JOIN cards c ON c.id = s.card_id
WHERE s.user_id = ? AND s.suspended = 0 AND s.due <= ?;
```

- **Why the fixed text is still right.** If the app isn't opened, due counts only grow, so "N cards
  are due" stays true. (Answers on another device could make it an overstatement; that is minor.)
  Skipping days with nothing due avoids nagging.
- **Reschedule:**
  - after the first local read on app start;
  - on `AppState` → active;
  - when a focus block ends (not after every answer);
  - after a sync download changes `card_states` (watch `SELECT MAX(updated_at) FROM card_states`
    with `throttleMs: 30000`);
  - when the reminder setting changes.
- **Sign-out:** `cancelAllAlerts()` already removes it (`notifications.ts:204-215`).
- **Setup:**
  - Create the channel in `configureNotifications()` next to `timers-v1`.
  - Settings → **Daily review reminder: Off / 18:00** (stored in `local_state` key
    `review-reminder`: it is per phone, like alerts).
  - Offer it once, after the first study block that answered cards: "Remind me when cards are due?
    **Yes, at 6 pm**". Permission is already asked in context (D29).
- **In the foreground:** `shouldShowInForeground` shows it unless a cycle screen is visible. Add
  `kind: 'reviews-due'` to `NOTIFICATION_KIND`.

---

## 5. Screens

**ADHD-friendly defaults** (EXECUTION_PLAN "Evidence base"): one primary action per screen; the
next step always visible; instant feedback on every answer; adjustable block lengths.

**Routes** go under `src/app/(app)/` with `Stack.Screen` entries in `_layout.tsx`. Home gets a
**Study plans** row in "More" and a "Due today: 23 cards" line. Its primary action stays **Start a
study block**.

| Screen (route) | Reads | Writes | Offline? | Primary action |
|---|---|---|---|---|
| **Plans list** `/plans` | `study_plans` (own and group); per plan: due count, new count, source count, next step | — | yes | **New plan** |
| **Create plan** `/plans/new` | — | `study_plans` INSERT (`owner_id`, `title`, `scope`, `goal`, `target_date`) | yes | **Create plan** → Add material |
| **Plan detail** `/plans/[id]` | plan; `plan_sources` → `sources` (title, kind, status); `source_files` (unconfirmed transcripts); `topics` (status, position, card counts); due and new counts; latest `tracy_events` per source (status, error) | `study_plans.scope` PATCH; `plan_sources` DELETE; title and goal edits | yes (all writes) | The computed **next step**, one at a time: "Check 3 transcriptions" → "Review the outline" → "Cards are being made…" (no button) → **Study now** (starts a cycle with this plan) |
| **Add material** `/plans/[id]/add` | — | `sources` INSERT (`kind`, `title`, `url`), `plan_sources` INSERT, Storage upload `‹uid›/‹source›/‹file›.‹ext›`, `source_files` INSERT (`storage_path`, `page`), then the enqueue Edge Function | **needs network** (Storage and the queue). Offline: "Connect to add material." | **Upload** |
| **Transcription review** `/plans/[id]/sources/[sourceId]/check` | `source_files` (transcript, confirmed, page); the photo from a local cache (saved at upload) or a signed URL | `source_files` PATCH `transcript`, `confirmed = 1` | yes for the writes; the photo needs network on another phone | **Looks right** (next photo); the transcript stays editable |
| **Outline review** `/plans/[id]/outline` | `topics` of the plan: `draft` ones to review, `ready` ones greyed for context | in one transaction: `topics` PATCH `position` and `title`; DELETE cut ones; PATCH kept ones `status = 'confirmed'` | yes; the worker picks up `confirmed` topics after the upload | **Save outline and make cards** |
| **Cards browser** `/plans/[id]/cards` | `cards` with `topics`, source title (via `cards.source_id`), the user's `card_states` (due, state, suspended); filter by topic or source | owner: `cards` INSERT, PATCH, DELETE (set `plan_id` locally to the topic's plan; the server re-copies it); anyone: suspend, i.e. `card_states` PATCH `suspended`, or INSERT an empty state with `suspended = 1` and the derived id | yes | **Add a card** (owner) / **Study these** (member) |
| **Concept map** `/plans/[id]/map` | `card_links` with both cards | `card_links` INSERT (`created_by` = user id, **set by the phone**: a PUT sends the whole row, so the column default never applies; `plan_id` = the from-card's plan) and DELETE of own links | yes | **Link two cards** |
| **Focus block study panel** (in `/cycle`) | section 2.3 queries | `reviews` and `card_states` (section 1.6) | yes | **Show answer** / **Check**, then the grade |
| **Settings** additions | `local_state` | answer buttons 2/4, type short answers, new cards per block and per day, review reminder | yes | — |

**Notes on the harder screens:**
- **Outline review: accessible cut and reorder.**
  - Each row has **Move up** and **Move down** buttons and a **Keep / Cut** switch. The same actions
    are exposed as `accessibilityActions` (`[{name:'moveUp',label:'Move up'}, …]`), so TalkBack works
    without dragging. No drag-only interaction.
  - Changes are local until **Save**, so they can be undone.
  - Renumber `position` 0..n−1 in the same transaction.
- **Concept map:** draw with `react-native-svg` 15.15.4 (installed), using a simple layout: topics
  on a circle, cards around them; no new physics library.
  - Members are on the phone; a screen-reader user gets the **list view** ("Linked cards" per card,
    with relation chips: related, why, analogy, prerequisite, contrast).
  - Visual-only. On-the-go mode never shows it (plan guardrail).
- **Citations:**
  - The card shows "p. ‹page›, ‹source title›" from `cards.page` and `cards.source_id → sources.title`.
  - "Show the passage" fetches `source_chunks.content` through the API (SELECT grant plus RLS at
    `:1557-1560`). **Needs network**; hide it offline.
  - Group members may lack a source row they can't read: show "a source you can't see".
- **New packages** (exact pins, per the repo's style; versions from `expo/bundledNativeModules.json`,
  latest 57.x checked on npm):
  - `ts-fsrs` 5.4.2;
  - `expo-document-picker` 57.0.3;
  - `expo-image-picker` 57.0.20, with plugin `{ microphonePermission: false }`, because
    `RECORD_AUDIO` is blocked in `app.config.ts:89-104` (ANDROID.md 2.7);
  - `expo-file-system` 57.0.7, to cache photos and read upload bodies;
  - optional: `expo-image-manipulator` 57.0.21 to shrink photos before upload, and
    `@react-native-community/datetimepicker` 9.1.0 for the target date (or "1 week / 2 weeks / 1
    month" chips and no package).

---

## 6. What syncs to the phone today, and what is missing

From `powersync/sync-config.yaml` (edition 3) and the registry `src/db/tables.ts`:

| Table | Stream (yaml line) | On the phone | Used by | Gap |
|---|---|---|---|---|
| `study_plans` | `user_owned:82`, `group_shared:103` | all columns | lists, detail | — |
| `plan_sources` | `plan_content:117` | all | detail, newest source (`added_at`) | — |
| `sources` | `user_owned:79`, `group_shared:101` | all (`status` pending/processing/ready/failed) | detail | no error text (use `tracy_events.error`) |
| `source_files` | `user_owned:81`, `group_shared:102` | all (`transcript`, `confirmed`, `storage_path`, `page`) | transcription review | image bytes come from Storage (network) |
| `source_chunks` | **never** (not in the publication, `:2151-2173`) | — | citation passage | **cards can't be traced to their source** (see A) |
| `topics` | `plan_content:118` | `plan_id`, `title`, `position` | outline | **no draft state** (see B) |
| `cards` | `plan_content:119` | `topic_id`, `plan_id`, `source_chunk_id`, `page`, `question`, `answer`, `card_type` | queue, browser | no `source_id` (see A) |
| `card_links` | `plan_content:120` | all | map | — |
| `card_states`, `reviews` | `user_private:55-56` | all | queue, stats, reminder | — |
| `tracy_events` | `user_private:60`, light columns only | `id, user_id, job, status, error, accepted, created_at, updated_at` | progress | **no link to a plan or source** (see C) |
| `profiles.fsrs_params` | `user_private` | yes | scheduler parameters | — |

### Proposed migration (one SQL Editor paste, 40 lines; tested)

The sibling draft `20261009120000_study_backend.sql` adds no public columns. Either fold this into it,
or ship it as `20261009130000_study_engine_columns.sql`.

```sql
-- A. cards.source_id: the card's source, DERIVED from source_chunk_id (never chosen by the phone), so the
--    phone can filter "newest source" and cite "p. 12, Lecture 3" without syncing source_chunks.
alter table public.cards
  add column source_id uuid references public.sources (id) on delete set null;
create index cards_source_id_idx on public.cards (source_id);

-- Runs after clear_source_chunk_reference (same event; triggers fire in name order), so a chunk the
-- writer may not read is already null here. security definer: the chunk may belong to a group member's
-- source. Like copy_source_ownership, it never copies back a value an ON DELETE SET NULL is clearing:
-- deleting a source cascades to its chunks and nulls cards.source_id in an undefined order.
create function public.copy_card_source_id()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then             -- never trust a sent source_id; null for a hand-made card
    new.source_id := (select sc.source_id from public.source_chunks sc where sc.id = new.source_chunk_id);
  elsif new.source_chunk_id is not null and new.source_chunk_id is distinct from old.source_chunk_id then
    new.source_id := (select sc.source_id from public.source_chunks sc where sc.id = new.source_chunk_id);
  elsif new.source_id is not null then
    new.source_id := old.source_id;    -- may be cleared (FK action, or the owner), never repointed
  end if;
  return new;
end $$;
create trigger copy_source_id
  before insert or update of source_chunk_id, source_id on public.cards
  for each row execute function public.copy_card_source_id();
revoke all on function public.copy_card_source_id() from public, anon, authenticated, service_role;

-- B. topics.status: draft (proposed by the study builder) -> confirmed (kept by the owner in outline
--    review; the worker makes its cards) -> ready. Hand-made topics are ready at once.
alter table public.topics
  add column status text not null default 'ready'
    check (status in ('draft', 'confirmed', 'ready'));

-- C. tracy_events: which plan and source a job is for, so the phone can show per-source progress and
--    errors. Server-written only (the device may update `accepted` alone), so no normalizing trigger.
alter table public.tracy_events
  add column plan_id uuid references public.study_plans (id) on delete set null,
  add column source_id uuid references public.sources (id) on delete set null;
create index tracy_events_plan_id_idx on public.tracy_events (plan_id);
create index tracy_events_source_id_idx on public.tracy_events (source_id);
```

**Tested.** The repo's `scripts/db-test.sh` was run on a scratch copy (Postgres 16.15 with
pgvector, pgTAP and uuid-ossp) holding:
- the migration above: `scratch/dbcopy/supabase/migrations/20261009130000_study_engine_columns.sql`;
- a new test file: `scratch/dbcopy/supabase/tests/15_study_engine_columns.test.sql`, 17 tests;
- the three `00_schema.test.sql` edits below.

Result: `all 15 test files passed (559 tests)`. Without the edits, `00_schema` fails tests 9, 21 and
22, exactly the pinned lists. The snapshot diff adds just `cards.source_id`, `topics.status` and
`tracy_events.plan_id` and `source_id`.

The new tests check:
- a worker insert derives `source_id` from the chunk and ignores a sent value;
- the status CHECK (23514);
- the owner can confirm a topic;
- a PATCH of `source_id` can't repoint it;
- a new chunk re-derives it, and an unreadable chunk is nulled first while `source_id` is kept;
- a hand-made card with a forged `source_id` stores null;
- `authenticated` can't write `tracy_events.plan_id` (42501);
- deleting a chunk keeps `source_id`, and deleting the source clears both **without failing**;
- deleting the plan nulls `tracy_events.plan_id`.

**Implications, item by item:**
- **Grants and RLS.** Nothing new.
  - `cards`, `topics`: table-level grants (`:2032-2039`) cover the new columns; the plan-owner
    policies (`:1599-1629`) already limit who writes.
  - `tracy_events`: `grant select` covers reading; `update (accepted)` stays the only device write
    (`:2055-2058`).
  - A plan owner may set any `topics.status`. The worker must build cards only for `confirmed`
    topics that have **zero** cards, then set `ready`, so flipping a topic back can't duplicate cards.
- **Tests that must change** (the edits that were run):
  - `00_schema.test.sql:85-91` (ON DELETE SET NULL list): add `'cards.source_id'`,
    `'tracy_events.plan_id'` and `'tracy_events.source_id'`.
  - `:221-227` (optional client-writable references): add `'cards.source_id'`.
  - `:245` (allowed trigger functions): `p.proname in ('copy_source_ownership',
    'copy_card_source_id')`.
  - Plus the new test file.
- **A known gap.** Suppose a chunk is deleted and the phone then re-sends an old PUT of that card.
  The INSERT half of the upsert re-derives from the (now nulled) chunk, so the card loses its source
  link. This needs a re-extraction racing an offline card edit; it is cosmetic (a citation title and
  the newest filter), not data loss.
- **Sync:**
  - `topics` and `cards` use `SELECT *`, so the new columns flow with no config change.
  - `tracy_events` uses an explicit list (`sync-config.yaml:60`). Add `plan_id, source_id`, add both
    to `TABLES.tracy_events` (`src/db/tables.ts:404`), which `src/db/__tests__/sync-config.test.ts`
    compares, then **redeploy the sync config**.
  - Add `status: 'text'` to `topics` and `source_id: 'uuid'` to `cards`, with an index
    `by_source: ['plan_id', 'source_id']`.
  - Run `npm run db:test` to regenerate `supabase/schema.snapshot.json` and keep the registry-drift
    test green.
- **Existing rows** (PowerSync docs, "Column Changes"): "Adding a column with a different default
  value … will not have this default automatically replicated for existing rows. To propagate this
  value, make an update to every existing row."
  - No study rows exist in production yet, so nothing to do.
  - The app still reads a missing `topics.status` as `'ready'` (`COALESCE`), and missing
    `source_id` and `plan_id` as unknown.
- **Group visibility:** members receive draft topics through `plan_content` (RLS lets them read
  them too). Hide `draft` and `confirmed` topics from non-owners in the UI. A filtered member query is
  possible but not needed before Phase 4.
- **Queue functions:** the sibling `enqueue_tracy_event(...)` (supabase.md section 5) would take
  `p_plan_id` and `p_source_id` and store them.
- **Worker triggers for offline confirmations:** the device cannot insert `tracy_events`. A
  confirmed transcript (`source_files.confirmed`) or confirmed topics reach the server by sync. Then
  either the `pg_cron` worker polls for them, or an AFTER UPDATE trigger enqueues a job. This is a
  sibling-track decision; it keeps both confirmations offline-OK.

**Considered and rejected:**
- `plan_sources.stage` for progress: device-writable, so the worker's state would race the phone's
  PATCHes.
- Syncing `source_chunks (id, source_id, page)` with a publication column list: about 1,000 rows per
  300-page PDF on every phone.
- `topics.source_id` instead of `cards.source_id`: topics can mix sources once Tracy "places its
  topics next to related ones".
- A `cards.created_at > plan_sources.added_at` heuristic for "newest": wrong when uploads overlap.

---

## 7. Open risks and things not verified

1. **ts-fsrs on a real Android build** (Metro plus Hermes on the device): **unverified**. It compiles
   on Hermes 1.0, and runs identically on Hermes 0.12 after a Babel class transform. Add the "FSRS
   check" row to the preview APK.
2. **Two offline devices** produce mixed `card_states` until PATCH uploads send full rows (1.6). That
   needs an `upload.ts` change and tests. The `reviews` log is never lost.
3. **Clock skew:** the clamp prevents the throw and the silently-skipped write. A phone clock that
   runs ahead still schedules early or late; there is no server time on the device.
4. **6.0 migration:** `fsrs()` deprecated, `elapsed_days` removed, `Date.prototype` patches removed.
   The proposed code only uses `elapsed_days` as the dummy in `toCardInput`, and computes
   `reviews.elapsed_days` itself.
5. **Typed matching** is a heuristic (false accepts like `mitochondrion` for `mitochondria`). It
   needs a test table and the **Count it as right** override.
   - `String.prototype.normalize` on Android Hermes is **unverified**; the code guards it.
   - Tracy's card output must follow the conventions: `;` between alternatives, short answers for
     typeable cards, and a cloze blank marker. Agree these with `tracy.md`'s `dualrep_build_cards`
     validator.
6. **Reminder text** goes stale if the user reviews on another device and never opens this phone.
   Inexact delivery without the exact-alarm permission is fine for a daily nudge.
7. **Schema:**
   - The proposed migration changes three pinned lists in `00_schema.test.sql` and the sync config.
   - It must be applied **before** the APK that reads the columns (the PowerSync order: database,
     sync config, then app).
   - It passed the repo's pgTAP harness locally (559 tests). Not yet run on the hosted Supabase
     project, and not yet combined with the sibling's `20261009120000_study_backend.sql`.
8. **Data growth:** `reviews` syncs down in full (an open ROADMAP decision). `insertOnly` exists in
   `@powersync/common` 2.3.1 (`Table.d.ts:11`), but per-block stats and the daily new count read
   `reviews` locally, so keep syncing it in Phase 2.
9. **`study_sessions.plan_id`** is normalized to null for an unreadable plan. The panel must not
   assume the plan still exists after a sync (handle the empty queue).
10. **Not looked at in depth:** on-the-go audio mode (the spike comes first, ANDROID.md 2.1–2.4) and
    the Phase 3 grader.

## Sources

- `ts-fsrs@5.4.2` tarball (`npm pack`): `dist/index.d.ts`, `dist/index.mjs`, `dist/index.umd.js`,
  `CHANGELOG.md`; GitHub: https://github.com/open-spaced-repetition/ts-fsrs
- `hermes-engine-cli@0.12.0` (npm), `hermes-compiler` in DualRep `node_modules` (Hermes 1.0.0)
- `expo-notifications` 57.0.22, `expo-crypto` 57.0.3, `@powersync/common` 2.3.1, `@powersync/react`
  2.0.2, `metro-config` 0.84.5, `@expo/config`, `jest-expo`: installed sources in
  `/home/user/DualRep/node_modules`
- PowerSync, "Implementing Schema Changes" (docs source on GitHub, fetched raw because
  docs.powersync.com is blocked):
  https://raw.githubusercontent.com/powersync-ja/powersync-docs/main/maintenance-ops/implementing-schema-changes.mdx
  ([rendered page](https://docs.powersync.com/maintenance-ops/implementing-schema-changes))
- PowerSync, deploying schema changes (search result):
  [docs.powersync.com/maintenance-ops/deploying-schema-changes](https://docs.powersync.com/maintenance-ops/deploying-schema-changes)
- DualRep: `docs/ROADMAP.md:273-327`, `docs/EXECUTION_PLAN.md:80-136, 291-323`,
  `docs/DATA_MODEL.md`, `docs/TRACY_INTEGRATION.md`, `docs/research/exercise-data-and-fsrs.md:210-394`,
  `docs/ANDROID.md:349-400, 488-523`, migration lines as cited, `powersync/sync-config.yaml`,
  `src/features/cycle/*`, `src/features/timer/notifications.ts`, `src/db/*`
