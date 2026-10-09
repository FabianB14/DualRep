import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SETUP_TEMPLATES } from '@/features/training/equipment';
import type { LoggedSet } from '@/features/training/spotter';
import { STARTER_LIBRARY, STARTER_LIBRARY_BY_ID } from '@/features/training/starterLibrary';
import type { Circuit, CircuitItem } from '@/features/training/types';

import {
  cycleReducer,
  initialCycleState,
  type CycleEvent,
  type CyclePlanInput,
  type CycleState,
  type FocusState,
  type MoveState,
  type ReturnState,
} from '../cycleMachine';
import {
  CYCLE_LOAD_ERROR,
  CYCLE_SAVE_ERROR,
  cycleHaptic,
  CycleStore,
  type CycleContext,
  type CycleRepo,
  type CycleStoreDeps,
} from '../cycleStore';

const USER = '11111111-1111-4111-8111-111111111111';
const T0 = 1_760_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

const PLAN: CyclePlanInput = {
  focusSubject: 'History',
  blockMinutes: 25,
  presetId: null,
  split: { lower: 25, upper: 25, core: 25, cardio: 25 },
  setupId: null,
  location: 'home',
  equipment: SETUP_TEMPLATES.home_bodyweight.equipment,
  moveKind: 'micro',
  moveMinutes: 5,
};

const CONTEXT: CycleContext = { library: STARTER_LIBRARY, byId: STARTER_LIBRARY_BY_ID, unit: 'lb' };

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Repo = { [K in keyof CycleRepo]: jest.Mock<CycleRepo[K]> };

/** Fake I/O that records the order of saves and effects in `log`. */
function fakeIo(saved: unknown = null) {
  const io = {
    saved,
    clock: T0,
    ids: 0,
    log: [] as string[],
    timers: [] as { callback: () => void; ms: number }[],
    history: new Map<string, LoggedSet[]>(),
  };
  /** Records a write as `name:key`, the key being the row id it is about. */
  const effect =
    (name: string) =>
    async (...args: unknown[]) => {
      const [first] = args;
      const input = (typeof first === 'object' && first !== null ? first : {}) as Record<string, unknown>;
      const key = typeof first === 'string' ? first : (input.id ?? input.workoutId ?? input.blockId);
      io.log.push(`${name}:${String(key)}`);
    };
  const repo: Repo = {
    startFocusBlock: jest.fn(effect('startFocusBlock')),
    endFocusBlock: jest.fn(effect('endFocusBlock')),
    rateBlock: jest.fn(effect('rateBlock')),
    startMoveBlock: jest.fn(effect('startMoveBlock')),
    logSet: jest.fn(effect('logSet')),
    finishMoveBlock: jest.fn(effect('finishMoveBlock')),
    skipMoveBlock: jest.fn(effect('skipMoveBlock')),
    lastSessionSetsFor: jest.fn(async () => io.history),
  };
  const deps = {
    readState: jest.fn(async () => io.saved),
    writeState: jest.fn(async (state: CycleState) => {
      io.saved = roundTrip(state);
      io.log.push(`save:${state.phase}:[${state.pending.map((entry) => entry.kind).join(',')}]`);
    }),
    repo,
    scheduleBlockEnd: jest.fn(async (_endsAt: number, content: { identifier?: string }) => {
      io.log.push(`schedule:${content.identifier}`);
      return content.identifier ?? null;
    }),
    cancelScheduled: jest.fn(async (id: string) => {
      io.log.push(`cancel:${id}`);
    }),
    haptic: jest.fn(),
    now: () => io.clock,
    newId: () => {
      io.ids += 1;
      return `id-${io.ids}`;
    },
    setTimeout: jest.fn((callback: () => void, ms: number) => {
      io.timers.push({ callback, ms });
      return io.timers.length;
    }),
    clearTimeout: jest.fn(),
  } satisfies CycleStoreDeps;
  return { io, deps, repo };
}

