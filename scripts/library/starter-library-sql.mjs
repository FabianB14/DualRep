#!/usr/bin/env node
/**
 * Writes the starter-library migration from the app's own data (`npm run check:library` checks it).
 *
 *   node scripts/library/starter-library-sql.mjs           write supabase/migrations/20261008120000_starter_library.sql
 *   node scripts/library/starter-library-sql.mjs --check   exit 1 if that file differs from what would be written
 *
 * The data is src/features/training/starterLibraryData.ts, imported directly through Node's built-in
 * TypeScript type stripping (as scripts/validate-sync-config.mjs does with src/db/tables.ts), so the
 * app and the database are always seeded from one list. The output is deterministic: entries in file
 * order, one `insert ... on conflict (id) do update` that sets every column, so running it again
 * restores each starter row exactly (also a row someone edited by hand).
 *
 * A migration runs once per database. After this one has been applied to the hosted project, a change
 * to the starter library needs a NEW migration: point MIGRATION below at a new timestamped file and
 * keep the old one as it is. The upsert covers the whole library, so the new file simply supersedes
 * the old one. (Retiring an exercise is a separate, hand-written delete; its id is never reused.)
 *
 * Exit code: 0 = written / up to date, 1 = out of date or invalid data.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
const DATA = 'src/features/training/starterLibraryData.ts';
const MIGRATION = 'supabase/migrations/20261008120000_starter_library.sql';

// --- Runtime flags -------------------------------------------------------------------------------
// Type stripping is on by default from Node 22.18; older 22.x need --experimental-strip-types.
// The script re-runs itself once with whatever is missing, plus filters for the harmless
// "experimental" / "module type" warnings that importing a .ts file prints.
const RESPAWNED = 'DUALREP_STARTER_LIBRARY_SQL_CHILD';
if (!process.env[RESPAWNED]) {
  const flags = ['--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];
  if (!process.features.typescript) flags.push('--experimental-strip-types');
  const child = spawnSync(process.execPath, [...flags, ...process.execArgv, scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [RESPAWNED]: '1' },
  });
  if (child.error) console.error(`starter-library-sql: could not start Node: ${child.error.message}`);
  process.exit(child.status ?? 1);
}
if (!process.features.typescript) {
  console.error(`starter-library-sql: Node ${process.version} cannot import TypeScript; use Node 22.13+ or 24.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--check');
if (unknown.length > 0) {
  console.error(`starter-library-sql: unknown argument ${unknown.join(' ')} (only --check is accepted)`);
  process.exit(1);
}
const check = args.includes('--check');

const { STARTER_EXERCISES, STARTER_ID_PREFIX } = await import(pathToFileURL(path.join(repoRoot, DATA)).href);

// --- Validation ----------------------------------------------------------------------------------
// Only what the SQL itself depends on. Vocabulary is checked by the unit test and, for good, by the
// CHECK constraints when the migration is applied (npm run db:test).
const problems = [];
const seenIds = new Set();
for (const [index, entry] of STARTER_EXERCISES.entries()) {
  const label = `entry ${index} (${entry.name ?? 'no name'})`;
  if (!new RegExp(`^${STARTER_ID_PREFIX}[0-9a-f]{4}$`).test(entry.id)) problems.push(`${label}: bad id ${entry.id}`);
  if (seenIds.has(entry.id)) problems.push(`${label}: duplicate id ${entry.id}`);
  seenIds.add(entry.id);
  if (typeof entry.name !== 'string' || entry.name.trim() === '') problems.push(`${label}: missing name`);
  for (const key of ['secondaryMuscles', 'equipment', 'instructions']) {
    if (!Array.isArray(entry[key]) || entry[key].some((item) => typeof item !== 'string')) {
      problems.push(`${label}: ${key} must be a list of strings`);
    }
  }
  if (![1, 2, 3].includes(entry.demandLevel)) problems.push(`${label}: demandLevel must be 1, 2 or 3`);
  if (typeof entry.microOk !== 'boolean') problems.push(`${label}: microOk must be a boolean`);
}
if (problems.length > 0) {
  console.error(`starter-library-sql: ${DATA} is invalid:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// --- SQL -----------------------------------------------------------------------------------------
const text = (value) => (value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`);
const json = (value) => text(JSON.stringify(value));

/** Columns in insert order, each with how a starter entry fills it. created_at/updated_at keep their defaults. */
const COLUMNS = [
  ['id', (e) => text(e.id)],
  ['name', (e) => text(e.name)],
  ['muscle_group', (e) => text(e.muscleGroup)],
  ['secondary_muscles', (e) => json(e.secondaryMuscles)],
  ['body_region', (e) => text(e.bodyRegion)],
  ['category', (e) => text(e.category)],
  ['dataset_category', () => 'null'],
  ['equipment', (e) => json(e.equipment)],
  ['location', (e) => text(e.location)],
  ['movement_pattern', (e) => text(e.movementPattern)],
  ['demand_level', (e) => String(e.demandLevel)],
  ['level', (e) => text(e.level)],
  ['force', (e) => text(e.force)],
  ['mechanic', (e) => text(e.mechanic)],
  ['micro_ok', (e) => String(e.microOk)],
  ['instructions', (e) => json(e.instructions)],
  ['images', () => "'[]'"],
  ['origin', () => "'interverse'"],
  ['dataset_id', () => 'null'],
  ['reviewed', () => 'true'],
  ['owner_id', () => 'null'],
  ['group_id', () => 'null'],
];

