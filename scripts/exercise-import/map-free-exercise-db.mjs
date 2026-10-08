// Usage: node scripts/exercise-import/map-free-exercise-db.mjs <exercises.json> [--dump <out.json>] [--show <field=value>]
// Applies DualRep's curation rules (mapping.mjs, research §A6) to free-exercise-db rows and prints the
// distributions, so a curator can see what a rule change does before importing.
//   --dump <out.json>     write every mapped row
//   --show <field=value>  list the rows with that value, e.g. --show movement_pattern=other
import { readFileSync, writeFileSync } from 'node:fs';

import { mapExercise } from './mapping.mjs';

const args = process.argv.slice(2);
const src = args[0];
if (!src || src.startsWith('--')) {
  console.error('usage: node map-free-exercise-db.mjs <exercises.json> [--dump <out.json>] [--show <field=value>]');
  process.exit(2);
}
const dumpIdx = args.indexOf('--dump');
const showIdx = args.indexOf('--show');
const data = JSON.parse(readFileSync(src, 'utf8'));

const rows = data.map(mapExercise);

const tally = (k, f = (r) => r[k]) => {
  const c = {};
  for (const r of rows) for (const v of [].concat(f(r))) c[v] = (c[v] || 0) + 1;
  return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]));
};
const out = {
  total: rows.length,
  body_region: tally('body_region'),
  category: tally('category'),
  equipment_items: tally('equipment'),
  primary_equipment: tally('x', (r) => r.equipment[0]),
  location: tally('location'),
  movement_pattern: tally('movement_pattern'),
  demand_level: tally('demand_level'),
  micro_ok: tally('micro_ok'),
  micro_ok_by_pattern: tally('x', (r) => (r.micro_ok ? r.movement_pattern : [])),
};
console.log(JSON.stringify(out, null, 2));

if (showIdx > -1) {
  const [field, value] = args[showIdx + 1].split('=');
  const list = rows.filter((r) => String([].concat(r[field])[0]) === value || [].concat(r[field]).map(String).includes(value));
  console.log(`\n--- ${field}=${value} (${list.length}) ---`);
  console.log(list.map((r) => `${r.name} | ${r.dataset_category} | ${r.muscle_group} | ${r.equipment.join('+')} | ${r.movement_pattern} | ${r.body_region} | d${r.demand_level} | micro=${r.micro_ok}`).join('\n'));
}
if (dumpIdx > -1) writeFileSync(args[dumpIdx + 1], JSON.stringify(rows, null, 1));
