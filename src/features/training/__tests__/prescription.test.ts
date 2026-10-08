import { describe, expect, it } from '@jest/globals';

import { defaultTargets, demandOf, PRESCRIPTION, workSeconds } from '../prescription';
import { STARTER_LIBRARY } from '../starterLibrary';
import type { DemandLevel, Measure, WorkoutKind } from '../types';

const DEMANDS: (DemandLevel | null)[] = [1, 2, 3, null];
const KINDS: WorkoutKind[] = ['micro', 'full'];
const MEASURES: Measure[] = ['reps', 'time'];

describe('defaultTargets: the table in the header', () => {
  // [kind, measure, demand, targetReps, targetSeconds, restSeconds]
  const table: [WorkoutKind, Measure, DemandLevel | null, number | null, number | null, number][] = [
    ['micro', 'reps', 1, 12, null, 15],
    ['micro', 'reps', 2, 10, null, 20],
    ['micro', 'reps', 3, 8, null, 25],
    ['micro', 'reps', null, 10, null, 20],
    ['micro', 'time', 1, null, 40, 10],
    ['micro', 'time', 2, null, 30, 20],
    ['micro', 'time', 3, null, 30, 20],
    ['micro', 'time', null, null, 30, 20],
    ['full', 'reps', 1, 12, null, 60],
    ['full', 'reps', 2, 10, null, 60],
    ['full', 'reps', 3, 5, null, 120],
    ['full', 'reps', null, 10, null, 60],
    ['full', 'time', 1, null, 45, 60],
    ['full', 'time', 2, null, 40, 60],
    ['full', 'time', 3, null, 30, 120],
    ['full', 'time', null, null, 40, 60],
  ];
  it.each(table)(
    '%s, %s, demand %s → %s reps / %s s, rest %s s',
    (kind, measure, demandLevel, reps, seconds, rest) => {
      expect(defaultTargets({ measure, demandLevel }, kind)).toEqual({
        targetReps: reps,
        targetSeconds: seconds,
        targetWeightLbs: null,
        restSeconds: rest,
      });
    },
  );
});

describe('defaultTargets: invariants', () => {
  const cases = KINDS.flatMap((kind) =>
    MEASURES.flatMap((measure) => DEMANDS.map((demandLevel) => [kind, measure, demandLevel] as const)),
  );

  it.each(cases)(
    '%s, %s, demand %s: exactly one of reps/seconds, never a guessed load',
    (kind, measure, demandLevel) => {
      const targets = defaultTargets({ measure, demandLevel }, kind);
      expect(targets.targetWeightLbs).toBeNull();
      if (measure === 'reps') {
        expect(targets.targetSeconds).toBeNull();
        expect(Number.isInteger(targets.targetReps)).toBe(true);
        expect(targets.targetReps).toBeGreaterThanOrEqual(5);
      } else {
        expect(targets.targetReps).toBeNull();
        // The spotter counts timed sets in 5 s steps and relies on targets of 20 s and up.
        expect(targets.targetSeconds).toBeGreaterThanOrEqual(20);
        expect((targets.targetSeconds ?? 0) % 5).toBe(0);
      }
      expect(targets.restSeconds % 5).toBe(0);
    },
  );

  it.each(cases.filter(([kind]) => kind === 'micro'))(
    '%s, %s, demand %s: work plus change-over fills the 50 s slot (at least 10 s to change over)',
    (_kind, measure, demandLevel) => {
      const targets = defaultTargets({ measure, demandLevel }, 'micro');
      expect(targets.restSeconds).toBeGreaterThanOrEqual(PRESCRIPTION.micro.minChangeoverSeconds);
      const slot = workSeconds(targets) + targets.restSeconds;
      expect(Math.abs(slot - PRESCRIPTION.micro.slotSeconds)).toBeLessThanOrEqual(2.5);
    },
  );

  it('full: heavy lifts rest 90–120 s, everything else 60 s', () => {
    for (const measure of MEASURES) {
      for (const demandLevel of DEMANDS) {
        const rest = defaultTargets({ measure, demandLevel }, 'full').restSeconds;
        if (demandLevel === 3) {
          expect(rest).toBeGreaterThanOrEqual(90);
          expect(rest).toBeLessThanOrEqual(120);
        } else {
          expect(rest).toBe(60);
        }
      }
    }
  });

  it('harder exercises get fewer reps and never less rest', () => {
    for (const kind of KINDS) {
      const reps = [1, 2, 3].map((d) => defaultTargets({ measure: 'reps', demandLevel: d as DemandLevel }, kind));
      expect(reps[0].targetReps).toBeGreaterThan(reps[1].targetReps ?? 0);
      expect(reps[1].targetReps).toBeGreaterThan(reps[2].targetReps ?? 0);
      expect(reps[0].restSeconds).toBeLessThanOrEqual(reps[1].restSeconds);
      expect(reps[1].restSeconds).toBeLessThanOrEqual(reps[2].restSeconds);
    }
  });

  it('gives every starter exercise sensible targets in both kinds', () => {
    for (const exercise of STARTER_LIBRARY) {
      for (const kind of KINDS) {
        const targets = defaultTargets(exercise, kind);
        expect(targets.targetReps === null).toBe(exercise.measure === 'time');
        expect(workSeconds(targets)).toBeGreaterThanOrEqual(15);
        expect(workSeconds(targets)).toBeLessThanOrEqual(45);
      }
    }
  });
});

describe('helpers', () => {
  it('demandOf counts an unknown demand level as 2', () => {
    expect(demandOf({ demandLevel: null })).toBe(2);
    expect(demandOf({ demandLevel: 1 })).toBe(1);
    expect(demandOf({ demandLevel: 3 })).toBe(3);
  });

  it('workSeconds: seconds for a timed set, 3 s per rep otherwise, 0 with no target', () => {
    expect(workSeconds({ targetReps: null, targetSeconds: 40 })).toBe(40);
    expect(workSeconds({ targetReps: 12, targetSeconds: null })).toBe(36);
    expect(workSeconds({ targetReps: 5, targetSeconds: null })).toBe(5 * PRESCRIPTION.secondsPerRep);
    expect(workSeconds({ targetReps: null, targetSeconds: null })).toBe(0);
  });
});
