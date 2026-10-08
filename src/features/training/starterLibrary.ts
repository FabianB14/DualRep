/**
 * The Interverse starter library as the app uses it.
 *
 * The same exercises are seeded into Postgres (supabase/migrations/20261008120000_starter_library.sql,
 * generated from starterLibraryData.ts) and synced like any reviewed library row. The app also bundles
 * them, so the circuit builder has a complete library offline from the very first launch, before the
 * first sync has finished. Once a row has synced, the synced copy wins (see mergeLibrary in library.ts),
 * but `measure` always comes from here because it is not a database column.
 */
import { STARTER_EXERCISES, STARTER_ID_PREFIX, type StarterExercise } from './starterLibraryData';
import type { LibraryExercise, Measure } from './types';

export { MUSCLE_GROUPS, STARTER_EXERCISES, STARTER_ID_PREFIX } from './starterLibraryData';
export type { MuscleGroup, StarterExercise } from './starterLibraryData';

/**
 * A starter entry as a LibraryExercise: exactly what the synced row reads as once exerciseFromRow has
 * parsed it (origin 'interverse', reviewed, no owner). `force` and `mechanic` are database columns
 * the training code does not use, so they are left out here as they are in LibraryExercise.
 */
export function starterToLibraryExercise(entry: StarterExercise): LibraryExercise {
  return {
    id: entry.id,
    name: entry.name,
    muscleGroup: entry.muscleGroup,
    secondaryMuscles: [...entry.secondaryMuscles],
    bodyRegion: entry.bodyRegion,
    category: entry.category,
    equipment: [...entry.equipment],
    location: entry.location,
    movementPattern: entry.movementPattern,
    demandLevel: entry.demandLevel,
    level: entry.level,
    microOk: entry.microOk,
    instructions: [...entry.instructions],
    origin: 'interverse',
    reviewed: true,
    ownerId: null,
    measure: entry.measure,
  };
}

/** The bundled starter library, in id order. Shared by every caller: treat it as read-only. */
export const STARTER_LIBRARY: LibraryExercise[] = STARTER_EXERCISES.map(starterToLibraryExercise);

/** Starter exercises by id. */
export const STARTER_LIBRARY_BY_ID: ReadonlyMap<string, LibraryExercise> = new Map(
  STARTER_LIBRARY.map((exercise) => [exercise.id, exercise]),
);

/**
 * How each starter exercise is counted (reps or seconds), by id. `measure` is not a database column,
 * so a synced starter row gets its measure from here. A null-prototype object, so an id that is not a
 * starter id (including names like 'toString') reads as undefined.
 */
export const STARTER_MEASURE: Readonly<Record<string, Measure>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, Measure>,
    Object.fromEntries(STARTER_EXERCISES.map((entry) => [entry.id, entry.measure])),
  ),
);

/** The starter measure for an id, or undefined when the id is not a starter exercise. */
export function starterMeasure(id: string): Measure | undefined {
  return STARTER_MEASURE[id];
}

const STARTER_ID_PATTERN = new RegExp(`^${STARTER_ID_PREFIX}[0-9a-f]{4}$`);

/**
 * True when the id is in the range reserved for starter exercises, including ids of exercises a newer
 * app version added or an older one retired. Use STARTER_LIBRARY_BY_ID to look up a bundled one.
 */
export function isStarterExerciseId(id: string): boolean {
  return STARTER_ID_PATTERN.test(id);
}
