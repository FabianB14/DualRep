// Usage: node scripts/exercise-import/enum-counts.mjs /path/to/exercises.json [/path/to/schema.json]
// Prints total count, per-field value counts, field-shape checks, and image stats.
import { readFileSync } from 'node:fs';

const [, , jsonPath, schemaPath] = process.argv;
if (!jsonPath) {
  console.error('usage: node enum-counts.mjs <exercises.json> [schema.json]');
  process.exit(2);
}
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
if (!Array.isArray(data)) throw new Error('expected top-level array');

const out = {};
out.total = data.length;

// Key shape
const keySets = {};
for (const ex of data) {
  const k = Object.keys(ex).sort().join(',');
  keySets[k] = (keySets[k] || 0) + 1;
}
out.keySets = keySets;

function tally(field, isArray = false) {
  const counts = {};
  for (const ex of data) {
    const v = ex[field];
    const vals = isArray ? (Array.isArray(v) ? v : [`<non-array:${JSON.stringify(v)}>`]) : [v];
    for (const x of vals) {
      const key = x === null ? '<null>' : x === undefined ? '<missing>' : String(x);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

for (const f of ['force', 'level', 'mechanic', 'equipment', 'category']) out[f] = tally(f);
out.primaryMuscles = tally('primaryMuscles', true);
out.secondaryMuscles = tally('secondaryMuscles', true);

// primaryMuscles array length distribution
const pmLen = {};
const smLen = {};
const imgLen = {};
const insLen = {};
for (const ex of data) {
  pmLen[ex.primaryMuscles?.length ?? 'x'] = (pmLen[ex.primaryMuscles?.length ?? 'x'] || 0) + 1;
  smLen[ex.secondaryMuscles?.length ?? 'x'] = (smLen[ex.secondaryMuscles?.length ?? 'x'] || 0) + 1;
  imgLen[ex.images?.length ?? 'x'] = (imgLen[ex.images?.length ?? 'x'] || 0) + 1;
  insLen[ex.instructions?.length ?? 'x'] = (insLen[ex.instructions?.length ?? 'x'] || 0) + 1;
}
out.primaryMusclesArrayLength = pmLen;
out.secondaryMusclesArrayLength = smLen;
out.imagesArrayLength = imgLen;
out.instructionsArrayLength = insLen;

// id uniqueness and pattern; image path convention `${id}/<n>.jpg`
const ids = new Map();
let badIdPattern = 0;
let imgNotIdPrefixed = [];
const imgExt = {};
for (const ex of data) {
  ids.set(ex.id, (ids.get(ex.id) || 0) + 1);
  if (!/^[0-9a-zA-Z_-]+$/.test(ex.id)) badIdPattern++;
  for (const p of ex.images || []) {
    const ext = p.split('.').pop();
    imgExt[ext] = (imgExt[ext] || 0) + 1;
    if (!p.startsWith(ex.id + '/')) imgNotIdPrefixed.push([ex.id, p]);
  }
}
out.duplicateIds = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
out.badIdPattern = badIdPattern;
out.imageExtensions = imgExt;
out.imagesNotPrefixedById = imgNotIdPrefixed.slice(0, 20);
out.imagesNotPrefixedByIdCount = imgNotIdPrefixed.length;
out.totalImages = Object.values(imgExt).reduce((a, b) => a + b, 0);

// Duplicate names (case-insensitive)
const names = new Map();
for (const ex of data) {
  const n = ex.name.trim().toLowerCase();
  names.set(n, (names.get(n) || 0) + 1);
}
out.duplicateNames = [...names].filter(([, n]) => n > 1).map(([n]) => n);

// Cross-tab category x equipment
const xt = {};
for (const ex of data) {
  const c = ex.category;
  const e = ex.equipment ?? '<null>';
  xt[c] ??= {};
  xt[c][e] = (xt[c][e] || 0) + 1;
}
out.categoryByEquipment = xt;

// Values not in schema enums
if (schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const p = schema.properties;
  const enumOf = (prop) => (p[prop].enum ?? (Array.isArray(p[prop].items) ? p[prop].items[0].enum : p[prop].items?.enum)) || [];
  const violations = {};
  for (const f of ['force', 'level', 'mechanic', 'equipment', 'category']) {
    const allowed = new Set(enumOf(f));
    for (const ex of data) if (!allowed.has(ex[f])) (violations[f] ??= []).push([ex.id, ex[f]]);
  }
  for (const f of ['primaryMuscles', 'secondaryMuscles']) {
    const allowed = new Set(enumOf(f));
    for (const ex of data) for (const m of ex[f]) if (!allowed.has(m)) (violations[f] ??= []).push([ex.id, m]);
  }
  out.schemaEnumViolations = violations;
  out.schemaEnums = Object.fromEntries(
    ['force', 'level', 'mechanic', 'equipment', 'primaryMuscles', 'secondaryMuscles', 'category'].map((f) => [f, enumOf(f)])
  );
}

console.log(JSON.stringify(out, null, 2));
