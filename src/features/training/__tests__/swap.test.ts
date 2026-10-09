/**
 * The location swap against the real starter library: a gym circuit taken home (and back) must come
 * out fully doable, with the same movement patterns where the setup allows, and sensible targets.
 */
import { describe, expect, it } from '@jest/globals';

import { SYSTEM_PRESET_IDS } from '@/db/constants';

import { buildDefaultCircuit, circuitItemFor, estimateCircuitSeconds } from '../circuits';
import { fitsSetup, SETUP_TEMPLATES } from '../equipment';
import { defaultTargets, demandOf } from '../prescription';
import { STARTER_LIBRARY, STARTER_LIBRARY_BY_ID } from '../starterLibrary';
import { alternativesFor, replaceItem, swapForSetup } from '../swap';
import type { Circuit, CircuitItem, LibraryExercise, Split, WorkoutKind } from '../types';

// The system presets' splits (as seeded by the first migration; circuits.test.ts checks them there).
const SPLITS: Record<keyof typeof SYSTEM_PRESET_IDS, Split> = {
  all_lower: { lower: 100, upper: 0, core: 0, cardio: 0 },
  mostly_lower: { lower: 70, upper: 15, core: 15, cardio: 0 },
  full_body: { lower: 25, upper: 50, core: 25, cardio: 0 },
  mostly_upper: { lower: 15, upper: 70, core: 15, cardio: 0 },
  all_upper: { lower: 0, upper: 100, core: 0, cardio: 0 },
  mostly_cardio: { lower: 10, upper: 10, core: 10, cardio: 70 },
};
const HOME = SETUP_TEMPLATES.home_bodyweight;
const HOME_BASIC = SETUP_TEMPLATES.home_basic;
const GYM = SETUP_TEMPLATES.gym;

function byName(name: string): LibraryExercise {
  const found = STARTER_LIBRARY.find((exercise) => exercise.name === name);
  if (!found) throw new Error(`${name} is missing from the starter library`);
  return found;
}

function gymCircuit(split: Split, kind: WorkoutKind, minutes: number, variant = 0): Circuit {
  return buildDefaultCircuit({ split, kind, minutes, variant, library: STARTER_LIBRARY, ...GYM });
}

/** A circuit by hand: these exercises, in order, with default targets and a target load. */
function circuitOf(names: string[], kind: WorkoutKind, location: 'gym' | 'home' = 'gym'): Circuit {
  const items = names.map((name) => {
    const exercise = byName(name);
    const region = exercise.bodyRegion === 'cardio' || exercise.bodyRegion === 'core' || exercise.bodyRegion === 'upper'
      ? exercise.bodyRegion
      : 'lower';
    const item = circuitItemFor(exercise, region, kind, 3);
    return { ...item, targetWeightLbs: exercise.equipment.includes('bodyweight') ? null : 95 };
  });
  return {
    version: 1,
    source: 'default',
    kind,
    minutes: kind === 'micro' ? 10 : 45,
    rounds: kind === 'micro' ? 3 : 1,
    items,
    estimatedSeconds: estimateCircuitSeconds(items),
    location,
    split: SPLITS.full_body,
  };
}

