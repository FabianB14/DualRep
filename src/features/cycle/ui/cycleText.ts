/**
 * The words and numbers the cycle screen shows: targets ("10 reps · 25 lb"), the preview of the move
 * block, the time left as a screen reader says it, the summary. Pure, so the phrasing is unit-tested
 * and every phase says things the same way.
 */
import { statsSentence, type Stat, type StatusTone } from '@/components';
import { formatClock } from '@/features/timer/timerMath';
import type { SpotterAction } from '@/features/training/spotter';
import type { Circuit, Measure, SetupLocation, Unit, WorkoutKind } from '@/features/training/types';
import { formatWeight } from '@/features/training/units';

import type { CycleSummary, Station } from '../cycleMachine';

/** "1 set", "2 sets". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What one set aims for: "10 reps", "40 s", "No set target". */
export function amountLabel(target: number | null, measure: Measure): string {
  if (target === null || !Number.isFinite(target)) return 'No set target';
  const amount = Math.max(0, Math.round(target));
  return measure === 'time' ? `${amount} s` : plural(amount, 'rep', 'reps');
}

/** A set's target with its load: "10 reps · 25 lb", "40 s", "12 reps" (no load = bodyweight). */
export function targetLabel(target: number | null, measure: Measure, weightLbs: number | null, unit: Unit): string {
  const amount = amountLabel(target, measure);
  return weightLbs !== null && weightLbs > 0 ? `${amount} · ${formatWeight(weightLbs, unit)}` : amount;
}

/** The target as a screen reader says it: "10 reps at 25 lb" (no "·" to read out). */
export function spokenTarget(target: number | null, measure: Measure, weightLbs: number | null, unit: Unit): string {
  const amount = amountLabel(target, measure);
  return weightLbs !== null && weightLbs > 0 ? `${amount} at ${formatWeight(weightLbs, unit)}` : amount;
}

/** The move block in a few words: "10-min home circuit", "45-min gym session". */
export function moveLabel(plan: { moveKind: WorkoutKind; moveMinutes: number; location: SetupLocation }): string {
  return `${plan.moveMinutes}-min ${plan.location} ${plan.moveKind === 'micro' ? 'circuit' : 'session'}`;
}

/**
 * The focus screen's preview of what comes next: "Next: 10-min home circuit · Goblet squat first".
 * Before the circuit is ready (it is built in the first moments of the block) only the kind shows.
 */
export function previewLine(
  plan: { moveKind: WorkoutKind; moveMinutes: number; location: SetupLocation },
  circuit: Pick<Circuit, 'items'> | null,
): string {
  const first = circuit?.items.find((item) => item.sets > 0);
  return first ? `Next: ${moveLabel(plan)} · ${first.name} first` : `Next: ${moveLabel(plan)}`;
}

/**
 * Whole minutes left, matching the clock: the clock rounds up to the second, so this changes exactly
 * when the clock's minutes do (24:00 → "24 minutes left", 23:59 → "23 minutes left"). Screen readers
 * hear it once a minute instead of every second.
 */
export function wholeMinutesLeft(ms: number): number {
  const seconds = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  return Math.floor(seconds / 60);
}

/** "12 minutes left", "1 minute left", "Less than a minute left". */
export function minutesLeftLabel(ms: number): string {
  const minutes = wholeMinutesLeft(ms);
  return minutes === 0 ? 'Less than a minute left' : `${plural(minutes, 'minute', 'minutes')} left`;
}

/** "Rest 0:45". */
export function restLabel(ms: number): string {
  return `Rest ${formatClock(ms)}`;
}

/**
 * Where the user is in the move block: "Round 2 of 3 · Exercise 1 of 4" (micro: round-robin) or
 * "Set 2 of 3 · Exercise 1 of 4" (full: straight sets). A rest-pause mini-set says so.
 */
export function stationProgressLabel(station: Station, kind: WorkoutKind, itemCount: number): string {
  const exercise = `Exercise ${station.index + 1} of ${itemCount}`;
  if (station.restPause) return `Rest-pause set · ${exercise}`;
  const step =
    kind === 'micro'
      ? `Round ${station.round} of ${station.rounds}`
      : `Set ${station.setNumber} of ${station.plannedSets}`;
  return `${step} · ${exercise}`;
}

/** How the spotter's note is colored: good news, a change of plan, or the exercise stops. */
export function adviceTone(action: SpotterAction): StatusTone {
  switch (action) {
    case 'continue':
      return 'success';
    case 'cut_set':
      return 'warning';
    default:
      return 'info';
  }
}

export type SummaryStat = Stat;

/** The finish summary's numbers: a study cycle counts blocks, focus minutes and sets; "Just train" sets and minutes. */
export function summaryStats(summary: CycleSummary): SummaryStat[] {
  const sets = { value: summary.sets, label: summary.sets === 1 ? 'set' : 'sets' };
  if (summary.mode === 'move_only') {
    const minutes = Math.max(0, Math.round((summary.finishedAt - summary.startedAt) / 60_000));
    return [sets, { value: minutes, label: minutes === 1 ? 'minute' : 'minutes' }];
  }
  const focusMinutes = Math.max(0, Math.round(summary.focusMs / 60_000));
  return [
    { value: summary.blocks, label: summary.blocks === 1 ? 'focus block' : 'focus blocks' },
    { value: focusMinutes, label: 'focus minutes' },
    sets,
  ];
}

/** The summary as one sentence, for screen readers: "2 focus blocks, 50 focus minutes, 18 sets." */
export function summarySentence(summary: CycleSummary): string {
  return statsSentence(summaryStats(summary));
}

/** The finish summary's heading. */
export function summaryTitle(summary: CycleSummary): string {
  if (summary.mode === 'move_only') return summary.sets > 0 ? 'Workout done' : 'Workout ended';
  return summary.blocks > 0 || summary.sets > 0 ? 'Nice work' : 'Cycle ended';
}

/** The running totals on the return screen: "1 focus block · 25 min · 8 sets". */
export function runningTotals(stats: { blocks: number; focusMs: number; sets: number }): string {
  const minutes = Math.max(0, Math.round(stats.focusMs / 60_000));
  return `${plural(stats.blocks, 'focus block', 'focus blocks')} · ${minutes} min · ${plural(stats.sets, 'set', 'sets')}`;
}
