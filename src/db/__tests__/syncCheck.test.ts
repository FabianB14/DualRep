import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createProbeRow, getUploadFailures, getUploadQueueCount, verifyOnServer } from '../syncCheck';

// database.ts constructs the native PowerSync database, so it is replaced by a recording fake.
// (jest.mock is hoisted above everything; a `mock`-prefixed function declaration is hoisted too.)
function mockCreateDb() {
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected: 1 })),
    getAll: jest.fn(async (_sql: string) => [] as unknown[]),
    getUploadQueueStats: jest.fn(async () => ({ count: 3, size: null })),
  };
}
jest.mock('../database', () => ({ db: mockCreateDb() }));
// `virtual` keeps this independent of whether src/lib/ids.ts (expo-crypto) is loadable here.
jest.mock('../../lib/ids', () => ({ newId: () => '55555555-5555-4555-8555-555555555555' }), { virtual: true });

const mockDb = (jest.requireMock('../database') as { db: ReturnType<typeof mockCreateDb> }).db;

const USER = '22222222-2222-4222-8222-222222222222';
const PROBE = '55555555-5555-4555-8555-555555555555';

/** supabase.from(table).select(cols).eq(col, value).maybeSingle() answering with `result` (or throwing). */
function fakeSupabase(result: { data: unknown; error: unknown; status: number } | Error) {
  const seen: unknown[] = [];
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          maybeSingle: async () => {
            seen.push({ table, columns, column, value });
            if (result instanceof Error) throw result;
            return result;
          },
        }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, seen };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createProbeRow', () => {
  it('inserts a study_sessions row locally with a fresh id and an ISO timestamp', async () => {
    const { id, createdAt } = await createProbeRow(USER);
    expect(id).toBe(PROBE);
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(sql).toMatch(/^INSERT INTO study_sessions \(id, user_id, focus_subject, created_at, updated_at\)/);
    expect(params).toEqual([PROBE, USER, `Sync check ${createdAt}`, createdAt, createdAt]);
  });
});

describe('local queue helpers', () => {
  it('reports the upload queue count', async () => {
    await expect(getUploadQueueCount()).resolves.toBe(3);
  });

  it('lists upload failures newest first', async () => {
    await getUploadFailures();
    expect(mockDb.getAll.mock.calls[0][0]).toBe('SELECT * FROM upload_failures ORDER BY created_at DESC');
  });
});

describe('verifyOnServer', () => {
  it('reads the row by id from Postgres through the Data API', async () => {
    const { client, seen } = fakeSupabase({ data: { id: PROBE }, error: null, status: 200 });
    await expect(verifyOnServer(client, PROBE)).resolves.toBe('found');
    expect(seen).toEqual([{ table: 'study_sessions', columns: 'id', column: 'id', value: PROBE }]);
  });

  it('reports missing when the row is not (yet) there', async () => {
    const { client } = fakeSupabase({ data: null, error: null, status: 200 });
    await expect(verifyOnServer(client, PROBE)).resolves.toBe('missing');
  });

  it('reports offline when the request got no response', async () => {
    const { client } = fakeSupabase({ data: null, error: { message: 'TypeError: Network request failed', code: '' }, status: 0 });
    await expect(verifyOnServer(client, PROBE)).resolves.toBe('offline');
  });

  it('reports error for a server-side failure or a thrown exception', async () => {
    const denied = fakeSupabase({ data: null, error: { message: 'permission denied', code: '42501' }, status: 403 });
    await expect(verifyOnServer(denied.client, PROBE)).resolves.toBe('error');
    const thrown = fakeSupabase(new Error('aborted'));
    await expect(verifyOnServer(thrown.client, PROBE)).resolves.toBe('error');
  });
});
