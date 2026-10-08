import { column, Schema, Table, type BaseColumnType } from '@powersync/react-native';

import { LOCAL_STATE_TABLE, UPLOAD_FAILURES_TABLE } from './constants';
import { TABLES, TABLE_NAMES, type ColumnKind, type TableDefinition, type TableName } from './tables';

/**
 * PowerSync stores every synced row as JSON behind a SQLite view, and views only have three column
 * types. Postgres types map onto them as in the SPEC: uuid/text/date/timestamptz/jsonb arrive as TEXT,
 * booleans as INTEGER 0/1, smallint/integer as INTEGER and double precision as REAL.
 */
const COLUMN_BY_KIND = {
  uuid: column.text,
  text: column.text,
  json: column.text,
  timestamp: column.text,
  date: column.text,
  integer: column.integer,
  boolean: column.integer,
  real: column.real,
} as const satisfies Record<ColumnKind, BaseColumnType<string | number | null>>;

type ColumnFor<K extends ColumnKind> = (typeof COLUMN_BY_KIND)[K];
type RegistryColumns<T extends TableName> = (typeof TABLES)[T]['columns'];
type ColumnsFor<T extends TableName> = {
  [C in keyof RegistryColumns<T>]: RegistryColumns<T>[C] extends ColumnKind ? ColumnFor<RegistryColumns<T>[C]> : never;
};
type SyncedTables = { [T in TableName]: Table<ColumnsFor<T>> };

function buildTable(def: TableDefinition): Table {
  const columns = Object.fromEntries(
    Object.entries(def.columns).map(([name, kind]) => [name, COLUMN_BY_KIND[kind]]),
  );
  // The registry keeps index column lists readonly; PowerSync's shorthand wants mutable arrays.
  const indexes = def.indexes
    ? Object.fromEntries(Object.entries(def.indexes).map(([name, cols]) => [name, [...cols]]))
    : undefined;
  return new Table(columns, indexes ? { indexes } : undefined);
}

// The runtime object is built generically from the registry; the mapped type above gives each table
// its precise column types so that `Database['study_sessions']` etc. are fully typed.
const syncedTables = Object.fromEntries(
  TABLE_NAMES.map((name) => [name, buildTable(TABLES[name])]),
) as unknown as SyncedTables;

/**
 * Local-only dead-letter log. When the server rejects an upload for a reason a retry cannot fix
 * (constraint violation, RLS/privilege denial, bad data), the connector records the operation here
 * and drops it from the upload queue so later writes keep flowing. Never synced or uploaded.
 */
const upload_failures = new Table(
  {
    table_name: column.text,
    row_id: column.text,
    op: column.text,
    /** The operation's data as JSON text (what the device tried to send). */
    op_data: column.text,
    error_code: column.text,
    error_message: column.text,
    /** ps_crud id and local transaction id, to correlate with SDK logs. */
    client_id: column.integer,
    transaction_id: column.integer,
    created_at: column.text,
  },
  { localOnly: true, indexes: { by_created: ['created_at'] } },
);

/**
 * Local-only key-value store for state that belongs to this phone, not to the account: the running
 * study/move cycle (its timer's end time, the circuit, where the user is in it), so an app restart or
 * a killed process picks up exactly where it was. `id` is the key; `value` is JSON text. Never synced
 * or uploaded, and cleared with everything else on sign-out (disconnectAndClear clears local-only
 * tables too).
 */
const local_state = new Table(
  {
    value: column.text,
    updated_at: column.text,
  },
  { localOnly: true },
);

export const AppSchema = new Schema({
  ...syncedTables,
  [UPLOAD_FAILURES_TABLE]: upload_failures,
  [LOCAL_STATE_TABLE]: local_state,
});

export type Database = (typeof AppSchema)['types'];
export type TableRow<T extends keyof Database> = Database[T];

export type ProfileRow = Database['profiles'];
export type EntitlementRow = Database['entitlements'];
export type PresetRow = Database['presets'];
export type EquipmentSetupRow = Database['equipment_setups'];
export type ExerciseRow = Database['exercises'];
export type StudySessionRow = Database['study_sessions'];
export type IntervalBlockRow = Database['interval_blocks'];
export type WorkoutSessionRow = Database['workout_sessions'];
export type ExerciseSetRow = Database['exercise_sets'];
export type TransitionRow = Database['transitions'];
export type GroupRow = Database['groups'];
export type GroupMemberRow = Database['group_members'];
export type SourceRow = Database['sources'];
export type SourceFileRow = Database['source_files'];
export type StudyPlanRow = Database['study_plans'];
export type PlanSourceRow = Database['plan_sources'];
export type TopicRow = Database['topics'];
export type CardRow = Database['cards'];
export type CardLinkRow = Database['card_links'];
export type CardStateRow = Database['card_states'];
export type ReviewRow = Database['reviews'];
export type TracyEventRow = Database['tracy_events'];
export type UploadFailure = Database['upload_failures'];
export type LocalStateRow = Database['local_state'];
