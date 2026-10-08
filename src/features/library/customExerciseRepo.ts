import { TABLE } from '@/db/constants';
import { db } from '@/db/database';
import { newId } from '@/lib/ids';

import { exerciseInsert, type ExerciseDraft } from './customExercise';

/**
 * Saves an exercise of the user's own on this phone (works offline; uploaded later) and returns its
 * id. It is in the library, and eligible for default circuits, at once.
 */
export async function createUserExercise(
  userId: string,
  draft: ExerciseDraft,
  options: { nowMs?: number; id?: string } = {},
): Promise<string> {
  const id = options.id ?? newId();
  const { sql, params } = exerciseInsert(userId, draft, id, options.nowMs ?? Date.now());
  await db.writeTransaction(async (tx) => {
    await tx.execute(sql, params);
  });
  return id;
}

/**
 * Deletes one of the user's own exercises. Library rows and other people's exercises are never
 * touched. Logged sets keep the exercise's name (exercise_sets.exercise_name), so history still reads
 * well; the server sets their exercise_id to null.
 */
export async function deleteUserExercise(id: string, userId: string): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute(`DELETE FROM ${TABLE.exercises} WHERE id = ? AND owner_id = ? AND origin = ?`, [id, userId, 'user']);
  });
}
