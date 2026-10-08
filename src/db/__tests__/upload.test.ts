import { describe, expect, it, jest } from '@jest/globals';
import { UpdateType } from '@powersync/react-native';

import { TABLE_NAMES, TABLES, type TableName, type WritePolicy } from '../tables';
import {
  isFatalUploadError,
  NoSessionError,
  planOperation,
  toPostgresRow,
  UploadPlanError,
  UploadRequestError,
  type QueuedOperation,
} from '../upload';

// The runtime SDK loads native modules (and ESM jest cannot transform); @powersync/common
// exports the same classes and enums. babel-jest hoists this above the imports.
jest.mock('@powersync/react-native', () => jest.requireActual('@powersync/common'));

const ID = '11111111-1111-4111-8111-111111111111';

function op(table: string, kind: UpdateType, opData?: Record<string, unknown>): QueuedOperation {
  return { table, op: kind, id: ID, opData };
}

function planError(fn: () => unknown): UploadPlanError {
  try {
    fn();
  } catch (err) {
    if (err instanceof UploadPlanError) return err;
    throw err;
  }
  throw new Error('expected an UploadPlanError');
}

/**
 * What the device may do per table, written out from SPEC.md's "Client writes" lines (not derived
 * from the registry), so a registry edit that loosens or tightens a policy fails here.
 * groups.put is 'insert-ignore' (not upsert) because of its column-level UPDATE grant — see tables.ts.
 */
const EXPECTED: Record<
  TableName,
  { put: 'upsert' | 'insert-ignore' | false; patch: 'any' | readonly string[] | false; delete: boolean }
> = {
  profiles: { put: 'upsert', patch: 'any', delete: false },
  entitlements: { put: false, patch: false, delete: false },
  presets: { put: 'upsert', patch: 'any', delete: true },
  equipment_setups: { put: 'upsert', patch: 'any', delete: true },
  exercises: { put: 'upsert', patch: 'any', delete: true },
  study_sessions: { put: 'upsert', patch: 'any', delete: true },
  interval_blocks: { put: 'upsert', patch: 'any', delete: true },
  workout_sessions: { put: 'upsert', patch: 'any', delete: true },
  exercise_sets: { put: 'upsert', patch: 'any', delete: true },
  transitions: { put: 'upsert', patch: 'any', delete: true },
  groups: { put: 'insert-ignore', patch: ['name'], delete: true },
  group_members: { put: false, patch: false, delete: true },
  sources: { put: 'upsert', patch: 'any', delete: true },
  source_files: { put: 'upsert', patch: 'any', delete: true },
  study_plans: { put: 'upsert', patch: 'any', delete: true },
  plan_sources: { put: 'upsert', patch: 'any', delete: true },
  topics: { put: 'upsert', patch: 'any', delete: true },
  cards: { put: 'upsert', patch: 'any', delete: true },
  card_links: { put: 'upsert', patch: 'any', delete: true },
  card_states: { put: 'upsert', patch: 'any', delete: true },
  reviews: { put: 'insert-ignore', patch: false, delete: false },
  tracy_events: { put: false, patch: ['accepted'], delete: false },
};

/** A column of each table that a full-row PATCH may change, for the "any column" cases. */
const SAMPLE_PATCH: Partial<Record<TableName, Record<string, unknown>>> = {
  profiles: { display_name: 'Sam' },
  groups: { name: 'Study crew' },
  tracy_events: { accepted: 1 },
};

