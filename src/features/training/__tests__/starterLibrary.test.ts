/**
 * @jest-environment node
 *
 * (The node environment gives the test child_process, to run the migration generator's --check.)
 *
 * The starter library is the circuit builder's guaranteed floor: with it alone, every setup must be
 * able to fill a micro circuit. These tests hold the data to the vocabulary of the first migration's
 * CHECK constraints (parsed from the migration itself), the curation rules in starterLibraryData.ts,
 * and the coverage the circuit builder relies on.
 */
/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EQUIPMENT, GYM_ONLY_EQUIPMENT, SETUP_TEMPLATES, fitsSetup, isEquipment } from '../equipment';
import {
  MUSCLE_GROUPS,
  STARTER_EXERCISES,
  STARTER_ID_PREFIX,
  STARTER_LIBRARY,
  STARTER_LIBRARY_BY_ID,
  STARTER_MEASURE,
  isStarterExerciseId,
  starterMeasure,
  starterToLibraryExercise,
  type StarterExercise,
} from '../starterLibrary';
import type { MovementPattern, SetupLocation } from '../types';

const repoRoot = path.resolve(__dirname, '../../../..');
const initialMigration = readFileSync(
  path.join(repoRoot, 'supabase/migrations/20261008000000_initial_schema.sql'),
  'utf8',
);

/** The values a `<column> text ... check (<column> in (...))` constraint on public.exercises allows. */
function checkValues(column: string): string[] {
  const table = /create table public\.exercises \(([\s\S]*?)\n\);/.exec(initialMigration)?.[1];
  if (!table) throw new Error('public.exercises not found in the initial migration');
  const match = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(table);
  if (!match) throw new Error(`No CHECK (${column} in (...)) on public.exercises`);
  return match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
}

const GYM_ONLY = new Set<string>(GYM_ONLY_EQUIPMENT);
const LOWER_MUSCLES = new Set(['quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors']);
const UPPER_MUSCLES = new Set([
  'chest',
  'shoulders',
  'triceps',
  'biceps',
  'forearms',
  'lats',
  'middle back',
  'traps',
  'neck',
]);
const STRENGTH_PATTERNS: MovementPattern[] = [
  'squat',
  'hinge',
  'lunge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
];

/** Body region by the research rules (§A6): conditioning is cardio, a carry is full body, else by muscle. */
function expectedRegion(entry: StarterExercise): StarterExercise['bodyRegion'] {
  if (entry.movementPattern === 'conditioning') return 'cardio';
  if (entry.movementPattern === 'carry') return 'full';
  if (entry.muscleGroup === 'lower back') return entry.movementPattern === 'hinge' ? 'lower' : 'core';
  if (entry.muscleGroup === 'abdominals') return 'core';
  if (LOWER_MUSCLES.has(entry.muscleGroup)) return 'lower';
  if (UPPER_MUSCLES.has(entry.muscleGroup)) return 'upper';
  throw new Error(`No region rule for ${entry.muscleGroup}`);
}

/** What the micro circuit builder may pick for a setup: micro-ok, demand 1–2, fits the setup. */
function microFor(setup: { location: SetupLocation; equipment: readonly string[] }) {
  return STARTER_LIBRARY.filter((ex) => ex.microOk && (ex.demandLevel ?? 3) <= 2 && fitsSetup(ex, setup));
}

function countByPattern(exercises: readonly { movementPattern: MovementPattern | null }[]) {
  const counts = new Map<MovementPattern | null, number>();
  for (const ex of exercises) counts.set(ex.movementPattern, (counts.get(ex.movementPattern) ?? 0) + 1);
  return (pattern: MovementPattern) => counts.get(pattern) ?? 0;
}

const byName = new Map(STARTER_EXERCISES.map((entry) => [entry.name, entry]));
const each = STARTER_EXERCISES.map((entry) => [entry.name, entry] as const);

