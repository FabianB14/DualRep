import { describe, expect, it } from '@jest/globals';

import {
  adviseNextSession,
  adviseNextSet,
  estimatedMax,
  SPOTTER_RULES,
  type LoggedSet,
  type NextSessionContext,
  type NextSetInput,
} from '../spotter';
import type { Measure, Unit } from '../types';
import { loadIncrement, roundDownToIncrement, toLbs } from '../units';

const kg = (value: number) => toLbs(value, 'kg');

/** A logged set: by default 10 of 10 reps at 100 lb, effort not rated, a normal set. */
function logged(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    target: 10,
    done: 10,
    targetWeightLbs: 100,
    weightLbs: 100,
    rpe: null,
    restSeconds: 90,
    setType: 'normal',
    ...overrides,
  };
}

/** The first of 3 planned barbell sets in lb, 90 s rest, unless overridden. */
function input(last: Partial<LoggedSet>, overrides: Partial<NextSetInput> = {}): NextSetInput {
  return {
    measure: 'reps',
    unit: 'lb',
    equipment: ['barbell', 'bench', 'rack'],
    plannedSets: 3,
    plannedRestSeconds: 90,
    earlier: [],
    last: logged(last),
    ...overrides,
  };
}

const advise = (last: Partial<LoggedSet>, overrides: Partial<NextSetInput> = {}) =>
  adviseNextSet(input(last, overrides));

/** The last of 3 planned sets: two earlier sets on target. */
const LAST_SET: Partial<NextSetInput> = { earlier: [logged(), logged()] };

const BODYWEIGHT = { targetWeightLbs: null, weightLbs: null } as const;

describe('adviseNextSet: on target', () => {
  it('continues with the same target, load and planned rest', () => {
    expect(advise({ done: 10 })).toEqual({
      action: 'continue',
      next: { targetReps: 10, targetSeconds: null, targetWeightLbs: 100 },
      restSeconds: 90,
      setType: 'normal',
      message: 'On target. Same again: 10 reps at 100 lb.',
    });
  });

  it('counts beating the target as on target, and never raises the load within a session', () => {
    const advice = advise({ done: 14, rpe: 6 });
    expect(advice.action).toBe('continue');
    expect(advice.next).toEqual({ targetReps: 10, targetSeconds: null, targetWeightLbs: 100 });
  });

  it('carries on at the load actually used; no weight ("None") is a bodyweight set, whatever the target', () => {
    expect(advise({ weightLbs: 95 }).next?.targetWeightLbs).toBe(95);
    expect(advise({ weightLbs: null }).next?.targetWeightLbs).toBeNull();
    expect(advise({ weightLbs: 0 }).next?.targetWeightLbs).toBeNull();
  });

  it('keeps an effort of 10 on a set that hit its target', () => {
    expect(advise({ rpe: 10 }).action).toBe('continue');
  });

  it('ends the exercise after the last planned set', () => {
    expect(advise({}, LAST_SET)).toMatchObject({
      action: 'continue',
      next: null,
      restSeconds: 90,
      message: 'On target. All 3 sets done.',
    });
    expect(advise({}, { plannedSets: 1 })).toMatchObject({ next: null, message: 'On target. That one is done.' });
  });

  it('does not count rest-pause mini-sets as planned sets', () => {
    const earlier = [logged(), logged({ setType: 'rest_pause', target: 3, done: 3 })];
    expect(advise({}, { earlier }).next).not.toBeNull();
    expect(advise({}, { earlier: [...earlier, logged()] }).next).toBeNull();
  });

  it('carries on as planned when the set has no target', () => {
    expect(advise({ target: null, done: 7 })).toMatchObject({
      action: 'continue',
      next: { targetReps: null, targetSeconds: null, targetWeightLbs: 100 },
    });
    expect(advise({ target: 0 }, LAST_SET)).toMatchObject({ action: 'continue', next: null });
  });
});

describe('adviseNextSet: 1 short extends the rest', () => {
  it('keeps the target and load and rests 30 s longer', () => {
    expect(advise({ done: 9, restSeconds: 90 })).toEqual({
      action: 'extend_rest',
      next: { targetReps: 10, targetSeconds: null, targetWeightLbs: 100 },
      restSeconds: 120,
      setType: 'normal',
      message: '1 rep short. Rest 120 s, then same again: 10 reps at 100 lb.',
    });
  });

  it.each([
    // [planned rest, rest taken, next rest]
    [90, null, 120],
    [90, 0, 120],
    [90, 45, 120],
    [90, 120, 150],
    [60, 140, 170],
    [90, 150, 180],
    [90, 151, 180],
    [90, 400, 180],
    [160, 60, 180],
    [180, 180, 180],
    [200, 90, 200],
    [0, 0, 30],
  ])('planned %p s, taken %p s → %p s (at most 180 s, never under the plan)', (planned, taken, rest) => {
    expect(advise({ done: 9, restSeconds: taken }, { plannedRestSeconds: planned }).restSeconds).toBe(rest);
  });

  it('escalates over repeated 1-short sets through the rest actually taken', () => {
    const first = advise({ done: 9, restSeconds: null }, { plannedRestSeconds: 60 });
    const second = advise({ done: 9, restSeconds: first.restSeconds }, { plannedRestSeconds: 60, earlier: [logged()] });
    expect([first.restSeconds, second.restSeconds]).toEqual([90, 120]);
  });

  it('keeps a drop set a drop set', () => {
    const earlier = [logged({ done: 7 })];
    const dropSet = { setType: 'drop', targetWeightLbs: 85, weightLbs: 85 } as const;
    const advice = advise({ ...dropSet, done: 9 }, { earlier, plannedSets: 4 });
    expect(advice).toMatchObject({ action: 'extend_rest', setType: 'drop', next: { targetWeightLbs: 85 } });
  });

  it('ends the exercise instead on the last planned set', () => {
    expect(advise({ done: 9 }, LAST_SET)).toMatchObject({
      action: 'continue',
      next: null,
      message: '1 rep short on the last set. That one is done.',
    });
  });
});

