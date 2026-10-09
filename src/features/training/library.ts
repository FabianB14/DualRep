/**
 * The exercise library as the training code sees it: synced `exercises` rows turned into
 * LibraryExercise objects, merged with the bundled starter library, and filtered for the default
 * circuits. Pure functions only (no React, no database), so they are tested on their own; the hook
 * that feeds them from the local database is useLibrary.ts.
 *
 * Why merge with the bundled copy: the starter library is seeded into Postgres and syncs like any
 * library row, but on a fresh install the first sync may not have run yet (or the phone is in airplane
 * mode). The app ships the same exercises (starterLibrary.ts), so a circuit can always be built. Once
 * a row has synced, the synced copy wins, because the server may have corrected it; `measure` still
 * comes from the bundled data, because it is not a database column. Once the server's starter rows
 * are on the phone at all, they are all there (PowerSync applies the library stream a whole checkpoint
 * at a time), so a bundled starter exercise missing from them was withdrawn or retired on the server
 * (or this app is newer than the server's list): it is kept for its name and measure in history, but
 * as not reviewed, so circuits and swaps stop picking it. Its sets would otherwise lose their
 * exercise_id on upload (the server clears a link to an exercise the user cannot read).
 *
 * Reading rows defensively: PowerSync hands JSON columns over as text and booleans as 0/1, and a newer
 * server could send a value this app version does not know. Bad JSON reads as an empty list, unknown
 * enumeration values read as null (they then simply never match a filter or a circuit slot), and
 * unknown equipment items are kept, so an exercise that needs gear we cannot name never fits a setup.
 */
import type { ExerciseRow } from '@/db/schema';

import { fitsSetup } from './equipment';
import { isStarterExerciseId, STARTER_LIBRARY, starterMeasure } from './starterLibrary';
import type {
  BodyRegion,
  DemandLevel,
  ExerciseLocation,
  ExerciseOrigin,
  LibraryExercise,
  Measure,
  MovementPattern,
  SetupLocation,
  TrainingCategory,
} from './types';

/** Plain-word names for the movement patterns, in the order of the database CHECK constraint. */
export const MOVEMENT_PATTERN_LABELS: Readonly<Record<MovementPattern, string>> = {
  squat: 'Squat',
  hinge: 'Hinge',
  lunge: 'Lunge',
  horizontal_push: 'Push forward',
  vertical_push: 'Push overhead',
  horizontal_pull: 'Row',
  vertical_pull: 'Pull down',
  carry: 'Carry',
  core: 'Core',
  conditioning: 'Cardio',
  mobility: 'Mobility',
  other: 'Other',
};

/** Plain-word names for the body regions, in the order of the database CHECK constraint. */
export const BODY_REGION_LABELS: Readonly<Record<BodyRegion, string>> = {
  lower: 'Lower body',
  upper: 'Upper body',
  core: 'Core',
  full: 'Full body',
  cardio: 'Cardio',
};

// Every value of each union. Built from Records so the compiler insists on every member.
export const MOVEMENT_PATTERNS = Object.keys(MOVEMENT_PATTERN_LABELS) as readonly MovementPattern[];
export const BODY_REGIONS = Object.keys(BODY_REGION_LABELS) as readonly BodyRegion[];
const CATEGORY_SET: Record<TrainingCategory, true> = {
  strength: true,
  power: true,
  conditioning: true,
  mobility: true,
};
export const TRAINING_CATEGORIES = Object.keys(CATEGORY_SET) as readonly TrainingCategory[];
const LOCATION_SET: Record<ExerciseLocation, true> = { gym: true, home: true, both: true };
export const EXERCISE_LOCATIONS = Object.keys(LOCATION_SET) as readonly ExerciseLocation[];
type Level = NonNullable<LibraryExercise['level']>;
const LEVEL_SET: Record<Level, true> = { beginner: true, intermediate: true, expert: true };
export const EXERCISE_LEVELS = Object.keys(LEVEL_SET) as readonly Level[];
const ORIGIN_SET: Record<ExerciseOrigin, true> = { dataset: true, interverse: true, user: true };
export const EXERCISE_ORIGINS = Object.keys(ORIGIN_SET) as readonly ExerciseOrigin[];

