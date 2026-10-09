#!/usr/bin/env node
/**
 * Builds the SQL that loads free-exercise-db into public.exercises (Phase 1; D9 in docs/DECISIONS.md).
 *
 *   node scripts/exercise-import/build-import-sql.mjs <exercises.json> --out <file.sql> [--allow-unpinned]
 *
 * The input must be the pinned copy of the dataset (PINNED_SHA256) unless --allow-unpinned is given:
 * the mapping rules were checked against that exact file, and a moved upstream `main` must not change
 * what lands in the database without someone looking. To move to a newer copy, run
 * map-free-exercise-db.mjs on it, review the differences, then update the pin here and in
 * .github/workflows/exercise-import.yml.
 *
 * The output is one SQL statement (so it is one transaction wherever it runs: the Supabase SQL Editor,
 * psql -f): `insert ... on conflict (dataset_id) do update`, which can be run again after every upstream
 * update without losing the curators' work:
 *   - new rows: origin 'dataset', reviewed false, no owner or group, no images or instructions (D9);
 *   - dataset facts (FACT_COLUMNS) are refreshed from the file;
 *   - images and instructions are set to [] explicitly, so a row never keeps copied dataset content;
 *   - curated fields (CURATED_COLUMNS) are written on insert only, so a curator's fixes survive;
 *   - reviewed is kept only when no dataset fact changed, else false (a changed row needs a new review);
 *   - a row with nothing to change is not updated at all, so its updated_at stays and phones do not
 *     download the whole library again;
 *   - rows the file no longer has are left alone (a set may still point at them) and only counted.
 * The statement ends with one summary row (rows_in_file, inserted, updated, review_reset, unchanged,
 * not_in_file), which the SQL Editor shows. verify-import-sql.sh proves a file against the real schema.
 *
 * The output is deterministic: rows sorted by dataset_id, no timestamps.
 * Exit code: 0 = written, 1 = wrong file or invalid data, 2 = usage.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DATASET_CATEGORIES,
  DATASET_EQUIPMENT,
  DATASET_FORCES,
  DATASET_LEVELS,
  DATASET_MECHANICS,
  GYM_ONLY_EQUIPMENT,
  HOME_OK_EQUIPMENT,
  MUSCLES,
  mapExercise,
} from './mapping.mjs';

/** sha256 of the dataset copy the mapping rules were checked against (research §A1). */
export const PINNED_SHA256 = '5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf';
/** The upstream commit that holds exactly that file (checked 2026-10-08). */
export const DATASET_COMMIT = 'f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5';
export const DATASET_URL = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${DATASET_COMMIT}/dist/exercises.json`;

/** Facts the dataset owns: refreshed by every import. */
export const FACT_COLUMNS = ['name', 'muscle_group', 'secondary_muscles', 'level', 'force', 'mechanic', 'dataset_category'];
/** DualRep's curation (mapping.mjs): written when a row is first imported, then owned by the curators. */
export const CURATED_COLUMNS = [
  'equipment', 'location', 'movement_pattern', 'body_region', 'category', 'demand_level', 'micro_ok',
];
const JSON_COLUMNS = new Set(['secondary_muscles', 'equipment']);
const INCOMING_COLUMNS = ['dataset_id', ...FACT_COLUMNS, ...CURATED_COLUMNS];

// What the CHECK constraints on public.exercises accept (supabase/migrations/20261008000000_initial_schema.sql).
const PATTERNS = [
  'squat', 'hinge', 'lunge', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull', 'carry', 'core',
  'conditioning', 'mobility', 'other',
];
const REGIONS = ['lower', 'upper', 'core', 'full', 'cardio'];
const CATEGORIES = ['strength', 'power', 'conditioning', 'mobility'];
const LOCATIONS = ['gym', 'both'];
const EQUIPMENT = new Set([...HOME_OK_EQUIPMENT, ...GYM_ONLY_EQUIPMENT]);

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Everything about the input that would make the mapping or the SQL wrong, one message per problem.
 * The pinned file has none; a newer upstream copy may (a new muscle, equipment or category value
 * needs a rule before it can be imported, not a silent guess).
 */
export function findDatasetProblems(data) {
  if (!Array.isArray(data)) return ['the file is not a JSON array of exercises'];
  if (data.length === 0) return ['the file has no exercises'];
  const problems = [];
  const seen = new Set();
  for (const [index, ex] of data.entries()) {
    if (ex === null || typeof ex !== 'object' || Array.isArray(ex)) {
      problems.push(`entry ${index}: not an object`);
      continue;
    }
    const label = `entry ${index} (${typeof ex.id === 'string' ? ex.id : 'no id'})`;
    const check = (ok, message) => {
      if (!ok) problems.push(`${label}: ${message}`);
    };
    check(typeof ex.id === 'string' && /^[0-9A-Za-z_-]+$/.test(ex.id), `id must match [0-9A-Za-z_-]+, got ${JSON.stringify(ex.id)}`);
    check(!seen.has(ex.id), 'duplicate id');
    seen.add(ex.id);
    check(
      typeof ex.name === 'string' && ex.name.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(ex.name),
      'name must be non-empty text without control characters',
    );
    check(DATASET_LEVELS.includes(ex.level), `unknown level ${JSON.stringify(ex.level)}`);
    check(ex.force === null || DATASET_FORCES.includes(ex.force), `unknown force ${JSON.stringify(ex.force)}`);
    check(ex.mechanic === null || DATASET_MECHANICS.includes(ex.mechanic), `unknown mechanic ${JSON.stringify(ex.mechanic)}`);
    check(ex.equipment === null || DATASET_EQUIPMENT.includes(ex.equipment), `unknown equipment ${JSON.stringify(ex.equipment)}`);
    check(DATASET_CATEGORIES.includes(ex.category), `unknown category ${JSON.stringify(ex.category)}`);
    check(
      isStringList(ex.primaryMuscles) && ex.primaryMuscles.length > 0 && ex.primaryMuscles.every((m) => MUSCLES.includes(m)),
      `primaryMuscles must be a non-empty list of known muscles, got ${JSON.stringify(ex.primaryMuscles)}`,
    );
    check(
      isStringList(ex.secondaryMuscles) && ex.secondaryMuscles.every((m) => MUSCLES.includes(m)),
      `secondaryMuscles must be a list of known muscles, got ${JSON.stringify(ex.secondaryMuscles)}`,
    );
    // Only their length is used (micro_ok); their content is never imported (D9).
    check(Array.isArray(ex.instructions), 'instructions must be a list');
    check(Array.isArray(ex.images), 'images must be a list');
  }
  return problems;
}

/** A mapped row outside the CHECK constraints would fail the whole import in the SQL Editor; catch it here. */
function findRowProblems(rows) {
  const problems = [];
  for (const row of rows) {
    const check = (ok, message) => {
      if (!ok) problems.push(`${row.dataset_id}: ${message}`);
    };
    check(PATTERNS.includes(row.movement_pattern), `movement_pattern ${row.movement_pattern}`);
    check(REGIONS.includes(row.body_region), `body_region ${row.body_region}`);
    check(CATEGORIES.includes(row.category), `category ${row.category}`);
    check(LOCATIONS.includes(row.location), `location ${row.location}`);
    check([1, 2, 3].includes(row.demand_level), `demand_level ${row.demand_level}`);
    check(typeof row.micro_ok === 'boolean', `micro_ok ${row.micro_ok}`);
    check(isStringList(row.equipment) && row.equipment.every((item) => EQUIPMENT.has(item)), `equipment ${row.equipment}`);
  }
  return problems;
}

/** A SQL literal. Strings use standard quoting ('' for '); JSON columns are cast so the VALUES list is typed. */
function literal(value, isJson) {
  if (isJson) return `${literal(JSON.stringify(value), false)}::jsonb`;
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Comma-separated items wrapped into lines of at most `width` characters, each starting with `indent`. */
function wrap(items, indent, width = 104) {
  const lines = [];
  let line = '';
  for (const [i, item] of items.entries()) {
    const piece = i < items.length - 1 ? `${item},` : item;
    if (line && indent.length + line.length + 1 + piece.length > width) {
      lines.push(indent + line);
      line = piece;
    } else {
      line = line ? `${line} ${piece}` : piece;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

/**
 * The import SQL for a validated dataset (call findDatasetProblems first). `sha256` is the input file's
 * hash, recorded in the header so anyone holding the SQL can tell which copy it came from.
 */
export function buildImportSql(data, { sha256 }) {
  const rows = data.map(mapExercise).sort((a, b) => (a.dataset_id < b.dataset_id ? -1 : a.dataset_id > b.dataset_id ? 1 : 0));
  const problems = findRowProblems(rows);
  if (problems.length > 0) throw new Error(`the mapping produced values the database refuses:\n  ${problems.join('\n  ')}`);

  const source =
    sha256 === PINNED_SHA256
      ? `the pinned copy (yuhonas/free-exercise-db@${DATASET_COMMIT})`
      : 'NOT the pinned copy (built with --allow-unpinned)';
  const header = `-- =================================================================================================
