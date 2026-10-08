/**
 * The spotter: DualRep's in-set coach. After every logged set it says what the next set of the same
 * exercise should be (adviseNextSet), and from a finished session it says what the next session should
 * aim for (adviseNextSession). It is plain rules, not a model, so it works with no signal and answers in
 * well under a millisecond (the plan allows 50 ms; docs/EXECUTION_PLAN.md "Why the spotter is rules, not
 * a model"). When online, Tracy may add a one-line explanation (Phase 3); she never changes the numbers.
 *
 * This header is the product spec of the spotter. Every rule is pinned by __tests__/spotter.test.ts, and
 * the numbers live in SPOTTER_RULES below.
 *
 * WORDS
 * - Target: the reps a set aims for, or the seconds of work for a timed set (measure 'time').
 * - Short by: target minus what was done. A timed set uses the same rules on seconds, but only every
 *   full 5 seconds short counts as one rep short, so tapping "Done" a second or two early is not a miss
 *   (40 s target: 36 s done is on target, 35 s is 1 short, 30 s is 2 short). The 25% and 50% checks
 *   compare the seconds themselves. (So a timed target under 10 s can never be 2 short; the default
 *   targets are 20 s and up.)
 * - Load: the weight used on the set (else its target weight), in pounds. No load (none, or 0) means a
 *   bodyweight set.
 * - Effort: RPE 1–10 (the effort chips are Easy = 6, Solid = 8, All out = 10), or unknown.
 * - Eased set: a set the spotter already made easier this session: a drop set, a rest-pause set, or a
 *   set whose target or target load is below the session's first set.
 * - Real weight: a weight on the equipment's grid of steps (units.ts: 5 lb; 2.5 kg, 2 kg for dumbbells;
 *   4 kg kettlebells). One step is the lightest load the spotter will suggest.
 *
 * THE NEXT SET (adviseNextSet). The first rule that matches wins. Unless a rule says otherwise, the next
 * set keeps the target, the load and the planned rest, and is a normal set. When the exercise is over
 * for the session (cut or done), there is no next set and the rest is the planned rest before moving on.
 * A set logged without a target is just recorded: carry on as planned.
 * 1. On target (short by 0, or more than the target): continue. If that was the last planned set (or a
 *    rest-pause set, which always comes after the last one), the exercise is done.
 * 2. Cut: stop this exercise for today when the set came up short and any of these is true:
 *    a. a quarter of the target or less was done (10 reps: 2 done; 40 s: 10 s done);
 *    b. the effort was 10 (all out);
 *    c. it was an eased set and came up 2 or more short again (a failed drop or rest-pause).
 * 3. Last planned set, 2 or more short: rest-pause. Rest 20 s, then do just the missing reps (or
 *    seconds) at the same load; that mini-set is logged as set type rest_pause and does not count as a
 *    planned set. Never twice in a row: a rest-pause set 2 or more short is cut by 2c, and one that is
 *    1 short ends the exercise (rule 4).
 * 4. Last planned set, 1 short (or a rest-pause set 1 short): the exercise is done.
 * 5. 1 short: extend the rest. Same target and load; rest 30 s longer than the rest just taken (or than
 *    the planned rest, whichever is longer), at most 180 s, and never less than the planned rest.
 * 6. 2 or more short: ease off for the next set.
 *    - With a load: drop it by 10% (2 short), 15% (3 short) or 20% (4 or more short, or half the target
 *      or less done), rounded DOWN to a real weight, never below one step. Same target; the next set is
 *      a drop set, and sets after it stay at the dropped load (still set type drop).
 *    - With no load, or a load already at one step: lower the target to what was done (at least 1).
 * The spotter never raises the load within a session.
 *
 * THE NEXT SESSION (adviseNextSession), from the last session's sets of this exercise:
 * - Working sets are the normal and drop sets (rest-pause mini-sets don't count). Last load is the
 *   lowest load used on a normal set; last target is the first normal set's target. With no normal set
 *   that had a target there is nothing to judge, and no advice (the plan's default targets apply).
 * 1. Lower when more than half the working sets came up 2 or more short: the load drops 10%, rounded
 *    down to a real weight, never below one step. With no load, or a load already at one step: the
 *    target drops 10%, rounded down, by at least 1 rep (timed: 5 s steps, at least 5 s less, never
 *    below 5 s). If nothing can go lower, hold.
 * 2. Raise only when every normal set hit its target with an effort of 8 or less (or not rated):
 *    - Reps with a load: the load goes up 5%, rounded down to a real weight. When one step is more than
 *      5% (20 lb dumbbells: 5 lb is 25%), add reps instead (double progression): +2 reps from a target
 *      of 10 or more, +1 below 10, up to 15 reps. At 15 reps, move up one step and reset the reps to the
 *      most that keep the estimated strength the set needs (Epley: load × (1 + reps / 30)) within 5% of
 *      last time; if that is fewer than 5 reps, the step is too big for one session, so hold.
 *    - Reps with no load: +2 / +1 reps the same way, up to 15, then hold.
 *    - Timed sets: the load goes up 5% when a real weight fits; else +5 s up to 60 s; then hold.
 * 3. Otherwise hold: same load and target.
 *
 * THE CAP (the plan's guardrail: "load increases are capped per session, starting at 5 percent").
 * The load never rises by more than 5% from one session to the next (next ≤ last × 1.05), and it rises
 * only on a raise. The one exception is the double-progression reset, where the weight goes up a whole
 * step and the reps fall so that load × (1 + reps / 30) still rises by 5% at most. Every rep raise keeps
 * that measure within 5% too: +1 rep never adds more than 1/30, and +2 is only used from 10 reps up,
 * where it adds 2/40 = 5% at most.
 */
