import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  describeBlock,
  describeSet,
  describeWhen,
  describeWorkout,
  focusBlockFromRow,
  groupWorkouts,
  parseTime,
  RECENT_BLOCKS_SQL,
  RECENT_SETS_SQL,
  RECENT_WORKOUTS_SQL,
  startOfLocalDay,
  summarizeToday,
  TODAY_BLOCKS_SQL,
  TODAY_SETS_SQL,
  UNKNOWN_EXERCISE,
  type BlockRow,
  type HistorySetRow,
  type SetEntry,
  type WorkoutRow,
} from '../history';
import { createSqliteDb } from '../testing/sqliteDb';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const SQUAT = '00000000-0000-4000-8000-0000000e0001';
const PLANK = '00000000-0000-4000-8000-0000000e0002';
const GONE = '00000000-0000-4000-8000-0000000effff';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 9, 8, 9, 30, 0, 0);
const MIN = 60_000;

function block(id: string, startedAt: number, endedAt: number | null, extra: Partial<BlockRow> = {}): BlockRow {
  return {
    id,
    started_at: iso(startedAt),
    ended_at: endedAt === null ? null : iso(endedAt),
    planned_minutes: 25,
    interrupted: 0,
    effort_rating: null,
    ...extra,
  };
}

describe('the history SQL on SQLite', () => {
  const db = createSqliteDb();

  beforeEach(() => {
    db.reset();
    db.seed('exercises', { id: SQUAT, name: 'Goblet squat (renamed)', origin: 'interverse', reviewed: 1 });
    db.seed('exercises', { id: PLANK, name: 'Plank', origin: 'interverse', reviewed: 1 });
    db.seed('workout_sessions', { id: 'w1', user_id: USER, logged_at: iso(T0), kind: 'micro', duration_minutes: 10 });
    db.seed('workout_sessions', { id: 'w2', user_id: USER, logged_at: iso(T0 + 60 * MIN), kind: 'full', duration_minutes: null });
    db.seed('workout_sessions', { id: 'w3', user_id: OTHER, logged_at: iso(T0 + 90 * MIN), kind: 'micro' });
    const set = (id: string, workout: string, exerciseId: string | null, name: string, index: number, extra = {}) =>
      db.seed('exercise_sets', {
        id,
        user_id: workout === 'w3' ? OTHER : USER,
        workout_session_id: workout,
        exercise_id: exerciseId,
        exercise_name: name,
        set_index: index,
        reps: 10,
        target_reps: 10,
        set_type: 'normal',
        created_at: iso(T0 + index * MIN),
        ...extra,
      });
    set('s1', 'w1', SQUAT, 'Goblet squat', 0, { weight_lbs: 25 });
    set('s2', 'w1', PLANK, 'Plank', 1, { reps: 40, target_reps: 40 });
    set('s3', 'w1', SQUAT, 'Goblet squat', 2, { reps: 8, weight_lbs: 25 });
    set('s4', 'w1', null, 'Doorframe row', 3);
    set('s5', 'w1', GONE, 'Old exercise', 4);
    set('s6', 'w2', SQUAT, 'Goblet squat', 0);
    set('s7', 'w3', SQUAT, 'Goblet squat', 0);
  });

  it('reads recent workouts of this user, newest first', async () => {
    const rows = await db.getAll<WorkoutRow>(RECENT_WORKOUTS_SQL, [USER, 30]);
    expect(rows.map((row) => row.id)).toEqual(['w2', 'w1']);
    expect(await db.getAll<WorkoutRow>(RECENT_WORKOUTS_SQL, [USER, 1])).toEqual([
      { id: 'w2', logged_at: iso(T0 + 60 * MIN), kind: 'full', duration_minutes: null },
    ]);
  });

  it('names sets COALESCE(exercise name, logged name) with a LEFT JOIN, in order', async () => {
    const rows = await db.getAll<HistorySetRow>(RECENT_SETS_SQL, [USER, 30]);
    expect(rows.map((row) => [row.workout_session_id, row.id, row.display_name])).toEqual([
      ['w1', 's1', 'Goblet squat (renamed)'],
      ['w1', 's2', 'Plank'],
      ['w1', 's3', 'Goblet squat (renamed)'],
      // No exercise id, and an id whose exercise is not on the phone: the logged name.
      ['w1', 's4', 'Doorframe row'],
      ['w1', 's5', 'Old exercise'],
      ['w2', 's6', 'Goblet squat (renamed)'],
    ]);
  });

  it('only reads the sets of the workouts shown', async () => {
    const rows = await db.getAll<HistorySetRow>(RECENT_SETS_SQL, [USER, 1]);
    expect(rows.map((row) => row.id)).toEqual(['s6']);
  });

  it('reads recent focus blocks, newest first', async () => {
    db.seed('interval_blocks', { id: 'b1', user_id: USER, started_at: iso(T0), ended_at: iso(T0 + 25 * MIN), planned_minutes: 25 });
    db.seed('interval_blocks', { id: 'b2', user_id: USER, started_at: iso(T0 + 40 * MIN), planned_minutes: 25 });
    db.seed('interval_blocks', { id: 'b3', user_id: OTHER, started_at: iso(T0 + 80 * MIN), planned_minutes: 25 });
    const rows = await db.getAll<BlockRow>(RECENT_BLOCKS_SQL, [USER, 30]);
    expect(rows.map((row) => row.id)).toEqual(['b2', 'b1']);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['effort_rating', 'ended_at', 'id', 'interrupted', 'planned_minutes', 'started_at'].sort(),
    );
  });

  it('counts today from the start of the local day', async () => {
    const since = iso(T0 + 2 * MIN);
    db.seed('interval_blocks', { id: 'b0', user_id: USER, started_at: iso(T0 - 60 * MIN), planned_minutes: 25 });
    db.seed('interval_blocks', { id: 'b1', user_id: USER, started_at: iso(T0 + 5 * MIN), planned_minutes: 25 });
    db.seed('interval_blocks', { id: 'b9', user_id: OTHER, started_at: iso(T0 + 5 * MIN), planned_minutes: 25 });
    expect((await db.getAll<BlockRow>(TODAY_BLOCKS_SQL, [USER, since])).map((row) => row.id)).toEqual(['b1']);
    // s3 (index 2) and s4, s5 were created at or after `since`; s6/s7 at T0 (index 0).
    expect(await db.get<{ n: number }>(TODAY_SETS_SQL, [USER, since])).toEqual({ n: 3 });
  });

  it('feeds groupWorkouts end to end', async () => {
    const workouts = await db.getAll<WorkoutRow>(RECENT_WORKOUTS_SQL, [USER, 30]);
    const sets = await db.getAll<HistorySetRow>(RECENT_SETS_SQL, [USER, 30]);
    const grouped = groupWorkouts(workouts, sets);
    expect(grouped.map((workout) => workout.id)).toEqual(['w2', 'w1']);
    expect(grouped[1].exercises.map((group) => [group.name, group.sets.map((s) => s.id)])).toEqual([
      ['Goblet squat (renamed)', ['s1', 's3']],
      ['Plank', ['s2']],
      ['Doorframe row', ['s4']],
      ['Old exercise', ['s5']],
    ]);
    expect(grouped[1].setCount).toBe(5);
  });
});