describe('starter library: ids and names', () => {
  it('has roughly 70–90 exercises', () => {
    expect(STARTER_EXERCISES.length).toBeGreaterThanOrEqual(70);
    expect(STARTER_EXERCISES.length).toBeLessThanOrEqual(100);
  });

  it('uses unique ids in the reserved range 00000000-0000-4000-8000-0000000eXXXX', () => {
    const ids = STARTER_EXERCISES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^00000000-0000-4000-8000-0000000e[0-9a-f]{4}$/);
      expect(id.startsWith(STARTER_ID_PREFIX)).toBe(true);
      expect(id.endsWith('0000')).toBe(false);
    }
  });

  it('has unique, trimmed, sentence-case names', () => {
    const names = STARTER_EXERCISES.map((entry) => entry.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const { name } of STARTER_EXERCISES) {
      expect(name).toBe(name.trim());
      expect(name).not.toMatch(/\s{2}/);
      expect(name[0]).toBe(name[0].toUpperCase());
    }
  });
});

describe.each(each)('%s', (_name, entry) => {
  it('uses the database vocabulary', () => {
    expect(MUSCLE_GROUPS).toContain(entry.muscleGroup);
    expect(checkValues('body_region')).toContain(entry.bodyRegion);
    expect(checkValues('category')).toContain(entry.category);
    expect(checkValues('location')).toContain(entry.location);
    expect(checkValues('movement_pattern')).toContain(entry.movementPattern);
    expect(checkValues('level')).toContain(entry.level);
    expect([1, 2, 3]).toContain(entry.demandLevel);
    if (entry.force !== null) expect(checkValues('force')).toContain(entry.force);
    if (entry.mechanic !== null) expect(checkValues('mechanic')).toContain(entry.mechanic);
    expect(['reps', 'time']).toContain(entry.measure);
    expect(typeof entry.microOk).toBe('boolean');
  });

  it('lists distinct secondary muscles other than the primary one', () => {
    for (const muscle of entry.secondaryMuscles) expect(MUSCLE_GROUPS).toContain(muscle);
    expect(new Set(entry.secondaryMuscles).size).toBe(entry.secondaryMuscles.length);
    expect(entry.secondaryMuscles).not.toContain(entry.muscleGroup);
  });

  it('needs known equipment: just bodyweight, or only real items, in vocabulary order', () => {
    expect(entry.equipment.length).toBeGreaterThan(0);
    for (const item of entry.equipment) expect(isEquipment(item)).toBe(true);
    expect(entry.equipment).not.toContain('other');
    if (entry.equipment.includes('bodyweight')) expect(entry.equipment).toEqual(['bodyweight']);
    expect([...entry.equipment]).toEqual(EQUIPMENT.filter((item) => entry.equipment.includes(item)));
  });

  it('has a location that matches its equipment', () => {
    const needsGym = entry.equipment.some((item) => GYM_ONLY.has(item));
    if (needsGym) expect(entry.location).toBe('gym');
    else expect(['both', 'home']).toContain(entry.location);
    // 'home' is only for desk-side originals that need furniture rather than equipment.
    if (entry.location === 'home') expect(entry.equipment).toEqual(['bodyweight']);
  });

  it('has the body region and category its pattern and muscle imply', () => {
    expect(entry.bodyRegion).toBe(expectedRegion(entry));
    expect(entry.category === 'conditioning').toBe(entry.movementPattern === 'conditioning');
    expect(entry.category === 'mobility').toBe(entry.movementPattern === 'mobility');
  });

  it('is measured in time for holds, carries, conditioning and mobility, else in reps', () => {
    const timed = ['conditioning', 'mobility', 'carry'].includes(entry.movementPattern);
    if (timed) expect(entry.measure).toBe('time');
    if (entry.measure === 'time') expect(timed || entry.force === 'static').toBe(true);
  });

  it('has a demand level that matches how heavy it is', () => {
    if (entry.movementPattern === 'mobility') expect(entry.demandLevel).toBe(1);
    // Heavy barbell lifts (§A6 demand rule 4, plus the bent-over row) are demand 3.
    if (entry.equipment.includes('barbell') && entry.mechanic === 'compound') expect(entry.demandLevel).toBe(3);
    if (entry.microOk) {
      expect(entry.demandLevel).toBeLessThanOrEqual(2);
      expect(entry.level).not.toBe('expert');
    }
    if (entry.demandLevel === 3) expect(entry.microOk).toBe(false);
  });

  it('has 2 to 4 short instruction steps written as sentences', () => {
    expect(entry.instructions.length).toBeGreaterThanOrEqual(2);
    expect(entry.instructions.length).toBeLessThanOrEqual(4);
    for (const step of entry.instructions) {
      expect(step).toBe(step.trim());
      expect(step.length).toBeLessThanOrEqual(110);
      expect(step).toMatch(/^[A-Z].*[.!]$/);
      expect(step).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(new Set(entry.instructions).size).toBe(entry.instructions.length);
  });
});

describe('starter library: coverage the circuit builder relies on', () => {
  const homeBodyweight = microFor(SETUP_TEMPLATES.home_bodyweight);
  const homeBasic = microFor(SETUP_TEMPLATES.home_basic);
  const gym = microFor(SETUP_TEMPLATES.gym);

  it('home with no equipment: every pattern, plenty of core, conditioning and mobility', () => {
    expect(homeBodyweight.every((ex) => ex.equipment.join() === 'bodyweight')).toBe(true);
    const count = countByPattern(homeBodyweight);
    // [pattern, ok] pairs, so a failure names the pattern.
    for (const pattern of STRENGTH_PATTERNS) expect([pattern, count(pattern) >= 2]).toEqual([pattern, true]);
    expect(count('core')).toBeGreaterThanOrEqual(4);
    expect(count('conditioning')).toBeGreaterThanOrEqual(5);
    expect(count('mobility')).toBeGreaterThanOrEqual(3);
  });

  it('home with no equipment: conditioning includes low-impact options, not only jumping', () => {
    const conditioning = homeBodyweight.filter((ex) => ex.movementPattern === 'conditioning').map((ex) => ex.name);
    expect(conditioning).toEqual(
      expect.arrayContaining(['High-knee march', 'Step jack', 'Shadow boxing', 'Skater step']),
    );
  });

  it('home with no equipment: upper-body pulls without a bar', () => {
    const pulls = homeBodyweight
      .filter((ex) => ex.movementPattern === 'horizontal_pull' || ex.movementPattern === 'vertical_pull')
      .map((ex) => ex.name);
    expect(pulls).toEqual(
      expect.arrayContaining(['Doorframe row', 'Prone Y-T raise', 'Superman pull', 'Towel lat pulldown']),
    );
  });

  it('includes the desk-side originals, all home-only and micro-ok', () => {
    for (const name of ['Chair squat', 'Desk push-up', 'Seated knee raise', 'Standing calf raise', 'Wall sit']) {
      expect(byName.get(name)).toMatchObject({ location: 'home', equipment: ['bodyweight'], microOk: true });
    }
  });

  it('home equipment (dumbbells, kettlebell, bands, pull-up bar) covers every pattern', () => {
    const homeGear = STARTER_EXERCISES.filter(
      (entry) => entry.location === 'both' && !entry.equipment.includes('bodyweight') && entry.microOk,
    );
    const count = countByPattern(homeGear);
    for (const pattern of [...STRENGTH_PATTERNS, 'core', 'carry', 'conditioning'] as const) {
      expect([pattern, count(pattern) >= 1]).toEqual([pattern, true]);
    }
    for (const item of ['dumbbell', 'kettlebell', 'band', 'pull_up_bar']) {
      expect(homeGear.some((entry) => entry.equipment.includes(item))).toBe(true);
    }
  });

  const TEMPLATES = ['home_bodyweight', 'home_basic', 'gym'] as const;
  it.each(TEMPLATES)('%s template: enough micro options for every pattern and region', (template) => {
    const options = microFor(SETUP_TEMPLATES[template]);
    const count = countByPattern(options);
    for (const pattern of STRENGTH_PATTERNS) expect([pattern, count(pattern) >= 2]).toEqual([pattern, true]);
    expect(count('core')).toBeGreaterThanOrEqual(4);
    expect(count('conditioning')).toBeGreaterThanOrEqual(5);
    // "Mostly cardio" puts up to 5 of 6 stations in the cardio region.
    expect(options.filter((ex) => ex.bodyRegion === 'cardio').length).toBeGreaterThanOrEqual(5);
    for (const region of ['lower', 'upper', 'core'] as const) {
      expect(options.filter((ex) => ex.bodyRegion === region).length).toBeGreaterThanOrEqual(6);
    }
  });

  it('home setups never get gym-only exercises, gym setups never get desk-side ones', () => {
    expect([...homeBodyweight, ...homeBasic].some((ex) => ex.location === 'gym')).toBe(false);
    expect(gym.some((ex) => ex.location === 'home')).toBe(false);
  });

  it('has the gym staples, heavy barbell lifts as demand 3 and never micro', () => {
    const heavy = [
      'Barbell back squat',
      'Barbell front squat',
      'Barbell deadlift',
      'Barbell Romanian deadlift',
      'Barbell hip thrust',
      'Barbell bench press',
      'Barbell overhead press',
      'Barbell row',
    ];
    for (const name of heavy) {
      expect(byName.get(name)).toMatchObject({ location: 'gym', demandLevel: 3, microOk: false });
    }
    const staples = [
      'Incline dumbbell press',
      'Pull-up',
      'Lat pulldown',
      'Seated cable row',
      'Leg press',
      'Leg curl',
      'Leg extension',
      'Cable face pull',
      'Machine chest press',
      'Dip',
      'Rower intervals',
      'Bike intervals',
      'Treadmill intervals',
      'Farmer carry',
    ];
    for (const name of staples) expect([name, byName.has(name)]).toEqual([name, true]);
    for (const name of ['Rower intervals', 'Bike intervals', 'Treadmill intervals']) {
      expect(byName.get(name)).toMatchObject({ equipment: ['cardio_machine'], movementPattern: 'conditioning' });
    }
  });
});

describe('starter library: app view', () => {
  it('turns every entry into a reviewed Interverse LibraryExercise with its measure', () => {
    expect(STARTER_LIBRARY).toHaveLength(STARTER_EXERCISES.length);
    STARTER_LIBRARY.forEach((exercise, index) => {
      const entry = STARTER_EXERCISES[index];
      expect(exercise).toEqual({
        id: entry.id,
        name: entry.name,
        muscleGroup: entry.muscleGroup,
        secondaryMuscles: entry.secondaryMuscles,
        bodyRegion: entry.bodyRegion,
        category: entry.category,
        equipment: entry.equipment,
        location: entry.location,
        movementPattern: entry.movementPattern,
        demandLevel: entry.demandLevel,
        level: entry.level,
        microOk: entry.microOk,
        instructions: entry.instructions,
        origin: 'interverse',
        reviewed: true,
        ownerId: null,
        measure: entry.measure,
      });
    });
  });

  it('copies arrays, so changing a converted exercise never changes the data', () => {
    const copy = starterToLibraryExercise(STARTER_EXERCISES[0]);
    copy.equipment.push('dumbbell');
    copy.instructions.length = 0;
    expect(STARTER_EXERCISES[0].equipment).toEqual(['bodyweight']);
    expect(STARTER_EXERCISES[0].instructions.length).toBeGreaterThan(0);
  });

  it('looks up exercises and measures by id', () => {
    for (const entry of STARTER_EXERCISES) {
      expect(STARTER_LIBRARY_BY_ID.get(entry.id)?.name).toBe(entry.name);
      expect(STARTER_MEASURE[entry.id]).toBe(entry.measure);
      expect(starterMeasure(entry.id)).toBe(entry.measure);
    }
    expect(Object.keys(STARTER_MEASURE)).toHaveLength(STARTER_EXERCISES.length);
    expect(starterMeasure('b0000000-0000-4000-8000-000000000001')).toBeUndefined();
    expect(starterMeasure('toString')).toBeUndefined();
    expect(starterMeasure('__proto__')).toBeUndefined();
    expect(Object.isFrozen(STARTER_MEASURE)).toBe(true);
  });

  it('recognizes the reserved id range', () => {
    expect(isStarterExerciseId('00000000-0000-4000-8000-0000000e0001')).toBe(true);
    expect(isStarterExerciseId('00000000-0000-4000-8000-0000000effff')).toBe(true);
    expect(isStarterExerciseId('00000000-0000-4000-8000-0000000E0001')).toBe(false);
    expect(isStarterExerciseId('00000000-0000-4000-8000-0000000000a1')).toBe(false);
    expect(isStarterExerciseId('00000000-0000-4000-8000-0000000e00011')).toBe(false);
    expect(isStarterExerciseId('x00000000-0000-4000-8000-0000000e0001')).toBe(false);
  });
});

describe('starter library: migration', () => {
  it('supabase/migrations/20261008120000_starter_library.sql is up to date with the data', () => {
    const script = path.join(repoRoot, 'scripts/library/starter-library-sql.mjs');
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