const KIND_OF_ENTRY: Record<string, string> = {
  startFocusBlock: 'start_focus_block',
  endFocusBlock: 'end_focus_block',
  rateBlock: 'rate_block',
  startMoveBlock: 'start_move_block',
  logSet: 'log_set',
  finishMoveBlock: 'finish_move_block',
  skipMoveBlock: 'skip_move_block',
  schedule: 'schedule_block_end',
  cancel: 'cancel_notification',
};

/** Every write in the log comes after a save whose pending list still holds it (the crash-safety rule). */
function expectSavedBeforeEachWrite(log: readonly string[]): void {
  let lastSaved: string[] = [];
  for (const entry of log) {
    const [name] = entry.split(':');
    if (name === 'save') {
      lastSaved = entry.slice(entry.indexOf('[') + 1, -1).split(',').filter(Boolean);
      continue;
    }
    expect({ entry, savedFirst: lastSaved.includes(KIND_OF_ENTRY[name]) }).toEqual({ entry, savedFirst: true });
  }
}

/** Lets every queued promise (saves, effects, circuit preparation) finish. */
async function settle(): Promise<void> {
  for (let k = 0; k < 30; k += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function loaded(saved: unknown = null) {
  const fake = fakeIo(saved);
  const store = new CycleStore(USER, fake.deps);
  store.setContext(CONTEXT);
  await store.load();
  await settle();
  return { store, ...fake };
}

function state(store: CycleStore): CycleState {
  const current = store.getSnapshot().state;
  if (!current) throw new Error('not loaded');
  return current;
}

async function inMove() {
  const fake = await loaded();
  fake.store.start(PLAN);
  await settle();
  fake.io.clock = T0 + 25 * MIN;
  fake.store.tick();
  await settle();
  expect(state(fake.store).phase).toBe('move');
  fake.io.log.length = 0;
  return fake;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loading', () => {
  it('starts idle when nothing is saved, and tells subscribers', async () => {
    const fake = fakeIo(null);
    const store = new CycleStore(USER, fake.deps);
    const listener = jest.fn();
    store.subscribe(listener);
    expect(store.getSnapshot()).toEqual({ state: null, error: null });
    await store.load();
    expect(store.getSnapshot().state).toEqual(initialCycleState(USER));
    expect(listener).toHaveBeenCalled();
    // load is once only.
    await store.load();
    expect(fake.deps.readState).toHaveBeenCalledTimes(1);
  });

  it('a block that ended while the app was killed hands off as soon as it loads', async () => {
    const focus = cycleReducer(initialCycleState(USER), {
      type: 'start',
      at: T0 - 2 * 60 * MIN,
      userId: USER,
      plan: PLAN,
      ids: { sessionId: 's', blockId: 'b', workoutId: 'w', transitionId: 't' },
    }) as FocusState;
    const saved = roundTrip({ ...focus, pending: [] });
    const { store, repo, deps } = await loaded(saved);
    const move = state(store) as MoveState;
    expect(move.phase).toBe('move');
    expect(repo.endFocusBlock).toHaveBeenCalledWith('b', T0 - 2 * 60 * MIN + 25 * MIN, false, T0);
    expect(repo.startMoveBlock).toHaveBeenCalledWith(expect.objectContaining({ workoutId: 'w', loggedAt: T0 }));
    expect(deps.haptic).toHaveBeenCalledWith('success');
    // The circuit was prepared on load (it had not been saved), excluding the new workout from history.
    expect(repo.lastSessionSetsFor).toHaveBeenCalledWith(expect.any(Array), { excludeWorkoutId: 'w' });
    expect(move.circuit.items.length).toBeGreaterThan(0);
  });

  it("drops another user's saved cycle", async () => {
    const other = cycleReducer(initialCycleState('someone-else'), {
      type: 'start',
      at: T0,
      userId: 'someone-else',
      plan: PLAN,
      ids: { sessionId: 's', blockId: 'b', workoutId: 'w', transitionId: 't' },
    });
    const { store, repo } = await loaded(roundTrip(other));
    expect(state(store)).toEqual(initialCycleState(USER));
    expect(repo.startFocusBlock).not.toHaveBeenCalled();
  });

  it('retries a failed read and reports it meanwhile', async () => {
    const fake = fakeIo(null);
    fake.deps.readState.mockRejectedValueOnce(new Error('db closed'));
    const store = new CycleStore(USER, fake.deps);
    await store.load();
    expect(store.getSnapshot()).toEqual({ state: null, error: CYCLE_LOAD_ERROR });
    expect(fake.io.timers).toHaveLength(1);
    expect(fake.io.timers[0].ms).toBe(1000);
    fake.io.timers[0].callback();
    await settle();
    expect(store.getSnapshot()).toEqual({ state: initialCycleState(USER), error: null });
  });
});

describe('saving before writing (crash safety)', () => {
  it('saves the state holding an effect before performing it, then saves it done', async () => {
    const { store, io, repo } = await loaded();
    store.start(PLAN);
    await settle();
    // Each effect runs only after a save that still lists it, and is acknowledged by a later save.
    expectSavedBeforeEachWrite(io.log);
    expect(io.log.filter((entry) => !entry.startsWith('save'))).toEqual(['startFocusBlock:id-2', 'schedule:block-end-id-1-1']);
    expect(io.log.at(-1)).toBe('save:focus:[]');
    expect(repo.startFocusBlock).toHaveBeenCalledWith({
      userId: USER,
      sessionId: 'id-1',
      createSession: true,
      focusSubject: 'History',
      blockId: 'id-2',
      plannedMinutes: 25,
      startedAt: T0,
    });
    // The circuit was prepared while the timer runs, and the saved state has it.
    const saved = io.saved as FocusState;
    expect(saved.pending).toEqual([]);
    expect(saved.circuit?.items.length).toBeGreaterThan(0);
  });

  it('a crash after saving but before writing: the write runs after the restart', async () => {
    const { store } = await inMove();
    const move = state(store) as MoveState;
    const event: CycleEvent = {
      type: 'log_set',
      at: T0 + 26 * MIN,
      setId: 'set-crash',
      done: 10,
      weightLbs: null,
      rpe: null,
      unit: 'lb',
      equipment: [],
    };
    // What was on disk when the app died: the set is in the state and its write still pending.
    const onDisk = roundTrip(cycleReducer(move, event));
    const restarted = await loaded(onDisk);
    expect(restarted.repo.logSet).toHaveBeenCalledTimes(1);
    expect(restarted.repo.logSet.mock.calls[0][0]).toMatchObject({ id: 'set-crash', setIndex: 0 });
    expect(state(restarted.store).pending).toEqual([]);
    expect((state(restarted.store) as MoveState).setsLogged).toBe(1);
  });

  it('a crash after writing but before the ack: the same write (same ids) runs again, so no duplicate', async () => {
    const { store, repo } = await inMove();
    store.logSet();
    await settle();
    const written = repo.logSet.mock.calls[0][0];
    // On disk when the app died: the set's write was done but its effect_done was never saved.
    const onDisk = roundTrip({ ...state(store), pending: [{ id: 99, at: T0, kind: 'log_set' as const, input: written }] });
    const restarted = await loaded(onDisk);
    // cycleRepo.logSet skips the INSERT when the row id exists, so running it again is harmless.
    expect(restarted.repo.logSet).toHaveBeenCalledTimes(1);
    expect(restarted.repo.logSet).toHaveBeenCalledWith(written);
    expect(state(restarted.store).pending).toEqual([]);
  });

  it('does not perform an effect until its state could be saved', async () => {
    const { store, io, repo, deps } = await inMove();
    deps.writeState.mockRejectedValueOnce(new Error('disk full'));
    store.logSet();
    await settle();
    expect(repo.logSet).not.toHaveBeenCalled();
    expect(store.getSnapshot().error).toBe(CYCLE_SAVE_ERROR);
    io.timers.at(-1)?.callback();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().error).toBeNull();
  });
});

