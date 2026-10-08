// Turns the raw catalog dump made by scripts/db-test.sh into supabase/schema.snapshot.json.
//
// Usage: node scripts/db/write-schema-snapshot.mjs <raw.json> <out.json>
//
// The input is one JSON object queried from pg_catalog after the migrations ran:
//   { "tables": [{ "name", "rls", "columns": [{ "name", "type" (pg_type.typname), "nullable", "has_default" }] }],
//     "publication": ["table", ...] }
// The output is the documented, deterministic snapshot the sync-config validator reads:
//   { "tables": { "<table>": { "rls", "columns": [{ "name", "type", "nullable", "has_default" }] } },
//     "publication": [...] }
// Tables and the publication list are sorted by name; columns keep their table order. Column types
// are normalized to what the device sees (see SPEC "Postgres → device types"). An unknown type —
// notably `numeric`, which PowerSync would sync as TEXT — fails the run instead of being guessed.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const TYPE_MAP = {
  uuid: 'uuid',
  text: 'text',
  varchar: 'text',
  bpchar: 'text',
  int2: 'integer',
  int4: 'integer',
  int8: 'integer',
  float4: 'real',
  float8: 'real',
  bool: 'boolean',
  json: 'json',
  jsonb: 'json',
  timestamptz: 'timestamp',
  timestamp: 'timestamp',
  date: 'date',
  vector: 'vector',
};

const [rawPath, outPath] = process.argv.slice(2);
if (!rawPath || !outPath) {
  console.error('usage: write-schema-snapshot.mjs <raw.json> <out.json>');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const problems = [];

const tables = {};
for (const table of [...raw.tables].sort((a, b) => byName(a.name, b.name))) {
  tables[table.name] = {
    rls: table.rls,
    columns: table.columns.map((column) => {
      const type = TYPE_MAP[column.type];
      if (!type) problems.push(`${table.name}.${column.name} has unsupported type "${column.type}"`);
      return {
        name: column.name,
        type: type ?? column.type,
        nullable: column.nullable,
        has_default: column.has_default,
      };
    }),
  };
}

if (problems.length > 0) {
  console.error(`schema snapshot: ${problems.join('; ')}`);
  process.exit(1);
}

const snapshot = { tables, publication: [...raw.publication].sort(byName) };
// Write then rename, so an interrupted run never leaves a half-written snapshot behind.
const tmpPath = `${outPath}.tmp`;
writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
renameSync(tmpPath, outPath);
