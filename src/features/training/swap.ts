/**
 * The location swap: "Switching location swaps each exercise for one with the same movement pattern
 * that fits the equipment. Progress is tracked per exercise" (docs/EXECUTION_PLAN.md, Gym or home).
 * Pure functions, like the circuit builder.
 *
 * swapForSetup(circuit, setup, library) keeps every item whose exercise fits the new setup and
 * replaces each one that does not (or whose exercise is not on the phone any more) with the best
 * alternative that fits. alternativesFor(item, setup, library) ranks the alternatives for the
 * one-exercise "Swap" button on the set card.
 *
 * RANKING. An alternative must be a circuit candidate for the setup (circuits.ts isCircuitCandidate:
 * fits the setup; in a micro circuit microOk and demand ≤ 2), must not be the item's own exercise, and
 * is never one already in the circuit. Each alternative is placed in the first tier it matches:
 *   1. same movement pattern and same muscle group
 *   2. same movement pattern (not for 'other': an isolation move of another muscle is no match)
 *   3. same muscle group, in the item's split region ('other' moves, such as a leg curl, match here)
 *   4. the item's region's other patterns, in rotation order (circuits.ts REGION_PATTERNS)
 *   5. any other exercise of the region
 *   6. any bodyweight core or conditioning exercise
 * Within a tier: mobility moves last (unless the item is one), then the closest demand level, then
 * equipment like the original's (a barbell Romanian deadlift becomes a dumbbell one, not a bodyweight
 * single-leg deadlift, when there are dumbbells), then the same measure (reps or seconds), then id
 * order. Tiers 4 to 6 are the circuit builder's fallbacks, so a swap with the starter library always
 * finds something.
 *
 * TARGETS. The swapped-in exercise is a different exercise, and progress is tracked per exercise, so
 * its target load starts empty (null; the set card and the spotter's adviseNextSession fill it from
 * that exercise's own history). Reps or seconds and rest are kept when the measure and the demand
 * level are the same; otherwise they are recomputed with defaultTargets (5 heavy back-squat reps
 * become 10 goblet-squat reps, a 40 s plank becomes 12 dead bugs). The number of sets is kept.
 */
import {
  candidatePool,
  estimateCircuitSeconds,
  isBodyweightOnly,
  otherPatternsAfter,
  REGION_PATTERNS,
  servesRegion,
} from './circuits';
import { fitsSetup } from './equipment';
import { defaultTargets, demandOf } from './prescription';
import type {
  Circuit,
  CircuitItem,
  LibraryExercise,
  MovementPattern,
  SetupLocation,
  SplitRegion,
  WorkoutKind,
} from './types';

export type SwapSetup = { location: SetupLocation; equipment: readonly string[] };

export type AlternativesOptions = {
  /** The circuit's kind. Default 'micro' (the stricter one: microOk and demand ≤ 2 only). */
  kind?: WorkoutKind;
  /** Exercise ids to leave out, e.g. the rest of the circuit. */
  exclude?: readonly string[];
  /** At most this many alternatives (default: all). */
  limit?: number;
};

/** The tier an alternative falls in for this item (see RANKING in the header), or null for none. */
function tierFor(candidate: LibraryExercise, item: CircuitItem, original: LibraryExercise | undefined): number | null {
  const pattern = item.movementPattern ?? original?.movementPattern ?? null;
  const muscle = original?.muscleGroup ?? null;
  const region = item.region;
  const samePattern = pattern !== null && candidate.movementPattern === pattern;
  const sameMuscle = muscle !== null && candidate.muscleGroup === muscle;
  if (samePattern && sameMuscle) return 1;
  if (samePattern && pattern !== 'other') return 2;
  if (sameMuscle && servesRegion(candidate, region)) return 3;
  const candidatePattern = candidate.movementPattern;
  if (candidatePattern !== null && otherPatternsAfter(REGION_PATTERNS[region], pattern).includes(candidatePattern)) {
    return 4;
  }
  if (servesRegion(candidate, region)) return 5;
  const coreOrCardio = candidatePattern === 'core' || candidatePattern === 'conditioning';
  return isBodyweightOnly(candidate) && coreOrCardio ? 6 : null;
}

/**
 * Order inside a tier, before the closeness keys: tier 4 follows the region's rotation order, tier 6
 * takes conditioning first for a cardio station and core first otherwise (as the circuit builder does).
 */
function subTier(
  candidate: LibraryExercise,
  tier: number,
  order: readonly MovementPattern[],
  region: SplitRegion,
): number {
  const pattern = candidate.movementPattern;
  if (tier === 4 && pattern !== null) return order.indexOf(pattern);
  if (tier === 6) return (pattern === 'conditioning') === (region === 'cardio') ? 0 : 1;
  return 0;
}

