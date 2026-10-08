import * as SecureStore from 'expo-secure-store';

/**
 * A supabase-js auth storage adapter backed by expo-secure-store (Android Keystore / iOS Keychain), so
 * the refresh token is encrypted at rest instead of sitting in plain AsyncStorage.
 *
 * Three constraints shape it:
 * - Value size: Supabase sessions (access token + refresh token + user JSON) often exceed 2 KB, the
 *   size SecureStore has historically warned about, so each value is split into chunks of at most
 *   CHUNK_SIZE characters. A cut never separates a UTF-16 surrogate pair: a lone surrogate would be
 *   replaced by U+FFFD when stored natively, corrupting the value.
 * - Key charset: only [A-Za-z0-9._-] is allowed. Keys are encoded injectively (see encodeKey), so two
 *   different supabase keys can never collide on the same entries.
 * - Crash safety: the app can be killed between two SecureStore writes. Chunks are written to the
 *   generation ('a' or 'b') the current value is NOT using, and one final write of the index entry
 *   (`<gen>:<count>`) switches to them. A crash before that switch leaves the old value intact; a
 *   crash after it only leaves unreferenced chunks, which the next write cleans up. Losing the session
 *   to a half-written value would sign the user out — and offline they could not sign back in.
 *
 * Committed values are also cached in memory: supabase-js reads the session before every API request,
 * each chunk read is a Keystore decryption, and this process is the only writer of these entries.
 */

export const CHUNK_SIZE = 1800;

/** The subset of expo-secure-store this adapter needs (lets tests substitute an in-memory store). */
export type KeyValueStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/** Structurally compatible with supabase-js `SupportedStorage`. */
export type AsyncStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/**
 * Maps any string onto SecureStore's key charset. Letters, digits and '-' pass through; every other
 * character (including '.' and '_') becomes `_<hex code point>_`. Because '_' is always an escape and
 * '.' never appears in the output, the encoding is injective and '.' is free to separate the suffixes
 * this module appends.
 */
export function encodeKey(key: string): string {
  let out = '';
  for (const char of key) {
    out += /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`;
  }
  // SecureStore rejects an empty key.
  return out === '' ? '_empty_' : out;
}

/** Splits into pieces of at most `size` UTF-16 units without separating a surrogate pair. */
export function splitIntoChunks(value: string, size = CHUNK_SIZE): string[] {
  if (size < 2) throw new Error('chunk size must be at least 2');
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + size, value.length);
    const last = value.charCodeAt(end - 1);
    // A high surrogate at the cut would be separated from its low surrogate: cut one earlier.
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  // An empty string is still a stored value (one empty chunk), distinct from "no value".
  return chunks.length > 0 ? chunks : [''];
}

type Generation = 'a' | 'b';
type Index = { generation: Generation; count: number };

const indexKey = (base: string) => `${base}.n`;
const chunkKey = (base: string, generation: Generation, index: number) => `${base}.${generation}${index}`;

function parseIndex(raw: string | null): Index | null {
  const match = raw === null ? null : /^([ab]):(\d+)$/.exec(raw);
  if (!match) return null;
  return { generation: match[1] as Generation, count: Number(match[2]) };
}

export function createChunkedSecureStorage(store: KeyValueStore, chunkSize = CHUNK_SIZE): AsyncStorageAdapter {
  /** Last committed value per encoded key (null = known absent). Absent from the map = not read yet. */
  const cache = new Map<string, string | null>();
  // Operations on one key run one at a time, so an overlapping set/remove pair (e.g. a token refresh
  // racing a sign-out) cannot interleave their writes.
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(base: string, task: () => Promise<T>): Promise<T> => {
    const run = (queues.get(base) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    queues.set(base, settled);
    // Drop the entry once idle so the map does not grow with every key ever used.
    void settled.then(() => {
      if (queues.get(base) === settled) queues.delete(base);
    });
    return run;
  };

  /** Deletes chunks of one generation from `from` up to the first one that does not exist. */
  const deleteChunksFrom = async (base: string, generation: Generation, from: number) => {
    for (let index = from; (await store.getItemAsync(chunkKey(base, generation, index))) !== null; index += 1) {
      await store.deleteItemAsync(chunkKey(base, generation, index));
    }
  };

  const readCommitted = async (base: string): Promise<string | null> => {
    const current = parseIndex(await store.getItemAsync(indexKey(base)));
    if (!current) return null;
    const parts: string[] = [];
    for (let index = 0; index < current.count; index += 1) {
      const part = await store.getItemAsync(chunkKey(base, current.generation, index));
      // Only possible if the store lost an entry; report "no value" rather than a truncated one.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  };

  return {
    getItem(key) {
      const base = encodeKey(key);
      return serialize(base, async () => {
        const cached = cache.get(base);
        if (cached !== undefined) return cached;
        const value = await readCommitted(base);
        cache.set(base, value);
        return value;
      });
    },

    setItem(key, value) {
      const base = encodeKey(key);
      return serialize(base, async () => {
        // Forget the cached value until this write is committed: if it fails part-way, the next read
        // goes back to the store, which still holds the old value (or the new one, if the switch landed).
        cache.delete(base);
        const current = parseIndex(await store.getItemAsync(indexKey(base)));
        const next: Generation = current?.generation === 'a' ? 'b' : 'a';
        const chunks = splitIntoChunks(value, chunkSize);
        for (let index = 0; index < chunks.length; index += 1) {
          await store.setItemAsync(chunkKey(base, next, index), chunks[index]);
        }
        // Leftovers from an interrupted earlier write to this generation, beyond the new value's end.
        await deleteChunksFrom(base, next, chunks.length);
        // The switch: from here on readers get the new value.
        await store.setItemAsync(indexKey(base), `${next}:${chunks.length}`);
        cache.set(base, value);
        // The previous value's chunks are now unreferenced; remove them so old tokens do not linger.
        await deleteChunksFrom(base, next === 'a' ? 'b' : 'a', 0);
      });
    },

    removeItem(key) {
      const base = encodeKey(key);
      return serialize(base, async () => {
        cache.delete(base);
        // Index first: from this point on readers see "no value" even if deleting a chunk fails.
        await store.deleteItemAsync(indexKey(base));
        cache.set(base, null);
        await deleteChunksFrom(base, 'a', 0);
        await deleteChunksFrom(base, 'b', 0);
      });
    },
  };
}

/** The app's auth storage, on the device's secure store. */
export const secureStorage: AsyncStorageAdapter = createChunkedSecureStorage({
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
});
