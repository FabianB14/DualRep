import { describe, expect, it } from '@jest/globals';

import { SYSTEM_PRESET_IDS } from '@/db/constants';
import type { Circuit, CircuitItem } from '@/features/training/types';

import {
  blockEndNotificationId,
  CYCLE_RULES,
  CYCLE_STATE_VERSION,
  currentStation,
  cycleReducer,
  initialCycleState,
  nextOpenPosition,
  normalizePlan,
  parseCycleState,
  type BlockIds,
  type CycleEffect,
  type CycleEvent,
  type CycleEventType,
  type CyclePhase,
  type CyclePlanInput,
  type CycleState,
  type FocusState,
  type IdleState,
  type ItemProgress,
  type MoveState,
  type ReturnState,
} from '../cycleMachine';

const USER = '11111111-1111-4111-8111-111111111111';
const T0 = 1_760_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

const PLAN: CyclePlanInput = {
  focusSubject: '  Cell biology  ',
  blockMinutes: 25,
  presetId: SYSTEM_PRESET_IDS.full_body,
  split: { lower: 40, upper: 30, core: 15, cardio: 15 },
  setupId: '22222222-2222-4222-8222-222222222222',
  location: 'home',
  equipment: ['dumbbell', 'band'],
  moveKind: 'micro',
  moveMinutes: 10,
};

const IDS: BlockIds & { sessionId: string } = { sessionId: 'session-1', blockId: 'block-1', workoutId: 'workout-1', transitionId: 'transition-1' };
const IDS2: BlockIds = { blockId: 'block-2', workoutId: 'workout-2', transitionId: 'transition-2' };

function item(id: string, overrides: Partial<CircuitItem> = {}): CircuitItem {
  return {
    exerciseId: id,
    name: `Exercise ${id}`,
    measure: 'reps',
    movementPattern: 'squat',
    region: 'lower',
    sets: 3,
    targetReps: 10,
    targetSeconds: null,
    targetWeightLbs: null,
    restSeconds: 20,
    ...overrides,
  };
}

function circuit(kind: 'micro' | 'full', items: CircuitItem[]): Circuit {
  return {
    version: 1,
    source: 'default',
    kind,
    minutes: kind === 'micro' ? 10 : 30,
    rounds: kind === 'micro' ? 3 : 1,
    items,
    estimatedSeconds: 600,
    location: 'home',
    split: { lower: 40, upper: 30, core: 15, cardio: 15 },
  };
}

/** Three stations, three rounds: bodyweight reps, a timed hold, dumbbell reps at 25 lb. */
const MICRO = circuit('micro', [
  item('a'),
  item('b', { measure: 'time', targetReps: null, targetSeconds: 30, movementPattern: 'core', region: 'core' }),
  item('c', { targetWeightLbs: 25, movementPattern: 'horizontal_push', region: 'upper', restSeconds: 15 }),
]);

/** Straight sets: a barbell lift (5 × 135 lb, 120 s rest), then a bodyweight move. */
const FULL = circuit('full', [
  item('x', { targetReps: 5, targetWeightLbs: 135, restSeconds: 120 }),
  item('y', { restSeconds: 60 }),
]);

const EQUIPMENT: Record<string, string[]> = { a: [], b: [], c: ['dumbbell'], x: ['barbell', 'rack'], y: [], z: [] };


function cleared<S extends CycleState>(state: S): S {
  return { ...state, pending: [] };
}

function kinds(state: CycleState): string[] {
  return state.pending.map((effect) => effect.kind);
}

function effect<K extends CycleEffect['kind']>(state: CycleState, kind: K): Extract<CycleEffect, { kind: K }> {
  const found = state.pending.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`no ${kind} effect in ${kinds(state).join(', ')}`);
  return found as Extract<CycleEffect, { kind: K }>;
}

function expectPhase<P extends CyclePhase>(state: CycleState, phase: P): asserts state is Extract<CycleState, { phase: P }> {
  expect(state.phase).toBe(phase);
}

function started(at = T0, plan: CyclePlanInput = PLAN): FocusState {
  const state = cycleReducer(initialCycleState(USER), { type: 'start', at, userId: USER, plan, ids: IDS });
  expectPhase(state, 'focus');
  return state;
}

function withCircuit(state: FocusState, c: Circuit = MICRO, at = T0 + SEC): FocusState {
  const next = cycleReducer(state, { type: 'circuit_ready', at, blockId: state.blockId, circuit: c });
  expectPhase(next, 'focus');
  return next;
}

/** In the move block after the first focus block ran out (pending effects cleared). */
function moving(c: Circuit = MICRO): MoveState {
  const focus = withCircuit(started(), c);
  const next = cycleReducer(focus, { type: 'tick', at: T0 + 25 * MIN });
  expectPhase(next, 'move');
  return cleared(next);
}

/** A log_set event for the current set at `at` (default: the target, at the target weight). */
function logEvent(state: CycleState, at: number, overrides: Partial<Extract<CycleEvent, { type: 'log_set' }>> = {}): CycleEvent {
  const move = state as MoveState;
  const index = move.position.itemIndex;
  const current = move.circuit.items[index];
  const next = move.items[index].next;
  const target = current.measure === 'time' ? next.targetSeconds : next.targetReps;
  return {
    type: 'log_set',
    at,
    setId: `set-${move.setsLogged}`,
    done: target ?? 0,
    weightLbs: next.targetWeightLbs,
    rpe: null,
    unit: 'lb',
    equipment: EQUIPMENT[current.exerciseId] ?? [],
    ...overrides,
  };
}

/** Logs the current set at `at` (default: the target). */
function log(state: CycleState, at: number, overrides: Partial<Extract<CycleEvent, { type: 'log_set' }>> = {}): CycleState {
  return cycleReducer(state, logEvent(state, at, overrides));
}

/** Logs `count` sets on target, one a minute from `from`. */
function logMany(state: CycleState, count: number, from: number): CycleState {
  let current = state;
  for (let k = 0; k < count; k += 1) current = log(current, from + k * MIN);
  return current;
}

function position(state: CycleState): [number, number] {
  const move = state as MoveState;
  return [move.position.round, move.position.itemIndex];
}

function roundTrip<S>(state: S): S {
  return JSON.parse(JSON.stringify(state)) as S;
}

