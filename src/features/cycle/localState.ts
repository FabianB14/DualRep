import { useQuery } from '@powersync/react-native';
import { useMemo } from 'react';

import { LOCAL_STATE_TABLE } from '@/db/constants';
import { db } from '@/db/database';

/**
 * Small on-device key-value store on the local-only `local_state` table (see src/db/schema.ts): the
 * running cycle, the timer-check measurement. Values are JSON text. The table is never synced or
 * uploaded and is cleared with everything else on sign-out, so nothing here outlives the account
 * session on this phone.
 */

type ValueRow = { value: string | null };

/** Parses stored JSON text; null when there is no value or it is not valid JSON. */
export function parseLocalValue<T>(text: string | null | undefined): T | null {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The value stored under `key`, or null when there is none (or it cannot be parsed). */
export async function readLocalState<T>(key: string): Promise<T | null> {
  const row = await db.getOptional<ValueRow>(`SELECT value FROM ${LOCAL_STATE_TABLE} WHERE id = ?`, [key]);
  return parseLocalValue<T>(row?.value);
}

/**
 * Stores `value` (as JSON) under `key`, replacing what was there. One write transaction: PowerSync's
 * tables are views, so instead of an upsert it checks for the row and then updates or inserts it.
 */
export async function writeLocalState(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value ?? null);
  const updatedAt = new Date().toISOString();
  await db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional<{ id: string }>(`SELECT id FROM ${LOCAL_STATE_TABLE} WHERE id = ?`, [key]);
    if (existing) {
      await tx.execute(`UPDATE ${LOCAL_STATE_TABLE} SET value = ?, updated_at = ? WHERE id = ?`, [json, updatedAt, key]);
    } else {
      await tx.execute(`INSERT INTO ${LOCAL_STATE_TABLE} (id, value, updated_at) VALUES (?, ?, ?)`, [
        key,
        json,
        updatedAt,
      ]);
    }
  });
}

export async function deleteLocalState(key: string): Promise<void> {
  await db.execute(`DELETE FROM ${LOCAL_STATE_TABLE} WHERE id = ?`, [key]);
}

/**
 * The value stored under `key`, live: re-renders when it is written. `value` is null while loading
 * and when nothing is stored. Must be used under `PowerSyncContext.Provider`.
 */
export function useLocalState<T>(key: string): { value: T | null; isLoading: boolean } {
  const { data, isLoading } = useQuery<ValueRow>(`SELECT value FROM ${LOCAL_STATE_TABLE} WHERE id = ?`, [key]);
  const text = data[0]?.value ?? null;
  const value = useMemo(() => parseLocalValue<T>(text), [text]);
  return { value, isLoading };
}