describe('planOperation: write policy per table', () => {
  it('covers exactly the registry tables', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...TABLE_NAMES].sort());
  });

  describe.each(TABLE_NAMES)('%s', (table) => {
    const expected = EXPECTED[table];

    it(`PUT → ${expected.put || 'rejected'}`, () => {
      const put = op(table, UpdateType.PUT, { created_at: '2026-10-08T09:30:00.123Z' });
      if (expected.put === false) {
        expect(planError(() => planOperation(put)).code).toBe('DUALREP_WRITE_NOT_ALLOWED');
        return;
      }
      expect(planOperation(put)).toEqual({
        method: 'upsert',
        table,
        row: { id: ID, created_at: '2026-10-08T09:30:00.123Z' },
        options: { onConflict: 'id', ignoreDuplicates: expected.put === 'insert-ignore' },
      });
    });

    it(`PATCH → ${expected.patch === false ? 'rejected' : 'allowed'}`, () => {
      const values = SAMPLE_PATCH[table] ?? { created_at: '2026-10-08T09:30:00.123Z' };
      const patch = op(table, UpdateType.PATCH, values);
      if (expected.patch === false) {
        expect(planError(() => planOperation(patch)).code).toBe('DUALREP_WRITE_NOT_ALLOWED');
        return;
      }
      const plan = planOperation(patch);
      expect(plan).toMatchObject({ method: 'update', table, id: ID });
      if (Array.isArray(expected.patch)) {
        // Any column outside the allow-list is refused.
        const outside = op(table, UpdateType.PATCH, { ...values, created_at: '2026-10-08T09:30:00.123Z' });
        expect(planError(() => planOperation(outside)).code).toBe('DUALREP_WRITE_NOT_ALLOWED');
      }
    });

    it(`DELETE → ${expected.delete ? 'allowed' : 'rejected'}`, () => {
      const del = op(table, UpdateType.DELETE);
      if (!expected.delete) {
        expect(planError(() => planOperation(del)).code).toBe('DUALREP_WRITE_NOT_ALLOWED');
        return;
      }
      expect(planOperation(del)).toEqual({ method: 'delete', table, id: ID });
    });
  });
});