/** Ranked alternatives (see RANKING in the header). */
function rankAlternatives(
  item: CircuitItem,
  original: LibraryExercise | undefined,
  setup: SwapSetup,
  library: readonly LibraryExercise[],
  kind: WorkoutKind,
  exclude: ReadonlySet<string>,
): LibraryExercise[] {
  const region = item.region;
  const pattern = item.movementPattern ?? original?.movementPattern ?? null;
  const order = otherPatternsAfter(REGION_PATTERNS[region], pattern);
  const demand = original ? demandOf(original) : null;
  // Whether the original needs equipment (null when unknown): a loaded move is best replaced by one.
  const loaded = original ? !isBodyweightOnly(original) : null;
  const ranked = candidatePool(library, kind, setup)
    .filter((candidate) => candidate.id !== item.exerciseId && !exclude.has(candidate.id))
    .map((candidate) => ({ candidate, tier: tierFor(candidate, item, original) }))
    .filter((entry): entry is { candidate: LibraryExercise; tier: number } => entry.tier !== null)
    .map(({ candidate, tier }) => ({
      candidate,
      key: [
        tier,
        subTier(candidate, tier, order, region),
        (candidate.movementPattern === 'mobility') === (pattern === 'mobility') ? 0 : 1,
        demand === null ? 0 : Math.abs(demandOf(candidate) - demand),
        loaded === null || !isBodyweightOnly(candidate) === loaded ? 0 : 1,
        candidate.measure === item.measure ? 0 : 1,
      ],
    }));
  // candidatePool is in id order and Array.prototype.sort is stable, so equal keys stay in id order.
  ranked.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
  return ranked.map((entry) => entry.candidate);
}

function indexById(library: readonly LibraryExercise[]): Map<string, LibraryExercise> {
  const map = new Map<string, LibraryExercise>();
  for (const exercise of library) if (!map.has(exercise.id)) map.set(exercise.id, exercise);
  return map;
}

/**
 * The exercises that could replace this item with this setup, best first (see RANKING in the header).
 * Pass the circuit's kind, and the circuit's other exercise ids in `exclude`.
 */
export function alternativesFor(
  item: CircuitItem,
  setup: SwapSetup,
  library: readonly LibraryExercise[],
  options: AlternativesOptions = {},
): LibraryExercise[] {
  const original = indexById(library).get(item.exerciseId);
  const exclude = new Set(options.exclude ?? []);
  const ranked = rankAlternatives(item, original, setup, library, options.kind ?? 'micro', exclude);
  return options.limit === undefined ? ranked : ranked.slice(0, Math.max(0, options.limit));
}

/**
 * The item with its exercise replaced (see TARGETS in the header). `original` is the item's current
 * exercise if it is known; without it the targets are recomputed.
 */
export function replaceItem(
  item: CircuitItem,
  replacement: LibraryExercise,
  kind: WorkoutKind,
  original?: LibraryExercise | null,
): CircuitItem {
  const keep = original != null && replacement.measure === item.measure && demandOf(replacement) === demandOf(original);
  const targets = keep
    ? { targetReps: item.targetReps, targetSeconds: item.targetSeconds, restSeconds: item.restSeconds }
    : defaultTargets(replacement, kind);
  return {
    ...item,
    exerciseId: replacement.id,
    name: replacement.name,
    measure: replacement.measure,
    movementPattern: replacement.movementPattern,
    ...targets,
    targetWeightLbs: null,
  };
}

/**
 * The circuit for another setup: items that fit stay as they are, the others are replaced with their
 * best alternative (never one already in the circuit). An item with no alternative at all is kept
 * (with the starter library there always is one). The circuit's location becomes the setup's, and
 * its estimate is recomputed when an item changed.
 */
export function swapForSetup(circuit: Circuit, setup: SwapSetup, library: readonly LibraryExercise[]): Circuit {
  const byId = indexById(library);
  const inCircuit = new Set(circuit.items.map((item) => item.exerciseId));
  let changed = false;
  const items = circuit.items.map((item) => {
    const original = byId.get(item.exerciseId);
    if (original && fitsSetup(original, setup)) return item;
    const [replacement] = rankAlternatives(item, original, setup, library, circuit.kind, inCircuit);
    if (!replacement) return item;
    inCircuit.add(replacement.id);
    changed = true;
    return replaceItem(item, replacement, circuit.kind, original);
  });
  if (!changed) return { ...circuit, location: setup.location };
  return { ...circuit, location: setup.location, items, estimatedSeconds: estimateCircuitSeconds(items) };
}
