/**
 * Pure helpers for uploading PowerSync's local write queue to Supabase. No I/O happens here: the
 * connector asks `planOperation` what to send, sends it, and asks `isFatalUploadError` what to do
 * when it fails. Keeping this pure makes every table's write policy unit-testable.
 */
// Type-only imports: the runtime package pulls in native modules that unit tests cannot load.
import type { CrudEntry, UpdateType } from '@powersync/react-native';

import { TABLES, isTableName, type ColumnKind, type TableDefinition, type TableName } from './tables';

/** 'PUT' | 'PATCH' | 'DELETE' — the string values of PowerSync's UpdateType enum. */
type OpKind = `${UpdateType}`;

export type PostgresValue = string | number | boolean | null | PostgresJson;
type PostgresJson = { [key: string]: unknown } | unknown[];
export type PostgresRow = Record<string, PostgresValue>;

/** What the connector should send through supabase-js for one queued operation. */
export type PlannedOperation =
  | {
      method: 'upsert';
      table: TableName;
      row: PostgresRow;
      /** ignoreDuplicates: true = `ON CONFLICT (id) DO NOTHING` (insert-ignore). */
      options: { onConflict: 'id'; ignoreDuplicates: boolean };
    }
  | { method: 'update'; table: TableName; id: string; values: PostgresRow }
  | { method: 'delete'; table: TableName; id: string }
  /** Nothing left to send (e.g. a PATCH that only touched server-maintained columns). */
  | { method: 'skip'; table: TableName; id: string; reason: string };

/** The fields of a CrudEntry that planning needs (lets tests build plain objects). */
export type QueuedOperation = Pick<CrudEntry, 'id' | 'op' | 'opData' | 'table'>;

/**
 * Codes for writes refused on the device before upload. They are deterministic — retrying can never
 * succeed — so they are always fatal: the connector records them in `upload_failures` and moves on.
 */
export type UploadPlanErrorCode =
  | 'DUALREP_UNKNOWN_TABLE'
  | 'DUALREP_UNKNOWN_COLUMN'
  | 'DUALREP_WRITE_NOT_ALLOWED'
  | 'DUALREP_INVALID_VALUE';

export class UploadPlanError extends Error {
  readonly code: UploadPlanErrorCode;

  constructor(code: UploadPlanErrorCode, message: string) {
    super(message);
    this.name = 'UploadPlanError';
    this.code = code;
  }
}

/**
 * Columns the server maintains itself. `updated_at` is overwritten by the set_updated_at() trigger
 * on every UPDATE, so sending it in a PATCH achieves nothing — and on tables with column-level UPDATE
 * grants (groups: name only, tracy_events: accepted only) it would turn a valid rename into a 42501.
 */
const SERVER_MAINTAINED_ON_PATCH = new Set(['updated_at']);

function definitionOf(table: string): TableDefinition {
  if (!isTableName(table)) {
    throw new UploadPlanError('DUALREP_UNKNOWN_TABLE', `Table "${table}" is not a synced table`);
  }
  return TABLES[table];
}

function convertValue(table: string, columnName: string, kind: ColumnKind, value: unknown): PostgresValue {
  if (value === null) return null;
  switch (kind) {
    case 'json':
      // jsonb arrives on the device as JSON text. Sent as a string, PostgREST would store a JSON
      // *string* (silently wrong), so parse it back into a value; reject text that is not JSON.
      if (typeof value !== 'string') return value as PostgresValue;
      try {
        return JSON.parse(value) as PostgresValue;
      } catch {
        throw new UploadPlanError(
          'DUALREP_INVALID_VALUE',
          `${table}.${columnName} is a json column but holds text that is not valid JSON`,
        );
      }
    case 'boolean':
      // SQLite has no boolean type: booleans are stored as INTEGER 0/1 on the device.
      if (value === 0 || value === 1) return value === 1;
      if (typeof value === 'boolean') return value;
      throw new UploadPlanError(
        'DUALREP_INVALID_VALUE',
        `${table}.${columnName} is a boolean column but holds ${JSON.stringify(value)}`,
      );
    default:
      return value as PostgresValue;
  }
}

/**
 * Converts a row (or the changed columns of a row) from its SQLite form to what PostgREST expects:
 * JSON text → JSON values, 0/1 → false/true. `id` is dropped (the caller adds `op.id` where needed).
 *
 * Unknown columns are rejected rather than passed through or stripped: the local schema is built from
 * the same registry, so an unknown column means the code and the registry disagree. Passing it on would
 * fail with PGRST204 (a retryable-looking error that would block the queue forever); stripping it would
 * lose data silently. Rejecting records the whole operation in `upload_failures`, where it is visible.
 */
export function toPostgresRow(table: string, data: Readonly<Record<string, unknown>> | undefined): PostgresRow {
  const def = definitionOf(table);
  const columns: Readonly<Record<string, ColumnKind>> = def.columns;
  const row: PostgresRow = {};
  for (const [name, value] of Object.entries(data ?? {})) {
    if (name === 'id' || value === undefined) continue;
    const kind = columns[name];
    if (kind === undefined) {
      throw new UploadPlanError('DUALREP_UNKNOWN_COLUMN', `Column "${name}" is not in the registry for ${table}`);
    }
    row[name] = convertValue(table, name, kind, value);
  }
  return row;
}

