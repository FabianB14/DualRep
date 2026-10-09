/**
 * Default circuits: the move block DualRep builds on the phone, with no network and no model, from the
 * focus preset's split, the setup in use (location and equipment), the minutes available and the
 * library. In Phase 3 Tracy's transition planner proposes circuits of the same shape (Circuit in
 * types.ts); this builder stays as the offline fallback.
 *
 * buildDefaultCircuit is pure and deterministic: the same input gives the same circuit, whatever the
 * order of the library (candidates are taken in id order). `variant` (for example the day number)
 * rotates the choices, so a week of study days does not repeat one circuit.
 *
 * TIME MODEL
 * - Work: a rep takes 3 s and a timed set takes its seconds (workSeconds in prescription.ts).
 * - A circuit's estimated length is the sum over its items of sets × (work + rest after each set).
 *   The rest after the very last set counts too: in the loop it rolls into the next focus block.
 * - Micro (5 to 15 minutes): stations of a 50 s slot each (about 40 s of work, then the rest of the
 *   slot to change over; prescription.ts sets the reps or seconds and fills the slot), done
 *   round-robin: every station once, then the next round.
 *     rounds   = 2 below 8 minutes, else 3
 *     stations = round(minutes × 60 / (50 × rounds)), at least 1
 *   So 5 min → 3 stations × 2 rounds, 10 → 4 × 3 and 15 → 6 × 3: exactly 6, 12 and 18 slots of 50 s.
 * - Full (30, 45 or 60 minutes): straight sets, 3 per exercise, 120 s of rest after heavy (demand 3)
 *   sets and 60 s otherwise. One exercise then takes about 4.5 to 7 minutes, so the number of
 *   exercises is searched: every count from 3 below to 3 above minutes × 60 / 300 is built, and the
 *   one whose estimate is closest to the minutes available wins (a tie goes to fewer exercises).
 *   Warm-up sets are not modelled.
 *
 * ALLOCATION (stations to the split's regions)
 * - Each region's share is split% × stations. A region first gets the whole part of its share; the
 *   stations left over go one each to the largest fractional remainders (largest-remainder rounding),
 *   ties in SPLIT_REGIONS order (lower, upper, core, cardio). A region at 0% never gets a station.
 *   Example: Mostly lower (70/15/15/0) with 4 stations → shares 2.8/0.6/0.6/0 → lower 2, then the two
 *   stations left go to lower (.8) and upper (.6, before core in the tie) → lower 3, upper 1, core 0.
 * - A split that does not add up to 100 is read as shares of its own total (negative or non-numeric
 *   values as 0); a split with no positive share at all is read as even across the four regions.
 *
 * CHOOSING EXERCISES
 * - Candidates are exercises that fit the setup (fitsSetup in equipment.ts). Micro also needs microOk
 *   and demand ≤ 2 (unknown demand counts as 2). The library passed in should already be filtered with
 *   eligibleForDefaultCircuits (library.ts; it needs the user id). The builder re-checks the part it
 *   can see without the user id, so an unreviewed library row never gets in. No exercise is used twice.
 * - Within a region, stations rotate through its patterns, starting at `variant`:
 *   lower: squat, hinge, lunge; upper: horizontal push, horizontal pull, vertical push, vertical pull;
 *   core: core; cardio: conditioning.
 * - A station takes an exercise of its pattern. When none is left it falls back, in order: the
 *   region's other patterns (in rotation order) → any exercise of the region (a full-body carry counts
 *   for lower and upper; mobility moves last) → any bodyweight core or conditioning exercise
 *   (conditioning first for a cardio station). A station that still finds nothing is left out; with
 *   the starter library that never happens (__tests__/circuits.test.ts checks every preset and setup).
 * - Within a step, candidates are in id order and the pick rotates with `variant` plus the number of
 *   times the station's pattern already came up in this circuit. A full session first narrows the
 *   step to the best tier: the first station of a strength pattern takes a heavy lift (demand 3) while
 *   the session has fewer than 2; then demand 2 with equipment (dumbbells, machines, a pull-up bar),
 *   demand 2 with none, demand 1; more heavy lifts only as a last resort. A micro circuit rotates
 *   through all its candidates alike, so a home setup with gear still mixes in bodyweight moves.
 *
 * ORDER
 * - Micro: each region's stations are spread evenly through the round (station k of a region's n sits
 *   at (k + ½) / n; ties in SPLIT_REGIONS order), so the same body part rarely comes twice in a row.
 * - Full: heavy lifts first, then the other strength patterns, then carries and other moves, then core,
 *   conditioning and mobility; within a group harder before easier, then in the order chosen.
 */
