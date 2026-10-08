// Tests for the A6 curation rules (node --test; `npm run test:scripts`).
// The fixture is real rows of the pinned free-exercise-db file (the research §A6 spot-check table plus
// a few odd ones), with the instruction text replaced: the dataset's prose stays out of the repo (D9).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  BASE_EQUIPMENT,
  GYM_ONLY_EQUIPMENT,
  HOME_OK_EQUIPMENT,
  MICRO_EQUIPMENT,
  MUSCLES,
  bodyRegion,
  demandLevel,
  exerciseLocation,
  mapExercise,
  microOk,
  movementPattern,
  normalizeEquipment,
  trainingCategory,
} from './mapping.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/spot-check.json', import.meta.url), 'utf8'));
const byId = (id) => {
  const row = fixture.find((ex) => ex.id === id);
  assert.ok(row, `fixture row ${id}`);
  return mapExercise(row);
};

/** A dataset row with sensible defaults, for rules the fixture does not reach. */
const ex = (overrides) => ({
  id: 'Test_Row',
  name: 'Test Row',
  force: 'push',
  level: 'beginner',
  mechanic: 'compound',
  equipment: 'body only',
  primaryMuscles: ['chest'],
  secondaryMuscles: [],
  instructions: ['Step.'],
  category: 'strength',
  images: ['Test_Row/0.jpg', 'Test_Row/1.jpg'],
  ...overrides,
});
const curated = (row) => {
  const m = mapExercise(row);
  return [m.equipment, m.location, m.movement_pattern, m.body_region, m.demand_level, m.micro_ok];
};

describe('the research §A6 spot-check table', () => {
  // | Exercise | equipment | location | movement_pattern | body_region | demand | micro_ok |
  const table = [
    ['Pullups', ['pull_up_bar'], 'both', 'vertical_pull', 'upper', 2, true],
    ['Barbell_Squat', ['barbell', 'rack'], 'gym', 'squat', 'lower', 3, false],
    ['Goblet_Squat', ['kettlebell'], 'both', 'squat', 'lower', 2, true],
    ['Farmers_Walk', ['other'], 'gym', 'carry', 'full', 3, false],
    ['Rope_Jumping', ['jump_rope'], 'both', 'conditioning', 'cardio', 2, true],
    ['Plank', ['bodyweight'], 'both', 'core', 'core', 1, true],
    ['Dips_-_Triceps_Version', ['dip_station'], 'gym', 'vertical_push', 'upper', 2, false],
  ];
  for (const [id, equipment, location, pattern, region, demand, micro] of table) {
    test(id, () => {
      const row = byId(id);
      assert.deepEqual(
        [row.equipment, row.location, row.movement_pattern, row.body_region, row.demand_level, row.micro_ok],
        [equipment, location, pattern, region, demand, micro],
      );
    });
  }
});

describe('the other fixture rows', () => {
  test('the first of two primary muscles is the muscle group; no images keeps it out of micro circuits', () => {
    const row = byId('Kettlebell_Halo_With_Overhead_Extension');
    assert.equal(row.muscle_group, 'shoulders');
    assert.equal(row.movement_pattern, 'vertical_push'); // shoulders + compound + push fallback
    assert.equal(row.location, 'both');
    assert.equal(row.micro_ok, false);
  });

  test('a row without instructions is not micro_ok', () => {
    const row = byId('Side_Bridge');
    assert.equal(row.movement_pattern, 'core');
    assert.equal(row.micro_ok, false);
  });

  test('"crunch" is core, not conditioning (the \\brun\\b boundary)', () => {
    assert.deepEqual(curated(fixture.find((r) => r.id === 'Crunches')), [['bodyweight'], 'both', 'core', 'core', 1, true]);
  });

  test('a cardio machine row', () => {
    const row = byId('Bicycling_Stationary');
    assert.deepEqual(row.equipment, ['cardio_machine']);
    assert.equal(row.location, 'gym');
    assert.equal(row.category, 'conditioning');
    assert.equal(row.body_region, 'cardio');
  });

  test('a stretch with no equipment is bodyweight mobility at demand 1', () => {
    const row = byId('Adductor_Groin');
    assert.deepEqual(
      [row.equipment, row.movement_pattern, row.category, row.dataset_category, row.demand_level, row.micro_ok],
      [['bodyweight'], 'mobility', 'mobility', 'stretching', 1, true],
    );
  });

  test('dataset facts are copied as they are; the name is trimmed', () => {
    const row = byId('Farmers_Walk');
    assert.deepEqual(
      [row.dataset_id, row.name, row.muscle_group, row.level, row.force, row.mechanic, row.dataset_category],
      ['Farmers_Walk', "Farmer's Walk", 'forearms', 'intermediate', null, 'compound', 'strongman'],
    );
    assert.deepEqual(row.secondary_muscles, ['abdominals', 'glutes', 'hamstrings', 'lower back', 'quadriceps', 'traps']);
    assert.equal(mapExercise(ex({ name: '  Padded Name  ' })).name, 'Padded Name');
  });

  test('instructions and images are never part of a mapped row (D9)', () => {
    for (const row of fixture) {
      const mapped = mapExercise(row);
      assert.equal('instructions' in mapped, false);
      assert.equal('images' in mapped, false);
    }
  });
});

