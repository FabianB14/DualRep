import { describe, expect, it } from '@jest/globals';

import {
  elapsedMs,
  formatClock,
  isDone,
  isPaused,
  pauseTimer,
  progress,
  remainingMs,
  resumeTimer,
  startTimer,
} from '../timerMath';

const T0 = 1_760_000_000_000;
const MIN = 60_000;

describe('startTimer', () => {
  it('stores when the timer reaches zero, as plain JSON', () => {
    const timer = startTimer(T0, 25 * MIN);
    expect(timer).toEqual({ durationMs: 25 * MIN, endsAt: T0 + 25 * MIN, pausedRemainingMs: null });
    expect(JSON.parse(JSON.stringify(timer))).toEqual(timer);
    expect(isPaused(timer)).toBe(false);
  });

  it('treats a negative or invalid length as zero (done at once)', () => {
    expect(startTimer(T0, -5)).toEqual({ durationMs: 0, endsAt: T0, pausedRemainingMs: null });
    expect(startTimer(T0, Number.NaN).durationMs).toBe(0);
    expect(isDone(startTimer(T0, 0), T0)).toBe(true);
    expect(progress(startTimer(T0, 0), T0)).toBe(1);
  });
});

describe('readings come from the clock', () => {
  const timer = startTimer(T0, 10 * MIN);

  it('remaining, elapsed and progress at any moment', () => {
    expect(remainingMs(timer, T0)).toBe(10 * MIN);
    expect(elapsedMs(timer, T0)).toBe(0);
    expect(progress(timer, T0)).toBe(0);
    expect(remainingMs(timer, T0 + 4 * MIN)).toBe(6 * MIN);
    expect(elapsedMs(timer, T0 + 4 * MIN)).toBe(4 * MIN);
    expect(progress(timer, T0 + 4 * MIN)).toBeCloseTo(0.4);
    expect(isDone(timer, T0 + 10 * MIN - 1)).toBe(false);
  });

  it('is done at endsAt and stays at zero afterwards (a read after a restart)', () => {
    expect(isDone(timer, T0 + 10 * MIN)).toBe(true);
    expect(remainingMs(timer, T0 + 3 * 60 * MIN)).toBe(0);
    expect(elapsedMs(timer, T0 + 3 * 60 * MIN)).toBe(10 * MIN);
    expect(progress(timer, T0 + 3 * 60 * MIN)).toBe(1);
  });

  it('never shows more than its length when the clock is set back', () => {
    expect(remainingMs(timer, T0 - 5 * MIN)).toBe(10 * MIN);
    expect(progress(timer, T0 - 5 * MIN)).toBe(0);
  });
});

describe('pause and resume', () => {
  it('pausing keeps the time left; resuming continues from it', () => {
    const running = startTimer(T0, 10 * MIN);
    const paused = pauseTimer(running, T0 + 3 * MIN);
    expect(paused).toEqual({ durationMs: 10 * MIN, endsAt: null, pausedRemainingMs: 7 * MIN });
    expect(isPaused(paused)).toBe(true);
    // Time does not pass while paused.
    expect(remainingMs(paused, T0 + 60 * MIN)).toBe(7 * MIN);
    expect(isDone(paused, T0 + 60 * MIN)).toBe(false);
    const resumed = resumeTimer(paused, T0 + 20 * MIN);
    expect(resumed).toEqual({ durationMs: 10 * MIN, endsAt: T0 + 27 * MIN, pausedRemainingMs: null });
    expect(remainingMs(resumed, T0 + 25 * MIN)).toBe(2 * MIN);
    expect(elapsedMs(resumed, T0 + 25 * MIN)).toBe(8 * MIN);
  });

  it('several pauses add up: elapsed counts only running time', () => {
    let timer = startTimer(T0, 10 * MIN);
    timer = pauseTimer(timer, T0 + 1 * MIN); // 1 min run
    timer = resumeTimer(timer, T0 + 5 * MIN);
    timer = pauseTimer(timer, T0 + 7 * MIN); // 2 more
    timer = resumeTimer(timer, T0 + 30 * MIN);
    expect(elapsedMs(timer, T0 + 31 * MIN)).toBe(4 * MIN);
    expect(timer.endsAt).toBe(T0 + 37 * MIN);
  });

  it('pausing twice, resuming a running timer, or pausing a finished one changes nothing', () => {
    const running = startTimer(T0, MIN);
    const paused = pauseTimer(running, T0 + 1000);
    expect(pauseTimer(paused, T0 + 5000)).toBe(paused);
    expect(resumeTimer(running, T0 + 5000)).toBe(running);
    expect(pauseTimer(running, T0 + MIN)).toBe(running);
    expect(pauseTimer(running, T0 + 2 * MIN)).toBe(running);
  });
});

describe('formatClock', () => {
  it('reads m:ss, rounding up to the whole second', () => {
    expect(formatClock(25 * MIN)).toBe('25:00');
    expect(formatClock(25 * MIN - 1)).toBe('25:00');
    expect(formatClock(24 * MIN + 59_001)).toBe('25:00');
    expect(formatClock(24 * MIN + 59_000)).toBe('24:59');
    expect(formatClock(30_000)).toBe('0:30');
    expect(formatClock(1)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-100)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('shows hours past 60 minutes', () => {
    expect(formatClock(60 * MIN)).toBe('1:00:00');
    expect(formatClock(75 * MIN + 5000)).toBe('1:15:05');
  });
});
