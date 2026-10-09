import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

import {
  cancelReviewReminder,
  ensureReviewsChannel,
  nextLocalTime,
  reminderContent,
  rescheduleReviewReminder,
  resetRemindersForTests,
  REVIEWS_CHANNEL_ID,
} from '../reminders';

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  SchedulableTriggerInputTypes: { DAILY: 'daily', DATE: 'date' },
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async (request: { identifier?: string }) => request.identifier ?? 'os-id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
}));
jest.mock('../../timer/notifications', () => ({ getNotificationPermission: jest.fn(async () => 'granted') }));
jest.mock('../studyRepo', () => ({ countDueCards: jest.fn(async () => 0), firstDueAfter: jest.fn(async () => null) }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const N = jest.requireMock('expo-notifications') as Record<string, AnyMock>;
const permission = (jest.requireMock('../../timer/notifications') as { getNotificationPermission: AnyMock }).getNotificationPermission;
const repo = jest.requireMock('../studyRepo') as { countDueCards: AnyMock; firstDueAfter: AnyMock };

const USER = '11111111-1111-4111-8111-111111111111';
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0).getTime(); // local time
const endOfDay = (day: number) => new Date(2026, 9, day + 1, 0, 0, 0, 0).getTime() - 1; // local time
const SIX_PM = { enabled: true, hour: 18, minute: 0 };

function setPlatform(os: 'android' | 'ios'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRemindersForTests();
  setPlatform('android');
  permission.mockResolvedValue('granted');
  N.setNotificationChannelAsync.mockResolvedValue(null);
  N.scheduleNotificationAsync.mockImplementation(async (request: { identifier?: string }) => request.identifier ?? 'os-id');
  repo.countDueCards.mockResolvedValue(0);
  repo.firstDueAfter.mockResolvedValue(null);
});

describe('nextLocalTime', () => {
  it('is today’s time when it is still ahead, else tomorrow’s', () => {
    expect(nextLocalTime({ hour: 18, minute: 0 }, at(9, 10))).toBe(at(9, 18));
    expect(nextLocalTime({ hour: 18, minute: 0 }, at(9, 18))).toBe(at(10, 18));
    expect(nextLocalTime({ hour: 18, minute: 0 }, at(9, 18), true)).toBe(at(9, 18));
    expect(nextLocalTime({ hour: 18, minute: 0 }, at(9, 18, 1), true)).toBe(at(10, 18));
    expect(nextLocalTime({ hour: 7, minute: 30 }, at(31, 23))).toBe(new Date(2026, 10, 1, 7, 30).getTime());
  });
});

describe('reminderContent', () => {
  it('counts the cards', () => {
    expect(reminderContent(1)).toEqual({ title: 'Cards to review', body: '1 card is due. A 10-minute block clears a lot of them.' });
    expect(reminderContent(23).body).toBe('23 cards are due. A 10-minute block clears a lot of them.');
  });
});

