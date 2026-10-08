import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { STARTER_LIBRARY, STARTER_LIBRARY_BY_ID } from '@/features/training/starterLibrary';

import type { CyclePlanInput } from '../cycleMachine';
import { cycleStoreFor, resetCycleStore, stopCycleForSignOut, useCycle, type UseCycleResult } from '../useCycle';

const USER = '11111111-1111-4111-8111-111111111111';
const T0 = 1_760_000_000_000;
const MIN = 60_000;

const mockAuth: { user: { id: string } | null } = { user: { id: USER } };
jest.mock('../../../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
const mockLibraryView = {
  exercises: [] as unknown[],
  byId: new Map() as ReadonlyMap<string, unknown>,
  circuitPool: [] as unknown[],
  isLoading: false,
};
jest.mock('../../training/useLibrary', () => ({ useLibrary: () => mockLibraryView }));
jest.mock('@powersync/react-native', () => ({ useQuery: () => ({ data: [{ unit_pref: 'kg' }], isLoading: false }) }));
jest.mock('../cycleRepo', () => ({
  startFocusBlock: jest.fn(async () => undefined),
  endFocusBlock: jest.fn(async () => undefined),
  rateBlock: jest.fn(async () => undefined),
  startMoveBlock: jest.fn(async () => undefined),
  logSet: jest.fn(async () => undefined),
  finishMoveBlock: jest.fn(async () => undefined),
  skipMoveBlock: jest.fn(async () => undefined),
  lastSessionSetsFor: jest.fn(async () => new Map()),
}));
jest.mock('../localState', () => ({ readLocalState: jest.fn(async () => null), writeLocalState: jest.fn(async () => undefined) }));
const mockRelease = jest.fn();
jest.mock('../../timer/notifications', () => ({
  scheduleBlockEnd: jest.fn(async () => 'id'),
  cancelScheduled: jest.fn(async () => undefined),
  cancelAllAlerts: jest.fn(async () => undefined),
  registerVisibleTimer: jest.fn(() => mockRelease),
}));
jest.mock('../../../theme', () => ({ haptic: jest.fn() }));
let mockIds = 0;
jest.mock('../../../lib/ids', () => ({ newId: () => `id-${(mockIds += 1)}` }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const repo = jest.requireMock('../cycleRepo') as Record<string, AnyMock>;
const local = jest.requireMock('../localState') as Record<string, AnyMock>;
const notifications = jest.requireMock('../../timer/notifications') as Record<string, AnyMock>;
const theme = jest.requireMock('../../../theme') as Record<string, AnyMock>;

const PLAN: CyclePlanInput = {
  split: { lower: 25, upper: 25, core: 25, cardio: 25 },
  location: 'home',
  equipment: [],
  blockMinutes: 10,
  moveKind: 'micro',
  moveMinutes: 5,
};

async function settle(): Promise<void> {
  for (let k = 0; k < 30; k += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
}

const appStateListeners: ((status: string) => void)[] = [];
const setAppState = (status: string) => appStateListeners.forEach((listener) => listener(status));
const appStateRemove = jest.fn();

function mountTwo() {
  const seen: { a: UseCycleResult | null; b: UseCycleResult | null } = { a: null, b: null };
  function A() {
    seen.a = useCycle();
    return null;
  }
  function B() {
    seen.b = useCycle();
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(createElement('View', null, createElement(A), createElement(B)));
  });
  return { seen, renderer: renderer! };
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.clearAllMocks();
  resetCycleStore();
  mockAuth.user = { id: USER };
  appStateListeners.length = 0;
  mockLibraryView.circuitPool = STARTER_LIBRARY;
  mockLibraryView.byId = STARTER_LIBRARY_BY_ID;
  (AppState as unknown as { currentState: string }).currentState = 'active';
  (AppState.addEventListener as unknown as AnyMock).mockImplementation((_type: string, listener: (status: string) => void) => {
    appStateListeners.push(listener);
    return { remove: appStateRemove };
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useCycle', () => {
  it('two screens share one store: one start writes one study session and one block', async () => {
    const { seen } = mountTwo();
    await settle();
    expect(local.readLocalState).toHaveBeenCalledTimes(1);
    expect(local.readLocalState).toHaveBeenCalledWith('cycle');
    expect(seen.a?.state?.phase).toBe('idle');
    expect(seen.a?.unit).toBe('kg');
    act(() => seen.a?.start(PLAN));
    act(() => seen.b?.start(PLAN));
    await settle();
    expect(seen.a?.state?.phase).toBe('focus');
    expect(seen.b?.state).toBe(seen.a?.state);
    expect(repo.startFocusBlock).toHaveBeenCalledTimes(1);
    expect(notifications.scheduleBlockEnd).toHaveBeenCalledTimes(1);
    expect(local.writeLocalState).toHaveBeenLastCalledWith('cycle', seen.a?.state);
    expect(cycleStoreFor(USER)).toBe(cycleStoreFor(USER));
  });

  it('ticks every second while the app is open and hands off when the block ends', async () => {
    const { seen } = mountTwo();
    await settle();
    act(() => seen.a?.start(PLAN));
    await settle();
    expect(seen.a?.now).toBe(T0);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(seen.a?.now).toBe(T0 + 5000);

    // In the background nothing ticks; coming back ticks at once.
    act(() => setAppState('background'));
    await act(async () => {
      jest.advanceTimersByTime(10 * MIN);
    });
    expect(seen.a?.state?.phase).toBe('focus');
    expect(seen.a?.now).toBe(T0 + 5000);
    act(() => setAppState('active'));
    await settle();
    expect(seen.a?.state?.phase).toBe('move');
    expect(repo.endFocusBlock).toHaveBeenCalledTimes(1);
    expect(repo.startMoveBlock).toHaveBeenCalledTimes(1);
    expect(theme.haptic).toHaveBeenCalledWith('success');
  });

  it('holds the in-app alert silence while mounted (one hold per screen)', async () => {
    const { renderer } = mountTwo();
    await settle();
    expect(notifications.registerVisibleTimer).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
    expect(mockRelease).toHaveBeenCalledTimes(2);
    expect(appStateRemove).toHaveBeenCalledTimes(2);
  });

  it('signed out: no state, and the store stops', async () => {
    const { seen, renderer } = mountTwo();
    await settle();
    const store = cycleStoreFor(USER);
    mockAuth.user = null;
    act(() => renderer.update(createElement('View', null)));
    act(() => {
      renderer.unmount();
    });
    const again = mountTwo();
    await settle();
    expect(again.seen.a?.state).toBeNull();
    expect(again.seen.a?.loading).toBe(true);
    expect(store.isDisposed).toBe(true);
    expect(seen.a).not.toBeNull();
  });

  it('sign-out stops the store whether or not the screen is open, after its write in progress, then withdraws every alert', async () => {
    const { seen, renderer } = mountTwo();
    await settle();
    act(() => seen.a?.start(PLAN));
    await settle();
    // The cycle screen is closed (the user went to Settings); the focus block's alert is scheduled.
    act(() => renderer.unmount());
    const store = cycleStoreFor(USER);
    let finishWrite: () => void = () => undefined;
    repo.endFocusBlock.mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)));
    store.endBlock();
    await settle();
    expect(repo.endFocusBlock).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = stopCycleForSignOut().then(() => (stopped = true));
    await settle();
    // Waits for the write in progress, so it cannot land after the local data is cleared.
    expect(stopped).toBe(false);
    expect(store.isDisposed).toBe(true);
    finishWrite();
    await stopping;
    expect(notifications.cancelAllAlerts).toHaveBeenCalledTimes(1);
    // Nothing after it: the move block the handoff queued is never started.
    expect(repo.startMoveBlock).not.toHaveBeenCalled();
    expect(cycleStoreFor(USER)).not.toBe(store);
  });
});
