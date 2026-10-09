/**
 * Phase 2: a cycle that studies a plan. The machine only carries the plan (studyPlanId, studyFilter);
 * the session row records it; a study block's end reschedules the review reminder. Everything else
 * (the timer, the alerts, the handoff) must be exactly what a timer-only cycle does, and states saved
 * by Phase 1 must still load and run.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SETUP_TEMPLATES } from '@/features/training/equipment';
import { STARTER_LIBRARY, STARTER_LIBRARY_BY_ID } from '@/features/training/starterLibrary';
import type { Circuit } from '@/features/training/types';

import {
  CYCLE_STATE_VERSION,
  cycleReducer,
  initialCycleState,
  normalizePlan,
  parseCycleState,
  studyPlanOf,
  type BlockIds,
  type CycleEffect,
  type CycleEvent,
  type CyclePlanInput,
  type CycleState,
  type FocusState,
  type ReturnState,
} from '../cycleMachine';
import { startFocusBlock } from '../cycleRepo';
import { CycleStore, type CycleStoreDeps } from '../cycleStore';

// cycleRepo writes through database.ts, which needs the native PowerSync module: a recording fake.
type Call = { sql: string; params: unknown[] };
function mockCreateDb() {
  const calls: Call[] = [];
  const existing = new Set<string>();
  const tx = {
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rowsAffected: 1 };
    },
    getOptional: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return existing.has(String(params[0])) ? { id: params[0] } : null;
    },
  };
  return {
    calls,
    existing,
    async writeTransaction<T>(callback: (context: typeof tx) => Promise<T>): Promise<T> {
      return callback(tx);
    },
  };
}
jest.mock('../../../db/database', () => ({ db: mockCreateDb() }));
const mockDb = (jest.requireMock('../../../db/database') as { db: ReturnType<typeof mockCreateDb> }).db;

const USER = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '90000000-0000-4000-8000-000000000001';
const T0 = 1_760_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

const TIMER_ONLY: CyclePlanInput = {
  focusSubject: 'Cell biology',
  blockMinutes: 25,
  presetId: null,
  split: { lower: 25, upper: 25, core: 25, cardio: 25 },
  setupId: null,
  location: 'home',
  equipment: SETUP_TEMPLATES.home_bodyweight.equipment,
  moveKind: 'micro',
  moveMinutes: 5,
};
const STUDYING: CyclePlanInput = { ...TIMER_ONLY, focusSubject: 'Biology 101', studyPlanId: PLAN_ID, studyFilter: 'newest' };

const IDS: BlockIds & { sessionId: string } = { sessionId: 'session-1', blockId: 'block-1', workoutId: 'workout-1', transitionId: 'transition-1' };
const IDS2: BlockIds = { blockId: 'block-2', workoutId: 'workout-2', transitionId: 'transition-2' };

const CIRCUIT: Circuit = {
  version: 1,
  source: 'default',
  kind: 'micro',
  minutes: 5,
  rounds: 2,
  items: [
    {
      exerciseId: 'a',
      name: 'Squat',
      measure: 'reps',
      movementPattern: 'squat',
      region: 'lower',
      sets: 2,
      targetReps: 10,
      targetSeconds: null,
      targetWeightLbs: null,
      restSeconds: 20,
    },
  ],
  estimatedSeconds: 120,
  location: 'home',
  split: { lower: 100, upper: 0, core: 0, cardio: 0 },
};

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function run(state: CycleState, events: CycleEvent[]): CycleState[] {
  const states: CycleState[] = [];
  let current = state;
  for (const event of events) {
    current = cycleReducer(current, event);
    states.push(current);
  }
  return states;
}

/** A whole cycle: block 1 runs out, a set, the countdown starts block 2, which is ended early, finish. */
function wholeCycle(plan: CyclePlanInput): CycleState[] {
  const states = run(initialCycleState(USER), [
    { type: 'start', at: T0, userId: USER, plan, ids: IDS },
    { type: 'circuit_ready', at: T0 + SEC, blockId: 'block-1', circuit: CIRCUIT },
    { type: 'pause', at: T0 + 5 * MIN },
    { type: 'resume', at: T0 + 6 * MIN },
    { type: 'tick', at: T0 + 26 * MIN },
    { type: 'log_set', at: T0 + 27 * MIN, setId: 'set-1', done: 10, weightLbs: null, rpe: null, unit: 'lb', equipment: [] },
    { type: 'finish_move', at: T0 + 28 * MIN },
  ]);
  const back = states[states.length - 1] as ReturnState;
  const end = back.countdown.endsAt ?? 0;
  return [
    ...states,
    ...run(back, [
      { type: 'tick', at: end, ids: IDS2 },
      { type: 'circuit_ready', at: end + SEC, blockId: 'block-2', circuit: CIRCUIT },
      { type: 'end_block', at: end + 10 * MIN },
      { type: 'finish', at: end + 12 * MIN },
    ]),
  ];
}

