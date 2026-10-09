import { describe, expect, it } from '@jest/globals';

import { SYSTEM_PRESET_IDS } from '@/db/constants';
import { buildDefaultCircuit, estimateCircuitSeconds } from '@/features/training/circuits';
import { SETUP_TEMPLATES } from '@/features/training/equipment';
import { MICRO_LIMITS, PRESCRIPTION } from '@/features/training/prescription';
import type { LoggedSet } from '@/features/training/spotter';
import { STARTER_LIBRARY, STARTER_LIBRARY_BY_ID } from '@/features/training/starterLibrary';
import type { Circuit, CircuitItem, Split } from '@/features/training/types';

import { applySessionAdvice, buildCycleCircuit, circuitVariant, localDayNumber } from '../circuitPrep';
import { normalizePlan } from '../cycleMachine';

const DAY = 86_400_000;
const NOON = new Date(2026, 9, 8, 12, 0, 0).getTime();

function item(id: string, overrides: Partial<CircuitItem> = {}): CircuitItem {
  return {
    exerciseId: id,
    name: id,
    measure: 'reps',
    movementPattern: 'squat',
    region: 'lower',
    sets: 3,
    targetReps: 10,
    targetSeconds: null,
    targetWeightLbs: null,
    restSeconds: 20,
    ...overrides,
  };
}

function circuitOf(items: CircuitItem[]): Circuit {
  return {
    version: 1,
    source: 'default',
    kind: 'micro',
    minutes: 10,
    rounds: 3,
    items,
    estimatedSeconds: estimateCircuitSeconds(items),
    location: 'home',
    split: { lower: 100, upper: 0, core: 0, cardio: 0 },
  };
}

function set(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return { target: 10, done: 10, targetWeightLbs: 25, weightLbs: 25, rpe: null, restSeconds: 30, setType: 'normal', ...overrides };
}

describe('circuit variant', () => {
  it('turns over at local midnight', () => {
    const day = localDayNumber(NOON);
    expect(localDayNumber(new Date(2026, 9, 8, 0, 0, 1).getTime())).toBe(day);
    expect(localDayNumber(new Date(2026, 9, 8, 23, 59, 59).getTime())).toBe(day);
    expect(localDayNumber(new Date(2026, 9, 9, 0, 0, 1).getTime())).toBe(day + 1);
  });

  it('differs from block to block and from day to day, and is stable for the same block', () => {
    expect(circuitVariant(NOON, 1)).toBe(localDayNumber(NOON));
    expect(circuitVariant(NOON, 2)).toBe(circuitVariant(NOON, 1) + 1);
    expect(circuitVariant(NOON + DAY, 1)).toBe(circuitVariant(NOON, 1) + 1);
    expect(circuitVariant(NOON, 3)).toBe(circuitVariant(NOON + 60_000, 3));
    expect(circuitVariant(NOON, 0)).toBe(circuitVariant(NOON, 1));
  });
});

describe('buildCycleCircuit', () => {
  const plan = normalizePlan({
    split: { lower: 25, upper: 25, core: 25, cardio: 25 },
    presetId: SYSTEM_PRESET_IDS.full_body,
    location: 'home',
    equipment: SETUP_TEMPLATES.home_bodyweight.equipment,
    moveKind: 'micro',
    moveMinutes: 10,
  });

  it("is the default builder's circuit for the plan", () => {
    const circuit = buildCycleCircuit(plan, STARTER_LIBRARY, 7);
    expect(circuit).toEqual(
      buildDefaultCircuit({
        split: plan.split,
        location: 'home',
        equipment: [],
        minutes: 10,
        kind: 'micro',
        library: STARTER_LIBRARY,
        variant: 7,
      }),
    );
    expect(circuit.items.length).toBeGreaterThan(0);
  });

  it('builds a full gym session too', () => {
    const gym = normalizePlan({ ...plan, location: 'gym', equipment: SETUP_TEMPLATES.gym.equipment, moveKind: 'full', moveMinutes: 45 });
    const circuit = buildCycleCircuit(gym, STARTER_LIBRARY, 0);
    expect(circuit.kind).toBe('full');
    expect(circuit.items.length).toBeGreaterThan(0);
  });
});

describe('applySessionAdvice', () => {
  const byId = new Map([
    ['goblet', { equipment: ['dumbbell'] }],
    ['barbell', { equipment: ['barbell', 'rack'] }],
    ['plank', { equipment: [] }],
  ]);
  const CIRCUIT = circuitOf([
    item('goblet'),
    item('barbell', { targetReps: 5, restSeconds: 120 }),
    item('plank', { measure: 'time', targetReps: null, targetSeconds: 30 }),
    item('new'),
  ]);

  it('moves each exercise on from its last session (never more than +5% load)', () => {
    const history = new Map<string, LoggedSet[]>([
      // Every set on target at 25 lb: one 5 lb step is 20%, so the reps go up instead.
      ['goblet', [set(), set(), set()]],
      // 5 × 200 lb on target: +5% is 210 lb.
      ['barbell', [set({ target: 5, done: 5, targetWeightLbs: 200, weightLbs: 200 })]],
      // Timed: +5 s.
      ['plank', [set({ target: 30, done: 30, targetWeightLbs: null, weightLbs: null })]],
    ]);
    const advised = applySessionAdvice(CIRCUIT, history, { unit: 'lb', byId });
    expect(advised.items.map((entry) => [entry.exerciseId, entry.targetReps, entry.targetSeconds, entry.targetWeightLbs])).toEqual([
      ['goblet', 12, null, 25],
      ['barbell', 5, null, 210],
      ['plank', null, 35, null],
      ['new', 10, null, null],
    ]);
    expect(advised.estimatedSeconds).toBe(estimateCircuitSeconds(advised.items));
    expect(advised.items[3]).toBe(CIRCUIT.items[3]);
    expect(CIRCUIT.items[0].targetReps).toBe(10);
  });

  it('lowers the load after a session of big misses', () => {
    const history = new Map([['barbell', [set({ target: 5, done: 2, targetWeightLbs: 200, weightLbs: 200 }), set({ target: 5, done: 3, targetWeightLbs: 200, weightLbs: 200 })]]]);
    const advised = applySessionAdvice(CIRCUIT, history, { unit: 'lb', byId });
    expect(advised.items[1]).toMatchObject({ targetReps: 5, targetWeightLbs: 180 });
  });

  it('returns the same circuit when there is nothing to judge', () => {
    expect(applySessionAdvice(CIRCUIT, new Map(), { unit: 'lb', byId })).toBe(CIRCUIT);
    const onlyRestPause = new Map([['goblet', [set({ setType: 'rest_pause' })]]]);
    expect(applySessionAdvice(CIRCUIT, onlyRestPause, { unit: 'kg', byId })).toBe(CIRCUIT);
    expect(applySessionAdvice(CIRCUIT, new Map([['goblet', []]]), { unit: 'lb', byId })).toBe(CIRCUIT);
  });
});

