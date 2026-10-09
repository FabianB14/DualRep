/**
 * The Interverse starter library: exercises written by Interverse (origin 'interverse'), shipped in
 * the app and seeded into Postgres by supabase/migrations/20261008120000_starter_library.sql, so the
 * circuit builder works offline from the first launch, before the library has ever synced.
 *
 * This file is the single source of both copies. After changing it, regenerate the migration with
 * `node scripts/library/starter-library-sql.mjs`; `npm run check:library` (part of `npm run check`)
 * fails while the migration is out of date. Once that migration has run on the hosted project,
 * a change needs a new migration file (see the script's header).
 *
 * Rules for entries (src/features/training/__tests__/starterLibrary.test.ts checks them):
 * - `id` is fixed: 00000000-0000-4000-8000-0000000eXXXX, XXXX a 4-digit hex number. A new exercise
 *   takes the next number after the highest one in use. A removed exercise's id is never reused,
 *   because logged sets and Tracy's history keep pointing at it.
 * - Instructions are our own words: 2 to 4 short imperative steps, never copied from a dataset or
 *   website. Safety cues (sturdy chair, safety bars) go in the steps.
 * - Vocabulary is the one in supabase/migrations/20261008000000_initial_schema.sql (CHECK constraints)
 *   and in equipment.ts. `muscleGroup` uses free-exercise-db's 17 muscle names.
 * - `equipment` is ['bodyweight'] for no equipment, otherwise only the items needed (no bodyweight).
 * - `location`: 'gym' if any item is gym-only, 'home' for desk-side and small-space originals that
 *   need a chair, desk, wall or doorway (never with equipment), otherwise 'both'.
 * - `bodyRegion`, `category` and `demandLevel` follow the research rules (docs/research/
 *   exercise-data-and-fsrs.md §A6): conditioning is the cardio region, a carry is full body; heavy
 *   barbell lifts are demand 3 and never micro-ok; mobility is demand 1.
 * - `microOk` (fits a 5–15 minute circuit between focus blocks) needs demand 1 or 2, no long setup
 *   and nothing that is risky when changing stations quickly.
 * - `measure` is not a database column: 'time' for holds, carries, conditioning intervals and
 *   mobility, otherwise 'reps'.
 *
 * Like src/db/tables.ts, this file must stay free of imports and of non-erasable TypeScript syntax
 * (no enums, namespaces or parameter properties): the migration generator imports it directly with
 * Node's built-in type stripping. App code uses it through starterLibrary.ts.
 */