describe('adviseNextSet: 2 or more short drops the load', () => {
  it.each([
    // [target, done, drop %]: 2 short → 10%, 3 → 15%, 4 or more → 20%, half or less done → 20%.
    [10, 8, 10],
    [10, 7, 15],
    [10, 6, 20],
    [10, 5, 20],
    [10, 3, 20],
    [12, 4, 20],
    [5, 3, 10],
    [7, 4, 15],
    [7, 2, 20],
    [6, 3, 20],
    [4, 2, 20],
  ])('target %p, done %p → %p%% lighter', (target, done, percent) => {
    // 200 lb on a 5 lb grid: 10% → 180, 15% → 170, 20% → 160 are all real weights.
    const advice = advise({ target, done, targetWeightLbs: 200, weightLbs: 200 });
    expect(advice).toMatchObject({
      action: 'drop_weight',
      next: { targetReps: target, targetSeconds: null, targetWeightLbs: 200 * (1 - percent / 100) },
      restSeconds: 90,
      setType: 'drop',
    });
  });

  it('says what to do in the user’s unit', () => {
    expect(advise({ done: 7 }).message).toBe('3 reps short. Next set: 10 reps at 85 lb.');
    const metric = advise({ done: 8, targetWeightLbs: kg(60), weightLbs: kg(60) }, { unit: 'kg' });
    expect(metric.message).toBe('2 reps short. Next set: 10 reps at 52.5 kg.');
  });

  it.each([
    // [equipment, unit, load used, reps done of 10, next load]
    ['barbell', 'lb', 135, 8, 120],
    ['barbell', 'lb', 135, 7, 110],
    ['barbell', 'lb', 135, 6, 105],
    ['dumbbell', 'lb', 25, 8, 20],
    ['dumbbell', 'lb', 10, 6, 5],
    ['machine', 'lb', 97, 8, 85],
    ['barbell', 'kg', kg(60), 8, kg(52.5)],
    ['barbell', 'kg', kg(60), 7, kg(50)],
    ['barbell', 'kg', kg(60), 6, kg(47.5)],
    ['cable', 'kg', kg(20), 8, kg(17.5)],
    ['dumbbell', 'kg', kg(12), 8, kg(10)],
    ['dumbbell', 'kg', kg(4), 6, kg(2)],
    ['kettlebell', 'kg', kg(16), 8, kg(12)],
    ['kettlebell', 'lb', kg(16), 8, kg(12)],
    ['kettlebell', 'kg', kg(8), 7, kg(4)],
  ] as [string, Unit, number, number, number][])(
    '%s in %s: %p lb, %p of 10 → %p lb (rounded down to a real weight)',
    (equipment, unit, load, done, next) => {
      const advice = advise({ done, targetWeightLbs: load, weightLbs: load }, { equipment: [equipment], unit });
      expect(advice.action).toBe('drop_weight');
      expect(advice.next?.targetWeightLbs).toBeCloseTo(next, 9);
      expect(roundDownToIncrement(advice.next?.targetWeightLbs ?? 0, unit, equipment)).toBeCloseTo(next, 9);
    },
  );

  it('drops from the load actually used', () => {
    expect(advise({ done: 8, targetWeightLbs: 100, weightLbs: 120 }).next?.targetWeightLbs).toBe(105);
  });

  it('never goes below one step: at one step it lowers the target instead', () => {
    const atOneStep = advise({ done: 7, targetWeightLbs: 5, weightLbs: 5 }, { equipment: ['dumbbell'] });
    expect(atOneStep).toMatchObject({
      action: 'lower_target',
      next: { targetReps: 7, targetWeightLbs: 5 },
      setType: 'normal',
      message: '3 reps short. Next set: aim for 7 reps at 5 lb.',
    });
    const kettlebell = advise({ done: 6, targetWeightLbs: kg(4), weightLbs: kg(4) }, { equipment: 'kettlebell' });
    expect(kettlebell.action).toBe('lower_target');
    // Below one step (an odd 3 lb) the floor would be a raise, so the target drops instead.
    const odd = advise({ done: 6, targetWeightLbs: 3, weightLbs: 3 }, { equipment: 'dumbbell' });
    expect(odd.action).toBe('lower_target');
  });

  it('never suggests more load than was used, over a grid of loads, units and equipment', () => {
    for (const unit of ['lb', 'kg'] as Unit[]) {
      for (const equipment of ['barbell', 'dumbbell', 'kettlebell', 'machine', 'bodyweight']) {
        for (let load = 1; load <= 400; load += 3.7) {
          for (let done = 0; done <= 12; done++) {
            const advice = advise({ done, targetWeightLbs: load, weightLbs: load }, { unit, equipment });
            if (advice.next?.targetWeightLbs != null) expect(advice.next.targetWeightLbs).toBeLessThanOrEqual(load);
          }
        }
      }
    }
  });
});

