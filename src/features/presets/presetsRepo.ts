/**
 * Writes for the user's own presets. Each is one PowerSync write transaction on the phone (works
 * offline; uploaded later). System presets are read-only for every client, so updates and deletes
 * are limited to rows the user owns (`owner_id = ?`), which is also what the server's RLS allows.
 */
import { TABLE } from '@/db/constants';
import { db } from '@/db/database';
import { newId } from '@/lib/ids';
import { isoTimestamp } from '@/lib/time';

import { presetDraftErrors, type PresetDraft } from './presets';

/** Refuses a draft the server would refuse (name length, split CHECK). */
function checked(draft: PresetDraft): { name: string; split: string } {
  const errors = presetDraftErrors(draft);
  const problem = errors.name ?? errors.split;
  if (problem) throw new RangeError(problem);
  const { lower, upper, core, cardio } = draft.split;
  // Always the four keys in the same order, so the JSON text is stable.
  return { name: draft.name.trim(), split: JSON.stringify({ lower, upper, core, cardio }) };
}

export type CreatePresetOptions = {
  /** Also make it the profile's default preset (when the profile has synced). */
  makeDefault?: boolean;
  nowMs?: number;
  id?: string;
};

/** Creates a custom preset and returns its id. */
export async function createPreset(userId: string, draft: PresetDraft, options: CreatePresetOptions = {}): Promise<string> {
  const { name, split } = checked(draft);
  const id = options.id ?? newId();
  const at = isoTimestamp(options.nowMs ?? Date.now());
  await db.writeTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO ${TABLE.presets} (id, owner_id, name, kind, split, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, name, 'custom', split, at, at],
    );
    if (options.makeDefault) {
      await tx.execute(`UPDATE ${TABLE.profiles} SET default_preset_id = ?, updated_at = ? WHERE id = ?`, [id, at, userId]);
    }
  });
  return id;
}

/** Saves a new name and split on one of the user's presets. */
export async function updatePreset(id: string, userId: string, draft: PresetDraft, nowMs: number = Date.now()): Promise<void> {
  const { name, split } = checked(draft);
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${TABLE.presets} SET name = ?, split = ?, updated_at = ? WHERE id = ? AND owner_id = ?`, [
      name,
      split,
      at,
      id,
      userId,
    ]);
  });
}

/**
 * Deletes one of the user's presets. If it was the default, the profile's default is cleared in the
 * same transaction, as the server's ON DELETE SET NULL will do, so the phone does not point at a
 * preset that is gone while offline. (Past workouts keep their preset_id; the server nulls it.)
 */
export async function deletePreset(id: string, userId: string, nowMs: number = Date.now()): Promise<void> {
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`DELETE FROM ${TABLE.presets} WHERE id = ? AND owner_id = ?`, [id, userId]);
    await tx.execute(
      `UPDATE ${TABLE.profiles} SET default_preset_id = NULL, updated_at = ? WHERE id = ? AND default_preset_id = ?`,
      [at, userId, id],
    );
  });
}