/** Shown when a row has no usable name (the server never sends one, but the column is nullable here). */
export const UNNAMED_EXERCISE = 'Unnamed exercise';

/** The value when it is one of `allowed`, else null. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * A JSON column (text) as a list of strings. Anything that is not a JSON array reads as []; items
 * that are not non-empty strings are dropped. An already-parsed array is accepted too.
 */
export function parseStringArray(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** A 0/1 column as a boolean (null and anything but a non-zero number read as false). */
function toBool(value: unknown): boolean {
  return typeof value === 'number' && value !== 0;
}

/** Names that describe a hold or a timed effort ('Hang clean' and 'Walking lunge' are reps, so no "hang"/"walk"). */
const TIMED_NAME =
  /\b(planks?|holds?|wall sits?|isometric|carry|carries|dead hang|stretch(es|ing)?|l-sit|side bridge)\b/i;
const TIMED_PATTERNS: readonly MovementPattern[] = ['carry', 'conditioning', 'mobility'];

/**
 * How sets of an exercise are counted. A starter exercise uses its bundled `measure`. Anything else
 * (a dataset row, a user's own exercise) is timed when it is a carry, conditioning or mobility, or
 * its name says it is a hold (plank, wall sit, dead hang, "... hold", stretch); otherwise reps.
 * The add-exercise screen uses the same rule, since `measure` is not stored.
 */
export function exerciseMeasure(exercise: {
  id: string;
  name: string;
  movementPattern: MovementPattern | null;
  category?: TrainingCategory | null;
}): Measure {
  const bundled = starterMeasure(exercise.id);
  if (bundled) return bundled;
  if (exercise.movementPattern !== null && TIMED_PATTERNS.includes(exercise.movementPattern)) return 'time';
  if (exercise.category === 'conditioning' || exercise.category === 'mobility') return 'time';
  return TIMED_NAME.test(exercise.name) ? 'time' : 'reps';
}

/** A synced `exercises` row as a LibraryExercise (see the header for how bad values are read). */
export function exerciseFromRow(row: ExerciseRow): LibraryExercise {
  const name = (typeof row.name === 'string' ? row.name.trim() : '') || UNNAMED_EXERCISE;
  const movementPattern = oneOf(row.movement_pattern, MOVEMENT_PATTERNS);
  const category = oneOf(row.category, TRAINING_CATEGORIES);
  const equipment = parseStringArray(row.equipment);
  const demand = row.demand_level;
  const ownerId = typeof row.owner_id === 'string' && row.owner_id.length > 0 ? row.owner_id : null;
  return {
    id: row.id,
    name,
    muscleGroup: typeof row.muscle_group === 'string' && row.muscle_group.trim() ? row.muscle_group.trim() : null,
    secondaryMuscles: parseStringArray(row.secondary_muscles),
    bodyRegion: oneOf(row.body_region, BODY_REGIONS),
    category,
    // No equipment listed means none needed, the same as the starter data's ['bodyweight'].
    equipment: equipment.length > 0 ? equipment : ['bodyweight'],
    // 'both' is the column's default; equipment still decides whether the exercise fits a setup.
    location: oneOf(row.location, EXERCISE_LOCATIONS) ?? 'both',
    movementPattern,
    demandLevel: demand === 1 || demand === 2 || demand === 3 ? (demand as DemandLevel) : null,
    level: oneOf(row.level, EXERCISE_LEVELS),
    microOk: toBool(row.micro_ok),
    instructions: parseStringArray(row.instructions),
    // The server ties origin to owner_id (CHECK exercises_owner_matches_origin), so an unknown origin
    // falls back on that; a library row then still needs `reviewed` to be used anywhere.
    origin: oneOf(row.origin, EXERCISE_ORIGINS) ?? (ownerId ? 'user' : 'dataset'),
    reviewed: toBool(row.reviewed),
    ownerId,
    measure: exerciseMeasure({ id: row.id, name, movementPattern, category }),
  };
}

/** Sort key: name without case, then id, so the order never depends on the input order or the locale. */
function compareByName(a: LibraryExercise, b: LibraryExercise): number {
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The library the app uses: every synced exercise plus every bundled starter exercise that has not
 * synced, sorted by name. A synced row replaces the bundled copy with the same id but keeps the
 * bundled `measure` (not a database column). Once any starter row has synced, a bundled one that has
 * not is the server's withdrawal: it stays in the list, but not reviewed (see the header).
 */
export function mergeLibrary(
  synced: readonly LibraryExercise[],
  starter: readonly LibraryExercise[] = STARTER_LIBRARY,
): LibraryExercise[] {
  const bundled = new Map(starter.map((exercise) => [exercise.id, exercise]));
  const serverHasStarters = synced.some((exercise) => isStarterExerciseId(exercise.id));
  const merged = new Map(
    starter.map((exercise) => [exercise.id, serverHasStarters ? { ...exercise, reviewed: false } : exercise]),
  );
  for (const exercise of synced) {
    const copy = bundled.get(exercise.id);
    const keepMeasure = copy !== undefined && copy.measure !== exercise.measure;
    merged.set(exercise.id, keepMeasure ? { ...exercise, measure: copy.measure } : exercise);
  }
  return [...merged.values()].sort(compareByName);
}

/**
 * Whether the default circuits (and the location swap) may pick this exercise. The plan: "Tracy only
 * picks exercises marked as reviewed, plus the user's own custom entries", and the default builder
 * follows the same rule.
 * - Library rows (dataset or Interverse, starter rows included) only when reviewed. A synced row is
 *   what the server says; a bundled starter row is reviewed until the server's starter rows have
 *   synced without it (mergeLibrary), so a curator can withdraw a starter exercise on the server.
 * - The signed-in user's own exercises only when they say where they go in a circuit (movement
 *   pattern and body region) and that they fit a short circuit (microOk).
 * - Never a group mate's exercise: it is on the phone to browse, not to be picked for you.
 */
export function eligibleForDefaultCircuits(exercise: LibraryExercise, userId: string | null): boolean {
  if (exercise.origin === 'user') {
    return (
      userId !== null &&
      exercise.ownerId === userId &&
      exercise.movementPattern !== null &&
      exercise.bodyRegion !== null &&
      exercise.microOk
    );
  }
  return exercise.reviewed;
}

/** The exercises default circuits and swaps may pick from (keeps the input order). */
export function eligibleLibrary(exercises: readonly LibraryExercise[], userId: string | null): LibraryExercise[] {
  return exercises.filter((exercise) => eligibleForDefaultCircuits(exercise, userId));
}

/** Everything the screens need from the library, computed once per change of the exercises table. */
export type LibraryView = {
  /** Every exercise on the phone plus the starter exercises not synced yet, sorted by name. */
  exercises: LibraryExercise[];
  /** The same exercises by id (a circuit item's exercise, a logged set's exercise). */
  byId: ReadonlyMap<string, LibraryExercise>;
  /** What default circuits and swaps may pick from (eligibleForDefaultCircuits). */
  circuitPool: LibraryExercise[];
};

/** The library view for these synced rows and the signed-in user (null when signed out). */
export function libraryView(rows: readonly ExerciseRow[], userId: string | null): LibraryView {
  const exercises = mergeLibrary(rows.map(exerciseFromRow));
  return {
    exercises,
    byId: new Map(exercises.map((exercise) => [exercise.id, exercise])),
    circuitPool: eligibleLibrary(exercises, userId),
  };
}

/** Filters for the library screen. Every filter that is set must match. */
export type LibraryFilter = {
  /** Words to find in the name or the muscle group, in any order, ignoring case. */
  query?: string;
  /** Only this movement pattern. */
  pattern?: MovementPattern | null;
  /** Only exercises that can be done with this setup ("fits my setup"). */
  setup?: { location: SetupLocation; equipment: readonly string[] } | null;
};

/** The exercises that match the filter, in their input order. */
export function filterLibrary(exercises: readonly LibraryExercise[], filter: LibraryFilter): LibraryExercise[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const { pattern, setup } = filter;
  return exercises.filter((exercise) => {
    if (pattern && exercise.movementPattern !== pattern) return false;
    if (setup && !fitsSetup(exercise, setup)) return false;
    if (words.length === 0) return true;
    const haystack = `${exercise.name} ${exercise.muscleGroup ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