/** A state without the study fields (what the same cycle would be without a plan). */
function withoutStudy(state: CycleState): unknown {
  const copy = roundTrip(state) as unknown as Record<string, unknown>;
  if (copy.plan && typeof copy.plan === 'object') {
    const plan = copy.plan as Record<string, unknown>;
    delete plan.studyPlanId;
    delete plan.studyFilter;
    plan.focusSubject = 'Cell biology';
  }
  copy.pending = (copy.pending as CycleEffect[]).map((effect) => {
    const entry = { ...effect } as Record<string, unknown>;
    delete entry.studyPlanId;
    if (entry.kind === 'start_focus_block') {
      const input = { ...(entry.input as Record<string, unknown>) };
      delete input.planId;
      input.focusSubject = 'Cell biology';
      entry.input = input;
    }
    return entry;
  });
  return copy;
}

describe('the cycle plan carries the study plan', () => {
  it('keeps a plan id and its filter', () => {
    expect(normalizePlan(STUDYING)).toMatchObject({ studyPlanId: PLAN_ID, studyFilter: 'newest', focusSubject: 'Biology 101' });
    expect(normalizePlan({ ...STUDYING, studyFilter: undefined }).studyFilter).toBe('all');
    expect(normalizePlan({ ...STUDYING, studyFilter: 'everything' as never }).studyFilter).toBe('all');
  });

  it('a timer-only plan has neither field (exactly what Phase 1 made)', () => {
    for (const plan of [TIMER_ONLY, { ...TIMER_ONLY, studyPlanId: null }, { ...TIMER_ONLY, studyPlanId: '' }]) {
      const normalized = normalizePlan(plan);
      expect(normalized).not.toHaveProperty('studyPlanId');
      expect(normalized).not.toHaveProperty('studyFilter');
    }
    // A filter without a plan means nothing.
    expect(normalizePlan({ ...TIMER_ONLY, studyFilter: 'newest' })).not.toHaveProperty('studyFilter');
  });

  it('refuses a plan id that is not a UUID (the session would carry a reference the server refuses)', () => {
    expect(normalizePlan({ ...TIMER_ONLY, studyPlanId: 'plan-1' })).not.toHaveProperty('studyPlanId');
    expect(normalizePlan({ ...TIMER_ONLY, studyPlanId: 42 as never })).not.toHaveProperty('studyPlanId');
  });

  it('studyPlanOf reads any plan defensively', () => {
    expect(studyPlanOf(normalizePlan(STUDYING))).toEqual({ planId: PLAN_ID, filter: 'newest' });
    expect(studyPlanOf(normalizePlan(TIMER_ONLY))).toBeNull();
    expect(studyPlanOf({})).toBeNull();
    expect(studyPlanOf({ studyPlanId: null, studyFilter: 'newest' })).toBeNull();
    expect(studyPlanOf({ studyPlanId: PLAN_ID, studyFilter: 7 })).toEqual({ planId: PLAN_ID, filter: 'all' });
  });
});

describe('a study cycle runs exactly like a timer-only one', () => {
  it('same states, effects and alerts, apart from the plan in the session and the block ends', () => {
    const studying = wholeCycle(STUDYING);
    const timerOnly = wholeCycle(TIMER_ONLY);
    expect(studying.map((state) => state.phase)).toEqual(timerOnly.map((state) => state.phase));
    studying.forEach((state, index) => expect(withoutStudy(state)).toEqual(roundTrip(timerOnly[index])));
  });

  it('every block of the session carries the plan; every block end says it studied', () => {
    const states = wholeCycle(STUDYING);
    const last = states[states.length - 1];
    const starts = last.pending.filter((effect) => effect.kind === 'start_focus_block');
    expect(starts.map((effect) => [effect.input.blockId, effect.input.createSession, effect.input.planId])).toEqual([
      ['block-1', true, PLAN_ID],
      ['block-2', false, PLAN_ID],
    ]);
    const ends = last.pending.filter((effect) => effect.kind === 'end_focus_block');
    expect(ends.map((effect) => [effect.blockId, effect.interrupted, effect.studyPlanId])).toEqual([
      ['block-1', false, PLAN_ID],
      ['block-2', true, PLAN_ID],
    ]);
    // The alerts are the same as without a plan.
    const alerts = last.pending.filter((effect) => effect.kind === 'schedule_block_end').map((effect) => effect.body);
    expect(new Set(alerts)).toEqual(new Set(['Time to move: your 5-minute circuit is ready.']));
  });

  it('a timer-only cycle never mentions a plan', () => {
    const states = wholeCycle(TIMER_ONLY);
    const text = JSON.stringify(states);
    expect(text).not.toContain('planId');
    expect(text).not.toContain('studyPlanId');
    expect(text).not.toContain('studyFilter');
  });

  it('every state with a plan is plain JSON that reads back as itself, with version 1', () => {
    for (const state of wholeCycle(STUDYING)) {
      expect(state.version).toBe(1);
      expect(parseCycleState(roundTrip(state), USER)).toEqual(state);
    }
    expect(CYCLE_STATE_VERSION).toBe(1);
  });
});

