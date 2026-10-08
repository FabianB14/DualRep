import { TABLE_NAMES, type TableName } from './tables';

/** Synced table names as constants (`TABLE.study_sessions === 'study_sessions'`), for SQL strings. */
export const TABLE = Object.freeze(
  Object.fromEntries(TABLE_NAMES.map((name) => [name, name])) as { readonly [K in TableName]: K },
);

/**
 * Fixed ids of the six system presets. They are seeded by the first migration (production needs
 * them), so the device can reference them before the first sync completes.
 */
export const SYSTEM_PRESET_IDS = {
  all_lower: '00000000-0000-4000-8000-0000000000a1',
  mostly_lower: '00000000-0000-4000-8000-0000000000a2',
  full_body: '00000000-0000-4000-8000-0000000000a3',
  mostly_upper: '00000000-0000-4000-8000-0000000000a4',
  all_upper: '00000000-0000-4000-8000-0000000000a5',
  mostly_cardio: '00000000-0000-4000-8000-0000000000a6',
} as const;

export type SystemPresetKind = keyof typeof SYSTEM_PRESET_IDS;

/** SQLite file name of the local PowerSync database. */
export const DB_FILENAME = 'dualrep.sqlite';

/** Local-only dead-letter table written by the connector (see schema.ts). */
export const UPLOAD_FAILURES_TABLE = 'upload_failures';

/** The Phase 0 gate writes its probe rows into this table (any user-private, client-writable table works). */
export const SYNC_CHECK_TABLE = TABLE.study_sessions;

/** Prefix of the probe row's focus_subject, so probe rows are easy to find (and clean up) in Postgres. */
export const SYNC_CHECK_SUBJECT_PREFIX = 'Sync check ';
