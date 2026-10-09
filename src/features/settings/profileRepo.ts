import { TABLE } from '@/db/constants';
import { db } from '@/db/database';

import { profileUpdate, type ProfilePatch } from './profile';

/**
 * Saves settings on the profile row, on this phone (PowerSync uploads the change later, so it works
 * offline). The row is created by the server and arrives with the first sync; until it has, nothing is
 * written and this resolves to false (the device never inserts a profile). One write transaction, so
 * the existence check and the update cannot be split by a sync.
 */
export async function updateProfile(userId: string, patch: ProfilePatch, nowMs: number = Date.now()): Promise<boolean> {
  const { sql, params } = profileUpdate(userId, patch, nowMs);
  return db.writeTransaction(async (tx) => {
    const row = await tx.getOptional<{ id: string }>(`SELECT id FROM ${TABLE.profiles} WHERE id = ?`, [userId]);
    if (!row) return false;
    await tx.execute(sql, params);
    return true;
  });
}
