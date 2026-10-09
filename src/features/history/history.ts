/**
 * History and today's summary: the queries and the pure shaping behind the History screen and the
 * Home summary. Everything is read from the local database, so history works offline and shows what
 * was done on this phone before it has uploaded.
 *
 * Rules:
 * - A set's exercise name is `COALESCE(exercises.name, exercise_sets.exercise_name)` with a LEFT
 *   JOIN: the synced exercise's current name when it is on the phone, else the name copied into the
 *   set when it was logged (the exercise was deleted, unshared, never synced, or nulled by the
 *   server). Sets are grouped by that name within a workout, in the order they were done.
 * - Timed sets keep their seconds in `reps` / `target_reps` (exercise_sets has no seconds column; see
 *   cycleRepo.ts); the exercise's measure says how to read them.
 * - A focus block's minutes are the time from start to end, capped at its planned length. The loop
 *   records a block's end as its start plus the time actually focused (pauses left out; see
 *   cycleMachine.ts), so this is focus time, the same as the cycle's own summary; the cap only
 *   guards rows written some other way. Blocks without an end are "not finished".
 * - "Today" is the phone's local calendar day; stored timestamps are UTC ISO strings, which compare
 *   correctly as text because every one has the same format (DATA_MODEL.md).
 */
import { TABLE } from '@/db/constants';
import { formatWeight } from '@/features/training/units';
import type { Measure, Unit } from '@/features/training/types';

const T = TABLE;

/** How many recent blocks and workouts the History screen shows. */
export const HISTORY_LIMIT = 30;

export type BlockRow = {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  planned_minutes: number | null;
  interrupted: number | null;
  effort_rating: number | null;
};

export type WorkoutRow = {
  id: string;
  logged_at: string | null;
  kind: string | null;
  duration_minutes: number | null;
};

export type HistorySetRow = {
  id: string;
  workout_session_id: string | null;
  exercise_id: string | null;
  /** COALESCE(exercises.name, exercise_sets.exercise_name). */
  display_name: string | null;
  set_index: number | null;
  reps: number | null;
  weight_lbs: number | null;
  rpe: number | null;
  target_reps: number | null;
  set_type: string | null;
};

/** Params: user id, limit. Newest first. */
export const RECENT_BLOCKS_SQL = `SELECT id, started_at, ended_at, planned_minutes, interrupted, effort_rating
FROM ${T.interval_blocks}
WHERE user_id = ?
ORDER BY started_at DESC, id DESC
LIMIT ?`;

/** Params: user id, limit. Newest first. */
export const RECENT_WORKOUTS_SQL = `SELECT id, logged_at, kind, duration_minutes
FROM ${T.workout_sessions}
WHERE user_id = ?
ORDER BY logged_at DESC, id DESC
LIMIT ?`;

/** Params: user id, limit (the same as RECENT_WORKOUTS_SQL's). The sets of those workouts, in order. */
export const RECENT_SETS_SQL = `SELECT s.id, s.workout_session_id, s.exercise_id,
  COALESCE(e.name, s.exercise_name) AS display_name,
  s.set_index, s.reps, s.weight_lbs, s.rpe, s.target_reps, s.set_type
FROM ${T.exercise_sets} s
LEFT JOIN ${T.exercises} e ON e.id = s.exercise_id
WHERE s.workout_session_id IN (
  SELECT id FROM ${T.workout_sessions} WHERE user_id = ? ORDER BY logged_at DESC, id DESC LIMIT ?
)
ORDER BY s.workout_session_id, s.set_index, s.id`;

/** Params: user id, start of the local day (ISO). Today's focus blocks. */
export const TODAY_BLOCKS_SQL = `SELECT id, started_at, ended_at, planned_minutes, interrupted, effort_rating
FROM ${T.interval_blocks}
WHERE user_id = ? AND started_at >= ?`;

/** Params: user id, start of the local day (ISO). How many sets were logged today. */
export const TODAY_SETS_SQL = `SELECT COUNT(*) AS n FROM ${T.exercise_sets} WHERE user_id = ? AND created_at >= ?`;

/** Midnight at the start of the phone's local day containing `nowMs`, as epoch ms. */
export function startOfLocalDay(nowMs: number): number {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** An ISO timestamp as epoch ms, or null when missing or unreadable. */
export function parseTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export type FocusBlockEntry = {
  id: string;
  startedAt: number | null;
  plannedMinutes: number | null;
  /** Focused minutes (rounded, capped at the planned length); null while not finished. */
  minutes: number | null;
  effort: number | null;
  interrupted: boolean;
  finished: boolean;
};

export function focusBlockFromRow(row: BlockRow): FocusBlockEntry {
  const startedAt = parseTime(row.started_at);
  const endedAt = parseTime(row.ended_at);
  const planned = typeof row.planned_minutes === 'number' && row.planned_minutes > 0 ? row.planned_minutes : null;
  let minutes: number | null = null;
  if (startedAt !== null && endedAt !== null) {
    const elapsed = Math.max(0, Math.round((endedAt - startedAt) / 60_000));
    minutes = planned !== null ? Math.min(elapsed, planned) : elapsed;
  }
  const effort = typeof row.effort_rating === 'number' && row.effort_rating >= 1 && row.effort_rating <= 5 ? row.effort_rating : null;
  return {
    id: row.id,
    startedAt,
    plannedMinutes: planned,
    minutes,
    effort,
    interrupted: row.interrupted === 1,
    finished: endedAt !== null,
  };
}

export type TodaySummary = { blocks: number; focusMinutes: number; sets: number };

/** Today's numbers for Home: focus blocks started today, their focused minutes, sets logged today. */
export function summarizeToday(blocks: readonly BlockRow[], setCount: number | null | undefined): TodaySummary {
  const entries = blocks.map(focusBlockFromRow);
  return {
    blocks: entries.length,
    focusMinutes: entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0),
    sets: typeof setCount === 'number' && setCount > 0 ? setCount : 0,
  };
}

