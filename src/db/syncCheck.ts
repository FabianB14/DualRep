/**
 * Helpers for the Phase 0 gate (the Sync Check screen): a row written offline on the phone must reach
 * Postgres after reconnecting. The screen creates a probe row, watches the upload queue drain, and
 * then asks the server directly — through the Supabase Data API, not through PowerSync — whether the
 * row exists, which is what proves the round trip.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { newId } from '../lib/ids';
import { SYNC_CHECK_SUBJECT_PREFIX, SYNC_CHECK_TABLE, UPLOAD_FAILURES_TABLE } from './constants';
import { db } from './database';
import type { UploadFailure } from './schema';

export type { UploadFailure } from './schema';

export type ServerCheckResult = 'found' | 'missing' | 'offline' | 'error';

/**
 * Inserts a study_sessions row for the user. This is a purely local write (works in airplane mode):
 * PowerSync queues it and uploads it whenever a connection is available.
 */
export async function createProbeRow(userId: string): Promise<{ id: string; createdAt: string }> {
  const id = newId();
  const createdAt = new Date().toISOString();
  await db.execute(
    `INSERT INTO ${SYNC_CHECK_TABLE} (id, user_id, focus_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, userId, `${SYNC_CHECK_SUBJECT_PREFIX}${createdAt}`, createdAt, createdAt],
  );
  return { id, createdAt };
}

/** Number of local writes not yet acknowledged by the server. */
export async function getUploadQueueCount(): Promise<number> {
  const stats = await db.getUploadQueueStats();
  return stats.count;
}

/** Writes the server rejected for good (newest first); see SupabaseConnector.uploadData. */
export function getUploadFailures(): Promise<UploadFailure[]> {
  return db.getAll<UploadFailure>(`SELECT * FROM ${UPLOAD_FAILURES_TABLE} ORDER BY created_at DESC`);
}

/**
 * Reads the row straight from Postgres through PostgREST (subject to the same RLS as everything else).
 * 'offline' means the request got no HTTP response at all (supabase-js reports status 0).
 */
export async function verifyOnServer(supabase: SupabaseClient, id: string): Promise<ServerCheckResult> {
  try {
    const { data, error, status } = await supabase.from(SYNC_CHECK_TABLE).select('id').eq('id', id).maybeSingle();
    if (error) return status === 0 ? 'offline' : 'error';
    return data ? 'found' : 'missing';
  } catch {
    return 'error';
  }
}