describe('focusBlockFromRow', () => {
  it('counts focused minutes, capped at the planned length', () => {
    expect(focusBlockFromRow(block('a', T0, T0 + 25 * MIN))).toEqual({
      id: 'a',
      startedAt: T0,
      plannedMinutes: 25,
      minutes: 25,
      effort: null,
      interrupted: false,
      finished: true,
    });
    // Paused for 10 minutes: 35 on the clock, 25 focused.
    expect(focusBlockFromRow(block('b', T0, T0 + 35 * MIN)).minutes).toBe(25);
    expect(focusBlockFromRow(block('c', T0, T0 + 12 * MIN + 20_000, { interrupted: 1, effort_rating: 3 }))).toMatchObject({
      minutes: 12,
      interrupted: true,
      effort: 3,
    });
  });

  it('handles unfinished blocks and bad values', () => {
    expect(focusBlockFromRow(block('d', T0, null))).toMatchObject({ minutes: null, finished: false });
    expect(focusBlockFromRow({ ...block('e', T0, T0 + MIN), started_at: 'garbage' })).toMatchObject({ startedAt: null, minutes: null });
    expect(focusBlockFromRow({ ...block('f', T0, T0 + 5 * MIN), planned_minutes: null }).minutes).toBe(5);
    expect(focusBlockFromRow(block('g', T0, T0 + MIN, { effort_rating: 9 })).effort).toBeNull();
    expect(focusBlockFromRow(block('h', T0 + MIN, T0)).minutes).toBe(0);
  });
});

describe('summarizeToday', () => {
  it('adds up blocks, focused minutes and sets', () => {
    expect(summarizeToday([], 0)).toEqual({ blocks: 0, focusMinutes: 0, sets: 0 });
    expect(summarizeToday([], null)).toEqual({ blocks: 0, focusMinutes: 0, sets: 0 });
    expect(
      summarizeToday(
        [block('a', T0, T0 + 25 * MIN), block('b', T0, T0 + 10 * MIN, { interrupted: 1 }), block('c', T0, null)],
        14,
      ),
    ).toEqual({ blocks: 3, focusMinutes: 35, sets: 14 });
  });
});

