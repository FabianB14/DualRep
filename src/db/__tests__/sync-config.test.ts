/**
 * @jest-environment node
 *
 * (The node environment makes `yaml` resolve to its CommonJS build; the default React Native
 * environment picks its untransformed browser ESM build.)
 *
 * Structural checks of powersync/sync-config.yaml that need no Postgres schema (the full compile
 * against the schema snapshot is `npm run validate:sync`).
 */
/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { SERVER_ONLY_TABLES, TABLE_NAMES, TABLES } from '../tables';

type Stream = {
  auto_subscribe?: boolean;
  priority?: number;
  query?: string;
  queries?: string[];
  with?: Record<string, string>;
};
type SyncConfig = {
  config: { edition: number; timestamp_max_precision?: string };
  with?: Record<string, string>;
  streams: Record<string, Stream>;
};

const configPath = path.resolve(__dirname, '../../../powersync/sync-config.yaml');
const config = parse(readFileSync(configPath, 'utf8')) as SyncConfig;

const queries = Object.entries(config.streams).flatMap(([stream, def]) =>
  [...(def.query ? [def.query] : []), ...(def.queries ?? [])].map((sql) => ({ stream, sql: sql.trim() })),
);
const ctes = [
  ...Object.values(config.with ?? {}),
  ...Object.values(config.streams).flatMap((def) => Object.values(def.with ?? {})),
];

/** The table a query syncs: the first FROM (subqueries only appear after it, in WHERE). */
function outputTable(sql: string): string {
  const match = /\bFROM\s+([a-z_][a-z0-9_]*)/i.exec(sql);
  if (!match) throw new Error(`No FROM in: ${sql}`);
  return match[1];
}

function selectList(sql: string): string[] {
  const match = /^SELECT\s+(.+?)\s+FROM\s/is.exec(sql);
  if (!match) throw new Error(`Cannot read the select list of: ${sql}`);
  return match[1].split(',').map((c) => c.trim());
}

describe('powersync/sync-config.yaml', () => {
  it('uses Sync Streams (edition 3) with millisecond timestamps', () => {
    expect(config.config.edition).toBe(3);
    expect(config.config.timestamp_max_precision).toBe('milliseconds');
    expect(queries.length).toBeGreaterThan(0);
  });

  it('subscribes every stream automatically (offline-first: everything is on the device)', () => {
    const notAuto = Object.entries(config.streams)
      .filter(([, stream]) => stream.auto_subscribe !== true)
      .map(([name]) => name);
    expect(notAuto).toEqual([]);
  });

  it.each(TABLE_NAMES)('syncs registry table %s', (table) => {
    expect(queries.map((q) => outputTable(q.sql))).toContain(table);
  });

  it('syncs no table outside the registry', () => {
    const registry = new Set<string>(TABLE_NAMES);
    expect(queries.map((q) => outputTable(q.sql)).filter((t) => !registry.has(t))).toEqual([]);
  });

  it('never mentions a server-only table (source_chunks), in queries or CTEs', () => {
    for (const table of SERVER_ONLY_TABLES) {
      const pattern = new RegExp(`\\b${table}\\b`, 'i');
      expect([...queries.map((q) => q.sql), ...ctes].filter((sql) => pattern.test(sql))).toEqual([]);
    }
  });

  it('selects id in every query', () => {
    const withoutId = queries.filter(({ sql }) => {
      const columns = selectList(sql);
      return !columns.includes('*') && !columns.includes('id');
    });
    expect(withoutId).toEqual([]);
  });

  it('selects exactly the registry columns of tracy_events (heavy JSON stays on the server)', () => {
    const tracy = queries.filter((q) => outputTable(q.sql) === 'tracy_events');
    expect(tracy.length).toBeGreaterThan(0);
    for (const { sql } of tracy) {
      const columns = selectList(sql);
      expect(columns).not.toContain('*');
      expect([...columns].sort()).toEqual(['id', ...Object.keys(TABLES.tracy_events.columns)].sort());
    }
  });

  it('uses no literal IN lists (unsupported by the compiler; use OR)', () => {
    expect(queries.map((q) => q.sql).filter((sql) => /\bIN\s*\(\s*'/i.test(sql))).toEqual([]);
  });

  it('authorizes only on signed JWT claims, never on client-supplied parameters', () => {
    const all = [...queries.map((q) => q.sql), ...ctes].join('\n');
    // connection/subscription parameters are client-supplied and unauthenticated.
    expect(all).not.toMatch(/connection\.parameter|subscription\.parameter|request\.parameters/);
  });
});
