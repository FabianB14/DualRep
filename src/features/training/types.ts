/**
 * Shared training types (Phase 1). Pure TypeScript: no React Native or database imports, so the
 * circuit builder, the spotter and their tests can use them anywhere.
 *
 * Enumerations mirror the CHECK constraints on public.exercises, public.presets and
 * public.equipment_setups in supabase/migrations/20261008000000_initial_schema.sql.
 */

export type MovementPattern =
  | 'squat'
  | 'hinge'
  | 'lunge'
  | 'horizontal_push'
  | 'vertical_push'
  | 'horizontal_pull'
  | 'vertical_pull'
  | 'carry'
  | 'core'
  | 'conditioning'
  | 'mobility'
  | 'other';

export type BodyRegion = 'lower' | 'upper' | 'core' | 'full' | 'cardio';

export type TrainingCategory = 'strength' | 'power' | 'conditioning' | 'mobility';

/** Where an exercise can be done. `home` is only used for Interverse originals (desk-side moves). */
export type ExerciseLocation = 'gym' | 'home' | 'both';

/** Where a setup is. A block is always done at one of these. */
export type SetupLocation = 'gym' | 'home';

export type ExerciseOrigin = 'dataset' | 'interverse' | 'user';

/** How a set is counted: repetitions, or seconds of work (planks, jumping jacks, carries). */
export type Measure = 'reps' | 'time';

export type DemandLevel = 1 | 2 | 3;

export type Unit = 'lb' | 'kg';

/** A preset's split of working sets, in percent. Always the four keys, adding up to 100. */
export type Split = { lower: number; upper: number; core: number; cardio: number };

export type SplitRegion = keyof Split;

/** The regions a split allocates, in the fixed order used to break ties. */
export const SPLIT_REGIONS: readonly SplitRegion[] = ['lower', 'upper', 'core', 'cardio'];

/**
 * An exercise as the training code sees it: the synced `exercises` row with its JSON columns parsed,
 * 0/1 booleans turned into booleans, plus `measure`, which is not a database column (see
 * exerciseMeasure in library.ts).
 */
export type LibraryExercise = {
  id: string;
  name: string;
  muscleGroup: string | null;
  secondaryMuscles: string[];
  bodyRegion: BodyRegion | null;
  category: TrainingCategory | null;
  /** Items the exercise needs (equipment vocabulary in equipment.ts). `bodyweight` means none. */
  equipment: string[];
  location: ExerciseLocation;
  movementPattern: MovementPattern | null;
  demandLevel: DemandLevel | null;
  level: 'beginner' | 'intermediate' | 'expert' | null;
  microOk: boolean;
  instructions: string[];
  origin: ExerciseOrigin;
  reviewed: boolean;
  ownerId: string | null;
  measure: Measure;
};

/** An equipment setup as the training code sees it. */
export type Setup = {
  id: string;
  name: string;
  location: SetupLocation;
  equipment: string[];
};

/** micro = a 5–15 minute circuit between focus blocks; full = the day's full session. */
export type WorkoutKind = 'micro' | 'full';

/** One exercise in a circuit, with what to aim for on each of its sets. */
export type CircuitItem = {
  exerciseId: string;
  /** Copied into exercise_sets.exercise_name when a set is logged. */
  name: string;
  measure: Measure;
  movementPattern: MovementPattern | null;
  /** The split region this item was chosen for. */
  region: SplitRegion;
  /** Sets of this exercise (in a micro circuit: one per round). */
  sets: number;
  /** Target reps per set (measure = 'reps'), else null. */
  targetReps: number | null;
  /** Target seconds of work per set (measure = 'time'), else null. */
  targetSeconds: number | null;
  /** Target load in pounds (storage unit), or null for bodyweight / not known yet. */
  targetWeightLbs: number | null;
  /** Rest after each set of this item, in seconds. */
  restSeconds: number;
};

/**
 * A circuit: what the move block will do. Stored as the `proposal` of a `transitions` row, so it must
 * stay plain JSON. `source` says who built it: the on-device default builder (Phase 1) or Tracy's
 * transition planner (Phase 3).
 */
export type Circuit = {
  version: 1;
  source: 'default' | 'tracy';
  kind: WorkoutKind;
  minutes: number;
  /**
   * micro: the items are done in order, then repeated, `rounds` times (round-robin).
   * full: each item's sets are done back to back (straight sets) and `rounds` is 1.
   */
  rounds: number;
  items: CircuitItem[];
  /** Estimated duration of the whole circuit including rest, in seconds. */
  estimatedSeconds: number;
  location: SetupLocation;
  split: Split;
};
