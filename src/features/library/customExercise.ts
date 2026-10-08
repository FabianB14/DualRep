/**
 * The user's own exercises (origin 'user'): the add-exercise form's draft, its checks, and the row it
 * becomes. Pure: no React, no database (customExerciseRepo.ts writes).
 *
 * Rules (the CHECK constraints on public.exercises, and what the circuit builder needs):
 * - origin 'user', owner_id = the user, reviewed false, dataset_id null, group_id null (sharing with a
 *   group comes in Phase 4), images [] and no dataset facts (level, force, mechanic stay null).
 * - Equipment uses the vocabulary of equipment.ts; no equipment is stored as ['bodyweight'], like the
 *   starter library. Anything gym-only makes the exercise a gym exercise.
 * - The body region follows the movement pattern unless the user picks another; the category follows
 *   the pattern (cardio → conditioning, mobility → mobility, everything else strength).
 * - How sets are counted (reps or seconds) is not stored: exerciseMeasure in library.ts derives it
 *   from the pattern and the name, and the form shows the result, so what the user sees is what the
 *   cycle screen will use.
 * - Default circuits pick a user's own exercise only when it has a pattern and a region and fits a
 *   short circuit (eligibleForDefaultCircuits); the form asks for all three, so a new exercise can be
 *   used straight away.
 */
import { TABLE } from '@/db/constants';
import { GYM_ONLY_EQUIPMENT, normalizeEquipmentList, type Equipment } from '@/features/training/equipment';
import { BODY_REGIONS, exerciseMeasure, MOVEMENT_PATTERNS } from '@/features/training/library';
import { MUSCLE_GROUPS, type MuscleGroup } from '@/features/training/starterLibrary';
import type {
  BodyRegion,
  DemandLevel,
  ExerciseLocation,
  Measure,
  MovementPattern,
  TrainingCategory,
} from '@/features/training/types';
import { isoTimestamp } from '@/lib/time';

/** Longest name the form accepts (the column has no limit; this keeps lists readable). */
export const EXERCISE_NAME_MAX = 80;

/** At most this many instruction steps, each at most STEP_MAX characters. */
export const MAX_STEPS = 8;
export const STEP_MAX = 300;

/** The region a pattern usually works; null for 'other' (the user picks). */
export const DEFAULT_REGION: Readonly<Record<MovementPattern, BodyRegion | null>> = {
  squat: 'lower',
  hinge: 'lower',
  lunge: 'lower',
  horizontal_push: 'upper',
  vertical_push: 'upper',
  horizontal_pull: 'upper',
  vertical_pull: 'upper',
  carry: 'full',
  core: 'core',
  conditioning: 'cardio',
  mobility: 'full',
  other: null,
};

/** Where the user says the exercise can be done ('home' keeps a desk-side move out of gym circuits). */
export type PlaceChoice = 'both' | 'home' | 'gym';

export const DEMAND_LABELS: Readonly<Record<DemandLevel, string>> = { 1: 'Light', 2: 'Moderate', 3: 'Hard' };

export type ExerciseDraft = {
  name: string;
  pattern: MovementPattern | null;
  /** null = follow the pattern (DEFAULT_REGION). */
  region: BodyRegion | null;
  equipment: Equipment[];
  place: PlaceChoice;
  demand: DemandLevel;
  muscleGroup: MuscleGroup | null;
  /** Usable in the short circuits between study blocks. */
  microOk: boolean;
  /** "How to do it": one step per line. */
  steps: string;
};

export function emptyExerciseDraft(): ExerciseDraft {
  return {
    name: '',
    pattern: null,
    region: null,
    equipment: [],
    place: 'both',
    demand: 2,
    muscleGroup: null,
    microOk: true,
    steps: '',
  };
}

/** The region the exercise will be stored with: the user's pick, else the pattern's usual one. */
export function draftRegion(draft: Pick<ExerciseDraft, 'pattern' | 'region'>): BodyRegion | null {
  return draft.region ?? (draft.pattern ? DEFAULT_REGION[draft.pattern] : null);
}

export function categoryFor(pattern: MovementPattern | null): TrainingCategory {
  if (pattern === 'conditioning') return 'conditioning';
  if (pattern === 'mobility') return 'mobility';
  return 'strength';
}

/** Gym-only gear makes it a gym exercise whatever was chosen; otherwise the user's choice. */
export function locationFor(equipment: readonly Equipment[], place: PlaceChoice): ExerciseLocation {
  if (equipment.some((item) => GYM_ONLY_EQUIPMENT.includes(item))) return 'gym';
  return place;
}

/** Reps or seconds, by the same rule the rest of the app uses for non-starter exercises. */
export function draftMeasure(draft: Pick<ExerciseDraft, 'name' | 'pattern'>): Measure {
  return exerciseMeasure({
    id: '',
    name: draft.name.trim(),
    movementPattern: draft.pattern,
    category: categoryFor(draft.pattern),
  });
}

/** The instruction steps: one per non-empty line, trimmed, capped in number and length. */
export function parseSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_STEPS)
    .map((line) => line.slice(0, STEP_MAX));
}

/** What is wrong with a draft, in plain words; an empty object when it can be saved. */
export function exerciseDraftErrors(draft: ExerciseDraft): { name?: string; pattern?: string; region?: string } {
  const errors: { name?: string; pattern?: string; region?: string } = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = 'Give it a name.';
  else if (name.length > EXERCISE_NAME_MAX) errors.name = `Use at most ${EXERCISE_NAME_MAX} characters.`;
  if (!draft.pattern || !MOVEMENT_PATTERNS.includes(draft.pattern)) errors.pattern = 'Pick the kind of movement.';
  const region = draftRegion(draft);
  if (!region || !BODY_REGIONS.includes(region)) errors.region = 'Pick the part of the body it works.';
  return errors;
}

/**
 * The INSERT for a new exercise of the user's own. Throws (RangeError) on a draft with errors, so a
 * row the server would refuse never reaches the upload queue.
 */
export function exerciseInsert(
  userId: string,
  draft: ExerciseDraft,
  id: string,
  nowMs: number,
): { sql: string; params: unknown[] } {
  const errors = exerciseDraftErrors(draft);
  const problem = errors.name ?? errors.pattern ?? errors.region;
  if (problem) throw new RangeError(problem);
  const at = isoTimestamp(nowMs);
  if (draft.demand !== 1 && draft.demand !== 2 && draft.demand !== 3) {
    throw new RangeError(`demand_level must be 1, 2 or 3, got ${String(draft.demand)}`);
  }
  const equipment = normalizeEquipmentList(draft.equipment);
  const values: Record<string, unknown> = {
    id,
    name: draft.name.trim(),
    muscle_group: draft.muscleGroup && MUSCLE_GROUPS.includes(draft.muscleGroup) ? draft.muscleGroup : null,
    secondary_muscles: '[]',
    body_region: draftRegion(draft),
    category: categoryFor(draft.pattern),
    equipment: JSON.stringify(equipment.length > 0 ? equipment : ['bodyweight']),
    location: locationFor(equipment, draft.place),
    movement_pattern: draft.pattern,
    demand_level: draft.demand,
    micro_ok: draft.microOk ? 1 : 0,
    instructions: JSON.stringify(parseSteps(draft.steps)),
    images: '[]',
    origin: 'user',
    reviewed: 0,
    owner_id: userId,
    created_at: at,
    updated_at: at,
  };
  const columns = Object.keys(values);
  return {
    sql: `INSERT INTO ${TABLE.exercises} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: Object.values(values),
  };
}
