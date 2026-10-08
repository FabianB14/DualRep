/// <reference types="node" />
/**
 * Compares the client registry (src/db/tables.ts) with the real Postgres schema, as captured in
 * supabase/schema.snapshot.json by `npm run db:test` (CI fails if that file is stale). A column added
 * to a migration but not to the registry would be dropped on the device; a registry column the
 * database lacks would always read as NULL and make uploads fail.
 *
 * SNAPSHOT_PATH overrides the snapshot location (used while the migration is being written).
 */
import { beforeAll, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseSchemaSnapshot, parseSnapshotPublication, type SnapshotTables } from '../snapshot';
import { SERVER_ONLY_COLUMNS, SERVER_ONLY_TABLES, TABLE_NAMES, TABLES, type ColumnKind } from '../tables';

const repoRoot = path.resolve(__dirname, '../../..');
const snapshotPath = path.resolve(repoRoot, process.env.SNAPSHOT_PATH ?? 'supabase/schema.snapshot.json');
const hasSnapshot = existsSync(snapshotPath);

if (!hasSnapshot) {
  console.warn(
    `registry-drift: SKIPPED — ${path.relative(repoRoot, snapshotPath)} does not exist. ` +
      'Run `npm run db:test` to generate it.',
  );
}

const describeWithSnapshot = hasSnapshot ? describe : describe.skip;

describeWithSnapshot('registry vs Postgres schema snapshot', () => {
  let snapshot: SnapshotTables;
  let publication: string[] | undefined;
  beforeAll(() => {
    const json: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    snapshot = parseSchemaSnapshot(json);
    publication = parseSnapshotPublication(json);
  });

  it.each(TABLE_NAMES)('%s exists with a uuid id and every registry column, with a matching type', (table) => {
    const columns = snapshot.get(table);
    expect(columns).toBeDefined();
    const types = new Map(columns!.map((c) => [c.name, c.type]));
    expect(types.get('id')).toBe('uuid');

    // ColumnKind names are the snapshot's normalized type names, so compatible means equal.
    const registry: Record<string, ColumnKind> = TABLES[table].columns;
    const mismatches = Object.entries(registry)
      .filter(([name, kind]) => types.get(name) !== kind)
      .map(([name, kind]) => `${name}: registry ${kind}, Postgres ${types.get(name) ?? 'missing'}`);
    expect(mismatches).toEqual([]);
  });

  it.each(TABLE_NAMES)('%s: every Postgres column is synced or explicitly server-only', (table) => {
    const registry: Record<string, ColumnKind> = TABLES[table].columns;
    const serverOnly: readonly string[] = SERVER_ONLY_COLUMNS[table] ?? [];
    const unlisted = snapshot
      .get(table)!
      .map((c) => c.name)
      .filter((name) => name !== 'id' && !(name in registry) && !serverOnly.includes(name));
    expect(unlisted).toEqual([]);
  });

  it('lists only server-only columns that exist and are not also in the registry', () => {
    const stale: string[] = [];
    for (const table of TABLE_NAMES) {
      const existing = new Set(snapshot.get(table)?.map((c) => c.name));
      const registry: Record<string, ColumnKind> = TABLES[table].columns;
      for (const column of SERVER_ONLY_COLUMNS[table] ?? []) {
        if (!existing.has(column)) stale.push(`${table}.${column} is not in Postgres`);
        if (column in registry) stale.push(`${table}.${column} is also in the registry`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('accounts for every public table: synced (in the registry) or explicitly server-only', () => {
    const known = new Set<string>([...TABLE_NAMES, ...SERVER_ONLY_TABLES]);
    expect([...snapshot.keys()].filter((table) => !known.has(table))).toEqual([]);
    for (const table of SERVER_ONLY_TABLES) {
      expect(snapshot.has(table)).toBe(true);
      expect(TABLE_NAMES as readonly string[]).not.toContain(table);
    }
  });

  it('publishes exactly the synced tables to PowerSync (the `powersync` publication)', () => {
    // PowerSync only replicates published tables; server-only tables must stay out of the WAL stream.
    expect(publication).toBeDefined();
    expect([...(publication ?? [])].sort()).toEqual([...TABLE_NAMES].sort());
  });
});
