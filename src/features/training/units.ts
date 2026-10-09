/**
 * Weight units and the weights that exist in the real world.
 *
 * Every weight is stored in pounds (exercise_sets.weight_lbs, target_weight_lbs, circuit targets); the
 * screens show it in the profile's unit (profiles.unit_pref). Storage never changes unit, so a user
 * who switches from lb to kg keeps their history; only the display and the load steps change.
 *
 * Load steps. A weight the spotter or the −/+ buttons suggest must be one you can actually load, so
 * every weight sits on a grid of whole steps, counted from zero in the step's own unit:
 * - lb: 5 lb for barbells, EZ and trap bars, machines, cables, plates and dumbbells (the smallest
 *   common plate is 2.5 lb, one per side; dumbbell racks go up in 5 lb).
 * - kg: 2.5 kg for barbells, EZ and trap bars, machines, cables and plates (1.25 kg per side);
 *   2 kg for dumbbells (the usual fixed-dumbbell rack: 2, 4, 6, … kg).
 * - Kettlebells: 4 kg in both units (8, 12, 16, 20, 24 kg: the sizes kettlebells are made in), so in
 *   lb they show as 17.6, 26.5, 35.3 … lb.
 * - Anything else that carries a load (a weighted vest on a bodyweight move, a medicine ball): the
 *   unit's general step, 5 lb or 2.5 kg.
 * When an exercise lists several items (a bench press needs barbell, bench and rack), the one that
 * carries the load decides, in this order: barbell, trap bar, EZ bar, machine, cable, plate,
 * kettlebell, dumbbell.
 *
 * Pure functions with no imports beyond types, so the spotter and its tests can use them anywhere.
 */
import type { Unit } from './types';

/** Pounds in one kilogram (1 / 0.45359237, the international pound, to 12 significant digits). */
export const LB_PER_KG = 2.20462262185;

/** The exercise's equipment list (exercises.equipment) or a single item from it. */
export type EquipmentInput = string | readonly string[];

/** A grid of loadable weights: whole multiples of `step`, counted in `unit`. */
type Grid = { unit: Unit; step: number };

/** Items that carry the load, in the order that decides the step when an exercise lists several. */
const LOAD_PRIORITY = ['barbell', 'trap_bar', 'ez_bar', 'machine', 'cable', 'weight_plate', 'kettlebell', 'dumbbell'];

/**
 * Float slack for grid math: a weight converted kg → lb → kg can come back as 19.999999999, which must
 * still count as 20 kg (8 whole steps of 2.5), not fall a step.
 */
const EPSILON = 1e-9;

/** Converts a weight in `unit` to pounds. */
export function toLbs(value: number, unit: Unit): number {
  return unit === 'kg' ? value * LB_PER_KG : value;
}

/** Converts a weight in pounds to `unit`. */
export function fromLbs(lbs: number, unit: Unit): number {
  return unit === 'kg' ? lbs / LB_PER_KG : lbs;
}

/** The item that carries the load, or null when none of the list is a load item. */
function loadItem(equipment: EquipmentInput): string | null {
  const items: readonly string[] = typeof equipment === 'string' ? [equipment] : equipment;
  return LOAD_PRIORITY.find((item) => items.includes(item)) ?? null;
}

function gridFor(unit: Unit, equipment: EquipmentInput): Grid {
  const item = loadItem(equipment);
  if (item === 'kettlebell') return { unit: 'kg', step: 4 };
  if (unit === 'lb') return { unit: 'lb', step: 5 };
  return { unit: 'kg', step: item === 'dumbbell' ? 2 : 2.5 };
}

/** Position of a weight on its grid, in steps (fractional when the weight is between two steps). */
function stepsOf(lbs: number, grid: Grid): number {
  return Number.isFinite(lbs) && lbs > 0 ? fromLbs(lbs, grid.unit) / grid.step : 0;
}

function lbsAt(steps: number, grid: Grid): number {
  return toLbs(Math.max(0, steps) * grid.step, grid.unit);
}

/**
 * One load step for this equipment, in the user's unit: what the weight −/+ buttons move by
 * (5 lb, 2.5 kg, 2 kg, or 4 kg ≈ 8.82 lb for a kettlebell).
 */
export function loadIncrement(unit: Unit, equipment: EquipmentInput): number {
  const grid = gridFor(unit, equipment);
  return fromLbs(toLbs(grid.step, grid.unit), unit);
}

/** The heaviest real weight at or below `lbs`, in pounds (0 below one step). */
export function roundDownToIncrement(lbs: number, unit: Unit, equipment: EquipmentInput): number {
  const grid = gridFor(unit, equipment);
  return lbsAt(Math.floor(stepsOf(lbs, grid) + EPSILON), grid);
}

/** The nearest real weight to `lbs`, in pounds (halfway rounds up). */
export function roundToIncrement(lbs: number, unit: Unit, equipment: EquipmentInput): number {
  const grid = gridFor(unit, equipment);
  return lbsAt(Math.round(stepsOf(lbs, grid) + EPSILON), grid);
}

/**
 * The weight `steps` real steps away from `lbs`, in pounds, never below 0: +1 is the next weight up
 * (from 22 lb on a 5 lb grid: 25), −1 the next one down (20), 0 the nearest. For the −/+ buttons and
 * the spotter's "one step heavier".
 */
export function stepWeight(lbs: number, unit: Unit, equipment: EquipmentInput, steps: number): number {
  const grid = gridFor(unit, equipment);
  const at = stepsOf(lbs, grid);
  const whole = Math.trunc(steps);
  if (whole > 0) return lbsAt(Math.floor(at + EPSILON) + whole, grid);
  if (whole < 0) return lbsAt(Math.ceil(at - EPSILON) + whole, grid);
  return lbsAt(Math.round(at + EPSILON), grid);
}

/** A stored weight for display in the user's unit: "135 lb", "22.5 kg", "35.3 lb" (one decimal at most). */
export function formatWeight(lbs: number, unit: Unit): string {
  if (!Number.isFinite(lbs)) return `– ${unit}`;
  const value = Math.round(fromLbs(lbs, unit) * 10) / 10;
  return `${value} ${unit}`;
}