import { fitsSetup } from './equipment';
import { defaultTargets, demandOf, PRESCRIPTION, workSeconds } from './prescription';
import {
  SPLIT_REGIONS,
  type Circuit,
  type CircuitItem,
  type LibraryExercise,
  type MovementPattern,
  type SetupLocation,
  type Split,
  type SplitRegion,
  type WorkoutKind,
} from './types';

export const CIRCUIT_RULES = {
  /** Micro circuits of this many minutes or more get 3 rounds; shorter ones 2. */
  microThreeRoundsFromMinutes: 8,
  /** A first guess of a full-session exercise's length (3 sets with rest), for the count search. */
  fullSecondsPerExerciseGuess: 300,
  /** How far the count search looks on each side of the guess. */
  fullSearchSpread: 3,
  /** Heavy lifts (demand 3) a full session picks on purpose. */
  maxHeavyPerFull: 2,
} as const;

/** The movement patterns each split region rotates through, in rotation order. */
export const REGION_PATTERNS: Readonly<Record<SplitRegion, readonly MovementPattern[]>> = {
  lower: ['squat', 'hinge', 'lunge'],
  upper: ['horizontal_push', 'horizontal_pull', 'vertical_push', 'vertical_pull'],
  core: ['core'],
  cardio: ['conditioning'],
};

/** The patterns whose first station in a full session may take a heavy lift. */
const STRENGTH_PATTERNS: readonly MovementPattern[] = [
  'squat',
  'hinge',
  'lunge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
];

export type CircuitSetup = { location: SetupLocation; equipment: readonly string[] };

export type BuildCircuitInput = {
  split: Split;
  location: SetupLocation;
  /** The setup's equipment (bodyweight is implicit). */
  equipment: readonly string[];
  /** Micro: 5, 10 or 15. Full: 30, 45 or 60. */
  minutes: number;
  kind: WorkoutKind;
  /** What the builder may pick from: the eligible library (useLibrary().circuitPool). */
  library: readonly LibraryExercise[];
  /** Rotates the choices, e.g. the day number. Same variant, same circuit. Default 0. */
  variant?: number;
};

/** a mod n, never negative. */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function byId(a: LibraryExercise, b: LibraryExercise): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True when the exercise needs no equipment at all. */
export function isBodyweightOnly(exercise: Pick<LibraryExercise, 'equipment'>): boolean {
  return exercise.equipment.every((item) => item === 'bodyweight');
}

/** Whether an exercise of this body region can fill a station of the split region (full counts for both halves). */
export function servesRegion(exercise: Pick<LibraryExercise, 'bodyRegion'>, region: SplitRegion): boolean {
  if (exercise.bodyRegion === region) return true;
  return exercise.bodyRegion === 'full' && (region === 'lower' || region === 'upper');
}

/**
 * Whether the builder (and the swap) may put this exercise into a circuit of this kind with this
 * setup: it fits the setup, a micro circuit also needs microOk and demand ≤ 2, and a library row must
 * be reviewed (the rest of eligibleForDefaultCircuits needs the user id; callers filter with it).
 */
export function isCircuitCandidate(exercise: LibraryExercise, kind: WorkoutKind, setup: CircuitSetup): boolean {
  if (exercise.origin !== 'user' && !exercise.reviewed) return false;
  if (!fitsSetup(exercise, setup)) return false;
  return kind === 'full' || (exercise.microOk && demandOf(exercise) <= 2);
}

/** The candidates in id order, each id once (the first copy wins). */
export function candidatePool(
  library: readonly LibraryExercise[],
  kind: WorkoutKind,
  setup: CircuitSetup,
): LibraryExercise[] {
  const seen = new Set<string>();
  const pool: LibraryExercise[] = [];
  for (const exercise of library) {
    if (seen.has(exercise.id)) continue;
    seen.add(exercise.id);
    if (isCircuitCandidate(exercise, kind, setup)) pool.push(exercise);
  }
  return pool.sort(byId);
}

/** Stations and rounds of a micro circuit of this length (see TIME MODEL in the header). */
export function microShape(minutes: number): { stations: number; rounds: number } {
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  const rounds = safe < CIRCUIT_RULES.microThreeRoundsFromMinutes ? 2 : 3;
  const stations = Math.max(1, Math.round((safe * 60) / (PRESCRIPTION.micro.slotSeconds * rounds)));
  return { stations, rounds };
}