describe('planOperation: specifics', () => {
  it('uploads reviews with ON CONFLICT DO NOTHING so a retried upload is harmless', () => {
    const plan = planOperation(
      op('reviews', UpdateType.PUT, { user_id: ID, card_id: ID, rating: 3, reviewed_at: '2026-10-08T09:30:00.123Z' }),
    );
    expect(plan).toMatchObject({ method: 'upsert', options: { onConflict: 'id', ignoreDuplicates: true } });
  });

  it('upserts ordinary tables (idempotent on retry)', () => {
    const plan = planOperation(op('study_sessions', UpdateType.PUT, { user_id: ID, focus_subject: 'Biology' }));
    expect(plan).toEqual({
      method: 'upsert',
      table: 'study_sessions',
      row: { id: ID, user_id: ID, focus_subject: 'Biology' },
      options: { onConflict: 'id', ignoreDuplicates: false },
    });
  });

  it('lets tracy_events change only `accepted`, converting 0/1 to a boolean', () => {
    expect(planOperation(op('tracy_events', UpdateType.PATCH, { accepted: 0 }))).toEqual({
      method: 'update',
      table: 'tracy_events',
      id: ID,
      values: { accepted: false },
    });
    for (const column of ['status', 'error', 'user_id', 'job']) {
      const err = planError(() => planOperation(op('tracy_events', UpdateType.PATCH, { accepted: 1, [column]: 'x' })));
      expect(err.code).toBe('DUALREP_WRITE_NOT_ALLOWED');
      expect(err.message).toContain(column);
    }
  });

  it('never uploads groups.invite_code: the server always picks the code', () => {
    // A locally created group may hold null (or a placeholder) there; the insert grant excludes the
    // column, so sending it at all would make the whole insert fail with 42501.
    for (const inviteCode of [null, 'ABCD2345']) {
      expect(
        planOperation(
          op('groups', UpdateType.PUT, {
            owner_id: ID,
            name: 'Crew',
            invite_code: inviteCode,
            created_at: '2026-10-08T09:30:00.123Z',
          }),
        ),
      ).toEqual({
        method: 'upsert',
        table: 'groups',
        row: { id: ID, owner_id: ID, name: 'Crew', created_at: '2026-10-08T09:30:00.123Z' },
        options: { onConflict: 'id', ignoreDuplicates: true },
      });
    }
  });

  it('refuses a PATCH that changes a server-generated column', () => {
    const err = planError(() => planOperation(op('groups', UpdateType.PATCH, { invite_code: 'ABCD2345' })));
    expect(err.code).toBe('DUALREP_WRITE_NOT_ALLOWED');
    expect(err.message).toContain('generated by the server');
  });

  it('declares exactly groups.invite_code as server-generated, and only registry columns', () => {
    const declared = TABLE_NAMES.flatMap((table) => {
      const writes: WritePolicy = TABLES[table].writes;
      return (writes.serverGenerated ?? []).map((column) => `${table}.${column}`);
    });
    expect(declared).toEqual(['groups.invite_code']);
    for (const name of declared) {
      const [table, column] = name.split('.') as [TableName, string];
      expect(Object.keys(TABLES[table].columns)).toContain(column);
    }
  });

  it('lets groups change only `name`', () => {
    expect(planOperation(op('groups', UpdateType.PATCH, { name: 'Crew' }))).toMatchObject({ values: { name: 'Crew' } });
    for (const column of ['owner_id', 'invite_code']) {
      const err = planError(() => planOperation(op('groups', UpdateType.PATCH, { name: 'Crew', [column]: ID })));
      expect(err.code).toBe('DUALREP_WRITE_NOT_ALLOWED');
    }
  });

  it('drops server-maintained updated_at from PATCH (the trigger sets it; column grants would refuse it)', () => {
    expect(
      planOperation(op('groups', UpdateType.PATCH, { name: 'Crew', updated_at: '2026-10-08T09:30:00.123Z' })),
    ).toEqual({ method: 'update', table: 'groups', id: ID, values: { name: 'Crew' } });
    expect(planOperation(op('tracy_events', UpdateType.PATCH, { updated_at: '2026-10-08T09:30:00.123Z' }))).toMatchObject(
      { method: 'skip' },
    );
    expect(planOperation(op('study_sessions', UpdateType.PATCH, undefined))).toMatchObject({ method: 'skip' });
  });

  it('never lets a PATCH change the id', () => {
    expect(planOperation(op('topics', UpdateType.PATCH, { id: 'other', title: 'T' }))).toEqual({
      method: 'update',
      table: 'topics',
      id: ID,
      values: { title: 'T' },
    });
  });

  it('refuses read-only tables entirely', () => {
    for (const kind of [UpdateType.PUT, UpdateType.PATCH, UpdateType.DELETE]) {
      expect(planError(() => planOperation(op('entitlements', kind, { tier: 'subscription' }))).code).toBe(
        'DUALREP_WRITE_NOT_ALLOWED',
      );
    }
    expect(planError(() => planOperation(op('group_members', UpdateType.PUT, { role: 'owner' }))).code).toBe(
      'DUALREP_WRITE_NOT_ALLOWED',
    );
    expect(planError(() => planOperation(op('reviews', UpdateType.PATCH, { rating: 1 }))).code).toBe(
      'DUALREP_WRITE_NOT_ALLOWED',
    );
  });

  it('refuses tables that are not synced (including server-only source_chunks)', () => {
    for (const table of ['source_chunks', 'upload_failures', 'nope']) {
      expect(planError(() => planOperation(op(table, UpdateType.PUT, {}))).code).toBe('DUALREP_UNKNOWN_TABLE');
    }
  });
});