describe('normalizePlan', () => {
  it('keeps a valid plan and trims the subject', () => {
    expect(normalizePlan(PLAN)).toEqual({
      focusSubject: 'Cell biology',
      blockMinutes: 25,
      presetId: SYSTEM_PRESET_IDS.full_body,
      split: { lower: 40, upper: 30, core: 15, cardio: 15 },
      setupId: '22222222-2222-4222-8222-222222222222',
      location: 'home',
      equipment: ['dumbbell', 'band'],
      moveKind: 'micro',
      moveMinutes: 10,
      returnSeconds: 30,
    });
  });

  it('fills defaults: 25-minute blocks, a 10-minute micro circuit, 30 s return, no preset or setup', () => {
    const plan = normalizePlan({ split: PLAN.split, location: 'gym' });
    expect(plan).toMatchObject({
      focusSubject: '',
      blockMinutes: 25,
      presetId: null,
      setupId: null,
      location: 'gym',
      equipment: [],
      moveKind: 'micro',
      moveMinutes: 10,
      returnSeconds: 30,
    });
  });

  it('clamps block minutes to 10–50 and rounds them', () => {
    expect(normalizePlan({ ...PLAN, blockMinutes: 3 }).blockMinutes).toBe(10);
    expect(normalizePlan({ ...PLAN, blockMinutes: 90 }).blockMinutes).toBe(50);
    expect(normalizePlan({ ...PLAN, blockMinutes: 32.6 }).blockMinutes).toBe(33);
    expect(normalizePlan({ ...PLAN, blockMinutes: Number.NaN }).blockMinutes).toBe(25);
  });

  it('snaps move minutes to the offered lengths for the kind', () => {
    expect(normalizePlan({ ...PLAN, moveMinutes: 12 }).moveMinutes).toBe(10);
    expect(normalizePlan({ ...PLAN, moveMinutes: 14 }).moveMinutes).toBe(15);
    expect(normalizePlan({ ...PLAN, moveMinutes: 1 }).moveMinutes).toBe(5);
    expect(normalizePlan({ ...PLAN, moveKind: 'full', moveMinutes: 10 }).moveMinutes).toBe(30);
    expect(normalizePlan({ ...PLAN, moveKind: 'full', moveMinutes: undefined }).moveMinutes).toBe(45);
    expect(normalizePlan({ ...PLAN, moveKind: 'full', moveMinutes: 59 }).moveMinutes).toBe(60);
  });

  it('caps the subject at 200 characters, the return countdown at 0–300 s, and dedupes equipment', () => {
    const plan = normalizePlan({
      ...PLAN,
      focusSubject: 'x'.repeat(250),
      returnSeconds: 999,
      equipment: ['band', 'band', 'dumbbell'],
    });
    expect(plan.focusSubject).toHaveLength(200);
    expect(plan.returnSeconds).toBe(300);
    expect(plan.equipment).toEqual(['band', 'dumbbell']);
    expect(normalizePlan({ ...PLAN, returnSeconds: -4 }).returnSeconds).toBe(0);
  });
});

describe('idle → focus (start)', () => {
  it('starts the first block, with the move block ids made now and no circuit yet', () => {
    const focus = started();
    expect(focus).toMatchObject({
      version: CYCLE_STATE_VERSION,
      userId: USER,
      phase: 'focus',
      mode: 'study',
      sessionId: 'session-1',
      blockId: 'block-1',
      blockNumber: 1,
      workoutId: 'workout-1',
      transitionId: 'transition-1',
      notificationId: 'block-end-block-1',
      circuit: null,
      endedAt: null,
      interrupted: false,
      cycleStartedAt: T0,
      stats: { blocks: 0, focusMs: 0, moveBlocks: 0, sets: 0 },
    });
    expect(focus.timer).toEqual({ durationMs: 25 * MIN, endsAt: T0 + 25 * MIN, pausedRemainingMs: null });
    expect(focus.plan.focusSubject).toBe('Cell biology');
  });

  it('queues the study session + block insert, then the block-end alert', () => {
    const focus = started();
    expect(focus.pending).toEqual([
      {
        id: 1,
        at: T0,
        kind: 'start_focus_block',
        input: {
          userId: USER,
          sessionId: 'session-1',
          createSession: true,
          focusSubject: 'Cell biology',
          blockId: 'block-1',
          plannedMinutes: 25,
          startedAt: T0,
        },
      },
      {
        id: 2,
        at: T0,
        kind: 'schedule_block_end',
        notificationId: 'block-end-block-1',
        endsAt: T0 + 25 * MIN,
        title: 'Focus block done',
        body: 'Time to move: your 10-minute circuit is ready.',
      },
    ]);
    expect(focus.effectSeq).toBe(2);
  });

  it('describes a full session in the alert', () => {
    const focus = started(T0, { ...PLAN, moveKind: 'full', moveMinutes: 45 });
    expect(effect(focus, 'schedule_block_end').body).toBe('Time to move: your 45-minute session is ready.');
  });

  it('clears the previous summary', () => {
    const idle: IdleState = { ...initialCycleState(USER), summary: { blocks: 1, focusMs: 1, moveBlocks: 0, sets: 0, mode: 'study', startedAt: 1, finishedAt: 2 } };
    const focus = cycleReducer(idle, { type: 'start', at: T0, userId: USER, plan: PLAN, ids: IDS });
    expect(focus).not.toHaveProperty('summary');
  });
});

describe('focus: the circuit is prepared while the timer runs', () => {
  it('stores the circuit for this block only once', () => {
    const focus = withCircuit(cleared(started()));
    expect(focus.circuit).toBe(MICRO);
    expect(focus.pending).toEqual([]);
    expect(cycleReducer(focus, { type: 'circuit_ready', at: T0, blockId: 'block-1', circuit: FULL })).toBe(focus);
  });

  it('ignores a circuit for another block', () => {
    const focus = started();
    expect(cycleReducer(focus, { type: 'circuit_ready', at: T0, blockId: 'block-9', circuit: MICRO })).toBe(focus);
  });
});

