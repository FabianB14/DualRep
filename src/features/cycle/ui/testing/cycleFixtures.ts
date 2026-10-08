/**
 * Real cycle states for the screen tests, made with the cycle machine itself (start → circuit ready
 * → the timer runs out → …) and the bundled starter library, so the screen is tested on exactly what
 * useCycle hands it. Test-only; not imported by the app.
 */
import { SYSTEM_PRESET_IDS } from '@/db/constants';
import { libraryView } from '@/features/training/library';
import type { Circuit, CircuitItem } from '@/features/training/types';

import { buildCycleCircuit } from '../../circuitPrep';
import {
  cycleReducer,
  initialCycleState,
  normalizePlan,
  type CycleEvent,
  type CyclePlanInput,
  type CycleState,
  type FocusState,
  type IdleState,
  type MoveState,
  type ReturnState,
} from '../../cycleMachine';

export const USER = '11111111-1111-4111-8111-111111111111';
export const T0 = 1_760_000_000_000;
export const MIN = 60_000;

/** A 25-minute block, then a 10-minute bodyweight circuit at home, Full body. */
export const HOME_PLAN: CyclePlanInput = {
  focusSubject: 'Biology, chapter 4',
  blockMinutes: 25,
  presetId: SYSTEM_PRESET_IDS.full_body,
  split: { lower: 25, upper: 50, core: 25, cardio: 0 },
  setupId: null,
  location: 'home',
  equipment: [],
  moveKind: 'micro',
  moveMinutes: 10,
};

/** What default circuits pick from with an empty database (the starter library). */
export const POOL = libraryView([], USER).circuitPool;

let ids = 0;
function nextId(prefix: string): string {
  ids += 1;
  return `${prefix}-${ids}`;
}

function run(state: CycleState, ...events: CycleEvent[]): CycleState {
  return events.reduce(cycleReducer, state);
}

/** The circuit the store would prepare for this plan. */
export function circuitFor(plan: CyclePlanInput = HOME_PLAN): Circuit {
  return buildCycleCircuit(normalizePlan(plan), POOL, 0);
}

/** The circuit with its first item changed (e.g. a target weight from the last session). */
export function withFirstItem(circuit: Circuit, patch: Partial<CircuitItem>): Circuit {
  return { ...circuit, items: circuit.items.map((item, index) => (index === 0 ? { ...item, ...patch } : item)) };
}

/** A focus block started at `at`, its circuit ready (unless `circuit` is null). */
export function focusState(options: { plan?: CyclePlanInput; at?: number; circuit?: Circuit | null } = {}): FocusState {
  const plan = options.plan ?? HOME_PLAN;
  const at = options.at ?? T0;
  const started = run(initialCycleState(USER), {
    type: 'start',
    at,
    userId: USER,
    plan,
    ids: { sessionId: nextId('session'), blockId: nextId('block'), workoutId: nextId('workout'), transitionId: nextId('transition') },
  }) as FocusState;
  const circuit = options.circuit === undefined ? circuitFor(plan) : options.circuit;
  if (circuit === null) return started;
  return run(started, { type: 'circuit_ready', at, blockId: started.blockId, circuit }) as FocusState;
}

/** When the focus block's timer reaches zero. */
export function endsAt(focus: FocusState): number {
  return focus.timer.endsAt ?? T0;
}

/** The move block right after `focus` ran out (the handoff). */
export function moveAfter(focus: FocusState, at: number = endsAt(focus)): MoveState {
  const next = run(focus, { type: 'tick', at });
  if (next.phase !== 'move') throw new Error(`expected the move phase, got ${next.phase}`);
  return next;
}

/** A "Just train" move block. */
export function moveOnlyState(plan: CyclePlanInput = HOME_PLAN, at: number = T0, circuit: Circuit = circuitFor(plan)): MoveState {
  const next = run(initialCycleState(USER), { type: 'start_move', at, userId: USER, plan, workoutId: nextId('workout'), circuit });
  if (next.phase !== 'move') throw new Error(`expected the move phase, got ${next.phase}`);
  return next;
}

/** Applies events to a state (for logging sets and the like). */
export function after<S extends CycleState>(state: S, ...events: CycleEvent[]): CycleState {
  return run(state, ...events);
}

/** A logged set on the current item: the target, at `at`. */
export function logEvent(state: MoveState, at: number, done?: number): CycleEvent {
  const index = state.position.itemIndex;
  const item = state.circuit.items[index];
  const next = state.items[index].next;
  return {
    type: 'log_set',
    at,
    setId: nextId('set'),
    done: done ?? (item.measure === 'time' ? (next.targetSeconds ?? 0) : (next.targetReps ?? 0)),
    weightLbs: next.targetWeightLbs,
    rpe: null,
    unit: 'lb',
    equipment: [],
  };
}

/** The return countdown after a move block in which one set was logged. */
export function returnState(): ReturnState {
  const move = moveAfter(focusState());
  const at = endsAt(focusState()) + 2 * MIN;
  const next = run(move, logEvent(move, at), { type: 'finish_move', at: at + 1_000 });
  if (next.phase !== 'return') throw new Error(`expected the return phase, got ${next.phase}`);
  return next;
}

/** Idle with the summary of a finished study cycle. */
export function finishedState(): IdleState {
  const back = returnState();
  const countdownEnd = back.countdown.endsAt ?? T0;
  const next = run(back, { type: 'finish', at: countdownEnd - 10_000 });
  if (next.phase !== 'idle') throw new Error(`expected the idle phase, got ${next.phase}`);
  return next;
}