describe('applySessionAdvice: a micro circuit keeps to its minutes', () => {
  /** Every set of every item hit its target at its target weight, effort not rated (one tap on "Done"). */
  function allHit(c: Circuit): Map<string, LoggedSet[]> {
    return new Map(
      c.items.map((entry) => {
        const target = entry.measure === 'time' ? entry.targetSeconds : entry.targetReps;
        const sets = Array.from({ length: entry.sets }, () =>
          set({ target, done: target ?? 0, targetWeightLbs: entry.targetWeightLbs, weightLbs: entry.targetWeightLbs }),
        );
        return [entry.exerciseId, sets];
      }),
    );
  }

  it.each([
    ['mostly cardio, home with just your body, 10 min', { lower: 10, upper: 10, core: 10, cardio: 70 }, 'home_bodyweight', 10],
    ['upper and core, home with just your body, 15 min', { lower: 25, upper: 50, core: 25, cardio: 0 }, 'home_bodyweight', 15],
    ['mostly cardio, gym, 5 min', { lower: 10, upper: 10, core: 10, cardio: 70 }, 'gym', 5],
    ['full body, home with gear, 10 min', { lower: 25, upper: 25, core: 25, cardio: 25 }, 'home_basic', 10],
  ] as [string, Split, keyof typeof SETUP_TEMPLATES, number][])(
    '%s: ten sessions that all hit still fit the 50 s stations',
    (_name, split, template, minutes) => {
      const setup = SETUP_TEMPLATES[template];
      let c = buildDefaultCircuit({
        split,
        location: setup.location,
        equipment: setup.equipment,
        minutes,
        kind: 'micro',
        library: STARTER_LIBRARY,
        variant: 0,
      });
      for (let session = 0; session < 10; session += 1) {
        c = applySessionAdvice(c, allHit(c), { unit: 'lb', byId: STARTER_LIBRARY_BY_ID });
      }
      const slot = PRESCRIPTION.micro.slotSeconds;
      for (const entry of c.items) {
        if (entry.targetReps !== null) expect(entry.targetReps).toBeLessThanOrEqual(MICRO_LIMITS.reps);
        if (entry.targetSeconds !== null) expect(entry.targetSeconds).toBeLessThanOrEqual(MICRO_LIMITS.seconds);
        expect(entry.restSeconds).toBeGreaterThanOrEqual(PRESCRIPTION.micro.minChangeoverSeconds);
        const station = (entry.targetSeconds ?? (entry.targetReps ?? 0) * PRESCRIPTION.secondsPerRep) + entry.restSeconds;
        expect(Math.abs(station - slot)).toBeLessThanOrEqual(2.5);
      }
      expect(c.estimatedSeconds).toBe(estimateCircuitSeconds(c.items));
      expect(Math.abs(c.estimatedSeconds - minutes * 60)).toBeLessThanOrEqual(minutes * 60 * 0.05);
    },
  );

  it('cuts a longer target from a full session back to the station, and works out the change-over again', () => {
    const history = new Map<string, LoggedSet[]>([
      // A full session's 15 bodyweight reps and 45 s hold, all on target: neither fits a 50 s station.
      ['goblet', [set({ target: 15, done: 15, targetWeightLbs: null, weightLbs: null })]],
      ['plank', [set({ target: 45, done: 45, targetWeightLbs: null, weightLbs: null })]],
    ]);
    const c = circuitOf([
      item('goblet'),
      item('plank', { measure: 'time', targetReps: null, targetSeconds: 30 }),
    ]);
    const advised = applySessionAdvice(c, history, { unit: 'lb', byId: new Map() });
    expect(advised.items.map((entry) => [entry.targetReps, entry.targetSeconds, entry.restSeconds])).toEqual([
      [13, null, 10],
      [null, 40, 10],
    ]);
    // A full session keeps the spotter's targets (15 reps is the top; the hold goes up 5 s) and its rest.
    const full = applySessionAdvice({ ...c, kind: 'full' }, history, { unit: 'lb', byId: new Map() });
    expect(full.items.map((entry) => [entry.targetReps, entry.targetSeconds, entry.restSeconds])).toEqual([
      [15, null, 20],
      [null, 50, 20],
    ]);
  });
});