describe('rescheduleReviewReminder', () => {
  it('with cards due on the reminder’s day: a DAILY reminder on the reviews channel with the count', async () => {
    repo.countDueCards.mockResolvedValue(12);
    const outcome = await rescheduleReviewReminder(USER, SIX_PM, { now: at(9, 10) });
    expect(outcome).toEqual({ status: 'daily', at: at(9, 18), count: 12 });
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('reviews-due');
    expect(repo.countDueCards).toHaveBeenCalledWith(USER, endOfDay(9));
    expect(N.setNotificationChannelAsync).toHaveBeenCalledWith('reviews-v1', {
      name: 'Review reminders',
      description: 'Once a day, when cards are due.',
      importance: 3,
      lockscreenVisibility: 1,
      sound: 'default',
    });
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'reviews-due',
      content: {
        title: 'Cards to review',
        body: '12 cards are due. A 10-minute block clears a lot of them.',
        data: { url: '/', kind: 'reviews-due' },
        sound: 'default',
      },
      trigger: { type: 'daily', hour: 18, minute: 0, channelId: REVIEWS_CHANNEL_ID },
    });
  });

  it('with nothing due that day: one reminder at the time on the day the next card falls due', async () => {
    const firstDue = at(12, 9, 15);
    repo.firstDueAfter.mockResolvedValue(firstDue);
    repo.countDueCards.mockImplementation(async (_user: string, until: number) => (until >= firstDue ? 4 : 0));
    const outcome = await rescheduleReviewReminder(USER, SIX_PM, { now: at(9, 10) });
    expect(outcome).toEqual({ status: 'once', at: at(12, 18), count: 4 });
    expect(repo.firstDueAfter).toHaveBeenCalledWith(USER, endOfDay(9));
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'reviews-due',
        content: expect.objectContaining({ body: '4 cards are due. A 10-minute block clears a lot of them.' }),
        trigger: { type: 'date', date: at(12, 18), channelId: REVIEWS_CHANNEL_ID },
      }),
    );
  });

  it('a card due exactly at the reminder time is in that reminder', async () => {
    repo.firstDueAfter.mockResolvedValue(at(12, 18));
    repo.countDueCards.mockImplementation(async (_user: string, until: number) => (until >= at(12, 18) ? 1 : 0));
    await expect(rescheduleReviewReminder(USER, SIX_PM, { now: at(9, 10) })).resolves.toEqual({ status: 'once', at: at(12, 18), count: 1 });
  });

  it('a card due minutes after the reminder time is in that day’s reminder, not the next day’s', async () => {
    // Studied at the 09:00 reminder: the cards come back at 09:02 a few days later. That day's 09:00
    // reminder (and block) includes them; waiting for the next 09:00 would be a day late.
    const NINE = { enabled: true, hour: 9, minute: 0 };
    repo.countDueCards.mockImplementation(async (_user: string, until: number) => (until >= at(10, 9, 2) ? 5 : 0));
    await expect(rescheduleReviewReminder(USER, NINE, { now: at(9, 9, 30) })).resolves.toEqual({ status: 'daily', at: at(10, 9), count: 5 });
    repo.countDueCards.mockImplementation(async (_user: string, until: number) => (until >= at(13, 9, 2) ? 3 : 0));
    repo.firstDueAfter.mockResolvedValue(at(13, 9, 2));
    await expect(rescheduleReviewReminder(USER, NINE, { now: at(9, 9, 30) })).resolves.toEqual({ status: 'once', at: at(13, 9), count: 3 });
    expect(N.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: { type: 'date', date: at(13, 9), channelId: REVIEWS_CHANNEL_ID } }));
  });

  it('nothing ever due: no reminder at all', async () => {
    await expect(rescheduleReviewReminder(USER, SIX_PM, { now: at(9, 10) })).resolves.toEqual({ status: 'nothing_due' });
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('reviews-due');
  });

  it('turned off, signed out or not allowed: the old reminder is withdrawn and nothing scheduled', async () => {
    await expect(rescheduleReviewReminder(USER, { ...SIX_PM, enabled: false })).resolves.toEqual({ status: 'off' });
    await expect(rescheduleReviewReminder(USER, null)).resolves.toEqual({ status: 'off' });
    await expect(rescheduleReviewReminder(null, SIX_PM)).resolves.toEqual({ status: 'off' });
    permission.mockResolvedValue('denied');
    await expect(rescheduleReviewReminder(USER, SIX_PM)).resolves.toEqual({ status: 'no_permission' });
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(4);
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('never throws: an OS refusal or a failing read is reported', async () => {
    repo.countDueCards.mockResolvedValue(3);
    N.scheduleNotificationAsync.mockRejectedValueOnce(new Error('no module'));
    await expect(rescheduleReviewReminder(USER, SIX_PM, { now: at(9, 10) })).resolves.toEqual({ status: 'failed' });
    repo.countDueCards.mockRejectedValueOnce(new Error('db closed'));
    await expect(rescheduleReviewReminder(USER, SIX_PM, { now: at(9, 10) })).resolves.toEqual({ status: 'failed' });
    N.cancelScheduledNotificationAsync.mockRejectedValueOnce(new Error('no module'));
    await expect(cancelReviewReminder()).resolves.toBeUndefined();
  });

  it('uses injected readers when given', async () => {
    const countDue = jest.fn(async () => 2);
    await rescheduleReviewReminder(USER, { enabled: true, hour: 7, minute: 45 }, { now: at(9, 10), countDue });
    expect(countDue).toHaveBeenCalledWith(USER, endOfDay(10));
    expect(repo.countDueCards).not.toHaveBeenCalled();
  });
});

describe('ensureReviewsChannel', () => {
  it('creates the channel once on Android, never on iOS, and retries after a failure', async () => {
    await ensureReviewsChannel();
    await ensureReviewsChannel();
    expect(N.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    resetRemindersForTests();
    N.setNotificationChannelAsync.mockRejectedValueOnce(new Error('no module'));
    await ensureReviewsChannel();
    await ensureReviewsChannel();
    expect(N.setNotificationChannelAsync).toHaveBeenCalledTimes(3);
    resetRemindersForTests();
    setPlatform('ios');
    await ensureReviewsChannel();
    expect(N.setNotificationChannelAsync).toHaveBeenCalledTimes(3);
  });
});
