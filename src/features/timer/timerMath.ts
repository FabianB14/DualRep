/**
 * Clock-derived timers for the focus block, the rest between sets and the return countdown.
 *
 * A timer never counts down by itself. It stores when it will reach zero (`endsAt`, epoch ms) and
 * every reading is computed from the clock: remaining = endsAt - now. So nothing has to run while the
 * screen is off or the app is killed, and a timer read after a restart is exactly right
 * (docs/ANDROID.md 1.1, DECISIONS.md D8). A paused timer stores the time it had left instead.
 *
 * The state is plain JSON, so it is persisted as part of the cycle state (local_state).
 *
 * Readings are clamped: never below 0, and never above the timer's length (the phone's clock can be
 * set back while a timer runs; the timer then shows its full length until the clock catches up,
 * instead of more than it started with).
 */

export type TimerState = {
  /** The timer's full length, in ms. */
  durationMs: number;
  /** When it reaches zero if it keeps running (epoch ms); null while paused. */
  endsAt: number | null;
  /** Time left when it was paused, in ms; null while running. */
  pausedRemainingMs: number | null;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** A running timer of `durationMs` (negative or invalid lengths count as 0) started at `nowMs`. */
export function startTimer(nowMs: number, durationMs: number): TimerState {
  const duration = Math.max(0, finiteOr(durationMs, 0));
  return { durationMs: duration, endsAt: finiteOr(nowMs, 0) + duration, pausedRemainingMs: null };
}

export function isPaused(timer: TimerState): boolean {
  return timer.endsAt === null;
}

/** Time left, in ms (0 when done). */
export function remainingMs(timer: TimerState, nowMs: number): number {
  const left = timer.endsAt === null ? (timer.pausedRemainingMs ?? 0) : timer.endsAt - nowMs;
  return Math.min(timer.durationMs, Math.max(0, finiteOr(left, 0)));
}

/** Time counted so far, in ms (pauses excluded). */
export function elapsedMs(timer: TimerState, nowMs: number): number {
  return timer.durationMs - remainingMs(timer, nowMs);
}

/** How far along the timer is, 0 (just started) to 1 (done). A zero-length timer is done. */
export function progress(timer: TimerState, nowMs: number): number {
  if (timer.durationMs <= 0) return 1;
  return elapsedMs(timer, nowMs) / timer.durationMs;
}

export function isDone(timer: TimerState, nowMs: number): boolean {
  return remainingMs(timer, nowMs) <= 0;
}

/**
 * The timer paused at `nowMs`. Pausing a paused timer changes nothing, and so does pausing one that
 * is already done (there is nothing left to keep).
 */
export function pauseTimer(timer: TimerState, nowMs: number): TimerState {
  if (isPaused(timer) || isDone(timer, nowMs)) return timer;
  return { ...timer, endsAt: null, pausedRemainingMs: remainingMs(timer, nowMs) };
}

/** The timer running again from `nowMs` with the time it had left. Resuming a running timer changes nothing. */
export function resumeTimer(timer: TimerState, nowMs: number): TimerState {
  if (!isPaused(timer)) return timer;
  const left = Math.min(timer.durationMs, Math.max(0, timer.pausedRemainingMs ?? 0));
  return { ...timer, endsAt: finiteOr(nowMs, 0) + left, pausedRemainingMs: null };
}

/**
 * "m:ss" for a time left, rounded UP to the whole second, so the display reads 0:01 until the timer
 * is really done and 25:00 for the first second of a 25-minute block. An hour or more reads "h:mm:ss".
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(finiteOr(ms, 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
