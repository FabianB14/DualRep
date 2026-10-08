/**
 * The equipment vocabulary shared by exercises.equipment and equipment_setups.equipment (both jsonb
 * arrays of these strings). It is the one from docs/research/exercise-data-and-fsrs.md §A6, which the
 * dataset import also uses, so library rows and setups always speak the same words.
 *
 * An exercise fits a setup when every item it needs is in the setup. `bodyweight` means "no
 * equipment" and is always available, so it never has to be checked off.
 */
import type { ExerciseLocation, SetupLocation } from './types';

export const EQUIPMENT = [
  // Home-friendly (an exercise needing only these can be location 'both').
  'bodyweight',
  'dumbbell',
  'kettlebell',
  'band',
  'pull_up_bar',
  'bench',
  'box',
  'jump_rope',
  'medicine_ball',
  'stability_ball',
  'foam_roller',
  'suspension_trainer',
  'weight_plate',
  'ab_wheel',
  'balance_board',
  // Gym-only.
  'barbell',
  'rack',
  'ez_bar',
  'trap_bar',
  'cable',
  'machine',
  'cardio_machine',
  'dip_station',
  'hyperextension_bench',
  'sled',
  'battle_rope',
  'climbing_rope',
  'strongman_implement',
  // Unknown gear in the dataset. Never on a setup checklist, so such exercises never fit a setup.
  'other',
] as const;

export type Equipment = (typeof EQUIPMENT)[number];

/** Items that need a gym (research §A6 "location"). */
export const GYM_ONLY_EQUIPMENT: readonly Equipment[] = [
  'barbell',
  'rack',
  'ez_bar',
  'trap_bar',
  'cable',
  'machine',
  'cardio_machine',
  'dip_station',
  'hyperextension_bench',
  'sled',
  'battle_rope',
  'climbing_rope',
  'strongman_implement',
  'other',
];

export const EQUIPMENT_LABELS: Record<Equipment, string> = {
  bodyweight: 'Just my body',
  dumbbell: 'Dumbbells',
  kettlebell: 'Kettlebell',
  band: 'Resistance bands',
  pull_up_bar: 'Pull-up bar',
  bench: 'Bench',
  box: 'Box or sturdy step',
  jump_rope: 'Jump rope',
  medicine_ball: 'Medicine ball',
  stability_ball: 'Stability ball',
  foam_roller: 'Foam roller',
  suspension_trainer: 'Suspension trainer or rings',
  weight_plate: 'Weight plate',
  ab_wheel: 'Ab wheel',
  balance_board: 'Balance board',
  barbell: 'Barbell',
  rack: 'Squat rack',
  ez_bar: 'EZ curl bar',
  trap_bar: 'Trap bar',
  cable: 'Cable machine',
  machine: 'Weight machines',
  cardio_machine: 'Cardio machines',
  dip_station: 'Dip station',
  hyperextension_bench: 'Back extension bench',
  sled: 'Sled',
  battle_rope: 'Battle ropes',
  climbing_rope: 'Climbing rope',
  strongman_implement: 'Strongman gear',
  other: 'Other',
};

/** Checklist groups for the setup editor (bodyweight and 'other' are not checklist items). */
export const EQUIPMENT_GROUPS: readonly { title: string; items: readonly Equipment[] }[] = [
  { title: 'Free weights', items: ['dumbbell', 'kettlebell', 'barbell', 'ez_bar', 'trap_bar', 'weight_plate', 'medicine_ball'] },
  { title: 'Bars, benches and racks', items: ['pull_up_bar', 'bench', 'rack', 'dip_station', 'hyperextension_bench', 'box'] },
  { title: 'Machines', items: ['cable', 'machine', 'cardio_machine'] },
  {
    title: 'Small gear',
    items: ['band', 'jump_rope', 'stability_ball', 'foam_roller', 'suspension_trainer', 'ab_wheel', 'balance_board'],
  },
  { title: 'Specialty', items: ['sled', 'battle_rope', 'climbing_rope', 'strongman_implement'] },
];

/** One-tap starting points for a new setup. Users adjust the checklist afterwards. */
export const SETUP_TEMPLATES: Record<'gym' | 'home_bodyweight' | 'home_basic', { location: SetupLocation; equipment: Equipment[] }> = {
  gym: {
    location: 'gym',
    equipment: [
      'dumbbell',
      'kettlebell',
      'barbell',
      'ez_bar',
      'weight_plate',
      'medicine_ball',
      'pull_up_bar',
      'bench',
      'rack',
      'dip_station',
      'hyperextension_bench',
      'box',
      'cable',
      'machine',
      'cardio_machine',
      'band',
      'jump_rope',
      'stability_ball',
      'foam_roller',
      'ab_wheel',
    ],
  },
  home_bodyweight: { location: 'home', equipment: [] },
  home_basic: { location: 'home', equipment: ['dumbbell', 'band'] },
};

export function isEquipment(value: unknown): value is Equipment {
  return typeof value === 'string' && (EQUIPMENT as readonly string[]).includes(value);
}

/** True when every item the exercise needs is available. `bodyweight` is always available. */
export function fitsEquipment(required: readonly string[], available: readonly string[]): boolean {
  return required.every((item) => item === 'bodyweight' || available.includes(item));
}

/**
 * True when an exercise's location allows it at a setup's location. Real availability is the
 * equipment check; this only keeps desk-side moves (location 'home') out of gym sessions. A 'gym'
 * exercise is allowed at home, because a home gym with a barbell and a rack has checked them off, and
 * fitsEquipment decides.
 */
export function fitsLocation(exercise: ExerciseLocation, setup: SetupLocation): boolean {
  return exercise === 'both' || exercise === setup || (setup === 'home' && exercise === 'gym');
}

/** Both checks: the exercise may be done with this setup. */
export function fitsSetup(
  exercise: { equipment: readonly string[]; location: ExerciseLocation },
  setup: { equipment: readonly string[]; location: SetupLocation },
): boolean {
  return fitsLocation(exercise.location, setup.location) && fitsEquipment(exercise.equipment, setup.equipment);
}

/** Dedupes, drops unknown items and `bodyweight` (implicit), and sorts by vocabulary order. */
export function normalizeEquipmentList(items: readonly unknown[]): Equipment[] {
  const set = new Set(items.filter(isEquipment));
  set.delete('bodyweight');
  return EQUIPMENT.filter((item) => set.has(item));
}

/**
 * The gear in a list, in plain words and in the list's order ("Dumbbells, Bench"); '' when it
 * needs none (`bodyweight` is implicit and never named). An item this app version does not know is
 * shown as given rather than hidden, so a newer server's gear still reads as something.
 */
export function describeEquipment(items: readonly string[]): string {
  return items
    .filter((item) => item !== 'bodyweight')
    .map((item) => (isEquipment(item) ? EQUIPMENT_LABELS[item] : item))
    .join(', ');
}