describe('adviseNextSet: bodyweight', () => {
  it('lowers the rep target to what was done instead of dropping a load', () => {
    expect(advise({ ...BODYWEIGHT, target: 12, done: 9 })).toEqual({
      action: 'lower_target',
      next: { targetReps: 9, targetSeconds: null, targetWeightLbs: null },
      restSeconds: 90,
      setType: 'normal',
      message: '3 reps short. Next set: aim for 9 reps.',
    });
    expect(advise({ ...BODYWEIGHT, target: 12, done: 4 }).next?.targetReps).toBe(4);
  });

  it('treats a load of 0 as bodyweight', () => {
    expect(advise({ targetWeightLbs: 0, weightLbs: 0, done: 7 }).action).toBe('lower_target');
  });

  it('goes by the weight used when the user picked "None" over a target weight (no drop from a load never lifted)', () => {
    // 10 reps at 25 lb planned; the user had no dumbbells to hand, set the weight to None and did 8.
    const none = { targetWeightLbs: 25, weightLbs: null } as const;
    expect(advise({ ...none, done: 8 }, { equipment: 'dumbbell' })).toEqual({
      action: 'lower_target',
      next: { targetReps: 8, targetSeconds: null, targetWeightLbs: null },
      restSeconds: 90,
      setType: 'normal',
      message: '2 reps short. Next set: aim for 8 reps.',
    });
    expect(advise({ ...none, done: 9 }).message).toBe('1 rep short. Rest 120 s, then same again: 10 reps.');
  });

  it('lowers to at least 1 rep', () => {
    expect(advise({ ...BODYWEIGHT, target: 3, done: 1 }).next?.targetReps).toBe(1);
  });

  it('cuts after a lowered target comes up 2 or more short again', () => {
    const earlier = [logged({ ...BODYWEIGHT, target: 12, done: 8 })];
    expect(advise({ ...BODYWEIGHT, target: 8, done: 6 }, { earlier }).action).toBe('cut_set');
    expect(advise({ ...BODYWEIGHT, target: 8, done: 7 }, { earlier }).action).toBe('extend_rest');
  });

  it('uses the same rest, extend and rest-pause rules', () => {
    expect(advise({ ...BODYWEIGHT, done: 10 }).next?.targetWeightLbs).toBeNull();
    expect(advise({ ...BODYWEIGHT, done: 9 }).action).toBe('extend_rest');
    expect(advise({ ...BODYWEIGHT, done: 6 }, LAST_SET)).toMatchObject({
      action: 'rest_pause',
      next: { targetReps: 4, targetWeightLbs: null },
      message: '4 reps short. Rest 20 s, then do the last 4 reps.',
    });
  });
});

describe('adviseNextSet: rest-pause on the last planned set', () => {
  it.each([
    [10, 8, 2],
    [10, 7, 3],
    [10, 4, 6],
    [8, 3, 5],
  ])('target %p, done %p → rest 20 s, then the missing %p at the same load', (target, done, missing) => {
    const earlier = [logged({ target, done: target }), logged({ target, done: target })];
    expect(advise({ target, done }, { earlier })).toMatchObject({
      action: 'rest_pause',
      next: { targetReps: missing, targetSeconds: null, targetWeightLbs: 100 },
      restSeconds: 20,
      setType: 'rest_pause',
    });
  });

  it('says so in one line', () => {
    expect(advise({ done: 7 }, LAST_SET).message).toBe('3 reps short. Rest 20 s, then do the last 3 reps at 100 lb.');
  });

  it('never twice in a row', () => {
    const earlier = [logged(), logged(), logged({ done: 7 })];
    const restPause = (done: number) => advise({ setType: 'rest_pause', target: 3, done }, { earlier });
    expect(restPause(3)).toMatchObject({ action: 'continue', next: null });
    expect(restPause(5)).toMatchObject({ action: 'continue', next: null });
    expect(restPause(2)).toMatchObject({
      action: 'continue',
      next: null,
      message: '1 rep short on the last set. That one is done.',
    });
    const fourShort = advise({ setType: 'rest_pause', target: 6, done: 4 }, { earlier });
    expect(fourShort).toMatchObject({ action: 'cut_set', next: null });
    expect(restPause(0)).toMatchObject({ action: 'cut_set', next: null });
  });

  it('comes after the cut rules', () => {
    expect(advise({ done: 2 }, LAST_SET).action).toBe('cut_set');
    expect(advise({ done: 7, rpe: 10 }, LAST_SET).action).toBe('cut_set');
    const afterDrop = [logged(), logged({ done: 7 })];
    expect(advise({ done: 8, setType: 'drop', weightLbs: 85, targetWeightLbs: 85 }, { earlier: afterDrop }).action)
      .toBe('cut_set');
  });

  it('counts a set beyond the plan as the last set too', () => {
    expect(advise({ done: 7 }, { plannedSets: 2, earlier: [logged(), logged()] }).action).toBe('rest_pause');
  });
});