-- DualRep — free-exercise-db import (Phase 1)
--
-- GENERATED by scripts/exercise-import/build-import-sql.mjs; do not edit. Paste it into the Supabase
-- SQL Editor (or run \`psql -f\`) as the project owner. It is one statement, so it runs as one
-- transaction: every row is written, or none is. Running it again is safe.
--
-- Source: dist/exercises.json, sha256 ${sha256},
--         ${source}.
-- Exercises: ${rows.length}
-- Mapping: docs/research/exercise-data-and-fsrs.md §A6 (scripts/exercise-import/mapping.mjs).
--
-- New rows: origin 'dataset', reviewed false (only reviewed rows reach phones), no owner, and no
-- images or instructions: the dataset's text and photos are not imported (docs/DECISIONS.md D9).
-- Rows already imported, matched by dataset_id:
--   * dataset facts (${FACT_COLUMNS.join(', ')})
--     are refreshed; images and instructions are set to [];
--   * curated fields (${CURATED_COLUMNS.join(', ')})
--     are kept, so a curator's fixes survive;
--   * reviewed is kept only when no dataset fact changed; a changed row needs a new review;
--   * a row with nothing to change is not touched (its updated_at stays, phones download nothing).
-- Dataset rows the file no longer has are left as they are.
-- The result row: rows_in_file, inserted, updated, review_reset (reviewed rows that changed and
-- need a new review), unchanged, not_in_file (dataset rows in the database but not in this file).
-- =================================================================================================
`;

  const values = rows.map(
    (row) => `    (${INCOMING_COLUMNS.map((column) => literal(row[column], JSON_COLUMNS.has(column))).join(', ')})`,
  );
  const current = (columns) => columns.map((column) => `e.${column}`);
  const excluded = (columns) => columns.map((column) => `excluded.${column}`);

  return `${header}
with incoming (
${wrap(INCOMING_COLUMNS, '  ')}
) as (
  values
${values.join(',\n')}
),
written as (
  insert into public.exercises as e (
${wrap(INCOMING_COLUMNS, '    ')},
    instructions, images, origin, reviewed, owner_id, group_id
  )
  select
${wrap(INCOMING_COLUMNS, '    ')},
    '[]'::jsonb, '[]'::jsonb, 'dataset', false, null::uuid, null::uuid
  from incoming
  on conflict (dataset_id) do update set
${wrap(
  FACT_COLUMNS.map((column) => `${column} = excluded.${column}`),
  '    ',
)},
    images = '[]', instructions = '[]',
    reviewed = e.reviewed and (
${wrap(current(FACT_COLUMNS), '      ')}
    ) is not distinct from (
${wrap(excluded(FACT_COLUMNS), '      ')}
    )
  -- Only rows with something to change are updated.
  where (
${wrap([...current(FACT_COLUMNS), 'e.images', 'e.instructions'], '    ')}
  ) is distinct from (
${wrap([...excluded(FACT_COLUMNS), 'excluded.images', 'excluded.instructions'], '    ')}
  )
  -- xmax is 0 on a freshly inserted row and set on one updated by ON CONFLICT.
  returning e.dataset_id, e.xmax = 0 as inserted, e.reviewed
)
-- public.exercises below is read as it was before this statement (data-modifying WITH semantics).
select
  (select count(*) from incoming) as rows_in_file,
  (select count(*) from written where inserted) as inserted,
  (select count(*) from written where not inserted) as updated,
  (select count(*) from written w join public.exercises prior on prior.dataset_id = w.dataset_id
    where prior.reviewed and not w.reviewed) as review_reset,
  (select count(*) from incoming) - (select count(*) from written) as unchanged,
  (select count(*) from public.exercises x
    where x.origin = 'dataset' and not exists (select 1 from incoming i where i.dataset_id = x.dataset_id)) as not_in_file;
`;
}

