/**
 * DualRep's curation rules for free-exercise-db rows (docs/research/exercise-data-and-fsrs.md §A6).
 *
 * Pure functions, no I/O: build-import-sql.mjs turns their output into the import SQL, and
 * map-free-exercise-db.mjs prints their distributions for a curator. The rules are ordered and the
 * first match wins; all name matching is case-insensitive. Word boundaries are deliberate: without
 * them "crunch" matches "run" and "machine" matches "chin" (mapping.test.mjs checks both).
 *
 * These rules only fill the CURATED columns of a new row (equipment, location, movement_pattern,
 * body_region, category, demand_level, micro_ok). A re-import never rewrites them, so a curator's fixes
 * survive; it also means a rule change here reaches rows imported later, not rows already in the
 * database (fix those by hand, or in a one-off SQL update).
 *
 * The equipment words are the app's vocabulary (src/features/training/equipment.ts). This file is
 * plain JavaScript so the import runs on any Node 22 without TypeScript support; mapping.test.mjs
 * checks that the two lists agree.
 */

// ---------- dataset vocabulary (research §A4) ----------

/** The 17 muscle names free-exercise-db uses (primaryMuscles and secondaryMuscles). */
export const MUSCLES = [
  'quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors',
  'chest', 'shoulders', 'triceps', 'biceps', 'forearms', 'lats', 'middle back', 'traps', 'neck',
  'abdominals', 'lower back',
];
export const LOWER_MUSCLES = new Set(['quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors']);
export const UPPER_MUSCLES = new Set([
  'chest', 'shoulders', 'triceps', 'biceps', 'forearms', 'lats', 'middle back', 'traps', 'neck',
]);
export const CORE_MUSCLES = new Set(['abdominals', 'lower back']);

export const DATASET_LEVELS = ['beginner', 'intermediate', 'expert'];
export const DATASET_FORCES = ['push', 'pull', 'static'];
export const DATASET_MECHANICS = ['compound', 'isolation'];
export const DATASET_CATEGORIES = [
  'strength', 'stretching', 'plyometrics', 'powerlifting', 'olympic weightlifting', 'strongman', 'cardio',
];

// ---------- equipment ----------

/** The dataset's equipment value → ours. `other` and null are refined from the name (NAME_EQUIPMENT). */
export const BASE_EQUIPMENT = {
  'body only': 'bodyweight', barbell: 'barbell', dumbbell: 'dumbbell', cable: 'cable', machine: 'machine',
  kettlebells: 'kettlebell', bands: 'band', 'medicine ball': 'medicine_ball', 'exercise ball': 'stability_ball',
  'foam roll': 'foam_roller', 'e-z curl bar': 'ez_bar',
};
/** Every equipment value the dataset uses (null aside). */
export const DATASET_EQUIPMENT = [...Object.keys(BASE_EQUIPMENT), 'other'];

