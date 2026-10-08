import { describe, expect, it, jest } from '@jest/globals';

import type { AlertTest } from '@/features/timer/notifications';

import { signOutWarning } from '../signOut';
import { describeAlertTest, formatDuration, ON_TIME_MS, TEST_MINUTES } from '../timerCheck';

// notifications.ts imports expo-notifications (native) and the database; only its types are used here.
jest.mock('expo-notifications', () => ({ AndroidImportance: { HIGH: 4 }, AndroidNotificationVisibility: { PUBLIC: 1 } }));
jest.mock('../../../db/database', () => ({ db: {} }));

describe('signOutWarning', () => {
  it('reassures when nothing is waiting to upload', () => {
    expect(signOutWarning(0)).toEqual({
      title: 'Sign out?',
      message: 'Your data stays safe on the server. This phone’s copy is removed.',
      confirmLabel: 'Sign out',
    });
    expect(signOutWarning(Number.NaN).confirmLabel).toBe('Sign out');
    expect(signOutWarning(-3).confirmLabel).toBe('Sign out');
  });

  it('says how many changes would be lost, in the right number', () => {
    expect(signOutWarning(1)).toEqual({
      title: 'Sign out?',
      message: '1 change has not been uploaded yet and will be lost. Connect to the internet first to keep it.',
      confirmLabel: 'Sign out and lose changes',
    });
    expect(signOutWarning(4).message).toBe(
      '4 changes have not been uploaded yet and will be lost. Connect to the internet first to keep them.',
    );
  });
});

describe('timer check wording', () => {
  const DUE = Date.UTC(2026, 9, 8, 10, 0, 0);
  const test: AlertTest = { id: 'alert-test-1', minutes: 25, scheduledAt: DUE - 25 * 60_000, dueAt: DUE, firedAt: null };

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(4_400)).toBe('4 s');
    expect(formatDuration(65_000)).toBe('1 min 5 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(-3_000)).toBe('3 s');
  });

  it('offers a quick try and the real 25-minute measurement', () => {
    expect(TEST_MINUTES).toEqual([1, 25]);
  });

  it('describes every state', () => {
    expect(describeAlertTest({ status: 'none' }, DUE)).toMatchObject({ headline: 'No test yet', tone: 'neutral' });
    expect(describeAlertTest({ status: 'waiting', test }, DUE - 90_000)).toMatchObject({
      headline: 'Due in 1 min 30 s',
      tone: 'info',
    });
    expect(describeAlertTest({ status: 'delayed', test, lateByMs: 42_000 }, DUE + 42_000)).toMatchObject({
      headline: '42 s late so far',
      tone: 'warning',
    });
    expect(describeAlertTest({ status: 'missed', test }, DUE)).toMatchObject({ headline: 'Result lost', tone: 'danger' });
  });

  it('calls a delay under a second on time, and grades longer ones', () => {
    const fired = (delayMs: number) =>
      describeAlertTest({ status: 'fired', test, firedAt: DUE + delayMs, delayMs }, DUE + delayMs + 5_000);
    expect(fired(400)).toMatchObject({ headline: 'Rang on time', tone: 'success' });
    expect(fired(400).detail).toBe('It was posted 0.4 s after the time it was due.');
    expect(fired(-200).detail).toBe('It was posted right at the time it was due.');
    expect(fired(ON_TIME_MS)).toMatchObject({ headline: 'Rang 1 s late', tone: 'warning' });
    expect(fired(12_000)).toMatchObject({ headline: 'Rang 12 s late', tone: 'warning' });
    expect(fired(5 * 60_000)).toMatchObject({ headline: 'Rang 5 min late', tone: 'danger' });
  });
});