import type { Measure, Unit } from './types';
import {
  formatWeight,
  loadIncrement,
  roundDownToIncrement,
  stepWeight,
  toLbs,
  type EquipmentInput,
} from './units';

/** exercise_sets.set_type. */
export type SetType = 'normal' | 'drop' | 'rest_pause';

/** What the spotter tells the user to do next within the session. */
export type SpotterAction = 'continue' | 'extend_rest' | 'drop_weight' | 'lower_target' | 'rest_pause' | 'cut_set';

/** What the next session should do with the exercise. */
export type SessionAction = 'raise' | 'hold' | 'lower';

/** One logged set of the exercise, as the spotter reads it (an exercise_sets row, measure-neutral). */
export type LoggedSet = {
  /** Target reps, or target seconds of work when the measure is 'time'. null = no target. */
  target: number | null;
  /** Reps done, or seconds of work done. */
  done: number;
  /** The load aimed for, in pounds; null for bodyweight. */
  targetWeightLbs: number | null;
  /** The load used, in pounds; null = the target load (bodyweight when that is null too). */
  weightLbs: number | null;
  /** Effort, RPE 1–10, or null when not rated. */
  rpe: number | null;
  /** Rest taken before this set, in seconds; null when unknown (or the first set). */
  restSeconds: number | null;
  setType: SetType;
};

/** Targets for a set, in the same shape as a CircuitItem's (one of reps/seconds is null by measure). */
export type SetTargets = {
  targetReps: number | null;
  targetSeconds: number | null;
  /** Pounds; null for bodyweight. */
  targetWeightLbs: number | null;
};

export type NextSetInput = {
  measure: Measure;
  /** The profile's unit: real weights and messages use it. */
  unit: Unit;
  /** The exercise's equipment list (decides the load step). */
  equipment: EquipmentInput;
  /** Planned sets of this exercise in this session (a micro circuit: its rounds). */
  plannedSets: number;
  /** Planned rest after each set of this exercise, in seconds (CircuitItem.restSeconds). */
  plannedRestSeconds: number;
  /** The set just logged. */
  last: LoggedSet;
  /** The sets of this exercise logged earlier in this session, oldest first (not including `last`). */
  earlier: readonly LoggedSet[];
};

export type SpotterAdvice = {
  action: SpotterAction;
  /** Targets for the next set, or null when the exercise is over for this session (cut or done). */
  next: SetTargets | null;
  /** Rest before the next set (or before moving on, when `next` is null), in seconds. */
  restSeconds: number;
  /** set_type to log the next set with. */
  setType: SetType;
  /** One line of plain English for the screen. */
  message: string;
};

export type NextSessionContext = {
  measure: Measure;
  unit: Unit;
  equipment: EquipmentInput;
};

export type NextSessionAdvice = SetTargets & {
  action: SessionAction;
  message: string;
};