/** Name-based refinement for 'other' and null equipment (first match wins). */
const NAME_EQUIPMENT = [
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
const BENCH_NAME = /bench|incline|decline|preacher|seated .*press|lying .*(extension|curl|row|fly|flye)/i;

/** Items that need a gym (equipment.ts GYM_ONLY_EQUIPMENT). */
export const GYM_ONLY_EQUIPMENT = new Set([
  'barbell', 'ez_bar', 'cable', 'machine', 'sled', 'strongman_implement', 'trap_bar', 'cardio_machine',
  'hyperextension_bench', 'rack', 'battle_rope', 'climbing_rope', 'dip_station', 'other',
]);
/** Items a home can have (equipment.ts EQUIPMENT minus the gym-only ones). */
export const HOME_OK_EQUIPMENT = new Set([
  'bodyweight', 'dumbbell', 'kettlebell', 'band', 'medicine_ball', 'stability_ball', 'foam_roller', 'pull_up_bar',
  'bench', 'box', 'jump_rope', 'suspension_trainer', 'weight_plate', 'ab_wheel', 'balance_board',
]);
/** Gear that is quick to pick up between study blocks (micro_ok). */
export const MICRO_EQUIPMENT = new Set([
  'bodyweight', 'band', 'dumbbell', 'kettlebell', 'jump_rope', 'pull_up_bar', 'stability_ball', 'bench', 'box',
]);

/** The items an exercise needs: the dataset's value mapped and refined, plus fixtures it implies. */
export function normalizeEquipment(ex) {
  let primary = ex.equipment ? BASE_EQUIPMENT[ex.equipment] ?? null : null;
  if (ex.equipment === 'other' || ex.equipment === null) {
    const hit = NAME_EQUIPMENT.find(([rx]) => rx.test(ex.name));
    if (hit) primary = hit[1];
    else if (ex.equipment === null) primary = 'bodyweight'; // null rows are overwhelmingly bodyweight/stretches
    else primary = 'other';
  }
  if (ex.category === 'cardio' && primary === 'machine') primary = 'cardio_machine';
  const items = new Set([primary]);
  if (BENCH_NAME.test(ex.name) && !['machine', 'cable', 'cardio_machine'].includes(primary)) items.add('bench');
  if (primary === 'barbell' && /squat|bench press|overhead press|military|shoulder press|rack/i.test(ex.name)) {
    items.add('rack');
  }
  // Implied fixtures the dataset omits (e.g. 'body only' pull-ups still need a bar).
  if (/pull-?ups?\b|\bchin(s|-up|-ups)?\b|hanging|muscle.?up|toes.to.bar/i.test(ex.name)) items.add('pull_up_bar');
  if (/(?<!bench )\bdips?\b|parallel bar/i.test(ex.name) && !items.has('machine') && !items.has('suspension_trainer')) {
    items.add('dip_station');
  }
  if (/inverted row(?! with straps)/i.test(ex.name)) items.add('rack');
  if (/box jump|step.?up/i.test(ex.name) && !items.has('box')) items.add('box');
  if (items.size > 1) items.delete('bodyweight');
  return [...items];
}

/**
 * 'gym' when any item needs a gym, else 'both'. Dataset rows are never 'home' alone: anything you can
 * do at home you can also do at a gym ('home' is for Interverse desk-side originals).
 */
export function exerciseLocation(equipment) {
  if (equipment.some((e) => GYM_ONLY_EQUIPMENT.has(e))) return 'gym';
  if (equipment.every((e) => HOME_OK_EQUIPMENT.has(e))) return 'both';
  return 'gym';
}

// ---------- movement pattern (ordered, first match wins) ----------

const absPrimary = (ex) => ex.primaryMuscles[0] === 'abdominals';
const PATTERN_RULES = [
  ['mobility', (ex) => ex.category === 'stretching' || /stretch|smr\b|-smr|foam roll|circles|mobility|world's greatest/i.test(ex.name)],
  ['core', (ex) => /turkish get-?up|landmine 180|hanging pike|wind sprints|frog sit/i.test(ex.name)],
  ['conditioning', (ex) => ex.category === 'cardio' ||
    (!absPrimary(ex) && !/chest/i.test(ex.name) &&
     /rope jumping|jump rope|battling rope|sled push|prowler|burpee|mountain climber|jumping jack|sprint|shuttle|carioca|high knee|butt kick|bear crawl|\bskip|quick step|agility|cone hop|\b(run|running|jog|jogging)\b|star jump|line hop|hurdle hop|bound\b/i.test(ex.name))],
  ['carry', (ex) => /farmer|carry|yoke walk|suitcase|waiter|\bdrag\b(?! curl)|sled .*walk|overhead backward walk|conan/i.test(ex.name)],
  ['lunge', (ex) => /lunge|split squat|split jump|step.?up|bulgarian|pistol|single.leg (box )?squat|one.leg squat|skater|scissor/i.test(ex.name)],
  ['squat', (ex) => !absPrimary(ex) && /squat|leg press|hack|thruster|wall sit|sissy|box jump|jump squat|tuck jump/i.test(ex.name) &&
    !/good morning|calf|jerk/i.test(ex.name)],
  ['hinge', (ex) => /deadlift|good morning|romanian|\brdl\b|stiff.leg|hip thrust|glute bridge|butt lift|pull.through|swing|hyperextension|back extension|clean|snatch|rack pull|glute.ham|kettlebell .*high pull|reverse hyper|atlas|keg load|sandbag load|tire flip/i.test(ex.name)],
  ['vertical_pull', (ex) => ex.primaryMuscles[0] !== 'triceps' && !absPrimary(ex) &&
    /\bpull-?ups?\b|\bpullups?\b|\bchin(s|-up|-ups)?\b|pulldown|pull-down|muscle.?up|rope climb|london bridge/i.test(ex.name)],
  ['horizontal_pull', (ex) => /\brows?\b|rowing|face pull|reverse fly|reverse flye|rear delt|inverted row|pull apart|high pull\b|sled row/i.test(ex.name) &&
    !/upright/i.test(ex.name)],
  ['vertical_push', (ex) => !absPrimary(ex) &&
    /overhead press|shoulder press|military|push press|jerk|arnold|handstand|landmine .*(press|jammer)|linear jammer|z press|press behind|behind the neck|seated .*press|standing .*press|dumbbell press|log lift|circus bell|\bdips?\b|bradford|kettlebell .*press|see-?saw press|para press|cuban press|anti-gravity press|alternating .*press/i.test(ex.name) &&
    !/bench|chest|floor|leg press|calf|incline|decline|close-grip dumbbell|triceps press|tricep press/i.test(ex.name)],
  ['horizontal_push', (ex) => (/bench press|push-?ups?\b|pushup|chest press|floor press|\bflye?s?\b|crossover|pec deck|butterfly|svend|chest push|chest pass|incline .*press|decline .*press|dumbbell press|board press|pin press|close.grip .*press/i.test(ex.name) &&
    ex.primaryMuscles[0] !== 'shoulders' && !LOWER_MUSCLES.has(ex.primaryMuscles[0])) ||
    (ex.primaryMuscles[0] === 'chest' && ex.force === 'push')],
  ['core', (ex) => absPrimary(ex) ||
    /crunch|sit-?up|plank|leg raise|knee raise|knee.hip raise|rollout|ab roller|russian twist|wood ?chop|pallof|side bridge|jackknife|v-up|flutter|dead bug|bird dog|hollow|superman|windmill|bicycle|oblique|twist/i.test(ex.name)],
];
/** Isolation / leftover fallback by primary muscle, so a location swap still finds a peer. */
const MUSCLE_FALLBACK = {
  chest: 'horizontal_push', quadriceps: 'squat', hamstrings: 'hinge', glutes: 'hinge', lats: 'vertical_pull',
  'middle back': 'horizontal_pull', 'lower back': 'hinge', abdominals: 'core',
};

export function movementPattern(ex) {
  const hit = PATTERN_RULES.find(([, rule]) => rule(ex));
  if (hit) return hit[0];
  if (ex.category === 'plyometrics') return LOWER_MUSCLES.has(ex.primaryMuscles[0]) ? 'conditioning' : 'other';
  if (ex.primaryMuscles[0] === 'shoulders' && ex.mechanic === 'compound' && ex.force === 'push') return 'vertical_push';
  return MUSCLE_FALLBACK[ex.primaryMuscles[0]] ?? 'other';
}

// ---------- body region ----------

const FULL_BODY_NAME =
  /thruster|burpee|turkish get|man.?maker|clean and press|tire flip|atlas|keg load|sandbag load|squat jerk|split jerk|power jerk/i;

export function bodyRegion(ex, pattern) {
  if (ex.category === 'cardio' || pattern === 'conditioning') return 'cardio';
  if (ex.category === 'olympic weightlifting' || FULL_BODY_NAME.test(ex.name)) return 'full';
  if (pattern === 'carry') return 'full';
  const muscle = ex.primaryMuscles[0];
  if (muscle === 'lower back') return pattern === 'hinge' ? 'lower' : 'core';
  if (LOWER_MUSCLES.has(muscle)) return 'lower';
  if (UPPER_MUSCLES.has(muscle)) return 'upper';
  if (CORE_MUSCLES.has(muscle)) return 'core';
  return 'full';
}

// ---------- training category ----------

const CATEGORY = {
  strength: 'strength', powerlifting: 'strength', strongman: 'strength',
  'olympic weightlifting': 'power', plyometrics: 'power', cardio: 'conditioning', stretching: 'mobility',
};

/**
 * The training type. The conditioning pattern overrides the dataset's category: without it only 14
 * rows would be conditioning, too few to feed the "Mostly cardio" preset.
 */
export function trainingCategory(ex, pattern) {
  return pattern === 'conditioning' ? 'conditioning' : CATEGORY[ex.category];
}

// ---------- demand level 1..3 ----------

export function demandLevel(ex, pattern, equipment) {
  if (ex.category === 'stretching' || pattern === 'mobility') return 1;
  if (['olympic weightlifting', 'powerlifting', 'strongman'].includes(ex.category)) return 3;
  if (ex.level === 'expert') return 3;
  if (ex.mechanic === 'compound' && equipment.some((e) => ['barbell', 'trap_bar'].includes(e)) &&
      ['squat', 'hinge', 'lunge', 'horizontal_push', 'vertical_push'].includes(pattern)) return 3;
  if (/depth jump|drop jump|clap|plyo push/i.test(ex.name)) return 3;
  if (ex.mechanic === 'isolation' && ex.level === 'beginner') return 1;
  if (pattern === 'core' && ex.level === 'beginner') return 1;
  if (ex.primaryMuscles[0] === 'neck' || equipment.includes('foam_roller')) return 1;
  return 2;
}

// ---------- micro_ok ----------

/** Safe and quick enough for a 5–15 minute circuit between study blocks. */
export function microOk(ex, location, demand, equipment, pattern) {
  if (location !== 'both') return false;
  if (demand > 2) return false;
  if (ex.level === 'expert') return false;
  if (!equipment.every((e) => MICRO_EQUIPMENT.has(e))) return false;
  if (/partner|assisted|with a spotter|throw|toss|slam|wall ball|against wall/i.test(ex.name)) return false;
  // The images and instructions are not imported (D9), but a row without them upstream is usually an
  // odd one out; keep it out of micro circuits until a curator has looked at it.
  if (ex.images.length === 0 || ex.instructions.length === 0) return false;
  if (ex.primaryMuscles[0] === 'neck') return false;
  if (pattern === 'mobility' && equipment.includes('foam_roller')) return false;
  return true;
}

// ---------- one row ----------

/**
 * A dataset exercise as an `exercises` row (snake_case column names). Only the structured fields:
 * the dataset's instructions and images are never copied (D9).
 */
export function mapExercise(ex) {
  const equipment = normalizeEquipment(ex);
  const pattern = movementPattern(ex);
  const location = exerciseLocation(equipment);
  const demand = demandLevel(ex, pattern, equipment);
  return {
    dataset_id: ex.id,
    name: ex.name.trim(),
    muscle_group: ex.primaryMuscles[0],
    secondary_muscles: ex.secondaryMuscles,
    body_region: bodyRegion(ex, pattern),
    category: trainingCategory(ex, pattern),
    dataset_category: ex.category,
    equipment,
    location,
    movement_pattern: pattern,
    demand_level: demand,
    micro_ok: microOk(ex, location, demand, equipment, pattern),
    level: ex.level,
    mechanic: ex.mechanic,
    force: ex.force,
  };
}
