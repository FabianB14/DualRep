/**
 * The Phase 1 gate, end to end on the phone's database with no network: a study → lift → study cycle,
 * once with a home setup made by the one-tap choice and once with a gym setup. It runs the real cycle
 * store, reducer, circuit builder, spotter and repo SQL against an in-memory SQLite database with the
 * PowerSync client tables (history/testing/sqliteDb.ts); only notifications, haptics and the clock
 * are fakes. Then it checks:
 * - every row written would pass the server: owner = the user, the CHECK ranges and enums of the
 *   first migration, the parents the RLS policies look up, ISO timestamps with milliseconds;
 * - nothing was written to the library (exercises) and nothing called the network (no Supabase here);
 * - an app restart in the middle of the second block picks up exactly where it was, with no row
 *   written twice;
 * - the History and Today queries show everything.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SYSTEM_PRESET_IDS, TABLE } from '@/db/constants';
import {
  focusBlockFromRow,
  groupWorkouts,
  RECENT_BLOCKS_SQL,
  RECENT_SETS_SQL,
  RECENT_WORKOUTS_SQL,
  summarizeToday,
  TODAY_BLOCKS_SQL,
  TODAY_SETS_SQL,
  type BlockRow,
  type HistorySetRow,
  type WorkoutRow,
} from '@/features/history/history';
import type { SqliteDb } from '@/features/history/testing/sqliteDb';
import { mergePresets, resolvePreset } from '@/features/presets/presets';
import { resolveSetup, setupFromRow, type SetupTemplate } from '@/features/setups/setups';
import { createSetupFromTemplate } from '@/features/setups/setupsRepo';
import { libraryView } from '@/features/training/library';
import { STARTER_LIBRARY_BY_ID } from '@/features/training/starterLibrary';
import type { Unit } from '@/features/training/types';

import { CYCLE_STATE_KEY, type CycleState, type MoveState } from '../cycleMachine';
import * as cycleRepo from '../cycleRepo';
import { CycleStore, type CycleStoreDeps } from '../cycleStore';
import { readLocalState, writeLocalState } from '../localState';
import { planFromChoices, type MoveLength } from '../ui/startPlan';

jest.mock('../../../db/database', () => ({
  db: jest
    .requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb')
    .createSqliteDb(),
}));
jest.mock('@powersync/react-native', () => ({ useQuery: jest.fn() }));

const db = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;

const USER = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The loop's tables, in the order rows are created. */
const LOOP_TABLES = [
  TABLE.equipment_setups,
  TABLE.study_sessions,
  TABLE.interval_blocks,
  TABLE.workout_sessions,
  TABLE.transitions,
  TABLE.exercise_sets,
] as const;

type Row = Record<string, unknown>;

