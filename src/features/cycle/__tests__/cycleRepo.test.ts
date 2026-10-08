import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Circuit } from '@/features/training/types';

import {
  endFocusBlock,
  finishMoveBlock,
  lastSessionSetsFor,
  loggedSetFromRow,
  logSet,
  rateBlock,
  skipMoveBlock,
  startFocusBlock,
  startMoveBlock,
  type LogSetInput,
} from '../cycleRepo';

// database.ts constructs the native PowerSync database, so it is replaced by a recording fake whose
// write transactions run against a recording `tx`. (jest.mock is hoisted; `mock`-prefixed names may
// be used inside the factory.)
type Call = { via: 'tx' | 'db'; method: string; sql: string; params: unknown[] };
function mockCreateDb() {
  const calls: Call[] = [];
  /** Rows "already in the table", by id, for the existence checks. */
  const existing = new Set<string>();
  const answers = { count: 0, rows: [] as unknown[] };
  const record = (via: Call['via'], method: string) => async (sql: string, params: unknown[] = []) => {
    calls.push({ via, method, sql, params });
    if (method === 'getOptional') return existing.has(String(params[0])) ? { id: params[0] } : null;
    if (method === 'get') return { n: answers.count };
    if (method === 'getAll') return answers.rows;
    return { rowsAffected: 1 };
  };
  const tx = { execute: record('tx', 'execute'), getOptional: record('tx', 'getOptional'), get: record('tx', 'get') };
  return {
    calls,
    existing,
    answers,
    transactions: 0,
    execute: record('db', 'execute'),
    getAll: record('db', 'getAll'),
    getOptional: record('db', 'getOptional'),
    async writeTransaction<T>(callback: (context: typeof tx) => Promise<T>): Promise<T> {
      this.transactions += 1;
      return callback(tx);
    },
  };
}
jest.mock('../../../db/database', () => ({ db: mockCreateDb() }));

const mockDb = (jest.requireMock('../../../db/database') as { db: ReturnType<typeof mockCreateDb> }).db;

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const BLOCK = '44444444-4444-4444-8444-444444444444';
const WORKOUT = '55555555-5555-4555-8555-555555555555';
const TRANSITION = '66666666-6666-4666-8666-666666666666';
const SET = '77777777-7777-4777-8777-777777777777';
const SQUAT = '00000000-0000-4000-8000-0000000e0001';
const T0 = Date.UTC(2026, 9, 8, 9, 30, 0, 250);
const ISO = '2026-10-08T09:30:00.250Z';
const LATER = T0 + 25 * 60_000;
const LATER_ISO = '2026-10-08T09:55:00.250Z';

const CIRCUIT: Circuit = {
  version: 1,
  source: 'default',
  kind: 'micro',
  minutes: 10,
  rounds: 3,
  items: [
    {
      exerciseId: SQUAT,
      name: 'Goblet squat',
      measure: 'reps',
      movementPattern: 'squat',
      region: 'lower',
      sets: 3,
      targetReps: 10,
      targetSeconds: null,
      targetWeightLbs: 25,
      restSeconds: 20,
    },
  ],
  estimatedSeconds: 150,
  location: 'home',
  split: { lower: 100, upper: 0, core: 0, cardio: 0 },
};

function sqlOf(): [string, string, unknown[]][] {
  return mockDb.calls.map((call) => [call.method, call.sql, call.params]);
}

beforeEach(() => {
  mockDb.calls.length = 0;
  mockDb.existing.clear();
  mockDb.transactions = 0;
  mockDb.answers.count = 0;
  mockDb.answers.rows = [];
});

