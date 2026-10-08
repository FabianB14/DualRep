/**
 * Plain-word results for the timer check (DECISIONS.md D8): how late Android posted the test alert
 * compared with when it was due. Pure, so the wording is tested; the measurement itself is in
 * src/features/timer/notifications.ts (scheduleAlertTest / readAlertTestResult).
 */
import type { AlertTestResult } from '@/features/timer/notifications';

/** A delay under this counts as on time (the alarm manager and the shade add a few hundred ms). */
export const ON_TIME_MS = 1_000;

/** The test lengths offered: a quick try, and the real D8 measurement (a full focus block). */
export const TEST_MINUTES = [1, 25] as const;
export type TestMinutes = (typeof TEST_MINUTES)[number];

/** "4 s", "1 min 5 s", "12 min". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export type AlertTestSummary = {
  /** Short headline, e.g. "Rang 12 s late". */
  headline: string;
  /** What it means / what to do next. */
  detail: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
};

/** The result in plain words. `nowMs` is used for the countdown while waiting. */
export function describeAlertTest(result: AlertTestResult, nowMs: number): AlertTestSummary {
  switch (result.status) {
    case 'none':
      return { headline: 'No test yet', detail: 'Schedule a test alert to measure the delay.', tone: 'neutral' };
    case 'waiting':
      return {
        headline: `Due in ${formatDuration(result.test.dueAt - nowMs)}`,
        detail: 'Lock the phone now and leave it alone until the alert rings.',
        tone: 'info',
      };
    case 'delayed':
      return {
        headline: `${formatDuration(result.lateByMs)} late so far`,
        detail:
          'The alert was due but Android has not shown it yet. That is the delay this check measures: leave the phone locked until it rings.',
        tone: 'warning',
      };
    case 'missed':
      return {
        headline: 'Result lost',
        detail: 'The alert was swiped away before its time could be read. Run the test again, and open DualRep before clearing the alert.',
        tone: 'danger',
      };
    case 'fired': {
      const late = result.delayMs;
      if (late < ON_TIME_MS) {
        return {
          headline: 'Rang on time',
          detail: `It was posted ${late < 0 ? 'right at' : `${(Math.max(0, late) / 1000).toFixed(1)} s after`} the time it was due.`,
          tone: 'success',
        };
      }
      return {
        headline: `Rang ${formatDuration(late)} late`,
        detail: 'Android held the alert back while the phone was idle. Note this number for the timer decision (D8).',
        tone: late >= 60_000 ? 'danger' : 'warning',
      };
    }
  }
}
