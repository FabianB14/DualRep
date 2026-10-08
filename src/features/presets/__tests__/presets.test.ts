/// <reference types="node" />
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SYSTEM_PRESET_IDS } from '@/db/constants';
import { SPLIT_REGIONS, type Split } from '@/features/training/types';

import type { SqliteDb } from '../../history/testing/sqliteDb';
import {
  DEFAULT_PRESET_ID,
  describeSplit,
  isValidSplit,
  mergePresets,
  newPresetDraft,
  parseSplit,
  PRESET_NAME_MAX,
  presetDraftErrors,
  presetFromRow,
  resolvePreset,
  sameSplit,
  splitTotal,
  SYSTEM_PRESETS,
} from '../presets';
import { createPreset, deletePreset, updatePreset } from '../presetsRepo';

jest.mock('../../../db/database', () => ({
  db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
}));
const mockDb = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;
// expo-crypto is native; Node's randomUUID makes the same kind of id.
jest.mock('../../../lib/ids', () => ({
  newId: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const MINE = '33333333-3333-4333-8333-333333333333';
const T0 = Date.UTC(2026, 9, 8, 9, 30, 0, 250);
const ISO = '2026-10-08T09:30:00.250Z';

const migration = readFileSync(
  path.resolve(__dirname, '../../../../supabase/migrations/20261008000000_initial_schema.sql'),
  'utf8',
);

beforeEach(() => mockDb.reset());

function row(id: string, ownerId: string | null, name: string, split: unknown, kind = 'custom') {
  return { id, owner_id: ownerId, name, kind, split: typeof split === 'string' ? split : JSON.stringify(split) };
}

describe('SYSTEM_PRESETS', () => {
  it('are exactly the six presets the first migration seeds (ids, kinds, names, splits, order)', () => {
    const pattern = /\('([0-9a-f-]{36})', null, '([^']+)', '(\w+)',\s*'(\{[^']*\})'\)/g;
    const seeded = [...migration.matchAll(pattern)].map(([, id, name, kind, split]) => ({
      id,
      name,
      kind,
      split: JSON.parse(split) as Split,
    }));
    expect(seeded).toHaveLength(6);
    expect(SYSTEM_PRESETS.map(({ id, name, kind, split }) => ({ id, name, kind, split }))).toEqual(seeded);
    expect(SYSTEM_PRESETS.map((preset) => preset.id)).toEqual(Object.values(SYSTEM_PRESET_IDS));
    for (const preset of SYSTEM_PRESETS) {
      expect(preset.system).toBe(true);
      expect(preset.ownerId).toBeNull();
      expect(isValidSplit(preset.split)).toBe(true);
    }
    expect(DEFAULT_PRESET_ID).toBe(SYSTEM_PRESET_IDS.full_body);
  });
});

describe('isValidSplit / parseSplit', () => {
  it('accepts exactly the four keys, each 0–100, adding up to 100', () => {
    expect(isValidSplit({ lower: 25, upper: 50, core: 25, cardio: 0 })).toBe(true);
    expect(isValidSplit({ cardio: 100, core: 0, upper: 0, lower: 0 })).toBe(true);
    expect(isValidSplit({ lower: 33.5, upper: 33.5, core: 33, cardio: 0 })).toBe(true);
    for (const bad of [
      null,
      [],
      'x',
      { lower: 50, upper: 50, core: 0 },
      { lower: 50, upper: 50, core: 0, cardio: 0, legs: 0 },
      { lower: 50, upper: 40, core: 0, cardio: 0 },
      { lower: 110, upper: -10, core: 0, cardio: 0 },
      { lower: '50', upper: 50, core: 0, cardio: 0 },
      { lower: Number.NaN, upper: 100, core: 0, cardio: 0 },
    ]) {
      expect(isValidSplit(bad)).toBe(false);
    }
  });

  it('parses JSON text and objects, and rejects anything unusable', () => {
    expect(parseSplit('{"lower": 70, "upper": 15, "core": 15, "cardio": 0}')).toEqual({
      lower: 70,
      upper: 15,
      core: 15,
      cardio: 0,
    });
    expect(parseSplit({ lower: 100, upper: 0, core: 0, cardio: 0 })).toEqual({ lower: 100, upper: 0, core: 0, cardio: 0 });
    expect(parseSplit('not json')).toBeNull();
    expect(parseSplit('{"lower": 100}')).toBeNull();
    expect(parseSplit(null)).toBeNull();
  });

  it('totals and compares splits', () => {
    expect(splitTotal({ lower: 10, upper: 20, core: 30, cardio: 5 })).toBe(65);
    expect(sameSplit({ lower: 10, upper: 20, core: 30, cardio: 40 }, { lower: 10, upper: 20, core: 30, cardio: 40 })).toBe(true);
    expect(sameSplit({ lower: 10, upper: 20, core: 30, cardio: 40 }, { lower: 20, upper: 10, core: 30, cardio: 40 })).toBe(false);
  });
});

describe('presetFromRow / mergePresets', () => {
  it('reads rows defensively', () => {
    expect(presetFromRow(row(MINE, USER, '  Legs day ', { lower: 80, upper: 0, core: 20, cardio: 0 }))).toEqual({
      id: MINE,
      name: 'Legs day',
      kind: 'custom',
      split: { lower: 80, upper: 0, core: 20, cardio: 0 },
      ownerId: USER,
      system: false,
    });
    expect(presetFromRow(row(MINE, USER, 'Bad', '{"lower": 80}'))).toBeNull();
    expect(presetFromRow(row(MINE, USER, '', { lower: 100, upper: 0, core: 0, cardio: 0 }))?.name).toBe('Unnamed preset');
    expect(presetFromRow(row(MINE, USER, 'X', { lower: 100, upper: 0, core: 0, cardio: 0 }, 'mystery'))?.kind).toBe('custom');
  });

  it('has the six system presets with an empty database (before the first sync)', () => {
    const list = mergePresets([], USER);
    expect(list.system.map((preset) => preset.id)).toEqual(Object.values(SYSTEM_PRESET_IDS));
    expect(list.custom).toEqual([]);
    expect(list.all).toHaveLength(6);
    expect(list.byId.get(SYSTEM_PRESET_IDS.mostly_cardio)?.name).toBe('Mostly cardio');
  });

  it('lets a synced system row replace its bundled copy, keeps the order, and adds unknown system rows last', () => {
    const tuned = row(SYSTEM_PRESET_IDS.all_lower, null, 'All lower body', { lower: 90, upper: 0, core: 10, cardio: 0 }, 'all_lower');
    const extra = row('00000000-0000-4000-8000-0000000000a7', null, 'Athletic', { lower: 40, upper: 40, core: 10, cardio: 10 }, 'full_body');
    const list = mergePresets([extra, tuned], USER);
    expect(list.system).toHaveLength(7);
    expect(list.system[0].split).toEqual({ lower: 90, upper: 0, core: 10, cardio: 0 });
    expect(list.system[6].name).toBe('Athletic');
  });

  it('keeps only the user’s own custom presets, sorted by name', () => {
    const list = mergePresets(
      [
        row('c2', USER, 'zumba mix', { lower: 25, upper: 25, core: 25, cardio: 25 }),
        row('c1', USER, 'Arms', { lower: 0, upper: 100, core: 0, cardio: 0 }),
        row('c3', OTHER, 'Not mine', { lower: 100, upper: 0, core: 0, cardio: 0 }),
        row('c4', USER, 'Broken', '{}'),
      ],
      USER,
    );
    expect(list.custom.map((preset) => preset.name)).toEqual(['Arms', 'zumba mix']);
    expect(list.byId.has('c3')).toBe(false);
    expect(mergePresets([row('c1', USER, 'Arms', { lower: 0, upper: 100, core: 0, cardio: 0 })], null).custom).toEqual([]);
  });

  it('resolves the default preset, falling back on Full body', () => {
    const list = mergePresets([row(MINE, USER, 'Mine', { lower: 50, upper: 50, core: 0, cardio: 0 })], USER);
    expect(resolvePreset(list, MINE).id).toBe(MINE);
    expect(resolvePreset(list, SYSTEM_PRESET_IDS.all_upper).id).toBe(SYSTEM_PRESET_IDS.all_upper);
    expect(resolvePreset(list, null).id).toBe(DEFAULT_PRESET_ID);
    expect(resolvePreset(list, 'deleted').id).toBe(DEFAULT_PRESET_ID);
    expect(resolvePreset({ byId: new Map() }, null).id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('describeSplit', () => {
  it('lists the non-zero parts in region order', () => {
    expect(describeSplit({ lower: 70, upper: 15, core: 15, cardio: 0 })).toBe('Lower 70% · Upper 15% · Core 15%');
    expect(describeSplit({ lower: 0, upper: 0, core: 0, cardio: 100 })).toBe('Cardio 100%');
    expect(describeSplit({ lower: 0, upper: 0, core: 0, cardio: 0 })).toBe('Nothing chosen');
  });
});

describe('drafts', () => {
  it('start from Full body or a copy of another preset', () => {
    expect(newPresetDraft()).toEqual({ name: '', split: { lower: 25, upper: 50, core: 25, cardio: 0 } });
    const from = SYSTEM_PRESETS[1];
    const draft = newPresetDraft(from);
    expect(draft.split).toEqual(from.split);
    draft.split.lower = 0;
    expect(from.split.lower).toBe(70);
  });

  it('need a name and a split adding up to exactly 100', () => {
    const split = { lower: 25, upper: 25, core: 25, cardio: 25 };
    expect(presetDraftErrors({ name: 'Even', split })).toEqual({});
    expect(presetDraftErrors({ name: '  ', split }).name).toBe('Give it a name.');
    expect(presetDraftErrors({ name: 'x'.repeat(PRESET_NAME_MAX + 1), split }).name).toMatch(/at most 60/);
    expect(presetDraftErrors({ name: 'x'.repeat(PRESET_NAME_MAX), split })).toEqual({});
    expect(presetDraftErrors({ name: 'A', split: { ...split, cardio: 10 } }).split).toBe(
      'Add 15% more: the parts must add up to 100%.',
    );
    expect(presetDraftErrors({ name: 'A', split: { ...split, cardio: 40 } }).split).toBe(
      'Take away 15%: the parts must add up to 100%.',
    );
    expect(presetDraftErrors({ name: 'A', split: { ...split, cardio: 24.5, core: 25.5 } }).split).toMatch(/whole number/);
    expect(presetDraftErrors({ name: 'A', split: { lower: 120, upper: -20, core: 0, cardio: 0 } }).split).toMatch(/whole number/);
  });

  it('every region is one of the four', () => {
    expect(SPLIT_REGIONS).toEqual(['lower', 'upper', 'core', 'cardio']);
  });
});

describe('presetsRepo', () => {
  const draft = { name: ' Legs and core ', split: { lower: 60, upper: 0, core: 40, cardio: 0 } };

  it('creates a custom preset owned by the user', async () => {
    const id = await createPreset(USER, draft, { nowMs: T0, id: MINE });
    expect(id).toBe(MINE);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.rows('presets')).toEqual([
      {
        id: MINE,
        owner_id: USER,
        name: 'Legs and core',
        kind: 'custom',
        split: '{"lower":60,"upper":0,"core":40,"cardio":0}',
        created_at: ISO,
        updated_at: ISO,
      },
    ]);
    expect(parseSplit(mockDb.rows('presets')[0].split)).toEqual(draft.split);
  });

  it('can make the new preset the default, when the profile has synced', async () => {
    mockDb.seed('profiles', { id: USER, default_preset_id: null });
    await createPreset(USER, draft, { nowMs: T0, id: MINE, makeDefault: true });
    expect(mockDb.rows('profiles')[0]).toMatchObject({ default_preset_id: MINE, updated_at: ISO });
  });

  it('makes a new id when none is given', async () => {
    const id = await createPreset(USER, draft, { nowMs: T0 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockDb.rows('presets')[0].id).toBe(id);
  });

  it('refuses drafts the server would refuse, writing nothing', async () => {
    await expect(createPreset(USER, { name: 'Bad', split: { lower: 50, upper: 0, core: 0, cardio: 0 } })).rejects.toThrow(
      RangeError,
    );
    await expect(createPreset(USER, { name: '', split: draft.split })).rejects.toThrow(RangeError);
    expect(mockDb.rows('presets')).toEqual([]);
  });

  it('updates only the user’s own preset', async () => {
    mockDb.seed('presets', row(MINE, USER, 'Old', { lower: 100, upper: 0, core: 0, cardio: 0 }));
    mockDb.seed('presets', row('theirs', OTHER, 'Theirs', { lower: 100, upper: 0, core: 0, cardio: 0 }));
    await updatePreset(MINE, USER, draft, T0);
    await updatePreset('theirs', USER, draft, T0);
    expect(mockDb.rows('presets').map((r) => [r.id, r.name, r.updated_at ?? null])).toEqual([
      [MINE, 'Legs and core', ISO],
      ['theirs', 'Theirs', null],
    ]);
  });

  it('never changes a system preset', async () => {
    const id = SYSTEM_PRESET_IDS.full_body;
    mockDb.seed('presets', row(id, null, 'Full body', { lower: 25, upper: 50, core: 25, cardio: 0 }, 'full_body'));
    await updatePreset(id, USER, draft, T0);
    await deletePreset(id, USER, T0);
    expect(mockDb.rows('presets')).toHaveLength(1);
    expect(mockDb.rows('presets')[0].name).toBe('Full body');
  });

  it('deletes a preset and clears it as the default in the same transaction', async () => {
    mockDb.seed('presets', row(MINE, USER, 'Mine', { lower: 100, upper: 0, core: 0, cardio: 0 }));
    mockDb.seed('profiles', { id: USER, default_preset_id: MINE });
    await deletePreset(MINE, USER, T0);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.rows('presets')).toEqual([]);
    expect(mockDb.rows('profiles')[0]).toMatchObject({ default_preset_id: null, updated_at: ISO });
  });

  it('leaves another default alone when deleting', async () => {
    mockDb.seed('presets', row(MINE, USER, 'Mine', { lower: 100, upper: 0, core: 0, cardio: 0 }));
    mockDb.seed('profiles', { id: USER, default_preset_id: SYSTEM_PRESET_IDS.all_upper, updated_at: 'before' });
    await deletePreset(MINE, USER, T0);
    expect(mockDb.rows('profiles')[0]).toMatchObject({ default_preset_id: SYSTEM_PRESET_IDS.all_upper, updated_at: 'before' });
  });
});