/** How many stations each region gets (largest-remainder rounding; see ALLOCATION in the header). */
export function allocateStations(split: Split, stations: number): Record<SplitRegion, number> {
  const n = Number.isFinite(stations) && stations > 0 ? Math.floor(stations) : 0;
  const shares = SPLIT_REGIONS.map((region) => {
    const value = split[region];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const weights = shares.some((share) => share > 0) ? shares : SPLIT_REGIONS.map(() => 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // share × n / total, kept as numerator and whole part so remainders compare exactly for whole numbers.
  const counts = weights.map((weight) => Math.floor((weight * n) / total));
  const remainders = weights.map((weight, index) => weight * n - counts[index] * total);
  let left = n - counts.reduce((sum, count) => sum + count, 0);
  const order = SPLIT_REGIONS.map((_, index) => index)
    .filter((index) => weights[index] > 0)
    .sort((a, b) => remainders[b] - remainders[a] || a - b);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) counts[order[k]] += 1;
  return { lower: counts[0], upper: counts[1], core: counts[2], cardio: counts[3] };
}

/** Estimated seconds for these items: sets × (work + rest), summed (see TIME MODEL in the header). */
export function estimateCircuitSeconds(items: readonly CircuitItem[]): number {
  return items.reduce((sum, item) => sum + item.sets * (workSeconds(item) + item.restSeconds), 0);
}

/** A circuit item for an exercise, with the default targets for the workout kind. */
export function circuitItemFor(
  exercise: LibraryExercise,
  region: SplitRegion,
  kind: WorkoutKind,
  sets: number,
): CircuitItem {
  return {
    exerciseId: exercise.id,
    name: exercise.name,
    measure: exercise.measure,
    movementPattern: exercise.movementPattern,
    region,
    sets,
    ...defaultTargets(exercise, kind),
  };
}

type Slot = {
  region: SplitRegion;
  pattern: MovementPattern;
  /** How many earlier stations of this circuit had the same pattern. */
  occurrence: number;
};

type Choice = { slot: Slot; exercise: LibraryExercise; order: number };

/** Every region's stations in SPLIT_REGIONS order, each region rotating through its patterns from `variant`. */
function planSlots(counts: Record<SplitRegion, number>, variant: number): Slot[] {
  const slots: Slot[] = [];
  const seen = new Map<MovementPattern, number>();
  for (const region of SPLIT_REGIONS) {
    const patterns = REGION_PATTERNS[region];
    for (let j = 0; j < counts[region]; j += 1) {
      const pattern = patterns[mod(variant + j, patterns.length)];
      const occurrence = seen.get(pattern) ?? 0;
      seen.set(pattern, occurrence + 1);
      slots.push({ region, pattern, occurrence });
    }
  }
  return slots;
}

/** The patterns after `pattern` in the list's rotation order (wrapping), without `pattern` itself. */
export function otherPatternsAfter(
  patterns: readonly MovementPattern[],
  pattern: MovementPattern | null,
): MovementPattern[] {
  const start = pattern === null ? -1 : patterns.indexOf(pattern);
  const rotated = start < 0 ? [...patterns] : [...patterns.slice(start + 1), ...patterns.slice(0, start)];
  return rotated.filter((other) => other !== pattern);
}

/** Who may fill a station, step by step (see CHOOSING EXERCISES in the header). */
function slotSteps(slot: Slot): ((exercise: LibraryExercise) => boolean)[] {
  const { region, pattern } = slot;
  const [first, second]: MovementPattern[] = region === 'cardio' ? ['conditioning', 'core'] : ['core', 'conditioning'];
  return [
    (exercise) => exercise.movementPattern === pattern,
    ...otherPatternsAfter(REGION_PATTERNS[region], pattern).map(
      (other) => (exercise: LibraryExercise) => exercise.movementPattern === other,
    ),
    (exercise) => servesRegion(exercise, region) && exercise.movementPattern !== 'mobility',
    (exercise) => servesRegion(exercise, region),
    (exercise) => isBodyweightOnly(exercise) && exercise.movementPattern === first,
    (exercise) => isBodyweightOnly(exercise) && exercise.movementPattern === second,
  ];
}

/** A full session's preference among a step's candidates: lower tiers win (see the header). */
function fullTier(exercise: LibraryExercise, slot: Slot, primary: boolean, heavyCount: number): number {
  const demand = demandOf(exercise);
  if (demand === 3) {
    const anchor =
      primary &&
      slot.occurrence === 0 &&
      STRENGTH_PATTERNS.includes(slot.pattern) &&
      heavyCount < CIRCUIT_RULES.maxHeavyPerFull;
    return anchor ? 0 : 4;
  }
  if (demand === 2) return isBodyweightOnly(exercise) ? 2 : 1;
  return 3;
}

/** Fills each station with an unused exercise, in station order; a station with nothing left is left out. */
function fillSlots(
  slots: readonly Slot[],
  pool: readonly LibraryExercise[],
  kind: WorkoutKind,
  variant: number,
): Choice[] {
  const used = new Set<string>();
  const picks: Choice[] = [];
  let heavyCount = 0;
  for (const slot of slots) {
    const steps = slotSteps(slot);
    for (let step = 0; step < steps.length; step += 1) {
      let candidates = pool.filter((exercise) => !used.has(exercise.id) && steps[step](exercise));
      if (candidates.length === 0) continue;
      if (kind === 'full') {
        const tiers = candidates.map((exercise) => fullTier(exercise, slot, step === 0, heavyCount));
        const best = Math.min(...tiers);
        candidates = candidates.filter((_, index) => tiers[index] === best);
      }
      const exercise = candidates[mod(variant + slot.occurrence, candidates.length)];
      used.add(exercise.id);
      if (demandOf(exercise) === 3) heavyCount += 1;
      picks.push({ slot, exercise, order: picks.length });
      break;
    }
  }
  return picks;
}

/** Micro order: each region's stations spread evenly through the round. */
function spreadOrder(picks: readonly Choice[]): Choice[] {
  const placed = SPLIT_REGIONS.flatMap((region, regionIndex) => {
    const mine = picks.filter((pick) => pick.slot.region === region);
    // Position (k + ½) / n, kept as the fraction (2k + 1) / 2n so comparisons are exact.
    return mine.map((pick, k) => ({ pick, regionIndex, top: 2 * k + 1, bottom: 2 * mine.length }));
  });
  placed.sort((a, b) => a.top * b.bottom - b.top * a.bottom || a.regionIndex - b.regionIndex);
  return placed.map((entry) => entry.pick);
}

/** Full order groups: strength patterns, then carries and others, core, conditioning, mobility. */
function fullGroup(pattern: MovementPattern | null): number {
  if (pattern === null) return 5;
  if (STRENGTH_PATTERNS.includes(pattern)) return 0;
  if (pattern === 'core') return 2;
  if (pattern === 'conditioning') return 3;
  if (pattern === 'mobility') return 4;
  return 1;
}

/** Full order: heavy lifts first, then by group, harder first, then as chosen. */
function fullOrder(picks: readonly Choice[]): Choice[] {
  const key = (pick: Choice) => {
    const demand = demandOf(pick.exercise);
    return [demand === 3 ? 0 : 1, fullGroup(pick.exercise.movementPattern), -demand, pick.order];
  };
  return [...picks].sort((a, b) => {
    const keyA = key(a);
    const keyB = key(b);
    for (let i = 0; i < keyA.length; i += 1) if (keyA[i] !== keyB[i]) return keyA[i] - keyB[i];
    return 0;
  });
}

function microItems(split: Split, minutes: number, pool: readonly LibraryExercise[], variant: number) {
  const { stations, rounds } = microShape(minutes);
  const picks = fillSlots(planSlots(allocateStations(split, stations), variant), pool, 'micro', variant);
  const items = spreadOrder(picks).map((pick) => circuitItemFor(pick.exercise, pick.slot.region, 'micro', rounds));
  return { items, rounds };
}

function fullItems(split: Split, minutes: number, pool: readonly LibraryExercise[], variant: number) {
  const target = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0;
  const guess = Math.max(1, Math.round(target / CIRCUIT_RULES.fullSecondsPerExerciseGuess));
  let best: { items: CircuitItem[]; seconds: number } | null = null;
  const spread = CIRCUIT_RULES.fullSearchSpread;
  for (let n = Math.max(1, guess - spread); n <= guess + spread; n += 1) {
    const picks = fillSlots(planSlots(allocateStations(split, n), variant), pool, 'full', variant);
    const items = fullOrder(picks).map((pick) =>
      circuitItemFor(pick.exercise, pick.slot.region, 'full', PRESCRIPTION.full.sets),
    );
    const seconds = estimateCircuitSeconds(items);
    if (best === null || Math.abs(seconds - target) < Math.abs(best.seconds - target)) best = { items, seconds };
  }
  return { items: best?.items ?? [], rounds: 1 };
}

/**
 * The default circuit for a preset's split, a setup and the minutes available (see the header for
 * every rule). Pure: it never changes its input, and the same input always gives the same circuit.
 */
export function buildDefaultCircuit(input: BuildCircuitInput): Circuit {
  const { split, location, equipment, minutes, kind, library } = input;
  const variant = Number.isFinite(input.variant) ? Math.trunc(input.variant ?? 0) : 0;
  const pool = candidatePool(library, kind, { location, equipment });
  const { items, rounds } =
    kind === 'micro' ? microItems(split, minutes, pool, variant) : fullItems(split, minutes, pool, variant);
  return {
    version: 1,
    source: 'default',
    kind,
    minutes,
    rounds,
    items,
    estimatedSeconds: estimateCircuitSeconds(items),
    location,
    split: { lower: split.lower, upper: split.upper, core: split.core, cardio: split.cardio },
  };
}