describe('adviseNextSet: cut the exercise', () => {
  it.each([
    // [target, done]: a quarter of the target or less
    [8, 2],
    [12, 3],
    [4, 1],
    [10, 0],
    [1, 0],
    [20, 5],
  ])('target %p, done %p (≤ 25%%) → cut', (target, done) => {
    const advice = advise({ target, done });
    expect(advice).toMatchObject({ action: 'cut_set', next: null, restSeconds: 90, setType: 'normal' });
  });

  it.each([
    [12, 4],
    [9, 3],
    [7, 2],
  ])('target %p, done %p (just over 25%%) → drop, not cut', (target, done) => {
    expect(advise({ target, done }).action).toBe('drop_weight');
  });

  it('cuts at effort 10 with any miss, and only then', () => {
    expect(advise({ done: 9, rpe: 10 })).toMatchObject({
      action: 'cut_set',
      next: null,
      message: 'All out and 1 rep short. Stop this one for today.',
    });
    expect(advise({ done: 7, rpe: 10 }).action).toBe('cut_set');
    expect(advise({ done: 9, rpe: 9.5 }).action).toBe('extend_rest');
    expect(advise({ done: 7, rpe: 9 }).action).toBe('drop_weight');
  });

  it('ignores effort when it was not rated', () => {
    expect(advise({ done: 9, rpe: null }).action).toBe('extend_rest');
    expect(advise({ done: 7, rpe: null }).action).toBe('drop_weight');
    expect(advise({ done: 10, rpe: null }).action).toBe('continue');
  });

  it('cuts after a failed drop (2 or more short again)', () => {
    const earlier = [logged({ done: 7 })];
    const drop = (done: number) =>
      advise({ setType: 'drop', targetWeightLbs: 85, weightLbs: 85, done }, { earlier, plannedSets: 4 });
    expect(drop(8)).toMatchObject({
      action: 'cut_set',
      next: null,
      message: 'Still 2 reps short after easing off. Stop this one for today.',
    });
    expect(drop(5).action).toBe('cut_set');
    expect(drop(9).action).toBe('extend_rest');
    expect(drop(10)).toMatchObject({ action: 'continue', setType: 'drop', next: { targetWeightLbs: 85 } });
  });

  it('cuts a later set still at the dropped load (logged as a drop set)', () => {
    const earlier = [logged({ done: 7 }), logged({ setType: 'drop', targetWeightLbs: 85, weightLbs: 85 })];
    const dropSet = { setType: 'drop', targetWeightLbs: 85, weightLbs: 85 } as const;
    expect(advise({ ...dropSet, done: 7 }, { earlier, plannedSets: 4 }).action).toBe('cut_set');
  });

  it('does not count a lighter weight the user picked as easing: a miss after it drops, it is not cut', () => {
    // History said 10 reps at 25 lb; the user went lighter (20 lb) and hit it, so set 2 aims for 20 lb.
    const equipment = 'dumbbell';
    const earlier = [logged({ targetWeightLbs: 25, weightLbs: 20 })];
    const advice = advise({ targetWeightLbs: 20, weightLbs: 20, done: 8 }, { earlier, equipment });
    expect(advice).toMatchObject({ action: 'drop_weight', setType: 'drop', next: { targetReps: 10, targetWeightLbs: 15 } });
    expect(advice.message).toBe('2 reps short. Next set: 10 reps at 15 lb.');
    // The same as with no history target on set 1.
    const fresh = [logged({ targetWeightLbs: null, weightLbs: 20 })];
    expect(advise({ targetWeightLbs: 20, weightLbs: 20, done: 8 }, { earlier: fresh, equipment })).toEqual(advice);
    // Only the spotter's own easing counts: its drops are drop sets, its lower targets are lower targets.
    const afterMiss = [logged({ done: 7 })];
    expect(advise({ targetWeightLbs: 85, weightLbs: 85, done: 7 }, { earlier: afterMiss, plannedSets: 4 }).action).toBe(
      'drop_weight',
    );
    expect(advise({ setType: 'drop', targetWeightLbs: 85, weightLbs: 85, done: 7 }, { earlier: afterMiss, plannedSets: 4 }).action).toBe(
      'cut_set',
    );
  });

  it('does not treat a second normal set as eased', () => {
    expect(advise({ done: 7 }, { earlier: [logged({ done: 9 })] }).action).toBe('drop_weight');
  });
});

describe('adviseNextSet: a micro circuit (round-robin)', () => {
  /** The next set of this exercise comes a round later, after the other stations. */
  const ROUND: Partial<NextSetInput> = { roundRobin: true, plannedRestSeconds: 20 };

  it('promises no extra rest for 1 short: the round is the rest, so the same target next round', () => {
    expect(advise({ done: 9 }, ROUND)).toEqual({
      action: 'continue',
      next: { targetReps: 10, targetSeconds: null, targetWeightLbs: 100 },
      restSeconds: 20,
      setType: 'normal',
      message: '1 rep short. Same again next round: 10 reps at 100 lb.',
    });
    expect(advise({ ...BODYWEIGHT, done: 9 }, ROUND).message).toBe('1 rep short. Same again next round: 10 reps.');
  });

  it('words every next-set message for the next round, with the same numbers as straight sets', () => {
    expect(advise({ done: 10 }, ROUND).message).toBe('On target. Next round: 10 reps at 100 lb.');
    const drop = advise({ done: 8 }, ROUND);
    expect(drop).toMatchObject({ action: 'drop_weight', setType: 'drop', next: { targetWeightLbs: 90 } });
    expect(drop.message).toBe('2 reps short. Next round: 10 reps at 90 lb.');
    expect(advise({ ...BODYWEIGHT, done: 7 }, ROUND).message).toBe('3 reps short. Next round: aim for 7 reps.');
    for (const done of [10, 8, 7, 2]) {
      const straight = advise({ done }, { plannedRestSeconds: 20 });
      const round = advise({ done }, ROUND);
      expect([round.action, round.next, round.setType]).toEqual([straight.action, straight.next, straight.setType]);
    }
  });

  it('keeps the rest-pause straight after the last round, and the end-of-exercise messages', () => {
    const last = { ...ROUND, earlier: [logged(), logged()] };
    expect(advise({ done: 7 }, last)).toMatchObject({
      action: 'rest_pause',
      restSeconds: 20,
      message: '3 reps short. Rest 20 s, then do the last 3 reps at 100 lb.',
    });
    expect(advise({}, last).message).toBe('On target. All 3 sets done.');
  });
});

