import { describe, expect, it, jest } from '@jest/globals';
import { ColumnType } from '@powersync/react-native';

import { AppSchema } from '../schema';
import { TABLE_NAMES, TABLES, type WritePolicy } from '../tables';

// The runtime SDK loads native modules (and ESM jest cannot transform); @powersync/common
// exports the same classes and enums. babel-jest hoists this above the imports.
jest.mock('@powersync/react-native', () => jest.requireActual('@powersync/common'));

const SQLITE_TYPE = {
  uuid: ColumnType.TEXT,
  text: ColumnType.TEXT,
  json: ColumnType.TEXT,
  timestamp: ColumnType.TEXT,
  date: ColumnType.TEXT,
  integer: ColumnType.INTEGER,
  boolean: ColumnType.INTEGER,
  real: ColumnType.REAL,
} as const;

const byName = new Map(AppSchema.tables.map((table) => [table.name, table]));

describe('AppSchema', () => {
  it('passes PowerSync validation (names, column counts, index columns exist)', () => {
    expect(() => AppSchema.validate()).not.toThrow();
  });

  it('has every registry table plus the local-only upload_failures log and local_state store', () => {
    expect([...byName.keys()].sort()).toEqual([...TABLE_NAMES, 'local_state', 'upload_failures'].sort());
    expect(byName.get('upload_failures')!.localOnly).toBe(true);
    expect(byName.get('local_state')!.localOnly).toBe(true);
    for (const name of TABLE_NAMES) expect(byName.get(name)!.localOnly).toBe(false);
  });

  it.each(TABLE_NAMES)('%s maps every registry column to the right SQLite type (and never declares id)', (name) => {
    const columns = Object.fromEntries(byName.get(name)!.columns.map((c) => [c.name, c.type]));
    const expected = Object.fromEntries(
      Object.entries(TABLES[name].columns).map(([column, kind]) => [column, SQLITE_TYPE[kind]]),
    );
    expect(columns).toEqual(expected);
    expect(columns).not.toHaveProperty('id');
  });

  it('tracks the values before each update only where upload.ts needs them (card_states FSRS state)', () => {
    for (const name of TABLE_NAMES) {
      const writes: WritePolicy = TABLES[name].writes;
      const together = writes.patchTogether;
      const tracked = byName.get(name)!.trackPrevious;
      if (together === undefined) expect(tracked).toBe(false);
      else expect(tracked).toEqual({ columns: [...together] });
    }
    expect(byName.get('card_states')!.trackPrevious).toEqual({
      columns: expect.arrayContaining(['stability', 'difficulty', 'last_review', 'due', 'state', 'reps']),
    });
  });

  it('has the indexes the hot queries need', () => {
    const indexes = (name: string) =>
      Object.fromEntries(byName.get(name)!.indexes.map((i) => [i.name, i.columns.map((c) => c.name)]));
    expect(Object.values(indexes('card_states'))).toContainEqual(['user_id', 'due']);
    expect(Object.values(indexes('reviews'))).toContainEqual(['card_id', 'reviewed_at']);
    expect(Object.values(indexes('exercise_sets'))).toContainEqual(['workout_session_id', 'set_index']);
    expect(Object.values(indexes('study_sessions'))).toContainEqual(['user_id', 'created_at']);
    expect(Object.values(indexes('cards'))).toContainEqual(['plan_id', 'source_id']);
    expect(Object.values(indexes('tracy_events'))).toContainEqual(['source_id', 'created_at']);
  });
});
