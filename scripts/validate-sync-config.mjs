#!/usr/bin/env node
/**
 * Offline check of powersync/sync-config.yaml (`npm run validate:sync`).
 *
 * Compiles the sync config with PowerSync's own compiler (@powersync/service-sync-rules) against the
 * Postgres schema snapshot written by `npm run db:test`, then checks what the compiler does not:
 *   1. no diagnostics at all — warnings fail too (e.g. "table could not be found in the source schema");
 *   2. every query outputs an `id` column (edition 3 compiles a query without one silently, and the
 *      device then keeps a single arbitrary row per table);
 *   3. server-only tables (source_chunks) are never referenced, not even as a parameter lookup;
 *   4. every table in the client registry (src/db/tables.ts) is synced by some query, every synced
 *      table is in the registry, and each query outputs exactly the registry's columns plus id
 *      (a column the registry lacks would be dropped on the device; a missing one would read as NULL).
 *
 * The registry is read by importing src/db/tables.ts itself through Node's built-in TypeScript type
 * stripping (that file is import-free and uses only erasable syntax), so there is no second copy of
 * the table list to keep in sync and no fragile regex parsing.
 *
 * Environment overrides: SNAPSHOT_PATH (default supabase/schema.snapshot.json) and SYNC_CONFIG_PATH
 * (default powersync/sync-config.yaml), both relative to the repository root or absolute.
 * Exit code: 0 = valid, 1 = invalid or could not be checked.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

// --- Runtime flags -------------------------------------------------------------------------------
// The compiler uses `using` declarations (explicit resource management): native in Node 24, behind
// --js-explicit-resource-management in Node 22. Type stripping (needed to import tables.ts) is on by
// default from Node 22.18; older 22.x need --experimental-strip-types. Both are feature-detected
// rather than inferred from the version string. The script re-runs itself once in a child process
// with whatever flags are missing (plus filters for the harmless "experimental" / "module type"
// warnings that importing a .ts file prints), so `npm run validate:sync` works on Node 22 and 24.
const RESPAWNED = 'DUALREP_VALIDATE_SYNC_CHILD';

function supportsUsingDeclarations() {
  try {
    new Function('{ using resource = null; }');
    return true;
  } catch {
    return false;
  }
}

if (!process.env[RESPAWNED]) {
  const flags = ['--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];
  if (!supportsUsingDeclarations()) flags.push('--js-explicit-resource-management');
  if (!process.features.typescript) flags.push('--experimental-strip-types');
  const child = spawnSync(process.execPath, [...flags, ...process.execArgv, scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [RESPAWNED]: '1' },
  });
  if (child.error) console.error(`validate-sync-config: could not start Node: ${child.error.message}`);
  process.exit(child.status ?? 1);
}

if (!supportsUsingDeclarations() || !process.features.typescript) {
  console.error(`validate-sync-config: Node ${process.version} cannot run the sync config compiler; use Node 22.13+ or 24.`);
  process.exit(1);
}

// --- Inputs ----------------------------------------------------------------------------------------
const fromRoot = (p) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
const syncConfigPath = fromRoot(process.env.SYNC_CONFIG_PATH || 'powersync/sync-config.yaml');
const snapshotPath = fromRoot(process.env.SNAPSHOT_PATH || 'supabase/schema.snapshot.json');
// Paths inside the repo are printed relative to it, anything else (e.g. a SNAPSHOT_PATH override) in full.
const rel = (p) => {
  const relative = path.relative(repoRoot, p);
  return relative && !relative.startsWith('..') ? relative : p;
};

if (!existsSync(snapshotPath)) {
  console.error(`validate-sync-config: ${rel(snapshotPath)} not found. Run \`npm run db:test\` to generate it.`);
  process.exit(1);
}

// Imported only now: on Node 22 without the flag, merely loading the compiler is a syntax error.
const { SqlSyncRules, StaticSchema, serializeSyncPlan } = await import('@powersync/service-sync-rules');
const { TABLES, SERVER_ONLY_TABLES } = await import(pathToFileURL(path.join(repoRoot, 'src/db/tables.ts')).href);
const { parseSchemaSnapshot, parseSnapshotPublication, PG_TYPE_FOR_SNAPSHOT_TYPE } = await import(
  pathToFileURL(path.join(repoRoot, 'src/db/snapshot.ts')).href
);

const problems = [];
const yamlText = readFileSync(syncConfigPath, 'utf8');

let snapshot;
let publication;
try {
  const snapshotJson = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  snapshot = parseSchemaSnapshot(snapshotJson);
  publication = parseSnapshotPublication(snapshotJson);
} catch (err) {
  console.error(`validate-sync-config: cannot read ${rel(snapshotPath)}: ${err.message}`);
  process.exit(1);
}

// --- 1. Compile ------------------------------------------------------------------------------------
const schema = new StaticSchema([
  {
    tag: 'default',
    schemas: [
      {
        name: 'public',
        tables: [...snapshot].map(([name, columns]) => ({
          name,
          columns: columns.map((c) => ({ name: c.name, pg_type: PG_TYPE_FOR_SNAPSHOT_TYPE[c.type] })),
        })),
      },
    ],
  },
]);

const { config, errors } = SqlSyncRules.fromYaml(yamlText, { defaultSchema: 'public', schema, throwOnError: false });

function lineAndColumn(offset) {
  const before = yamlText.slice(0, offset);
  const line = before.split('\n').length;
  return `${line}:${offset - before.lastIndexOf('\n')}`;
}

for (const error of errors) {
  const where = error.location
    ? `${rel(syncConfigPath)}:${lineAndColumn(error.location.start)} near "${yamlText
        .slice(error.location.start, error.location.end)
        .replace(/\s+/g, ' ')
        .slice(0, 100)}"`
    : rel(syncConfigPath);
  problems.push(`[${error.type}] ${error.message}\n      at ${where}`);
}

// --- 2-4. Inspect the compiled plan ------------------------------------------------------------------
if (!config?.plan) {
  problems.push('The compiler produced no Sync Streams plan (is `config: edition: 3` with `streams:` set?).');
} else {
  const plan = serializeSyncPlan(config.plan);

  // Which streams use each data source (bucket names are "<stream>|<n>"), for readable messages.
  const streamsBySource = new Map();
  for (const bucket of plan.buckets) {
    const stream = bucket.uniqueName.split('|')[0];
    for (const source of bucket.sources) {
      const names = streamsBySource.get(source) ?? new Set();
      names.add(stream);
      streamsBySource.set(source, names);
    }
  }

  const syncedTables = new Set();
  plan.dataSources.forEach((source, index) => {
    const table = source.table.table;
    const output = source.outputTableName ?? table;
    const streams = [...(streamsBySource.get(index) ?? [])].join(', ') || 'no stream';
    const label = `query on ${table} (stream ${streams})`;
    syncedTables.add(output);

    if (output !== table) problems.push(`${label} syncs as "${output}"; do not alias the table.`);

    const snapshotColumns = snapshot.get(table);
    let outputColumns;
    if (source.columns.some((c) => c === 'star')) {
      outputColumns = (snapshotColumns ?? []).map((c) => c.name);
      // Columns listed next to * are output too (they could only rename/duplicate; flag them below).
      for (const c of source.columns) if (c !== 'star') outputColumns.push(c.alias);
    } else {
      outputColumns = source.columns.map((c) => c.alias);
    }

    // (A `*` on a table missing from the snapshot is already reported by the compiler.)
    if (!outputColumns.includes('id') && (snapshotColumns || !source.columns.includes('star'))) {
      problems.push(`${label} does not output an "id" column; every synced row needs one.`);
    }

    const registry = TABLES[output];
    if (registry && snapshotColumns) {
      const expected = new Set(['id', ...Object.keys(registry.columns)]);
      const extra = outputColumns.filter((c) => !expected.has(c));
      const missing = [...expected].filter((c) => c !== 'id' && !outputColumns.includes(c));
      if (extra.length > 0) {
        problems.push(
          `${label} outputs ${extra.join(', ')}, which src/db/tables.ts does not declare ` +
            '(add them to the registry, or list columns explicitly to keep them server-side).',
        );
      }
      if (missing.length > 0) {
        problems.push(`${label} does not output ${missing.join(', ')}, which src/db/tables.ts declares.`);
      }
    }
  });

  // Server-only tables must not appear anywhere: as data, or as a parameter/subquery lookup.
  const referenced = new Set([
    ...config.getSourceTables().map((t) => t.tablePattern),
    ...plan.dataSources.map((s) => s.table.table),
    ...plan.parameterIndexes.map((p) => p.table.table),
  ]);
  for (const table of SERVER_ONLY_TABLES) {
    if (referenced.has(table)) problems.push(`${table} is server-only and must never be referenced by the sync config.`);
  }
  // A wildcard pattern (FROM "%" / "prefix%") would quietly pick up server-only and future tables.
  for (const pattern of referenced) {
    if (pattern.includes('%')) problems.push(`Wildcard table pattern "${pattern}" is not allowed; name each table.`);
  }

  for (const table of Object.keys(TABLES)) {
    if (!syncedTables.has(table)) problems.push(`Registry table ${table} is not synced by any stream.`);
  }
  for (const table of syncedTables) {
    if (!Object.hasOwn(TABLES, table)) {
      problems.push(`Synced table ${table} is missing from src/db/tables.ts, so the device would ignore its rows.`);
    }
  }

  // PowerSync replicates only tables in the `powersync` publication (and skips others with just a log
  // line), so cross-check it when the snapshot records it.
  if (publication) {
    const published = new Set(publication);
    for (const table of syncedTables) {
      if (!table.includes('%') && !published.has(table)) {
        problems.push(`Synced table ${table} is not in the powersync publication, so it would never replicate.`);
      }
    }
    for (const table of SERVER_ONLY_TABLES) {
      if (published.has(table)) problems.push(`Server-only table ${table} must not be in the powersync publication.`);
    }
  } else {
    console.warn(`validate-sync-config: ${rel(snapshotPath)} records no publication; skipping the publication check.`);
  }

  if (problems.length === 0) {
    console.log(
      `validate-sync-config: ${rel(syncConfigPath)} OK — ${plan.streams.length} streams, ` +
        `${plan.dataSources.length} data sources, ${syncedTables.size} tables ` +
        `(schema: ${rel(snapshotPath)}, ${snapshot.size} tables).`,
    );
  }
}

if (problems.length > 0) {
  console.error(`validate-sync-config: ${rel(syncConfigPath)} has ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