describe('equipment', () => {
  test('base values map to the vocabulary', () => {
    assert.deepEqual(normalizeEquipment(ex({ name: 'Thing', equipment: 'e-z curl bar' })), ['ez_bar']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Thing', equipment: 'exercise ball' })), ['stability_ball']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Thing', equipment: 'bands' })), ['band']);
  });

  test("'other' and null are refined from the name, else stay other / become bodyweight", () => {
    assert.deepEqual(normalizeEquipment(ex({ name: 'Atlas Stones', equipment: 'other' })), ['strongman_implement']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Sled Push', equipment: null })), ['sled']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Mystery Move', equipment: 'other' })), ['other']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Mystery Move', equipment: null })), ['bodyweight']);
  });

  test('implied fixtures are added and bodyweight is dropped when anything else is needed', () => {
    assert.deepEqual(normalizeEquipment(ex({ name: 'Chin-Up', equipment: 'body only' })), ['pull_up_bar']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Bench Dips', equipment: 'body only' })), ['bench']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Incline Dumbbell Press', equipment: 'dumbbell' })), ['dumbbell', 'bench']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Barbell Bench Press', equipment: 'barbell' })), ['barbell', 'bench', 'rack']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Inverted Row', equipment: 'body only' })), ['rack']);
    assert.deepEqual(normalizeEquipment(ex({ name: 'Box Jump', equipment: 'other' })), ['box']);
    // A machine never needs a separate bench.
    assert.deepEqual(normalizeEquipment(ex({ name: 'Incline Chest Press', equipment: 'machine' })), ['machine']);
  });

  test('location: gym when any item needs a gym, else both (never home)', () => {
    assert.equal(exerciseLocation(['dumbbell', 'bench']), 'both');
    assert.equal(exerciseLocation(['dumbbell', 'rack']), 'gym');
    assert.equal(exerciseLocation(['other']), 'gym');
    assert.equal(exerciseLocation(['bodyweight']), 'both');
  });

  test('the vocabulary is complete: every base value and every home or micro item is known', () => {
    const known = new Set([...GYM_ONLY_EQUIPMENT, ...HOME_OK_EQUIPMENT]);
    for (const item of Object.values(BASE_EQUIPMENT)) assert.ok(known.has(item), item);
    for (const item of MICRO_EQUIPMENT) assert.ok(HOME_OK_EQUIPMENT.has(item), item);
    for (const item of GYM_ONLY_EQUIPMENT) assert.equal(HOME_OK_EQUIPMENT.has(item), false, item);
  });

  test('matches the app vocabulary in src/features/training/equipment.ts', async (t) => {
    if (!process.features.typescript) {
      t.skip('this Node cannot import TypeScript (Node 22.18+ can; older 22.x need --experimental-strip-types)');
      return;
    }
    const app = await import(new URL('../../src/features/training/equipment.ts', import.meta.url).href);
    assert.deepEqual(new Set(app.EQUIPMENT), new Set([...GYM_ONLY_EQUIPMENT, ...HOME_OK_EQUIPMENT]));
    assert.deepEqual(new Set(app.GYM_ONLY_EQUIPMENT), GYM_ONLY_EQUIPMENT);
  });
});

describe('movement pattern', () => {
  test('word boundaries: "machine" is not a chin-up, "crunch" is not a run', () => {
    assert.equal(movementPattern(ex({ name: 'Machine Bicep Curl', primaryMuscles: ['biceps'], force: 'pull' })), 'other');
    assert.equal(movementPattern(ex({ name: 'Cable Crunch', primaryMuscles: ['abdominals'] })), 'core');
    assert.equal(movementPattern(ex({ name: 'Running, Treadmill', category: 'cardio', primaryMuscles: ['quadriceps'] })), 'conditioning');
  });

  test('rule order: the first match wins', () => {
    // "Squat" names that are really lunges.
    assert.equal(movementPattern(ex({ name: 'Dumbbell Split Squat', primaryMuscles: ['quadriceps'] })), 'lunge');
    // A stretch is mobility whatever else its name says.
    assert.equal(movementPattern(ex({ name: 'Squat Stretch', category: 'stretching', primaryMuscles: ['quadriceps'] })), 'mobility');
    // Upright rows are not horizontal pulls.
    assert.equal(movementPattern(ex({ name: 'Upright Barbell Row', primaryMuscles: ['shoulders'], force: 'pull' })), 'other');
    // A chest-primary push is a horizontal push even without a matching name.
    assert.equal(movementPattern(ex({ name: 'Svend Press', primaryMuscles: ['chest'] })), 'horizontal_push');
    assert.equal(movementPattern(ex({ name: 'Around The Worlds', primaryMuscles: ['chest'] })), 'horizontal_push');
    // A conditioning-looking plyometric with "chest" in its name is a push.
    assert.equal(movementPattern(ex({ name: 'Medicine Ball Chest Pass', category: 'plyometrics', primaryMuscles: ['chest'], force: 'pull' })), 'horizontal_push');
  });

  test('fallbacks', () => {
    assert.equal(movementPattern(ex({ name: 'Frog Hops', category: 'plyometrics', primaryMuscles: ['quadriceps'] })), 'conditioning');
    assert.equal(movementPattern(ex({ name: 'Plyo Kettlebell Thing', category: 'plyometrics', primaryMuscles: ['triceps'] })), 'other');
    assert.equal(movementPattern(ex({ name: 'Leg Curl', primaryMuscles: ['hamstrings'], force: 'pull' })), 'hinge');
    assert.equal(movementPattern(ex({ name: 'Wrist Curl', primaryMuscles: ['forearms'], force: 'pull' })), 'other');
  });
});

