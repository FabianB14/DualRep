// Usage: node scripts/exercise-import/map-free-exercise-db.mjs <exercises.json> [--dump <out.json>] [--show <pattern|region|...>]
// Applies DualRep curation heuristics to free-exercise-db rows and prints distributions.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const src = args[0];
const dumpIdx = args.indexOf('--dump');
const showIdx = args.indexOf('--show');
const data = JSON.parse(readFileSync(src, 'utf8'));

// ---------- muscle families ----------
const LOWER = new Set(['quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors']);
const UPPER = new Set(['chest', 'shoulders', 'triceps', 'biceps', 'forearms', 'lats', 'middle back', 'traps', 'neck']);
const CORE = new Set(['abdominals', 'lower back']);

// ---------- equipment ----------
const BASE_EQUIP = {
  'body only': 'bodyweight', barbell: 'barbell', dumbbell: 'dumbbell', cable: 'cable', machine: 'machine',
  kettlebells: 'kettlebell', bands: 'band', 'medicine ball': 'medicine_ball', 'exercise ball': 'stability_ball',
  'foam roll': 'foam_roller', 'e-z curl bar': 'ez_bar',
};
// Name-based refinement for 'other' and null (first match wins)
const NAME_EQUIP = [
  [/atlas stone|keg|yoke|\blog lift|tire flip|axle|car deadlift|rickshaw|circus bell|conan/i, 'strongman_implement'],
  [/\bsled\b|prowler/i, 'sled'],
  [/trap bar/i, 'trap_bar'],
  [/battling rope/i, 'battle_rope'],
  [/rope jumping|jump rope/i, 'jump_rope'],
  [/suspended|suspension|\btrx\b|ring dip|\brings?\b|inverted row with straps/i, 'suspension_trainer'],
  [/rope climb/i, 'climbing_rope'],
  [/pull-?ups?\b|\bchin(s|-up|-ups)?\b|muscle.?up|hanging|otis|scapular pull|toes.to.bar|london bridge/i, 'pull_up_bar'],
  [/(?<!bench )\bdips?\b|parallel bar/i, 'dip_station'],
  [/plate|wrist roller/i, 'weight_plate'],
  [/ab roller|rollout/i, 'ab_wheel'],
  [/balance board/i, 'balance_board'],
  [/bicycling$|stationary|elliptical|treadmill|recumbent|rowing, stationary|rowing_stationary|stairmaster|step mill/i, 'cardio_machine'],
  [/hyperextension|back extension|glute.ham|ghr/i, 'hyperextension_bench'],
  [/\bbox\b|bench jump|step.?up|platform/i, 'box'],
  [/band/i, 'band'],
  [/dumbbell/i, 'dumbbell'],
  [/kettlebell/i, 'kettlebell'],
  [/barbell/i, 'barbell'],
  [/cable/i, 'cable'],
  [/smith|lever|leverage|machine/i, 'machine'],
];
const BENCH_RX = /bench|incline|decline|preacher|seated .*press|lying .*(extension|curl|row|fly|flye)/i;

function normalizeEquipment(ex) {
  let primary = ex.equipment ? BASE_EQUIP[ex.equipment] ?? null : null;
  if (ex.equipment === 'other' || ex.equipment === null) {
    const hit = NAME_EQUIP.find(([rx]) => rx.test(ex.name));
    if (hit) primary = hit[1];
    else if (ex.equipment === null) primary = 'bodyweight'; // null rows are overwhelmingly bodyweight/stretches
    else primary = 'other';
  }
  if (ex.category === 'cardio' && primary === 'machine') primary = 'cardio_machine';
  const items = new Set([primary]);
  if (BENCH_RX.test(ex.name) && !['machine', 'cable', 'cardio_machine'].includes(primary)) items.add('bench');
  if (primary === 'barbell' && /squat|bench press|overhead press|military|shoulder press|rack/i.test(ex.name)) items.add('rack');
  // Implied fixtures the dataset omits (e.g. 'body only' pull-ups still need a bar)
  if (/pull-?ups?\b|\bchin(s|-up|-ups)?\b|hanging|muscle.?up|toes.to.bar/i.test(ex.name)) items.add('pull_up_bar');
  if (/(?<!bench )\bdips?\b|parallel bar/i.test(ex.name) && !items.has('machine') && !items.has('suspension_trainer')) items.add('dip_station');
  if (/inverted row(?! with straps)/i.test(ex.name)) items.add('rack');
  if (/box jump|step.?up/i.test(ex.name) && !items.has('box')) items.add('box');
  if (items.size > 1) items.delete('bodyweight');
  return [...items];
}

