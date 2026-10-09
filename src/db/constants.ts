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

/**
 * Namespace of card_states ids. A card_states id is not random; it is derived from the row's user
 * and card, so two offline devices of the same user pick the same id for a card and converge on one
 * row (Phase 2):
 *
 *   id = UUIDv5(namespace = CARD_STATE_ID_NAMESPACE, name = `${user_id}:${card_id}`)
 *
 * UUIDv5 is RFC 9562 section 5.5: SHA-1 over the 16 namespace bytes followed by the UTF-8 bytes of
 * the name, then the version (5) and variant bits set. user_id and card_id are written in canonical
 * lowercase hyphenated form (what Postgres' uuid::text produces), joined by a single ':'.
 *
 * The server enforces it (CHECK card_states_id_derived in the first migration, using Postgres'
 * uuid_generate_v5): any other id is refused with 23514, so nobody can take another user's id first.
 * Worked example, asserted by supabase/tests/06_study_engine.test.sql and src/db/__tests__/constants.test.ts:
 *   user 11111111-1111-4111-8111-111111111111 + card 70000000-0000-4000-8000-000000000001
 *   -> 57743c5a-f966-538b-bccb-0919027b21c9
 *
 * Never change this value: every stored card_states id depends on it.
 */
export const CARD_STATE_ID_NAMESPACE = 'c4cae30d-9668-4354-adc3-2ee1071432e7';

/** SQLite file name of the local PowerSync database. */
export const DB_FILENAME = 'dualrep.sqlite';

/** Local-only dead-letter table written by the connector (see schema.ts). */
export const UPLOAD_FAILURES_TABLE = 'upload_failures';

/** Local-only key-value table for on-device state such as the running study/move cycle (see schema.ts). */
export const LOCAL_STATE_TABLE = 'local_state';

/** The Phase 0 gate writes its probe rows into this table (any user-private, client-writable table works). */
export const SYNC_CHECK_TABLE = TABLE.study_sessions;

/** Prefix of the probe row's focus_subject, so probe rows are easy to find (and clean up) in Postgres. */
export const SYNC_CHECK_SUBJECT_PREFIX = 'Sync check ';
