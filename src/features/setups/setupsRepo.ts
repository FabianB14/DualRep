/**
 * Writes for equipment setups. Each is one PowerSync write transaction on the phone (works offline;
 * uploaded later), limited to the user's own rows (`user_id = ?`), which is what the server's RLS
 * allows too.
 */
import { TABLE } from '@/db/constants';
import { db } from '@/db/database';
import { normalizeEquipmentList } from '@/features/training/equipment';
import { newId } from '@/lib/ids';
import { isoTimestamp } from '@/lib/time';

import { setupDraftErrors, templateDraft, type SetupDraft, type SetupTemplate } from './setups';

/** Refuses a draft the server would refuse; returns the values as stored. */
function checked(draft: SetupDraft): { name: string; location: string; equipment: string } {
  const problem = setupDraftErrors(draft).name;
  if (problem) throw new RangeError(problem);
  if (draft.location !== 'gym' && draft.location !== 'home') {
    throw new RangeError(`location must be gym or home, got ${String(draft.location)}`);
  }
  return {
    name: draft.name.trim(),
    location: draft.location,
    equipment: JSON.stringify(normalizeEquipmentList(draft.equipment)),
  };
}

export type CreateSetupOptions = {
  /**
   * Also make it the profile's default setup. Only takes effect once the profile row has synced
   * (the UPDATE matches no row before that, and the device never creates the profile).
   */
  makeDefault?: boolean;
  nowMs?: number;
  id?: string;
};

/** Creates a setup and returns its id. */
export async function createSetup(userId: string, draft: SetupDraft, options: CreateSetupOptions = {}): Promise<string> {
  const values = checked(draft);
  const id = options.id ?? newId();
  const at = isoTimestamp(options.nowMs ?? Date.now());
  await db.writeTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO ${TABLE.equipment_setups} (id, user_id, name, location, equipment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, values.name, values.location, values.equipment, at, at],
    );
    if (options.makeDefault) {
      await tx.execute(`UPDATE ${TABLE.profiles} SET default_setup_id = ?, updated_at = ? WHERE id = ?`, [id, at, userId]);
    }
  });
  return id;
}

/**
 * One tap: a setup from a template ("Home, just my body", "Gym"), named so it does not repeat one of
 * `takenNames`. Returns its id. Used by the setups screens and the cycle screen's first-run choice.
 */
export function createSetupFromTemplate(
  userId: string,
  template: SetupTemplate,
  takenNames: readonly string[] = [],
  options: CreateSetupOptions = {},
): Promise<string> {
  return createSetup(userId, templateDraft(template, takenNames), options);
}

/** Saves a setup's name, location and equipment. */
export async function updateSetup(id: string, userId: string, draft: SetupDraft, nowMs: number = Date.now()): Promise<void> {
  const values = checked(draft);
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    await tx.execute(
      `UPDATE ${TABLE.equipment_setups} SET name = ?, location = ?, equipment = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.name, values.location, values.equipment, at, id, userId],
    );
  });
}

/**
 * Deletes a setup. If it was the default, the profile's default is cleared in the same transaction
 * (as the server's ON DELETE SET NULL will do), so the phone never points at a setup that is gone.
 * Past workouts keep their setup_id until the server nulls it; history does not depend on it.
 */
export async function deleteSetup(id: string, userId: string, nowMs: number = Date.now()): Promise<void> {
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`DELETE FROM ${TABLE.equipment_setups} WHERE id = ? AND user_id = ?`, [id, userId]);
    await tx.execute(
      `UPDATE ${TABLE.profiles} SET default_setup_id = NULL, updated_at = ? WHERE id = ? AND default_setup_id = ?`,
      [at, userId, id],
    );
  });
}