export type SetEntry = {
  id: string;
  reps: number | null;
  weightLbs: number | null;
  rpe: number | null;
  targetReps: number | null;
  setType: 'normal' | 'drop' | 'rest_pause';
};

export type ExerciseGroup = {
  /** The display name (the grouping key). */
  name: string;
  /** The first set's exercise id (null when the exercise is unknown). */
  exerciseId: string | null;
  sets: SetEntry[];
};

export type WorkoutEntry = {
  id: string;
  loggedAt: number | null;
  kind: 'micro' | 'full' | 'walk' | null;
  durationMinutes: number | null;
  exercises: ExerciseGroup[];
  setCount: number;
};

/** Shown when neither the exercise nor the set has a name (should not happen: logSet always fills it). */
export const UNKNOWN_EXERCISE = 'Exercise';

function setTypeOf(value: string | null): SetEntry['setType'] {
  return value === 'drop' || value === 'rest_pause' ? value : 'normal';
}

/**
 * Workouts in the given order, each with its sets grouped by exercise name (first appearance first,
 * sets in set_index order). Sets of workouts not in the list are ignored.
 */
export function groupWorkouts(workouts: readonly WorkoutRow[], sets: readonly HistorySetRow[]): WorkoutEntry[] {
  const byWorkout = new Map<string, HistorySetRow[]>();
  for (const set of sets) {
    if (!set.workout_session_id) continue;
    const list = byWorkout.get(set.workout_session_id) ?? [];
    list.push(set);
    byWorkout.set(set.workout_session_id, list);
  }
  return workouts.map((workout) => {
    const ordered = [...(byWorkout.get(workout.id) ?? [])].sort(
      (a, b) => (a.set_index ?? 0) - (b.set_index ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const groups = new Map<string, ExerciseGroup>();
    for (const set of ordered) {
      const name = (set.display_name ?? '').trim() || UNKNOWN_EXERCISE;
      const group = groups.get(name) ?? { name, exerciseId: set.exercise_id ?? null, sets: [] };
      group.sets.push({
        id: set.id,
        reps: set.reps,
        weightLbs: set.weight_lbs,
        rpe: set.rpe,
        targetReps: set.target_reps,
        setType: setTypeOf(set.set_type),
      });
      groups.set(name, group);
    }
    const kind = workout.kind === 'micro' || workout.kind === 'full' || workout.kind === 'walk' ? workout.kind : null;
    return {
      id: workout.id,
      loggedAt: parseTime(workout.logged_at),
      kind,
      durationMinutes: typeof workout.duration_minutes === 'number' ? workout.duration_minutes : null,
      exercises: [...groups.values()],
      setCount: ordered.length,
    };
  });
}

/**
 * One set in plain words: "10 reps · 25 lb", "8 of 10 reps", "40 s", "35 of 40 s · drop set".
 * A weight of 0 or none (bodyweight) is left out.
 */
export function describeSet(set: SetEntry, measure: Measure, unit: Unit): string {
  const done = set.reps ?? 0;
  const target = set.targetReps;
  const missed = target !== null && target !== done;
  const amount =
    measure === 'time'
      ? `${missed ? `${done} of ${target}` : done} s`
      : `${missed ? `${done} of ${target}` : done} ${(missed ? target : done) === 1 ? 'rep' : 'reps'}`;
  const parts = [amount];
  if (set.weightLbs !== null && set.weightLbs > 0) parts.push(formatWeight(set.weightLbs, unit));
  if (set.setType === 'drop') parts.push('drop set');
  if (set.setType === 'rest_pause') parts.push('rest-pause');
  return parts.join(' · ');
}

/** "10-minute circuit", "Full session", "Walk", with the duration when known. */
export function describeWorkout(workout: Pick<WorkoutEntry, 'kind' | 'durationMinutes' | 'setCount'>): string {
  const kind = workout.kind === 'full' ? 'Full session' : workout.kind === 'walk' ? 'Walk' : 'Circuit';
  const parts = [kind];
  if (workout.durationMinutes !== null && workout.durationMinutes > 0) parts.push(`${workout.durationMinutes} min`);
  parts.push(`${workout.setCount} ${workout.setCount === 1 ? 'set' : 'sets'}`);
  return parts.join(' · ');
}

/** "25 min · effort 4 of 5", "12 of 25 min · ended early", "Not finished". */
export function describeBlock(block: FocusBlockEntry): string {
  if (!block.finished) return 'Not finished';
  const minutes =
    block.interrupted && block.plannedMinutes !== null && block.minutes !== null && block.minutes < block.plannedMinutes
      ? `${block.minutes} of ${block.plannedMinutes} min`
      : `${block.minutes ?? 0} min`;
  const parts = [minutes];
  if (block.interrupted) parts.push('ended early');
  parts.push(block.effort !== null ? `effort ${block.effort} of 5` : 'effort not rated');
  return parts.join(' · ');
}

/**
 * "Today, 9:30", "Yesterday, 18:05", or the date ("Mon 6 Oct, 7:15") in the phone's locale.
 * `nowMs` decides what today is.
 */
export function describeWhen(ms: number | null, nowMs: number): string {
  if (ms === null) return 'Unknown time';
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = startOfLocalDay(nowMs);
  const day = startOfLocalDay(ms);
  if (day === today) return `Today, ${time}`;
  if (day === startOfLocalDay(today - 12 * 3_600_000)) return `Yesterday, ${time}`;
  const date = new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${date}, ${time}`;
}
