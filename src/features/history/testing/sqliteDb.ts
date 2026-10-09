/// <reference types="node" />
/**
 * Test helper (never imported by app code): an in-memory SQLite database (Node's built-in
 * node:sqlite) with the same tables and columns as the PowerSync client schema, behind the subset of
 * PowerSync's database API the app uses (execute, getAll, getOptional, get, writeTransaction).
 *
 * PowerSync is SQLite, so running the app's real SQL here checks more than comparing strings: that
 * it parses, that the parameters line up, and what rows it reads and writes. Tests mock
 * `@/db/database` with it:
 *
 *   jest.mock('../../../db/database', () => ({
 *     db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
 *   }));
 */
import type { SQLInputValue } from 'node:sqlite';

import { LOCAL_STATE_TABLE } from '@/db/constants';
import { TABLES, TABLE_NAMES, type ColumnKind } from '@/db/tables';

const SQL_TYPE: Record<ColumnKind, string> = {
  uuid: 'TEXT',
  text: 'TEXT',
  json: 'TEXT',
  timestamp: 'TEXT',
  date: 'TEXT',
  integer: 'INTEGER',
  boolean: 'INTEGER',
  real: 'REAL',
};

export type SqlCall = { sql: string; params: unknown[] };

export type Row = Record<string, unknown>;

type ExecuteResult = { rowsAffected: number; rows: { _array: Row[]; length: number } };

/** The PowerSync calls the app uses, plus helpers for setting up and checking a test. */
export type SqliteDb = {
  /** Every statement the code under test ran, in order (seed/rows/reset are not logged). */
  calls: SqlCall[];
  /** How many write transactions were run. */
  readonly transactions: number;
  execute(sql: string, params?: readonly unknown[]): Promise<ExecuteResult>;
  getAll<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  getOptional<T = Row>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  get<T = Row>(sql: string, params?: readonly unknown[]): Promise<T>;
  writeTransaction<T>(callback: (tx: SqliteDb) => Promise<T>): Promise<T>;
  /** Inserts a row directly. */
  seed(table: string, row: Row): void;
  /** All rows of a table, by id. */
  rows(table: string, where?: string): Row[];
  /** Empties every table and the call log. */
  reset(): void;
};

/** node:sqlite, loaded without its one-time "experimental feature" warning (noise in test output). */
function loadSqlite(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function createSqliteDb(): SqliteDb {
  const { DatabaseSync } = loadSqlite();
  const sqlite = new DatabaseSync(':memory:');
  for (const name of TABLE_NAMES) {
    const columns = Object.entries(TABLES[name].columns as Record<string, ColumnKind>).map(
      ([column, kind]) => `${column} ${SQL_TYPE[kind]}`,
    );
    sqlite.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY NOT NULL, ${columns.join(', ')})`);
  }
  sqlite.exec(`CREATE TABLE ${LOCAL_STATE_TABLE} (id TEXT PRIMARY KEY NOT NULL, value TEXT, updated_at TEXT)`);

  /** Every statement the code under test ran, in order. */
  const calls: SqlCall[] = [];
  let transactions = 0;

  const read = (sql: string, params: readonly unknown[] = []): Row[] => {
    calls.push({ sql, params: [...params] });
    return sqlite
      .prepare(sql)
      .all(...(params as SQLInputValue[]))
      .map((row) => ({ ...(row as Row) }));
  };

  const api: SqliteDb = {
    calls,
    get transactions() {
      return transactions;
    },
    async execute(sql, params = []) {
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
        const rows = read(sql, params);
        return { rowsAffected: 0, rows: { _array: rows, length: rows.length } };
      }
      calls.push({ sql, params: [...params] });
      const result = sqlite.prepare(sql).run(...(params as SQLInputValue[]));
      return { rowsAffected: Number(result.changes), rows: { _array: [], length: 0 } };
    },
    async getAll<T = Row>(sql: string, params: readonly unknown[] = []) {
      return read(sql, params) as T[];
    },
    async getOptional<T = Row>(sql: string, params: readonly unknown[] = []) {
      return (read(sql, params)[0] as T | undefined) ?? null;
    },
    async get<T = Row>(sql: string, params: readonly unknown[] = []) {
      const row = read(sql, params)[0];
      if (!row) throw new Error('Result set is empty');
      return row as T;
    },
    async writeTransaction<T>(callback: (tx: SqliteDb) => Promise<T>) {
      transactions += 1;
      sqlite.exec('BEGIN');
      try {
        const result = await callback(api);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    seed(table, row) {
      const columns = Object.keys(row);
      sqlite
        .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...(Object.values(row) as SQLInputValue[]));
    },
    rows(table, where = '1 = 1') {
      return sqlite
        .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`)
        .all()
        .map((row) => ({ ...(row as Row) }));
    },
    reset() {
      for (const name of [...TABLE_NAMES, LOCAL_STATE_TABLE]) sqlite.exec(`DELETE FROM ${name}`);
      calls.length = 0;
      transactions = 0;
    },
  };
  return api;
}