describe('effects', () => {
  it('the handoff ends the block, withdraws the alert and starts the move block, in that order', async () => {
    const { store, io, deps } = await loaded();
    store.start(PLAN);
    await settle();
    io.log.length = 0;
    io.clock = T0 + 25 * MIN + 300;
    store.tick();
    await settle();
    expect(io.log.filter((entry) => !entry.startsWith('save'))).toEqual([
      'endFocusBlock:id-2',
      'cancel:block-end-id-1-1',
      'startMoveBlock:id-3',
    ]);
    expect(deps.haptic).toHaveBeenCalledWith('success');
  });

  it('a failed write is retried with backoff and later writes wait behind it', async () => {
    const { store, io, repo } = await inMove();
    repo.logSet.mockRejectedValueOnce(new Error('locked')).mockRejectedValueOnce(new Error('locked'));
    store.logSet();
    io.clock += 2 * MIN;
    store.finishMove();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(1);
    expect(repo.finishMoveBlock).not.toHaveBeenCalled();
    expect(store.getSnapshot().error).toBe(CYCLE_SAVE_ERROR);
    expect(io.timers.at(-1)?.ms).toBe(1000);
    io.timers.at(-1)?.callback();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(2);
    expect(io.timers.at(-1)?.ms).toBe(2000);
    io.timers.at(-1)?.callback();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(3);
    expect(repo.finishMoveBlock).toHaveBeenCalledTimes(1);
    expect(state(store).pending).toEqual([]);
    expect(store.getSnapshot().error).toBeNull();
  });

  it('a failed save of a change with no write behind it: the warning goes once the retry has saved it', async () => {
    const { store, io, deps } = await inMove();
    store.logSet();
    await settle();
    expect((state(store) as MoveState).rest).not.toBeNull();
    // "Skip rest" queues no write: only the state itself is saved, and that save fails once.
    deps.writeState.mockRejectedValueOnce(new Error('database is locked'));
    store.skipRest();
    await settle();
    expect(store.getSnapshot().error).toBe(CYCLE_SAVE_ERROR);
    expect(io.timers.at(-1)?.ms).toBe(1000);
    io.timers.at(-1)?.callback();
    await settle();
    expect((io.saved as MoveState).rest).toBeNull();
    expect(store.getSnapshot().error).toBeNull();
    // The backoff starts over: the next failure is retried after 1 s again.
    deps.writeState.mockRejectedValueOnce(new Error('database is locked'));
    io.clock += 5 * SEC;
    store.logSet();
    await settle();
    expect(io.timers.at(-1)?.ms).toBe(1000);
  });

  it('a save that goes through does not hide a write still failing', async () => {
    const { store, io, repo } = await inMove();
    repo.logSet.mockRejectedValueOnce(new Error('locked')).mockRejectedValueOnce(new Error('locked'));
    store.logSet();
    await settle();
    expect(store.getSnapshot().error).toBe(CYCLE_SAVE_ERROR);
    // Another change is saved fine meanwhile, but the set's write (tried again with it) still fails.
    store.skipRest();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().error).toBe(CYCLE_SAVE_ERROR);
    io.timers.at(-1)?.callback();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().error).toBeNull();
  });

  it('a write the repo refuses as invalid is dropped and reported, so the loop goes on', async () => {
    const { store, repo } = await inMove();
    repo.rateBlock.mockRejectedValueOnce(new RangeError('effort_rating must be a whole number from 1 to 5'));
    store.rateBlock(3);
    store.logSet();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(1);
    expect(state(store).pending).toEqual([]);
    expect(store.getSnapshot().error).toBe('A change was not saved: effort_rating must be a whole number from 1 to 5');
  });

  it('after dispose nothing is saved or written', async () => {
    const { store, repo, deps } = await inMove();
    const saves = deps.writeState.mock.calls.length;
    store.dispose();
    store.logSet();
    store.finish();
    await settle();
    expect(repo.logSet).not.toHaveBeenCalled();
    expect(deps.writeState.mock.calls.length).toBe(saves);
    expect(store.isDisposed).toBe(true);
  });

  it('finishAndStop() (sign-out) closes a running workout on the phone first, then stops', async () => {
    const { store, io, repo } = await inMove();
    const move = state(store) as MoveState;
    store.logSet();
    await settle();
    io.clock += 2 * MIN;
    await store.finishAndStop();
    expect(repo.finishMoveBlock).toHaveBeenCalledWith(move.workoutId, expect.any(Number), T0 + 27 * MIN);
    expect((io.saved as CycleState).phase).toBe('idle');
    expect((io.saved as CycleState).pending).toEqual([]);
    expect(store.isDisposed).toBe(true);
  });

  it('finishAndStop() loads a cycle saved on the phone and ends its focus block (interrupted)', async () => {
    const focus = cycleReducer(initialCycleState(USER), {
      type: 'start',
      at: T0 - 10 * MIN,
      userId: USER,
      plan: PLAN,
      ids: { sessionId: 's', blockId: 'b', workoutId: 'w', transitionId: 't' },
    }) as FocusState;
    const fake = fakeIo(roundTrip({ ...focus, pending: [] }));
    const store = new CycleStore(USER, fake.deps);
    await store.finishAndStop();
    expect(fake.repo.endFocusBlock).toHaveBeenCalledWith('b', T0, true, T0);
    expect(fake.deps.cancelScheduled).toHaveBeenCalledWith('block-end-s-1');
    expect(fake.repo.startMoveBlock).not.toHaveBeenCalled();
    expect(store.isDisposed).toBe(true);
  });

  it('finishAndStop() writes nothing when no cycle runs, and gives up (does not hang) when a write fails', async () => {
    const idle = await loaded();
    const saves = idle.deps.writeState.mock.calls.length;
    await idle.store.finishAndStop();
    expect(idle.deps.writeState.mock.calls.length).toBe(saves);
    expect(idle.store.isDisposed).toBe(true);

    const failing = await loaded();
    failing.store.start(PLAN);
    await settle();
    failing.repo.endFocusBlock.mockRejectedValue(new Error('locked'));
    await failing.store.finishAndStop();
    expect(failing.store.isDisposed).toBe(true);
  });

  it('stop() resolves only after the save in progress, and nothing runs after it (sign-out)', async () => {
    const { store, repo, deps } = await inMove();
    let finishSave: () => void = () => undefined;
    deps.writeState.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSave = resolve)));
    store.logSet();
    await settle();
    // The state holding the set is being saved; the set itself waits for that save.
    expect(repo.logSet).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = store.stop().then(() => (stopped = true));
    await settle();
    expect(stopped).toBe(false);
    finishSave();
    await stopping;
    await settle();
    expect(repo.logSet).not.toHaveBeenCalled();
    expect(store.isDisposed).toBe(true);
  });
});

