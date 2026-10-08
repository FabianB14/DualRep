/// <reference types="node" />
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ExerciseRow } from '@/db/schema';
import { buildDefaultCircuit } from '@/features/training/circuits';
import { eligibleForDefaultCircuits, exerciseFromRow, mergeLibrary } from '@/features/training/library';

import type { SqliteDb } from '../../history/testing/sqliteDb';
import {
  categoryFor,
  DEFAULT_REGION,
  draftMeasure,
  draftRegion,
  emptyExerciseDraft,
  EXERCISE_NAME_MAX,
  exerciseDraftErrors,
  exerciseInsert,
  locationFor,
  MAX_STEPS,
  parseSteps,
  type ExerciseDraft,
} from '../customExercise';
import { createUserExercise, deleteUserExercise } from '../customExerciseRepo';

jest.mock('../../../db/database', () => ({
  db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
}));
const mockDb = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;
jest.mock('../../../lib/ids', () => ({
  newId: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const ID = '44444444-4444-4444-8444-444444444444';
const T0 = Date.UTC(2026, 9, 8, 9, 30, 0, 250);
const ISO = '2026-10-08T09:30:00.250Z';

const draft = (patch: Partial<ExerciseDraft> = {}): ExerciseDraft => ({
  ...emptyExerciseDraft(),
  name: 'Stair step-up',
  pattern: 'lunge',
  ...patch,
});

beforeEach(() => mockDb.reset());

describe('draft rules', () => {
  it('starts empty and asks for a name and a kind of movement', () => {
    const empty = emptyExerciseDraft();
    expect(exerciseDraftErrors(empty)).toEqual({
      name: 'Give it a name.',
      pattern: 'Pick the kind of movement.',
      region: 'Pick the part of the body it works.',
    });
    expect(exerciseDraftErrors(draft())).toEqual({});
    expect(exerciseDraftErrors(draft({ name: 'x'.repeat(EXERCISE_NAME_MAX + 1) })).name).toMatch(/80/);
  });

  it('takes the region from the pattern unless the user picked one; "other" needs a pick', () => {
    expect(draftRegion({ pattern: 'squat', region: null })).toBe('lower');
    expect(draftRegion({ pattern: 'squat', region: 'full' })).toBe('full');
    expect(draftRegion({ pattern: 'other', region: null })).toBeNull();
    expect(exerciseDraftErrors(draft({ pattern: 'other' })).region).toBeDefined();
    expect(exerciseDraftErrors(draft({ pattern: 'other', region: 'upper' }))).toEqual({});
    for (const region of Object.values(DEFAULT_REGION)) {
      if (region !== null) expect(['lower', 'upper', 'core', 'full', 'cardio']).toContain(region);
    }
  });

  it('derives the category, the location and how sets are counted', () => {
    expect(categoryFor('conditioning')).toBe('conditioning');
    expect(categoryFor('mobility')).toBe('mobility');
    expect(categoryFor('squat')).toBe('strength');
    expect(categoryFor(null)).toBe('strength');
    expect(locationFor([], 'both')).toBe('both');
    expect(locationFor(['dumbbell'], 'home')).toBe('home');
    expect(locationFor(['dumbbell', 'cable'], 'home')).toBe('gym');
    expect(draftMeasure({ name: 'Stair step-up', pattern: 'lunge' })).toBe('reps');
    expect(draftMeasure({ name: 'Shadow boxing', pattern: 'conditioning' })).toBe('time');
    expect(draftMeasure({ name: 'Hollow hold', pattern: 'core' })).toBe('time');
    expect(draftMeasure({ name: 'Crunch', pattern: 'core' })).toBe('reps');
  });

  it('reads instruction steps one per line, without list markers', () => {
    expect(parseSteps(' 1. Stand tall\n\n- Step up\r\n2) Step down \n• Repeat ')).toEqual([
      'Stand tall',
      'Step up',
      'Step down',
      'Repeat',
    ]);
    expect(parseSteps('')).toEqual([]);
    expect(parseSteps(Array.from({ length: 12 }, (_, i) => `Step ${i}`).join('\n'))).toHaveLength(MAX_STEPS);
    expect(parseSteps('x'.repeat(400))[0]).toHaveLength(300);
  });
});

describe('exerciseInsert', () => {
  it('writes a user row the server accepts', () => {
    const { sql, params } = exerciseInsert(USER, draft({ equipment: ['band', 'dumbbell'], muscleGroup: 'glutes' }), ID, T0);
    expect(sql).toMatch(/^INSERT INTO exercises \(id, name, /);
    const row = Object.fromEntries(
      sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(', ')
        .map((column, index) => [column, params[index]]),
    );
    expect(row).toEqual({
      id: ID,
      name: 'Stair step-up',
      muscle_group: 'glutes',
      secondary_muscles: '[]',
      body_region: 'lower',
      category: 'strength',
      equipment: '["dumbbell","band"]',
      location: 'both',
      movement_pattern: 'lunge',
      demand_level: 2,
      micro_ok: 1,
      instructions: '[]',
      images: '[]',
      origin: 'user',
      reviewed: 0,
      owner_id: USER,
      created_at: ISO,
      updated_at: ISO,
    });
    // Never a dataset id or a group: those columns are not written at all.
    expect(sql).not.toMatch(/\b(dataset_id|group_id|level|force|mechanic)\b/);
  });

  it('stores no equipment as bodyweight, and refuses bad drafts', () => {
    const { params } = exerciseInsert(USER, draft(), ID, T0);
    expect(params).toContain('["bodyweight"]');
    expect(() => exerciseInsert(USER, draft({ name: ' ' }), ID, T0)).toThrow(RangeError);
    expect(() => exerciseInsert(USER, draft({ pattern: null }), ID, T0)).toThrow(RangeError);
    expect(() => exerciseInsert(USER, draft({ demand: 4 as never }), ID, T0)).toThrow(RangeError);
    expect(() => exerciseInsert(USER, draft(), ID, Number.NaN)).toThrow(RangeError);
  });
});

describe('customExerciseRepo', () => {
  it('saves an exercise the library and the default circuits can use at once', async () => {
    const id = await createUserExercise(USER, draft({ name: 'Backpack squat', pattern: 'squat', steps: 'Hold the bag\nSquat' }), {
      nowMs: T0,
      id: ID,
    });
    expect(id).toBe(ID);
    const rows = mockDb.rows('exercises') as unknown as ExerciseRow[];
    expect(rows).toHaveLength(1);
    const exercise = exerciseFromRow(rows[0]);
    expect(exercise).toMatchObject({
      id: ID,
      name: 'Backpack squat',
      origin: 'user',
      ownerId: USER,
      reviewed: false,
      movementPattern: 'squat',
      bodyRegion: 'lower',
      equipment: ['bodyweight'],
      microOk: true,
      instructions: ['Hold the bag', 'Squat'],
      measure: 'reps',
    });
    expect(eligibleForDefaultCircuits(exercise, USER)).toBe(true);
    expect(eligibleForDefaultCircuits(exercise, OTHER)).toBe(false);
    // It shows up in the merged library next to the starter exercises.
    expect(mergeLibrary([exercise]).some((entry) => entry.id === ID)).toBe(true);
  });

  it('can be picked by the circuit builder', async () => {
    await createUserExercise(USER, draft({ name: 'Backpack squat', pattern: 'squat' }), { nowMs: T0, id: ID });
    const mine = exerciseFromRow((mockDb.rows('exercises') as unknown as ExerciseRow[])[0]);
    const circuit = buildDefaultCircuit({
      split: { lower: 100, upper: 0, core: 0, cardio: 0 },
      location: 'home',
      equipment: [],
      minutes: 5,
      kind: 'micro',
      library: [mine],
      variant: 0,
    });
    expect(circuit.items.map((item) => item.exerciseId)).toContain(ID);
  });

  it('deletes only the user’s own exercise', async () => {
    mockDb.seed('exercises', { id: ID, name: 'Mine', origin: 'user', owner_id: USER });
    mockDb.seed('exercises', { id: 'theirs', name: 'Theirs', origin: 'user', owner_id: OTHER });
    mockDb.seed('exercises', { id: 'library', name: 'Library', origin: 'interverse', owner_id: null });
    await deleteUserExercise(ID, USER);
    await deleteUserExercise('theirs', USER);
    await deleteUserExercise('library', USER);
    expect(mockDb.rows('exercises').map((row) => row.id)).toEqual(['library', 'theirs']);
  });
});
