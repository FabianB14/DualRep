// Tests for the import SQL builder (node --test; `npm run test:scripts`). They check the SQL text; that
// Postgres accepts it and that a re-import keeps the curators' work is proven by
// verify-import-sql.sh against the real migrations (the exercise-import workflow runs it).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CURATED_COLUMNS,
  DATASET_COMMIT,
  DATASET_URL,
  FACT_COLUMNS,
  PINNED_SHA256,
  buildImportSql,
  findDatasetProblems,
  main,
  sha256Of,
} from './build-import-sql.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixturePath = path.join(here, 'fixtures/spot-check.json');
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const fixtureSha = sha256Of(fixtureBytes);
const sql = buildImportSql(fixture, { sha256: fixtureSha });

const workDir = mkdtempSync(path.join(tmpdir(), 'dualrep-import-test-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Runs main() and captures what it prints. */
function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { log: (m) => out.push(m), error: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The text between two markers of the generated SQL. */
function between(start, end) {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `markers ${start} … ${end}`);
  return sql.slice(from + start.length, to);
}

describe('the pin', () => {
  test('the workflow downloads the same commit and checks the same sha256', () => {
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/exercise-import.yml'), 'utf8');
    assert.ok(workflow.includes(PINNED_SHA256), 'sha256 in the workflow');
    assert.ok(workflow.includes(DATASET_URL), 'download URL in the workflow');
    assert.ok(DATASET_URL.includes(DATASET_COMMIT));
    assert.match(PINNED_SHA256, /^[0-9a-f]{64}$/);
  });

  test('a file that is not the pinned copy is refused unless --allow-unpinned', () => {
    const out = path.join(workDir, 'refused.sql');
    const refused = run([fixturePath, '--out', out]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /not the pinned dataset/);
    assert.ok(refused.err.includes(PINNED_SHA256) && refused.err.includes(fixtureSha));

    const allowed = run([fixturePath, '--out', out, '--allow-unpinned']);
    assert.equal(allowed.code, 0, allowed.err);
    assert.match(allowed.out, /12 exercises.*NOT pinned/);
    assert.equal(readFileSync(out, 'utf8'), sql);
  });

  test('the header says which copy the SQL came from', () => {
    assert.ok(sql.includes(`sha256 ${fixtureSha}`));
    assert.ok(sql.includes('NOT the pinned copy'));
    assert.ok(sql.includes('\n-- Exercises: 12\n'));
    const pinned = buildImportSql(fixture, { sha256: PINNED_SHA256 });
    assert.ok(pinned.includes(`the pinned copy (yuhonas/free-exercise-db@${DATASET_COMMIT})`));
  });
});

describe('the command line', () => {
  test('usage errors exit 2', () => {
    assert.equal(run([]).code, 2);
    assert.equal(run([fixturePath]).code, 2);
    assert.equal(run([fixturePath, '--out']).code, 2);
    assert.equal(run([fixturePath, '--out', 'x.sql', '--force']).code, 2);
    assert.equal(run([fixturePath, fixturePath, '--out', 'x.sql']).code, 2);
  });

  test('unreadable, non-JSON or invalid input exits 1 and writes nothing', () => {
    const out = path.join(workDir, 'never.sql');
    assert.equal(run([path.join(workDir, 'missing.json'), '--out', out, '--allow-unpinned']).code, 1);

    const notJson = path.join(workDir, 'not.json');
    writeFileSync(notJson, '{ nope');
    assert.equal(run([notJson, '--out', out, '--allow-unpinned']).code, 1);

    const invalid = path.join(workDir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify([{ ...fixture[0], level: 'elite' }]));
    const result = run([invalid, '--out', out, '--allow-unpinned']);
    assert.equal(result.code, 1);
    assert.match(result.err, /unknown level "elite"/);
    assert.throws(() => readFileSync(out));
  });

  test('runs as a script', () => {
    const out = path.join(workDir, 'cli.sql');
    const child = spawnSync(
      process.execPath,
      [path.join(here, 'build-import-sql.mjs'), fixturePath, '--out', out, '--allow-unpinned'],
      { encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(out, 'utf8'), sql);
  });

  test('map-free-exercise-db.mjs and enum-counts.mjs still run', () => {
    for (const script of ['map-free-exercise-db.mjs', 'enum-counts.mjs']) {
      const child = spawnSync(process.execPath, [path.join(here, script), fixturePath], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout).total, 12, script);
    }
  });
});

describe('input checks', () => {
  test('the fixture is valid', () => {
    assert.deepEqual(findDatasetProblems(fixture), []);
  });

  test('shape problems are reported, one message each', () => {
    assert.deepEqual(findDatasetProblems({}), ['the file is not a JSON array of exercises']);
    assert.deepEqual(findDatasetProblems([]), ['the file has no exercises']);
    const [good] = fixture;
    const cases = [
      [[good, good], /duplicate id/],
      [[{ ...good, id: 'bad id' }], /id must match/],
      [[{ ...good, name: ' ' }], /name must be non-empty/],
      [[{ ...good, force: 'twist' }], /unknown force/],
      [[{ ...good, mechanic: 'hybrid' }], /unknown mechanic/],
      [[{ ...good, equipment: 'rings' }], /unknown equipment/],
      [[{ ...good, category: 'yoga' }], /unknown category/],
      [[{ ...good, primaryMuscles: [] }], /primaryMuscles/],
      [[{ ...good, primaryMuscles: ['rotator cuff'] }], /primaryMuscles/],
      [[{ ...good, secondaryMuscles: 'biceps' }], /secondaryMuscles/],
      [[{ ...good, images: null }], /images must be a list/],
      [[{ ...good, instructions: undefined }], /instructions must be a list/],
      [[null], /not an object/],
    ];
    for (const [data, message] of cases) {
      const problems = findDatasetProblems(data);
      assert.equal(problems.length, 1, `${message}: ${problems.join('; ')}`);
      assert.match(problems[0], message);
    }
  });
});

describe('the SQL', () => {
  test('one statement: no transaction control, a single terminating semicolon', () => {
    const code = sql.replace(/^\s*--.*$/gm, '');
    assert.equal(/\b(begin|commit|rollback)\b/i.test(code), false);
    const outsideLiterals = code.replace(/'(?:[^']|'')*'/g, "''");
    assert.equal(outsideLiterals.split(';').length, 2);
    assert.ok(outsideLiterals.trimEnd().endsWith(';'));
  });

  test('one row per exercise, sorted by dataset_id, with quotes escaped', () => {
    const rows = between('  values\n', '\n),\nwritten as').split(',\n');
    assert.equal(rows.length, fixture.length);
    const ids = rows.map((row) => row.match(/^ {4}\('([^']+)'/)[1]);
    assert.deepEqual(ids, [...ids].sort());
    assert.ok(sql.includes("'Farmer''s Walk'"));
  });

  test('a row carries the dataset facts and the curated fields', () => {
    assert.ok(
      sql.includes(
        "    ('Barbell_Squat', 'Barbell Squat', 'quadriceps', '[\"calves\",\"glutes\",\"hamstrings\",\"lower back\"]'::jsonb, " +
          "'beginner', 'push', 'compound', 'strength', '[\"barbell\",\"rack\"]'::jsonb, 'gym', 'squat', 'lower', 'strength', 3, false)",
      ),
    );
    assert.ok(
      sql.includes(
        "    ('Rope_Jumping', 'Rope Jumping', 'quadriceps', '[\"calves\",\"hamstrings\"]'::jsonb, 'intermediate', null, null, " +
          "'cardio', '[\"jump_rope\"]'::jsonb, 'both', 'conditioning', 'cardio', 'conditioning', 2, true)",
      ),
    );
  });

  test('new rows are unreviewed dataset rows with no owner, group, images or instructions', () => {
    const insert = between('insert into public.exercises as e (', 'from incoming');
    assert.match(insert, /instructions, images, origin, reviewed, owner_id, group_id\n {2}\)/);
    assert.match(insert, /'\[\]'::jsonb, '\[\]'::jsonb, 'dataset', false, null::uuid, null::uuid\n/);
    assert.equal(sql.includes('gen_random_uuid'), false);
  });

  test('a re-import refreshes the dataset facts, clears images and instructions, and keeps curated fields', () => {
    const set = between('on conflict (dataset_id) do update set\n', '  -- Only rows with something to change');
    const assigned = [...set.matchAll(/(?:^|[\s,])([a-z_]+) = /g)].map((m) => m[1]);
    assert.deepEqual(assigned.sort(), [...FACT_COLUMNS, 'images', 'instructions', 'reviewed'].sort());
    for (const column of FACT_COLUMNS) assert.ok(set.includes(`${column} = excluded.${column}`), column);
    for (const column of CURATED_COLUMNS) assert.equal(new RegExp(`\\b${column} =`).test(set), false, column);
    assert.ok(set.includes("images = '[]', instructions = '[]'"));
  });

  test('reviewed survives only when no dataset fact changed', () => {
    const reviewed = between('reviewed = e.reviewed and (', '\n  -- Only rows');
    const [current, incoming] = reviewed.split(') is not distinct from (');
    assert.deepEqual(current.trim().split(/,\s*/), FACT_COLUMNS.map((c) => `e.${c}`));
    assert.deepEqual(incoming.replace(/\)\s*$/, '').trim().split(/,\s*/), FACT_COLUMNS.map((c) => `excluded.${c}`));
  });

  test('rows with nothing to change are skipped', () => {
    const where = between('  where (', '  -- xmax');
    const [current, incoming] = where.split(') is distinct from (');
    assert.deepEqual(current.trim().split(/,\s*/), [...FACT_COLUMNS, 'images', 'instructions'].map((c) => `e.${c}`));
    assert.deepEqual(
      incoming.replace(/\)\s*$/, '').trim().split(/,\s*/),
      [...FACT_COLUMNS, 'images', 'instructions'].map((c) => `excluded.${c}`),
    );
  });

  test('ends with the summary row', () => {
    for (const column of ['rows_in_file', 'inserted', 'updated', 'review_reset', 'unchanged', 'not_in_file']) {
      assert.match(sql, new RegExp(`\\) as ${column}[,;]`), column);
    }
  });

  test('deterministic: the same input in any order gives the same SQL', () => {
    assert.equal(buildImportSql(fixture, { sha256: fixtureSha }), sql);
    assert.equal(buildImportSql([...fixture].reverse(), { sha256: fixtureSha }), sql);
  });
});