const GYM_ONLY = new Set(['barbell', 'ez_bar', 'cable', 'machine', 'sled', 'strongman_implement', 'trap_bar',
  'cardio_machine', 'hyperextension_bench', 'rack', 'battle_rope', 'climbing_rope', 'dip_station', 'other']);
const HOME_OK = new Set(['bodyweight', 'dumbbell', 'kettlebell', 'band', 'medicine_ball', 'stability_ball', 'foam_roller',
  'pull_up_bar', 'bench', 'box', 'jump_rope', 'suspension_trainer', 'weight_plate', 'ab_wheel', 'balance_board']);

function location(equip) {
  if (equip.some((e) => GYM_ONLY.has(e))) return 'gym';
  if (equip.every((e) => HOME_OK.has(e))) return 'both';
  return 'gym';
}

// ---------- movement pattern (ordered, first match wins) ----------
const ABS = (ex) => ex.primaryMuscles[0] === 'abdominals';
const P = [
  ['mobility', (ex) => ex.category === 'stretching' || /stretch|smr\b|-smr|foam roll|circles|mobility|world's greatest/i.test(ex.name)],
  ['core', (ex) => /turkish get-?up|landmine 180|hanging pike|wind sprints|frog sit/i.test(ex.name)],
  ['conditioning', (ex) => ex.category === 'cardio' ||
    (!ABS(ex) && !/chest/i.test(ex.name) &&
     /rope jumping|jump rope|battling rope|sled push|prowler|burpee|mountain climber|jumping jack|sprint|shuttle|carioca|high knee|butt kick|bear crawl|\bskip|quick step|agility|cone hop|\b(run|running|jog|jogging)\b|star jump|line hop|hurdle hop|bound\b/i.test(ex.name))],
  ['carry', (ex) => /farmer|carry|yoke walk|suitcase|waiter|\bdrag\b(?! curl)|sled .*walk|overhead backward walk|conan/i.test(ex.name)],
  ['lunge', (ex) => /lunge|split squat|split jump|step.?up|bulgarian|pistol|single.leg (box )?squat|one.leg squat|skater|scissor/i.test(ex.name)],
  ['squat', (ex) => !ABS(ex) && /squat|leg press|hack|thruster|wall sit|sissy|box jump|jump squat|tuck jump/i.test(ex.name) && !/good morning|calf|jerk/i.test(ex.name)],
  ['hinge', (ex) => /deadlift|good morning|romanian|\brdl\b|stiff.leg|hip thrust|glute bridge|butt lift|pull.through|swing|hyperextension|back extension|clean|snatch|rack pull|glute.ham|kettlebell .*high pull|reverse hyper|atlas|keg load|sandbag load|tire flip/i.test(ex.name)],
  ['vertical_pull', (ex) => ex.primaryMuscles[0] !== 'triceps' && !ABS(ex) &&
    /\bpull-?ups?\b|\bpullups?\b|\bchin(s|-up|-ups)?\b|pulldown|pull-down|muscle.?up|rope climb|london bridge/i.test(ex.name)],
  ['horizontal_pull', (ex) => /\brows?\b|rowing|face pull|reverse fly|reverse flye|rear delt|inverted row|pull apart|high pull\b|sled row/i.test(ex.name) && !/upright/i.test(ex.name)],
  ['vertical_push', (ex) => !ABS(ex) &&
    /overhead press|shoulder press|military|push press|jerk|arnold|handstand|landmine .*(press|jammer)|linear jammer|z press|press behind|behind the neck|seated .*press|standing .*press|dumbbell press|log lift|circus bell|\bdips?\b|bradford|kettlebell .*press|see-?saw press|para press|cuban press|anti-gravity press|alternating .*press/i.test(ex.name)
    && !/bench|chest|floor|leg press|calf|incline|decline|close-grip dumbbell|triceps press|tricep press/i.test(ex.name)],
  ['horizontal_push', (ex) => /bench press|push-?ups?\b|pushup|chest press|floor press|\bflye?s?\b|crossover|pec deck|butterfly|svend|chest push|chest pass|incline .*press|decline .*press|dumbbell press|board press|pin press|close.grip .*press/i.test(ex.name)
    && ex.primaryMuscles[0] !== 'shoulders' && !LOWER.has(ex.primaryMuscles[0]) || (ex.primaryMuscles[0] === 'chest' && ex.force === 'push')],
  ['core', (ex) => ABS(ex) ||
    /crunch|sit-?up|plank|leg raise|knee raise|knee.hip raise|rollout|ab roller|russian twist|wood ?chop|pallof|side bridge|jackknife|v-up|flutter|dead bug|bird dog|hollow|superman|windmill|bicycle|oblique|twist/i.test(ex.name)],
];
// Isolation / leftover fallback by primary muscle so location swaps still find a peer.
const MUSCLE_FALLBACK = {
  chest: 'horizontal_push', quadriceps: 'squat', hamstrings: 'hinge', glutes: 'hinge', lats: 'vertical_pull',
  'middle back': 'horizontal_pull', 'lower back': 'hinge', abdominals: 'core',
};

function movementPattern(ex) {
  const hit = P.find(([, f]) => f(ex));
  if (hit) return hit[0];
  if (ex.category === 'plyometrics') return LOWER.has(ex.primaryMuscles[0]) ? 'conditioning' : 'other';
  if (ex.primaryMuscles[0] === 'shoulders' && ex.mechanic === 'compound' && ex.force === 'push') return 'vertical_push';
  return MUSCLE_FALLBACK[ex.primaryMuscles[0]] ?? 'other';
}

// ---------- body region ----------
function bodyRegion(ex, pattern) {
  if (ex.category === 'cardio' || pattern === 'conditioning') return 'cardio';
  if (ex.category === 'olympic weightlifting' || /thruster|burpee|turkish get|man.?maker|clean and press|tire flip|atlas|keg load|sandbag load|squat jerk|split jerk|power jerk/i.test(ex.name)) return 'full';
  if (pattern === 'carry') return 'full';
  const m = ex.primaryMuscles[0];
  if (m === 'lower back') return pattern === 'hinge' ? 'lower' : 'core';
  if (LOWER.has(m)) return 'lower';
  if (UPPER.has(m)) return 'upper';
  if (CORE.has(m)) return 'core';
  return 'full';
}

// ---------- category ----------
const CATEGORY = {
  strength: 'strength', powerlifting: 'strength', strongman: 'strength',
  'olympic weightlifting': 'power', plyometrics: 'power', cardio: 'conditioning', stretching: 'mobility',
};

// ---------- demand level 1..3 ----------
function demandLevel(ex, pattern, equip) {
  if (ex.category === 'stretching' || pattern === 'mobility') return 1;
  if (['olympic weightlifting', 'powerlifting', 'strongman'].includes(ex.category)) return 3;
  if (ex.level === 'expert') return 3;
  if (ex.mechanic === 'compound' && equip.some((e) => ['barbell', 'trap_bar'].includes(e)) &&
      ['squat', 'hinge', 'lunge', 'horizontal_push', 'vertical_push'].includes(pattern)) return 3;
  if (/depth jump|drop jump|clap|plyo push/i.test(ex.name)) return 3;
  if (ex.mechanic === 'isolation' && ex.level === 'beginner') return 1;
  if (pattern === 'core' && ex.level === 'beginner') return 1;
  if (ex.primaryMuscles[0] === 'neck' || equip.includes('foam_roller')) return 1;
  return 2;
}

// ---------- micro_ok ----------
const MICRO_EQUIP = new Set(['bodyweight', 'band', 'dumbbell', 'kettlebell', 'jump_rope', 'pull_up_bar', 'stability_ball', 'bench', 'box']);
function microOk(ex, loc, demand, equip, pattern) {
  if (loc !== 'both') return false;
  if (demand > 2) return false;
  if (ex.level === 'expert') return false;
  if (!equip.every((e) => MICRO_EQUIP.has(e))) return false;
  if (/partner|assisted|with a spotter|throw|toss|slam|wall ball|against wall/i.test(ex.name)) return false;
  if (ex.images.length === 0 || ex.instructions.length === 0) return false;
  if (ex.primaryMuscles[0] === 'neck') return false;
  if (pattern === 'mobility' && equip.includes('foam_roller')) return false;
  return true;
}

const rows = data.map((ex) => {
  const equip = normalizeEquipment(ex);
  const pattern = movementPattern(ex);
  const loc = location(equip);
  const demand = demandLevel(ex, pattern, equip);
  return {
    dataset_id: ex.id,
    name: ex.name.trim(),
    muscle_group: ex.primaryMuscles[0],
    secondary_muscles: ex.secondaryMuscles,
    body_region: bodyRegion(ex, pattern),
    category: pattern === 'conditioning' ? 'conditioning' : CATEGORY[ex.category],
    dataset_category: ex.category,
    equipment: equip,
    location: loc,
    movement_pattern: pattern,
    demand_level: demand,
    micro_ok: microOk(ex, loc, demand, equip, pattern),
    level: ex.level,
    mechanic: ex.mechanic,
    force: ex.force,
  };
});

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
