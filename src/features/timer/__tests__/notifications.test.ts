import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

import {
  ALERT_TEST_STATE_KEY,
  cancelAllAlerts,
  cancelScheduled,
  configureNotifications,
  getNotificationPermission,
  readAlertTestResult,
  registerVisibleTimer,
  requestNotificationPermission,
  resetNotificationsForTests,
  scheduleAlertTest,
  scheduleBlockEnd,
  shouldShowInForeground,
  TIMER_CHANNEL_ID,
  type AlertTest,
} from '../notifications';

type Permission = { granted: boolean; status: string; canAskAgain: boolean; expires: 'never'; ios?: { status: number } };
const GRANTED: Permission = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' };
const DENIED: Permission = { granted: false, status: 'denied', canAskAgain: false, expires: 'never' };
const UNDETERMINED: Permission = { granted: false, status: 'undetermined', canAskAgain: true, expires: 'never' };

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 6 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(async (request: { identifier?: string }) => request.identifier ?? 'os-id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  dismissNotificationAsync: jest.fn(async () => undefined),
  cancelAllScheduledNotificationsAsync: jest.fn(async () => undefined),
  dismissAllNotificationsAsync: jest.fn(async () => undefined),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
}));
jest.mock('../../cycle/localState', () => ({ readLocalState: jest.fn(), writeLocalState: jest.fn() }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const N = jest.requireMock('expo-notifications') as Record<string, AnyMock>;
const store = jest.requireMock('../../cycle/localState') as { readLocalState: AnyMock; writeLocalState: AnyMock };

const NOW = 1_760_000_000_000;

/** jest-expo runs as iOS; Android is the platform with channels. */
function setPlatform(os: 'android' | 'ios'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetNotificationsForTests();
  setPlatform('android');
  N.getPermissionsAsync.mockResolvedValue(GRANTED);
  N.requestPermissionsAsync.mockResolvedValue(GRANTED);
  N.scheduleNotificationAsync.mockImplementation(async (request: { identifier?: string }) => request.identifier ?? 'os-id');
  N.getPresentedNotificationsAsync.mockResolvedValue([]);
  N.getAllScheduledNotificationsAsync.mockResolvedValue([]);
  store.readLocalState.mockResolvedValue(null);
  store.writeLocalState.mockResolvedValue(undefined);
});

describe('configureNotifications', () => {
  it('sets the foreground handler and creates the versioned timers channel, once', async () => {
    await configureNotifications();
    await configureNotifications();
    expect(N.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(N.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(N.setNotificationChannelAsync).toHaveBeenCalledWith('timers-v1', {
      name: 'Block timers',
      description: 'Tells you when a focus block ends.',
      importance: 6,
      vibrationPattern: [0, 300, 200, 300],
      enableVibrate: true,
      lockscreenVisibility: 1,
      sound: 'default',
    });
    expect(TIMER_CHANNEL_ID).toBe('timers-v1');
  });

  it('creates no channel on iOS, and survives a failing native call', async () => {
    setPlatform('ios');
    await configureNotifications();
    expect(N.setNotificationChannelAsync).not.toHaveBeenCalled();
    resetNotificationsForTests();
    setPlatform('android');
    N.setNotificationChannelAsync.mockRejectedValueOnce(new Error('no module'));
    N.setNotificationHandler.mockImplementationOnce(() => {
      throw new Error('no module');
    });
    await expect(configureNotifications()).resolves.toBeUndefined();
  });

  it('in the foreground, a block-end alert is silent while a timer screen is visible; others always show', async () => {
    await configureNotifications();
    const handler = N.setNotificationHandler.mock.calls[0][0] as {
      handleNotification: (notification: unknown) => Promise<Record<string, boolean>>;
    };
    const arriving = (kind: string) => ({ request: { content: { data: { kind, url: '/cycle' } } } });
    const shown = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
    const silent = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

    await expect(handler.handleNotification(arriving('block-end'))).resolves.toEqual(shown);
    const release = registerVisibleTimer();
    const second = registerVisibleTimer();
    await expect(handler.handleNotification(arriving('block-end'))).resolves.toEqual(silent);
    await expect(handler.handleNotification(arriving('alert-test'))).resolves.toEqual(shown);
    release();
    release();
    expect(shouldShowInForeground({ kind: 'block-end' })).toBe(false);
    second();
    await expect(handler.handleNotification(arriving('block-end'))).resolves.toEqual(shown);
    expect(shouldShowInForeground(undefined)).toBe(true);
  });
});

describe('permission', () => {
  it('reads the permission without asking', async () => {
    await expect(getNotificationPermission()).resolves.toBe('granted');
    N.getPermissionsAsync.mockResolvedValueOnce(DENIED);
    await expect(getNotificationPermission()).resolves.toBe('denied');
    N.getPermissionsAsync.mockResolvedValueOnce(UNDETERMINED);
    await expect(getNotificationPermission()).resolves.toBe('undetermined');
    N.getPermissionsAsync.mockResolvedValueOnce({ ...UNDETERMINED, ios: { status: 3 } });
    await expect(getNotificationPermission()).resolves.toBe('granted');
    N.getPermissionsAsync.mockRejectedValueOnce(new Error('no module'));
    await expect(getNotificationPermission()).resolves.toBe('undetermined');
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('asks only when not granted yet, after the channel exists (Android 13+ needs one to prompt)', async () => {
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(N.setNotificationChannelAsync).toHaveBeenCalled();

    N.getPermissionsAsync.mockResolvedValueOnce(UNDETERMINED);
    N.requestPermissionsAsync.mockResolvedValueOnce(DENIED);
    await expect(requestNotificationPermission()).resolves.toBe('denied');
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);

    N.getPermissionsAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });
});

describe('scheduleBlockEnd', () => {
  it('schedules a DATE alert on the timers channel that opens the cycle screen', async () => {
    const id = await scheduleBlockEnd(NOW + 25 * 60_000, { title: 'Focus block done', body: 'Time to move.', identifier: 'block-end-b1' }, NOW);
    expect(id).toBe('block-end-b1');
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'block-end-b1',
      content: { title: 'Focus block done', body: 'Time to move.', data: { url: '/cycle', kind: 'block-end' }, sound: 'default' },
      trigger: { type: 'date', date: NOW + 25 * 60_000, channelId: 'timers-v1' },
    });
  });

  it('lets the OS pick the id when none is given', async () => {
    await expect(scheduleBlockEnd(NOW + 1000, { title: 't', body: 'b' }, NOW)).resolves.toBe('os-id');
    expect(N.scheduleNotificationAsync.mock.calls[0][0]).not.toHaveProperty('identifier');
  });

  it('never throws: no alert for a past time, without permission, or when the OS refuses', async () => {
    await expect(scheduleBlockEnd(NOW, { title: 't', body: 'b' }, NOW)).resolves.toBeNull();
    await expect(scheduleBlockEnd(Number.NaN, { title: 't', body: 'b' }, NOW)).resolves.toBeNull();
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    N.getPermissionsAsync.mockResolvedValueOnce(DENIED);
    await expect(scheduleBlockEnd(NOW + 1000, { title: 't', body: 'b' }, NOW)).resolves.toBeNull();
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    N.scheduleNotificationAsync.mockRejectedValueOnce(new Error('alarm limit'));
    await expect(scheduleBlockEnd(NOW + 1000, { title: 't', body: 'b' }, NOW)).resolves.toBeNull();
  });
});

describe('cancelScheduled', () => {
  it('cancels the alert and removes it from the shade', async () => {
    await cancelScheduled('block-end-b1');
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('block-end-b1');
    expect(N.dismissNotificationAsync).toHaveBeenCalledWith('block-end-b1');
  });

  it('does nothing without an id and never throws', async () => {
    await cancelScheduled(null);
    expect(N.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    N.cancelScheduledNotificationAsync.mockRejectedValueOnce(new Error('x'));
    N.dismissNotificationAsync.mockRejectedValueOnce(new Error('x'));
    await expect(cancelScheduled('gone')).resolves.toBeUndefined();
  });
});

describe('cancelAllAlerts (sign-out)', () => {
  it('withdraws every scheduled alert and clears the shade', async () => {
    await cancelAllAlerts();
    expect(N.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(N.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    N.cancelAllScheduledNotificationsAsync.mockRejectedValueOnce(new Error('no native module'));
    N.dismissAllNotificationsAsync.mockRejectedValueOnce(new Error('no native module'));
    await expect(cancelAllAlerts()).resolves.toBeUndefined();
    expect(N.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
  });
});

describe('the timer check (D8 alert delay)', () => {
  const TEST: AlertTest = { id: `alert-test-${NOW}`, minutes: 25, scheduledAt: NOW, dueAt: NOW + 25 * 60_000, firedAt: null };

  it('schedules a test alert that opens the timer check, and remembers when it is due', async () => {
    store.readLocalState.mockResolvedValueOnce({ ...TEST, id: 'alert-test-old' });
    const test = await scheduleAlertTest(25, NOW);
    expect(test).toEqual(TEST);
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('alert-test-old');
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: `alert-test-${NOW}`,
      content: {
        title: 'Timer check',
        body: 'This is the test alert. Open DualRep to see how late it came.',
        data: { url: '/timer-check', kind: 'alert-test' },
        sound: 'default',
      },
      trigger: { type: 'date', date: NOW + 25 * 60_000, channelId: 'timers-v1' },
    });
    expect(store.writeLocalState).toHaveBeenCalledWith(ALERT_TEST_STATE_KEY, TEST);
  });

  it('waits at least a minute; no permission means no test', async () => {
    const short = await scheduleAlertTest(0, NOW);
    expect(short?.dueAt).toBe(NOW + 60_000);
    jest.clearAllMocks();
    N.getPermissionsAsync.mockResolvedValue(DENIED);
    await expect(scheduleAlertTest(1, NOW)).resolves.toBeNull();
    expect(store.writeLocalState).not.toHaveBeenCalled();
  });

  it('withdraws the alert when the due time cannot be saved', async () => {
    store.writeLocalState.mockRejectedValueOnce(new Error('disk'));
    await expect(scheduleAlertTest(1, NOW)).resolves.toBeNull();
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith(`alert-test-${NOW}`);
  });

  it('reports none, then waiting before the due time', async () => {
    await expect(readAlertTestResult(NOW)).resolves.toEqual({ status: 'none' });
    store.readLocalState.mockResolvedValue(TEST);
    await expect(readAlertTestResult(NOW + 60_000)).resolves.toEqual({ status: 'waiting', test: TEST });
  });

  it('measures the delay from the time Android posted it, and keeps it', async () => {
    store.readLocalState.mockResolvedValue(TEST);
    N.getPresentedNotificationsAsync.mockResolvedValue([
      { date: NOW + 5000, request: { identifier: 'other' } },
      { date: TEST.dueAt + 95_000, request: { identifier: TEST.id } },
    ]);
    const result = await readAlertTestResult(TEST.dueAt + 10 * 60_000);
    const saved = { ...TEST, firedAt: TEST.dueAt + 95_000 };
    expect(result).toEqual({ status: 'fired', test: saved, firedAt: TEST.dueAt + 95_000, delayMs: 95_000 });
    expect(store.writeLocalState).toHaveBeenCalledWith(ALERT_TEST_STATE_KEY, saved);

    // Later reads use the saved time, even after the alert was swiped away.
    store.readLocalState.mockResolvedValue(saved);
    N.getPresentedNotificationsAsync.mockResolvedValue([]);
    await expect(readAlertTestResult(TEST.dueAt + 60 * 60_000)).resolves.toMatchObject({ status: 'fired', delayMs: 95_000 });
  });

  it('reads a posting time given in seconds', async () => {
    store.readLocalState.mockResolvedValue(TEST);
    N.getPresentedNotificationsAsync.mockResolvedValue([{ date: (TEST.dueAt + 3000) / 1000, request: { identifier: TEST.id } }]);
    await expect(readAlertTestResult(TEST.dueAt + 60_000)).resolves.toMatchObject({ status: 'fired', delayMs: 3000 });
  });

  it('past due: delayed while still scheduled, missed once gone without being seen', async () => {
    store.readLocalState.mockResolvedValue(TEST);
    N.getAllScheduledNotificationsAsync.mockResolvedValueOnce([{ identifier: TEST.id }]);
    await expect(readAlertTestResult(TEST.dueAt + 120_000)).resolves.toEqual({ status: 'delayed', test: TEST, lateByMs: 120_000 });
    N.getAllScheduledNotificationsAsync.mockResolvedValueOnce([]);
    await expect(readAlertTestResult(TEST.dueAt + 120_000)).resolves.toEqual({ status: 'missed', test: TEST });
  });

  it('treats an unreadable record as no test', async () => {
    store.readLocalState.mockResolvedValueOnce({ id: 5 });
    await expect(readAlertTestResult(NOW)).resolves.toEqual({ status: 'none' });
    store.readLocalState.mockRejectedValueOnce(new Error('closed'));
    await expect(readAlertTestResult(NOW)).resolves.toEqual({ status: 'none' });
  });
});