describe('focus → move: the zero-tap handoff', () => {
  it('a tick before the end changes nothing', () => {
    const focus = withCircuit(started());
    expect(cycleReducer(focus, { type: 'tick', at: T0 + 25 * MIN - 1 })).toBe(focus);
  });

  it('when the timer runs out the block ends, the alert is withdrawn and the move block starts', () => {
    const focus = cleared(withCircuit(started()));
    const move = cycleReducer(focus, { type: 'tick', at: T0 + 25 * MIN + 400 });
    expectPhase(move, 'move');
    expect(move).toMatchObject({
      workoutId: 'workout-1',
      transitionId: 'transition-1',
      blockId: 'block-1',
      blockNumber: 1,
      effortRating: null,
      circuit: MICRO,
      position: { round: 1, itemIndex: 0 },
      setsLogged: 0,
      startedAt: T0 + 25 * MIN + 400,
      rest: null,
      lastAdvice: null,
      stats: { blocks: 1, focusMs: 25 * MIN, moveBlocks: 0, sets: 0 },
    });
    expect(move.items).toHaveLength(3);
    expect(move.items[2]).toEqual({
      setsDone: 0,
      setsBefore: 0,
      history: [],
      next: { targetReps: 10, targetSeconds: null, targetWeightLbs: 25 },
      nextSetType: 'normal',
      status: 'open',
    });
    expect(move.pending.map(({ id, ...rest }) => rest)).toEqual([
      { at: T0 + 25 * MIN + 400, kind: 'end_focus_block', blockId: 'block-1', endedAt: T0 + 25 * MIN, interrupted: false },
      { at: T0 + 25 * MIN + 400, kind: 'cancel_notification', notificationId: 'block-end-block-1' },
      {
        at: T0 + 25 * MIN + 400,
        kind: 'start_move_block',
        input: {
          userId: USER,
          workoutId: 'workout-1',
          kind: 'micro',
          loggedAt: T0 + 25 * MIN + 400,
          presetId: SYSTEM_PRESET_IDS.full_body,
          setupId: '22222222-2222-4222-8222-222222222222',
          transition: { id: 'transition-1', blockId: 'block-1', proposal: MICRO },
        },
      },
    ]);
  });

  it('detects the end after a restart: the block ended at endsAt, the move block starts now', () => {
    const saved = roundTrip(withCircuit(started()));
    const loaded = parseCycleState(saved, USER);
    expect(loaded).toEqual(saved);
    const threeHoursLater = T0 + 3 * 60 * MIN;
    const move = cycleReducer(loaded, { type: 'tick', at: threeHoursLater });
    expectPhase(move, 'move');
    expect(effect(move, 'end_focus_block')).toMatchObject({ endedAt: T0 + 25 * MIN, interrupted: false });
    expect(effect(move, 'start_move_block').input.loggedAt).toBe(threeHoursLater);
    expect(move.stats.focusMs).toBe(25 * MIN);
  });

  it('if the circuit is not ready, the block ends and the handoff waits for it', () => {
    const focus = cleared(started());
    const ended = cycleReducer(focus, { type: 'tick', at: T0 + 26 * MIN });
    expectPhase(ended, 'focus');
    expect(ended.endedAt).toBe(T0 + 25 * MIN);
    expect(kinds(ended)).toEqual(['end_focus_block', 'cancel_notification']);
    // More ticks, pauses or an early end change nothing now.
    for (const event of [
      { type: 'tick', at: T0 + 27 * MIN },
      { type: 'pause', at: T0 + 27 * MIN },
      { type: 'resume', at: T0 + 27 * MIN },
      { type: 'end_block', at: T0 + 27 * MIN },
    ] as CycleEvent[]) {
      expect(cycleReducer(ended, event)).toBe(ended);
    }
    const move = cycleReducer(ended, { type: 'circuit_ready', at: T0 + 28 * MIN, blockId: 'block-1', circuit: MICRO });
    expectPhase(move, 'move');
    expect(kinds(move)).toEqual(['end_focus_block', 'cancel_notification', 'start_move_block']);
    expect(move.startedAt).toBe(T0 + 28 * MIN);
  });

  it('an empty circuit (nothing fits) goes straight to the return countdown with no workout rows', () => {
    const focus = cleared(withCircuit(started(), circuit('micro', [])));
    const back = cycleReducer(focus, { type: 'tick', at: T0 + 25 * MIN });
    expectPhase(back, 'return');
    expect(kinds(back)).toEqual(['end_focus_block', 'cancel_notification']);
    expect(back.countdown).toEqual({ durationMs: 30 * SEC, endsAt: T0 + 25 * MIN + 30 * SEC, pausedRemainingMs: null });
  });
});

describe('focus: pause and resume', () => {
  it('pausing keeps the time left and withdraws the alert; time does not pass while paused', () => {
    const focus = cleared(withCircuit(started()));
    const paused = cycleReducer(focus, { type: 'pause', at: T0 + 5 * MIN });
    expectPhase(paused, 'focus');
    expect(paused.timer).toEqual({ durationMs: 25 * MIN, endsAt: null, pausedRemainingMs: 20 * MIN });
    expect(paused.pending).toEqual([{ id: 3, at: T0 + 5 * MIN, kind: 'cancel_notification', notificationId: 'block-end-block-1' }]);
    expect(cycleReducer(paused, { type: 'tick', at: T0 + 2 * 60 * MIN })).toBe(paused);
    expect(cycleReducer(paused, { type: 'pause', at: T0 + 6 * MIN })).toBe(paused);
  });

  it('resuming continues from the time left and schedules the alert for the new end', () => {
    const paused = cleared(cycleReducer(withCircuit(started()), { type: 'pause', at: T0 + 5 * MIN }) as FocusState);
    const resumeAt = T0 + 2 * 60 * MIN;
    const resumed = cycleReducer(paused, { type: 'resume', at: resumeAt });
    expectPhase(resumed, 'focus');
    expect(resumed.timer.endsAt).toBe(resumeAt + 20 * MIN);
    expect(kinds(resumed)).toEqual(['schedule_block_end']);
    expect(effect(resumed, 'schedule_block_end')).toMatchObject({ notificationId: 'block-end-block-1', endsAt: resumeAt + 20 * MIN });
    expect(cycleReducer(resumed, { type: 'resume', at: resumeAt + MIN })).toBe(resumed);
    expect(cycleReducer(resumed, { type: 'tick', at: resumeAt + 20 * MIN - 1 })).toBe(resumed);
    const move = cycleReducer(resumed, { type: 'tick', at: resumeAt + 20 * MIN });
    expectPhase(move, 'move');
    expect(move.stats.focusMs).toBe(25 * MIN);
    expect(effect(move, 'end_focus_block').endedAt).toBe(resumeAt + 20 * MIN);
  });

  it('a pause that arrives after the end hands off instead', () => {
    const focus = withCircuit(started());
    const move = cycleReducer(focus, { type: 'pause', at: T0 + 30 * MIN });
    expectPhase(move, 'move');
    expect(effect(move, 'end_focus_block')).toMatchObject({ endedAt: T0 + 25 * MIN, interrupted: false });
  });
});

describe('focus: ending early and finishing', () => {
  it('"End block early" records an interrupted block and hands off now', () => {
    const focus = cleared(withCircuit(started()));
    const move = cycleReducer(focus, { type: 'end_block', at: T0 + 12 * MIN });
    expectPhase(move, 'move');
    expect(effect(move, 'end_focus_block')).toMatchObject({ endedAt: T0 + 12 * MIN, interrupted: true });
    expect(move.stats).toEqual({ blocks: 1, focusMs: 12 * MIN, moveBlocks: 0, sets: 0 });
    expect(move.startedAt).toBe(T0 + 12 * MIN);
  });

  it('ending a paused block counts only the time before the pause', () => {
    const paused = cycleReducer(withCircuit(started()), { type: 'pause', at: T0 + 8 * MIN });
    const move = cycleReducer(paused, { type: 'end_block', at: T0 + 40 * MIN });
    expectPhase(move, 'move');
    expect(move.stats.focusMs).toBe(8 * MIN);
    expect(effect(move, 'end_focus_block')).toMatchObject({ endedAt: T0 + 40 * MIN, interrupted: true });
  });

  it('"End block" after the timer ran out is a normal end', () => {
    const move = cycleReducer(withCircuit(started()), { type: 'end_block', at: T0 + 25 * MIN + 500 });
    expect(effect(move, 'end_focus_block')).toMatchObject({ endedAt: T0 + 25 * MIN, interrupted: false });
  });

  it('"Finish" ends the block (interrupted) and the cycle, with no move block', () => {
    const focus = cleared(withCircuit(started()));
    const idle = cycleReducer(focus, { type: 'finish', at: T0 + 10 * MIN });
    expectPhase(idle, 'idle');
    expect(kinds(idle)).toEqual(['end_focus_block', 'cancel_notification']);
    expect(effect(idle, 'end_focus_block')).toMatchObject({ endedAt: T0 + 10 * MIN, interrupted: true });
    expect(idle.summary).toEqual({ blocks: 1, focusMs: 10 * MIN, moveBlocks: 0, sets: 0, mode: 'study', startedAt: T0, finishedAt: T0 + 10 * MIN });
    expect(idle.userId).toBe(USER);
  });

  it('"Finish" after the timer ran out records a full block; after the block ended it only finishes', () => {
    const late = cycleReducer(withCircuit(started()), { type: 'finish', at: T0 + 30 * MIN });
    expect(effect(late, 'end_focus_block')).toMatchObject({ endedAt: T0 + 25 * MIN, interrupted: false });
    const waiting = cleared(cycleReducer(started(), { type: 'tick', at: T0 + 25 * MIN }) as FocusState);
    const idle = cycleReducer(waiting, { type: 'finish', at: T0 + 26 * MIN });
    expectPhase(idle, 'idle');
    expect(idle.pending).toEqual([]);
    expect(idle.summary?.blocks).toBe(1);
  });
});