describe('startFocusBlock', () => {
  const input = {
    userId: USER,
    sessionId: SESSION,
    createSession: true,
    focusSubject: '  Organic chemistry  ',
    blockId: BLOCK,
    plannedMinutes: 25,
    startedAt: T0,
  };

  it('inserts the study session and the block in one transaction', async () => {
    await startFocusBlock(input);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.calls.every((call) => call.via === 'tx')).toBe(true);
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM study_sessions WHERE id = ?', [SESSION]],
      [
        'execute',
        'INSERT INTO study_sessions (id, user_id, focus_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [SESSION, USER, 'Organic chemistry', ISO, ISO],
      ],
      ['getOptional', 'SELECT id FROM interval_blocks WHERE id = ?', [BLOCK]],
      [
        'execute',
        'INSERT INTO interval_blocks (id, user_id, study_session_id, planned_minutes, started_at, interrupted, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [BLOCK, USER, SESSION, 25, ISO, 0, 'seated', ISO, ISO],
      ],
    ]);
  });

  it('later blocks of the cycle only insert the block', async () => {
    await startFocusBlock({ ...input, createSession: false });
    expect(sqlOf().map(([method, sql]) => `${method} ${sql.split(' (')[0]}`)).toEqual([
      'getOptional SELECT id FROM interval_blocks WHERE id = ?',
      'execute INSERT INTO interval_blocks',
    ]);
  });

  it('is idempotent: rows that already exist are not inserted again', async () => {
    mockDb.existing.add(SESSION);
    mockDb.existing.add(BLOCK);
    await startFocusBlock(input);
    expect(mockDb.calls.filter((call) => call.method === 'execute')).toEqual([]);
  });

  it('cuts the subject to 200 characters and refuses a block length the database would', async () => {
    await startFocusBlock({ ...input, focusSubject: 'a'.repeat(300) });
    expect((mockDb.calls[1].params[2] as string).length).toBe(200);
    await expect(startFocusBlock({ ...input, plannedMinutes: 0 })).rejects.toThrow(RangeError);
    await expect(startFocusBlock({ ...input, plannedMinutes: 121 })).rejects.toThrow(RangeError);
    await expect(startFocusBlock({ ...input, plannedMinutes: 2.5 })).rejects.toThrow(RangeError);
    await expect(startFocusBlock({ ...input, startedAt: Number.NaN })).rejects.toThrow(RangeError);
  });
});

describe('endFocusBlock and rateBlock', () => {
  it('records the end and whether the block was interrupted', async () => {
    await endFocusBlock(BLOCK, T0, true, LATER);
    await endFocusBlock(BLOCK, T0, false, LATER);
    expect(mockDb.transactions).toBe(2);
    expect(sqlOf()).toEqual([
      ['execute', 'UPDATE interval_blocks SET ended_at = ?, interrupted = ?, updated_at = ? WHERE id = ?', [ISO, 1, LATER_ISO, BLOCK]],
      ['execute', 'UPDATE interval_blocks SET ended_at = ?, interrupted = ?, updated_at = ? WHERE id = ?', [ISO, 0, LATER_ISO, BLOCK]],
    ]);
  });

  it('stores the effort rating 1–5 and refuses anything else', async () => {
    await rateBlock(BLOCK, 4, T0);
    expect(sqlOf()).toEqual([
      ['execute', 'UPDATE interval_blocks SET effort_rating = ?, updated_at = ? WHERE id = ?', [4, ISO, BLOCK]],
    ]);
    for (const bad of [0, 6, 3.5, Number.NaN]) await expect(rateBlock(BLOCK, bad, T0)).rejects.toThrow(RangeError);
  });
});

describe('startMoveBlock', () => {
  const input = {
    userId: USER,
    workoutId: WORKOUT,
    kind: 'micro' as const,
    loggedAt: T0,
    presetId: '00000000-0000-4000-8000-0000000000a3',
    setupId: '88888888-8888-4888-8888-888888888888',
    transition: { id: TRANSITION, blockId: BLOCK, proposal: CIRCUIT },
  };

  it('inserts the workout and, after a focus block, the transition with the circuit as its proposal', async () => {
    await startMoveBlock(input);
    expect(mockDb.transactions).toBe(1);
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM workout_sessions WHERE id = ?', [WORKOUT]],
      [
        'execute',
        'INSERT INTO workout_sessions (id, user_id, logged_at, kind, preset_id, setup_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [WORKOUT, USER, ISO, 'micro', input.presetId, input.setupId, ISO, ISO],
      ],
      ['getOptional', 'SELECT id FROM transitions WHERE id = ?', [TRANSITION]],
      [
        'execute',
        'INSERT INTO transitions (id, user_id, interval_block_id, workout_session_id, proposal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [TRANSITION, USER, BLOCK, WORKOUT, JSON.stringify(CIRCUIT), ISO, ISO],
      ],
    ]);
    // accepted is not written: it stays null until the first set or a skip.
    expect(JSON.parse(mockDb.calls[3].params[4] as string)).toEqual(CIRCUIT);
  });

  it('a move block on its own has no transition; no preset or setup is fine', async () => {
    await startMoveBlock({ ...input, kind: 'full', presetId: null, setupId: null, transition: null });
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM workout_sessions WHERE id = ?', [WORKOUT]],
      [
        'execute',
        'INSERT INTO workout_sessions (id, user_id, logged_at, kind, preset_id, setup_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [WORKOUT, USER, ISO, 'full', null, null, ISO, ISO],
      ],
    ]);
  });

  it('is idempotent, and refuses a kind the database would', async () => {
    mockDb.existing.add(WORKOUT);
    mockDb.existing.add(TRANSITION);
    await startMoveBlock(input);
    expect(mockDb.calls.filter((call) => call.method === 'execute')).toEqual([]);
    await expect(startMoveBlock({ ...input, kind: 'walk' as never })).rejects.toThrow(RangeError);
  });
});