/** Lets every queued promise (saves, effects, circuit preparation) finish. */
async function settle(): Promise<void> {
  for (let k = 0; k < 40; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The phone: a clock, ids, the alerts it holds, and a store built like useCycle builds it. */
function phone() {
  const io = { clock: T0, ids: 0, alerts: new Map<string, number>(), haptics: [] as string[] };
  const deps: CycleStoreDeps = {
    readState: () => readLocalState(CYCLE_STATE_KEY),
    writeState: (state) => writeLocalState(CYCLE_STATE_KEY, state),
    repo: cycleRepo,
    scheduleBlockEnd: async (endsAt, content) => {
      io.alerts.set(content.identifier ?? 'alert', endsAt);
      return content.identifier ?? null;
    },
    cancelScheduled: async (id) => {
      io.alerts.delete(id);
    },
    haptic: (intent) => io.haptics.push(intent),
    now: () => io.clock,
    newId: () => {
      io.ids += 1;
      return `aaaaaaaa-0000-4000-8000-${io.ids.toString(16).padStart(12, '0')}`;
    },
    setTimeout: () => {
      throw new Error('No retry expected: every write should succeed');
    },
    clearTimeout: () => undefined,
  };
  return { io, deps };
}

async function openStore(deps: CycleStoreDeps, unit: Unit): Promise<CycleStore> {
  const store = new CycleStore(USER, deps);
  // What useLibrary gives on a fresh install in airplane mode: no synced rows, the bundled library.
  const view = libraryView([], USER);
  store.setContext({ library: view.circuitPool, byId: view.byId, unit });
  await store.load();
  await settle();
  return store;
}

function current(store: CycleStore): CycleState {
  const state = store.getSnapshot().state;
  if (!state) throw new Error('The cycle has not loaded');
  return state;
}

/** Taps "Done" through the move block (waiting out each rest); the last set of an item misses once. */
async function doTheWorkout(store: CycleStore, io: { clock: number }, options: { missOnce: boolean }): Promise<number> {
  let sets = 0;
  let missed = !options.missOnce;
  store.rateBlock(4);
  for (let guard = 0; guard < 200; guard += 1) {
    const state = current(store);
    if (state.phase !== 'move') return sets;
    if (state.rest?.endsAt) io.clock = Math.max(io.clock, state.rest.endsAt);
    io.clock += 30 * SEC; // the set itself
    store.tick();
    const station = state.items[state.position.itemIndex];
    const target = (state.circuit.items[state.position.itemIndex].measure === 'time'
      ? station.next.targetSeconds
      : station.next.targetReps) ?? 0;
    if (!missed && target >= 6) {
      // A miss by three: the spotter drops the load (or the reps) for the next set of this exercise.
      missed = true;
      store.logSet({ done: target - 3, rpe: 10, expectedSetIndex: (state as MoveState).setsLogged });
    } else {
      store.logSet({ rpe: 8, expectedSetIndex: (state as MoveState).setsLogged });
    }
    sets += 1;
    await settle();
  }
  throw new Error('The workout never ended');
}

/** What the server would refuse in this row (an empty list when it would store it). */
function serverProblems(table: string, row: Row, all: Record<string, Row[]>): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(`${table}.${what}: ${JSON.stringify(row)}`);
  };
  const exists = (parent: string, id: unknown) => all[parent].some((entry) => entry.id === id);
  const wholeAtLeast = (value: unknown, min: number) => value === null || (Number.isInteger(value) && (value as number) >= min);
  const numberAtLeast = (value: unknown, min: number) =>
    value === null || (typeof value === 'number' && Number.isFinite(value) && value >= min);
  const isoOrNull = (value: unknown) => value === null || (typeof value === 'string' && ISO_MS.test(value));

  check(typeof row.id === 'string' && row.id.length === 36, 'id');
  check(row.user_id === USER, 'user_id is the signed-in user (RLS)');
  check(typeof row.created_at === 'string' && ISO_MS.test(row.created_at), 'created_at');
  check(typeof row.updated_at === 'string' && ISO_MS.test(row.updated_at), 'updated_at');
  switch (table) {
    case TABLE.equipment_setups: {
      const name = String(row.name ?? '');
      check(name.length >= 1 && name.length <= 60, 'name 1–60');
      check(row.location === 'gym' || row.location === 'home', 'location');
      check(Array.isArray(JSON.parse(String(row.equipment))), 'equipment is an array');
      break;
    }
    case TABLE.study_sessions:
      check(typeof row.focus_subject === 'string' && [...row.focus_subject].length <= 200, 'focus_subject');
      break;
    case TABLE.interval_blocks:
      check(exists(TABLE.study_sessions, row.study_session_id), 'study_session_id is an own session (RLS)');
      check(Number.isInteger(row.planned_minutes) && (row.planned_minutes as number) >= 1 && (row.planned_minutes as number) <= 120, 'planned_minutes');
      check(row.interrupted === 0 || row.interrupted === 1, 'interrupted not null');
      check(row.effort_rating === null || [1, 2, 3, 4, 5].includes(row.effort_rating as number), 'effort_rating');
      check(row.mode === 'seated' || row.mode === 'on_the_go', 'mode');
      check(isoOrNull(row.started_at) && isoOrNull(row.ended_at), 'timestamps');
      break;
    case TABLE.workout_sessions:
      check(['micro', 'full', 'walk'].includes(String(row.kind)), 'kind');
      check(typeof row.logged_at === 'string' && ISO_MS.test(row.logged_at), 'logged_at');
      check(wholeAtLeast(row.duration_minutes, 0), 'duration_minutes');
      check(
        row.preset_id === null || Object.values<string>(SYSTEM_PRESET_IDS).includes(String(row.preset_id)),
        'preset_id is a system preset',
      );
      check(row.setup_id === null || exists(TABLE.equipment_setups, row.setup_id), 'setup_id is an own setup');
      break;
    case TABLE.transitions:
      check(exists(TABLE.interval_blocks, row.interval_block_id), 'interval_block_id is an own block (RLS)');
      check(row.workout_session_id === null || exists(TABLE.workout_sessions, row.workout_session_id), 'workout_session_id');
      check(row.accepted === null || row.accepted === 0 || row.accepted === 1, 'accepted');
      check(typeof JSON.parse(String(row.proposal)) === 'object', 'proposal is JSON');
      break;
    case TABLE.exercise_sets:
      check(exists(TABLE.workout_sessions, row.workout_session_id), 'workout_session_id is an own workout (RLS)');
      check(STARTER_LIBRARY_BY_ID.has(String(row.exercise_id)), 'exercise_id is a library exercise');
      check(typeof row.exercise_name === 'string' && row.exercise_name.length > 0, 'exercise_name is filled');
      check(wholeAtLeast(row.set_index, 0) && row.set_index !== null, 'set_index');
      check(wholeAtLeast(row.reps, 0) && wholeAtLeast(row.target_reps, 0) && wholeAtLeast(row.rest_seconds, 0), 'counts ≥ 0');
      check(numberAtLeast(row.weight_lbs, 0) && numberAtLeast(row.target_weight_lbs, 0), 'weights ≥ 0');
      check(row.rpe === null || ((row.rpe as number) >= 1 && (row.rpe as number) <= 10), 'rpe 1–10');
      check(['normal', 'drop', 'rest_pause'].includes(String(row.set_type)), 'set_type');
      break;
  }
  return problems;
}