// --- CLI -----------------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/exercise-import/build-import-sql.mjs <exercises.json> --out <file.sql> [--allow-unpinned]';

/** Runs the command line and returns the exit code (exported for the tests). */
export function main(argv, { log = console.log, error = console.error } = {}) {
  const args = [...argv];
  let input = null;
  let out = null;
  let allowUnpinned = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--out') out = args.shift() ?? null;
    else if (arg === '--allow-unpinned') allowUnpinned = true;
    else if (arg.startsWith('--') || input !== null) {
      error(`build-import-sql: unexpected argument ${arg}\n${USAGE}`);
      return 2;
    } else input = arg;
  }
  if (input === null || out === null) {
    error(USAGE);
    return 2;
  }

  let bytes;
  try {
    bytes = readFileSync(input);
  } catch (e) {
    error(`build-import-sql: cannot read ${input}: ${e.message}`);
    return 1;
  }
  const sha256 = sha256Of(bytes);
  if (sha256 !== PINNED_SHA256 && !allowUnpinned) {
    error(
      `build-import-sql: ${input} is not the pinned dataset.\n` +
        `  expected sha256 ${PINNED_SHA256}\n  got      ${sha256}\n` +
        `Download ${DATASET_URL}, or pass --allow-unpinned to build from another copy on purpose.`,
    );
    return 1;
  }

  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    error(`build-import-sql: ${input} is not valid JSON: ${e.message}`);
    return 1;
  }
  const problems = findDatasetProblems(data);
  if (problems.length > 0) {
    const shown = problems.slice(0, 25);
    const more = problems.length > shown.length ? `\n  ... and ${problems.length - shown.length} more` : '';
    error(`build-import-sql: ${input} cannot be imported:\n  ${shown.join('\n  ')}${more}`);
    return 1;
  }

  let sql;
  try {
    sql = buildImportSql(data, { sha256 });
  } catch (e) {
    error(`build-import-sql: ${e.message}`);
    return 1;
  }
  writeFileSync(out, sql);
  const pin = sha256 === PINNED_SHA256 ? 'pinned' : 'NOT pinned';
  log(`build-import-sql: wrote ${out} (${data.length} exercises, sha256 ${sha256}, ${pin})`);
  return 0;
}

// Run only when executed directly (the tests import this file). Node resolves symlinks for the main
// module, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