describe('adviseNextSet: timed sets', () => {
  const timed = (last: Partial<LoggedSet>, overrides: Partial<NextSetInput> = {}) =>
    advise({ ...BODYWEIGHT, target: 40, ...last }, { measure: 'time', equipment: [], ...overrides });
  const carry = (done: number) =>
    advise({ target: 40, done, targetWeightLbs: 50, weightLbs: 50 }, { measure: 'time', equipment: ['dumbbell'] });

  it.each([
    // [seconds done of 40, action]: every full 5 s short counts as one rep short
    [40, 'continue'],
    [45, 'continue'],
    [36, 'continue'],
    [35.5, 'continue'],
    [35, 'extend_rest'],
    [31, 'extend_rest'],
    [30, 'lower_target'],
    [25, 'lower_target'],
    [11, 'lower_target'],
    [10, 'cut_set'],
    [0, 'cut_set'],
  ])('bodyweight: %p s of 40 → %s', (done, action) => {
    expect(timed({ done }).action).toBe(action);
  });

  it('fills seconds, not reps', () => {
    expect(timed({ done: 40 })).toMatchObject({
      next: { targetReps: null, targetSeconds: 40, targetWeightLbs: null },
      message: 'On target. Same again: 40 s.',
    });
    expect(timed({ done: 28 })).toMatchObject({
      next: { targetReps: null, targetSeconds: 28, targetWeightLbs: null },
      message: '12 s short. Next set: aim for 28 s.',
    });
  });

  it.each([
    [30, 45],
    [26, 45],
    [25, 40],
    [21, 40],
    [20, 40],
    [11, 40],
  ])('loaded carry at 50 lb: %p s of 40 → %p lb', (done, next) => {
    expect(carry(done)).toMatchObject({ action: 'drop_weight', next: { targetSeconds: 40, targetWeightLbs: next } });
  });

  it('rest-pauses the missing seconds on the last planned set', () => {
    expect(timed({ done: 28 }, LAST_SET)).toMatchObject({
      action: 'rest_pause',
      next: { targetReps: null, targetSeconds: 12 },
      restSeconds: 20,
      setType: 'rest_pause',
      message: '12 s short. Rest 20 s, then do the last 12 s.',
    });
    expect(timed({ done: 33 }, LAST_SET)).toMatchObject({ action: 'continue', next: null });
  });

  it('cuts at effort 10 only on a real miss (5 s or more short)', () => {
    expect(timed({ done: 37, rpe: 10 }).action).toBe('continue');
    expect(timed({ done: 35, rpe: 10 }).action).toBe('cut_set');
  });
});

describe('adviseNextSet: robustness', () => {
  it('treats bad numbers as safe defaults', () => {
    expect(advise({ done: Number.NaN }).action).toBe('cut_set');
    expect(advise({ done: -3 }).action).toBe('cut_set');
    expect(advise({ rpe: Number.NaN, done: 9 }).action).toBe('extend_rest');
    expect(advise({ done: 9, restSeconds: null }, { plannedRestSeconds: Number.NaN }).restSeconds).toBe(30);
    expect(advise({ done: 9, restSeconds: -5 }, { plannedRestSeconds: -60 }).restSeconds).toBe(30);
    expect(advise({}, { plannedSets: 0 }).next).toBeNull();
  });
});