function snapshotRows(): Record<string, Row[]> {
  return Object.fromEntries(LOOP_TABLES.map((table) => [table, db.rows(table)]));
}

async function runCycle({
  template,
  moveLength,
  fullMinutes = 30,
  unit,
}: {
  template: SetupTemplate;
  moveLength: MoveLength;
  fullMinutes?: number;
  unit: Unit;
}) {
  const { io, deps } = phone();

  // Start panel with no setup yet: one tap on "Home, just my body" or "Gym" saves a setup. The profile
  // has not synced (airplane mode right after signing in), so it cannot become the default yet.
  const setupId = await createSetupFromTemplate(USER, template, [], { makeDefault: true, nowMs: io.clock, id: deps.newId() });
  const setup = resolveSetup(db.rows(TABLE.equipment_setups).map((row) => setupFromRow(row as never)), null);
  expect(setup?.id).toBe(setupId);
  const plan = planFromChoices({
    focusSubject: 'Organic chemistry',
    blockMinutes: 25,
    preset: resolvePreset(mergePresets([], USER), null),
    setup,
    quick: null,
    moveLength,
    fullMinutes,
  });
  if (!plan) throw new Error('No plan');

  let store = await openStore(deps, unit);
  store.start(plan);
  await settle();
  const focus = current(store);
  expect(focus.phase).toBe('focus');
  if (focus.phase !== 'focus') throw new Error('unreachable');
  // "Tracy prepares the movement block while the timer is still running."
  expect(focus.circuit?.items.length).toBeGreaterThan(0);
  expect(io.alerts.get(focus.notificationId)).toBe(T0 + 25 * MIN);

  // The timer runs out: the block ends and the workout starts with no tap.
  io.clock = T0 + 25 * MIN;
  store.tick();
  await settle();
  expect(current(store).phase).toBe('move');
  expect(io.haptics).toContain('success');
  expect(io.alerts.size).toBe(0);

  const sets = await doTheWorkout(store, io, { missOnce: true });
  const back = current(store);
  expect(back.phase).toBe('return');

  // The countdown runs out: the second block starts on its own, in the same study session.
  if (back.phase !== 'return' || back.countdown.endsAt === null) throw new Error('unreachable');
  io.clock = back.countdown.endsAt + 500;
  store.tick();
  await settle();
  const second = current(store);
  expect(second.phase).toBe('focus');
  if (second.phase !== 'focus') throw new Error('unreachable');
  expect(second.blockNumber).toBe(2);
  expect(second.sessionId).toBe(focus.sessionId);
  expect(second.circuit?.items.length).toBeGreaterThan(0);

  // The app is killed ten minutes in and opened again: same block, same timer, nothing written twice.
  const before = snapshotRows();
  const callsBefore = db.calls.length;
  store.dispose();
  io.clock += 10 * MIN;
  store = await openStore(deps, unit);
  const restored = current(store);
  expect(restored.phase).toBe('focus');
  if (restored.phase !== 'focus') throw new Error('unreachable');
  expect(restored.blockId).toBe(second.blockId);
  expect(restored.timer).toEqual(second.timer);
  expect(snapshotRows()).toEqual(before);
  expect(db.calls.slice(callsBefore).some((call) => /^\s*(INSERT|UPDATE|DELETE)/i.test(call.sql) && !call.sql.includes('local_state'))).toBe(false);

  // "Finish for now" five minutes later.
  io.clock += 5 * MIN;
  store.finish();
  await settle();
  const done = current(store);
  expect(done.phase).toBe('idle');
  expect(done.pending).toEqual([]);
  expect(io.alerts.size).toBe(0);
  // What is on disk is the finished cycle, ready for the next one.
  expect((await readLocalState<CycleState>(CYCLE_STATE_KEY))?.phase).toBe('idle');

  return { io, sets, firstBlockId: focus.blockId, secondBlockId: second.blockId, workoutId: focus.workoutId, setupId };
}

beforeEach(() => {
  db.reset();
});

