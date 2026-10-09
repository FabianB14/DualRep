import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SqliteDb } from '../../history/testing/sqliteDb';
import {
  BLOCK_MINUTES,
  DEFAULT_PROFILE,
  formatMinutes,
  isValidBlockMinutes,
  profileFromRow,
  profileUpdate,
} from '../profile';
import { updateProfile } from '../profileRepo';

// The real SQL runs on an in-memory SQLite database with the app's table shapes.
jest.mock('../../../db/database', () => ({
  db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
}));
const mockDb = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;

const USER = '11111111-1111-4111-8111-111111111111';
const PRESET = '00000000-0000-4000-8000-0000000000a2';
const SETUP = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 9, 8, 9, 30, 0, 250);
const ISO = '2026-10-08T09:30:00.250Z';

beforeEach(() => mockDb.reset());

describe('profileFromRow', () => {
  it('uses the server defaults before the profile has synced', () => {
    expect(profileFromRow(null)).toEqual(DEFAULT_PROFILE);
    expect(profileFromRow(undefined)).toEqual({
      synced: false,
      displayName: '',
      unit: 'lb',
      blockMinutes: 25,
      defaultPresetId: null,
      defaultSetupId: null,
    });
  });

  it('reads a synced row', () => {
    expect(
      profileFromRow({
        id: USER,
        display_name: 'Sam',
        unit_pref: 'kg',
        default_block_minutes: 40,
        default_preset_id: PRESET,
        default_setup_id: SETUP,
      }),
    ).toEqual({
      synced: true,
      displayName: 'Sam',
      unit: 'kg',
      blockMinutes: 40,
      defaultPresetId: PRESET,
      defaultSetupId: SETUP,
    });
  });

  it('falls back on defaults for values it cannot use', () => {
    const profile = profileFromRow({
      id: USER,
      display_name: null,
      unit_pref: 'stone',
      default_block_minutes: 9,
      default_preset_id: '',
      default_setup_id: null,
    });
    expect(profile).toEqual({ ...DEFAULT_PROFILE, synced: true });
    expect(profileFromRow({ id: USER, default_block_minutes: 51 }).blockMinutes).toBe(25);
    expect(profileFromRow({ id: USER, default_block_minutes: 22.5 }).blockMinutes).toBe(25);
    expect(profileFromRow({ id: USER, default_block_minutes: 10 }).blockMinutes).toBe(10);
    expect(profileFromRow({ id: USER, default_block_minutes: 50 }).blockMinutes).toBe(50);
  });
});

describe('block minutes', () => {
  it('match the profile CHECK (10–50) and step 5', () => {
    expect(BLOCK_MINUTES).toMatchObject({ min: 10, max: 50, step: 5, default: 25 });
    for (const ok of [10, 15, 25, 50]) expect(isValidBlockMinutes(ok)).toBe(true);
    for (const bad of [9, 51, 0, -10, 12.5, Number.NaN, '25', null]) expect(isValidBlockMinutes(bad)).toBe(false);
    expect(formatMinutes(25)).toBe('25 min');
  });
});

describe('profileUpdate', () => {
  it('writes only the columns in the patch, plus updated_at', () => {
    expect(profileUpdate(USER, { unit: 'kg' }, T0)).toEqual({
      sql: 'UPDATE profiles SET unit_pref = ?, updated_at = ? WHERE id = ?',
      params: ['kg', ISO, USER],
    });
    expect(
      profileUpdate(USER, { unit: 'lb', blockMinutes: 30, defaultPresetId: PRESET, defaultSetupId: null }, T0),
    ).toEqual({
      sql: 'UPDATE profiles SET unit_pref = ?, default_block_minutes = ?, default_preset_id = ?, default_setup_id = ?, updated_at = ? WHERE id = ?',
      params: ['lb', 30, PRESET, null, ISO, USER],
    });
  });

  it('refuses what the CHECK constraints would refuse, and empty patches', () => {
    expect(() => profileUpdate(USER, { blockMinutes: 55 }, T0)).toThrow(RangeError);
    expect(() => profileUpdate(USER, { blockMinutes: 9 }, T0)).toThrow(RangeError);
    expect(() => profileUpdate(USER, { blockMinutes: 27.5 }, T0)).toThrow(RangeError);
    expect(() => profileUpdate(USER, { unit: 'st' as never }, T0)).toThrow(RangeError);
    expect(() => profileUpdate(USER, {}, T0)).toThrow(RangeError);
    expect(() => profileUpdate(USER, { unit: 'kg' }, Number.NaN)).toThrow(RangeError);
  });

  it('writes an empty id as null', () => {
    expect(profileUpdate(USER, { defaultSetupId: '' }, T0).params).toEqual([null, ISO, USER]);
  });
});

describe('updateProfile', () => {
  it('never creates the profile: before it has synced nothing is written', async () => {
    await expect(updateProfile(USER, { unit: 'kg' }, T0)).resolves.toBe(false);
    expect(mockDb.rows('profiles')).toEqual([]);
    expect(mockDb.calls.every((call) => !/^\s*(INSERT|UPDATE)/i.test(call.sql))).toBe(true);
  });

  it('updates the synced row in one transaction', async () => {
    mockDb.seed('profiles', { id: USER, unit_pref: 'lb', default_block_minutes: 25, updated_at: '2026-01-01T00:00:00.000Z' });
    await expect(updateProfile(USER, { unit: 'kg', blockMinutes: 45, defaultPresetId: PRESET }, T0)).resolves.toBe(true);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.rows('profiles')).toEqual([
      expect.objectContaining({
        id: USER,
        unit_pref: 'kg',
        default_block_minutes: 45,
        default_preset_id: PRESET,
        default_setup_id: null,
        updated_at: ISO,
      }),
    ]);
  });

  it('only touches the signed-in user’s row', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    mockDb.seed('profiles', { id: USER, unit_pref: 'lb' });
    mockDb.seed('profiles', { id: other, unit_pref: 'lb' });
    await updateProfile(USER, { unit: 'kg' }, T0);
    expect(mockDb.rows('profiles').map((row) => [row.id, row.unit_pref])).toEqual([
      [USER, 'kg'],
      [other, 'lb'],
    ]);
  });
});