describe('actions', () => {
  it('"Done" logs the target with the exercise equipment and the profile unit; a double tap logs one set', async () => {
    const { store, repo } = await inMove();
    const move = state(store) as MoveState;
    const first = move.circuit.items[0];
    store.logSet();
    store.logSet();
    await settle();
    expect(repo.logSet).toHaveBeenCalledTimes(1);
    expect(repo.logSet.mock.calls[0][0]).toMatchObject({
      exerciseId: first.exerciseId,
      exerciseName: first.name,
      reps: first.measure === 'time' ? first.targetSeconds : first.targetReps,
      weightLbs: first.targetWeightLbs,
      setIndex: 0,
      transitionId: move.transitionId,
    });
  });

  it('"Done" with changes logs what was done', async () => {
    const { store, repo } = await inMove();
    store.logSet({ done: 7, rpe: 10 });
    await settle();
    expect(repo.logSet.mock.calls[0][0]).toMatchObject({ reps: 7, rpe: 10 });
    expect((state(store) as MoveState).lastAdvice?.advice.action).toBe('cut_set');
  });

  it('a block started while alerts were off gets its alert once they are allowed (rescheduleAlert)', async () => {
    const { store, io, deps } = await loaded();
    // Notifications denied: scheduleBlockEnd schedules nothing.
    deps.scheduleBlockEnd.mockResolvedValueOnce(null);
    store.start(PLAN);
    await settle();
    expect(deps.scheduleBlockEnd).toHaveBeenCalledTimes(1);
    // The user turns them on and comes back: the screen asks for the alert again.
    io.clock = T0 + 4 * MIN;
    store.rescheduleAlert();
    await settle();
    expect(deps.scheduleBlockEnd).toHaveBeenCalledTimes(2);
    expect(deps.scheduleBlockEnd).toHaveBeenLastCalledWith(T0 + 25 * MIN, {
      title: 'Focus block done',
      body: 'Time to move: your 5-minute circuit is ready.',
      identifier: 'block-end-id-1-1',
    });
    expect(state(store).pending).toEqual([]);
  });

  it('pause and resume withdraw and re-schedule the alert', async () => {
    const { store, io, deps } = await loaded();
    store.start(PLAN);
    await settle();
    io.clock = T0 + 5 * MIN;
    store.pause();
    await settle();
    expect(deps.cancelScheduled).toHaveBeenCalledWith('block-end-id-1-1');
    io.clock = T0 + 15 * MIN;
    store.resume();
    await settle();
    expect(deps.scheduleBlockEnd).toHaveBeenLastCalledWith(T0 + 35 * MIN, {
      title: 'Focus block done',
      body: 'Time to move: your 5-minute circuit is ready.',
      identifier: 'block-end-id-1-1',
    });
  });

  it('skip, swap, rate, finish move, then the countdown starts the next block on its own', async () => {
    const { store, io, repo, deps } = await inMove();
    const move = state(store) as MoveState;
    const replacement = STARTER_LIBRARY.find(
      (exercise) => exercise.microOk &&
        !move.circuit.items.some((entry) => entry.exerciseId === exercise.id) &&
        exercise.equipment.every((need) => need === 'bodyweight'),
    );
    if (!replacement) throw new Error('no replacement');
    io.history = new Map([[replacement.id, [{ target: 10, done: 10, targetWeightLbs: null, weightLbs: null, rpe: 7, restSeconds: 30, setType: 'normal' }]]]);
    await store.swapExercise(1, replacement);
    await settle();
    const swapped = (state(store) as MoveState).circuit.items[1];
    expect(swapped.exerciseId).toBe(replacement.id);
    expect(repo.lastSessionSetsFor).toHaveBeenLastCalledWith([replacement.id], { excludeWorkoutId: move.workoutId });
    // Its last session was on target at 10 reps: two more this time.
    expect(swapped.targetReps).toBe(12);

    store.skipExercise();
    store.rateBlock(4);
    io.clock += 3 * MIN;
    store.finishMove();
    await settle();
    expect(repo.rateBlock).toHaveBeenCalledWith(move.blockId, 4, expect.any(Number));
    expect(repo.skipMoveBlock).toHaveBeenCalledWith(move.workoutId, move.transitionId, expect.any(Number));
    const back = state(store) as ReturnState;
    expect(back.phase).toBe('return');

    deps.haptic.mockClear();
    io.clock = (back.countdown.endsAt ?? 0) + 200;
    store.tick();
    await settle();
    const next = state(store) as FocusState;
    expect(next.phase).toBe('focus');
    expect(next.blockNumber).toBe(2);
    expect(next.sessionId).toBe(back.sessionId);
    expect(deps.haptic).toHaveBeenCalledWith('handoff');
    expect(repo.startFocusBlock).toHaveBeenLastCalledWith(expect.objectContaining({ createSession: false, blockId: next.blockId }));
    expect(next.circuit).not.toBeNull();
    expectSavedBeforeEachWrite(io.log);
  });

  it('"Just train" builds the circuit first, starts once, and finishes into a summary', async () => {
    const { store, repo } = await loaded();
    const [first, second] = await Promise.all([
      store.startMoveOnly({ ...PLAN, moveKind: 'micro', moveMinutes: 5 }),
      store.startMoveOnly({ ...PLAN, moveKind: 'micro', moveMinutes: 5 }),
    ]);
    expect([first, second]).toEqual([true, false]);
    await settle();
    const move = state(store) as MoveState;
    expect(move).toMatchObject({ phase: 'move', mode: 'move_only', transitionId: null });
    expect(repo.startMoveBlock).toHaveBeenCalledTimes(1);
    expect(repo.startMoveBlock.mock.calls[0][0].transition).toBeNull();
    store.finish();
    await settle();
    expect(state(store)).toMatchObject({ phase: 'idle', summary: { mode: 'move_only' } });
    store.dismissSummary();
    expect(state(store)).toMatchObject({ phase: 'idle', summary: null });
    await expect(store.startMoveOnly(PLAN)).resolves.toBe(true);
  });

  it('"Start now" and "End block" use fresh ids; actions in the wrong phase do nothing', async () => {
    const { store, io, deps } = await loaded();
    store.startNow();
    store.pause();
    store.logSet();
    store.skipExercise();
    await settle();
    expect(state(store)).toEqual(initialCycleState(USER));
    expect(deps.writeState).not.toHaveBeenCalled();
    store.start(PLAN);
    store.start(PLAN);
    await settle();
    expect(io.ids).toBe(4);
    io.clock += 10 * MIN;
    store.endBlock();
    await settle();
    expect(state(store).phase).toBe('move');
  });
});

