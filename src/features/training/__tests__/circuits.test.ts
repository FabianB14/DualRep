/**
 * The default circuit builder against the real starter library: every system preset, at home with no
 * equipment, at home with dumbbells and bands, and at the gym, must give a usable circuit at every
 * length, offline, before the first sync. The system presets' splits are read from the first
 * migration (they are seeded there), so these tests follow any change to them.
 */
/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SYSTEM_PRESET_IDS, type SystemPresetKind } from '@/db/constants';

import {
  allocateStations,
  buildDefaultCircuit,
  candidatePool,
  CIRCUIT_RULES,
  estimateCircuitSeconds,
  isCircuitCandidate,
  microShape,
  otherPatternsAfter,
  REGION_PATTERNS,
  servesRegion,
  type BuildCircuitInput,
} from '../circuits';
import { fitsSetup, SETUP_TEMPLATES } from '../equipment';
import { defaultTargets, demandOf, PRESCRIPTION } from '../prescription';
import { STARTER_LIBRARY, STARTER_LIBRARY_BY_ID } from '../starterLibrary';
import {
  SPLIT_REGIONS,
  type Circuit,
  type LibraryExercise,
  type MovementPattern,
  type Split,
  type SplitRegion,
} from '../types';

const migration = readFileSync(
  path.resolve(__dirname, '../../../../supabase/migrations/20261008000000_initial_schema.sql'),
  'utf8',
);

