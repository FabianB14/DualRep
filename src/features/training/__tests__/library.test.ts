/**
 * The library view: reading synced rows defensively, the bundled starter library as the offline floor,
 * which exercises the default circuits may pick, and the library screen's filter. The hook itself is
 * a thin wrapper; it gets one test with PowerSync and auth replaced by fakes.
 */
/// <reference types="node" />
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { ExerciseRow } from '@/db/schema';

import { SETUP_TEMPLATES } from '../equipment';
import {
  BODY_REGIONS,
  EXERCISE_LEVELS,
  EXERCISE_LOCATIONS,
  EXERCISE_ORIGINS,
  eligibleForDefaultCircuits,
  eligibleLibrary,
  exerciseFromRow,
  exerciseMeasure,
  filterLibrary,
  libraryView,
  mergeLibrary,
  MOVEMENT_PATTERN_LABELS,
  MOVEMENT_PATTERNS,
  parseStringArray,
  TRAINING_CATEGORIES,
  UNNAMED_EXERCISE,
} from '../library';
import { STARTER_EXERCISES, STARTER_LIBRARY, STARTER_LIBRARY_BY_ID, type StarterExercise } from '../starterLibrary';
import type { LibraryExercise, Measure, MovementPattern } from '../types';
import { useLibrary, type UseLibraryResult } from '../useLibrary';

// useLibrary's dependencies, replaced so the hook runs without a native database or a session.
const mockQueryResult: { data: ExerciseRow[]; isLoading: boolean } = { data: [], isLoading: false };
jest.mock('@powersync/react-native', () => ({
  useQuery: jest.fn(() => mockQueryResult),
}));
jest.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-08T12:00:00.000Z';

/** A synced exercises row as PowerSync hands it over: JSON as text, booleans as 0/1. */
function row(overrides: Partial<ExerciseRow> = {}): ExerciseRow {
  return {
    id: 'd0000000-0000-4000-8000-000000000001',
    name: 'Goblet Squat',
    muscle_group: 'quadriceps',
    secondary_muscles: '["glutes","hamstrings"]',
    body_region: 'lower',
    category: 'strength',
    dataset_category: 'strength',
    equipment: '["kettlebell"]',
    location: 'both',
    movement_pattern: 'squat',
    demand_level: 2,
    level: 'beginner',
    force: 'push',
    mechanic: 'compound',
    micro_ok: 1,
    instructions: '["Hold the bell at your chest.","Squat down and stand up."]',
    images: '[]',
    origin: 'dataset',
    dataset_id: 'Goblet_Squat',
    reviewed: 1,
    owner_id: null,
    group_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as ExerciseRow;
}

/** A starter entry as the migration seeds it and PowerSync syncs it. */
function starterRow(entry: StarterExercise): ExerciseRow {
  return row({
    id: entry.id,
    name: entry.name,
    muscle_group: entry.muscleGroup,
    secondary_muscles: JSON.stringify(entry.secondaryMuscles),
    body_region: entry.bodyRegion,
    category: entry.category,
    dataset_category: null,
    equipment: JSON.stringify(entry.equipment),
    location: entry.location,
    movement_pattern: entry.movementPattern,
    demand_level: entry.demandLevel,
    level: entry.level,
    force: entry.force,
    mechanic: entry.mechanic,
    micro_ok: entry.microOk ? 1 : 0,
    instructions: JSON.stringify(entry.instructions),
    origin: 'interverse',
    dataset_id: null,
    reviewed: 1,
  });
}

/** A LibraryExercise for eligibility and filter tests. */
function exercise(overrides: Partial<LibraryExercise> = {}): LibraryExercise {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    name: 'Goblet squat',
    muscleGroup: 'quadriceps',
    secondaryMuscles: [],
    bodyRegion: 'lower',
    category: 'strength',
    equipment: ['kettlebell'],
    location: 'both',
    movementPattern: 'squat',
    demandLevel: 2,
    level: 'beginner',
    microOk: true,
    instructions: [],
    origin: 'dataset',
    reviewed: true,
    ownerId: null,
    measure: 'reps',
    ...overrides,
  };
}