describe('toPostgresRow', () => {
  it('parses json columns and converts boolean columns', () => {
    expect(
      toPostgresRow('exercises', {
        name: 'Goblet squat',
        equipment: '["dumbbell"]',
        secondary_muscles: '[]',
        instructions: '["Hold the bell", "Squat"]',
        images: null,
        micro_ok: 1,
        reviewed: 0,
        demand_level: 2,
      }),
    ).toEqual({
      name: 'Goblet squat',
      equipment: ['dumbbell'],
      secondary_muscles: [],
      instructions: ['Hold the bell', 'Squat'],
      images: null,
      micro_ok: true,
      reviewed: false,
      demand_level: 2,
    });
  });

  it('parses json objects (presets.split, transitions.proposal, profiles.fsrs_params)', () => {
    expect(toPostgresRow('presets', { split: '{"lower":70,"upper":15,"core":15,"cardio":0}' })).toEqual({
      split: { lower: 70, upper: 15, core: 15, cardio: 0 },
    });
    expect(toPostgresRow('transitions', { proposal: '{"exercises":[],"ok":true}', accepted: null })).toEqual({
      proposal: { exercises: [], ok: true },
      accepted: null,
    });
    expect(toPostgresRow('profiles', { fsrs_params: '{"request_retention":0.9}' })).toEqual({
      fsrs_params: { request_retention: 0.9 },
    });
  });

  it('converts every boolean column of the FSRS and session tables', () => {
    expect(toPostgresRow('card_states', { suspended: 1, stability: 2.3065, state: 1 })).toEqual({
      suspended: true,
      stability: 2.3065,
      state: 1,
    });
    expect(toPostgresRow('interval_blocks', { interrupted: 0 })).toEqual({ interrupted: false });
    expect(toPostgresRow('source_files', { confirmed: true })).toEqual({ confirmed: true });
  });

  it('keeps text, uuid, timestamp and date values unchanged', () => {
    const row = { owner_id: ID, title: 'Exam', target_date: '2026-12-01', created_at: '2026-10-08T09:30:00.123Z' };
    expect(toPostgresRow('study_plans', row)).toEqual(row);
  });

  it('rejects invalid JSON instead of storing it as a JSON string', () => {
    expect(planError(() => toPostgresRow('exercises', { equipment: 'dumbbell' })).code).toBe('DUALREP_INVALID_VALUE');
  });

  it('rejects boolean values other than 0/1', () => {
    expect(planError(() => toPostgresRow('exercises', { micro_ok: 2 })).code).toBe('DUALREP_INVALID_VALUE');
  });

  it('rejects columns the registry does not know (surfaces registry/code drift)', () => {
    expect(planError(() => toPostgresRow('study_sessions', { focus: 'x' })).code).toBe('DUALREP_UNKNOWN_COLUMN');
    // tracy_events' heavy columns are server-only and therefore unknown on the device.
    expect(planError(() => toPostgresRow('tracy_events', { input: '{}' })).code).toBe('DUALREP_UNKNOWN_COLUMN');
  });
});

describe('isFatalUploadError', () => {
  const pg = (code: string, status = 400) => new UploadRequestError({ code, message: code }, status);

  it.each([
    ['22P02 invalid text representation', pg('22P02')],
    ['22001 string too long', pg('22001')],
    ['23505 unique violation', pg('23505', 409)],
    ['23503 foreign key violation', pg('23503', 409)],
    ['23514 check violation', pg('23514')],
    ['23502 not null violation', pg('23502')],
    ['42501 RLS / missing grant for a signed-in user (HTTP 403)', pg('42501', 403)],
    ['a plain object with a fatal code', { code: '23505', message: 'duplicate' }],
    ['a local plan error', new UploadPlanError('DUALREP_WRITE_NOT_ALLOWED', 'no')],
  ])('fatal: %s', (_label, err) => {
    expect(isFatalUploadError(err)).toBe(true);
  });

  it.each([
    ['offline (no HTTP response)', new UploadRequestError({ code: '', message: 'TypeError: Network request failed' }, 0)],
    ['5xx without a code', new UploadRequestError({ message: '<html>Bad gateway</html>' }, 502)],
    ['expired JWT (PGRST301)', pg('PGRST301', 401)],
    ['PGRST303 JWT claims', pg('PGRST303', 401)],
    // No usable session: supabase-js sent the anon key and PostgREST refused the request as `anon`.
    ['42501 with HTTP 401 (request ran as anon)', pg('42501', 401)],
    ['any HTTP 401, whatever its code', pg('23505', 401)],
    ['a plain object with status 401', { code: '42501', status: 401 }],
    ['no signed-in session (refused before sending)', new NoSessionError()],
    ['PGRST204 unknown column in schema cache', pg('PGRST204')],
    ['42P01 undefined table', pg('42P01', 404)],
    ['57014 statement timeout', pg('57014', 500)],
    ['08006 connection failure', pg('08006', 503)],
    ['a thrown TypeError', new TypeError('Network request failed')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a numeric code', { code: 23505 }],
  ])('retryable: %s', (_label, err) => {
    expect(isFatalUploadError(err)).toBe(false);
  });
});