/** Wraps comma-separated items into lines of at most `width` characters after `indent`. */
function wrap(items, indent, width = 100) {
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

/** A jsonb list with one item per line (whitespace inside a jsonb literal is not stored). */
function jsonLines(items, indent) {
  return text(`[${items.map((item) => JSON.stringify(item)).join(`,\n${indent} `)}]`);
}

const rows = STARTER_EXERCISES.map((entry) => {
  const values = COLUMNS.map(([column, value]) => (column === 'instructions' ? null : value(entry)));
  // One block per row: the columns before the instructions, the instructions one per line, the rest.
  const at = COLUMNS.findIndex(([column]) => column === 'instructions');
  return [
    `  (${wrap(values.slice(0, at), '   ').trimStart()},`,
    `   ${jsonLines(entry.instructions, '   ')},`,
    `${wrap(values.slice(at + 1), '   ')})`,
  ].join('\n');
});

const header = `-- =================================================================================================
-- DualRep — Interverse starter library (Phase 1)
--
-- GENERATED by scripts/library/starter-library-sql.mjs from ${DATA}.
-- Do not edit by hand: change the data file, run \`node scripts/library/starter-library-sql.mjs\`, and
-- commit both. \`npm run check:library\` (part of \`npm run check\`) fails while this file is out of date.
--
-- ${STARTER_EXERCISES.length} exercises written by Interverse: origin 'interverse', reviewed, no owner, no
-- dataset id, no images, instructions in our own words. Their ids are fixed
-- (${STARTER_ID_PREFIX}XXXX) because the app bundles the same list and uses it before
-- its first sync; a retired id is never reused. The upsert sets every column, so running it again
-- restores each starter row exactly.
-- =================================================================================================
`;

const sql = `${header}
insert into public.exercises (
${wrap(
  COLUMNS.map(([column]) => column),
  '  ',
)}
) values
${rows.join(',\n')}
on conflict (id) do update set
${wrap(
  COLUMNS.filter(([column]) => column !== 'id').map(([column]) => `${column} = excluded.${column}`),
  '  ',
)};
`;

const target = path.join(repoRoot, MIGRATION);
if (check) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current !== sql) {
    console.error(
      `starter-library-sql: ${MIGRATION} is ${current === null ? 'missing' : 'out of date'}. ` +
        'Run `node scripts/library/starter-library-sql.mjs` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`starter-library-sql: ${MIGRATION} is up to date (${STARTER_EXERCISES.length} exercises).`);
} else {
  writeFileSync(target, sql);
  console.log(`starter-library-sql: wrote ${MIGRATION} (${STARTER_EXERCISES.length} exercises).`);
}