describe('vocabulary', () => {
  const migration = readFileSync(
    path.resolve(__dirname, '../../../../supabase/migrations/20261008000000_initial_schema.sql'),
    'utf8',
  );
  /** The values a `check (<column> in (...))` constraint on public.exercises allows, in order. */
  function checkValues(column: string): string[] {
    const table = /create table public\.exercises \(([\s\S]*?)\n\);/.exec(migration)?.[1] ?? '';
    const match = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(table);
    if (!match) throw new Error(`No CHECK (${column} in (...)) on public.exercises`);
    return match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
  }

  it('matches the CHECK constraints on public.exercises, in the same order', () => {
    expect(MOVEMENT_PATTERNS).toEqual(checkValues('movement_pattern'));
    expect(BODY_REGIONS).toEqual(checkValues('body_region'));
    expect(TRAINING_CATEGORIES).toEqual(checkValues('category'));
    expect(EXERCISE_LOCATIONS).toEqual(checkValues('location'));
    expect(EXERCISE_LEVELS).toEqual(checkValues('level'));
    expect(EXERCISE_ORIGINS).toEqual(checkValues('origin'));
  });

  it('has a plain-word label for every movement pattern', () => {
    for (const pattern of MOVEMENT_PATTERNS) expect(MOVEMENT_PATTERN_LABELS[pattern]).toMatch(/^[A-Z][a-z ]+$/);
  });
});

describe('parseStringArray', () => {
  it.each([
    ['["a","b"]', ['a', 'b']],
    ['[]', []],
    ['["a",1,null,"",{"x":1},"b"]', ['a', 'b']],
    ['{"a":1}', []],
    ['"a"', []],
    ['not json', []],
    ['', []],
    [null, []],
    [undefined, []],
    [42, []],
    [['already', 'parsed', 3], ['already', 'parsed']],
  ])('%p → %p', (input, expected) => {
    expect(parseStringArray(input)).toEqual(expected);
  });
});

