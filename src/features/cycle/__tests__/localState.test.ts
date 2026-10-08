import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import { deleteLocalState, parseLocalValue, readLocalState, useLocalState, writeLocalState } from '../localState';

type Call = { via: 'tx' | 'db'; method: string; sql: string; params: unknown[] };
function mockCreateDb() {
  const calls: Call[] = [];
  const stored = new Map<string, string>();
  const record = (via: Call['via'], method: string) => async (sql: string, params: unknown[] = []) => {
    calls.push({ via, method, sql, params });
    if (method === 'getOptional') {
      const key = String(params[0]);
      if (!stored.has(key)) return null;
      return sql.startsWith('SELECT value') ? { value: stored.get(key) } : { id: key };
    }
    return { rowsAffected: 1 };
  };
  const tx = { execute: record('tx', 'execute'), getOptional: record('tx', 'getOptional') };
  return {
    calls,
    stored,
    execute: record('db', 'execute'),
    getOptional: record('db', 'getOptional'),
    writeTransaction: async <T,>(callback: (context: typeof tx) => Promise<T>) => callback(tx),
  };
}
jest.mock('../../../db/database', () => ({ db: mockCreateDb() }));
jest.mock('@powersync/react-native', () => ({ useQuery: jest.fn() }));

const mockDb = (jest.requireMock('../../../db/database') as { db: ReturnType<typeof mockCreateDb> }).db;
const mockUseQuery = (jest.requireMock('@powersync/react-native') as { useQuery: jest.Mock }).useQuery;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(() => {
  mockDb.calls.length = 0;
  mockDb.stored.clear();
  mockUseQuery.mockReset();
});

describe('parseLocalValue', () => {
  it('parses JSON text and turns anything unreadable into null', () => {
    expect(parseLocalValue('{"phase":"idle"}')).toEqual({ phase: 'idle' });
    expect(parseLocalValue('[1,2]')).toEqual([1, 2]);
    expect(parseLocalValue('{broken')).toBeNull();
    expect(parseLocalValue('')).toBeNull();
    expect(parseLocalValue(null)).toBeNull();
    expect(parseLocalValue(undefined)).toBeNull();
  });
});

describe('readLocalState', () => {
  it('reads the value by key from local_state', async () => {
    mockDb.stored.set('cycle', '{"phase":"focus"}');
    await expect(readLocalState('cycle')).resolves.toEqual({ phase: 'focus' });
    expect(mockDb.calls).toEqual([
      { via: 'db', method: 'getOptional', sql: 'SELECT value FROM local_state WHERE id = ?', params: ['cycle'] },
    ]);
  });

  it('is null when nothing is stored', async () => {
    await expect(readLocalState('missing')).resolves.toBeNull();
  });
});

describe('writeLocalState', () => {
  it('inserts a new key as JSON text with its updated_at', async () => {
    await writeLocalState('cycle', { phase: 'idle', n: 1 });
    expect(mockDb.calls.map(({ via, method, sql }) => [via, method, sql])).toEqual([
      ['tx', 'getOptional', 'SELECT id FROM local_state WHERE id = ?'],
      ['tx', 'execute', 'INSERT INTO local_state (id, value, updated_at) VALUES (?, ?, ?)'],
    ]);
    const [key, json, updatedAt] = mockDb.calls[1].params;
    expect([key, json]).toEqual(['cycle', '{"phase":"idle","n":1}']);
    expect(updatedAt).toMatch(ISO);
  });

  it('updates an existing key in place', async () => {
    mockDb.stored.set('cycle', '{}');
    await writeLocalState('cycle', null);
    expect(mockDb.calls[1].sql).toBe('UPDATE local_state SET value = ?, updated_at = ? WHERE id = ?');
    expect(mockDb.calls[1].params).toEqual(['null', expect.stringMatching(ISO), 'cycle']);
  });
});

describe('deleteLocalState', () => {
  it('deletes the key', async () => {
    await deleteLocalState('alert-test');
    expect(mockDb.calls).toEqual([
      { via: 'db', method: 'execute', sql: 'DELETE FROM local_state WHERE id = ?', params: ['alert-test'] },
    ]);
  });
});

describe('useLocalState', () => {
  function render(key: string) {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useLocalState<{ phase: string }>(key));
      return null;
    }
    act(() => {
      create(createElement(Probe));
    });
    return seen;
  }

  it('watches the key and parses its value', () => {
    mockUseQuery.mockReturnValue({ data: [{ value: '{"phase":"move"}' }], isLoading: false });
    const seen = render('cycle');
    expect(mockUseQuery).toHaveBeenCalledWith('SELECT value FROM local_state WHERE id = ?', ['cycle']);
    expect(seen.at(-1)).toEqual({ value: { phase: 'move' }, isLoading: false });
  });

  it('is null while loading or when nothing is stored', () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: true });
    expect(render('cycle').at(-1)).toEqual({ value: null, isLoading: true });
  });
});
