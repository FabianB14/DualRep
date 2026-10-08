// Type-only imports keep this module loadable in unit tests (the runtime SDK needs native modules).
import type {
  CommonPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/react-native';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

import { UPLOAD_FAILURES_TABLE } from './constants';
import {
  isFatalUploadError,
  NoSessionError,
  planOperation,
  uploadErrorCode,
  UploadRequestError,
  type PlannedOperation,
} from './upload';

type FailedOperation = { op: CrudEntry; error: unknown };

/**
 * Connects PowerSync to Supabase: Supabase Auth issues the JWT the PowerSync service accepts
 * (client_auth.supabase in powersync/service.yaml), and local writes are uploaded through the
 * Supabase Data API (PostgREST), so every write passes the same grants and RLS as any other request.
 */
export class SupabaseConnector implements PowerSyncBackendConnector {
  private readonly supabase: SupabaseClient;
  private readonly endpoint: string;

  constructor(supabase: SupabaseClient, powersyncUrl: string) {
    this.supabase = supabase;
    // The SDK rejects an endpoint with a trailing slash; tolerate one in the env var.
    this.endpoint = powersyncUrl.replace(/\/+$/, '');
  }

  /**
   * Called by the SDK whenever it (re)connects or its token is about to expire. getSession() returns
   * the stored session and refreshes the access token first if it has expired, so this always hands
   * PowerSync a currently valid Supabase JWT.
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const { data, error } = await this.supabase.auth.getSession();
    // A refresh that fails (e.g. offline) is transient: throwing makes the SDK retry later.
    if (error) throw error;
    // Signed out: returning null keeps PowerSync disconnected instead of retrying.
    if (!data.session) return null;
    const { access_token, expires_at } = data.session;
    return {
      endpoint: this.endpoint,
      token: access_token,
      expiresAt: expires_at ? new Date(expires_at * 1000) : undefined,
    };
  }

  /**
   * Uploads the oldest local transaction. The SDK calls this repeatedly while the queue is non-empty
   * and, if it throws, retries the same transaction after its retry delay (5 s by default).
   *
   * Nothing is sent without a signed-in session (see below). Every operation is attempted in order.
   * A transient failure (offline, 5xx, any HTTP 401) aborts and rethrows so the whole transaction is
   * retried; the operations already applied are idempotent (upsert / insert-ignore / update / delete
   * by id), so re-sending them is harmless. A fatal failure (see isFatalUploadError) is remembered
   * and the remaining operations still run — each one is a separate request anyway, so there is no
   * atomicity to preserve, and continuing loses less data.
   * Fatal failures are written to the local-only upload_failures table only once the transaction has
   * otherwise succeeded, so a retry never records the same failure twice; then the transaction is
   * completed so later writes are not stuck behind a write that can never succeed.
   */
  async uploadData(database: CommonPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    // Never upload without a signed-in session. The SDK calls uploadData whether or not it has
    // credentials, and with no usable session (refresh token revoked or reused, refresh failed)
    // supabase-js would send the publishable/anon key instead of a user JWT: every write would run as
    // `anon` and be refused. Throwing leaves the transaction queued; the SDK retries after its retry
    // delay, so the writes go up once the same user is signed in again. (A session lost during the
    // requests themselves surfaces as HTTP 401, which isFatalUploadError also treats as retryable.)
    const { data, error } = await this.supabase.auth.getSession();
    if (error) throw error;
    if (!data.session) throw new NoSessionError();

    const failures: FailedOperation[] = [];
    for (const op of transaction.crud) {
      try {
        await this.apply(planOperation(op));
      } catch (error) {
        if (!isFatalUploadError(error)) throw error;
        failures.push({ op, error });
      }
    }

    if (failures.length > 0) await recordUploadFailures(database, failures);
    await transaction.complete();
  }

  private async apply(plan: PlannedOperation): Promise<void> {
    if (plan.method === 'skip') return;
    const table = this.supabase.from(plan.table);
    // supabase-js reports failures as { error, status } rather than throwing; status 0 = no HTTP response.
    // The status goes into the UploadRequestError: isFatalUploadError needs it (a 42501 with HTTP 401
    // means "not signed in" and is retried; with 403 it is a real denial and is dropped).
    let response: { error: PostgrestError | null; status: number };
    switch (plan.method) {
      case 'upsert':
        response = await table.upsert(plan.row, plan.options);
        break;
      case 'update':
        response = await table.update(plan.values).eq('id', plan.id);
        break;
      case 'delete':
        response = await table.delete().eq('id', plan.id);
        break;
    }
    if (response.error) throw new UploadRequestError(response.error, response.status);
  }
}

async function recordUploadFailures(database: CommonPowerSyncDatabase, failures: FailedOperation[]): Promise<void> {
  const createdAt = new Date().toISOString();
  await database.writeTransaction(async (tx) => {
    for (const { op, error } of failures) {
      const code = uploadErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      // Logged as well, so a discarded write shows up in `adb logcat` even if nobody opens the screen.
      console.warn(`[sync] upload of ${op.op} ${op.table}/${op.id} discarded (${code || 'no code'}): ${message}`);
      await tx.execute(
        // uuid() is provided by the PowerSync SQLite extension, so no JS crypto is needed here.
        `INSERT INTO ${UPLOAD_FAILURES_TABLE}
           (id, table_name, row_id, op, op_data, error_code, error_message, client_id, transaction_id, created_at)
         VALUES (uuid(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          op.table,
          op.id,
          op.op,
          op.opData === undefined ? null : JSON.stringify(op.opData),
          code || null,
          message,
          op.clientId,
          op.transactionId ?? null,
          createdAt,
        ],
      );
    }
  });
}