describe('states saved by Phase 1 still load', () => {
  /** A focus block as Phase 1 saved it in local_state: version 1, a plan with no study fields. */
  const PHASE1_FOCUS = {
    version: 1,
    userId: USER,
    pending: [],
    effectSeq: 2,
    mode: 'study',
    plan: {
      focusSubject: 'Cell biology',
      blockMinutes: 25,
      presetId: null,
      split: { lower: 25, upper: 25, core: 25, cardio: 25 },
      setupId: null,
      location: 'home',
      equipment: [],
      moveKind: 'micro',
      moveMinutes: 5,
      returnSeconds: 30,
    },
    sessionId: 'session-1',
    cycleStartedAt: T0,
    stats: { blocks: 0, focusMs: 0, moveBlocks: 0, sets: 0 },
    phase: 'focus',
    blockId: 'block-1',
    blockNumber: 1,
    startedAt: T0,
    timer: { durationMs: 25 * MIN, endsAt: T0 + 25 * MIN, pausedRemainingMs: null },
    endedAt: null,
    interrupted: false,
    circuit: CIRCUIT,
    workoutId: 'workout-1',
    transitionId: 'transition-1',
    notificationId: 'block-end-session-1-1',
  };

  it('a running block loads as it was and is a timer-only block', () => {
    const loaded = parseCycleState(roundTrip(PHASE1_FOCUS), USER) as FocusState;
    expect(loaded).toEqual(PHASE1_FOCUS);
    expect(studyPlanOf(loaded.plan)).toBeNull();
  });

  it('it runs on: the handoff, the countdown and the next block, with no plan written anywhere', () => {
    const loaded = parseCycleState(roundTrip(PHASE1_FOCUS), USER);
    const moved = cycleReducer(loaded, { type: 'tick', at: T0 + 25 * MIN });
    expect(moved.phase).toBe('move');
    const end = moved.pending.find((effect) => effect.kind === 'end_focus_block');
    expect(end).toEqual({ id: 3, at: T0 + 25 * MIN, kind: 'end_focus_block', blockId: 'block-1', endedAt: T0 + 25 * MIN, interrupted: false });
    const back = cycleReducer(moved, { type: 'skip_move', at: T0 + 26 * MIN }) as ReturnState;
    const next = cycleReducer(back, { type: 'tick', at: back.countdown.endsAt ?? 0, ids: IDS2 });
    expect(next.phase).toBe('focus');
    const start = next.pending.find((effect) => effect.kind === 'start_focus_block');
    expect(start && start.kind === 'start_focus_block' ? start.input : null).not.toHaveProperty('planId');
  });

  it('a saved plan id that is not a UUID studies nothing', () => {
    const damaged = { ...roundTrip(PHASE1_FOCUS), plan: { ...PHASE1_FOCUS.plan, studyPlanId: 'x', studyFilter: 'newest' } };
    const loaded = parseCycleState(damaged, USER) as FocusState;
    expect(loaded.phase).toBe('focus');
    expect(studyPlanOf(loaded.plan)).toBeNull();
  });
});