describe('move: micro circuits go round-robin', () => {
  it('visits every station once per round, then the next round, and ends after the last round', () => {
    let state: CycleState = moving();
    const visited: [number, number][] = [position(state)];
    for (let k = 0; k < 9; k += 1) {
      state = log(state, T0 + 30 * MIN + k * MIN);
      if (state.phase === 'move') visited.push(position(state));
    }
    expect(visited).toEqual([
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
      [3, 0], [3, 1], [3, 2],
    ]);
    expectPhase(state, 'return');
    expect(state.stats.sets).toBe(9);
    expect(state.stats.moveBlocks).toBe(1);
    const sets = state.pending.filter((entry) => entry.kind === 'log_set').map((entry) => (entry as Extract<CycleEffect, { kind: 'log_set' }>).input);
    expect(sets.map((set) => set.setIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sets.map((set) => set.exerciseId)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c']);
    expect(kinds(state).slice(-1)).toEqual(['finish_move_block']);
    expect(effect(state, 'finish_move_block')).toMatchObject({ workoutId: 'workout-1', durationMinutes: 13 });
  });

  it('logs each set with its targets, the rest taken before it and the set type', () => {
    const first = log(moving(), T0 + 26 * MIN);
    expectPhase(first, 'move');
    expect(first.pending).toEqual([
      {
        id: expect.any(Number),
        at: T0 + 26 * MIN,
        kind: 'log_set',
        input: {
          id: 'set-0',
          userId: USER,
          workoutId: 'workout-1',
          transitionId: 'transition-1',
          exerciseId: 'a',
          exerciseName: 'Exercise a',
          setIndex: 0,
          reps: 10,
          weightLbs: null,
          rpe: null,
          targetReps: 10,
          targetWeightLbs: null,
          restSeconds: null,
          setType: 'normal',
          loggedAt: T0 + 26 * MIN,
        },
      },
    ]);
    // The change-over to the next station is the station's rest.
    expect(first.rest).toEqual({ durationMs: 20 * SEC, endsAt: T0 + 26 * MIN + 20 * SEC, pausedRemainingMs: null });
    expect(first.lastAdvice).toMatchObject({ itemIndex: 0, exerciseName: 'Exercise a', advice: { action: 'continue' } });

    // A timed station stores seconds; rest taken = time since the last set less the 30 s of work.
    const second = log(cleared(first), T0 + 27 * MIN, { rpe: 8 });
    expect(effect(second, 'log_set').input).toMatchObject({
      exerciseId: 'b',
      setIndex: 1,
      reps: 30,
      targetReps: 30,
      rpe: 8,
      restSeconds: 30,
    });
  });

  it('a dumbbell station logs the target weight unless the user changed it', () => {
    let state: CycleState = logMany(moving(), 2, T0 + 26 * MIN);
    state = log(cleared(state as MoveState), T0 + 28 * MIN, { weightLbs: 30, done: 12 });
    expect(effect(state, 'log_set').input).toMatchObject({ exerciseId: 'c', reps: 12, weightLbs: 30, targetReps: 10, targetWeightLbs: 25 });
  });

  it('a miss of 3 reps drops the weight for that station next round (a drop set)', () => {
    let state: CycleState = logMany(moving(), 2, T0 + 26 * MIN);
    state = log(state, T0 + 28 * MIN, { done: 7 });
    expectPhase(state, 'move');
    expect(state.lastAdvice?.advice.action).toBe('drop_weight');
    expect(state.items[2]).toMatchObject({ setsDone: 1, next: { targetReps: 10, targetWeightLbs: 20 }, nextSetType: 'drop', status: 'open' });
    // It moved on to the next round's first station.
    expect(position(state)).toEqual([2, 0]);
    state = logMany(state, 2, T0 + 29 * MIN);
    state = log(cleared(state as MoveState), T0 + 31 * MIN);
    expect(effect(state, 'log_set').input).toMatchObject({ exerciseId: 'c', setType: 'drop', targetWeightLbs: 20, weightLbs: 20 });
  });

  it('a set with a quarter of the target or less cuts the station: later rounds skip it', () => {
    let state: CycleState = log(moving(), T0 + 26 * MIN, { done: 2 });
    expectPhase(state, 'move');
    expect(state.items[0].status).toBe('cut');
    expect(state.lastAdvice?.advice.action).toBe('cut_set');
    const visited: [number, number][] = [];
    for (let k = 0; k < 6; k += 1) {
      visited.push(position(state));
      state = log(state, T0 + 27 * MIN + k * MIN);
    }
    expect(visited).toEqual([[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]);
    expectPhase(state, 'return');
  });

  it('a bodyweight miss lowers the target for the next round', () => {
    const state = log(moving(), T0 + 26 * MIN, { done: 7 });
    expectPhase(state, 'move');
    expect(state.items[0].next.targetReps).toBe(7);
    expect(state.lastAdvice?.advice.action).toBe('lower_target');
  });

  it('a rest-pause on the last round stays on the station with a 20 s rest, then moves on', () => {
    let state: CycleState = logMany(moving(), 6, T0 + 26 * MIN);
    expect(position(state)).toEqual([3, 0]);
    state = log(state, T0 + 33 * MIN, { done: 8 });
    expectPhase(state, 'move');
    expect(position(state)).toEqual([3, 0]);
    expect(state.rest?.durationMs).toBe(20 * SEC);
    expect(state.items[0]).toMatchObject({ setsDone: 3, nextSetType: 'rest_pause', next: { targetReps: 2 }, status: 'open' });
    expect(currentStation(state)).toMatchObject({ index: 0, setNumber: 3, plannedSets: 3, restPause: true, target: 2 });
    state = log(cleared(state), T0 + 34 * MIN);
    expectPhase(state, 'move');
    expect(effect(state, 'log_set').input).toMatchObject({ setType: 'rest_pause', reps: 2, targetReps: 2, setIndex: 7 });
    expect(state.items[0].status).toBe('done');
    expect(position(state)).toEqual([3, 1]);
  });
});

describe('move: full sessions do straight sets', () => {
  it('does every set of an item before the next, with the spotter rest between them', () => {
    let state: CycleState = moving(FULL);
    const visited: number[] = [];
    const rests: (number | null)[] = [];
    for (let k = 0; k < 6; k += 1) {
      visited.push((state as MoveState).position.itemIndex);
      state = log(state, T0 + 30 * MIN + k * 3 * MIN);
      rests.push(state.phase === 'move' ? (state.rest?.durationMs ?? null) : null);
    }
    expect(visited).toEqual([0, 0, 0, 1, 1, 1]);
    expect(rests).toEqual([120 * SEC, 120 * SEC, 120 * SEC, 60 * SEC, 60 * SEC, null]);
    expectPhase(state, 'return');
    const sets = state.pending.filter((entry) => entry.kind === 'log_set').map((entry) => (entry as Extract<CycleEffect, { kind: 'log_set' }>).input);
    expect(sets.map((set) => [set.exerciseId, set.setIndex, set.weightLbs])).toEqual([
      ['x', 0, 135],
      ['x', 1, 135],
      ['x', 2, 135],
      ['y', 3, null],
      ['y', 4, null],
      ['y', 5, null],
    ]);
    expect((state as ReturnState).countdown.durationMs).toBe(30 * SEC);
  });

  it('one rep short extends the rest; position stays on the item', () => {
    const state = log(moving(FULL), T0 + 26 * MIN, { done: 4 });
    expectPhase(state, 'move');
    expect(state.lastAdvice?.advice.action).toBe('extend_rest');
    expect(position(state)).toEqual([1, 0]);
    expect(state.rest?.durationMs).toBe(150 * SEC);
  });

  it('a rest-pause after the last planned set, then on to the next item', () => {
    let state: CycleState = logMany(moving(FULL), 2, T0 + 26 * MIN);
    state = log(state, T0 + 30 * MIN, { done: 3 });
    expectPhase(state, 'move');
    expect(position(state)).toEqual([1, 0]);
    expect(state.rest?.durationMs).toBe(20 * SEC);
    expect(currentStation(state)).toMatchObject({ restPause: true, target: 2, targetWeightLbs: 135 });
    state = log(state, T0 + 31 * MIN);
    expectPhase(state, 'move');
    expect(position(state)).toEqual([1, 1]);
    expect(state.rest?.durationMs).toBe(120 * SEC);
  });

  it('a cut ends the item and goes to the next one', () => {
    const state = log(moving(FULL), T0 + 26 * MIN, { done: 3, rpe: 10 });
    expectPhase(state, 'move');
    expect(state.items[0].status).toBe('cut');
    expect(position(state)).toEqual([1, 1]);
  });
});

describe('move: double taps and stale taps', () => {
  it('two "Done" taps within a second log one set', () => {
    const once = log(moving(), T0 + 26 * MIN);
    expect(log(once, T0 + 26 * MIN + 400)).toBe(once);
    expect(log(once, T0 + 26 * MIN + CYCLE_RULES.doubleTapMs - 1)).toBe(once);
    const twice = log(once, T0 + 26 * MIN + CYCLE_RULES.doubleTapMs);
    expect((twice as MoveState).setsLogged).toBe(2);
  });

  it('a tap for a set the workout has moved past does nothing', () => {
    const once = log(moving(), T0 + 26 * MIN);
    expect(log(once, T0 + 30 * MIN, { expectedSetIndex: 0 })).toBe(once);
    expect((log(once, T0 + 30 * MIN, { expectedSetIndex: 1 }) as MoveState).setsLogged).toBe(2);
  });

  it('cleans up odd input: negative reps, zero weight, an out-of-range effort', () => {
    const state = log(moving(), T0 + 26 * MIN, { done: -3, weightLbs: 0, rpe: 14 });
    expect(effect(state, 'log_set').input).toMatchObject({ reps: 0, weightLbs: null, rpe: null });
  });
});

describe('move: rest timer', () => {
  it('"Skip rest" clears it; a tick clears it once it has run out', () => {
    const resting = log(moving(), T0 + 26 * MIN) as MoveState;
    expect(resting.rest).not.toBeNull();
    expect((cycleReducer(resting, { type: 'skip_rest', at: T0 + 26 * MIN + 5 * SEC }) as MoveState).rest).toBeNull();
    expect(cycleReducer(resting, { type: 'tick', at: T0 + 26 * MIN + 19 * SEC })).toBe(resting);
    expect((cycleReducer(resting, { type: 'tick', at: T0 + 26 * MIN + 20 * SEC }) as MoveState).rest).toBeNull();
    const notResting = moving();
    expect(cycleReducer(notResting, { type: 'skip_rest', at: T0 })).toBe(notResting);
    expect(cycleReducer(notResting, { type: 'tick', at: T0 + 99 * MIN })).toBe(notResting);
  });
});

describe('move: skip and swap', () => {
  it('"Skip" ends the current item for today and moves on', () => {
    const move = moving();
    const skipped = cycleReducer(move, { type: 'skip_exercise', at: T0 + 26 * MIN, itemIndex: 0 });
    expectPhase(skipped, 'move');
    expect(skipped.items[0].status).toBe('skipped');
    expect(position(skipped)).toEqual([1, 1]);
    expect(skipped.pending).toEqual([]);
    // Not the current item, or a double tap: nothing.
    expect(cycleReducer(skipped, { type: 'skip_exercise', at: T0 + 27 * MIN, itemIndex: 0 })).toBe(skipped);
    expect(cycleReducer(skipped, { type: 'skip_exercise', at: T0 + 26 * MIN + 300, itemIndex: 1 })).toBe(skipped);
  });

  it('skipping every item with no set logged skips the move block', () => {
    let state: CycleState = moving();
    for (let k = 0; k < 3; k += 1) {
      state = cycleReducer(state, { type: 'skip_exercise', at: T0 + 26 * MIN + k * MIN, itemIndex: (state as MoveState).position.itemIndex });
    }
    expectPhase(state, 'return');
    expect(state.pending.map(({ id, at, ...rest }) => rest)).toEqual([
      { kind: 'skip_move_block', workoutId: 'workout-1', transitionId: 'transition-1' },
    ]);
    expect(state.stats.moveBlocks).toBe(0);
  });

  it('a swap replaces the item, starts its targets over and keeps the sets already done there', () => {
    let state: CycleState = cleared(logMany(moving(), 3, T0 + 26 * MIN) as MoveState);
    const replacement = item('z', { name: 'Exercise z', targetReps: 12 });
    state = cycleReducer(state, { type: 'swap', at: T0 + 30 * MIN, itemIndex: 0, item: replacement });
    expectPhase(state, 'move');
    expect(state.circuit.items[0]).toBe(replacement);
    expect(state.circuit.items.slice(1)).toEqual(MICRO.items.slice(1));
    expect(state.items[0]).toEqual({
      setsDone: 1,
      setsBefore: 1,
      history: [],
      next: { targetReps: 12, targetSeconds: null, targetWeightLbs: null },
      nextSetType: 'normal',
      status: 'open',
    });
    expect(state.pending).toEqual([]);
    state = log(state, T0 + 31 * MIN);
    expect(effect(state, 'log_set').input).toMatchObject({ exerciseId: 'z', exerciseName: 'Exercise z', reps: 12, setIndex: 3 });
    // Two rounds were left at that station: the new exercise does exactly those two.
    state = logMany(state, 3, T0 + 32 * MIN);
    expectPhase(state, 'move');
    expect(state.items[0]).toMatchObject({ setsDone: 3, status: 'done' });
    expect(state.items[0].history).toHaveLength(2);
    state = logMany(state, 2, T0 + 36 * MIN);
    expectPhase(state, 'return');
  });

  it('ignores a swap for a closed item, the same exercise, or an invalid item', () => {
    const cut = log(moving(), T0 + 26 * MIN, { done: 1 }) as MoveState;
    expect(cycleReducer(cut, { type: 'swap', at: T0, itemIndex: 0, item: item('z') })).toBe(cut);
    expect(cycleReducer(cut, { type: 'swap', at: T0, itemIndex: 1, item: MICRO.items[1] })).toBe(cut);
    expect(cycleReducer(cut, { type: 'swap', at: T0, itemIndex: 9, item: item('z') })).toBe(cut);
    expect(cycleReducer(cut, { type: 'swap', at: T0, itemIndex: 1, item: { ...item('z'), sets: -1 } })).toBe(cut);
  });

  it('a swap clears the spotter line about the swapped item', () => {
    const state = log(moving(FULL), T0 + 26 * MIN) as MoveState;
    const swapped = cycleReducer(state, { type: 'swap', at: T0 + 27 * MIN, itemIndex: 0, item: item('z') }) as MoveState;
    expect(swapped.lastAdvice).toBeNull();
  });
});

describe('move and return: rating the focus block', () => {
  it('queues the rating; the same rating again or an invalid one does nothing', () => {
    const move = moving();
    const rated = cycleReducer(move, { type: 'rate_block', at: T0 + 26 * MIN, effort: 4 });
    expectPhase(rated, 'move');
    expect(rated.effortRating).toBe(4);
    expect(rated.pending.map(({ id, ...rest }) => rest)).toEqual([
      { at: T0 + 26 * MIN, kind: 'rate_block', blockId: 'block-1', effort: 4 },
    ]);
    expect(cycleReducer(rated, { type: 'rate_block', at: T0, effort: 4 })).toBe(rated);
    expect(kinds(cycleReducer(rated, { type: 'rate_block', at: T0, effort: 2 }))).toEqual(['rate_block', 'rate_block']);
    for (const effort of [0, 6, 2.5, Number.NaN]) {
      expect(cycleReducer(move, { type: 'rate_block', at: T0, effort })).toBe(move);
    }
  });

  it('can still be rated during the return countdown, and the rating carries over', () => {
    const rated = cycleReducer(moving(), { type: 'rate_block', at: T0, effort: 3 });
    const back = cleared(cycleReducer(rated, { type: 'finish_move', at: T0 + 30 * MIN }) as ReturnState);
    expect(back.effortRating).toBe(3);
    const again = cycleReducer(back, { type: 'rate_block', at: T0 + 30 * MIN, effort: 5 });
    expect(kinds(again)).toEqual(['rate_block']);
  });
});

describe('move → return: ending the move block', () => {
  it('"Finish move" after sets closes the workout with its length', () => {
    const state = log(moving(), T0 + 26 * MIN);
    const back = cycleReducer(cleared(state as MoveState), { type: 'finish_move', at: T0 + 33 * MIN + 40 * SEC });
    expectPhase(back, 'return');
    expect(back.pending.map(({ id, ...rest }) => rest)).toEqual([
      { at: T0 + 33 * MIN + 40 * SEC, kind: 'finish_move_block', workoutId: 'workout-1', durationMinutes: 9 },
    ]);
    expect(back.countdown).toEqual({ durationMs: 30 * SEC, endsAt: T0 + 34 * MIN + 10 * SEC, pausedRemainingMs: null });
    expect(back).toMatchObject({ blockId: 'block-1', blockNumber: 1, stats: { blocks: 1, sets: 1, moveBlocks: 1 } });
  });

  it('"Skip" with no sets refuses the transition; after sets it is the same as finishing', () => {
    const skipped = cycleReducer(moving(), { type: 'skip_move', at: T0 + 26 * MIN });
    expect(kinds(skipped)).toEqual(['skip_move_block']);
    expect(effect(skipped, 'skip_move_block')).toMatchObject({ workoutId: 'workout-1', transitionId: 'transition-1' });
    const afterSets = cycleReducer(cleared(log(moving(), T0 + 26 * MIN) as MoveState), { type: 'skip_move', at: T0 + 30 * MIN });
    expect(kinds(afterSets)).toEqual(['finish_move_block']);
  });

  it('"Finish" in the move block closes it and the cycle', () => {
    const state = cleared(log(moving(), T0 + 26 * MIN) as MoveState);
    const idle = cycleReducer(state, { type: 'finish', at: T0 + 30 * MIN });
    expectPhase(idle, 'idle');
    expect(kinds(idle)).toEqual(['finish_move_block']);
    expect(idle.summary).toMatchObject({ blocks: 1, sets: 1, moveBlocks: 1, mode: 'study', finishedAt: T0 + 30 * MIN });
  });
});

describe('return → focus: the countdown starts the next block on its own', () => {
  function returning(): ReturnState {
    const back = cycleReducer(log(moving(), T0 + 26 * MIN), { type: 'finish_move', at: T0 + 35 * MIN });
    expectPhase(back, 'return');
    return cleared(back);
  }
  const END = T0 + 35 * MIN + 30 * SEC;

  it('a tick before the end, or without ids, changes nothing', () => {
    const back = returning();
    expect(cycleReducer(back, { type: 'tick', at: END - 1, ids: IDS2 })).toBe(back);
    expect(cycleReducer(back, { type: 'tick', at: END })).toBe(back);
  });

  it('at zero the next block starts when the countdown ended, in the same study session', () => {
    const focus = cycleReducer(returning(), { type: 'tick', at: END + 700, ids: IDS2 });
    expectPhase(focus, 'focus');
    expect(focus).toMatchObject({
      blockId: 'block-2',
      blockNumber: 2,
      sessionId: 'session-1',
      workoutId: 'workout-2',
      transitionId: 'transition-2',
      notificationId: blockEndNotificationId('block-2'),
      circuit: null,
      cycleStartedAt: T0,
      stats: { blocks: 1, sets: 1, moveBlocks: 1 },
    });
    expect(focus.timer).toEqual({ durationMs: 25 * MIN, endsAt: END + 25 * MIN, pausedRemainingMs: null });
    expect(focus.pending.map(({ id, ...rest }) => rest)).toEqual([
      {
        at: END,
        kind: 'start_focus_block',
        input: {
          userId: USER,
          sessionId: 'session-1',
          createSession: false,
          focusSubject: 'Cell biology',
          blockId: 'block-2',
          plannedMinutes: 25,
          startedAt: END,
        },
      },
      {
        at: END,
        kind: 'schedule_block_end',
        notificationId: 'block-end-block-2',
        endsAt: END + 25 * MIN,
        title: 'Focus block done',
        body: 'Time to move: your 10-minute circuit is ready.',
      },
    ]);
  });

  it('a countdown that ran out while the app was away starts the block from now', () => {
    const at = END + 3 * MIN;
    const focus = cycleReducer(returning(), { type: 'tick', at, ids: IDS2 });
    expectPhase(focus, 'focus');
    expect(focus.timer.endsAt).toBe(at + 25 * MIN);
  });

  it('a countdown abandoned for more than 5 minutes finishes the cycle instead', () => {
    const idle = cycleReducer(returning(), { type: 'tick', at: END + CYCLE_RULES.returnStaleMs + 1 });
    expectPhase(idle, 'idle');
    expect(idle.summary).toMatchObject({ blocks: 1, sets: 1, moveBlocks: 1, finishedAt: END });
    expect(idle.pending).toEqual([]);
  });

  it('"Start now" starts the next block at once; "Finish" ends the cycle', () => {
    const focus = cycleReducer(returning(), { type: 'start_now', at: END - 20 * SEC, ids: IDS2 });
    expectPhase(focus, 'focus');
    expect(focus.timer.endsAt).toBe(END - 20 * SEC + 25 * MIN);
    const idle = cycleReducer(returning(), { type: 'finish', at: END - 10 * SEC });
    expectPhase(idle, 'idle');
    expect(idle.summary?.finishedAt).toBe(END - 10 * SEC);
  });

  it('the second block hands off to a fresh workout and transition', () => {
    let state = cycleReducer(returning(), { type: 'tick', at: END, ids: IDS2 });
    state = cycleReducer(state, { type: 'circuit_ready', at: END + SEC, blockId: 'block-2', circuit: FULL });
    state = cycleReducer(cleared(state), { type: 'tick', at: END + 25 * MIN });
    expectPhase(state, 'move');
    expect(effect(state, 'start_move_block').input).toMatchObject({
      workoutId: 'workout-2',
      kind: 'full',
      transition: { id: 'transition-2', blockId: 'block-2', proposal: FULL },
    });
    expect(state).toMatchObject({ blockNumber: 2, setsLogged: 0, effortRating: null, stats: { blocks: 2, focusMs: 50 * MIN } });
  });
});

describe('move-only ("Just train")', () => {
  function trained(): MoveState {
    const state = cycleReducer(initialCycleState(USER), {
      type: 'start_move',
      at: T0,
      userId: USER,
      plan: { ...PLAN, moveKind: 'full', moveMinutes: 30 },
      workoutId: 'workout-solo',
      circuit: FULL,
    });
    expectPhase(state, 'move');
    return state;
  }

  it('starts a workout with no transition and no focus block', () => {
    const state = trained();
    expect(state).toMatchObject({ mode: 'move_only', sessionId: null, transitionId: null, blockId: null, blockNumber: 0 });
    expect(state.pending.map(({ id, ...rest }) => rest)).toEqual([
      {
        at: T0,
        kind: 'start_move_block',
        input: {
          userId: USER,
          workoutId: 'workout-solo',
          kind: 'full',
          loggedAt: T0,
          presetId: SYSTEM_PRESET_IDS.full_body,
          setupId: '22222222-2222-4222-8222-222222222222',
          transition: null,
        },
      },
    ]);
  });

  it('logs sets without a transition, cannot rate a block, and finishes the cycle at the end', () => {
    let state: CycleState = cleared(trained());
    state = log(state, T0 + MIN);
    expect(effect(state, 'log_set').input.transitionId).toBeNull();
    expect(cycleReducer(state, { type: 'rate_block', at: T0, effort: 3 })).toBe(state);
    state = logMany(state, 5, T0 + 4 * MIN);
    expectPhase(state, 'idle');
    expect(kinds(state).slice(-1)).toEqual(['finish_move_block']);
    expect(state.summary).toMatchObject({ mode: 'move_only', blocks: 0, focusMs: 0, sets: 6, moveBlocks: 1, startedAt: T0 });
  });

  it('a move-only skip with no sets ends in idle with a skip', () => {
    const idle = cycleReducer(cleared(trained()), { type: 'skip_move', at: T0 + MIN });
    expectPhase(idle, 'idle');
    expect(kinds(idle)).toEqual(['skip_move_block']);
    expect(effect(idle, 'skip_move_block').transitionId).toBeNull();
  });

  it('an empty circuit does not start', () => {
    const idle = initialCycleState(USER);
    const event: CycleEvent = { type: 'start_move', at: T0, userId: USER, plan: PLAN, workoutId: 'w', circuit: circuit('micro', []) };
    expect(cycleReducer(idle, event)).toBe(idle);
  });
});

describe('effects', () => {
  it('effect ids keep increasing across phases; effect_done removes exactly one', () => {
    let state: CycleState = withCircuit(started());
    state = cycleReducer(state, { type: 'tick', at: T0 + 25 * MIN });
    const ids = state.pending.map((entry) => entry.id);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    const done = cycleReducer(state, { type: 'effect_done', effectId: 3 });
    expect(done.pending.map((entry) => entry.id)).toEqual([1, 2, 4, 5]);
    expect(done.phase).toBe('move');
    expect(cycleReducer(done, { type: 'effect_done', effectId: 3 })).toBe(done);
    expect(done.effectSeq).toBe(5);
  });

  it('pending effects survive a finish and stay ordered', () => {
    const state = cycleReducer(log(moving(), T0 + 26 * MIN), { type: 'finish', at: T0 + 27 * MIN });
    expect(kinds(state)).toEqual(['log_set', 'finish_move_block']);
  });
});

describe('every event in every phase', () => {
  const RESTING = log(moving(), T0 + 26 * MIN) as MoveState;
  const SAMPLES: Record<CyclePhase, CycleState> = {
    idle: { ...initialCycleState(USER), summary: { blocks: 1, focusMs: MIN, moveBlocks: 0, sets: 0, mode: 'study', startedAt: T0, finishedAt: T0 + MIN } },
    focus: cleared(started()),
    move: cleared(RESTING),
    return: cleared(cycleReducer(RESTING, { type: 'finish_move', at: T0 + 30 * MIN }) as ReturnState),
  };
  const LATER = T0 + 10 * 60 * MIN;
  const EVENTS: Record<CycleEventType, CycleEvent> = {
    start: { type: 'start', at: LATER, userId: USER, plan: PLAN, ids: { ...IDS, sessionId: 'session-9' } },
    start_move: { type: 'start_move', at: LATER, userId: USER, plan: PLAN, workoutId: 'w9', circuit: MICRO },
    tick: { type: 'tick', at: LATER, ids: IDS2 },
    circuit_ready: { type: 'circuit_ready', at: LATER, blockId: 'block-1', circuit: MICRO },
    pause: { type: 'pause', at: T0 + MIN },
    resume: { type: 'resume', at: T0 + MIN },
    end_block: { type: 'end_block', at: T0 + MIN },
    log_set: { type: 'log_set', at: LATER, setId: 'set-x', done: 10, weightLbs: null, rpe: null, unit: 'lb', equipment: [] },
    skip_rest: { type: 'skip_rest', at: LATER },
    skip_exercise: { type: 'skip_exercise', at: LATER, itemIndex: 1 },
    swap: { type: 'swap', at: LATER, itemIndex: 1, item: item('z') },
    rate_block: { type: 'rate_block', at: LATER, effort: 2 },
    finish_move: { type: 'finish_move', at: LATER },
    skip_move: { type: 'skip_move', at: LATER },
    start_now: { type: 'start_now', at: LATER, ids: IDS2 },
    finish: { type: 'finish', at: LATER },
    dismiss_summary: { type: 'dismiss_summary' },
    effect_done: { type: 'effect_done', effectId: 999 },
  };
  /** The events that change each sample state; every other event leaves it as it is. */
  const APPLIES: Record<CyclePhase, readonly CycleEventType[]> = {
    idle: ['start', 'start_move', 'dismiss_summary'],
    focus: ['tick', 'circuit_ready', 'pause', 'end_block', 'finish'],
    move: ['tick', 'log_set', 'skip_rest', 'skip_exercise', 'swap', 'rate_block', 'finish_move', 'skip_move', 'finish'],
    return: ['tick', 'rate_block', 'start_now', 'finish'],
  };
  /** The phase each applicable event leads to. */
  const LEADS_TO: Record<CyclePhase, Partial<Record<CycleEventType, CyclePhase>>> = {
    idle: { start: 'focus', start_move: 'move', dismiss_summary: 'idle' },
    focus: { tick: 'focus', circuit_ready: 'focus', pause: 'focus', end_block: 'focus', finish: 'idle' },
    move: {
      tick: 'move',
      log_set: 'move',
      skip_rest: 'move',
      skip_exercise: 'move',
      swap: 'move',
      rate_block: 'move',
      finish_move: 'return',
      skip_move: 'return',
      finish: 'idle',
    },
    // A tick ten hours late finds an abandoned countdown: the cycle finishes.
    return: { tick: 'idle', rate_block: 'return', start_now: 'focus', finish: 'idle' },
  };

  for (const phase of Object.keys(SAMPLES) as CyclePhase[]) {
    for (const type of Object.keys(EVENTS) as CycleEventType[]) {
      const applies = APPLIES[phase].includes(type);
      it(`${phase} + ${type}: ${applies ? `→ ${LEADS_TO[phase][type]}` : 'unchanged'}`, () => {
        const before = SAMPLES[phase];
        const snapshot = roundTrip(before);
        const after = cycleReducer(before, EVENTS[type]);
        // The reducer never changes its input.
        expect(before).toEqual(snapshot);
        if (!applies) {
          expect(after).toBe(before);
          return;
        }
        expect(after).not.toBe(before);
        expect(after.phase).toBe(LEADS_TO[phase][type]);
        // Every state is plain JSON that reads back as itself.
        expect(parseCycleState(roundTrip(after), USER)).toEqual(after);
        // Effects are only ever appended, with increasing ids.
        const ids = after.pending.map((entry) => entry.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(after.effectSeq).toBeGreaterThanOrEqual(before.effectSeq);
      });
    }
  }
});

describe('parseCycleState', () => {
  it('returns the saved state when it is valid and ours', () => {
    const state = roundTrip(log(moving(), T0 + 26 * MIN));
    expect(parseCycleState(state, USER)).toEqual(state);
    const idle = initialCycleState(null);
    expect(parseCycleState(roundTrip(idle), USER)).toEqual(idle);
  });

  it('drops anything unreadable: wrong version, unknown phase, broken shape, null', () => {
    const fresh = initialCycleState(USER);
    const valid = roundTrip(started());
    for (const value of [
      null,
      undefined,
      'cycle',
      42,
      [],
      { ...valid, version: 2 },
      { ...valid, phase: 'warmup' },
      { ...valid, pending: 'none' },
      { ...valid, timer: null },
      { ...valid, circuit: { items: 'x' } },
      { ...roundTrip(moving()), items: [] },
      { ...roundTrip(moving()), rest: { durationMs: 'x' } },
      { ...cleared(started()), userId: 7 },
    ]) {
      expect(parseCycleState(value, USER)).toEqual(fresh);
    }
  });

  it("drops another user's cycle and its pending writes", () => {
    const state = roundTrip(started());
    expect(parseCycleState(state, '99999999-9999-4999-8999-999999999999')).toEqual(
      initialCycleState('99999999-9999-4999-8999-999999999999'),
    );
  });
});

describe('helpers', () => {
  const open = (status: ItemProgress['status'] = 'open'): ItemProgress => ({
    setsDone: 0,
    setsBefore: 0,
    history: [],
    next: { targetReps: 10, targetSeconds: null, targetWeightLbs: null },
    nextSetType: 'normal',
    status,
  });

  it('nextOpenPosition wraps to the next round in micro only', () => {
    const items = [open(), open('cut'), open()];
    expect(nextOpenPosition(items, 0, 1, 'micro')).toEqual({ round: 1, itemIndex: 2 });
    expect(nextOpenPosition(items, 2, 1, 'micro')).toEqual({ round: 2, itemIndex: 0 });
    expect(nextOpenPosition(items, 2, 1, 'full')).toEqual({ round: 1, itemIndex: 0 });
    expect(nextOpenPosition([open('done'), open()], 1, 2, 'micro')).toEqual({ round: 3, itemIndex: 1 });
    expect(nextOpenPosition([open('done'), open('skipped')], 0, 1, 'micro')).toBeNull();
  });

  it('currentStation describes the next set', () => {
    const state = log(moving(), T0 + 26 * MIN) as MoveState;
    expect(currentStation(state)).toEqual({
      index: 1,
      item: MICRO.items[1],
      progress: state.items[1],
      target: 30,
      targetWeightLbs: null,
      setNumber: 1,
      plannedSets: 3,
      round: 1,
      rounds: 3,
      restPause: false,
    });
  });
});

describe('a whole cycle', () => {
  it('study → move → study → move → finish, every state saved and read back as itself', () => {
    const states: CycleState[] = [];
    const step = (state: CycleState, event: CycleEvent) => {
      const next = cycleReducer(state, event);
      states.push(next);
      return next;
    };
    let state: CycleState = initialCycleState(USER);
    state = step(state, { type: 'start', at: T0, userId: USER, plan: PLAN, ids: IDS });
    state = step(state, { type: 'circuit_ready', at: T0 + SEC, blockId: 'block-1', circuit: MICRO });
    state = step(state, { type: 'tick', at: T0 + 25 * MIN });
    state = step(state, { type: 'rate_block', at: T0 + 25 * MIN + 5 * SEC, effort: 4 });
    for (let k = 0; k < 9; k += 1) state = step(state, logEvent(state, T0 + 26 * MIN + k * MIN, { rpe: 8 }));
    expectPhase(state, 'return');
    const end = (state as ReturnState).countdown.endsAt ?? 0;
    state = step(state, { type: 'tick', at: end, ids: IDS2 });
    state = step(state, { type: 'circuit_ready', at: end + SEC, blockId: 'block-2', circuit: FULL });
    state = step(state, { type: 'end_block', at: end + 20 * MIN });
    state = step(state, logEvent(state, end + 21 * MIN));
    state = step(state, { type: 'finish', at: end + 30 * MIN });
    expectPhase(state, 'idle');
    expect(state.summary).toEqual({
      blocks: 2,
      focusMs: 45 * MIN,
      moveBlocks: 2,
      sets: 10,
      mode: 'study',
      startedAt: T0,
      finishedAt: end + 30 * MIN,
    });
    expect(kinds(state).filter((kind) => kind === 'log_set')).toHaveLength(10);
    expect(kinds(state).filter((kind) => kind === 'start_focus_block')).toHaveLength(2);
    expect(kinds(state).filter((kind) => kind === 'start_move_block')).toHaveLength(2);
    expect(kinds(state).filter((kind) => kind === 'finish_move_block')).toHaveLength(2);
    for (const saved of states) expect(parseCycleState(roundTrip(saved), USER)).toEqual(saved);
    // Dismissing the summary leaves a clean idle state once every effect is done.
    let idle: CycleState = state;
    for (const entry of state.pending) idle = cycleReducer(idle, { type: 'effect_done', effectId: entry.id });
    idle = cycleReducer(idle, { type: 'dismiss_summary' });
    expect(idle).toEqual({ ...initialCycleState(USER), effectSeq: state.effectSeq });
  });
});
