import { describe, expect, it } from '@jest/globals';

import type { Unit } from '../types';
import {
  formatWeight,
  fromLbs,
  LB_PER_KG,
  loadIncrement,
  roundDownToIncrement,
  roundToIncrement,
  stepWeight,
  toLbs,
} from '../units';

const kg = (value: number) => toLbs(value, 'kg');

/** Every load item with the step it should get, per unit (the grid is counted in `gridUnit`). */
const STEPS: { equipment: string; lb: number; kg: number }[] = [
  { equipment: 'barbell', lb: 5, kg: 2.5 },
  { equipment: 'trap_bar', lb: 5, kg: 2.5 },
  { equipment: 'ez_bar', lb: 5, kg: 2.5 },
  { equipment: 'machine', lb: 5, kg: 2.5 },
  { equipment: 'cable', lb: 5, kg: 2.5 },
  { equipment: 'weight_plate', lb: 5, kg: 2.5 },
  { equipment: 'dumbbell', lb: 5, kg: 2 },
  { equipment: 'kettlebell', lb: 4 * LB_PER_KG, kg: 4 },
  // Not a load item: the unit's general step (a weighted vest on a push-up, a medicine ball).
  { equipment: 'bodyweight', lb: 5, kg: 2.5 },
  { equipment: 'medicine_ball', lb: 5, kg: 2.5 },
  { equipment: 'band', lb: 5, kg: 2.5 },
];

describe('unit conversion', () => {
  it('uses the international pound', () => {
    expect(LB_PER_KG).toBeCloseTo(1 / 0.45359237, 10);
  });

  it('converts both ways and round-trips', () => {
    expect(toLbs(100, 'lb')).toBe(100);
    expect(fromLbs(100, 'lb')).toBe(100);
    expect(toLbs(20, 'kg')).toBeCloseTo(44.0925, 4);
    expect(fromLbs(45, 'kg')).toBeCloseTo(20.4117, 4);
    for (const value of [0, 1.25, 2.5, 17.5, 60, 142.5, 300]) {
      expect(fromLbs(toLbs(value, 'kg'), 'kg')).toBeCloseTo(value, 10);
    }
  });
});

describe('formatWeight', () => {
  it.each([
    [135, 'lb', '135 lb'],
    [47.5, 'lb', '47.5 lb'],
    [0, 'lb', '0 lb'],
    [kg(22.5), 'kg', '22.5 kg'],
    [kg(20), 'kg', '20 kg'],
    [135, 'kg', '61.2 kg'],
    [kg(16), 'lb', '35.3 lb'],
    [kg(12), 'kg', '12 kg'],
  ] as [number, Unit, string][])('%p lb in %s → %s', (lbs, unit, text) => {
    expect(formatWeight(lbs, unit)).toBe(text);
  });

  it('never shows float noise or "NaN"', () => {
    expect(formatWeight(0.1 + 0.2, 'lb')).toBe('0.3 lb');
    expect(formatWeight(Number.NaN, 'kg')).toBe('– kg');
  });
});

describe('loadIncrement', () => {
  it.each(STEPS)('$equipment: $lb lb / $kg kg', ({ equipment, lb, kg: kgStep }) => {
    expect(loadIncrement('lb', equipment)).toBeCloseTo(lb, 10);
    expect(loadIncrement('kg', equipment)).toBeCloseTo(kgStep, 10);
    expect(loadIncrement('kg', [equipment])).toBeCloseTo(kgStep, 10);
  });

  it('lets the item that carries the load decide when an exercise lists several', () => {
    expect(loadIncrement('kg', ['barbell', 'bench', 'rack'])).toBe(2.5);
    expect(loadIncrement('kg', ['bench', 'dumbbell'])).toBe(2);
    expect(loadIncrement('kg', ['dumbbell', 'barbell'])).toBe(2.5);
    expect(loadIncrement('kg', ['dumbbell', 'kettlebell'])).toBe(4);
    expect(loadIncrement('kg', ['cable', 'dumbbell'])).toBe(2.5);
    expect(loadIncrement('kg', [])).toBe(2.5);
  });
});