describe('cycleHaptic', () => {
  const idle = initialCycleState(USER);
  const focus = cycleReducer(idle, {
    type: 'start',
    at: T0,
    userId: USER,
    plan: PLAN,
    ids: { sessionId: 's', blockId: 'b', workoutId: 'w', transitionId: 't' },
  }) as FocusState;
  const item: CircuitItem = {
    exerciseId: 'a',
    name: 'A',
    measure: 'reps',
    movementPattern: 'squat',
    region: 'lower',
    sets: 1,
    targetReps: 10,
    targetSeconds: null,
    targetWeightLbs: null,
    restSeconds: 20,
  };
  const circuit: Circuit = { version: 1, source: 'default', kind: 'micro', minutes: 5, rounds: 1, items: [item, { ...item, exerciseId: 'b' }], estimatedSeconds: 100, location: 'home', split: PLAN.split };
  const ready = cycleReducer(focus, { type: 'circuit_ready', at: T0, blockId: 'b', circuit }) as FocusState;
  const tick: CycleEvent = { type: 'tick', at: T0 + 25 * MIN };
  const move = cycleReducer(ready, tick) as MoveState;

  it('marks the zero-tap moments only', () => {
    expect(cycleHaptic(ready, move, tick)).toBe('success');
    const logEvent: CycleEvent = { type: 'log_set', at: T0 + 26 * MIN, setId: 'x', done: 10, weightLbs: null, rpe: null, unit: 'lb', equipment: [] };
    const resting = cycleReducer(move, logEvent) as MoveState;
    expect(cycleHaptic(move, resting, logEvent)).toBeNull();
    const restOver: CycleEvent = { type: 'tick', at: T0 + 27 * MIN };
    expect(cycleHaptic(resting, cycleReducer(resting, restOver), restOver)).toBe('select');
    const last: CycleEvent = { ...logEvent, at: T0 + 28 * MIN, setId: 'y' } as CycleEvent;
    const back = cycleReducer(resting, last) as ReturnState;
    expect(back.phase).toBe('return');
    expect(cycleHaptic(resting, back, last)).toBe('success');
    const countdownOver: CycleEvent = { type: 'tick', at: (back.countdown.endsAt ?? 0) + 10, ids: { blockId: 'b2', workoutId: 'w2', transitionId: 't2' } };
    expect(cycleHaptic(back, cycleReducer(back, countdownOver), countdownOver)).toBe('handoff');
    const startNow: CycleEvent = { type: 'start_now', at: T0, ids: { blockId: 'b2', workoutId: 'w2', transitionId: 't2' } };
    expect(cycleHaptic(back, cycleReducer(back, startNow), startNow)).toBeNull();
    expect(cycleHaptic(idle, focus, { type: 'start', at: T0, userId: USER, plan: PLAN, ids: { sessionId: 's', blockId: 'b', workoutId: 'w', transitionId: 't' } })).toBeNull();
  });
});
