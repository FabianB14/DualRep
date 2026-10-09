import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { notificationUrl, useNotificationRouting } from '../useNotificationRouting';

type Listener = (response: unknown) => void;
const mockListeners: Listener[] = [];
const mockRemove = jest.fn();
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 6 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  dismissNotificationAsync: jest.fn(async () => undefined),
  addNotificationResponseReceivedListener: jest.fn((listener: Listener) => {
    mockListeners.push(listener);
    return { remove: mockRemove };
  }),
}));
// The timer-check alert's posting time is saved in local_state before its screen opens.
jest.mock('../../cycle/localState', () => ({ readLocalState: jest.fn(async () => null), writeLocalState: jest.fn(async () => undefined) }));
const mockRouter = { navigate: jest.fn() };
const mockNavigation = { state: { key: 'root' } as { key?: string } | undefined };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useRootNavigationState: () => mockNavigation.state,
}));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const N = jest.requireMock('expo-notifications') as Record<string, AnyMock>;
const local = jest.requireMock('../../cycle/localState') as Record<string, AnyMock>;

function response(url: unknown, identifier = 'block-end-b1', date = 1_760_000_000_000, kind?: string) {
  const data = kind === undefined ? { url } : { url, kind };
  return { actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { date, request: { identifier, content: { data } } } };
}

function Probe() {
  useNotificationRouting();
  return null;
}

function mount(): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(createElement(Probe));
  });
  return renderer!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.length = 0;
  mockNavigation.state = { key: 'root' };
  N.getLastNotificationResponse.mockReturnValue(null);
});

describe('notificationUrl', () => {
  it('accepts only in-app paths', () => {
    expect(notificationUrl(response('/cycle') as never)).toBe('/cycle');
    expect(notificationUrl(response('/timer-check') as never)).toBe('/timer-check');
    for (const bad of ['https://evil.example', '//evil.example', 'cycle', '/cy cle', 42, undefined]) {
      expect(notificationUrl(response(bad) as never)).toBeNull();
    }
    expect(notificationUrl(null)).toBeNull();
    expect(notificationUrl({} as never)).toBeNull();
  });
});

describe('useNotificationRouting', () => {
  it('opens the screen of a tap that launched the app (cold start), once, and clears it', () => {
    N.getLastNotificationResponse.mockReturnValue(response('/cycle'));
    const renderer = mount();
    expect(mockRouter.navigate).toHaveBeenCalledTimes(1);
    expect(mockRouter.navigate).toHaveBeenCalledWith('/cycle');
    expect(N.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    // The same response arriving through the listener too is not opened again.
    act(() => mockListeners[0](response('/cycle')));
    expect(mockRouter.navigate).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('opens the screen of a tap while the app runs (warm)', () => {
    mount();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    act(() => mockListeners[0](response('/timer-check', 'alert-test-1')));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/timer-check');
    act(() => mockListeners[0](response('/cycle', 'block-end-b2')));
    expect(mockRouter.navigate).toHaveBeenLastCalledWith('/cycle');
    expect(mockRouter.navigate).toHaveBeenCalledTimes(2);
  });

  it('a tapped timer-check alert has its posting time saved before its screen opens', async () => {
    const due = 1_760_000_000_000;
    const test = { id: 'alert-test-1', minutes: 25, scheduledAt: due - 25 * 60_000, dueAt: due, firedAt: null };
    local.readLocalState.mockResolvedValueOnce(test);
    mount();
    act(() => mockListeners[0](response('/timer-check', 'alert-test-1', due + 47_000, 'alert-test')));
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(local.writeLocalState).toHaveBeenCalledWith('alert-test', { ...test, firedAt: due + 47_000 });
    expect(mockRouter.navigate).toHaveBeenCalledWith('/timer-check');
    // A block-end alert opens at once, with nothing saved.
    act(() => mockListeners[0](response('/cycle', 'block-end-b3', due + 48_000, 'block-end')));
    expect(mockRouter.navigate).toHaveBeenLastCalledWith('/cycle');
    expect(local.writeLocalState).toHaveBeenCalledTimes(1);
  });

  it('waits for the root navigator before opening', () => {
    mockNavigation.state = undefined;
    N.getLastNotificationResponse.mockReturnValue(response('/cycle'));
    const renderer = mount();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    mockNavigation.state = { key: 'root' };
    act(() => renderer.update(createElement(Probe)));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/cycle');
  });

  it('ignores a notification without an in-app url and survives a missing native module', () => {
    N.getLastNotificationResponse.mockImplementation(() => {
      throw new Error('unavailable');
    });
    mount();
    act(() => mockListeners[0](response('https://example.com')));
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });
});