/** What every swapped circuit must satisfy. */
function expectSwapped(
  before: Circuit,
  after: Circuit,
  setup: { location: 'gym' | 'home'; equipment: readonly string[] },
) {
  expect(after.location).toBe(setup.location);
  expect(after.items).toHaveLength(before.items.length);
  const ids = after.items.map((item) => item.exerciseId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(after.estimatedSeconds).toBe(estimateCircuitSeconds(after.items));
  expect({ ...after, location: before.location, items: [], estimatedSeconds: 0 }).toEqual({
    ...before,
    items: [],
    estimatedSeconds: 0,
  });
  after.items.forEach((item, index) => {
    const old = before.items[index];
    const exercise = STARTER_LIBRARY_BY_ID.get(item.exerciseId)!;
    const original = STARTER_LIBRARY_BY_ID.get(old.exerciseId)!;
    expect([exercise.name, fitsSetup(exercise, setup)]).toEqual([exercise.name, true]);
    if (before.kind === 'micro') expect(exercise.microOk && demandOf(exercise) <= 2).toBe(true);
    expect(item.region).toBe(old.region);
    expect(item.sets).toBe(old.sets);
    if (fitsSetup(original, setup)) {
      // Items that fit are left exactly as they were.
      expect(item).toEqual(old);
      return;
    }
    // Replaced: same pattern (for an 'other' move, same muscle) whenever the setup still has one that is
    // not in the circuit already; no load carried over.
    const same = (candidate: LibraryExercise) =>
      original.movementPattern === 'other'
        ? candidate.muscleGroup === original.muscleGroup
        : candidate.movementPattern === original.movementPattern;
    if (!same(exercise)) {
      const left = STARTER_LIBRARY.filter(
        (candidate) =>
          same(candidate) &&
          fitsSetup(candidate, setup) &&
          (before.kind === 'full' || (candidate.microOk && demandOf(candidate) <= 2)) &&
          !ids.includes(candidate.id),
      );
      expect([original.name, exercise.name, left.map((candidate) => candidate.name)]).toEqual([
        original.name,
        exercise.name,
        [],
      ]);
    }
    expect(item.targetWeightLbs).toBeNull();
    expect(item.name).toBe(exercise.name);
    expect(item.measure).toBe(exercise.measure);
    expect(item.movementPattern).toBe(exercise.movementPattern);
  });
}

describe('swapForSetup: every gym circuit taken home', () => {
  const cases = Object.entries(SPLITS).flatMap(([preset, split]) =>
    [
      ['micro', 5],
      ['micro', 10],
      ['micro', 15],
      ['full', 30],
      ['full', 45],
    ].map(([kind, minutes]) => [preset, kind as WorkoutKind, minutes as number, split] as const),
  );

  it.each(cases)(
    '%s, %s %i min: fits home, same patterns, no duplicates, all week',
    (_preset, kind, minutes, split) => {
      for (const variant of [0, 1, 2, 3, 4, 5, 6]) {
        const before = gymCircuit(split, kind, minutes, variant);
        for (const setup of [HOME, HOME_BASIC]) {
          const after = swapForSetup(before, setup, STARTER_LIBRARY);
          expectSwapped(before, after, setup);
          // Swapping again to the same setup changes nothing.
          expect(swapForSetup(after, setup, STARTER_LIBRARY)).toEqual(after);
        }
      }
    },
  );
});

describe('swapForSetup: targets and edge cases', () => {
  it('turns a heavy gym session into its natural home equivalents', () => {
    const before = circuitOf(
      ['Barbell back squat', 'Barbell Romanian deadlift', 'Lat pulldown', 'Machine shoulder press'],
      'full',
    );
    const after = swapForSetup(before, HOME_BASIC, STARTER_LIBRARY);
    expect(after.items.map((item) => item.name)).toEqual([
      'Goblet squat',
      'Dumbbell Romanian deadlift',
      'Band lat pulldown',
      'Dumbbell shoulder press',
    ]);
    // Heavy 5-rep sets became the demand-2 prescription; the load starts empty.
    expect(after.items[0]).toMatchObject({ targetReps: 10, restSeconds: 60, targetWeightLbs: null, sets: 3 });
  });

  it('keeps reps and rest when the measure and demand level are the same, recomputes them otherwise', () => {
    const pulldown = byName('Lat pulldown'); // demand 2, reps
    const goblet = byName('Goblet squat'); // demand 2, reps
    const bandPulldown = byName('Band lat pulldown'); // demand 1, reps
    const plank = byName('Plank'); // demand 1, time
    const item: CircuitItem = {
      ...circuitItemFor(pulldown, 'upper', 'full', 4),
      targetReps: 8,
      restSeconds: 75,
      targetWeightLbs: 120,
    };

    expect(replaceItem(item, goblet, 'full', pulldown)).toEqual({
      ...item,
      exerciseId: goblet.id,
      name: goblet.name,
      measure: 'reps',
      movementPattern: 'squat',
      targetReps: 8,
      targetSeconds: null,
      restSeconds: 75,
      targetWeightLbs: null,
    });
    expect(replaceItem(item, bandPulldown, 'full', pulldown)).toMatchObject({
      ...defaultTargets(bandPulldown, 'full'),
      sets: 4,
      region: 'upper',
    });
    expect(replaceItem(item, plank, 'micro', pulldown)).toMatchObject({
      ...defaultTargets(plank, 'micro'),
      measure: 'time',
      targetReps: null,
    });
    // Without the original exercise the targets are recomputed.
    expect(replaceItem(item, goblet, 'full')).toMatchObject(defaultTargets(goblet, 'full'));
    expect(replaceItem(item, goblet, 'full', null)).toMatchObject(defaultTargets(goblet, 'full'));
  });

  it('replaces desk-side moves when a home circuit goes to the gym', () => {
    const before = circuitOf(['Chair squat', 'Desk push-up', 'Plank', 'Doorframe row'], 'micro', 'home');
    const after = swapForSetup(before, GYM, STARTER_LIBRARY);
    expectSwapped(before, after, GYM);
    expect(after.items[2]).toEqual(before.items[2]);
    expect(after.items.map((item) => item.movementPattern)).toEqual([
      'squat',
      'horizontal_push',
      'core',
      'horizontal_pull',
    ]);
  });

  it('only changes the location when everything fits', () => {
    const before = circuitOf(['Bodyweight squat', 'Push-up', 'Plank'], 'micro');
    const after = swapForSetup(before, HOME, STARTER_LIBRARY);
    expect(after).toEqual({ ...before, location: 'home' });
  });

  it('never puts the same exercise in twice, even when two items want the same replacement', () => {
    const before = circuitOf(['Leg press', 'Barbell back squat', 'Barbell front squat'], 'full');
    const after = swapForSetup(before, HOME, STARTER_LIBRARY);
    const ids = after.items.map((item) => item.exerciseId);
    expect(new Set(ids).size).toBe(3);
    expect(after.items.every((item) => item.movementPattern === 'squat')).toBe(true);
  });

  it('replaces an exercise that is no longer on the phone by its pattern, and keeps it when nothing fits', () => {
    const ghost: CircuitItem = {
      ...circuitItemFor(byName('Leg press'), 'lower', 'micro', 3),
      exerciseId: 'gone',
      name: 'Old squat',
    };
    const before = { ...circuitOf(['Plank'], 'micro'), items: [ghost] };
    const after = swapForSetup(before, HOME, STARTER_LIBRARY);
    expect(after.items[0].movementPattern).toBe('squat');
    expect(STARTER_LIBRARY_BY_ID.has(after.items[0].exerciseId)).toBe(true);
    expect(swapForSetup(before, HOME, [])).toEqual({ ...before, location: 'home' });
  });

  it('never changes its input', () => {
    const before = gymCircuit(SPLITS.full_body, 'full', 45);
    const library = STARTER_LIBRARY.map((exercise) => ({ ...exercise }));
    const snapshot = JSON.stringify([before, library]);
    swapForSetup(before, HOME, library);
    expect(JSON.stringify([before, library])).toBe(snapshot);
  });
});

describe('alternativesFor', () => {
  const itemFor = (name: string, region: CircuitItem['region'], kind: WorkoutKind = 'micro') =>
    circuitItemFor(byName(name), region, kind, 3);
  const names = (list: LibraryExercise[]) => list.map((exercise) => exercise.name);

  it('puts the same pattern and muscle first, closest demand and equipment like the original next', () => {
    const backSquat = itemFor('Barbell back squat', 'lower', 'full');
    expect(names(alternativesFor(backSquat, HOME_BASIC, STARTER_LIBRARY, { kind: 'full', limit: 1 }))).toEqual([
      'Goblet squat',
    ]);
    expect(names(alternativesFor(itemFor('Goblet squat', 'lower'), GYM, STARTER_LIBRARY, { limit: 2 }))).toEqual([
      'Leg press',
      'Bodyweight squat',
    ]);
  });

  it("matches an 'other' move on its muscle group; another muscle's isolation move is only a late fallback", () => {
    const pushdown = alternativesFor(itemFor('Cable triceps pushdown', 'upper'), HOME_BASIC, STARTER_LIBRARY);
    expect(names(pushdown).slice(0, 2)).toEqual(['Dumbbell overhead triceps extension', 'Chair dip']);
    // The curl is upper body, so it is offered, but after every move of the upper-body patterns.
    const upperPattern = (exercise: LibraryExercise) =>
      exercise.bodyRegion === 'upper' && !['other', 'mobility'].includes(exercise.movementPattern ?? 'other');
    const lastPattern = Math.max(...pushdown.map((exercise, index) => (upperPattern(exercise) ? index : -1)));
    expect(names(pushdown).indexOf('Dumbbell curl')).toBeGreaterThan(lastPattern);
    const legCurl = alternativesFor(itemFor('Leg curl', 'lower'), HOME, STARTER_LIBRARY);
    expect(legCurl.slice(0, 2).every((exercise) => exercise.muscleGroup === 'hamstrings')).toBe(true);
    // Mobility moves come after the rest of their tier.
    const position = (name: string) => names(legCurl).indexOf(name);
    expect(position('Lunge with rotation')).toBeGreaterThan(position('Bodyweight single-leg deadlift'));
  });

  it('only offers exercises that fit, never the item itself, and respects exclude and limit', () => {
    const item = itemFor('Bodyweight squat', 'lower');
    const all = alternativesFor(item, HOME, STARTER_LIBRARY);
    expect(all.length).toBeGreaterThan(5);
    for (const exercise of all) expect(fitsSetup(exercise, HOME)).toBe(true);
    expect(names(all)).not.toContain('Bodyweight squat');
    const [first, second] = all;
    expect(alternativesFor(item, HOME, STARTER_LIBRARY, { exclude: [first.id] })[0]).toEqual(second);
    expect(alternativesFor(item, HOME, STARTER_LIBRARY, { limit: 3 })).toEqual(all.slice(0, 3));
    expect(alternativesFor(item, HOME, STARTER_LIBRARY, { limit: 0 })).toEqual([]);
  });

  it('defaults to micro rules (no heavy or non-micro moves); full sessions may offer them', () => {
    const item = itemFor('Leg press', 'lower');
    const micro = alternativesFor(item, GYM, STARTER_LIBRARY);
    expect(micro.every((exercise) => exercise.microOk && demandOf(exercise) <= 2)).toBe(true);
    const full = alternativesFor(item, GYM, STARTER_LIBRARY, { kind: 'full' });
    expect(names(full)).toContain('Barbell back squat');
  });

  it('works for an exercise that is not on the phone, from the item alone', () => {
    const ghost: CircuitItem = { ...itemFor('Push-up', 'upper'), exerciseId: 'gone' };
    const list = alternativesFor(ghost, HOME, STARTER_LIBRARY);
    expect(list[0].movementPattern).toBe('horizontal_push');
    expect(names(list)).toContain('Push-up');
  });

  it('falls back to the region and then to bodyweight core or conditioning', () => {
    const onlyCore = STARTER_LIBRARY.filter((exercise) => exercise.movementPattern === 'core');
    const list = alternativesFor(itemFor('Bodyweight squat', 'lower'), HOME, onlyCore);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((exercise) => exercise.movementPattern === 'core')).toBe(true);
    const cardio = alternativesFor(itemFor('Jumping jack', 'cardio'), HOME, STARTER_LIBRARY);
    expect(cardio.slice(0, 5).every((exercise) => exercise.movementPattern === 'conditioning')).toBe(true);
  });
});
