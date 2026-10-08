/**
 * Every database write of the study → move → study loop, plus the one read the spotter needs.
 *
 * - All local: each function is one PowerSync write transaction on the phone's SQLite database, so the
 *   loop works in airplane mode; PowerSync uploads the rows later. Nothing here calls Supabase.
 * - Idempotent: every row id is made before the write (by the cycle machine), and an INSERT is skipped
 *   when a row with that id already exists. UPDATEs set fixed values. So a write that is retried after
 *   a crash or a lost acknowledgement never creates a second row (see useCycle / cycleStore).
 * - Columns and values follow the write policies in src/db/tables.ts and the CHECK constraints of the
 *   first migration: timestamps are ISO strings with milliseconds, booleans 0/1, JSON as text, and
 *   created_at/updated_at are set on INSERT (updated_at on UPDATE too; the server overwrites it).
 * - Values a CHECK would refuse are refused here first (RangeError), so a bad write never reaches the
 *   upload queue. The cycle machine only produces valid values.
 * - Timed sets (measure 'time') store seconds in `reps` and `target_reps`: exercise_sets has no seconds
 *   column, and the schema is frozen in Phase 1. The exercise's measure says how to read them.
 */
import { TABLE } from '@/db/constants';
import { db } from '@/db/database';
import type { LoggedSet, SetType } from '@/features/training/spotter';
import type { Circuit, WorkoutKind } from '@/features/training/types';
import { isoTimestamp } from '@/lib/time';

const T = TABLE;

/** focus_subject is at most 200 characters (CHECK on study_sessions). */
export const MAX_FOCUS_SUBJECT = 200;

const SET_TYPES: readonly SetType[] = ['normal', 'drop', 'rest_pause'];
const WORKOUT_KINDS: readonly WorkoutKind[] = ['micro', 'full'];

function wholeInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${min} to ${max}, got ${value}`);
  }
  return value;
}

/** A non-negative whole number, or null. */
function count(name: string, value: number | null): number | null {
  if (value === null) return null;
  return wholeInRange(name, value, 0, Number.MAX_SAFE_INTEGER);
}

/** A non-negative weight in pounds, or null. */
function pounds(name: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be 0 or more, got ${value}`);
  return value;
}

export type StartFocusBlockInput = {
  userId: string;
  sessionId: string;
  /** True on the cycle's first block: the study_sessions row is created in the same transaction. */
  createSession: boolean;
  /** What the user is studying ('' when not given). */
  focusSubject: string;
  blockId: string;
  /** 1–120 (the app offers 10–50). */
  plannedMinutes: number;
  /** Epoch ms. Also the rows' created_at/updated_at. */
  startedAt: number;
};

/** Starts a focus block: the study session (first block only) and the interval_blocks row. */
export async function startFocusBlock(input: StartFocusBlockInput): Promise<void> {
  const plannedMinutes = wholeInRange('planned_minutes', input.plannedMinutes, 1, 120);
  const at = isoTimestamp(input.startedAt);
  const subject = input.focusSubject.trim().slice(0, MAX_FOCUS_SUBJECT);
  await db.writeTransaction(async (tx) => {
    if (input.createSession) {
      const session = await tx.getOptional(`SELECT id FROM ${T.study_sessions} WHERE id = ?`, [input.sessionId]);
      if (!session) {
        await tx.execute(
          `INSERT INTO ${T.study_sessions} (id, user_id, focus_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [input.sessionId, input.userId, subject, at, at],
        );
      }
    }
    const block = await tx.getOptional(`SELECT id FROM ${T.interval_blocks} WHERE id = ?`, [input.blockId]);
    if (!block) {
      await tx.execute(
        `INSERT INTO ${T.interval_blocks} (id, user_id, study_session_id, planned_minutes, started_at, interrupted, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.blockId, input.userId, input.sessionId, plannedMinutes, at, 0, 'seated', at, at],
      );
    }
  });
}

/** Records when a focus block ended, and whether it was cut short. */
export async function endFocusBlock(
  blockId: string,
  endedAt: number,
  interrupted: boolean,
  updatedAt: number = Date.now(),
): Promise<void> {
  const ended = isoTimestamp(endedAt);
  const now = isoTimestamp(updatedAt);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${T.interval_blocks} SET ended_at = ?, interrupted = ?, updated_at = ? WHERE id = ?`, [
      ended,
      interrupted ? 1 : 0,
      now,
      blockId,
    ]);
  });
}

/** How the focus block felt, 1–5. */
export async function rateBlock(blockId: string, effort: number, updatedAt: number = Date.now()): Promise<void> {
  const rating = wholeInRange('effort_rating', effort, 1, 5);
  const now = isoTimestamp(updatedAt);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${T.interval_blocks} SET effort_rating = ?, updated_at = ? WHERE id = ?`, [
      rating,
      now,
      blockId,
    ]);
  });
}