describe('exerciseFromRow', () => {
  it('parses JSON text, turns 0/1 into booleans and keeps known values', () => {
    expect(exerciseFromRow(row())).toEqual({
      id: 'd0000000-0000-4000-8000-000000000001',
      name: 'Goblet Squat',
      muscleGroup: 'quadriceps',
      secondaryMuscles: ['glutes', 'hamstrings'],
      bodyRegion: 'lower',
      category: 'strength',
      equipment: ['kettlebell'],
      location: 'both',
      movementPattern: 'squat',
      demandLevel: 2,
      level: 'beginner',
      microOk: true,
      instructions: ['Hold the bell at your chest.', 'Squat down and stand up.'],
      origin: 'dataset',
      reviewed: true,
      ownerId: null,
      measure: 'reps',
    });
  });

  it('reads every starter exercise, as the migration seeds it, exactly like the bundled copy', () => {
    for (const entry of STARTER_EXERCISES) {
      expect(exerciseFromRow(starterRow(entry))).toEqual(STARTER_LIBRARY_BY_ID.get(entry.id));
    }
  });

  it('reads unknown enumeration values as null (location as the column default, both)', () => {
    const parsed = exerciseFromRow(
      row({
        body_region: 'legs',
        category: 'yoga',
        movement_pattern: 'twist',
        level: 'pro',
        location: 'moon',
        demand_level: 4,
      }),
    );
    expect(parsed).toMatchObject({
      bodyRegion: null,
      category: null,
      movementPattern: null,
      level: null,
      location: 'both',
      demandLevel: null,
    });
  });

  it.each([0, 4, 2.5, null])('reads demand level %p as null', (demand) => {
    expect(exerciseFromRow(row({ demand_level: demand })).demandLevel).toBeNull();
  });

  it('reads bad or missing JSON as empty lists, and no equipment as bodyweight', () => {
    const parsed = exerciseFromRow(
      row({ secondary_muscles: 'oops', instructions: null, equipment: '{}', movement_pattern: 'core' }),
    );
    expect(parsed.secondaryMuscles).toEqual([]);
    expect(parsed.instructions).toEqual([]);
    expect(parsed.equipment).toEqual(['bodyweight']);
    expect(exerciseFromRow(row({ equipment: '[]' })).equipment).toEqual(['bodyweight']);
  });

  it('keeps unknown equipment items, so the exercise never fits a setup', () => {
    expect(exerciseFromRow(row({ equipment: '["kettlebell","hovercraft"]' })).equipment).toEqual([
      'kettlebell',
      'hovercraft',
    ]);
  });

  it('reads booleans: 1 is true; 0 and null are false', () => {
    expect(exerciseFromRow(row({ micro_ok: 0, reviewed: 0 }))).toMatchObject({ microOk: false, reviewed: false });
    expect(exerciseFromRow(row({ micro_ok: null, reviewed: null }))).toMatchObject({ microOk: false, reviewed: false });
    expect(exerciseFromRow(row({ micro_ok: 1, reviewed: 1 }))).toMatchObject({ microOk: true, reviewed: true });
  });

  it('trims the name and never leaves it empty; an empty muscle group is null', () => {
    expect(exerciseFromRow(row({ name: '  Goblet squat  ' })).name).toBe('Goblet squat');
    expect(exerciseFromRow(row({ name: null })).name).toBe(UNNAMED_EXERCISE);
    expect(exerciseFromRow(row({ name: '   ' })).name).toBe(UNNAMED_EXERCISE);
    expect(exerciseFromRow(row({ muscle_group: ' ' })).muscleGroup).toBeNull();
    expect(exerciseFromRow(row({ muscle_group: null })).muscleGroup).toBeNull();
  });

  it('reads a user row with its owner; an unknown origin falls back on owner_id', () => {
    const mine = row({ origin: 'user', owner_id: ME, reviewed: 0, dataset_id: null });
    expect(exerciseFromRow(mine)).toMatchObject({ origin: 'user', ownerId: ME, reviewed: false });
    expect(exerciseFromRow(row({ origin: 'alien', owner_id: ME })).origin).toBe('user');
    expect(exerciseFromRow(row({ origin: 'alien', owner_id: null })).origin).toBe('dataset');
    expect(exerciseFromRow(row({ owner_id: '' })).ownerId).toBeNull();
  });

  it('takes a synced starter row’s measure from the bundled data, whatever the row says', () => {
    const wallSit = STARTER_EXERCISES.find((entry) => entry.name === 'Wall sit');
    if (!wallSit) throw new Error('Wall sit is missing from the starter library');
    const renamed = exerciseFromRow(row({ id: wallSit.id, name: 'Renamed squat', movement_pattern: 'squat' }));
    expect(renamed.measure).toBe('time');
  });
});

describe('exerciseMeasure', () => {
  const other = { id: 'd0000000-0000-4000-8000-000000000009' };
  const cases: [string, MovementPattern | null, Measure][] = [
    ['Plank', 'core', 'time'],
    ['Side Bridge', 'core', 'time'],
    ['Hollow body hold', 'core', 'time'],
    ['Wall Sit', 'squat', 'time'],
    ['Isometric Neck Exercise - Front', 'other', 'time'],
    ['Dead hang', 'vertical_pull', 'time'],
    ["Farmer's Walk", 'carry', 'time'],
    ['Rope Jumping', 'conditioning', 'time'],
    ['Hamstring Stretch', 'mobility', 'time'],
    ['Crunches', 'core', 'reps'],
    ['Barbell Squat', 'squat', 'reps'],
    ['Hang Clean', 'hinge', 'reps'],
    ['Walking Lunge', 'lunge', 'reps'],
    ['Hanging Leg Raise', 'core', 'reps'],
    ['Something new', null, 'reps'],
  ];
  it.each(cases)('%s (%s) → %s', (name, movementPattern, measure) => {
    expect(exerciseMeasure({ ...other, name, movementPattern })).toBe(measure);
  });

  it('counts conditioning and mobility categories as timed even without a pattern', () => {
    expect(exerciseMeasure({ ...other, name: 'Thing', movementPattern: null, category: 'conditioning' })).toBe('time');
    expect(exerciseMeasure({ ...other, name: 'Thing', movementPattern: null, category: 'mobility' })).toBe('time');
    expect(exerciseMeasure({ ...other, name: 'Thing', movementPattern: null, category: 'strength' })).toBe('reps');
  });

  it('uses the bundled measure for every starter id', () => {
    for (const entry of STARTER_EXERCISES) {
      expect(exerciseMeasure({ id: entry.id, name: 'x', movementPattern: null })).toBe(entry.measure);
    }
  });

  it('agrees with the bundled measure for every starter exercise judged by its name and pattern alone', () => {
    // The heuristic is what a dataset or user row gets; on the hand-labelled starter data it is exact.
    for (const entry of STARTER_EXERCISES) {
      const judged = exerciseMeasure({ ...other, name: entry.name, movementPattern: entry.movementPattern });
      expect([entry.name, judged]).toEqual([entry.name, entry.measure]);
    }
  });
});