/** The numbers behind the rules in the header. */
export const SPOTTER_RULES = {
  /** A timed set counts every full this-many seconds short as one rep short. */
  secondsPerRep: 5,
  /** Cut when this fraction of the target or less was done. */
  cutAtFraction: 0.25,
  /** Drop the most when this fraction of the target or less was done. */
  bigMissFraction: 0.5,
  /** Load drop in percent when 2, 3, and 4 or more reps short. */
  dropPercents: [10, 15, 20],
  restPauseSeconds: 20,
  extraRestSeconds: 30,
  maxExtendedRestSeconds: 180,
  /** Highest effort (RPE) that still allows a raise next session. */
  raiseMaxRpe: 8,
  /** Per-session load-increase cap. */
  sessionLoadCap: 0.05,
  /** Next-session drop when most sets missed. */
  lowerFraction: 0.1,
  /** Top of the rep range in double progression. */
  topReps: 15,
  /** Fewest reps a double-progression reset may ask for. */
  minResetReps: 5,
  /** Timed progression: step and ceiling, in seconds. */
  timeStepSeconds: 5,
  topSeconds: 60,
} as const;

const R = SPOTTER_RULES;

/** Float slack for comparisons of fractions and converted weights. */
const EPSILON = 1e-9;

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The target of a set when it has a usable one (> 0), else null. */
function targetOf(set: LoggedSet): number | null {
  const target = finite(set.target);
  return target !== null && target > 0 ? target : null;
}

function doneOf(set: LoggedSet): number {
  return Math.max(0, finite(set.done) ?? 0);
}

/** The load of a set in pounds, or null for a bodyweight set. */
function loadOf(set: LoggedSet): number | null {
  const load = finite(set.weightLbs) ?? finite(set.targetWeightLbs);
  return load !== null && load > 0 ? load : null;
}

function targetLoadOf(set: LoggedSet): number | null {
  const load = finite(set.targetWeightLbs);
  return load !== null && load > 0 ? load : null;
}

/** How many reps short of the target a set came (timed sets: whole 5 s steps). 0 = on target. */
function repsShort(target: number, done: number, measure: Measure): number {
  const short = target - done;
  if (short <= 0) return 0;
  return measure === 'time' ? Math.floor(short / R.secondsPerRep + EPSILON) : Math.ceil(short - EPSILON);
}

/** True when the set was already made easier this session (see "Eased set" in the header). */
function wasEased(last: LoggedSet, earlier: readonly LoggedSet[]): boolean {
  if (last.setType !== 'normal') return true;
  const first = earlier[0];
  if (!first) return false;
  const [firstTarget, lastTarget] = [targetOf(first), targetOf(last)];
  if (firstTarget !== null && lastTarget !== null && lastTarget < firstTarget - EPSILON) return true;
  const [firstLoad, lastLoad] = [targetLoadOf(first), targetLoadOf(last)];
  return firstLoad !== null && lastLoad !== null && lastLoad < firstLoad - EPSILON;
}

function targets(measure: Measure, amount: number | null, loadLbs: number | null): SetTargets {
  return {
    targetReps: measure === 'reps' ? amount : null,
    targetSeconds: measure === 'time' ? amount : null,
    targetWeightLbs: loadLbs,
  };
}