export type StartMoveBlockInput = {
  userId: string;
  workoutId: string;
  kind: WorkoutKind;
  /** Epoch ms. Also the rows' created_at/updated_at. */
  loggedAt: number;
  presetId: string | null;
  setupId: string | null;
  /**
   * The handoff from the focus block that just ended: the circuit proposed for this move block. null
   * for a move block started on its own ("Just train"), which has no transition.
   */
  transition: { id: string; blockId: string; proposal: Circuit } | null;
};

/**
 * Starts a move block: the workout_sessions row and, after a focus block, the transitions row that
 * logs the proposed circuit. `accepted` stays null until the first set (accepted) or a skip (refused).
 */
export async function startMoveBlock(input: StartMoveBlockInput): Promise<void> {
  if (!WORKOUT_KINDS.includes(input.kind)) throw new RangeError(`Unknown workout kind: ${input.kind}`);
  const at = isoTimestamp(input.loggedAt);
  await db.writeTransaction(async (tx) => {
    const workout = await tx.getOptional(`SELECT id FROM ${T.workout_sessions} WHERE id = ?`, [input.workoutId]);
    if (!workout) {
      await tx.execute(
        `INSERT INTO ${T.workout_sessions} (id, user_id, logged_at, kind, preset_id, setup_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.workoutId, input.userId, at, input.kind, input.presetId, input.setupId, at, at],
      );
    }
    const { transition } = input;
    if (!transition) return;
    const existing = await tx.getOptional(`SELECT id FROM ${T.transitions} WHERE id = ?`, [transition.id]);
    if (!existing) {
      await tx.execute(
        `INSERT INTO ${T.transitions} (id, user_id, interval_block_id, workout_session_id, proposal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [transition.id, input.userId, transition.blockId, input.workoutId, JSON.stringify(transition.proposal), at, at],
      );
    }
  });
}

export type LogSetInput = {
  id: string;
  userId: string;
  workoutId: string;
  /** The move block's transition, or null ("Just train"). */
  transitionId: string | null;
  /** null only if the exercise is unknown; exercise_name is always filled. */
  exerciseId: string | null;
  exerciseName: string;
  /** 0-based position of the set in the whole workout. */
  setIndex: number;
  /** Reps done, or seconds of work for a timed set. */
  reps: number;
  weightLbs: number | null;
  /** Effort 1–10, or null. */
  rpe: number | null;
  /** Target reps (or seconds for a timed set), or null. */
  targetReps: number | null;
  targetWeightLbs: number | null;
  /** Rest taken before this set, in seconds; null for the workout's first set. */
  restSeconds: number | null;
  setType: SetType;
  /** Epoch ms. The row's created_at/updated_at. */
  loggedAt: number;
};

/**
 * Logs one set. The workout's first set (set_index 0) also marks its transition accepted: the user
 * took up the proposed move block.
 */
export async function logSet(input: LogSetInput): Promise<void> {
  const setIndex = wholeInRange('set_index', input.setIndex, 0, Number.MAX_SAFE_INTEGER);
  const reps = count('reps', input.reps);
  const targetReps = count('target_reps', input.targetReps);
  const restSeconds = count('rest_seconds', input.restSeconds);
  const weightLbs = pounds('weight_lbs', input.weightLbs);
  const targetWeightLbs = pounds('target_weight_lbs', input.targetWeightLbs);
  if (input.rpe !== null && !(Number.isFinite(input.rpe) && input.rpe >= 1 && input.rpe <= 10)) {
    throw new RangeError(`rpe must be from 1 to 10, got ${input.rpe}`);
  }
  if (!SET_TYPES.includes(input.setType)) throw new RangeError(`Unknown set type: ${input.setType}`);
  const at = isoTimestamp(input.loggedAt);
  await db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional(`SELECT id FROM ${T.exercise_sets} WHERE id = ?`, [input.id]);
    if (!existing) {
      await tx.execute(
        `INSERT INTO ${T.exercise_sets} (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs, rpe, target_reps, target_weight_lbs, rest_seconds, set_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.userId,
          input.workoutId,
          input.exerciseId,
          input.exerciseName,
          setIndex,
          reps,
          weightLbs,
          input.rpe,
          targetReps,
          targetWeightLbs,
          restSeconds,
          input.setType,
          at,
          at,
        ],
      );
    }
    if (setIndex === 0 && input.transitionId) {
      await tx.execute(`UPDATE ${T.transitions} SET accepted = ?, updated_at = ? WHERE id = ?`, [
        1,
        at,
        input.transitionId,
      ]);
    }
  });
}

/** Closes a move block with how long it took. */
export async function finishMoveBlock(
  workoutId: string,
  durationMinutes: number,
  updatedAt: number = Date.now(),
): Promise<void> {
  const minutes = wholeInRange('duration_minutes', durationMinutes, 0, Number.MAX_SAFE_INTEGER);
  const now = isoTimestamp(updatedAt);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${T.workout_sessions} SET duration_minutes = ?, updated_at = ? WHERE id = ?`, [
      minutes,
      now,
      workoutId,
    ]);
  });
}