describe('mergeLibrary', () => {
  const synced = [
    exercise({ id: 'd0000000-0000-4000-8000-000000000002', name: 'Zercher squat' }),
    exercise({ id: 'd0000000-0000-4000-8000-000000000001', name: 'arnold press', movementPattern: 'vertical_push' }),
  ];

  it('is the union of synced rows and starter rows, sorted by name without case', () => {
    const merged = mergeLibrary(synced);
    expect(merged).toHaveLength(STARTER_LIBRARY.length + 2);
    const names = merged.map((entry) => entry.name.toLowerCase());
    expect(names).toEqual([...names].sort());
    expect(merged[0].name).toBe('arnold press');
    expect(merged.at(-1)?.name).toBe('Zercher squat');
    expect(new Set(merged.map((entry) => entry.id)).size).toBe(merged.length);
  });

  it('lets a synced row win over the bundled copy, keeping the bundled measure', () => {
    const plank = STARTER_LIBRARY.find((entry) => entry.name === 'Plank');
    if (!plank) throw new Error('Plank is missing from the starter library');
    const corrected = { ...plank, name: 'Front plank', microOk: false, measure: 'reps' as const };
    const merged = mergeLibrary([corrected]);
    const found = merged.filter((entry) => entry.id === plank.id);
    expect(found).toEqual([{ ...corrected, measure: 'time' }]);
  });

  it('uses the given starter list and never changes its inputs', () => {
    const starter = [exercise({ id: 's1', name: 'B' }), exercise({ id: 's2', name: 'A' })];
    const before = JSON.stringify([synced, starter]);
    const merged = mergeLibrary(synced, starter);
    expect(merged.map((entry) => entry.id)).toEqual([
      's2',
      'd0000000-0000-4000-8000-000000000001',
      's1',
      'd0000000-0000-4000-8000-000000000002',
    ]);
    expect(JSON.stringify([synced, starter])).toBe(before);
  });

  it('breaks name ties by id, so the order never depends on the input order', () => {
    const a = exercise({ id: 'b', name: 'Same' });
    const b = exercise({ id: 'a', name: 'same' });
    expect(mergeLibrary([a, b], []).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(mergeLibrary([b, a], []).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('is just the starter library before the first sync', () => {
    const merged = mergeLibrary([]);
    expect(new Set(merged.map((entry) => entry.id))).toEqual(new Set(STARTER_LIBRARY.map((entry) => entry.id)));
    expect(merged.every((entry) => entry.reviewed)).toBe(true);
  });

  it('once the server’s starter rows have synced, a bundled one it no longer sends is kept but withdrawn', () => {
    // A curator set reviewed = false on Chair squat (or deleted it): the library stream stops sending it.
    const chairSquat = STARTER_LIBRARY.find((entry) => entry.name === 'Chair squat');
    if (!chairSquat) throw new Error('Chair squat is missing from the starter library');
    const fromServer = STARTER_EXERCISES.filter((entry) => entry.id !== chairSquat.id).map((entry) =>
      exerciseFromRow(starterRow(entry)),
    );
    const merged = mergeLibrary(fromServer);
    expect(merged).toHaveLength(STARTER_LIBRARY.length);
    // Still there for its name and measure in history, but no longer reviewed.
    expect(merged.find((entry) => entry.id === chairSquat.id)).toEqual({ ...chairSquat, reviewed: false });
    expect(merged.filter((entry) => !entry.reviewed).map((entry) => entry.id)).toEqual([chairSquat.id]);
    // Dataset rows alone do not say anything about the starter list.
    expect(mergeLibrary(synced).every((entry) => entry.reviewed)).toBe(true);
  });
});

describe('eligibleForDefaultCircuits', () => {
  const mine = { origin: 'user' as const, ownerId: ME, reviewed: false };
  const cases: [string, boolean, LibraryExercise][] = [
    ['a reviewed dataset row', true, exercise()],
    ['an unreviewed dataset row', false, exercise({ reviewed: false })],
    ['a reviewed dataset row without micro_ok (full sessions may use it)', true, exercise({ microOk: false })],
    ['a bundled starter exercise', true, STARTER_LIBRARY[0]],
    ['a starter row the server withdrew (unreviewed)', false, { ...STARTER_LIBRARY[0], reviewed: false }],
    ['my own complete, micro-ok exercise', true, exercise(mine)],
    ['my own exercise without a movement pattern', false, exercise({ ...mine, movementPattern: null })],
    ['my own exercise without a body region', false, exercise({ ...mine, bodyRegion: null })],
    ['my own exercise not marked micro-ok', false, exercise({ ...mine, microOk: false })],
    ["a group mate's exercise", false, exercise({ ...mine, ownerId: FRIEND })],
  ];
  it.each(cases)('%s → %s', (_label, expected, candidate) => {
    expect(eligibleForDefaultCircuits(candidate, ME)).toBe(expected);
  });

  it('never picks user exercises when nobody is signed in', () => {
    expect(eligibleForDefaultCircuits(exercise(mine), null)).toBe(false);
    expect(eligibleForDefaultCircuits(exercise(), null)).toBe(true);
  });

  it('eligibleLibrary keeps the eligible ones in their order', () => {
    const list = [exercise({ id: '1' }), exercise({ id: '2', reviewed: false }), exercise({ id: '3', ...mine })];
    expect(eligibleLibrary(list, ME).map((entry) => entry.id)).toEqual(['1', '3']);
  });
});

describe('libraryView', () => {
  const rows = [
    row(),
    row({ id: 'd0000000-0000-4000-8000-000000000002', name: 'Unreviewed curl', reviewed: 0 }),
    row({ id: 'u1', name: 'My band squat', origin: 'user', owner_id: ME, reviewed: 0, dataset_id: null }),
    row({ id: 'u2', name: 'Friend squat', origin: 'user', owner_id: FRIEND, reviewed: 0, dataset_id: null }),
    // The library stream sends the whole starter list at once.
    ...STARTER_EXERCISES.map(starterRow),
  ];

  it('merges the rows with the starter library and indexes them', () => {
    const view = libraryView(rows, ME);
    expect(view.exercises).toHaveLength(STARTER_LIBRARY.length + 4);
    expect(view.byId.size).toBe(view.exercises.length);
    expect(view.byId.get('u2')?.name).toBe('Friend squat');
  });

  it('gives the circuits only what they may pick', () => {
    const pool = libraryView(rows, ME).circuitPool.map((entry) => entry.id);
    expect(pool).toContain('d0000000-0000-4000-8000-000000000001');
    expect(pool).toContain('u1');
    expect(pool).not.toContain('u2');
    expect(pool).not.toContain('d0000000-0000-4000-8000-000000000002');
    expect(pool).toHaveLength(STARTER_LIBRARY.length + 2);
  });

  it('stops offering a starter exercise the server withdrew, in circuits and swaps, but still knows it by id', () => {
    const withdrawn = STARTER_EXERCISES[0].id;
    const view = libraryView(
      rows.filter((entry) => entry.id !== withdrawn),
      ME,
    );
    expect(view.circuitPool.map((entry) => entry.id)).not.toContain(withdrawn);
    expect(view.circuitPool).toHaveLength(STARTER_LIBRARY.length + 1);
    expect(view.byId.get(withdrawn)).toMatchObject({ name: STARTER_EXERCISES[0].name, reviewed: false });
  });
});

describe('filterLibrary', () => {
  const list = [
    exercise({ id: '1', name: 'Goblet squat', muscleGroup: 'quadriceps' }),
    exercise({
      id: '2',
      name: 'Barbell row',
      muscleGroup: 'middle back',
      movementPattern: 'horizontal_pull',
      equipment: ['barbell'],
      location: 'gym',
    }),
    exercise({ id: '3', name: 'Chair squat', muscleGroup: 'quadriceps', equipment: ['bodyweight'], location: 'home' }),
  ];
  const ids = (found: LibraryExercise[]) => found.map((entry) => entry.id);

  it('returns everything with an empty filter', () => {
    expect(ids(filterLibrary(list, {}))).toEqual(['1', '2', '3']);
    expect(ids(filterLibrary(list, { query: '   ', pattern: null, setup: null }))).toEqual(['1', '2', '3']);
  });

  it('finds every word of the query in the name or the muscle group, ignoring case', () => {
    expect(ids(filterLibrary(list, { query: 'SQUAT' }))).toEqual(['1', '3']);
    expect(ids(filterLibrary(list, { query: 'squat chair' }))).toEqual(['3']);
    expect(ids(filterLibrary(list, { query: 'back' }))).toEqual(['2']);
    expect(ids(filterLibrary(list, { query: 'quad' }))).toEqual(['1', '3']);
    expect(ids(filterLibrary(list, { query: 'zzz' }))).toEqual([]);
  });

  it('filters by pattern and by "fits my setup"', () => {
    expect(ids(filterLibrary(list, { pattern: 'horizontal_pull' }))).toEqual(['2']);
    expect(ids(filterLibrary(list, { setup: SETUP_TEMPLATES.home_bodyweight }))).toEqual(['3']);
    expect(ids(filterLibrary(list, { setup: SETUP_TEMPLATES.gym }))).toEqual(['1', '2']);
    expect(ids(filterLibrary(list, { setup: SETUP_TEMPLATES.gym, query: 'squat', pattern: 'squat' }))).toEqual(['1']);
  });
});

describe('useLibrary', () => {
  function renderHook(): UseLibraryResult {
    const seen: UseLibraryResult[] = [];
    function Probe() {
      seen.push(useLibrary());
      return null;
    }
    act(() => {
      create(createElement(Probe));
    });
    const last = seen.at(-1);
    if (!last) throw new Error('useLibrary did not render');
    return last;
  }

  it('reads every exercises row and merges it with the starter library for the signed-in user', () => {
    const powersync = jest.requireMock('@powersync/react-native') as { useQuery: jest.Mock };
    mockQueryResult.data = [row(), row({ id: 'u1', origin: 'user', owner_id: ME, reviewed: 0, dataset_id: null })];
    mockQueryResult.isLoading = false;
    const result = renderHook();
    expect(powersync.useQuery).toHaveBeenCalledWith('SELECT * FROM exercises');
    expect(result.isLoading).toBe(false);
    expect(result.exercises).toHaveLength(STARTER_LIBRARY.length + 2);
    expect(result.circuitPool.map((entry) => entry.id)).toContain('u1');
  });

  it('already has the starter library while the first read is still loading', () => {
    mockQueryResult.data = [];
    mockQueryResult.isLoading = true;
    const result = renderHook();
    expect(result.isLoading).toBe(true);
    expect(result.exercises).toHaveLength(STARTER_LIBRARY.length);
    expect(result.circuitPool).toHaveLength(STARTER_LIBRARY.length);
  });
});
