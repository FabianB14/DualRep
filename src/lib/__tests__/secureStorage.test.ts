import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';

import {
  CHUNK_SIZE,
  createChunkedSecureStorage,
  encodeKey,
  secureStorage as appSecureStorage,
  splitIntoChunks,
  type AsyncStorageAdapter,
  type KeyValueStore,
} from '../secureStorage';

// An in-memory stand-in for expo-secure-store that enforces its key rule, so a key the real store would
// reject fails here too. jest hoists this above the imports; `mock`-prefixed names may be referenced.
const mockEntries = new Map<string, string>();
const mockAssertKey = (key: string) => {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`Invalid SecureStore key: ${key}`);
};
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    mockAssertKey(key);
    return mockEntries.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    mockAssertKey(key);
    mockEntries.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockAssertKey(key);
    mockEntries.delete(key);
  },
}));

const SESSION_KEY = 'sb-abcdefghijklmnop-auth-token';

/** A realistic large value: a session-like JSON blob several chunks long, with non-ASCII text. */
function longValue(length: number): string {
  const unit = JSON.stringify({ access_token: 'eyJ'.padEnd(120, 'x'), name: 'Zoë 🏋️ 学习' });
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

// A fresh adapter per test (its in-memory cache must not carry over), on the mocked expo-secure-store.
let secureStorage: AsyncStorageAdapter;
beforeEach(() => {
  mockEntries.clear();
  secureStorage = createChunkedSecureStorage(SecureStore);
});

describe('chunked SecureStore adapter', () => {
  it('is what the app uses, wired to expo-secure-store', async () => {
    await appSecureStorage.setItem('wiring-check', 'value');
    expect([...mockEntries.keys()].some((key) => key.startsWith('wiring-check.'))).toBe(true);
    await expect(appSecureStorage.getItem('wiring-check')).resolves.toBe('value');
    await appSecureStorage.removeItem('wiring-check');
    expect(mockEntries.size).toBe(0);
  });

  it('returns null for a key that was never set', async () => {
    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBeNull();
  });

  it('round-trips a short value', async () => {
    await secureStorage.setItem(SESSION_KEY, 'short');
    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBe('short');
  });

  it('round-trips an empty string as a value, not as "missing"', async () => {
    await secureStorage.setItem(SESSION_KEY, '');
    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBe('');
  });

  it('round-trips a long value across several chunks of at most CHUNK_SIZE characters', async () => {
    const value = longValue(CHUNK_SIZE * 3 + 17);
    await secureStorage.setItem(SESSION_KEY, value);
    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBe(value);

    const values = [...mockEntries.values()];
    expect(values.length).toBeGreaterThanOrEqual(5); // index + 4 chunks
    for (const stored of values) expect(stored.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('removes stale chunks when a long value is overwritten by a short one', async () => {
    await secureStorage.setItem(SESSION_KEY, longValue(CHUNK_SIZE * 4));
    expect(mockEntries.size).toBe(1 + 4);

    await secureStorage.setItem(SESSION_KEY, 'short');
    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBe('short');
    expect(mockEntries.size).toBe(1 + 1);
    expect([...mockEntries.values()].join('')).not.toContain('access_token');
  });

  it('overwrites short with long and back repeatedly without leaking entries', async () => {
    for (let round = 0; round < 4; round += 1) {
      const value = round % 2 === 0 ? longValue(CHUNK_SIZE * 2 + 1) : `v${round}`;
      await secureStorage.setItem(SESSION_KEY, value);
      await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBe(value);
    }
    expect(mockEntries.size).toBe(1 + 1);
  });

  it('removeItem clears every entry for the key', async () => {
    await secureStorage.setItem(SESSION_KEY, longValue(CHUNK_SIZE * 3));
    await secureStorage.setItem('other', 'kept');
    await secureStorage.removeItem(SESSION_KEY);

    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBeNull();
    await expect(secureStorage.getItem('other')).resolves.toBe('kept');
    expect([...mockEntries.keys()].every((key) => key.startsWith(encodeKey('other')))).toBe(true);
  });

  it('removing a missing key is a no-op', async () => {
    await expect(secureStorage.removeItem('never-set')).resolves.toBeUndefined();
  });

  it('accepts keys with characters SecureStore forbids', async () => {
    const key = 'sb:project/ref auth@token';
    await secureStorage.setItem(key, 'value');
    await expect(secureStorage.getItem(key)).resolves.toBe('value');
    for (const stored of mockEntries.keys()) expect(stored).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('keeps keys distinct even when they differ only in forbidden characters', async () => {
    await secureStorage.setItem('a:b', 'colon');
    await secureStorage.setItem('a/b', 'slash');
    await secureStorage.setItem('a_b', 'underscore');
    await secureStorage.setItem('a.b', 'dot');
    await expect(secureStorage.getItem('a:b')).resolves.toBe('colon');
    await expect(secureStorage.getItem('a/b')).resolves.toBe('slash');
    await expect(secureStorage.getItem('a_b')).resolves.toBe('underscore');
    await expect(secureStorage.getItem('a.b')).resolves.toBe('dot');
  });

  it('serializes overlapping writes to one key (last call wins, nothing mixed)', async () => {
    const long = longValue(CHUNK_SIZE * 3);
    await Promise.all([
      secureStorage.setItem(SESSION_KEY, long),
      secureStorage.removeItem(SESSION_KEY),
      secureStorage.setItem(SESSION_KEY, 'final'),
    ]);
    await expect(secureStorage.getItem(SESSION_KEY)).resolves.toBe('final');
    expect(mockEntries.size).toBe(1 + 1);
  });
});

describe('in-memory cache', () => {
  function countingStore() {
    const entries = new Map<string, string>();
    const reads = { count: 0 };
    const store: KeyValueStore = {
      getItemAsync: async (key) => {
        reads.count += 1;
        return entries.get(key) ?? null;
      },
      setItemAsync: async (key, value) => {
        entries.set(key, value);
      },
      deleteItemAsync: async (key) => {
        entries.delete(key);
      },
    };
    return { entries, reads, store };
  }

  it('serves repeat reads without touching the store', async () => {
    const { reads, store } = countingStore();
    const storage = createChunkedSecureStorage(store, 10);
    await storage.setItem('k', 'a value that spans several chunks');
    reads.count = 0;
    await expect(storage.getItem('k')).resolves.toBe('a value that spans several chunks');
    await expect(storage.getItem('k')).resolves.toBe('a value that spans several chunks');
    expect(reads.count).toBe(0);
  });

  it('reads the store once for a value written by an earlier app session', async () => {
    const { entries, reads, store } = countingStore();
    await createChunkedSecureStorage(store, 10).setItem('k', 'from last launch');
    const storage = createChunkedSecureStorage(store, 10); // a new launch: empty cache
    reads.count = 0;
    await expect(storage.getItem('k')).resolves.toBe('from last launch');
    const firstReads = reads.count;
    await expect(storage.getItem('k')).resolves.toBe('from last launch');
    expect(firstReads).toBeGreaterThan(0);
    expect(reads.count).toBe(firstReads);
    expect(entries.size).toBe(1 + 2);
  });

  it('remembers removals', async () => {
    const { reads, store } = countingStore();
    const storage = createChunkedSecureStorage(store, 10);
    await storage.setItem('k', 'v');
    await storage.removeItem('k');
    reads.count = 0;
    await expect(storage.getItem('k')).resolves.toBeNull();
    expect(reads.count).toBe(0);
  });
});

describe('crash safety', () => {
  it('keeps the previous value when the app dies before the new value is committed', async () => {
    const entries = new Map<string, string>();
    let writesLeft = Infinity;
    const store = {
      getItemAsync: async (key: string) => entries.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => {
        if (writesLeft-- <= 0) throw new Error('killed');
        entries.set(key, value);
      },
      deleteItemAsync: async (key: string) => {
        entries.delete(key);
      },
    };
    const storage = createChunkedSecureStorage(store, 10);
    await storage.setItem('k', 'old value that spans chunks');

    writesLeft = 2; // dies after writing two chunks of the new value
    await expect(storage.setItem('k', 'a brand new value, longer than before')).rejects.toThrow('killed');
    await expect(storage.getItem('k')).resolves.toBe('old value that spans chunks');

    writesLeft = Infinity; // the next write succeeds and leaves no orphans behind
    await storage.setItem('k', 'next');
    await expect(storage.getItem('k')).resolves.toBe('next');
    expect(entries.size).toBe(1 + 1);
  });
});

describe('encodeKey', () => {
  it('passes letters, digits and dashes through', () => {
    expect(encodeKey('sb-abc123-auth-token')).toBe('sb-abc123-auth-token');
  });

  it('escapes everything else, including . and _', () => {
    expect(encodeKey('a.b_c:d')).toBe('a_2e_b_5f_c_3a_d');
    expect(encodeKey('é')).toBe('_e9_');
    expect(encodeKey('🏋')).toBe('_1f3cb_');
    expect(encodeKey('')).toBe('_empty_');
  });
});

describe('splitIntoChunks', () => {
  it('splits at the size limit', () => {
    expect(splitIntoChunks('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(splitIntoChunks('', 3)).toEqual(['']);
  });

  it('never separates a surrogate pair', () => {
    const value = 'ab😀cd😀';
    const chunks = splitIntoChunks(value, 3);
    expect(chunks.join('')).toBe(value);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3);
      // Every chunk is well-formed UTF-16 (no lone surrogates).
      expect(chunk.isWellFormed()).toBe(true);
    }
  });
});