describe('body region, category, demand', () => {
  test('body region', () => {
    assert.equal(bodyRegion(ex({ name: 'Power Clean', category: 'olympic weightlifting', primaryMuscles: ['hamstrings'] }), 'hinge'), 'full');
    assert.equal(bodyRegion(ex({ name: 'Hyperextensions', primaryMuscles: ['lower back'] }), 'hinge'), 'lower');
    assert.equal(bodyRegion(ex({ name: 'Superman', primaryMuscles: ['lower back'] }), 'core'), 'core');
    assert.equal(bodyRegion(ex({ name: 'Burpee', primaryMuscles: ['quadriceps'] }), 'conditioning'), 'cardio');
    assert.equal(bodyRegion(ex({ name: 'Neck Press', primaryMuscles: ['neck'] }), 'other'), 'upper');
  });

  test('category: the conditioning pattern overrides the dataset category', () => {
    assert.equal(trainingCategory(ex({ category: 'plyometrics' }), 'conditioning'), 'conditioning');
    assert.equal(trainingCategory(ex({ category: 'plyometrics' }), 'squat'), 'power');
    assert.equal(trainingCategory(ex({ category: 'powerlifting' }), 'hinge'), 'strength');
    assert.equal(trainingCategory(ex({ category: 'stretching' }), 'mobility'), 'mobility');
  });

  test('demand level, in rule order', () => {
    assert.equal(demandLevel(ex({ category: 'stretching', level: 'expert' }), 'mobility', ['bodyweight']), 1);
    assert.equal(demandLevel(ex({ category: 'strongman' }), 'carry', ['other']), 3);
    assert.equal(demandLevel(ex({ level: 'expert', mechanic: 'isolation' }), 'other', ['dumbbell']), 3);
    assert.equal(demandLevel(ex({ name: 'Deadlift' }), 'hinge', ['barbell']), 3);
    assert.equal(demandLevel(ex({ name: 'Clap Push Up' }), 'horizontal_push', ['bodyweight']), 3);
    assert.equal(demandLevel(ex({ mechanic: 'isolation' }), 'other', ['dumbbell']), 1);
    assert.equal(demandLevel(ex({ mechanic: null }), 'core', ['bodyweight']), 1);
    assert.equal(demandLevel(ex({ level: 'intermediate', primaryMuscles: ['neck'] }), 'other', ['weight_plate']), 1);
    assert.equal(demandLevel(ex({ level: 'intermediate' }), 'horizontal_push', ['dumbbell']), 2);
  });

  test('micro_ok needs home-friendly quick gear, demand ≤ 2 and no partner or wall', () => {
    const base = ex({ name: 'Push-Up' });
    assert.equal(microOk(base, 'both', 2, ['bodyweight'], 'horizontal_push'), true);
    assert.equal(microOk(base, 'gym', 2, ['bodyweight'], 'horizontal_push'), false);
    assert.equal(microOk(base, 'both', 3, ['bodyweight'], 'horizontal_push'), false);
    assert.equal(microOk(base, 'both', 2, ['medicine_ball'], 'horizontal_push'), false);
    assert.equal(microOk(ex({ name: 'Partner Push-Up' }), 'both', 2, ['bodyweight'], 'horizontal_push'), false);
    assert.equal(microOk(ex({ name: 'Calf Stretch' }), 'both', 1, ['foam_roller'], 'mobility'), false);
    assert.equal(microOk(ex({ level: 'expert' }), 'both', 2, ['bodyweight'], 'core'), false);
  });

  test('every mapped muscle group is a dataset muscle', () => {
    for (const row of fixture) assert.ok(MUSCLES.includes(mapExercise(row).muscle_group));
  });
});
