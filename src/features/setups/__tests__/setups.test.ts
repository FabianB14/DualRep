/// <reference types="node" />
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EQUIPMENT_GROUPS, SETUP_TEMPLATES } from '@/features/training/equipment';

import type { SqliteDb } from '../../history/testing/sqliteDb';
import {
  describeSetup,
  draftChanged,
  emptySetupDraft,
  resolveSetup,
  SETUP_NAME_MAX,
  setupDraftErrors,
  setupFromRow,
  TEMPLATE_CHOICES,
  templateDraft,
  toggleEquipment,
  uniqueName,
} from '../setups';
import { createSetup, createSetupFromTemplate, deleteSetup, updateSetup } from '../setupsRepo';

jest.mock('../../../db/database', () => ({
  db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
}));
const mockDb = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;
jest.mock('../../../lib/ids', () => ({
  newId: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const HOME = '22222222-2222-4222-8222-222222222222';
const GYM = '33333333-3333-4333-8333-333333333333';
const T0 = Date.UTC(2026, 9, 8, 9, 30, 0, 250);
const ISO = '2026-10-08T09:30:00.250Z';

beforeEach(() => mockDb.reset());

describe('setupFromRow', () => {
  it('parses and normalizes the equipment list', () => {
    expect(
      setupFromRow({ id: HOME, name: ' Flat ', location: 'home', equipment: '["band","dumbbell","bodyweight","band","laser"]' }),
    ).toEqual({ id: HOME, name: 'Flat', location: 'home', equipment: ['dumbbell', 'band'] });
  });

  it('reads bad values safely', () => {
    expect(setupFromRow({ id: HOME, name: null, location: 'home', equipment: 'not json' })).toEqual({
      id: HOME,
      name: 'Home',
      location: 'home',
      equipment: [],
    });
    // An unknown location is inferred from the gear.
    expect(setupFromRow({ id: GYM, name: 'X', location: 'office', equipment: '["barbell"]' }).location).toBe('gym');
    expect(setupFromRow({ id: GYM, name: 'X', location: null, equipment: '["band"]' }).location).toBe('home');
  });
});

describe('resolveSetup', () => {
  const home = { id: HOME, name: 'Home', location: 'home' as const, equipment: [] };
  const gym = { id: GYM, name: 'Gym', location: 'gym' as const, equipment: ['barbell'] };

  it('uses the default, else the first setup, else none', () => {
    expect(resolveSetup([home, gym], GYM)).toBe(gym);
    expect(resolveSetup([home, gym], null)).toBe(home);
    expect(resolveSetup([home, gym], 'deleted')).toBe(home);
    expect(resolveSetup([], null)).toBeNull();
    expect(resolveSetup([], GYM)).toBeNull();
  });
});

describe('names and templates', () => {
  it('makes names unique, ignoring case', () => {
    expect(uniqueName('Gym', [])).toBe('Gym');
    expect(uniqueName('Gym', ['gym'])).toBe('Gym 2');
    expect(uniqueName('Gym', ['Gym', 'Gym 2', 'Office'])).toBe('Gym 3');
  });

  it('fills a draft from each template', () => {
    expect(templateDraft('home_bodyweight')).toEqual({ name: 'Home', location: 'home', equipment: [] });
    expect(templateDraft('home_basic', ['Home'])).toEqual({
      name: 'Home with weights',
      location: 'home',
      equipment: ['dumbbell', 'band'],
    });
    const gym = templateDraft('gym', ['Gym']);
    expect(gym.name).toBe('Gym 2');
    expect(gym.location).toBe('gym');
    expect(new Set(gym.equipment)).toEqual(new Set(SETUP_TEMPLATES.gym.equipment));
    expect(TEMPLATE_CHOICES.map((choice) => choice.template)).toEqual(['home_bodyweight', 'home_basic', 'gym']);
    expect(emptySetupDraft(['Home'])).toEqual({ name: 'Home 2', location: 'home', equipment: [] });
  });

  it('every checklist item and template item is a real equipment word', () => {
    const items = EQUIPMENT_GROUPS.flatMap((group) => group.items);
    for (const template of Object.values(SETUP_TEMPLATES)) {
      for (const item of template.equipment) expect(items).toContain(item);
    }
  });
});

describe('toggleEquipment', () => {
  it('checks and unchecks, keeping vocabulary order', () => {
    expect(toggleEquipment([], 'band')).toEqual(['band']);
    expect(toggleEquipment(['band'], 'dumbbell')).toEqual(['dumbbell', 'band']);
    expect(toggleEquipment(['dumbbell', 'band'], 'dumbbell')).toEqual(['band']);
  });
});

describe('setupDraftErrors / describeSetup / draftChanged', () => {
  it('needs a name of at most 60 characters', () => {
    expect(setupDraftErrors({ name: 'Home', location: 'home', equipment: [] })).toEqual({});
    expect(setupDraftErrors({ name: '  ', location: 'home', equipment: [] }).name).toBe('Give it a name.');
    expect(setupDraftErrors({ name: 'x'.repeat(SETUP_NAME_MAX + 1), location: 'home', equipment: [] }).name).toMatch(/60/);
  });

  it('describes a setup in a few words', () => {
    expect(describeSetup({ location: 'home', equipment: [] })).toBe('Home · just your body');
    expect(describeSetup({ location: 'home', equipment: ['dumbbell', 'band'] })).toBe('Home · Dumbbells, Resistance bands');
    expect(describeSetup({ location: 'gym', equipment: SETUP_TEMPLATES.gym.equipment })).toBe('Gym · 20 items');
  });

  it('notices unsaved changes', () => {
    const saved = { name: 'Home', location: 'home' as const, equipment: ['dumbbell'] };
    expect(draftChanged({ name: 'Home ', location: 'home', equipment: ['dumbbell'] }, saved)).toBe(false);
    expect(draftChanged({ name: 'Flat', location: 'home', equipment: ['dumbbell'] }, saved)).toBe(true);
    expect(draftChanged({ name: 'Home', location: 'gym', equipment: ['dumbbell'] }, saved)).toBe(true);
    expect(draftChanged({ name: 'Home', location: 'home', equipment: [] }, saved)).toBe(true);
  });
});

describe('setupsRepo', () => {
  it('creates a setup with normalized equipment JSON', async () => {
    const id = await createSetup(
      USER,
      { name: ' Flat ', location: 'home', equipment: ['band', 'dumbbell', 'band'] },
      { nowMs: T0, id: HOME },
    );
    expect(id).toBe(HOME);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.rows('equipment_setups')).toEqual([
      {
        id: HOME,
        user_id: USER,
        name: 'Flat',
        location: 'home',
        equipment: '["dumbbell","band"]',
        created_at: ISO,
        updated_at: ISO,
      },
    ]);
  });

  it('can make it the default once the profile has synced, and never creates the profile', async () => {
    await createSetup(USER, templateDraft('gym'), { nowMs: T0, id: GYM, makeDefault: true });
    expect(mockDb.rows('profiles')).toEqual([]);
    mockDb.seed('profiles', { id: USER });
    await createSetup(USER, templateDraft('home_bodyweight'), { nowMs: T0, id: HOME, makeDefault: true });
    expect(mockDb.rows('profiles')[0]).toMatchObject({ default_setup_id: HOME, updated_at: ISO });
  });

  it('creates from a template in one call', async () => {
    const id = await createSetupFromTemplate(USER, 'home_bodyweight', ['Home'], { nowMs: T0 });
    expect(mockDb.rows('equipment_setups')).toEqual([
      expect.objectContaining({ id, user_id: USER, name: 'Home 2', location: 'home', equipment: '[]' }),
    ]);
  });

  it('refuses a bad draft, writing nothing', async () => {
    await expect(createSetup(USER, { name: '', location: 'home', equipment: [] })).rejects.toThrow(RangeError);
    await expect(createSetup(USER, { name: 'Office', location: 'office' as never, equipment: [] })).rejects.toThrow(
      RangeError,
    );
    expect(mockDb.rows('equipment_setups')).toEqual([]);
  });

  it('updates only the user’s own setup', async () => {
    mockDb.seed('equipment_setups', { id: HOME, user_id: USER, name: 'Home', location: 'home', equipment: '[]' });
    mockDb.seed('equipment_setups', { id: GYM, user_id: OTHER, name: 'Gym', location: 'gym', equipment: '[]' });
    await updateSetup(HOME, USER, { name: 'Home gym', location: 'home', equipment: ['rack', 'barbell'] }, T0);
    await updateSetup(GYM, USER, { name: 'Mine now', location: 'home', equipment: [] }, T0);
    expect(mockDb.rows('equipment_setups').map((r) => [r.id, r.name, r.equipment, r.updated_at ?? null])).toEqual([
      [HOME, 'Home gym', '["barbell","rack"]', ISO],
      [GYM, 'Gym', '[]', null],
    ]);
  });

  it('deletes a setup and clears it as the default in the same transaction', async () => {
    mockDb.seed('equipment_setups', { id: HOME, user_id: USER, name: 'Home', location: 'home', equipment: '[]' });
    mockDb.seed('profiles', { id: USER, default_setup_id: HOME });
    await deleteSetup(HOME, USER, T0);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.rows('equipment_setups')).toEqual([]);
    expect(mockDb.rows('profiles')[0]).toMatchObject({ default_setup_id: null, updated_at: ISO });
  });

  it('keeps another default and other users’ setups when deleting', async () => {
    mockDb.seed('equipment_setups', { id: HOME, user_id: USER, name: 'Home', location: 'home', equipment: '[]' });
    mockDb.seed('equipment_setups', { id: GYM, user_id: OTHER, name: 'Gym', location: 'gym', equipment: '[]' });
    mockDb.seed('profiles', { id: USER, default_setup_id: 'something-else', updated_at: 'before' });
    await deleteSetup(HOME, USER, T0);
    await deleteSetup(GYM, USER, T0);
    expect(mockDb.rows('equipment_setups').map((r) => r.id)).toEqual([GYM]);
    expect(mockDb.rows('profiles')[0]).toMatchObject({ default_setup_id: 'something-else', updated_at: 'before' });
  });
});