describe('logSet', () => {
  const input: LogSetInput = {
    id: SET,
    userId: USER,
    workoutId: WORKOUT,
    transitionId: TRANSITION,
    exerciseId: SQUAT,
    exerciseName: 'Goblet squat',
    setIndex: 0,
    reps: 10,
    weightLbs: 25,
    rpe: 8,
    targetReps: 10,
    targetWeightLbs: 25,
    restSeconds: null,
    setType: 'normal',
    loggedAt: T0,
  };
  const INSERT =
    'INSERT INTO exercise_sets (id, user_id, workout_session_id, exercise_id, exercise_name, set_index, reps, weight_lbs, rpe, target_reps, target_weight_lbs, rest_seconds, set_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  it("inserts the set with the exercise's name; the first set accepts the transition", async () => {
    await logSet(input);
    expect(mockDb.transactions).toBe(1);
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM exercise_sets WHERE id = ?', [SET]],
      ['execute', INSERT, [SET, USER, WORKOUT, SQUAT, 'Goblet squat', 0, 10, 25, 8, 10, 25, null, 'normal', ISO, ISO]],
      ['execute', 'UPDATE transitions SET accepted = ?, updated_at = ? WHERE id = ?', [1, ISO, TRANSITION]],
    ]);
  });

  it('later sets, and sets without a transition, only insert the set', async () => {
    await logSet({ ...input, setIndex: 4, restSeconds: 35, setType: 'drop', weightLbs: 20, rpe: null });
    await logSet({ ...input, transitionId: null });
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM exercise_sets WHERE id = ?', [SET]],
      ['execute', INSERT, [SET, USER, WORKOUT, SQUAT, 'Goblet squat', 4, 10, 20, null, 10, 25, 35, 'drop', ISO, ISO]],
      ['getOptional', 'SELECT id FROM exercise_sets WHERE id = ?', [SET]],
      ['execute', INSERT, [SET, USER, WORKOUT, SQUAT, 'Goblet squat', 0, 10, 25, 8, 10, 25, null, 'normal', ISO, ISO]],
    ]);
  });

  it('a timed set stores its seconds in reps and target_reps; bodyweight has no weight', async () => {
    await logSet({ ...input, setIndex: 2, reps: 40, targetReps: 40, weightLbs: null, targetWeightLbs: null });
    expect(mockDb.calls[1].params.slice(5, 11)).toEqual([2, 40, null, 8, 40, null]);
  });

  it('a retried write never inserts the set twice (the accept is the same value again)', async () => {
    mockDb.existing.add(SET);
    await logSet(input);
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM exercise_sets WHERE id = ?', [SET]],
      ['execute', 'UPDATE transitions SET accepted = ?, updated_at = ? WHERE id = ?', [1, ISO, TRANSITION]],
    ]);
  });

  it('refuses values the database CHECKs would', async () => {
    const bad: Partial<LogSetInput>[] = [
      { setIndex: -1 },
      { setIndex: 1.5 },
      { reps: -1 },
      { reps: 2.5 },
      { targetReps: -3 },
      { restSeconds: -1 },
      { weightLbs: -5 },
      { targetWeightLbs: Number.NaN },
      { rpe: 0 },
      { rpe: 11 },
      { setType: 'superset' as never },
    ];
    for (const change of bad) await expect(logSet({ ...input, ...change })).rejects.toThrow(RangeError);
    expect(mockDb.calls).toEqual([]);
  });
});