describe('roundDownToIncrement', () => {
  it('rounds down to 5 lb in pounds', () => {
    expect(roundDownToIncrement(121.5, 'lb', 'barbell')).toBe(120);
    expect(roundDownToIncrement(124.99, 'lb', 'barbell')).toBe(120);
    expect(roundDownToIncrement(125, 'lb', 'barbell')).toBe(125);
    expect(roundDownToIncrement(22.5, 'lb', 'dumbbell')).toBe(20);
    expect(roundDownToIncrement(4.99, 'lb', 'machine')).toBe(0);
  });

  it('rounds down to 2.5 kg, or 2 kg for dumbbells, in kilograms', () => {
    expect(roundDownToIncrement(kg(54), 'kg', 'barbell')).toBeCloseTo(kg(52.5), 10);
    expect(roundDownToIncrement(kg(52.5), 'kg', 'barbell')).toBeCloseTo(kg(52.5), 10);
    expect(roundDownToIncrement(kg(10.8), 'kg', 'dumbbell')).toBeCloseTo(kg(10), 10);
    expect(roundDownToIncrement(kg(11.99), 'kg', 'dumbbell')).toBeCloseTo(kg(10), 10);
    // 135 lb is 61.2 kg: a kg user's real plate weight below it is 60 kg.
    expect(roundDownToIncrement(135, 'kg', 'barbell')).toBeCloseTo(kg(60), 10);
  });

  it('puts kettlebells on a 4 kg grid in both units', () => {
    expect(roundDownToIncrement(40, 'lb', 'kettlebell')).toBeCloseTo(kg(16), 10);
    expect(roundDownToIncrement(kg(14.4), 'lb', 'kettlebell')).toBeCloseTo(kg(12), 10);
    expect(roundDownToIncrement(kg(14.4), 'kg', 'kettlebell')).toBeCloseTo(kg(12), 10);
    expect(roundDownToIncrement(kg(3.9), 'kg', 'kettlebell')).toBe(0);
  });

  it('returns 0 for nothing, negatives and non-numbers', () => {
    expect(roundDownToIncrement(0, 'lb', 'barbell')).toBe(0);
    expect(roundDownToIncrement(-10, 'kg', 'barbell')).toBe(0);
    expect(roundDownToIncrement(Number.NaN, 'kg', 'barbell')).toBe(0);
  });

  it.each(STEPS)('$equipment: real weights stay put and nothing rounds up', ({ equipment }) => {
    for (const unit of ['lb', 'kg'] as Unit[]) {
      const step = toLbs(loadIncrement(unit, equipment), unit);
      for (let n = 0; n <= 200; n++) {
        const real = n * step;
        // Exactly on the grid (after a kg → lb → kg trip) stays put; just below falls one step.
        expect(roundDownToIncrement(real, unit, equipment)).toBeCloseTo(real, 9);
        if (n > 0) expect(roundDownToIncrement(real - 0.01, unit, equipment)).toBeCloseTo(real - step, 9);
        const between = real + step * 0.37;
        expect(roundDownToIncrement(between, unit, equipment)).toBeLessThanOrEqual(between);
      }
    }
  });
});

describe('roundToIncrement', () => {
  it('rounds to the nearest real weight, halfway up', () => {
    expect(roundToIncrement(122.4, 'lb', 'barbell')).toBe(120);
    expect(roundToIncrement(122.5, 'lb', 'barbell')).toBe(125);
    expect(roundToIncrement(kg(51.2), 'kg', 'barbell')).toBeCloseTo(kg(50), 10);
    expect(roundToIncrement(kg(51.25), 'kg', 'barbell')).toBeCloseTo(kg(52.5), 10);
    expect(roundToIncrement(kg(11), 'kg', 'dumbbell')).toBeCloseTo(kg(12), 10);
    expect(roundToIncrement(36, 'lb', 'kettlebell')).toBeCloseTo(kg(16), 10);
    expect(roundToIncrement(2, 'lb', 'dumbbell')).toBe(0);
  });
});

describe('stepWeight (the −/+ buttons)', () => {
  it('moves one real step from a real weight', () => {
    expect(stepWeight(20, 'lb', 'dumbbell', 1)).toBe(25);
    expect(stepWeight(25, 'lb', 'dumbbell', -1)).toBe(20);
    expect(stepWeight(20, 'lb', 'dumbbell', 2)).toBe(30);
    expect(stepWeight(kg(20), 'kg', 'barbell', 1)).toBeCloseTo(kg(22.5), 10);
    expect(stepWeight(kg(10), 'kg', 'dumbbell', 1)).toBeCloseTo(kg(12), 10);
    expect(stepWeight(kg(16), 'lb', 'kettlebell', 1)).toBeCloseTo(kg(20), 10);
    expect(stepWeight(kg(16), 'kg', 'kettlebell', -1)).toBeCloseTo(kg(12), 10);
  });

  it('goes to the next real weight up or down from an in-between weight', () => {
    expect(stepWeight(22, 'lb', 'dumbbell', 1)).toBe(25);
    expect(stepWeight(22, 'lb', 'dumbbell', -1)).toBe(20);
    expect(stepWeight(22.4, 'lb', 'dumbbell', 0)).toBe(20);
    // 135 lb shown to a kg user is 61.2 kg: up goes to 62.5 kg, down to 60 kg.
    expect(stepWeight(135, 'kg', 'barbell', 1)).toBeCloseTo(kg(62.5), 10);
    expect(stepWeight(135, 'kg', 'barbell', -1)).toBeCloseTo(kg(60), 10);
  });

  it('never goes below 0', () => {
    expect(stepWeight(0, 'lb', 'dumbbell', -1)).toBe(0);
    expect(stepWeight(5, 'lb', 'dumbbell', -3)).toBe(0);
    expect(stepWeight(0, 'kg', 'dumbbell', 1)).toBeCloseTo(kg(2), 10);
  });
});