/** Turns one queued local write into the supabase-js call that applies it, enforcing the table's WritePolicy. */
export function planOperation(op: QueuedOperation): PlannedOperation {
  const def = definitionOf(op.table);
  const table = op.table as TableName;
  const { writes } = def;
  const serverGenerated: readonly string[] = writes.serverGenerated ?? [];
  const kind: OpKind = op.op;

  switch (kind) {
    case 'PUT': {
      if (writes.put === false) {
        throw new UploadPlanError('DUALREP_WRITE_NOT_ALLOWED', `The device may not create rows in ${table}`);
      }
      const row = toPostgresRow(table, op.opData);
      // The server fills these in itself and grants the client no privilege on them (groups.invite_code):
      // sending one, even as null, would make the whole insert fail with 42501.
      for (const name of serverGenerated) delete row[name];
      return {
        method: 'upsert',
        table,
        row: { ...row, id: op.id },
        options: { onConflict: 'id', ignoreDuplicates: writes.put === 'insert-ignore' },
      };
    }

    case 'PATCH': {
      if (writes.patch === false) {
        throw new UploadPlanError('DUALREP_WRITE_NOT_ALLOWED', `The device may not update rows in ${table}`);
      }
      const values = toPostgresRow(table, op.opData);
      for (const name of SERVER_MAINTAINED_ON_PATCH) delete values[name];
      const generated = serverGenerated.filter((name) => name in values).map((name) => `${table}.${name}`);
      if (generated.length > 0) {
        throw new UploadPlanError(
          'DUALREP_WRITE_NOT_ALLOWED',
          `${generated.join(', ')}: generated by the server; the device may not change it`,
        );
      }
      if (Array.isArray(writes.patch)) {
        const allowed: readonly string[] = writes.patch;
        const forbidden = Object.keys(values).filter((name) => !allowed.includes(name));
        if (forbidden.length > 0) {
          throw new UploadPlanError(
            'DUALREP_WRITE_NOT_ALLOWED',
            `The device may only update ${allowed.join(', ')} in ${table}, not ${forbidden.join(', ')}`,
          );
        }
      }
      if (Object.keys(values).length === 0) {
        return { method: 'skip', table, id: op.id, reason: 'no client-writable columns changed' };
      }
      return { method: 'update', table, id: op.id, values };
    }

    case 'DELETE': {
      if (!writes.delete) {
        throw new UploadPlanError('DUALREP_WRITE_NOT_ALLOWED', `The device may not delete rows in ${table}`);
      }
      return { method: 'delete', table, id: op.id };
    }

    default: {
      const unexpected: never = kind;
      throw new UploadPlanError('DUALREP_WRITE_NOT_ALLOWED', `Unknown operation ${String(unexpected)}`);
    }
  }
}

/**
 * A failed PostgREST call, carrying the Postgres SQLSTATE or PostgREST code and the HTTP status
 * (0 = the request never got a response: offline, DNS, TLS, timeout).
 */
export class UploadRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(
    error: { message?: string; code?: string; details?: string | null; hint?: string | null },
    status: number,
  ) {
    super(error.message || `Upload failed with HTTP ${status}`);
    this.name = 'UploadRequestError';
    this.code = error.code ?? '';
    this.status = status;
    this.details = error.details ?? null;
    this.hint = error.hint ?? null;
  }
}

/**
 * Thrown by the connector instead of uploading when supabase-js has no signed-in session. Never
 * fatal: the transaction stays queued and the SDK retries it until the same user signs in again.
 */
export class NoSessionError extends Error {
  constructor() {
    super('No signed-in Supabase session; the upload waits until the user signs in again');
    this.name = 'NoSessionError';
  }
}

/** The SQLSTATE / PostgREST / DualRep code of an error, or '' when it has none. */
export function uploadErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err as { code: unknown };
    if (typeof code === 'string') return code;
  }
  return '';
}

/** The HTTP status of an error (UploadRequestError.status), or 0 when it has none. */
function uploadErrorStatus(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const { status } = err as { status: unknown };
    if (typeof status === 'number') return status;
  }
  return 0;
}

/** Postgres SQLSTATEs that no retry can fix: class 22 (data exception), class 23 (integrity violation). */
const FATAL_SQLSTATE = /^(22|23)[0-9A-Z]{3}$/;

/**
 * Should a failed upload be dropped from the queue (true) or retried by the SDK (false)?
 *
 * PowerSync uploads strictly in order, so an operation that can never succeed must be removed or
 * every later write stays stuck behind it. Fatal: invalid data (22xxx), constraint violations
 * (23xxx), RLS/privilege denial for a signed-in user (42501, which PostgREST sends as HTTP 403) and
 * anything refused locally by `planOperation`.
 * Everything else is assumed transient and retried, because dropping a write that would have
 * succeeded loses data: offline, 5xx, other PGRST codes, unknown errors, and ANY HTTP 401. A 401
 * means the request did not run as the user — an expired JWT (PGRST301/303), or no usable session at
 * all, in which case supabase-js sends the publishable/anon key and PostgREST answers 401 with code
 * 42501 because `anon` has no grants. Neither says anything about the write itself, so it waits
 * until the same user is signed in again.
 */
export function isFatalUploadError(err: unknown): boolean {
  if (err instanceof UploadPlanError) return true;
  const code = uploadErrorCode(err);
  if (code.startsWith('DUALREP_')) return true;
  if (uploadErrorStatus(err) === 401) return false;
  return FATAL_SQLSTATE.test(code) || code === '42501';
}