describe('adviseNextSession', () => {
  const ctx = (overrides: Partial<NextSessionContext> = {}): NextSessionContext => ({
    measure: 'reps',
    unit: 'lb',
    equipment: ['barbell'],
    ...overrides,
  });
  /** Three sets of `target` at `load` lb, all on target, with the given effort. */
  const allHit = (load: number | null, target = 10, rpe: number | null = 8): LoggedSet[] =>
    [1, 2, 3].map(() => logged({ target, done: target, targetWeightLbs: load, weightLbs: load, rpe }));

  it('has nothing to say without a normal set that had a target', () => {
    expect(adviseNextSession([], ctx())).toBeNull();
    expect(adviseNextSession([logged({ setType: 'rest_pause' })], ctx())).toBeNull();
    expect(adviseNextSession([logged({ target: null })], ctx())).toBeNull();
  });

  describe('raise', () => {
    it('raises the load 5%, rounded down to a real weight, when every set hit with effort ≤ 8', () => {
      expect(adviseNextSession(allHit(100), ctx())).toEqual({
        action: 'raise',
        targetReps: 10,
        targetSeconds: null,
        targetWeightLbs: 105,
        message: 'Next time: 10 reps at 105 lb. Up from 100 lb.',
      });
      expect(adviseNextSession(allHit(135), ctx())?.targetWeightLbs).toBe(140);
      expect(adviseNextSession(allHit(400), ctx())?.targetWeightLbs).toBe(420);
      expect(adviseNextSession(allHit(kg(60)), ctx({ unit: 'kg' }))?.targetWeightLbs).toBeCloseTo(kg(62.5), 9);
      expect(adviseNextSession(allHit(kg(100)), ctx({ unit: 'kg' }))?.targetWeightLbs).toBeCloseTo(kg(105), 9);
    });

    it('raises when effort was not rated', () => {
      expect(adviseNextSession(allHit(100, 10, null), ctx())?.action).toBe('raise');
    });

    it('holds when any set felt harder than 8 or missed by even 1', () => {
      const hard = allHit(100);
      hard[2] = { ...hard[2], rpe: 8.5 };
      expect(adviseNextSession(hard, ctx())).toMatchObject({ action: 'hold', targetWeightLbs: 100, targetReps: 10 });
      const oneShort = allHit(100);
      oneShort[1] = { ...oneShort[1], done: 9 };
      expect(adviseNextSession(oneShort, ctx())).toMatchObject({ action: 'hold', targetWeightLbs: 100 });
    });

    it('ignores a rest-pause mini-set and its effort', () => {
      const sets = [...allHit(100), logged({ setType: 'rest_pause', target: 2, done: 0, rpe: 10 })];
      expect(adviseNextSession(sets, ctx())?.action).toBe('raise');
    });

    it('raises from the lowest load used on a normal set', () => {
      const sets = [logged({ weightLbs: 120 }), logged(), logged({ weightLbs: 110 })];
      expect(adviseNextSession(sets, ctx())?.targetWeightLbs).toBe(105);
    });
  });

  describe('double progression (one step is more than 5%)', () => {
    it.each([
      // [target reps, next reps]: +1 below 10, +2 from 10, never past 15
      [5, 6],
      [8, 9],
      [9, 10],
      [10, 12],
      [12, 14],
      [13, 15],
      [14, 15],
    ])('20 lb dumbbells × %p → same weight × %p', (target, reps) => {
      expect(adviseNextSession(allHit(20, target), ctx({ equipment: 'dumbbell' }))).toMatchObject({
        action: 'raise',
        targetReps: reps,
        targetWeightLbs: 20,
      });
    });

    it.each([
      // [equipment, unit, load, next load, next reps]: one step heavier, reps reset under the cap
      ['dumbbell', 'lb', 20, 25, 7],
      ['dumbbell', 'lb', 15, 20, 5],
      ['dumbbell', 'lb', 95, 100, 14],
      ['dumbbell', 'kg', kg(10), kg(12), 9],
      ['kettlebell', 'kg', kg(16), kg(20), 7],
      ['kettlebell', 'lb', kg(16), kg(20), 7],
      ['barbell', 'kg', kg(20), kg(22.5), 12],
    ] as [string, Unit, number, number, number][])(
      '%s in %s at the top of the range (15 reps at %p lb) → %p lb × %p',
      (equipment, unit, load, next, reps) => {
        const advice = adviseNextSession(allHit(load, 15), ctx({ equipment, unit }));
        expect(advice?.action).toBe('raise');
        expect(advice?.targetWeightLbs).toBeCloseTo(next, 9);
        expect(advice?.targetReps).toBe(reps);
      },
    );

    it('holds at the top when the next step would need fewer than 5 reps', () => {
      expect(adviseNextSession(allHit(10, 15), ctx({ equipment: 'dumbbell' }))).toMatchObject({
        action: 'hold',
        targetReps: 15,
        targetWeightLbs: 10,
        message: 'Next time: 15 reps at 10 lb again. 15 lb is too big a jump for one session.',
      });
      expect(adviseNextSession(allHit(kg(8), 15), ctx({ equipment: 'kettlebell', unit: 'kg' }))?.action).toBe('hold');
    });

    it('resets the reps from a target above the top of the range too', () => {
      expect(adviseNextSession(allHit(20, 20), ctx({ equipment: 'dumbbell' }))).toMatchObject({
        action: 'raise',
        targetWeightLbs: 25,
        targetReps: 12,
      });
    });
  });

  describe('bodyweight and timed progression', () => {
    it.each([
      [5, 'raise', 6],
      [9, 'raise', 10],
      [10, 'raise', 12],
      [14, 'raise', 15],
      [15, 'hold', 15],
      [20, 'hold', 20],
    ])('bodyweight reps: %p → %s %p', (target, action, reps) => {
      expect(adviseNextSession(allHit(null, target), ctx({ equipment: [] }))).toMatchObject({
        action,
        targetReps: reps,
        targetWeightLbs: null,
      });
    });

    it('says to try a harder version at the top', () => {
      expect(adviseNextSession(allHit(null, 15), ctx({ equipment: [] }))?.message).toBe(
        'Next time: 15 reps again. Top of the range: try a harder version.',
      );
    });

    it.each([
      [30, 'raise', 35],
      [40, 'raise', 45],
      [58, 'raise', 60],
      [60, 'hold', 60],
      [90, 'hold', 90],
    ])('bodyweight timed: %p s → %s %p s', (target, action, seconds) => {
      expect(adviseNextSession(allHit(null, target), ctx({ measure: 'time', equipment: [] }))).toMatchObject({
        action,
        targetReps: null,
        targetSeconds: seconds,
      });
    });

    it('raises a timed set’s load 5% when a real weight fits, else its seconds', () => {
      const timedCtx = ctx({ measure: 'time', equipment: 'dumbbell' });
      expect(adviseNextSession(allHit(100, 40), timedCtx)).toMatchObject({
        action: 'raise',
        targetSeconds: 40,
        targetWeightLbs: 105,
      });
      expect(adviseNextSession(allHit(50, 40), timedCtx)).toMatchObject({
        action: 'raise',
        targetSeconds: 45,
        targetWeightLbs: 50,
      });
      expect(adviseNextSession(allHit(50, 60), timedCtx)).toMatchObject({ action: 'hold', targetWeightLbs: 50 });
    });
  });

  describe('a lower top of the range (a micro circuit’s 50 s station)', () => {
    it.each([
      [10, 'raise', 12],
      [12, 'raise', 13],
      [13, 'hold', 13],
    ])('bodyweight reps with a top of 13: %p → %s %p', (target, action, reps) => {
      expect(adviseNextSession(allHit(null, target), ctx({ equipment: [], topReps: 13 }))).toMatchObject({
        action,
        targetReps: reps,
      });
    });

    it('goes up in load once the reps are at that top (double progression), within the cap', () => {
      const advice = adviseNextSession(allHit(20, 13), ctx({ equipment: 'dumbbell', topReps: 13 }));
      expect(advice).toMatchObject({ action: 'raise', targetWeightLbs: 25 });
      expect(advice?.targetReps).toBeLessThanOrEqual(13);
      expect(estimatedMax(25, advice?.targetReps ?? 0)).toBeLessThanOrEqual(estimatedMax(20, 13) * 1.05 + 1e-9);
    });

    it('stops timed sets at that top', () => {
      const timed = ctx({ measure: 'time', equipment: [], topSeconds: 40 });
      expect(adviseNextSession(allHit(null, 35), timed)).toMatchObject({ action: 'raise', targetSeconds: 40 });
      expect(adviseNextSession(allHit(null, 40), timed)).toMatchObject({ action: 'hold', targetSeconds: 40 });
    });

    it('ignores an unusable top', () => {
      expect(adviseNextSession(allHit(null, 14), ctx({ equipment: [], topReps: Number.NaN }))?.targetReps).toBe(15);
      expect(adviseNextSession(allHit(null, 14), ctx({ equipment: [], topReps: 0 }))?.targetReps).toBe(15);
    });
  });

  it('reads sets done with no weight ("None") as bodyweight, not at their target weight', () => {
    const none = [1, 2, 3].map(() => logged({ targetWeightLbs: 25, weightLbs: null, rpe: null }));
    expect(adviseNextSession(none, ctx({ equipment: 'dumbbell' }))).toMatchObject({
      action: 'raise',
      targetReps: 12,
      targetWeightLbs: null,
    });
  });

  describe('lower and hold', () => {
    const sets = (dones: number[], load: number | null = 100, target = 10) =>
      dones.map((done) => logged({ target, done, targetWeightLbs: load, weightLbs: load }));

    it('lowers the load 10%, rounded down, when most sets came up 2 or more short', () => {
      expect(adviseNextSession(sets([8, 7, 10]), ctx())).toEqual({
        action: 'lower',
        targetReps: 10,
        targetSeconds: null,
        targetWeightLbs: 90,
        message: 'Next time: 10 reps at 90 lb. Lighter, because most sets came up 2 or more short.',
      });
      expect(adviseNextSession(sets([6, 6, 6], 25), ctx({ equipment: 'dumbbell' }))?.targetWeightLbs).toBe(20);
      const metric = adviseNextSession(sets([6, 6, 6], kg(60)), ctx({ unit: 'kg' }));
      expect(metric?.targetWeightLbs).toBeCloseTo(kg(52.5), 9);
    });

    it('holds when exactly half the sets missed big', () => {
      expect(adviseNextSession(sets([8, 8, 10, 10]), ctx())).toMatchObject({ action: 'hold', targetWeightLbs: 100 });
    });

    it('counts drop sets as working sets', () => {
      const failedDrop = [
        logged({ done: 7 }),
        logged({ done: 8, setType: 'drop', targetWeightLbs: 85, weightLbs: 85 }),
      ];
      expect(adviseNextSession(failedDrop, ctx())).toMatchObject({ action: 'lower', targetWeightLbs: 90 });
      const savedByDrop = [
        logged({ done: 8 }),
        logged({ setType: 'drop', targetWeightLbs: 90, weightLbs: 90 }),
        logged({ setType: 'drop', targetWeightLbs: 90, weightLbs: 90 }),
      ];
      expect(adviseNextSession(savedByDrop, ctx())).toMatchObject({
        action: 'hold',
        targetWeightLbs: 100,
        targetReps: 10,
      });
    });

    it('lowers the target when there is no load or the load is already at one step', () => {
      expect(adviseNextSession(sets([7, 7, 7], null), ctx({ equipment: [] }))).toMatchObject({
        action: 'lower',
        targetReps: 9,
        targetWeightLbs: null,
      });
      expect(adviseNextSession(sets([7, 7, 7], 5), ctx({ equipment: 'dumbbell' }))).toMatchObject({
        action: 'lower',
        targetReps: 9,
        targetWeightLbs: 5,
      });
      expect(adviseNextSession(sets([3, 3, 3], null, 5), ctx({ equipment: [] }))?.targetReps).toBe(4);
      expect(adviseNextSession(sets([0, 0], null, 2), ctx({ equipment: [] }))?.targetReps).toBe(1);
    });

    it.each([
      [40, 35],
      [30, 25],
      [60, 50],
      [45, 40],
      [10, 5],
    ])('lowers a timed target in 5 s steps: %p s → %p s', (target, seconds) => {
      const timed = sets([0, 0, 0], null, target);
      expect(adviseNextSession(timed, ctx({ measure: 'time', equipment: [] }))).toMatchObject({
        action: 'lower',
        targetSeconds: seconds,
      });
    });

    it('holds when nothing can go lower', () => {
      expect(adviseNextSession(sets([0, 0], null, 1), ctx({ equipment: [] }))).toMatchObject({
        action: 'hold',
        targetReps: 1,
      });
    });
  });
});