/** free-exercise-db's muscle names (exercises.muscle_group and secondary_muscles). */
export const MUSCLE_GROUPS = [
  'quadriceps',
  'hamstrings',
  'glutes',
  'calves',
  'adductors',
  'abductors',
  'chest',
  'shoulders',
  'triceps',
  'biceps',
  'lats',
  'middle back',
  'lower back',
  'traps',
  'forearms',
  'abdominals',
  'neck',
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

/** Every starter id is this prefix plus four hex digits. */
export const STARTER_ID_PREFIX = '00000000-0000-4000-8000-0000000e';

/** One starter exercise. The unions mirror types.ts and the CHECK constraints on public.exercises. */
export type StarterExercise = {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  secondaryMuscles: readonly MuscleGroup[];
  bodyRegion: 'lower' | 'upper' | 'core' | 'full' | 'cardio';
  movementPattern:
    | 'squat'
    | 'hinge'
    | 'lunge'
    | 'horizontal_push'
    | 'vertical_push'
    | 'horizontal_pull'
    | 'vertical_pull'
    | 'carry'
    | 'core'
    | 'conditioning'
    | 'mobility'
    | 'other';
  category: 'strength' | 'power' | 'conditioning' | 'mobility';
  /** Equipment vocabulary items (equipment.ts). */
  equipment: readonly string[];
  location: 'gym' | 'home' | 'both';
  demandLevel: 1 | 2 | 3;
  level: 'beginner' | 'intermediate' | 'expert';
  force: 'push' | 'pull' | 'static' | null;
  mechanic: 'compound' | 'isolation' | null;
  microOk: boolean;
  measure: 'reps' | 'time';
  instructions: readonly string[];
};

export const STARTER_EXERCISES: readonly StarterExercise[] = [
  // --- No equipment: desk-side, small-space and floor moves -------------------------------------
  {
    id: '00000000-0000-4000-8000-0000000e0001',
    name: 'Chair squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand in front of a sturdy chair with your feet hip-width apart.',
      'Sit your hips back and down until you lightly touch the seat.',
      'Push through your whole foot to stand up tall without using your hands.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0002',
    name: 'Bodyweight squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand with your feet shoulder-width apart and your toes turned out slightly.',
      'Bend your knees and hips together, keeping your chest up and your heels down.',
      'Go as low as feels comfortable, then stand back up.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0003',
    name: 'Wall sit',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Lean your back flat against a wall and walk your feet out in front of you.',
      'Slide down until your knees are bent to about a right angle, knees over ankles.',
      'Hold the position and keep breathing. Slide back up to finish.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0004',
    name: 'Glute bridge',
    muscleGroup: 'glutes', secondaryMuscles: ['hamstrings'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Lie on your back with your knees bent and your feet flat, hip-width apart.',
      'Press through your heels to lift your hips until your body is straight from knees to shoulders.',
      'Squeeze your glutes at the top, then lower slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0005',
    name: 'Bodyweight good morning',
    muscleGroup: 'hamstrings', secondaryMuscles: ['glutes', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand tall with your feet hip-width apart and your hands on your hips.',
      'With soft knees and a flat back, push your hips back and tip your chest forward.',
      'Stop when you feel a stretch in your hamstrings, then drive your hips forward to stand.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0006',
    name: 'Bodyweight single-leg deadlift',
    muscleGroup: 'hamstrings', secondaryMuscles: ['glutes', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand on one leg with a soft knee. Touch a wall or chair for balance if you need to.',
      'Hinge at the hips and reach your hands toward the floor as your free leg extends behind you.',
      'Keep your hips level, then squeeze your glute to stand back up. Do all reps, then switch legs.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0007',
    name: 'Reverse lunge',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'lunge', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand tall, then step one foot back and lower until both knees bend to about a right angle.',
      'Keep most of your weight on the front foot.',
      'Push through the front heel to come back up, then switch legs.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0008',
    name: 'Split squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes'],
    bodyRegion: 'lower', movementPattern: 'lunge', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand in a long split stance with your back heel lifted.',
      'Lower straight down until your back knee nearly touches the floor.',
      'Push back up without moving your feet. Do all reps, then switch sides.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0009',
    name: 'Lateral lunge',
    muscleGroup: 'quadriceps', secondaryMuscles: ['adductors', 'glutes'],
    bodyRegion: 'lower', movementPattern: 'lunge', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand with your feet together, then take a wide step to one side.',
      'Sit your hips back over the stepping leg and keep the other leg straight.',
      'Push off to return to the start, then repeat to the other side.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e000a',
    name: 'Desk push-up',
    muscleGroup: 'chest', secondaryMuscles: ['triceps', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Check that your desk is sturdy and will not slide, then place your hands on its edge.',
      'Walk your feet back until your body forms a straight line.',
      'Lower your chest to the edge, then push away until your arms are straight.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e000b',
    name: 'Knee push-up',
    muscleGroup: 'chest', secondaryMuscles: ['triceps', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Start on your hands and knees with your hands slightly wider than your shoulders.',
      'Walk your hands forward until your body is straight from knees to head.',
      'Lower your chest toward the floor, then press back up.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e000c',
    name: 'Push-up',
    muscleGroup: 'chest', secondaryMuscles: ['triceps', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Set your hands slightly wider than your shoulders with your body in a straight line.',
      'Lower your chest toward the floor with your elbows angled back, not flared out.',
      'Press back up without letting your hips sag.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e000d',
    name: 'Pike push-up',
    muscleGroup: 'shoulders', secondaryMuscles: ['triceps'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'From a push-up position, walk your feet in and lift your hips high into an upside-down V.',
      'Bend your elbows to lower the top of your head toward the floor between your hands.',
      'Press back up until your arms are straight.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e000e',
    name: 'Incline pike push-up',
    muscleGroup: 'shoulders', secondaryMuscles: ['triceps'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Place your hands on the seat of a sturdy chair pushed against a wall.',
      'Walk your feet in and lift your hips so your shoulders are over your hands.',
      'Bend your elbows to lower your head toward the seat, then press back up.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e000f',
    name: 'Chair dip',
    muscleGroup: 'triceps', secondaryMuscles: ['chest', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Sit on the edge of a sturdy chair pushed against a wall and grip the seat beside your hips.',
      'Slide forward off the seat with your knees bent and your feet flat.',
      'Bend your elbows to lower until they reach about a right angle, then press back up.',
      'Keep your shoulders down and away from your ears.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0010',
    name: 'Doorframe row',
    muscleGroup: 'middle back', secondaryMuscles: ['lats', 'biceps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand in a solid doorway and grip both sides of the frame at chest height. Never use the door.',
      'Walk your feet in and lean back until your arms are straight and your body is in a line.',
      'Pull your chest toward the frame by squeezing your shoulder blades together, then lower slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0011',
    name: 'Prone Y-T raise',
    muscleGroup: 'shoulders', secondaryMuscles: ['middle back', 'traps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Lie face down with your forehead on a folded towel and your arms overhead in a Y.',
      'Lift your arms a few inches by squeezing your shoulder blades, hold briefly, then lower.',
      'Move your arms out to a T and repeat. One Y and one T count as one rep.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0012',
    name: 'Reverse snow angel',
    muscleGroup: 'middle back', secondaryMuscles: ['shoulders', 'traps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Lie face down with your arms by your sides, palms down, and lift your chest slightly.',
      'Keeping your arms off the floor, sweep them in a wide arc until your hands meet overhead.',
      'Sweep them back to your sides, squeezing your shoulder blades the whole time.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0013',
    name: 'Superman pull',
    muscleGroup: 'lats', secondaryMuscles: ['middle back', 'lower back'],
    bodyRegion: 'upper', movementPattern: 'vertical_pull', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Lie face down with your arms straight overhead and lift your chest and arms slightly.',
      'Pull your elbows down toward your ribs as if pulling a bar, squeezing your back.',
      'Reach your arms back overhead without letting them touch the floor.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0014',
    name: 'Towel lat pulldown',
    muscleGroup: 'lats', secondaryMuscles: ['middle back', 'biceps'],
    bodyRegion: 'upper', movementPattern: 'vertical_pull', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Hold a towel overhead with your hands wide and pull it tight.',
      'Keep pulling outward as you draw your elbows down and bring the towel to your upper chest.',
      'Squeeze your back for a moment, then reach up again without letting the towel go slack.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0015',
    name: 'Plank',
    muscleGroup: 'abdominals', secondaryMuscles: ['shoulders', 'glutes'],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: 'isolation', microOk: true, measure: 'time',
    instructions: [
      'Rest on your forearms and toes with your elbows under your shoulders.',
      'Brace your stomach and squeeze your glutes so your body forms a straight line.',
      'Hold and breathe steadily. Drop to your knees if your lower back starts to sag.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0016',
    name: 'Side plank',
    muscleGroup: 'abdominals', secondaryMuscles: ['shoulders', 'glutes'],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: 'isolation', microOk: true, measure: 'time',
    instructions: [
      'Lie on your side and prop yourself up on one forearm, elbow under your shoulder.',
      'Lift your hips until your body is straight from head to feet. Bend your knees to make it easier.',
      'Hold, then switch sides halfway through.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0017',
    name: 'Dead bug',
    muscleGroup: 'abdominals', secondaryMuscles: [],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Lie on your back with your arms pointing up and your knees bent at right angles above your hips.',
      'Press your lower back gently into the floor.',
      'Slowly lower one arm and the opposite leg toward the floor, return, and switch sides.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0018',
    name: 'Bird dog',
    muscleGroup: 'lower back', secondaryMuscles: ['glutes', 'abdominals'],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Start on your hands and knees with a flat back.',
      'Reach one arm forward and the opposite leg back until both are level with your body.',
      'Pause without twisting your hips, return, and switch sides.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0019',
    name: 'Seated knee raise',
    muscleGroup: 'abdominals', secondaryMuscles: [],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Sit near the front edge of a sturdy chair and hold the sides of the seat.',
      'Lean back slightly and brace your stomach.',
      'Lift both knees toward your chest, then lower your feet until they almost touch the floor.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e001a',
    name: 'Standing cross-body crunch',
    muscleGroup: 'abdominals', secondaryMuscles: [],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Stand tall with your fingertips lightly at your temples.',
      'Lift one knee as you bring the opposite elbow down to meet it.',
      'Return to standing and repeat on the other side.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e001b',
    name: 'High-knee march',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'calves'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'March on the spot, lifting each knee to about hip height.',
      'Swing your arms in time with your legs.',
      'Speed up to raise your heart rate, keeping one foot on the floor at all times.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e001c',
    name: 'Step jack',
    muscleGroup: 'quadriceps', secondaryMuscles: ['calves', 'shoulders'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Stand with your feet together and your arms by your sides.',
      'Step one foot out to the side as you raise both arms overhead.',
      'Step back in as your arms come down, then alternate sides at a quick, steady pace.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e001d',
    name: 'Jumping jack',
    muscleGroup: 'quadriceps', secondaryMuscles: ['calves', 'shoulders'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Stand with your feet together and your arms by your sides.',
      'Jump your feet out wide as you swing your arms overhead.',
      'Jump back to the start and keep a steady rhythm, landing softly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e001e',
    name: 'Mountain climber',
    muscleGroup: 'quadriceps', secondaryMuscles: ['abdominals', 'shoulders'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Start in a high plank with your hands under your shoulders.',
      'Drive one knee toward your chest, then switch legs in a running rhythm.',
      'Keep your hips low and level. Slow down to a step if you need to.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e001f',
    name: 'Shadow boxing',
    muscleGroup: 'shoulders', secondaryMuscles: ['abdominals', 'triceps'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Stand in a staggered stance with your hands up near your chin.',
      'Throw quick, light punches straight ahead, alternating arms.',
      'Stay light on your feet and keep your elbows soft instead of snapping them straight.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0020',
    name: 'Skater step',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'abductors'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Step wide to one side and bring the other foot behind you, bending the front knee.',
      'Swing your arms across your body for balance.',
      'Step to the other side and keep moving side to side. Hop instead for more challenge.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0021',
    name: 'Burpee',
    muscleGroup: 'quadriceps', secondaryMuscles: ['chest', 'shoulders', 'triceps'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 2, level: 'intermediate', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Squat down and place your hands on the floor.',
      'Step or jump your feet back into a plank.',
      'Step or jump your feet back in, then stand up and reach overhead.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0022',
    name: 'Standing calf raise',
    muscleGroup: 'calves', secondaryMuscles: [],
    bodyRegion: 'lower', movementPattern: 'other', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Stand with your feet hip-width apart and lightly hold a desk or wall for balance.',
      'Rise up onto your toes as high as you can.',
      'Pause at the top, then lower your heels slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0023',
    name: 'Seated knee extension',
    muscleGroup: 'quadriceps', secondaryMuscles: [],
    bodyRegion: 'lower', movementPattern: 'other', category: 'strength',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Sit tall on a chair with your feet flat on the floor.',
      'Straighten one knee until the leg is level and squeeze the front of your thigh.',
      'Hold for two seconds, lower slowly, and switch legs.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0024',
    name: 'Half-kneeling hip flexor stretch',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes'],
    bodyRegion: 'lower', movementPattern: 'mobility', category: 'mobility',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: null, microOk: true, measure: 'time',
    instructions: [
      'Kneel on one knee with the other foot flat in front of you. Pad the knee if you need to.',
      'Tuck your hips under and shift forward until you feel a stretch at the front of the back hip.',
      'Hold and breathe, then switch sides halfway through.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0025',
    name: 'Cat-cow',
    muscleGroup: 'lower back', secondaryMuscles: ['abdominals'],
    bodyRegion: 'core', movementPattern: 'mobility', category: 'mobility',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: null, microOk: true, measure: 'time',
    instructions: [
      'Start on your hands and knees with your hands under your shoulders.',
      'Round your back toward the ceiling and tuck your chin.',
      'Then let your stomach sink as you lift your chest and tailbone. Move slowly with your breath.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0026',
    name: 'Lunge with rotation',
    muscleGroup: 'hamstrings', secondaryMuscles: ['glutes', 'quadriceps', 'middle back'],
    bodyRegion: 'lower', movementPattern: 'mobility', category: 'mobility',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: null, microOk: true, measure: 'time',
    instructions: [
      'Step into a long lunge and place both hands on the floor inside your front foot.',
      'Turn your chest toward the front leg and reach that arm up to the ceiling.',
      'Bring the hand back down, step back to standing, and switch sides.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0027',
    name: 'Thoracic open book',
    muscleGroup: 'middle back', secondaryMuscles: ['chest', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'mobility', category: 'mobility',
    equipment: ['bodyweight'], location: 'both',
    demandLevel: 1, level: 'beginner', force: null, mechanic: null, microOk: true, measure: 'time',
    instructions: [
      'Lie on your side with your knees bent and stacked and your arms straight out in front.',
      'Keep your knees together and sweep your top arm over to the other side, chest turning up.',
      'Follow your hand with your eyes, pause, and return. Switch sides halfway through.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0028',
    name: 'Seated figure-four stretch',
    muscleGroup: 'glutes', secondaryMuscles: ['lower back'],
    bodyRegion: 'lower', movementPattern: 'mobility', category: 'mobility',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: null, microOk: true, measure: 'time',
    instructions: [
      'Sit tall on a chair and rest one ankle on the opposite knee.',
      'Keep your back straight and lean forward slowly until you feel a stretch in your hip.',
      'Hold and breathe, then switch sides halfway through.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0029',
    name: 'Doorway chest stretch',
    muscleGroup: 'chest', secondaryMuscles: ['shoulders'],
    bodyRegion: 'upper', movementPattern: 'mobility', category: 'mobility',
    equipment: ['bodyweight'], location: 'home',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: null, microOk: true, measure: 'time',
    instructions: [
      'Stand in a doorway and rest your forearms on the frame with your elbows at shoulder height.',
      'Step one foot through and lean forward gently until you feel a stretch across your chest.',
      'Hold without arching your lower back.',
    ],
  },

  // --- Home equipment: dumbbells, kettlebell, bands, pull-up bar, bench, box ------------------------
  {
    id: '00000000-0000-4000-8000-0000000e002a',
    name: 'Goblet squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Hold one dumbbell upright against your chest with both hands.',
      'Squat down between your knees, keeping your chest tall and your elbows inside your knees.',
      'Push through your whole foot to stand.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e002b',
    name: 'Dumbbell Romanian deadlift',
    muscleGroup: 'hamstrings', secondaryMuscles: ['glutes', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand holding a dumbbell in each hand in front of your thighs.',
      'With soft knees and a flat back, push your hips back and slide the weights down your legs.',
      'Stop at mid-shin or before your back rounds, then drive your hips forward to stand.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e002c',
    name: 'Kettlebell swing',
    muscleGroup: 'glutes', secondaryMuscles: ['hamstrings', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'power',
    equipment: ['kettlebell'], location: 'both',
    demandLevel: 2, level: 'intermediate', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand with your feet wider than your hips and the kettlebell a little in front of you.',
      'Hinge to grip it, hike it back between your legs, then snap your hips forward to float it to chest height.',
      'Let it fall back between your legs as you hinge again. The power comes from your hips, not your arms.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e002d',
    name: 'Dumbbell reverse lunge',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'lunge', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand holding a dumbbell in each hand at your sides.',
      'Step one foot back and lower until both knees bend to about a right angle.',
      'Push through the front heel to come back up, then switch legs.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e002e',
    name: 'Step-up',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'lunge', category: 'strength',
    equipment: ['box'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand facing a sturdy box or step no higher than your knee.',
      'Place your whole foot on it and push through that heel to stand up on top.',
      'Step down with control. Do all reps on one leg, then switch.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e002f',
    name: 'Bulgarian split squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'lunge', category: 'strength',
    equipment: ['bench'], location: 'both',
    demandLevel: 2, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand a long stride in front of a bench and rest the top of your back foot on it.',
      'Lower straight down until your front thigh is about level with the floor.',
      'Push through the front foot to stand. Do all reps, then switch sides.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0030',
    name: 'Dumbbell floor press',
    muscleGroup: 'chest', secondaryMuscles: ['triceps', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Lie on your back with your knees bent, holding a dumbbell in each hand above your chest.',
      'Lower the weights until your upper arms rest lightly on the floor.',
      'Press back up until your arms are straight over your chest.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0031',
    name: 'Incline dumbbell press',
    muscleGroup: 'chest', secondaryMuscles: ['shoulders', 'triceps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['dumbbell', 'bench'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Set a bench to a low incline and lie back with a dumbbell in each hand at chest level.',
      'Press the weights up until your arms are straight above your chest.',
      'Lower them slowly to the sides of your chest.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0032',
    name: 'Dumbbell shoulder press',
    muscleGroup: 'shoulders', secondaryMuscles: ['triceps'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Stand or sit tall holding the dumbbells at shoulder height, palms facing forward.',
      'Brace your stomach and press the weights overhead until your arms are straight.',
      'Lower them back to your shoulders with control.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0033',
    name: 'One-arm dumbbell row',
    muscleGroup: 'middle back', secondaryMuscles: ['lats', 'biceps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Rest one hand on a bench or sturdy chair and hold a dumbbell in the other hand.',
      'Keep your back flat and pull the dumbbell up toward your hip.',
      'Lower it slowly until your arm is straight. Do all reps, then switch sides.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0034',
    name: 'Band row',
    muscleGroup: 'middle back', secondaryMuscles: ['lats', 'biceps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['band'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Anchor a band at chest height, for example in a closed door with a door anchor.',
      'Hold the ends and step back until the band is tight with your arms straight.',
      'Pull your elbows back past your ribs, squeeze your shoulder blades, then return slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0035',
    name: 'Band pull-apart',
    muscleGroup: 'shoulders', secondaryMuscles: ['middle back', 'traps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['band'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Hold a light band in front of your chest with straight arms, hands shoulder-width apart.',
      'Pull the band apart by moving your hands out to the sides until it touches your chest.',
      'Return slowly without letting the band go slack.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0036',
    name: 'Band lat pulldown',
    muscleGroup: 'lats', secondaryMuscles: ['biceps', 'middle back'],
    bodyRegion: 'upper', movementPattern: 'vertical_pull', category: 'strength',
    equipment: ['band'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Anchor a band high, for example over the top of a closed door with a door anchor.',
      'Kneel or sit facing it and hold the ends with your arms reaching up.',
      'Pull your elbows down to your sides, squeeze your back, then let your arms rise slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0037',
    name: 'Pull-up',
    muscleGroup: 'lats', secondaryMuscles: ['biceps', 'middle back'],
    bodyRegion: 'upper', movementPattern: 'vertical_pull', category: 'strength',
    equipment: ['pull_up_bar'], location: 'both',
    demandLevel: 2, level: 'intermediate', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Hang from the bar with your hands a little wider than your shoulders, palms facing away.',
      'Pull your shoulder blades down, then pull until your chin is over the bar.',
      'Lower yourself all the way down with control.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0038',
    name: 'Scapular pull-up',
    muscleGroup: 'lats', secondaryMuscles: ['traps', 'middle back'],
    bodyRegion: 'upper', movementPattern: 'vertical_pull', category: 'strength',
    equipment: ['pull_up_bar'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Hang from the bar with straight arms.',
      'Without bending your elbows, pull your shoulder blades down and back to lift your body slightly.',
      'Pause, then let your shoulders rise back up slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0039',
    name: 'Suspension row',
    muscleGroup: 'middle back', secondaryMuscles: ['lats', 'biceps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['suspension_trainer'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Hold the handles and lean back with straight arms and your body in a straight line.',
      'Pull your chest up to your hands, squeezing your shoulder blades together.',
      'Lower slowly. Walk your feet forward to make it harder, or back to make it easier.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e003a',
    name: 'Hanging knee raise',
    muscleGroup: 'abdominals', secondaryMuscles: ['forearms'],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['pull_up_bar'], location: 'both',
    demandLevel: 2, level: 'intermediate', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Hang from the bar with straight arms and your shoulders pulled down.',
      'Brace your stomach and lift your knees toward your chest without swinging.',
      'Lower your legs slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e003b',
    name: 'Band Pallof press',
    muscleGroup: 'abdominals', secondaryMuscles: ['shoulders'],
    bodyRegion: 'core', movementPattern: 'core', category: 'strength',
    equipment: ['band'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'static', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Anchor a band at chest height and stand side-on to it, holding the end at your chest.',
      'Step away until the band is tight, then press your hands straight out in front of you.',
      'Resist the pull to twist, hold for two seconds, and bring your hands back in.',
      'Switch sides halfway through.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e003c',
    name: 'Dumbbell curl',
    muscleGroup: 'biceps', secondaryMuscles: ['forearms'],
    bodyRegion: 'upper', movementPattern: 'other', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Stand holding a dumbbell in each hand at your sides, palms facing forward.',
      'Keep your elbows by your sides and curl the weights up toward your shoulders.',
      'Lower them slowly until your arms are straight.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e003d',
    name: 'Dumbbell overhead triceps extension',
    muscleGroup: 'triceps', secondaryMuscles: [],
    bodyRegion: 'upper', movementPattern: 'other', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Hold one dumbbell overhead with both hands and your arms straight.',
      'Keeping your elbows pointing up, lower the weight behind your head.',
      'Straighten your arms to lift it back up.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e003e',
    name: 'Dumbbell lateral raise',
    muscleGroup: 'shoulders', secondaryMuscles: [],
    bodyRegion: 'upper', movementPattern: 'other', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Stand holding light dumbbells at your sides.',
      'With a slight bend in your elbows, raise your arms out to the sides up to shoulder height.',
      'Lower them slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e003f',
    name: 'Band lateral walk',
    muscleGroup: 'abductors', secondaryMuscles: ['glutes'],
    bodyRegion: 'lower', movementPattern: 'other', category: 'strength',
    equipment: ['band'], location: 'both',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Place a small loop band around your legs, just above your knees.',
      'Bend your knees slightly and step sideways, keeping the band tight.',
      'Take all steps one way, then come back. Each step counts as one rep.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0040',
    name: 'Farmer carry',
    muscleGroup: 'forearms', secondaryMuscles: ['traps', 'abdominals'],
    bodyRegion: 'full', movementPattern: 'carry', category: 'strength',
    equipment: ['dumbbell'], location: 'both',
    demandLevel: 2, level: 'beginner', force: 'static', mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Pick up a heavy dumbbell in each hand, keeping your back flat.',
      'Stand tall with your shoulders down and walk with short, steady steps.',
      'Turn carefully at the end of your space and keep walking until the time is up.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0041',
    name: 'Jump rope',
    muscleGroup: 'calves', secondaryMuscles: ['quadriceps', 'shoulders'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['jump_rope'], location: 'both',
    demandLevel: 2, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Hold the handles at hip height with the rope behind your heels.',
      'Turn the rope with your wrists and make small, quick jumps on the balls of your feet.',
      'Land softly and keep a steady rhythm. Step over the rope if you trip.',
    ],
  },

  // --- Gym: barbells, racks, machines, cables, cardio machines ------------------------------------
  {
    id: '00000000-0000-4000-8000-0000000e0042',
    name: 'Barbell back squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['barbell', 'rack'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Set the safety bars just below your lowest squat and rest the bar across your upper back.',
      'Brace your stomach, then sit your hips down and back with your knees tracking over your toes.',
      'Drive up through your whole foot to stand tall.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0043',
    name: 'Barbell front squat',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'abdominals'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['barbell', 'rack'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Set the safety bars low and rest the bar on the front of your shoulders with your elbows high.',
      'Keep your chest up and squat straight down between your knees.',
      'Drive up through your whole foot, keeping your elbows high.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0044',
    name: 'Leg press',
    muscleGroup: 'quadriceps', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'squat', category: 'strength',
    equipment: ['machine'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Sit in the machine with your feet hip-width apart in the middle of the platform.',
      'Release the safety handles and lower the platform until your knees bend to about a right angle.',
      'Press back up without locking your knees, keeping your lower back against the seat.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0045',
    name: 'Barbell deadlift',
    muscleGroup: 'hamstrings', secondaryMuscles: ['glutes', 'lower back', 'traps', 'forearms'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['barbell'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'pull', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Stand with the bar over the middle of your feet and grip it just outside your legs.',
      'Flatten your back, brace, and push the floor away to stand up with the bar close to your legs.',
      'Lower the bar by pushing your hips back first, keeping your back flat.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0046',
    name: 'Barbell Romanian deadlift',
    muscleGroup: 'hamstrings', secondaryMuscles: ['glutes', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['barbell'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'pull', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Stand holding the bar at hip height with your hands just outside your thighs.',
      'With soft knees, push your hips back and slide the bar down your thighs.',
      'Stop when your hamstrings are tight or before your back rounds, then drive your hips forward.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0047',
    name: 'Barbell hip thrust',
    muscleGroup: 'glutes', secondaryMuscles: ['hamstrings'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['bench', 'barbell'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Sit with your upper back against a bench and a padded bar across your hips.',
      'Plant your feet and drive your hips up until your body is flat from knees to shoulders.',
      'Squeeze your glutes at the top, then lower with control.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0048',
    name: 'Back extension',
    muscleGroup: 'lower back', secondaryMuscles: ['glutes', 'hamstrings'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['hyperextension_bench'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Set the pad just below your hip bones and hook your heels under the foot rollers.',
      'Lower your upper body by bending at the hips with a flat back.',
      'Rise until your body is in a straight line, without leaning back past it.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0049',
    name: 'Cable pull-through',
    muscleGroup: 'glutes', secondaryMuscles: ['hamstrings', 'lower back'],
    bodyRegion: 'lower', movementPattern: 'hinge', category: 'strength',
    equipment: ['cable'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Attach a rope to a low pulley, face away from it, and hold the rope between your legs.',
      'Walk forward until the cable is tight, then hinge your hips back with a flat back.',
      'Drive your hips forward to stand tall and squeeze your glutes.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e004a',
    name: 'Leg curl',
    muscleGroup: 'hamstrings', secondaryMuscles: ['calves'],
    bodyRegion: 'lower', movementPattern: 'other', category: 'strength',
    equipment: ['machine'], location: 'gym',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Adjust the machine so your knees line up with its pivot and the pad sits just above your heels.',
      'Curl your heels toward your glutes.',
      'Return slowly without letting the weight stack touch down.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e004b',
    name: 'Leg extension',
    muscleGroup: 'quadriceps', secondaryMuscles: [],
    bodyRegion: 'lower', movementPattern: 'other', category: 'strength',
    equipment: ['machine'], location: 'gym',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Adjust the machine so your knees line up with its pivot and the pad sits on your lower shins.',
      'Straighten your legs and squeeze the front of your thighs.',
      'Lower slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e004c',
    name: 'Machine calf raise',
    muscleGroup: 'calves', secondaryMuscles: [],
    bodyRegion: 'lower', movementPattern: 'other', category: 'strength',
    equipment: ['machine'], location: 'gym',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Set up in the calf raise machine with the balls of your feet on the edge of the platform.',
      'Lower your heels for a gentle stretch.',
      'Rise up onto your toes as high as you can, pause, and lower slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e004d',
    name: 'Barbell bench press',
    muscleGroup: 'chest', secondaryMuscles: ['triceps', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['bench', 'barbell', 'rack'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Set the safety arms or ask for a spotter, then lie on the bench with your eyes under the bar.',
      'Grip the bar a little wider than your shoulders and lift it out over your chest.',
      'Lower it to your mid-chest with control, then press it back up.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e004e',
    name: 'Machine chest press',
    muscleGroup: 'chest', secondaryMuscles: ['triceps', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'horizontal_push', category: 'strength',
    equipment: ['machine'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Adjust the seat so the handles are level with your mid-chest.',
      'Press the handles forward until your arms are straight but not locked.',
      'Return slowly until you feel a light stretch across your chest.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e004f',
    name: 'Barbell overhead press',
    muscleGroup: 'shoulders', secondaryMuscles: ['triceps', 'traps'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['barbell', 'rack'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Take the bar from the rack at shoulder height with your hands just outside your shoulders.',
      'Brace your stomach and glutes and press the bar straight up, moving your head back out of its path.',
      'Lower the bar to your shoulders with control.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0050',
    name: 'Machine shoulder press',
    muscleGroup: 'shoulders', secondaryMuscles: ['triceps'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['machine'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'push', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Adjust the seat so the handles start at shoulder height.',
      'Press the handles overhead until your arms are straight.',
      'Lower slowly back to shoulder height.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0051',
    name: 'Dip',
    muscleGroup: 'triceps', secondaryMuscles: ['chest', 'shoulders'],
    bodyRegion: 'upper', movementPattern: 'vertical_push', category: 'strength',
    equipment: ['dip_station'], location: 'gym',
    demandLevel: 2, level: 'intermediate', force: 'push', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Support yourself on the bars with straight arms and your shoulders pulled down.',
      'Bend your elbows to lower until your upper arms are about level with the bars, or less if it pinches.',
      'Press back up until your arms are straight.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0052',
    name: 'Lat pulldown',
    muscleGroup: 'lats', secondaryMuscles: ['biceps', 'middle back'],
    bodyRegion: 'upper', movementPattern: 'vertical_pull', category: 'strength',
    equipment: ['cable'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Sit with your thighs under the pads and grip the bar a little wider than your shoulders.',
      'Lean back slightly and pull the bar to your upper chest, driving your elbows down.',
      'Let the bar rise slowly until your arms are straight.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0053',
    name: 'Seated cable row',
    muscleGroup: 'middle back', secondaryMuscles: ['lats', 'biceps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['cable'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Sit with your feet on the platform and your knees soft, holding the handle with straight arms.',
      'Sit tall and pull the handle to your stomach, squeezing your shoulder blades together.',
      'Let your arms straighten slowly without rounding your back.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0054',
    name: 'Barbell row',
    muscleGroup: 'middle back', secondaryMuscles: ['lats', 'biceps', 'lower back'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['barbell'], location: 'gym',
    demandLevel: 3, level: 'intermediate', force: 'pull', mechanic: 'compound', microOk: false, measure: 'reps',
    instructions: [
      'Hold the bar with an overhand grip, hinge forward to about 45 degrees, and keep your back flat.',
      'Pull the bar to your lower ribs, leading with your elbows.',
      'Lower it with control without standing up between reps.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0055',
    name: 'Cable face pull',
    muscleGroup: 'shoulders', secondaryMuscles: ['middle back', 'traps'],
    bodyRegion: 'upper', movementPattern: 'horizontal_pull', category: 'strength',
    equipment: ['cable'], location: 'gym',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'compound', microOk: true, measure: 'reps',
    instructions: [
      'Attach a rope to a pulley at face height and hold the ends with your thumbs toward you.',
      'Pull the rope toward your face, spreading your hands apart and keeping your elbows high.',
      'Pause, then let your arms straighten slowly.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0056',
    name: 'Cable triceps pushdown',
    muscleGroup: 'triceps', secondaryMuscles: [],
    bodyRegion: 'upper', movementPattern: 'other', category: 'strength',
    equipment: ['cable'], location: 'gym',
    demandLevel: 1, level: 'beginner', force: 'push', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Attach a bar or rope to a high pulley and stand close with your elbows at your sides.',
      'Push the handle down until your arms are straight.',
      'Let it rise slowly to about chest height, keeping your elbows still.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0057',
    name: 'EZ-bar curl',
    muscleGroup: 'biceps', secondaryMuscles: ['forearms'],
    bodyRegion: 'upper', movementPattern: 'other', category: 'strength',
    equipment: ['ez_bar'], location: 'gym',
    demandLevel: 1, level: 'beginner', force: 'pull', mechanic: 'isolation', microOk: true, measure: 'reps',
    instructions: [
      'Hold an EZ bar on the angled grips with your arms straight.',
      'Keep your elbows at your sides and curl the bar toward your shoulders.',
      'Lower it slowly without swinging.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0058',
    name: 'Rower intervals',
    muscleGroup: 'quadriceps', secondaryMuscles: ['middle back', 'lats', 'hamstrings'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['cardio_machine'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Strap your feet in and sit tall holding the handle with straight arms.',
      'Push with your legs first, then lean back slightly and pull the handle to your lower ribs.',
      'Return arms, body, then legs. Row hard for the work time and easy in between.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e0059',
    name: 'Bike intervals',
    muscleGroup: 'quadriceps', secondaryMuscles: ['hamstrings', 'glutes', 'calves'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['cardio_machine'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: null, mechanic: 'compound', microOk: true, measure: 'time',
    instructions: [
      'Set the seat so your knee stays slightly bent at the bottom of each pedal stroke.',
      'Pedal hard for the work time at a resistance you can keep up.',
      'Ease off and pedal lightly to recover between efforts.',
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000e005a',
    name: 'Treadmill intervals',
    muscleGroup: 'quadriceps', secondaryMuscles: ['hamstrings', 'calves'],
    bodyRegion: 'cardio', movementPattern: 'conditioning', category: 'conditioning',
    equipment: ['cardio_machine'], location: 'gym',
    demandLevel: 2, level: 'beginner', force: null, mechanic: 'compound', microOk: false, measure: 'time',
    instructions: [
      'Clip on the safety key and start at an easy walk.',
      'Raise the speed or incline to a brisk walk or run for the work time.',
      'Lower it back to an easy pace to recover. Slow the belt right down before stepping off.',
    ],
  },
];
