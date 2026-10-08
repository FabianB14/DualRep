/**
 * Default set targets: what each set of an exercise aims for when nothing better is known yet (no
 * history for the exercise, no plan from Tracy). The default circuit builder (circuits.ts) and the
 * location swap (swap.ts) use them; once sets are logged, the spotter (spotter.ts) takes over from
 * there, and its adviseNextSession sets the load for the next time.
 *
 * Targets depend only on how the exercise is counted (reps or seconds), its demand level and the kind
 * of workout. The numbers live in PRESCRIPTION below:
 *
 *              micro circuit, per round           full session, 3 straight sets
 *   demand     reps   seconds   rest              reps   seconds   rest
 *   1          12     40 s      rest of the slot  12     45 s      60 s
 *   2          10     30 s      rest of the slot  10     40 s      60 s
 *   3          8      30 s      rest of the slot  5      30 s      120 s
 *
 * - Time model: a rep takes about 3 seconds (a controlled pace), so a set of 12 reps is 36 seconds of
 *   work. workSeconds() is that rule; circuits.ts estimates a circuit's length with it.
 * - Micro: every station is a 50-second slot, the work and then the rest of the slot to change over to
 *   the next station (rounded to 5 s, at least 10 s). 12 reps (36 s) leave 15 s, 10 reps or a 30 s
 *   hold leave 20 s, a 40 s hold leaves 10 s. Harder moves get shorter work and a longer change-over.
 *   Demand 3 never goes into a micro circuit; its row is there so that no caller ever meets a gap.
 * - Full: heavy lifts (demand 3) get 5 reps and 2 minutes of rest; everything else 10 to 12 reps (or
 *   40 to 45 s) with 60 s of rest. The number of sets (3) is the circuit's business: circuits.ts uses
 *   PRESCRIPTION.full.sets.
 * - An exercise with no demand level (a user's own exercise can lack one) counts as demand 2.
 * - The load is never guessed: targetWeightLbs is always null here. It comes from history (the
 *   spotter's adviseNextSession) or from the user on the set card.
 * - Timed targets are 30 s or more, so the spotter's 5-second rule for timed sets always has room
 *   (its header: "the default targets are 20 s and up").
 */
import type { CircuitItem, DemandLevel, LibraryExercise, WorkoutKind } from './types';

export const PRESCRIPTION = {
  /** Seconds of work per rep, for estimating how long a set of reps takes. */
  secondsPerRep: 3,
  micro: {
    /** One station of a micro circuit: work plus change-over. */
    slotSeconds: 50,
    /** The shortest change-over between stations. */
    minChangeoverSeconds: 10,
    reps: { 1: 12, 2: 10, 3: 8 },
    seconds: { 1: 40, 2: 30, 3: 30 },
  },
  full: {
    /** Straight sets per exercise in a full session. */
    sets: 3,
    reps: { 1: 12, 2: 10, 3: 5 },
    seconds: { 1: 45, 2: 40, 3: 30 },
    restSeconds: { 1: 60, 2: 60, 3: 120 },
  },
} as const;

/** What each set of an exercise aims for, in the same shape as a CircuitItem's targets. */
export type SetPrescription = {
  /** Reps per set (measure 'reps'), else null. */
  targetReps: number | null;
  /** Seconds of work per set (measure 'time'), else null. */
  targetSeconds: number | null;
  /** Always null: the load comes from history or from the user. */
  targetWeightLbs: number | null;
  /** Rest after each set, in seconds. */
  restSeconds: number;
};

/** The fields defaultTargets reads; a LibraryExercise has them. */
export type PrescriptionInput = Pick<LibraryExercise, 'measure' | 'demandLevel'>;

/** The demand level the rules use: unknown counts as 2. */
export function demandOf(exercise: { demandLevel: DemandLevel | null }): DemandLevel {
  return exercise.demandLevel ?? 2;
}

/** Seconds of work in one set with these targets (a rep is PRESCRIPTION.secondsPerRep seconds). */
export function workSeconds(targets: Pick<CircuitItem, 'targetReps' | 'targetSeconds'>): number {
  if (targets.targetSeconds !== null) return targets.targetSeconds;
  return (targets.targetReps ?? 0) * PRESCRIPTION.secondsPerRep;
}

/** Rounds to the nearest multiple of 5. */
function roundTo5(seconds: number): number {
  return Math.round(seconds / 5) * 5;
}

/** Targets for each set of an exercise in a workout of this kind (see the table in the header). */
export function defaultTargets(exercise: PrescriptionInput, kind: WorkoutKind): SetPrescription {
  const demand = demandOf(exercise);
  const timed = exercise.measure === 'time';
  if (kind === 'micro') {
    const rules = PRESCRIPTION.micro;
    const targetReps = timed ? null : rules.reps[demand];
    const targetSeconds = timed ? rules.seconds[demand] : null;
    const work = workSeconds({ targetReps, targetSeconds });
    const restSeconds = Math.max(rules.minChangeoverSeconds, roundTo5(rules.slotSeconds - work));
    return { targetReps, targetSeconds, targetWeightLbs: null, restSeconds };
  }
  const rules = PRESCRIPTION.full;
  return {
    targetReps: timed ? null : rules.reps[demand],
    targetSeconds: timed ? rules.seconds[demand] : null,
    targetWeightLbs: null,
    restSeconds: rules.restSeconds[demand],
  };
}
