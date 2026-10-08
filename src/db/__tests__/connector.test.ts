import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { UpdateType, type CommonPowerSyncDatabase, type CrudEntry } from '@powersync/react-native';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SupabaseConnector } from '../connector';
import { NoSessionError } from '../upload';

// The runtime SDK loads native modules (and ESM jest cannot transform); @powersync/common
// exports the same classes and enums. babel-jest hoists this above the imports.
jest.mock('@powersync/react-native', () => jest.requireActual('@powersync/common'));

type Result = { error: { code?: string; message: string } | null; status: number };
type Call =
  | { method: 'upsert'; table: string; row: Record<string, unknown>; options: unknown }
  | { method: 'update'; table: string; values: Record<string, unknown>; eq: [string, string] }
  | { method: 'delete'; table: string; eq: [string, string] };

const OK: Result = { error: null, status: 201 };
const SIGNED_IN = { access_token: 'jwt-token', expires_at: 1_800_000_000 };

/**
 * A stand-in for the supabase-js client: records each request and answers via `respond`.
 * auth.getSession() returns `session` (signed in by default; pass null for signed out).
 */
function fakeSupabase(
  respond: (call: Call) => Result = () => OK,
  session: unknown = SIGNED_IN,
  sessionError: unknown = null,
) {
  const calls: Call[] = [];
  const send = (call: Call) => {
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  const client = {
    auth: { getSession: jest.fn(async () => ({ data: { session }, error: sessionError })) },
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, options: unknown) => send({ method: 'upsert', table, row, options }),
      update: (values: Record<string, unknown>) => ({
        eq: (column: string, value: string) => send({ method: 'update', table, values, eq: [column, value] }),
      }),
      delete: () => ({
        eq: (column: string, value: string) => send({ method: 'delete', table, eq: [column, value] }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, calls, getSession: client.auth.getSession };
}

let nextClientId = 1;
function entry(table: string, op: UpdateType, id: string, opData?: Record<string, unknown>): CrudEntry {
  const data = { clientId: nextClientId++, id, op, opData, table, transactionId: 7 };
  return { ...data, toJSON: () => data, equals: () => false, toComparisonArray: () => [] };
}

/** A stand-in for CommonPowerSyncDatabase with one queued transaction and a recording SQL executor. */
function fakeDatabase(crud: CrudEntry[] | null) {
  const complete = jest.fn(async () => undefined);
  const executed: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: jest.fn(async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params });
      return { rowsAffected: 1 };
    }),
  };
  const database = {
    getNextCrudTransaction: jest.fn(async () => (crud ? { crud, complete, transactionId: 7 } : null)),
    writeTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { database: database as unknown as CommonPowerSyncDatabase, complete, executed };
}

const USER = '22222222-2222-4222-8222-222222222222';
const ROW = '33333333-3333-4333-8333-333333333333';
const ROW2 = '44444444-4444-4444-8444-444444444444';
const URL = 'https://example.powersync.journeyapps.com';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('SupabaseConnector.fetchCredentials', () => {
  it('returns null when signed out, so PowerSync stays disconnected', async () => {
    const { client } = fakeSupabase(undefined, null);
    await expect(new SupabaseConnector(client, URL).fetchCredentials()).resolves.toBeNull();
  });

  it('hands PowerSync the Supabase access token, its expiry and the endpoint (trailing slash removed)', async () => {
    const { client } = fakeSupabase(undefined, SIGNED_IN);
    await expect(new SupabaseConnector(client, `${URL}/`).fetchCredentials()).resolves.toEqual({
      endpoint: URL,
      token: 'jwt-token',
      expiresAt: new Date(1_800_000_000 * 1000),
    });
  });

  it('throws when the session cannot be read or refreshed, so the SDK retries', async () => {
    const { client } = fakeSupabase(undefined, null, new Error('refresh failed: offline'));
    await expect(new SupabaseConnector(client, URL).fetchCredentials()).rejects.toThrow('refresh failed');
  });
});

