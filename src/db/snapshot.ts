/**
 * Reader for supabase/schema.snapshot.json, the machine-readable copy of the Postgres schema that
 * `npm run db:test` writes after applying every migration to a throwaway Postgres.
 *
 * Used only by tooling — `scripts/validate-sync-config.mjs` (which imports this file directly with
 * Node's type stripping, so it must stay import-free and use only erasable TypeScript) and the
 * registry-drift test. App code never imports it.
 */

/** Normalized column types written by db:test (smallint→integer, double precision→real, jsonb→json, timestamptz→timestamp). */
export type SnapshotColumnType =
  | 'uuid'
  | 'text'
  | 'integer'
  | 'real'
  | 'boolean'
  | 'json'
  | 'timestamp'
  | 'date'
  | 'vector';

export type SnapshotColumn = { name: string; type: SnapshotColumnType };
export type SnapshotTables = Map<string, SnapshotColumn[]>;

/**
 * Raw Postgres spellings accepted as well, in case a snapshot was written without normalizing.
 * Anything not listed (notably `numeric`, which would reach the device as TEXT) is an error.
 */
const TYPE_ALIASES: Record<string, SnapshotColumnType> = {
  uuid: 'uuid',
  text: 'text',
  'character varying': 'text',
  varchar: 'text',
  integer: 'integer',
  int: 'integer',
  int2: 'integer',
  int4: 'integer',
  smallint: 'integer',
  real: 'real',
  float4: 'real',
  float8: 'real',
  'double precision': 'real',
  boolean: 'boolean',
  bool: 'boolean',
  json: 'json',
  jsonb: 'json',
  timestamp: 'timestamp',
  timestamptz: 'timestamp',
  'timestamp with time zone': 'timestamp',
  date: 'date',
  vector: 'vector',
};

/** Postgres type names for @powersync/service-sync-rules' StaticSchema (`pg_type`). */
export const PG_TYPE_FOR_SNAPSHOT_TYPE: Record<SnapshotColumnType, string> = {
  uuid: 'uuid',
  text: 'text',
  integer: 'int4',
  real: 'float8',
  boolean: 'bool',
  json: 'jsonb',
  timestamp: 'timestamptz',
  date: 'date',
  vector: 'vector',
};

export function normalizeColumnType(raw: string): SnapshotColumnType | undefined {
  const key = raw.trim().toLowerCase().replace(/\(.*\)$/, '');
  return Object.prototype.hasOwnProperty.call(TYPE_ALIASES, key) ? TYPE_ALIASES[key] : undefined;
}

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readColumns(table: string, raw: Json): SnapshotColumn[] {
  // Columns as an ordered array of { name, type, ... } (the documented shape) ...
  const entries: [string, Json][] = Array.isArray(raw)
    ? raw.map((col, i) => {
        if (!isRecord(col) || typeof col.name !== 'string') {
          throw new Error(`snapshot: column #${i} of ${table} has no name`);
        }
        return [col.name, col];
      })
    : // ... or as an object keyed by column name.
      isRecord(raw)
      ? Object.entries(raw)
      : [];
  if (entries.length === 0) throw new Error(`snapshot: table ${table} has no columns`);

  return entries.map(([name, col]) => {
    const rawType = typeof col === 'string' ? col : isRecord(col) ? (col.type ?? col.data_type) : undefined;
    if (typeof rawType !== 'string') throw new Error(`snapshot: column ${table}.${name} has no type`);
    const type = normalizeColumnType(rawType);
    if (!type) throw new Error(`snapshot: column ${table}.${name} has unsupported type "${rawType}"`);
    return { name, type };
  });
}

/**
 * Parses the snapshot JSON into table → columns. Accepts the table map either at `tables` (or
 * `schemas.public.tables`) or at the top level, with each table either `{ columns }` or a bare column
 * list, and tables either keyed by name or as an array of `{ name, columns }`.
 */
export function parseSchemaSnapshot(json: Json): SnapshotTables {
  let root: Json = json;
  if (isRecord(root) && isRecord(root.schemas) && isRecord(root.schemas.public)) root = root.schemas.public;
  if (isRecord(root) && isRecord(root.public)) root = root.public;
  if (isRecord(root) && (isRecord(root.tables) || Array.isArray(root.tables))) root = root.tables;

  const tableEntries: [string, Json][] = Array.isArray(root)
    ? root.map((t, i) => {
        if (!isRecord(t) || typeof t.name !== 'string') throw new Error(`snapshot: table #${i} has no name`);
        return [t.name, t];
      })
    : isRecord(root)
      ? Object.entries(root).filter(([key]) => !key.startsWith('$') && key !== 'generated_at' && key !== 'version')
      : [];
  if (tableEntries.length === 0) throw new Error('snapshot: no tables found (unrecognized format)');

  const tables: SnapshotTables = new Map();
  for (const [name, table] of tableEntries) {
    const columns = isRecord(table) && 'columns' in table ? table.columns : table;
    tables.set(name, readColumns(name, columns));
  }
  return tables;
}

/**
 * Tables in the `powersync` publication, if the snapshot records it (db:test writes them as a
 * `publication` array). PowerSync only replicates published tables and skips the rest with a log line,
 * so a synced table missing here would silently never reach devices.
 */
export function parseSnapshotPublication(json: Json): string[] | undefined {
  if (!isRecord(json)) return undefined;
  const publication = json.publication;
  if (Array.isArray(publication) && publication.every((t) => typeof t === 'string')) return publication;
  if (isRecord(publication) && Array.isArray(publication.tables)) {
    return publication.tables.filter((t): t is string => typeof t === 'string');
  }
  return undefined;
}