describe.each([
  { name: 'home, just my body, a 10-minute circuit', template: 'home_bodyweight' as const, moveLength: '10' as const, unit: 'lb' as const, kind: 'micro' },
  { name: 'gym, a 30-minute full session, in kilograms', template: 'gym' as const, moveLength: 'full' as const, unit: 'kg' as const, kind: 'full' },
])('airplane mode: study → lift → study ($name)', ({ template, moveLength, unit, kind }) => {
  it('every row is one the server accepts, nothing touches the library, and History shows it all', async () => {
    const { sets, firstBlockId, secondBlockId, workoutId, setupId } = await runCycle({ template, moveLength, unit });
    const rows = snapshotRows();

    // Exactly the rows of one cycle.
    expect(rows[TABLE.equipment_setups]).toHaveLength(1);
    expect(rows[TABLE.study_sessions]).toHaveLength(1);
    expect(rows[TABLE.study_sessions][0].focus_subject).toBe('Organic chemistry');
    expect(rows[TABLE.interval_blocks].map((row) => row.id).sort()).toEqual([firstBlockId, secondBlockId].sort());
    expect(rows[TABLE.workout_sessions]).toHaveLength(1);
    expect(rows[TABLE.transitions]).toHaveLength(1);
    expect(rows[TABLE.exercise_sets]).toHaveLength(sets);
    expect(sets).toBeGreaterThan(2);

    const first = rows[TABLE.interval_blocks].find((row) => row.id === firstBlockId)!;
    const second = rows[TABLE.interval_blocks].find((row) => row.id === secondBlockId)!;
    expect(first).toMatchObject({ planned_minutes: 25, interrupted: 0, effort_rating: 4, ended_at: new Date(T0 + 25 * MIN).toISOString() });
    expect(second).toMatchObject({ interrupted: 1, effort_rating: null });
    expect(second.ended_at).not.toBeNull();

    const workout = rows[TABLE.workout_sessions][0];
    expect(workout).toMatchObject({ id: workoutId, kind, preset_id: SYSTEM_PRESET_IDS.full_body, setup_id: setupId });
    expect(workout.duration_minutes).toEqual(expect.any(Number));
    expect(rows[TABLE.transitions][0]).toMatchObject({ interval_block_id: firstBlockId, workout_session_id: workoutId, accepted: 1 });

    const setRows = [...rows[TABLE.exercise_sets]].sort((a, b) => (a.set_index as number) - (b.set_index as number));
    expect(setRows.map((row) => row.set_index)).toEqual(setRows.map((_, index) => index));
    expect(setRows[0].rest_seconds).toBeNull();
    expect(setRows.some((row) => row.set_type !== 'normal' || (row.reps as number) < (row.target_reps as number))).toBe(true);

    // The server would take every row.
    const problems = LOOP_TABLES.flatMap((table) => rows[table].flatMap((row) => serverProblems(table, row, rows)));
    expect(problems).toEqual([]);

    // Library rows are read-only, and the profile (not synced yet) was never created by the device.
    const writes = db.calls.filter((call) => /^\s*(INSERT|UPDATE|DELETE)/i.test(call.sql));
    expect(writes.filter((call) => new RegExp(`\\b${TABLE.exercises}\\b`).test(call.sql))).toEqual([]);
    expect(writes.filter((call) => /^\s*INSERT INTO profiles\b/i.test(call.sql))).toEqual([]);
    expect(db.rows(TABLE.exercises)).toEqual([]);

    // History: both blocks, the workout with every set under its exercise's name.
    const blocks = await db.getAll<BlockRow>(RECENT_BLOCKS_SQL, [USER, 30]);
    expect(blocks.map(focusBlockFromRow).map((block) => [block.id, block.finished])).toEqual([
      [secondBlockId, true],
      [firstBlockId, true],
    ]);
    const workouts = await db.getAll<WorkoutRow>(RECENT_WORKOUTS_SQL, [USER, 30]);
    const history = groupWorkouts(workouts, await db.getAll<HistorySetRow>(RECENT_SETS_SQL, [USER, 30]));
    expect(history).toHaveLength(1);
    expect(history[0].setCount).toBe(sets);
    const names = new Set(setRows.map((row) => row.exercise_name));
    expect(history[0].exercises.map((group) => group.name).sort()).toEqual([...names].sort());

    // Today on Home.
    const since = new Date(T0 - 9 * 60 * MIN).toISOString();
    const today = summarizeToday(
      await db.getAll<BlockRow>(TODAY_BLOCKS_SQL, [USER, since]),
      (await db.get<{ n: number }>(TODAY_SETS_SQL, [USER, since])).n,
    );
    expect(today).toEqual({ blocks: 2, focusMinutes: 25 + 15, sets });
  });
});