describe('SupabaseConnector.uploadData', () => {
  it('does nothing when the queue is empty', async () => {
    const { client, calls } = fakeSupabase();
    const { database, complete } = fakeDatabase(null);
    await new SupabaseConnector(client, URL).uploadData(database);
    expect(calls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('sends nothing without a signed-in session and keeps the transaction queued', async () => {
    // With no session supabase-js would send the anon key and every write would be refused as anon.
    const { client, calls } = fakeSupabase(undefined, null);
    const { database, complete, executed } = fakeDatabase([
      entry('study_sessions', UpdateType.PUT, ROW, { user_id: USER, focus_subject: 'Offline' }),
    ]);
    const upload = new SupabaseConnector(client, URL).uploadData(database);
    await expect(upload).rejects.toBeInstanceOf(NoSessionError);
    expect(calls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });

  it('keeps the transaction queued when the session cannot be read or refreshed', async () => {
    const { client, calls } = fakeSupabase(undefined, null, new Error('refresh failed: offline'));
    const { database, complete, executed } = fakeDatabase([entry('topics', UpdateType.PUT, ROW, { title: 'T' })]);
    await expect(new SupabaseConnector(client, URL).uploadData(database)).rejects.toThrow('refresh failed');
    expect(calls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });

  it('applies every operation in order and completes the transaction', async () => {
    const { client, calls } = fakeSupabase();
    const { database, complete, executed } = fakeDatabase([
      entry('study_sessions', UpdateType.PUT, ROW, { user_id: USER, focus_subject: 'Sync check' }),
      entry('exercises', UpdateType.PATCH, ROW2, { micro_ok: 1, equipment: '["band"]' }),
      entry('reviews', UpdateType.PUT, ROW2, { user_id: USER, rating: 3 }),
      entry('workout_sessions', UpdateType.DELETE, ROW),
    ]);

    await new SupabaseConnector(client, URL).uploadData(database);

    expect(calls).toEqual([
      {
        method: 'upsert',
        table: 'study_sessions',
        row: { id: ROW, user_id: USER, focus_subject: 'Sync check' },
        options: { onConflict: 'id', ignoreDuplicates: false },
      },
      { method: 'update', table: 'exercises', values: { micro_ok: true, equipment: ['band'] }, eq: ['id', ROW2] },
      {
        method: 'upsert',
        table: 'reviews',
        row: { id: ROW2, user_id: USER, rating: 3 },
        options: { onConflict: 'id', ignoreDuplicates: true },
      },
      { method: 'delete', table: 'workout_sessions', eq: ['id', ROW] },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(0);
  });

  it('records a fatal server error in upload_failures, still applies the rest, and completes', async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.table === 'exercise_sets'
        ? { error: { code: '23503', message: 'violates foreign key constraint' }, status: 409 }
        : OK,
    );
    const { database, complete, executed } = fakeDatabase([
      entry('exercise_sets', UpdateType.PUT, ROW, { user_id: USER, set_index: 0 }),
      entry('study_sessions', UpdateType.PUT, ROW2, { user_id: USER }),
    ]);

    await new SupabaseConnector(client, URL).uploadData(database);

    expect(calls.map((c) => c.table)).toEqual(['exercise_sets', 'study_sessions']);
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toMatch(/INSERT INTO upload_failures/);
    expect(executed[0].sql).toMatch(/uuid\(\)/);
    const [table, rowId, opName, opData, code, message, clientId, transactionId, createdAt] = executed[0].params;
    expect([table, rowId, opName, code, message, transactionId]).toEqual([
      'exercise_sets',
      ROW,
      'PUT',
      '23503',
      'violates foreign key constraint',
      7,
    ]);
    expect(JSON.parse(opData as string)).toEqual({ user_id: USER, set_index: 0 });
    expect(typeof clientId).toBe('number');
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('records an RLS / missing-grant denial (42501) and completes', async () => {
    const { client } = fakeSupabase(() => ({
      error: { code: '42501', message: 'new row violates row-level security policy' },
      status: 403,
    }));
    const { database, complete, executed } = fakeDatabase([entry('topics', UpdateType.PUT, ROW, { title: 'T' })]);
    await new SupabaseConnector(client, URL).uploadData(database);
    expect(executed[0].params[4]).toBe('42501');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('records writes refused on the device without sending them', async () => {
    const { client, calls } = fakeSupabase();
    const { database, complete, executed } = fakeDatabase([
      entry('entitlements', UpdateType.PUT, ROW, { user_id: USER, tier: 'subscription' }),
    ]);
    await new SupabaseConnector(client, URL).uploadData(database);
    expect(calls).toHaveLength(0);
    expect(executed[0].params.slice(0, 3)).toEqual(['entitlements', ROW, 'PUT']);
    expect(executed[0].params[4]).toBe('DUALREP_WRITE_NOT_ALLOWED');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Result]>([
    ['offline', { error: { code: '', message: 'TypeError: Network request failed' }, status: 0 }],
    ['expired JWT', { error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 }],
    // The session was lost mid-upload: PostgREST ran the request as anon (no grants) and says 401/42501.
    [
      'signed out mid-upload',
      { error: { code: '42501', message: 'permission denied for table study_sessions' }, status: 401 },
    ],
    ['server error', { error: { message: 'upstream connect error' }, status: 503 }],
  ])('rethrows a retryable error (%s) without completing or recording anything', async (_label, failure) => {
    // The first operation fails fatally, the second transiently: the whole transaction must be
    // retried later, and the fatal one must not be recorded yet (it would be recorded twice).
    const { client } = fakeSupabase((call) =>
      call.table === 'topics' ? { error: { code: '23514', message: 'check' }, status: 400 } : failure,
    );
    const { database, complete, executed } = fakeDatabase([
      entry('topics', UpdateType.PUT, ROW, { title: '' }),
      entry('study_sessions', UpdateType.PUT, ROW2, { user_id: USER }),
    ]);
    // The thrown error carries supabase-js's HTTP status (isFatalUploadError depends on it).
    await expect(new SupabaseConnector(client, URL).uploadData(database)).rejects.toMatchObject({
      code: failure.error?.code ?? '',
      status: failure.status,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });
});