describe('groupWorkouts', () => {
  const set = (id: string, workout: string | null, name: string | null, index: number | null): HistorySetRow => ({
    id,
    workout_session_id: workout,
    exercise_id: null,
    display_name: name,
    set_index: index,
    reps: 5,
    weight_lbs: null,
    rpe: null,
    target_reps: 5,
    set_type: 'weird',
  });

  it('keeps the workout order, sorts sets by index and names unnamed sets', () => {
    const grouped = groupWorkouts(
      [
        { id: 'w1', logged_at: iso(T0), kind: 'micro', duration_minutes: 10 },
        { id: 'w2', logged_at: null, kind: 'yoga', duration_minutes: null },
      ],
      [set('b', 'w1', 'Row', 1), set('a', 'w1', 'Squat', 0), set('c', 'w1', ' ', 2), set('x', null, 'Lost', 0), set('y', 'w9', 'Other', 0)],
    );
    expect(grouped[0].exercises.map((group) => group.name)).toEqual(['Squat', 'Row', UNKNOWN_EXERCISE]);
    expect(grouped[0].exercises[0].sets[0].setType).toBe('normal');
    expect(grouped[1]).toEqual({ id: 'w2', loggedAt: null, kind: null, durationMinutes: null, exercises: [], setCount: 0 });
  });
});

describe('plain-word descriptions', () => {
  const entry = (extra: Partial<SetEntry>): SetEntry => ({
    id: 's',
    reps: 10,
    weightLbs: null,
    rpe: null,
    targetReps: 10,
    setType: 'normal',
    ...extra,
  });

  it('describes sets', () => {
    expect(describeSet(entry({ weightLbs: 25 }), 'reps', 'lb')).toBe('10 reps · 25 lb');
    expect(describeSet(entry({ weightLbs: 25 }), 'reps', 'kg')).toBe('10 reps · 11.3 kg');
    expect(describeSet(entry({ reps: 8 }), 'reps', 'lb')).toBe('8 of 10 reps');
    expect(describeSet(entry({ reps: 1, targetReps: 1 }), 'reps', 'lb')).toBe('1 rep');
    expect(describeSet(entry({ reps: 1, targetReps: null }), 'reps', 'lb')).toBe('1 rep');
    expect(describeSet(entry({ reps: 40, targetReps: 40, weightLbs: 0 }), 'time', 'lb')).toBe('40 s');
    expect(describeSet(entry({ reps: 35, targetReps: 40, setType: 'drop' }), 'time', 'lb')).toBe('35 of 40 s · drop set');
    expect(describeSet(entry({ reps: 3, targetReps: 3, setType: 'rest_pause', weightLbs: 100 }), 'reps', 'lb')).toBe(
      '3 reps · 100 lb · rest-pause',
    );
    expect(describeSet(entry({ reps: null, targetReps: null }), 'reps', 'lb')).toBe('0 reps');
  });

  it('describes workouts and blocks', () => {
    expect(describeWorkout({ kind: 'micro', durationMinutes: 10, setCount: 12 })).toBe('Circuit · 10 min · 12 sets');
    expect(describeWorkout({ kind: 'full', durationMinutes: null, setCount: 1 })).toBe('Full session · 1 set');
    expect(describeWorkout({ kind: 'walk', durationMinutes: 20, setCount: 0 })).toBe('Walk · 20 min · 0 sets');
    expect(describeBlock(focusBlockFromRow(block('a', T0, T0 + 25 * MIN, { effort_rating: 4 })))).toBe(
      '25 min · effort 4 of 5',
    );
    expect(describeBlock(focusBlockFromRow(block('b', T0, T0 + 12 * MIN, { interrupted: 1 })))).toBe(
      '12 of 25 min · ended early · effort not rated',
    );
    expect(describeBlock(focusBlockFromRow(block('c', T0, null)))).toBe('Not finished');
  });

  it('says today and yesterday in words', () => {
    const now = new Date(2026, 9, 8, 15, 0).getTime();
    expect(describeWhen(new Date(2026, 9, 8, 9, 30).getTime(), now)).toMatch(/^Today, /);
    expect(describeWhen(new Date(2026, 9, 7, 23, 59).getTime(), now)).toMatch(/^Yesterday, /);
    expect(describeWhen(new Date(2026, 9, 6, 7, 15).getTime(), now)).not.toMatch(/^(Today|Yesterday)/);
    expect(describeWhen(null, now)).toBe('Unknown time');
  });
});

describe('time helpers', () => {
  it('finds the start of the local day and parses timestamps', () => {
    const at = new Date(2026, 9, 8, 15, 42, 10).getTime();
    expect(startOfLocalDay(at)).toBe(new Date(2026, 9, 8).getTime());
    expect(parseTime('2026-10-08T09:30:00.123Z')).toBe(Date.UTC(2026, 9, 8, 9, 30, 0, 123));
    expect(parseTime('')).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(parseTime('nope')).toBeNull();
  });
});