/** The six system presets as the first migration seeds them: [kind, id, split]. */
function systemPresets(): [SystemPresetKind, string, Split][] {
  const pattern = /\('([0-9a-f-]{36})', null, '[^']+', '(\w+)',\s*'(\{[^']*\})'\)/g;
  return [...migration.matchAll(pattern)].map(([, id, kind, split]) => [
    kind as SystemPresetKind,
    id,
    JSON.parse(split) as Split,
  ]);
}

const PRESETS = systemPresets();
const SETUPS = ['home_bodyweight', 'home_basic', 'gym'] as const;
const WEEK = [0, 1, 2, 3, 4, 5, 6];
const STRENGTH: MovementPattern[] = [
  'squat',
  'hinge',
  'lunge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
];

function input(
  split: Split,
  setup: (typeof SETUPS)[number],
  minutes: number,
  kind: 'micro' | 'full',
  variant = 0,
  library: readonly LibraryExercise[] = STARTER_LIBRARY,
): BuildCircuitInput {
  const template = SETUP_TEMPLATES[setup];
  return { split, location: template.location, equipment: template.equipment, minutes, kind, library, variant };
}

function regionCounts(circuit: Circuit): Record<SplitRegion, number> {
  const counts = { lower: 0, upper: 0, core: 0, cardio: 0 };
  for (const item of circuit.items) counts[item.region] += 1;
  return counts;
}

/** Everything a default circuit must satisfy, whatever the preset, setup, length or variant. */
function expectValidCircuit(circuit: Circuit, request: BuildCircuitInput) {
  const setup = { location: request.location, equipment: request.equipment };
  expect(circuit).toMatchObject({
    version: 1,
    source: 'default',
    kind: request.kind,
    minutes: request.minutes,
    location: request.location,
    split: request.split,
  });
  // Non-empty, no exercise twice.
  expect(circuit.items.length).toBeGreaterThan(0);
  const ids = circuit.items.map((item) => item.exerciseId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const item of circuit.items) {
    const exercise = STARTER_LIBRARY_BY_ID.get(item.exerciseId);
    if (!exercise) throw new Error(`Unknown exercise ${item.exerciseId}`);
    // Fits the setup; a micro circuit only takes micro-ok moves of demand 1 or 2.
    expect([exercise.name, fitsSetup(exercise, setup)]).toEqual([exercise.name, true]);
    if (request.kind === 'micro') {
      expect([exercise.name, exercise.microOk, demandOf(exercise) <= 2]).toEqual([exercise.name, true, true]);
    }
    // The item copies the exercise and the default targets.
    expect(item).toEqual({
      exerciseId: exercise.id,
      name: exercise.name,
      measure: exercise.measure,
      movementPattern: exercise.movementPattern,
      region: item.region,
      sets: request.kind === 'micro' ? circuit.rounds : PRESCRIPTION.full.sets,
      ...defaultTargets(exercise, request.kind),
    });
    // A region never gets a station its split gives 0%.
    expect(request.split[item.region]).toBeGreaterThan(0);
  }
  // Region counts follow the split's largest-remainder allocation.
  expect(regionCounts(circuit)).toEqual(allocateStations(request.split, circuit.items.length));
  // The estimate is the documented sum, and within ±20% of the time available.
  expect(circuit.estimatedSeconds).toBe(estimateCircuitSeconds(circuit.items));
  expect(circuit.estimatedSeconds).toBeGreaterThanOrEqual(request.minutes * 60 * 0.8);
  expect(circuit.estimatedSeconds).toBeLessThanOrEqual(request.minutes * 60 * 1.2);
  if (request.kind === 'micro') {
    expect({ stations: circuit.items.length, rounds: circuit.rounds }).toEqual(microShape(request.minutes));
  } else {
    expect(circuit.rounds).toBe(1);
  }
}

describe('system presets (read from the first migration)', () => {
  it('are the six fixed presets, each split adding up to 100', () => {
    expect(PRESETS.map(([kind, id]) => [kind, id])).toEqual(Object.entries(SYSTEM_PRESET_IDS));
    for (const [, , split] of PRESETS) {
      expect(Object.keys(split).sort()).toEqual([...SPLIT_REGIONS].sort());
      expect(SPLIT_REGIONS.reduce((sum, region) => sum + split[region], 0)).toBe(100);
    }
  });
});

describe('microShape', () => {
  it.each([
    [5, 3, 2],
    [10, 4, 3],
    [15, 6, 3],
  ])('%i minutes → %i stations × %i rounds, filling the time with 50 s slots', (minutes, stations, rounds) => {
    expect(microShape(minutes)).toEqual({ stations, rounds });
    expect(stations * rounds * PRESCRIPTION.micro.slotSeconds).toBe(minutes * 60);
  });

  it('follows the formula for other lengths and never returns zero stations', () => {
    expect(microShape(7)).toEqual({ stations: 4, rounds: 2 });
    expect(microShape(20)).toEqual({ stations: 8, rounds: 3 });
    expect(microShape(1)).toEqual({ stations: 1, rounds: 2 });
    expect(microShape(0)).toEqual({ stations: 1, rounds: 2 });
    expect(microShape(Number.NaN)).toEqual({ stations: 1, rounds: 2 });
    expect(microShape(-5)).toEqual({ stations: 1, rounds: 2 });
  });
});

describe('allocateStations (largest remainder, ties in SPLIT_REGIONS order)', () => {
  const split = (lower: number, upper: number, core: number, cardio: number): Split => ({ lower, upper, core, cardio });
  it.each([
    ['Mostly lower', split(70, 15, 15, 0), 4, { lower: 3, upper: 1, core: 0, cardio: 0 }],
    ['Mostly lower', split(70, 15, 15, 0), 6, { lower: 4, upper: 1, core: 1, cardio: 0 }],
    ['Full body', split(25, 50, 25, 0), 4, { lower: 1, upper: 2, core: 1, cardio: 0 }],
    ['Full body', split(25, 50, 25, 0), 6, { lower: 2, upper: 3, core: 1, cardio: 0 }],
    ['Mostly upper', split(15, 70, 15, 0), 3, { lower: 1, upper: 2, core: 0, cardio: 0 }],
    ['Mostly cardio', split(10, 10, 10, 70), 3, { lower: 1, upper: 0, core: 0, cardio: 2 }],
    ['Mostly cardio', split(10, 10, 10, 70), 6, { lower: 1, upper: 1, core: 0, cardio: 4 }],
    ['Mostly cardio', split(10, 10, 10, 70), 10, { lower: 1, upper: 1, core: 1, cardio: 7 }],
    ['All lower', split(100, 0, 0, 0), 6, { lower: 6, upper: 0, core: 0, cardio: 0 }],
    ['an even custom split', split(25, 25, 25, 25), 6, { lower: 2, upper: 2, core: 1, cardio: 1 }],
  ])('%s × %i stations', (_name, value, stations, expected) => {
    expect(allocateStations(value, stations)).toEqual(expected);
  });

  it('always hands out exactly the stations, each region within one of its exact share, none at 0%', () => {
    const splits = [
      ...PRESETS.map(([, , value]) => value),
      split(5, 5, 5, 85),
      split(35, 35, 15, 15),
      split(0, 0, 0, 100),
    ];
    for (const value of splits) {
      for (let stations = 0; stations <= 24; stations += 1) {
        const counts = allocateStations(value, stations);
        expect(SPLIT_REGIONS.reduce((sum, region) => sum + counts[region], 0)).toBe(stations);
        for (const region of SPLIT_REGIONS) {
          const share = (value[region] * stations) / 100;
          expect(counts[region]).toBeGreaterThanOrEqual(Math.floor(share));
          expect(counts[region]).toBeLessThanOrEqual(Math.ceil(share));
          if (value[region] === 0) expect(counts[region]).toBe(0);
        }
      }
    }
  });

  it('reads a split that does not add up as shares of its own total', () => {
    expect(allocateStations(split(1, 1, 0, 0), 3)).toEqual({ lower: 2, upper: 1, core: 0, cardio: 0 });
    expect(allocateStations(split(140, 60, 0, 0), 10)).toEqual({ lower: 7, upper: 3, core: 0, cardio: 0 });
  });

  it('reads a split with no positive share as even, and ignores negative or non-numeric values', () => {
    expect(allocateStations(split(0, 0, 0, 0), 4)).toEqual({ lower: 1, upper: 1, core: 1, cardio: 1 });
    expect(allocateStations(split(-50, Number.NaN, 0, 0), 4)).toEqual({ lower: 1, upper: 1, core: 1, cardio: 1 });
    expect(allocateStations(split(-50, 100, Number.POSITIVE_INFINITY, 0), 4)).toEqual({
      lower: 0,
      upper: 4,
      core: 0,
      cardio: 0,
    });
  });

  it('hands out nothing for zero, negative or non-numeric station counts', () => {
    const none = { lower: 0, upper: 0, core: 0, cardio: 0 };
    expect(allocateStations(split(25, 50, 25, 0), 0)).toEqual(none);
    expect(allocateStations(split(25, 50, 25, 0), -3)).toEqual(none);
    expect(allocateStations(split(25, 50, 25, 0), Number.NaN)).toEqual(none);
  });
});

// The coverage matrix: every system preset × setup × length, each for a whole week of variants.
const MICRO_MATRIX = PRESETS.flatMap(([kind, , split]) =>
  SETUPS.flatMap((setup) => [5, 10, 15].map((minutes) => [kind, setup, minutes, split] as const)),
);
const FULL_MATRIX = PRESETS.flatMap(([kind, , split]) =>
  [30, 45, 60].map((minutes) => [kind, 'gym' as const, minutes, split] as const),
);
const FULL_HOME_MATRIX = PRESETS.flatMap(([kind, , split]) =>
  (['home_bodyweight', 'home_basic'] as const).map((setup) => [kind, setup, 30, split] as const),
);

const MATRICES: ['micro' | 'full', (typeof MICRO_MATRIX)[number][]][] = [
  ['micro', MICRO_MATRIX],
  ['full', [...FULL_MATRIX, ...FULL_HOME_MATRIX]],
];

describe.each(MATRICES)('coverage matrix: %s circuits with the starter library', (circuitKind, matrix) => {
  it.each(matrix)('%s at %s, %i minutes: valid all week, deterministic, varied', (_preset, setup, minutes, split) => {
    const week = WEEK.map((variant) => {
      const request = input(split, setup, minutes, circuitKind, variant);
      const circuit = buildDefaultCircuit(request);
      expectValidCircuit(circuit, request);
      // Same input → same circuit, whatever the order of the library.
      expect(buildDefaultCircuit(request)).toEqual(circuit);
      expect(buildDefaultCircuit({ ...request, library: [...STARTER_LIBRARY].reverse() })).toEqual(circuit);
      return JSON.stringify(circuit.items.map((item) => item.exerciseId));
    });
    // The variant changes something across a week, and every day differs from the day before.
    expect(new Set(week).size).toBeGreaterThanOrEqual(3);
    for (let day = 1; day < week.length; day += 1) expect(week[day]).not.toBe(week[day - 1]);
  });
});

describe('buildDefaultCircuit: micro circuits', () => {
  const fullBody = PRESETS.find(([kind]) => kind === 'full_body')?.[2] as Split;
  const allLower = PRESETS.find(([kind]) => kind === 'all_lower')?.[2] as Split;
  const allUpper = PRESETS.find(([kind]) => kind === 'all_upper')?.[2] as Split;

  it('builds the 10-minute home circuit as 4 stations × 3 rounds of about 50 s each', () => {
    const circuit = buildDefaultCircuit(input(fullBody, 'home_bodyweight', 10, 'micro'));
    expect(circuit.rounds).toBe(3);
    expect(circuit.items).toHaveLength(4);
    for (const item of circuit.items) {
      expect(item.sets).toBe(3);
      expect(item.targetWeightLbs).toBeNull();
    }
    expect(Math.abs(circuit.estimatedSeconds - 600)).toBeLessThanOrEqual(30);
  });

  it('spreads each region evenly through the round', () => {
    // Full body × 4 stations: upper at ¼ and ¾, lower and core at ½ (lower first in a tie).
    const regions = buildDefaultCircuit(input(fullBody, 'gym', 10, 'micro')).items.map((item) => item.region);
    expect(regions).toEqual(['upper', 'lower', 'core', 'upper']);
  });

  it('rotates through the region patterns, starting at the variant', () => {
    const patterns = (variant: number) =>
      buildDefaultCircuit(input(allLower, 'home_bodyweight', 5, 'micro', variant)).items.map(
        (item) => item.movementPattern,
      );
    expect(patterns(0)).toEqual(['squat', 'hinge', 'lunge']);
    expect(patterns(1)).toEqual(['hinge', 'lunge', 'squat']);
    expect(patterns(2)).toEqual(['lunge', 'squat', 'hinge']);
    const firstUpper = WEEK.slice(0, 4).map(
      (variant) => buildDefaultCircuit(input(allUpper, 'gym', 5, 'micro', variant)).items[0].movementPattern,
    );
    expect(new Set(firstUpper).size).toBe(4);
  });

  it('never uses heavy or non-micro moves, even at the gym', () => {
    for (const [, , split] of PRESETS) {
      for (const variant of WEEK) {
        for (const item of buildDefaultCircuit(input(split, 'gym', 15, 'micro', variant)).items) {
          const exercise = STARTER_LIBRARY_BY_ID.get(item.exerciseId);
          expect(exercise?.microOk).toBe(true);
          expect(exercise?.demandLevel).not.toBe(3);
        }
      }
    }
  });
});

describe('buildDefaultCircuit: full sessions', () => {
  const allLower = PRESETS.find(([kind]) => kind === 'all_lower')?.[2] as Split;

  it('does straight sets, heavy lifts first, at most two of them, with longer rest', () => {
    for (const [, , split] of PRESETS) {
      for (const minutes of [30, 45, 60]) {
        for (const variant of WEEK) {
          const circuit = buildDefaultCircuit(input(split, 'gym', minutes, 'full', variant));
          const demands = circuit.items.map((item) => demandOf(STARTER_LIBRARY_BY_ID.get(item.exerciseId)!));
          const heavy = demands.filter((demand) => demand === 3).length;
          expect(heavy).toBeLessThanOrEqual(CIRCUIT_RULES.maxHeavyPerFull);
          // Heavy lifts come before everything else.
          expect(demands.slice(0, heavy).every((demand) => demand === 3)).toBe(true);
          circuit.items.forEach((item, index) => {
            expect(item.sets).toBe(3);
            expect(item.restSeconds).toBe(demands[index] === 3 ? 120 : 60);
          });
        }
      }
    }
  });

  it('anchors a gym lower-body day on the big barbell lifts and uses loaded moves for the rest', () => {
    const circuit = buildDefaultCircuit(input(allLower, 'gym', 30, 'full'));
    const names = circuit.items.map((item) => item.name);
    expect(names.slice(0, 2)).toEqual(['Barbell back squat', 'Barbell deadlift']);
    for (const item of circuit.items) {
      expect(STARTER_LIBRARY_BY_ID.get(item.exerciseId)?.equipment).not.toEqual(['bodyweight']);
    }
  });

  it('orders strength before core before conditioning', () => {
    const mostlyCardio = PRESETS.find(([kind]) => kind === 'mostly_cardio')?.[2] as Split;
    const order = buildDefaultCircuit(input(mostlyCardio, 'gym', 60, 'full')).items.map((item) => item.movementPattern);
    const group = (pattern: MovementPattern | null) =>
      pattern === 'conditioning' ? 2 : pattern === 'core' ? 1 : STRENGTH.includes(pattern!) ? 0 : 1;
    const groups = order.map(group);
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
  });

  it('picks the number of exercises whose estimate comes closest to the time', () => {
    for (const [, , split] of PRESETS) {
      for (const minutes of [30, 45, 60]) {
        const circuit = buildDefaultCircuit(input(split, 'gym', minutes, 'full'));
        expect(Math.abs(circuit.estimatedSeconds - minutes * 60)).toBeLessThanOrEqual(minutes * 60 * 0.1);
      }
    }
  });
});

describe('buildDefaultCircuit: what it picks from', () => {
  const allLower = PRESETS.find(([kind]) => kind === 'all_lower')?.[2] as Split;
  const fullBody = PRESETS.find(([kind]) => kind === 'full_body')?.[2] as Split;
  const without = (patterns: MovementPattern[]) =>
    STARTER_LIBRARY.filter((exercise) => !patterns.includes(exercise.movementPattern as MovementPattern));

  it('falls back to the region’s other patterns when a pattern is missing', () => {
    const circuit = buildDefaultCircuit(input(allLower, 'home_bodyweight', 15, 'micro', 0, without(['squat'])));
    expect(circuit.items).toHaveLength(6);
    expect(circuit.items.every((item) => item.region === 'lower')).toBe(true);
    expect(circuit.items.some((item) => item.movementPattern === 'squat')).toBe(false);
    expect(new Set(circuit.items.map((item) => item.movementPattern))).toEqual(new Set(['hinge', 'lunge']));
  });

  it('then to any exercise of the region, then to bodyweight core and conditioning', () => {
    const lowerOther = STARTER_LIBRARY.filter((exercise) => exercise.name === 'Standing calf raise');
    const coreAndCardio = STARTER_LIBRARY.filter(
      (exercise) => exercise.movementPattern === 'core' || exercise.movementPattern === 'conditioning',
    );
    const circuit = buildDefaultCircuit(
      input(allLower, 'home_bodyweight', 5, 'micro', 0, [...lowerOther, ...coreAndCardio]),
    );
    expect(circuit.items.map((item) => item.region)).toEqual(['lower', 'lower', 'lower']);
    expect(circuit.items[0].name).toBe('Standing calf raise');
    expect(circuit.items.slice(1).every((item) => item.movementPattern === 'core')).toBe(true);
  });

  it('leaves a station out rather than repeating an exercise', () => {
    const two = STARTER_LIBRARY.filter((exercise) => ['Plank', 'Bodyweight squat'].includes(exercise.name));
    const circuit = buildDefaultCircuit(input(fullBody, 'home_bodyweight', 15, 'micro', 0, two));
    expect(circuit.items.map((item) => item.name).sort()).toEqual(['Bodyweight squat', 'Plank']);
    expect(circuit.estimatedSeconds).toBe(estimateCircuitSeconds(circuit.items));
  });

  it('returns an empty circuit only when nothing fits', () => {
    const empty = buildDefaultCircuit(input(fullBody, 'gym', 10, 'micro', 0, []));
    expect(empty.items).toEqual([]);
    expect(empty.estimatedSeconds).toBe(0);
    const gymOnly = STARTER_LIBRARY.filter((exercise) => exercise.location === 'gym');
    expect(buildDefaultCircuit(input(fullBody, 'home_bodyweight', 30, 'full', 0, gymOnly)).items).toEqual([]);
  });

  it('never picks an unreviewed library row, even when one is passed in', () => {
    const unreviewed = STARTER_LIBRARY.map((exercise) => ({ ...exercise, reviewed: false }));
    const mine: LibraryExercise = {
      ...STARTER_LIBRARY[0],
      id: 'u0000000-0000-4000-8000-000000000001',
      name: 'My squat',
      origin: 'user',
      reviewed: false,
      ownerId: 'me',
    };
    const circuit = buildDefaultCircuit(input(allLower, 'home_bodyweight', 5, 'micro', 0, [...unreviewed, mine]));
    expect(circuit.items.map((item) => item.name)).toEqual(['My squat']);
  });

  it('includes the user’s own eligible exercises in the rotation', () => {
    const mine: LibraryExercise = {
      ...STARTER_LIBRARY_BY_ID.get('00000000-0000-4000-8000-0000000e0002')!,
      id: 'u0000000-0000-4000-8000-000000000002',
      name: 'Sofa squat',
      origin: 'user',
      reviewed: false,
      ownerId: 'me',
    };
    const library = [...STARTER_LIBRARY, mine];
    const names = WEEK.flatMap((variant) =>
      buildDefaultCircuit(input(allLower, 'home_bodyweight', 10, 'micro', variant, library)).items.map(
        (item) => item.name,
      ),
    );
    expect(names).toContain('Sofa squat');
  });

  it('uses each id once when the library lists it twice', () => {
    const twice = [...STARTER_LIBRARY, ...STARTER_LIBRARY];
    const circuit = buildDefaultCircuit(input(fullBody, 'gym', 15, 'micro', 0, twice));
    expect(circuit).toEqual(buildDefaultCircuit(input(fullBody, 'gym', 15, 'micro', 0)));
  });

  it('never changes its input', () => {
    const library = STARTER_LIBRARY.map((exercise) => ({ ...exercise }));
    const request = input(fullBody, 'home_basic', 15, 'micro', 3, library);
    const before = JSON.stringify(request);
    buildDefaultCircuit(request);
    buildDefaultCircuit({ ...request, kind: 'full', minutes: 45 });
    expect(JSON.stringify(request)).toBe(before);
  });

  it('reads odd variants as whole numbers and still builds a circuit', () => {
    const at = (variant: number) => buildDefaultCircuit(input(fullBody, 'home_basic', 10, 'micro', variant));
    expect(at(1.7)).toEqual(at(1));
    expect(at(Number.NaN)).toEqual(at(0));
    expect(buildDefaultCircuit({ ...input(fullBody, 'home_basic', 10, 'micro'), variant: undefined })).toEqual(at(0));
    expect(at(-1).items.length).toBe(4);
    expect(at(20_000).items.length).toBe(4);
  });
});

describe('helpers', () => {
  it('REGION_PATTERNS rotate the strength patterns and give core and cardio their own', () => {
    expect(REGION_PATTERNS).toEqual({
      lower: ['squat', 'hinge', 'lunge'],
      upper: ['horizontal_push', 'horizontal_pull', 'vertical_push', 'vertical_pull'],
      core: ['core'],
      cardio: ['conditioning'],
    });
  });

  it('otherPatternsAfter wraps around and leaves the pattern out', () => {
    expect(otherPatternsAfter(REGION_PATTERNS.upper, 'vertical_push')).toEqual([
      'vertical_pull',
      'horizontal_push',
      'horizontal_pull',
    ]);
    expect(otherPatternsAfter(REGION_PATTERNS.lower, 'other')).toEqual(['squat', 'hinge', 'lunge']);
    expect(otherPatternsAfter(REGION_PATTERNS.lower, null)).toEqual(['squat', 'hinge', 'lunge']);
    expect(otherPatternsAfter(REGION_PATTERNS.core, 'core')).toEqual([]);
  });

  it('servesRegion lets a full-body move fill a lower or an upper station', () => {
    expect(servesRegion({ bodyRegion: 'full' }, 'lower')).toBe(true);
    expect(servesRegion({ bodyRegion: 'full' }, 'upper')).toBe(true);
    expect(servesRegion({ bodyRegion: 'full' }, 'core')).toBe(false);
    expect(servesRegion({ bodyRegion: 'cardio' }, 'cardio')).toBe(true);
    expect(servesRegion({ bodyRegion: null }, 'lower')).toBe(false);
  });

  it('isCircuitCandidate and candidatePool apply the setup and the micro rules', () => {
    const home = SETUP_TEMPLATES.home_bodyweight;
    const backSquat = STARTER_LIBRARY.find((exercise) => exercise.name === 'Barbell back squat')!;
    const chairSquat = STARTER_LIBRARY.find((exercise) => exercise.name === 'Chair squat')!;
    expect(isCircuitCandidate(backSquat, 'full', SETUP_TEMPLATES.gym)).toBe(true);
    expect(isCircuitCandidate(backSquat, 'micro', SETUP_TEMPLATES.gym)).toBe(false);
    expect(isCircuitCandidate(chairSquat, 'micro', home)).toBe(true);
    expect(isCircuitCandidate(chairSquat, 'micro', SETUP_TEMPLATES.gym)).toBe(false);
    expect(isCircuitCandidate({ ...chairSquat, demandLevel: null }, 'micro', home)).toBe(true);
    const pool = candidatePool([...STARTER_LIBRARY].reverse(), 'micro', home);
    expect(pool.map((exercise) => exercise.id)).toEqual(
      STARTER_LIBRARY.filter((exercise) => isCircuitCandidate(exercise, 'micro', home)).map((exercise) => exercise.id),
    );
  });
});