describe('startFocusBlock records the plan on the session', () => {
  const ISO = new Date(T0).toISOString();
  const SESSION = '33333333-3333-4333-8333-333333333333';
  const BLOCK = '44444444-4444-4444-8444-444444444444';
  const input = {
    userId: USER,
    sessionId: SESSION,
    createSession: true,
    focusSubject: 'Biology 101',
    planId: PLAN_ID,
    blockId: BLOCK,
    plannedMinutes: 25,
    startedAt: T0,
  };

  beforeEach(() => {
    mockDb.calls.length = 0;
    mockDb.existing.clear();
  });

  it('writes study_sessions.plan_id with the session', async () => {
    await startFocusBlock(input);
    expect(mockDb.calls[1]).toEqual({
      sql: 'INSERT INTO study_sessions (id, user_id, plan_id, focus_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [SESSION, USER, PLAN_ID, 'Biology 101', ISO, ISO],
    });
    expect(mockDb.calls[3].sql).toContain('INSERT INTO interval_blocks');
  });

  it('a timer-only session (no plan, or one that is not a UUID) leaves plan_id out', async () => {
    for (const planId of [undefined, null, 'plan-1']) {
      mockDb.calls.length = 0;
      await startFocusBlock({ ...input, planId });
      expect(mockDb.calls[1].sql).toBe(
        'INSERT INTO study_sessions (id, user_id, focus_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
    }
  });

  it('later blocks and a retried write do not touch the session', async () => {
    await startFocusBlock({ ...input, createSession: false });
    expect(mockDb.calls.map((call) => call.sql.split(' (')[0])).toEqual([
      'SELECT id FROM interval_blocks WHERE id = ?',
      'INSERT INTO interval_blocks',
    ]);
    mockDb.calls.length = 0;
    mockDb.existing.add(SESSION);
    mockDb.existing.add(BLOCK);
    await startFocusBlock(input);
    expect(mockDb.calls.every((call) => call.sql.startsWith('SELECT'))).toBe(true);
  });
});

describe('the store reschedules the review reminder after a study block', () => {
  const CONTEXT = { library: STARTER_LIBRARY, byId: STARTER_LIBRARY_BY_ID, unit: 'lb' as const };

  function fakeDeps(order: string[]) {
    const studyBlockEnded = jest.fn((userId: string) => {
      order.push(`studyBlockEnded:${userId}`);
    });
    const deps = {
      readState: jest.fn(async () => null),
      writeState: jest.fn(async () => undefined),
      repo: {
        startFocusBlock: jest.fn(async () => undefined),
        endFocusBlock: jest.fn(async (blockId: string) => {
          order.push(`endFocusBlock:${blockId}`);
        }),
        rateBlock: jest.fn(async () => undefined),
        startMoveBlock: jest.fn(async () => undefined),
        logSet: jest.fn(async () => undefined),
        finishMoveBlock: jest.fn(async () => undefined),
        skipMoveBlock: jest.fn(async () => undefined),
        lastSessionSetsFor: jest.fn(async () => new Map()),
      },
      scheduleBlockEnd: jest.fn(async () => null),
      cancelScheduled: jest.fn(async () => undefined),
      haptic: jest.fn(),
      now: jest.fn(() => T0),
      newId: (() => {
        let n = 0;
        return () => `id-${(n += 1)}`;
      })(),
      setTimeout: jest.fn(() => 0),
      clearTimeout: jest.fn(),
      studyBlockEnded,
    } satisfies CycleStoreDeps;
    return deps;
  }

  async function settle(): Promise<void> {
    for (let k = 0; k < 30; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function running(plan: CyclePlanInput, order: string[] = []) {
    const deps = fakeDeps(order);
    const store = new CycleStore(USER, deps);
    store.setContext(CONTEXT);
    await store.load();
    store.start(plan);
    await settle();
    return { store, deps, order };
  }

  it('once the block’s end is written', async () => {
    const { store, deps, order } = await running(STUDYING);
    expect(deps.studyBlockEnded).not.toHaveBeenCalled();
    deps.now.mockReturnValue(T0 + 25 * MIN);
    store.tick();
    await settle();
    expect(store.getSnapshot().state?.phase).toBe('move');
    expect(order).toEqual(['endFocusBlock:id-2', `studyBlockEnded:${USER}`]);
  });

  it('also when the block is ended early or the cycle finished', async () => {
    const early = await running(STUDYING);
    early.store.endBlock();
    await settle();
    expect(early.deps.studyBlockEnded).toHaveBeenCalledTimes(1);
    const finished = await running(STUDYING);
    finished.store.finish();
    await settle();
    expect(finished.deps.studyBlockEnded).toHaveBeenCalledTimes(1);
  });

  it('never for a timer-only block', async () => {
    const { store, deps } = await running(TIMER_ONLY);
    store.endBlock();
    await settle();
    expect(deps.repo.endFocusBlock).toHaveBeenCalledTimes(1);
    expect(deps.studyBlockEnded).not.toHaveBeenCalled();
  });

  it('never during sign-out (every alert of the account is withdrawn right after)', async () => {
    const { store, deps } = await running(STUDYING);
    await store.finishAndStop();
    expect(deps.repo.endFocusBlock).toHaveBeenCalledTimes(1);
    expect(deps.studyBlockEnded).not.toHaveBeenCalled();
  });

  it('a reminder that throws never holds up the loop', async () => {
    const { store, deps } = await running(STUDYING);
    deps.studyBlockEnded.mockImplementation(() => {
      throw new Error('no native module');
    });
    deps.now.mockReturnValue(T0 + 25 * MIN);
    store.tick();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ error: null, state: { phase: 'move' } });
    expect(deps.repo.startMoveBlock).toHaveBeenCalledTimes(1);
  });
});
