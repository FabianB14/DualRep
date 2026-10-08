# Exercise dataset and FSRS scheduling (research report)

> Research date: 2026-10-08. Reference copy of a Phase 0 research report, kept as background. Where it disagrees with the repo (migration, sync config, code) or with the guides in `docs/`, the repo and the guides win.
> The decisions taken from it are in [DECISIONS.md](../DECISIONS.md) and [DATA_MODEL.md](../DATA_MODEL.md).

The helper scripts used for this research (enum counts, the mapping heuristics, ts-fsrs probes) were throwaway tools and are not in this repo. The mapping rules in A6 are written out in full so the Phase 1 import script can implement them.

---

## Part A: yuhonas/free-exercise-db

### A1. Where the data comes from
- Download `dist/exercises.json` (1,005,327 bytes), `LICENSE.md`, `schema.json`, `README.md` and `Makefile` from `https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/...`.
- The analysed `exercises.json` has sha256 `5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf`.
- The repo page (https://github.com/yuhonas/free-exercise-db) shows the license as **Unlicense**.
- There is no `free-exercise-db` npm package. [`react-muscle-map@0.1.3`](https://www.npmjs.com/package/react-muscle-map) (Unlicense) mirrors the data, but it strips images and has 873 rows: the 876 upstream minus the 3 rows that have no images. Use upstream, not this mirror.
- The upstream commit SHA was not recorded (the GitHub API was not reachable during research). Pin the import by the sha256 above, or by a commit SHA.

### A2. License: is it the Unlicense, and does it cover the data and the images?
- **It is the Unlicense.** The text of [LICENSE.md](https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/LICENSE.md) is the standard Unlicense, word for word ("This is free and unencumbered software released into the public domain…", see https://unlicense.org). The README badge and the GitHub sidebar both say Unlicense, and the README calls the repo an "Open Public Domain Exercise Dataset".
- **It does not explicitly cover the data or the images.** The license text only ever says "this software … in source code form or as a compiled binary". Nothing in the repo mentions the JSON data, the instruction text or the photos. There is no separate notice for the images and no per-image attribution.
- **Where the content came from is the real problem.** The README says the data was restructured from [wrkout/exercises.json](https://raw.githubusercontent.com/wrkout/exercises.json/master/README.md). That repo uses the same Unlicense text and also gives no source for its images. In the one exercise I checked, the instruction text matches bodybuilding.com: a web search for the exact README sentence "Sit down on an incline bench with a dumbbell in each hand being held at arms length…" returns bodybuilding.com's "Alternate Incline Dumbbell Curl" page (https://bodybuilding.com/exercises/alternate-incline-dumbbell-curl). The paired 0.jpg/1.jpg start and end photos also look like that site's format. **Unverified:** bodybuilding.com could not be opened during research, so the pages and photos were not compared directly. An Unlicense dedication can only give away rights the authors actually hold.
- **Verdict on the plan's own check** ("Confirm that the dataset's license file covers both the data and the images before import"): **not met.**
- **Recommendation:**
  1. Import the structured fields now (name, muscles, equipment, level, force, mechanic, category). These are factual classifications and low risk.
  2. Do not ship the images or the verbatim `instructions` until someone signs off legally. Until then, write DualRep's own instruction text (Claude drafts it, a person reviews it) and source images that are clearly licensed, or make our own.
  3. Keep `origin='dataset'` and `dataset_id` on every row so the content can be swapped later.

### A3. JSON shape
`dist/exercises.json` is one top-level array. All 876 objects have exactly these 11 keys:
```jsonc
{
  "id": "Alternate_Incline_Dumbbell_Curl", // string, pattern ^[0-9a-zA-Z_-]+$, unique (0 duplicates)
  "name": "Alternate Incline Dumbbell Curl",// string, unique (case-insensitive, 0 duplicates)
  "force": "pull",                         // "static" | "pull" | "push" | null
  "level": "beginner",                     // "beginner" | "intermediate" | "expert" (never null)
  "mechanic": "isolation",                 // "isolation" | "compound" | null
  "equipment": "dumbbell",                 // 12 values or null (see A4)
  "primaryMuscles": ["biceps"],            // string[]: 875 rows have 1 item, 1 row has 2
  "secondaryMuscles": ["forearms"],        // string[]: 0 to 10 items, 272 rows empty
  "instructions": ["Sit down on ..."],     // string[]: 0 to 24 steps, 5 rows empty
  "category": "strength",                  // 7 values (never null)
  "images": ["Alternate_Incline_Dumbbell_Curl/0.jpg", "Alternate_Incline_Dumbbell_Curl/1.jpg"]
}
```
Quirks in [schema.json](https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/schema.json) (draft-04):
- `required` leaves out `force`, but every row has the key anyway.
- The arrays use the tuple form `items: [ {...} ]`, so the schema only checks the **first** element against the enum. My script checked every element: there are 0 values outside the enums.

Outliers:
- No images: `Kettlebell_Halo`, `Kettlebell_Halo_With_Overhead_Extension`, `Kettlebell_Overhead_Triceps_Extension`.
- No instructions: `Iron_Cross`, `One-Arm_Kettlebell_Swings`, `Push_Press`, `Side_Bridge`, `Side_Jackknife`.
- Two primary muscles: `Kettlebell_Halo_With_Overhead_Extension` (shoulders, triceps).
- 24 instruction steps: `Power_Clean`.

### A4. Every enum value, with counts (876 exercises)
| Field | Values (count) |
|---|---|
| force | pull 371, push 371, static 104, **null 30** |
| level | beginner 525, intermediate 294, expert 57 |
| mechanic | compound 491, isolation 298, **null 87** |
| equipment | barbell 170, dumbbell 123, other 122, body only 111, cable 81, **null 77**, machine 67, kettlebells 56, bands 20, medicine ball 17, exercise ball 12, foam roll 11, e-z curl bar 9 |
| category | strength 584, stretching 123, plyometrics 61, powerlifting 38, olympic weightlifting 35, strongman 21, cardio 14 |
| primaryMuscles (17 values; counts sum to 877) | quadriceps 148, shoulders 129, abdominals 93, chest 84, hamstrings 79, triceps 73, biceps 53, lats 38, middle back 34, calves 28, lower back 27, forearms 25, glutes 22, traps 15, adductors 13, neck 8, abductors 8 |
| secondaryMuscles (same 17 values) | glutes 220, shoulders 210, hamstrings 201, calves 181, triceps 148, lower back 104, forearms 94, traps 84, quadriceps 82, biceps 74, middle back 66, chest 63, abdominals 59, lats 56, adductors 41, abductors 35, neck 1 |

- **Total: 876.** The README says "800+".
- Of the 77 rows with null equipment, 62 are stretches. The other 15 are mostly bodyweight moves.

### A5. Images
- Image paths are always `<id>/<n>.jpg`. This held for all 1,746 paths. 873 exercises have exactly 2 images (0.jpg is the start position, 1.jpg the end) and 3 have none.
- They are hosted at `https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/<path>`, which is the README's own advice. I confirmed this with `Air_Bike/0.jpg`: HTTP 200, `image/jpeg`, `cache-control: max-age=300`, `access-control-allow-origin: *`.
- The images are progressive JPEGs at 850×567. A sample of 30 averaged about 54.5 KB, so all of them come to roughly **90 MB**.
- The public frontend (https://yuhonas.github.io/free-exercise-db/) resizes images through imagekit.io. The README also mentions 25 duplicate image files.
- **Recommendation**, only if the license is cleared:
  - Don't hotlink GitHub raw. It has a 5-minute cache, no SLA, and pulls from `main`, which can change.
  - Don't bundle the images in the APK either (about 90 MB).
  - Instead, copy them once into Supabase Storage as WebP at about 400 px, and let the app cache them on demand.

### A6. Mapping to DualRep's `exercises` columns
I tested every rule below against all 876 rows with a throwaway mapping script. The rules are ordered and the first match wins. All matching is case-insensitive and runs on `name`.

**Keep these extra columns.** The plan lists "key columns", but the import needs these too:
- `dataset_id text unique` (the upstream `id`; makes the import idempotent)
- `secondary_muscles text[]`
- `level text`, `mechanic text`, `force text`
- `dataset_category text`
- `instructions text[]` (only if cleared)
- `image_paths text[]` (only if cleared)
- `origin = 'dataset'` and `reviewed = false` on every seeded row

**name:** `trim(name)`.

**muscle_group:** `primaryMuscles[0]`, using the 17 dataset values as they are. The weekly review's "sets per muscle group" uses this column directly.

**equipment:** store it as **`text[]`** (the items the exercise needs), not a single value. The availability check is then `exercise.equipment <@ setup.equipment`.
1. Map the base value:
   - `body only` → `bodyweight`, `kettlebells` → `kettlebell`, `bands` → `band`
   - `exercise ball` → `stability_ball`, `foam roll` → `foam_roller`, `e-z curl bar` → `ez_bar`, `medicine ball` → `medicine_ball`
   - `barbell`, `dumbbell`, `cable` and `machine` stay the same.
2. If the value is `other` (122 rows) or null, refine it from the name. First match wins:
   - `strongman_implement` (atlas stone, keg, yoke, log lift, tire flip, axle, car deadlift, rickshaw, circus bell, conan)
   - `sled` (`\bsled\b`, prowler)
   - `trap_bar`, `battle_rope`, `jump_rope`
   - `suspension_trainer` (suspended, rings)
   - `climbing_rope`
   - `pull_up_bar` (pull-up, `\bchin`, hanging, muscle-up, otis, scapular pull)
   - `dip_station` ("dip" not preceded by "bench")
   - `weight_plate` (plate, wrist roller)
   - `ab_wheel`, `balance_board`
   - `cardio_machine` (stationary, elliptical, treadmill, recumbent, stairmaster, step mill)
   - `hyperextension_bench`
   - `box`
   - then band, dumbbell, kettlebell, barbell, cable, machine (smith, lever)
   - If nothing matches: null becomes `bodyweight` and `other` stays `other`.
3. If the category is `cardio` and the value is `machine`, use `cardio_machine`.
4. Add implied items:
   - `bench`, when the name matches bench, incline, decline, preacher, "seated … press" or "lying … (extension|curl|row|fly)" and the equipment isn't a machine or cable.
   - `rack`, for barbell squat, bench press, overhead press, military press or shoulder press.
   - `pull_up_bar`, for any pull-up, chin-up, hanging or muscle-up name, even when the dataset says "body only".
   - `dip_station`, for dips.
   - `rack`, for inverted row.
   - `box`, for box jump or step-up.
   - Then drop `bodyweight` if another item is present.

**location** (gym, home or both):
- `gym` if any item is gym-only: barbell, ez_bar, cable, machine, sled, strongman_implement, trap_bar, cardio_machine, hyperextension_bench, rack, battle_rope, climbing_rope, dip_station or other.
- `both` if every item is home-friendly: bodyweight, dumbbell, kettlebell, band, medicine_ball, stability_ball, foam_roller, pull_up_bar, bench, box, jump_rope, suspension_trainer, weight_plate, ab_wheel or balance_board.
- Dataset rows are never `home` alone, because anything you can do at home you can also do at a gym. Keep `home` for Interverse originals, such as desk-side moves.
- Real availability still comes from the user's `equipment_setups`.
- Result: both 462, gym 414.

**movement_pattern** (ordered rules, first match wins):
1. `mobility`: category is stretching, or the name matches stretch, SMR, foam roll, circles or mobility.
2. `core` (explicit list): Turkish get-up, Landmine 180, hanging pike, Wind Sprints (in this dataset it is an ab exercise), frog sit-up.
3. `conditioning`: category is cardio, OR (primary muscle is not abs, and the name doesn't contain "chest", and the name matches rope jumping, battling rope, sled push, prowler, burpee, mountain climber, jumping jack, sprint, shuttle, carioca, high knee, butt kick, bear crawl, `\bskip`, quick step, agility, cone hop, `\b(run|running|jog|jogging)\b`, star jump, hurdle hop or `bound\b`). Word boundaries matter here: without them "crunch" matches "run".
4. `carry`: farmer, carry, yoke walk, suitcase, waiter, `\bdrag\b` (not "drag curl"), sled walk, conan.
5. `lunge`: lunge, split squat, split jump, step-up, bulgarian, pistol, single-leg squat, skater, scissor.
6. `squat`: squat, leg press, hack, thruster, wall sit, sissy, box jump, jump squat, tuck jump. Exclude abs primary and names containing good morning, calf or jerk.
7. `hinge`: deadlift, good morning, romanian, RDL, stiff-leg, hip thrust, glute bridge, butt lift, pull-through, swing, hyperextension, back extension, clean, snatch, rack pull, glute-ham, kettlebell high pull, reverse hyper, atlas, keg load, sandbag load, tire flip.
8. `vertical_pull`: pull-up, `\bchin(s|-up|-ups)?\b`, pulldown, muscle-up, rope climb, london bridge. Exclude triceps and abs primaries. Without the `\b`, "chin" matches "ma**chin**e".
9. `horizontal_pull`: row, rowing, face pull, reverse fly, rear delt, inverted row, pull apart, `high pull\b`, sled row. Exclude upright rows.
10. `vertical_push`: overhead, shoulder or military press, push press, jerk, arnold, handstand, landmine press or jammer, "seated … press", "standing … press", dumbbell press, log lift, circus bell, dips, bradford, kettlebell press, seesaw, para press, cuban press. Exclude abs primary and names containing bench, chest, floor, leg press, calf, incline, decline, close-grip dumbbell or triceps press.
11. `horizontal_push`: bench press, push-up, chest press, floor press, fly/flye, crossover, pec deck, butterfly, svend, chest push or pass, incline/decline press, dumbbell press, board or pin press, close-grip press. The primary muscle must not be shoulders or a lower-body muscle. Also catch any row with chest primary and `force = push`.
12. `core`: abs primary, or crunch, sit-up, plank, leg raise, knee raise, rollout, russian twist, wood chop, pallof, side bridge, jackknife, v-up, flutter, dead bug, bird dog, hollow, superman, windmill, bicycle, oblique, twist.
13. Fallbacks:
    - Plyometrics with a lower-body primary → `conditioning`; other plyometrics → `other`.
    - Shoulders primary + compound + push → `vertical_push`.
    - Otherwise by primary muscle: chest → horizontal_push, quadriceps → squat, hamstrings or glutes → hinge, lats → vertical_pull, middle back → horizontal_pull, lower back → hinge, abdominals → core.
    - Anything left → `other`.

Result: other 201, mobility 123, hinge 108, horizontal_push 95, core 87, squat 58, vertical_push 57, conditioning 49, horizontal_pull 45, vertical_pull 27, lunge 18, carry 8. The `other` rows are almost all isolation work for biceps, triceps, forearms, delt raises, calves, traps, neck and adductors/abductors. For the location swap, match on **(movement_pattern, muscle_group)**. For `other` rows, match on muscle_group alone.

**body_region:**
- `cardio` if category is cardio or the pattern is conditioning.
- `full` if category is olympic weightlifting, the pattern is carry, or the name matches thruster, burpee, turkish get-up, man-maker, clean and press, tire flip, atlas, keg or sandbag load, or squat, split or power jerk.
- Otherwise by primary muscle:
  - lower back → `lower` if the pattern is hinge, else `core`
  - quadriceps, hamstrings, glutes, calves, adductors, abductors → `lower`
  - chest, shoulders, triceps, biceps, forearms, lats, middle back, traps, neck → `upper`
  - abdominals → `core`
- Result: upper 441, lower 228, core 104, full 54, cardio 49.
- For preset splits, I suggest counting a `full` row as half lower and half upper.

**category** (training type: strength, power, conditioning or mobility):
- `conditioning` if the movement pattern is conditioning.
- Otherwise: strength, powerlifting and strongman → `strength`; olympic weightlifting and plyometrics → `power`; cardio → `conditioning`; stretching → `mobility`.
- Keep the raw value in `dataset_category`.
- Result: strength 639, mobility 123, power 65, conditioning 49. Without the conditioning override, only 14 rows would be conditioning, too few to feed the "Mostly cardio" preset.

**demand_level** (smallint 1 to 3; checked in this order):
1. `1` for stretching or the mobility pattern.
2. `3` for olympic weightlifting, powerlifting or strongman.
3. `3` for level expert.
4. `3` for compound moves with a barbell or trap bar in the squat, hinge, lunge, horizontal_push or vertical_push patterns.
5. `3` for depth jump, drop jump, clap or plyo push-up.
6. `1` for isolation at beginner level.
7. `1` for the core pattern at beginner level.
8. `1` for neck primary or a foam roller.
9. Otherwise `2`.

Result: 1 = 353, 2 = 355, 3 = 168. The "hard study, then heavy lifting" rule (don't auto-swap heavy lifts; trim conditioning and volume) can key on `demand_level = 3`.

**micro_ok:** true only if all of these hold:
- location is `both`
- demand ≤ 2 and level is not expert
- every equipment item is in {bodyweight, band, dumbbell, kettlebell, jump_rope, pull_up_bar, stability_ball, bench, box}
- the name doesn't match partner, assisted, spotter, throw, toss, slam, wall ball or against wall
- the row has images and instructions
- the primary muscle is not neck
- it is not a foam-roller mobility move

Result: 375 true, of which 77 are mobility, 49 core, 39 horizontal_push, 28 hinge, 25 vertical_push, 19 conditioning, 16 squat, 14 horizontal_pull, 11 vertical_pull, 9 lunge and 88 other.

**Spot checks:**
| Exercise | equipment | location | movement_pattern | body_region | demand | micro_ok |
|---|---|---|---|---|---|---|
| Pullups | [pull_up_bar] | both | vertical_pull | upper | 2 | true |
| Barbell Squat | [barbell, rack] | gym | squat | lower | 3 | false |
| Goblet Squat | [kettlebell] | both | squat | lower | 2 | true |
| Farmer's Walk | [other] | gym | carry | full | 3 | false |
| Rope Jumping | [jump_rope] | both | conditioning | cardio | 2 | true |
| Plank | [bodyweight] | both | core | core | 1 | true |
| Dips – Triceps Version | [dip_station] | gym | vertical_push | upper | 2 | false |

**Residual error:** the rules still put a few dozen rows in debatable spots. Examples: upright rows and raises land in `other`; Farmer's Walk is `other` equipment; one row ("Bodyweight Flyes") is labelled `e-z curl bar` in the dataset itself. This is fine because every seeded row imports with `reviewed=false`, and Tracy only picks reviewed rows. Have a person review the output, starting with `other` and `gym`.

---

## Part B: FSRS with ts-fsrs

### B1. Package facts
- The `latest` dist-tag is **5.4.2**, published 2026-09-01. License is MIT.
- `FSRSVersion` is `"v5.4.2 using FSRS-6.0"`, with **21 weights**.
- `beta` is **6.0.0-beta.13** (2026-10-03). It has big breaking changes:
  - `fsrs()`/`FSRS` are deprecated in favour of a `Scheduler`.
  - `afterHandler` is removed.
  - The `Card.elapsed_days`, `ReviewLog.elapsed_days` and `last_elapsed_days` fields are removed.
  - The `Date.prototype` extensions and the `fix*` helpers are removed.
  - FSRS-7 is added.
- **Pin `ts-fsrs@5.4.2`** and design the columns so they still work on 6.0. Source: `CHANGELOG.md` in both tarballs (https://github.com/open-spaced-repetition/ts-fsrs).
- Searching the 5.4.2 dist for BigInt, structuredClone, Intl, regex lookbehind, `.at(` and `Object.hasOwn` found nothing, so it should be safe on Hermes. **I have not run it on an Android device.**

### B2. Exact API (from `dist/index.d.ts`, checked by running it)
```ts
enum State  { New = 0, Learning = 1, Review = 2, Relearning = 3 }
enum Rating { Manual = 0, Again = 1, Hard = 2, Good = 3, Easy = 4 }
type Grade = Exclude<Rating, Rating.Manual>;       // Grades = [1,2,3,4]

interface Card {
  due: Date; stability: number; difficulty: number;
  /** @deprecated removed in 6.0 */ elapsed_days: number;
  scheduled_days: number; learning_steps: number;
  reps: number; lapses: number; state: State; last_review?: Date;
}
interface ReviewLog {
  rating: Rating; state: State; due: Date; stability: number; difficulty: number;
  /** @deprecated */ elapsed_days: number; /** @deprecated */ last_elapsed_days: number;
  scheduled_days: number; learning_steps: number; review: Date;
}
type RecordLogItem = { card: Card; log: ReviewLog };
interface FSRSParameters {
  request_retention: number;  // default 0.9
  maximum_interval: number;   // default 36500
  w: number[];                // default_w (21 numbers)
  enable_fuzz: boolean;       // default false
  enable_short_term: boolean; // default true
  learning_steps: StepUnit[]; // default ['1m','10m']
  relearning_steps: StepUnit[]; // default ['10m']
}
function createEmptyCard<R = Card>(now?: DateInput, afterHandler?: (c: Card) => R): R;
const generatorParameters: (props?: Partial<FSRSParameters>) => FSRSParameters;
const fsrs: (params?: Partial<FSRSParameters>) => FSRS;   // there is no export named "scheduler"
class FSRS {
  repeat(card: CardInput | Card, now: DateInput): IPreview;  // all 4 outcomes; keys "1".."4", iterable
  next(card: CardInput | Card, now: DateInput, grade: Grade): RecordLogItem;
  get_retrievability(card, now?, format?: boolean): string | number;
  rollback(card, log: ReviewLogInput): Card;
  forget(card, now, reset_count?): RecordLogItem;
  reschedule(current_card, reviews?: FSRSHistory[], options?): { collections: RecordLogItem[]; reschedule_item: RecordLogItem | null };
}
type DateInput = Date | number | string;  // CardInput.state also accepts 'New' | 'Learning' | 'Review' | 'Relearning'
```

**What the probe showed:**
- **First review of a new card:**

  | Rating | Next state | Due in | Stability |
  |---|---|---|---|
  | Again | Learning | 1 min | 0.212 |
  | Hard | Learning | 6 min | 1.2931 |
  | Good | Learning | 10 min | 2.3065 |
  | Easy | Review | 8 days | 8.2956 |

- **DB rows work as input.** `next()` accepts a database row with ISO strings for `due`/`last_review` and the string `'Review'` for `state`. The result is identical to passing `Date` objects. Extra fields such as `id` and `user_id` pass through to the returned card.
- **Input `elapsed_days` is ignored.** `init()` recomputes it from `last_review` using **UTC calendar days** (`dateDiffInDays` calls `getUTC*`). So there is no need to store it on the card state.
- **`ReviewLog` holds values from *before* the review.** Its `state`, `stability`, `difficulty`, `scheduled_days` and `learning_steps` are all pre-review. `log.due` is `last_review ?? due` of the *previous* card, not its previous due date. Any column that needs the after-review values must take them from `RecordLogItem.card`.
- **`rollback()` is not an exact inverse in 5.4.2.** In my test the restored `due` was the review time (`…09:11`), not the original due (`…09:10`). 6.0.0-beta.9 says it fixes this. **Don't build undo on `rollback()` in v5.**
- **`reschedule()` replays history exactly.** Replaying `[Good@t0, Good@t0+10m, Again@due+1m]` from an empty card produced the same card as applying the three reviews one by one. So the review log alone is enough to rebuild state.
- **Fuzz is deterministic.** The seed is `${review_time}_${reps}_${D*S}`, and identical inputs gave identical fuzzed dates. That means the server can reproduce client results, so turning on `enable_fuzz: true` is safe.

### B3. Recommendation: keep `reviews` as an append-only log and add a separate `card_states` table
**Why:**
1. **Shared group cards need per-user state somewhere other than `cards`.** Group members share `cards`, but each person's schedule is private (plan: "Each person's review history and schedule stay their own"). Putting `card_states` and `reviews` in the per-user sync bucket keeps quiz performance private by default, with no extra RLS logic.
2. **The due list must be a cheap indexed query on the phone:** `SELECT … FROM card_states WHERE user_id=? AND due<=? ORDER BY due LIMIT n`. Without `card_states`, the app would need a "latest review per card" query over a growing log, run inside PowerSync's JSON-view tables. New cards would be an anti-join (`cards LEFT JOIN card_states … WHERE s.id IS NULL`).
3. **This fits how PowerSync handles writes.** The conflict-handling docs say:
   - The default is last-write-wins per field, in the order the server receives writes.
   - PATCH carries only the changed columns.
   - Deletes win.
   - The client never resolves conflicts itself.
   - Upload handlers should be idempotent and return 2xx rather than 4xx, because a 4xx blocks the queue.

   Sources: https://docs.powersync.com/handling-writes/handling-update-conflicts and https://docs.powersync.com/handling-writes/custom-conflict-resolution (search excerpts only; docs.powersync.com could not be opened). Inserts into the append-only log can never conflict, since ids are made on the device and duplicates are ignored. `card_states` is only ever written by its owner, so it can only conflict when the same user reviews the same card on two devices while offline.
4. **The log is still needed** for FSRS parameter optimisation, the weekly Analyst SQL, auditing, and rebuilding state after that two-device case (via `reschedule()`).

**Key design rules:**
- **`card_states.id` = UUIDv5(`user_id:card_id`, a fixed DualRep namespace), computed on the device.** If two offline devices both start the same card, they produce the *same* id. The second upload then merges into the first row instead of hitting the `(user_id, card_id)` unique constraint, which would fail the upload and stall the queue. I checked `uuid@14.0.2`: its v5 uses a pure-JS SHA-1, so it needs no native crypto. v4 does need `crypto.getRandomValues`; use `expo-crypto` for that.
- **Only accept newer state on the server.** Add a BEFORE UPDATE trigger that skips any write whose `last_review` is older than the stored one. A skipped row still returns 2xx. The log keeps both reviews, so a later job can rebuild the lost one.
- **Write each review in one local `writeTransaction`:** insert the `reviews` row, then update or insert `card_states`. Use a select followed by UPDATE or INSERT, because I could not confirm that SQLite `ON CONFLICT` works on PowerSync's view-backed tables. The two writes upload as one CRUD transaction. Phase 0 can use the stock Supabase connector, which upserts on PUT, runs `.update(opData).eq('id')` on PATCH, and deletes on DELETE (https://docs.powersync.com/integrations/supabase/connector-performance). Later, move to a Postgres RPC or Edge Function that applies the whole transaction at once, as PowerSync's Supabase tutorial suggests.
- **Undo:** use a short grace period before the rating is committed, or rebuild state by replaying the log. Don't use v5 `rollback()`.

**Postgres (first migration):**
```sql
create table public.card_states (
  id             uuid primary key,          -- uuidv5(user_id||':'||card_id), made on device
  user_id        uuid not null references auth.users(id) on delete cascade,
  card_id        uuid not null references public.cards(id) on delete cascade,
  state          smallint not null default 0 check (state between 0 and 3),   -- ts-fsrs State
  due            timestamptz not null,
  stability      double precision not null default 0 check (stability >= 0),
  difficulty     double precision not null default 0 check (difficulty between 0 and 10),
  scheduled_days integer not null default 0 check (scheduled_days >= 0),
  learning_steps integer not null default 0 check (learning_steps >= 0),
  reps           integer not null default 0 check (reps >= 0),
  lapses         integer not null default 0 check (lapses >= 0),
  last_review    timestamptz,
  suspended      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, card_id)
);
create index card_states_user_due_idx on public.card_states (user_id, due);

create table public.reviews (               -- append-only: no UPDATE/DELETE policies
  id             uuid primary key,          -- uuid v4, made on device
  user_id        uuid not null references auth.users(id) on delete cascade,
  card_id        uuid not null references public.cards(id) on delete cascade,
  rating         smallint not null check (rating between 1 and 4),            -- ts-fsrs Grade
  answer_mode    text not null check (answer_mode in ('typed','spoken','handwritten','self_graded')),
  reviewed_at    timestamptz not null,                                       -- ReviewLog.review
  duration_ms    integer check (duration_ms >= 0),
  prev_state     smallint not null check (prev_state between 0 and 3),       -- ReviewLog.state (before)
  elapsed_days   integer not null,                                           -- days since previous review
  -- plan's columns = result AFTER this review (RecordLogItem.card), not ReviewLog's pre-values:
  state          smallint not null check (state between 0 and 3),
  due_at         timestamptz not null,
  stability      double precision not null,
  difficulty     double precision not null,
  scheduled_days integer not null,
  created_at     timestamptz not null default now()
);
create index reviews_user_card_time_idx on public.reviews (user_id, card_id, reviewed_at);
create index reviews_user_time_idx on public.reviews (user_id, reviewed_at);

create function public.card_states_guard() returns trigger language plpgsql as $$
begin
  if old.last_review is not null and (new.last_review is null or new.last_review < old.last_review) then
    return null;               -- stale write from a second offline device: skip, still 2xx
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger card_states_guard before update on public.card_states
  for each row execute function public.card_states_guard();
```

**RLS (on both tables):**
- `card_states`: select, update and delete allowed `using (user_id = (select auth.uid()))`. Insert requires `with check (user_id = (select auth.uid()) and public.can_read_card(card_id))`.
- `reviews`: select and insert policies only, no update or delete.
- For `reviews` PUTs, the connector should use `upsert(rec, { onConflict: 'id', ignoreDuplicates: true })`, which becomes `ON CONFLICT DO NOTHING`. That way retried uploads are harmless. My understanding is that `DO NOTHING` needs only the INSERT policy (https://www.postgresql.org/docs/current/sql-createpolicy.html); I did not test this here.
- Store per-user FSRS settings as `profiles.fsrs_params jsonb` (null means use the defaults). Pass them through `generatorParameters` and `checkParameters`.

**PowerSync client schema** (column types are only TEXT, INTEGER or REAL, and `indexes` uses the shorthand; both confirmed in the `@powersync/common@2.3.1` type definitions):
```ts
const card_states = new Table({
  user_id: column.text, card_id: column.text, state: column.integer, due: column.text,
  stability: column.real, difficulty: column.real, scheduled_days: column.integer,
  learning_steps: column.integer, reps: column.integer, lapses: column.integer,
  last_review: column.text, suspended: column.integer, created_at: column.text, updated_at: column.text,
}, { indexes: { user_due: ['user_id', 'due'], card: ['card_id'] } });
const reviews = new Table({
  user_id: column.text, card_id: column.text, rating: column.integer, answer_mode: column.text,
  reviewed_at: column.text, duration_ms: column.integer, prev_state: column.integer, elapsed_days: column.integer,
  state: column.integer, due_at: column.text, stability: column.real, difficulty: column.real,
  scheduled_days: column.integer, created_at: column.text,
}, { indexes: { card_time: ['card_id', 'reviewed_at'] } });
```
- **Buckets:** put `card_states` and `reviews` in a per-user bucket (`… WHERE user_id = bucket.user_id`), and cards in one bucket per group.
- **Sync rules may not allow JOINs.** As I understand it, PowerSync's data queries can't join tables, but I couldn't check the current docs. If that's right, `cards` (and probably `topics`) need a denormalised `plan_id` and/or `group_id` column in the **first migration** for group buckets to work. *(Resolved in the repo: Sync Streams allow joins and subqueries in filters, and `cards` and `card_links` carry a trigger-copied `plan_id`; see [DATA_MODEL.md](../DATA_MODEL.md).)*
- **Timestamps:** turn on the `timestamps_iso8601` compatibility option (edition ≥ 2) with millisecond precision, so synced `due` text matches the client's `toISOString()` format and sorts correctly in SQLite. See https://docs.powersync.com/sync/types and https://docs.powersync.com/sync/advanced/compatibility (search excerpts only). *(Resolved in the repo: the sync config uses `edition: 3` with `timestamp_max_precision: milliseconds`.)*
- **Android dependency:** `@powersync/react-native@2.3.1` has a peer dependency on `@op-engineering/op-sqlite >=17.1 <19`. It needs an Expo dev build, not Expo Go.
- **Optional:** PowerSync supports `insertOnly` tables, which upload writes but never download rows. Use this for `reviews` later if device storage grows. For Phase 0, sync `reviews` down normally so the offline-to-Postgres gate is easy to check.

## Open risks
- The license on free-exercise-db does not cover the data or images: LICENSE.md is the standard Unlicense, which only mentions 'software', and nothing in the repo addresses the JSON data or photos. The instruction text in one checked exercise matches bodybuilding.com (found via search; the site is blocked here, so not compared directly). The plan's check 'license covers data and images' is NOT met. Someone needs to decide legally before shipping the images or verbatim instructions.
- The movement_pattern, location, demand_level and micro_ok values come from name-matching heuristics. 201 rows end up as 'other' (mostly isolation lifts) and a few dozen are debatable. Every seeded row must import with reviewed=false and be checked by a person before Tracy can use it.
- Images are about 90 MB, served from raw.githubusercontent.com on the moving 'main' branch with a 5-minute cache. Don't hotlink them. If the license is cleared, copy them to Supabase Storage and pin the import by the sha256 of exercises.json (5bb747e3...). I could not get the commit SHA because the GitHub API is blocked.
- ts-fsrs 6.0 (now in beta) breaks the API: fsrs()/FSRS deprecated, elapsed_days fields removed, afterHandler removed, FSRS-7 added. Pin 5.4.2. The proposed schema already avoids storing elapsed_days on card_states.
- ts-fsrs 5.4.2 rollback() does not restore the original due date (seen in testing). Build undo on a grace period or on replaying the log with reschedule(), not on rollback().
- If one user reviews the same card on two offline devices, card_states keeps only the newer write (via the trigger). The review log keeps both, but card_states needs a server job that replays the log with ts-fsrs. Running ts-fsrs in a Supabase Edge Function via npm: is not verified.
- docs.powersync.com could not be opened during research. The claims about last-write-wins per field, PATCH carrying only changed columns, the timestamps_iso8601 setting, insertOnly tables, JOINs not being allowed in sync rules, and the Supabase connector pattern come from search excerpts, package type definitions, and my memory. Check them against the live docs before the first migration, especially the possible need for plan_id/group_id on cards and topics.
- Two things are not yet tested: (1) whether a BEFORE UPDATE trigger returning NULL quietly skips the update for supabase-js upserts (INSERT ... ON CONFLICT DO UPDATE), and (2) whether SQLite UPSERT works on PowerSync's view-backed tables. Prove both in Phase 0 tests.
- ts-fsrs counts elapsed days by UTC calendar day, not local midnight, so reviews near UTC midnight count as a new day. Use the user's local time when deciding what counts as 'due today'.
- ts-fsrs 5.4.2 uses no obviously Hermes-unsafe APIs, but it has not been run on an Android device yet. Include it in the Phase 0 Android dev-build smoke test.