/** Up to one decimal, so messages never show float noise. */
function tidy(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "1 rep", "10 reps", "40 s". */
function amountText(amount: number, measure: Measure): string {
  const value = tidy(amount);
  if (measure === 'time') return `${value} s`;
  return value === 1 ? '1 rep' : `${value} reps`;
}

/** "10 reps at 25 lb", or "10 reps" for bodyweight. */
function aimText(amount: number, measure: Measure, loadLbs: number | null, unit: Unit): string {
  const text = amountText(amount, measure);
  return loadLbs === null ? text : `${text} at ${formatWeight(loadLbs, unit)}`;
}

/** One load step for the equipment, in pounds (the lightest load the spotter suggests). */
function oneStepLbs(unit: Unit, equipment: EquipmentInput): number {
  return toLbs(loadIncrement(unit, equipment), unit);
}

/** What the next set of the same exercise in this session should be. See the header for the rules. */
export function adviseNextSet(input: NextSetInput): SpotterAdvice {
  const { measure, unit, equipment, last, earlier } = input;
  const plannedRest = Math.max(0, Math.round(finite(input.plannedRestSeconds) ?? 0));
  const plannedSets = Math.max(1, Math.floor(finite(input.plannedSets) ?? 1));
  const load = loadOf(last);
  const target = targetOf(last);
  const done = doneOf(last);
  // Rest-pause mini-sets are extras after the last planned set, not planned sets.
  const setsDone = [...earlier, last].filter((set) => set.setType !== 'rest_pause').length;
  const planDone = last.setType === 'rest_pause' || setsDone >= plannedSets;
  // A set after a drop stays at the dropped load, so it is still a drop set.
  const sameType: SetType = last.setType === 'drop' ? 'drop' : 'normal';

  /** Advice for one more set aiming at `amount` with `loadLbs`. */
  const another = (
    action: SpotterAction,
    amount: number | null,
    loadLbs: number | null,
    extra: { restSeconds?: number; setType?: SetType; message: string },
  ): SpotterAdvice => ({
    action,
    next: targets(measure, amount, loadLbs),
    restSeconds: extra.restSeconds ?? plannedRest,
    setType: extra.setType ?? sameType,
    message: extra.message,
  });
  /** Advice that ends the exercise for this session. */
  const over = (action: SpotterAction, message: string): SpotterAdvice => ({
    action,
    next: null,
    restSeconds: plannedRest,
    setType: 'normal',
    message,
  });
  const allDone = plannedSets === 1 ? 'That one is done.' : `All ${plannedSets} sets done.`;

  // Nothing to judge without a target: carry on as planned.
  if (target === null) {
    return planDone ? over('continue', `Logged. ${allDone}`) : another('continue', null, load, { message: 'Logged.' });
  }

  const short = repsShort(target, done, measure);
  const shortText = `${amountText(target - done, measure)} short`;
  const sameAim = aimText(target, measure, load, unit);

  // Rule 1: on target.
  if (short === 0) {
    if (last.setType === 'rest_pause') {
      return over('continue', `Made up the missing ${measure === 'time' ? 'time' : 'reps'}. That one is done.`);
    }
    if (planDone) return over('continue', `On target. ${allDone}`);
    return another('continue', target, load, { message: `On target. Same again: ${sameAim}.` });
  }

  // Rule 2: cut.
  const fraction = done / target;
  const rpe = finite(last.rpe);
  if (fraction <= R.cutAtFraction + EPSILON) {
    const doneText = `${amountText(done, measure)} of ${tidy(target)}`;
    return over('cut_set', `Only ${doneText}. That's enough of this one for today.`);
  }
  if (rpe !== null && rpe >= 10) {
    return over('cut_set', `All out and ${shortText}. Stop this one for today.`);
  }
  if (short >= 2 && wasEased(last, earlier)) {
    return over('cut_set', `Still ${shortText} after easing off. Stop this one for today.`);
  }

  // Rules 3 and 4: the last planned set.
  if (planDone) {
    if (short >= 2 && last.setType !== 'rest_pause') {
      const missing = tidy(target - done);
      const aim = aimText(missing, measure, load, unit);
      return another('rest_pause', missing, load, {
        restSeconds: R.restPauseSeconds,
        setType: 'rest_pause',
        message: `${shortText}. Rest ${R.restPauseSeconds} s, then do the last ${aim}.`,
      });
    }
    return over('continue', `${shortText} on the last set. That one is done.`);
  }

  // Rule 5: 1 short.
  if (short === 1) {
    const taken = Math.max(0, finite(last.restSeconds) ?? 0);
    const extended = Math.min(R.maxExtendedRestSeconds, Math.max(plannedRest, taken) + R.extraRestSeconds);
    const restSeconds = Math.max(plannedRest, Math.round(extended));
    const message = `${shortText}. Rest ${restSeconds} s, then same again: ${sameAim}.`;
    return another('extend_rest', target, load, { restSeconds, message });
  }

  // Rule 6: 2 or more short.
  if (load !== null) {
    const [two, three, fourOrMore] = R.dropPercents;
    const percent = short >= 4 || fraction <= R.bigMissFraction + EPSILON ? fourOrMore : short === 3 ? three : two;
    const dropped = Math.max(
      oneStepLbs(unit, equipment),
      roundDownToIncrement(load * (1 - percent / 100), unit, equipment),
    );
    if (dropped < load - EPSILON) {
      const aim = aimText(target, measure, dropped, unit);
      return another('drop_weight', target, dropped, { setType: 'drop', message: `${shortText}. Next set: ${aim}.` });
    }
  }
  const lowered = Math.max(1, Math.floor(done + EPSILON));
  const aim = aimText(lowered, measure, load, unit);
  return another('lower_target', lowered, load, { message: `${shortText}. Next set: aim for ${aim}.` });
}

/** Epley's estimate of the one-rep max a set needs: load × (1 + reps / 30). */
export function estimatedMax(loadLbs: number, reps: number): number {
  return loadLbs * (1 + reps / 30);
}

/** The target 10% lower (reps: at least 1 less, min 1; timed: 5 s steps, at least 5 s less, min 5 s). */
function lowerTarget(target: number, measure: Measure): number {
  if (measure === 'time') {
    const step = R.timeStepSeconds;
    const down = Math.floor((target * (1 - R.lowerFraction)) / step + EPSILON) * step;
    return Math.max(step, Math.min(target - step, down));
  }
  return Math.max(1, Math.min(target - 1, Math.floor(target * (1 - R.lowerFraction) + EPSILON)));
}

/** Reps added in one session: +2 from 10 reps up, +1 below, never past the top of the range. */
function addReps(target: number): number {
  return Math.min(R.topReps, target + (target >= 10 ? 2 : 1));
}

/**
 * What the next session should aim for, from the last session's sets of this exercise (oldest first).
 * Returns null when there is nothing to judge (no normal set with a target). See the header for the rules.
 */
export function adviseNextSession(
  lastSessionSets: readonly LoggedSet[],
  ctx: NextSessionContext,
): NextSessionAdvice | null {
  const { measure, unit, equipment } = ctx;
  const working = lastSessionSets.filter((set) => set.setType !== 'rest_pause' && targetOf(set) !== null);
  const normal = working.filter((set) => set.setType === 'normal');
  const target = normal.length > 0 ? targetOf(normal[0]) : null;
  if (target === null) return null;
  const loads = normal.map(loadOf).filter((value): value is number => value !== null);
  const load = loads.length > 0 ? Math.min(...loads) : null;
  const shortOf = (set: LoggedSet) => repsShort(targetOf(set) ?? 0, doneOf(set), measure);
  const advise = (action: SessionAction, amount: number, loadLbs: number | null, message: string) =>
    ({ action, ...targets(measure, amount, loadLbs), message }) satisfies NextSessionAdvice;
  const same = aimText(target, measure, load, unit);

  // Rule 1: lower.
  const bigMisses = working.filter((set) => shortOf(set) >= 2).length;
  if (bigMisses * 2 > working.length) {
    const why = 'most sets came up 2 or more short';
    if (load !== null) {
      const down = Math.max(
        oneStepLbs(unit, equipment),
        roundDownToIncrement(load * (1 - R.lowerFraction), unit, equipment),
      );
      if (down < load - EPSILON) {
        const aim = aimText(target, measure, down, unit);
        return advise('lower', target, down, `Next time: ${aim}. Lighter, because ${why}.`);
      }
    }
    const fewer = lowerTarget(target, measure);
    if (fewer < target) {
      const aim = aimText(fewer, measure, load, unit);
      return advise('lower', fewer, load, `Next time: ${aim}. Fewer, because ${why}.`);
    }
    return advise('hold', target, load, `Next time: ${same} again. It can't go lower, so keep at it.`);
  }

  // Rule 2: raise.
  const ready = normal.every((set) => {
    const rpe = finite(set.rpe);
    return shortOf(set) === 0 && (rpe === null || rpe <= R.raiseMaxRpe);
  });
  if (!ready) {
    return advise('hold', target, load, `Next time: ${same} again, until every set hits with effort to spare.`);
  }

  if (load !== null) {
    const up = roundDownToIncrement(load * (1 + R.sessionLoadCap), unit, equipment);
    if (up > load + EPSILON) {
      const aim = aimText(target, measure, up, unit);
      return advise('raise', target, up, `Next time: ${aim}. Up from ${formatWeight(load, unit)}.`);
    }
  }

  if (measure === 'time') {
    if (target < R.topSeconds) {
      const longer = Math.min(R.topSeconds, target + R.timeStepSeconds);
      return advise('raise', longer, load, `Next time: ${aimText(longer, measure, load, unit)}. A little longer.`);
    }
    return advise('hold', target, load, `Next time: ${same} again. That's the top of the range.`);
  }

  if (target < R.topReps) {
    const more = addReps(target);
    return advise('raise', more, load, `Next time: ${aimText(more, measure, load, unit)}. ${more - target} more.`);
  }

  if (load !== null) {
    // Double progression: at the top of the range, one step heavier with the reps reset under the cap.
    const heavier = stepWeight(load, unit, equipment, 1);
    const allowed = (1 + R.sessionLoadCap) * estimatedMax(load, target);
    const reps = Math.min(target, Math.floor(30 * (allowed / heavier - 1) + EPSILON));
    if (reps >= R.minResetReps) {
      return advise(
        'raise',
        reps,
        heavier,
        `Next time: ${aimText(reps, measure, heavier, unit)}. Heavier, with fewer reps to build back up.`,
      );
    }
    return advise(
      'hold',
      target,
      load,
      `Next time: ${same} again. ${formatWeight(heavier, unit)} is too big a jump for one session.`,
    );
  }
  return advise('hold', target, load, `Next time: ${same} again. Top of the range: try a harder version.`);
}