/**
 * The user skipped the move block: its transition is marked refused (accepted = 0), and the workout
 * is deleted when no set was logged in it (the transition then points at no workout, as the server's
 * ON DELETE SET NULL would leave it).
 */
export async function skipMoveBlock(
  workoutId: string,
  transitionId: string | null,
  updatedAt: number = Date.now(),
): Promise<void> {
  const now = isoTimestamp(updatedAt);
  await db.writeTransaction(async (tx) => {
    const sets = await tx.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${T.exercise_sets} WHERE workout_session_id = ?`,
      [workoutId],
    );
    const empty = Number(sets.n) === 0;
    if (transitionId) {
      if (empty) {
        await tx.execute(
          `UPDATE ${T.transitions} SET accepted = ?, workout_session_id = NULL, updated_at = ? WHERE id = ?`,
          [0, now, transitionId],
        );
      } else {
        await tx.execute(`UPDATE ${T.transitions} SET accepted = ?, updated_at = ? WHERE id = ?`, [0, now, transitionId]);
      }
    }
    if (empty) await tx.execute(`DELETE FROM ${T.workout_sessions} WHERE id = ?`, [workoutId]);
  });
}

type SetRow = {
  exercise_id: string;
  set_index: number | null;
  reps: number | null;
  weight_lbs: number | null;
  rpe: number | null;
  target_reps: number | null;
  target_weight_lbs: number | null;
  rest_seconds: number | null;
  set_type: string | null;
};

/** An exercise_sets row as the spotter reads it (timed sets: seconds in reps/target_reps). */
export function loggedSetFromRow(row: Omit<SetRow, 'exercise_id' | 'set_index'>): LoggedSet {
  const setType = SET_TYPES.find((type) => type === row.set_type) ?? 'normal';
  return {
    target: row.target_reps,
    done: row.reps ?? 0,
    targetWeightLbs: row.target_weight_lbs,
    weightLbs: row.weight_lbs,
    rpe: row.rpe,
    restSeconds: row.rest_seconds,
    setType,
  };
}

/**
 * For each exercise, its sets (oldest first) from the most recent workout that has any, for
 * adviseNextSession. `excludeWorkoutId` leaves out the workout in progress. Exercises never done are
 * missing from the map. The phone only holds the signed-in user's own sets (user_private stream).
 */
export async function lastSessionSetsFor(
  exerciseIds: readonly string[],
  options: { excludeWorkoutId?: string | null } = {},
): Promise<Map<string, LoggedSet[]>> {
  const ids = [...new Set(exerciseIds.filter((id) => typeof id === 'string' && id !== ''))];
  const result = new Map<string, LoggedSet[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.getAll<SetRow>(
    `SELECT s.exercise_id, s.set_index, s.reps, s.weight_lbs, s.rpe, s.target_reps, s.target_weight_lbs, s.rest_seconds, s.set_type
FROM ${T.exercise_sets} s
WHERE s.exercise_id IN (${placeholders})
  AND s.workout_session_id = (
    SELECT s2.workout_session_id FROM ${T.exercise_sets} s2
    JOIN ${T.workout_sessions} w ON w.id = s2.workout_session_id
    WHERE s2.exercise_id = s.exercise_id AND s2.workout_session_id <> ?
    ORDER BY w.logged_at DESC, w.id DESC
    LIMIT 1
  )
ORDER BY s.exercise_id, s.set_index`,
    [...ids, options.excludeWorkoutId ?? ''],
  );
  for (const row of rows) {
    const list = result.get(row.exercise_id) ?? [];
    list.push(loggedSetFromRow(row));
    result.set(row.exercise_id, list);
  }
  return result;
}