describe('the 5% cap', () => {
  const UNITS: Unit[] = ['lb', 'kg'];
  const EQUIPMENT = [
    'barbell',
    'trap_bar',
    'ez_bar',
    'machine',
    'cable',
    'weight_plate',
    'dumbbell',
    'kettlebell',
    'bodyweight',
  ];
  const MEASURES: Measure[] = ['reps', 'time'];
  const TARGETS = { reps: [1, 5, 8, 9, 10, 11, 12, 14, 15, 16, 20], time: [20, 40, 58, 60, 90] };
  const TOLERANCE = 1e-9;

  /** Loads from 1 lb to 500 lb, plus every real weight up to 250 kg in both units. */
  function loads(unit: Unit, equipment: string): number[] {
    const step = toLbs(loadIncrement(unit, equipment), unit);
    const real = Array.from({ length: Math.floor(kg(250) / step) }, (_, n) => (n + 1) * step);
    const odd = Array.from({ length: 200 }, (_, n) => 1 + n * 2.49);
    return [...real, ...odd];
  }

  function cases(): { unit: Unit; equipment: string; measure: Measure; load: number; target: number }[] {
    const all = [];
    for (const unit of UNITS) {
      for (const equipment of EQUIPMENT) {
        for (const measure of MEASURES) {
          for (const load of loads(unit, equipment)) {
            for (const target of TARGETS[measure]) all.push({ unit, equipment, measure, load, target });
          }
        }
      }
    }
    return all;
  }

  const sessionOf = (load: number, target: number, overrides: Partial<LoggedSet> = {}) =>
    [1, 2, 3].map(() => logged({ target, done: target, targetWeightLbs: load, weightLbs: load, rpe: 7, ...overrides }));

  it('never raises the load more than 5%, except a rep reset that keeps the estimated max within 5%', () => {
    const violations: string[] = [];
    let raises = 0;
    let resets = 0;
    for (const { unit, equipment, measure, load, target } of cases()) {
      const advice = adviseNextSession(sessionOf(load, target), { unit, equipment, measure });
      const next = advice?.targetWeightLbs ?? 0;
      const reps = advice?.targetReps ?? target;
      const fail = (rule: string) =>
        violations.push(`${rule}: ${load} lb × ${target} ${measure}, ${equipment} in ${unit}`);
      if (!advice) fail('no advice');

      // The load only rises on a raise, and a raise never lowers anything.
      if (next < load - TOLERANCE) fail('load fell');
      if (next > load + TOLERANCE && advice?.action !== 'raise') fail('load rose without a raise');
      if (measure === 'reps') {
        // Every change keeps load × (1 + reps / 30) within 5%.
        const ratio = estimatedMax(next, reps) / estimatedMax(load, target);
        if (ratio > 1 + SPOTTER_RULES.sessionLoadCap + TOLERANCE) fail('estimated max rose more than 5%');
      }
      if (reps >= target) {
        // Without a rep reset, the load itself rises 5% at most: next ≤ last × 1.05.
        if (next > load * 1.05 + TOLERANCE) fail('load rose more than 5%');
      } else {
        resets += 1;
        if (reps < SPOTTER_RULES.minResetReps) fail('reset below the minimum reps');
        if (target < SPOTTER_RULES.topReps) fail('reset below the top of the range');
      }
      // When a real weight fits within 5%, that is the next load.
      const capped = roundDownToIncrement(load * 1.05, unit, equipment);
      if (capped > load + TOLERANCE) {
        raises += 1;
        if (Math.abs(next - capped) > TOLERANCE) fail('did not raise to the capped real weight');
      }
    }
    expect(violations).toEqual([]);
    // The grid exercised both kinds of raise.
    expect(raises).toBeGreaterThan(1000);
    expect(resets).toBeGreaterThan(100);
  });

  it('never raises the load unless every set hit with effort ≤ 8', () => {
    const violations: string[] = [];
    const notReady: Partial<LoggedSet>[] = [{ rpe: 9 }, { rpe: 10 }, { rpe: 8.5 }, { done: 0 }];
    for (const { unit, equipment, measure, load, target } of cases().filter((_, i) => i % 3 === 0)) {
      for (const overrides of notReady) {
        const sets = sessionOf(load, target);
        sets[1] = { ...sets[1], ...overrides };
        const advice = adviseNextSession(sets, { unit, equipment, measure });
        if (!advice || advice.action === 'raise' || (advice.targetWeightLbs ?? 0) > load + TOLERANCE) {
          violations.push(`${JSON.stringify(overrides)}: ${load} lb × ${target} ${measure}, ${equipment} in ${unit}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('speed', () => {
  it('answers 10,000 in-set calls far inside the 50 ms budget (under 1 ms each on average)', () => {
    const inputs: NextSetInput[] = [];
    for (let i = 0; i < 10_000; i++) {
      const measure: Measure = i % 3 === 0 ? 'time' : 'reps';
      const target = measure === 'time' ? 40 : 10;
      const load = i % 5 === 0 ? null : 20 + (i % 40) * 5;
      inputs.push(
        input(
          {
            target,
            done: i % (target + 3),
            targetWeightLbs: load,
            weightLbs: load,
            rpe: i % 4 === 0 ? null : 6 + (i % 5),
            setType: i % 9 === 0 ? 'drop' : 'normal',
          },
          {
            measure,
            unit: i % 2 === 0 ? 'lb' : 'kg',
            equipment: [['barbell'], ['dumbbell'], ['kettlebell'], []][i % 4],
            earlier: [logged(), logged()].slice(0, i % 3),
          },
        ),
      );
    }
    const started = performance.now();
    for (const each of inputs) adviseNextSet(each);
    const perCall = (performance.now() - started) / inputs.length;
    expect(perCall).toBeLessThan(1);
  });

  it('answers 10,000 next-session calls under 1 ms each on average', () => {
    const sessions = Array.from({ length: 10_000 }, (_, i) =>
      [1, 2, 3].map(() => logged({ done: 8 + (i % 4), weightLbs: 20 + (i % 60) * 2.5, rpe: 6 + (i % 4) })),
    );
    const started = performance.now();
    sessions.forEach((sets, i) =>
      adviseNextSession(sets, { measure: 'reps', unit: i % 2 ? 'lb' : 'kg', equipment: 'dumbbell' }),
    );
    expect((performance.now() - started) / sessions.length).toBeLessThan(1);
  });
});