describe('finishMoveBlock and skipMoveBlock', () => {
  it('finishing stores the length in minutes', async () => {
    await finishMoveBlock(WORKOUT, 11, LATER);
    expect(sqlOf()).toEqual([
      ['execute', 'UPDATE workout_sessions SET duration_minutes = ?, updated_at = ? WHERE id = ?', [11, LATER_ISO, WORKOUT]],
    ]);
    await expect(finishMoveBlock(WORKOUT, -1, LATER)).rejects.toThrow(RangeError);
  });

  it('skipping with no sets refuses the transition and deletes the empty workout', async () => {
    await skipMoveBlock(WORKOUT, TRANSITION, T0);
    expect(mockDb.transactions).toBe(1);
    expect(sqlOf()).toEqual([
      ['get', 'SELECT COUNT(*) AS n FROM exercise_sets WHERE workout_session_id = ?', [WORKOUT]],
      ['execute', 'UPDATE transitions SET accepted = ?, workout_session_id = NULL, updated_at = ? WHERE id = ?', [0, ISO, TRANSITION]],
      ['execute', 'DELETE FROM workout_sessions WHERE id = ?', [WORKOUT]],
    ]);
  });

  it('skipping after sets keeps the workout', async () => {
    mockDb.answers.count = 2;
    await skipMoveBlock(WORKOUT, TRANSITION, T0);
    expect(sqlOf()).toEqual([
      ['get', 'SELECT COUNT(*) AS n FROM exercise_sets WHERE workout_session_id = ?', [WORKOUT]],
      ['execute', 'UPDATE transitions SET accepted = ?, updated_at = ? WHERE id = ?', [0, ISO, TRANSITION]],
    ]);
  });

  it('a move block on its own has no transition to refuse', async () => {
    await skipMoveBlock(WORKOUT, null, T0);
    expect(sqlOf()).toEqual([
      ['get', 'SELECT COUNT(*) AS n FROM exercise_sets WHERE workout_session_id = ?', [WORKOUT]],
      ['execute', 'DELETE FROM workout_sessions WHERE id = ?', [WORKOUT]],
    ]);
  });
});

describe('lastSessionSetsFor', () => {
  const SQL = `SELECT s.exercise_id, s.set_index, s.reps, s.weight_lbs, s.rpe, s.target_reps, s.target_weight_lbs, s.rest_seconds, s.set_type
FROM exercise_sets s
WHERE s.exercise_id IN (?, ?)
  AND s.workout_session_id = (
    SELECT s2.workout_session_id FROM exercise_sets s2
    JOIN workout_sessions w ON w.id = s2.workout_session_id
    WHERE s2.exercise_id = s.exercise_id AND s2.workout_session_id <> ?
    ORDER BY w.logged_at DESC, w.id DESC
    LIMIT 1
  )
ORDER BY s.exercise_id, s.set_index`;

  it("reads each exercise's sets from its most recent earlier workout, oldest first", async () => {
    const row = (exercise: string, index: number, reps: number, type = 'normal') => ({
      exercise_id: exercise,
      set_index: index,
      reps,
      weight_lbs: 25,
      rpe: null,
      target_reps: 10,
      target_weight_lbs: 25,
      rest_seconds: index === 0 ? null : 40,
      set_type: type,
    });
    mockDb.answers.rows = [row('a', 0, 10), row('a', 3, 8), row('a', 6, 2, 'rest_pause'), row('b', 1, 10)];
    const result = await lastSessionSetsFor(['a', 'b', 'a'], { excludeWorkoutId: WORKOUT });
    expect(sqlOf()).toEqual([['getAll', SQL, ['a', 'b', WORKOUT]]]);
    expect(mockDb.calls[0].via).toBe('db');
    expect([...result.keys()]).toEqual(['a', 'b']);
    expect(result.get('a')).toEqual([
      { target: 10, done: 10, targetWeightLbs: 25, weightLbs: 25, rpe: null, restSeconds: null, setType: 'normal' },
      { target: 10, done: 8, targetWeightLbs: 25, weightLbs: 25, rpe: null, restSeconds: 40, setType: 'normal' },
      { target: 10, done: 2, targetWeightLbs: 25, weightLbs: 25, rpe: null, restSeconds: 40, setType: 'rest_pause' },
    ]);
    expect(result.get('b')).toHaveLength(1);
  });

  it('excludes nothing by default and does not query for no exercises', async () => {
    await lastSessionSetsFor(['a']);
    expect(mockDb.calls[0].params).toEqual(['a', '']);
    mockDb.calls.length = 0;
    await expect(lastSessionSetsFor([])).resolves.toEqual(new Map());
    expect(mockDb.calls).toEqual([]);
  });

  it('reads rows defensively (unknown set type → normal, missing reps → 0)', () => {
    expect(
      loggedSetFromRow({
        reps: null,
        weight_lbs: null,
        rpe: 9,
        target_reps: null,
        target_weight_lbs: null,
        rest_seconds: null,
        set_type: 'warmup',
      }),
    ).toEqual({ target: null, done: 0, targetWeightLbs: null, weightLbs: null, rpe: 9, restSeconds: null, setType: 'normal' });
  });
});
