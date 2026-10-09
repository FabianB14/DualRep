/**
 * The study → move → study loop as a pure state machine (docs/EXECUTION_PLAN.md "Product loop").
 *
 *   idle ──start──▶ focus ──timer ends──▶ move ──circuit done──▶ return ──countdown ends──▶ focus …
 *     ▲                                                                                       │
 *     └──────────────────────────────────── finish (from any phase) ◀─────────────────────────┘
 *   idle ──start_move ("Just train")──▶ move ──circuit done──▶ idle
 *
 * - focus: a focus block is running or paused. At block start the move block that follows is
 *   prepared: its ids are made now, and the circuit arrives (circuit_ready) while the timer runs —
 *   "Tracy prepares the movement block while the timer is still running". When the timer reaches zero
 *   the block ends and the move block starts with zero taps (the handoff). If the circuit is somehow
 *   not ready yet (only after a crash), the block ends and the handoff happens as soon as it is.
 *   The block's recorded end (interval_blocks.ended_at) is its start plus the time actually focused:
 *   the table has no column for pauses, so a block paused and then ended early would otherwise count
 *   its pause as focus time wherever end − start is read (History, Today).
 * - move: the circuit, where the user is in it, each item's sets and the spotter's targets for its
 *   next set, the rest timer, and the effort rating of the focus block just finished. The workout's
 *   length runs from its start to its last logged set (time after it, such as a workout left open, is
 *   not counted). A move block nobody has touched for MOVE_STALE is closed as it stands and the cycle
 *   finished, both at its last set, rather than resumed hours later.
 *   Micro circuits go round-robin (every station once, then the next round); full sessions do
 *   straight sets (all sets of an item, then the next). A rest-pause mini-set always comes right
 *   after the set it follows. The move block ends when every item is done, cut by the spotter or
 *   skipped, or when the user ends it.
 * - return: the last rest rolls into the next focus block: a countdown (30 s by default), then the
 *   next block starts on its own; "Start now" and "Finish" are the actions. The next block starts
 *   when the countdown ends whether or not anyone is looking: nothing ticks while the screen is off or
 *   the app is in the background, so its end-of-block alert is scheduled as soon as the countdown
 *   starts, and the first tick after the countdown starts the block from the countdown's end (a tick
 *   only notices it). If nobody is back by RETURN_STALE after that block would have ended (its alert
 *   rang meanwhile), the cycle finishes instead of recording a block nobody was there for.
 * - idle: nothing running; after a finish it holds the cycle's summary until dismissed.
 *
 * Side effects are NOT performed here. The reducer describes them as data: every database write and
 * notification call it decides on is appended to `pending`, in order, with everything it needs (ids
 * included). The hook (useCycle / cycleStore) persists the state, then performs the pending effects
 * one by one and reports each with `effect_done`. Because the state with the effect is saved before
 * the effect runs, and every effect is idempotent, a crash at any point neither loses a logged set
 * nor writes a row twice (see cycleStore.ts).
 *
 * Events carry the time (`at`, epoch ms) and any new ids; the reducer never reads the clock or makes
 * ids, so it is deterministic and every transition is unit-tested. An event that does not apply to
 * the current phase returns the state unchanged (the same object), which also makes double taps
 * harmless: a second "End block" or "Start now" finds a different phase. Two quick taps on "Done"
 * (or "Skip") within DOUBLE_TAP are one tap.
 */
import { estimateCircuitSeconds } from '@/features/training/circuits';
import { PRESCRIPTION } from '@/features/training/prescription';
import {
  adviseNextSet,
  type LoggedSet,
  type SetTargets,
  type SetType,
  type SpotterAdvice,
} from '@/features/training/spotter';
import type { Circuit, CircuitItem, SetupLocation, Split, Unit, WorkoutKind } from '@/features/training/types';
import {
  elapsedMs,
  isDone,
  isPaused,
  pauseTimer,
  resumeTimer,
  startTimer,
  type TimerState,
} from '@/features/timer/timerMath';

import type { LogSetInput, StartFocusBlockInput, StartMoveBlockInput } from './cycleRepo';

/** local_state key of the persisted machine state. */
export const CYCLE_STATE_KEY = 'cycle';
export const CYCLE_STATE_VERSION = 1;

export const CYCLE_RULES = {
  /** Focus block length in minutes (profiles.default_block_minutes has the same range). */
  blockMinutes: { min: 10, max: 50, step: 5, default: 25 },
  /** Move block lengths the app offers, in minutes. */
  microMinutes: [5, 10, 15],
  fullMinutes: [30, 45, 60],
  defaultMicroMinutes: 10,
  defaultFullMinutes: 45,
  /** The return countdown before the next focus block starts on its own. */
  returnSeconds: 30,
  maxReturnSeconds: 300,
  /** RETURN_STALE: nobody back this long after the block the countdown started would have ended: finish instead. */
  returnStaleMs: 5 * 60_000,
  /** MOVE_STALE: a move block with no set or skip for this long is closed and the cycle finished. */
  moveStaleMs: 60 * 60_000,
  /** DOUBLE_TAP: a second "Done" or "Skip" this soon after the last one is the same tap. */
  doubleTapMs: 1_000,
  /** Effort rating of a focus block. */
  effort: { min: 1, max: 5 },
} as const;

const R = CYCLE_RULES;

/** What the user chose on the start panel. It stays the same for the whole cycle. */
export type CyclePlan = {
  /** What is being studied; '' when not given. At most 200 characters. */
  focusSubject: string;
  /** Focus block length, 10–50 minutes. */
  blockMinutes: number;
  /** The focus preset (presets.id), or null. */
  presetId: string | null;
  split: Split;
  /** The equipment setup in use (equipment_setups.id), or null when the user has none yet. */
  setupId: string | null;
  location: SetupLocation;
  equipment: string[];
  moveKind: WorkoutKind;
  /** micro: 5, 10 or 15; full: 30, 45 or 60. */
  moveMinutes: number;
  /** Return countdown, in seconds. */
  returnSeconds: number;
};

/** A plan as the start panel may give it: anything left out gets its default. */
export type CyclePlanInput = Pick<CyclePlan, 'split' | 'location'> & Partial<Omit<CyclePlan, 'split' | 'location'>>;

export type CycleStats = {
  /** Focus blocks ended (run out or ended early). */
  blocks: number;
  /** Focus time actually counted, in ms (pauses excluded). */
  focusMs: number;
  /** Move blocks with at least one set. */
  moveBlocks: number;
  sets: number;
};

export type CycleSummary = CycleStats & {
  mode: CycleMode;
  startedAt: number;
  finishedAt: number;
};

/** 'study' = focus blocks with move blocks between; 'move_only' = one move block ("Just train"). */
export type CycleMode = 'study' | 'move_only';

/** Where the user is in the circuit: the item to do next, and (micro) the round. */
export type MovePosition = { round: number; itemIndex: number };

/** One circuit item's progress in the move block. */
export type ItemProgress = {
  /** Planned sets done at this item, whichever exercise was in it (rest-pause mini-sets don't count). */
  setsDone: number;
  /** setsDone when the current exercise came in (more than 0 after a swap part-way). */
  setsBefore: number;
  /** The current exercise's sets in this block, oldest first: what the spotter reads. */
  history: LoggedSet[];
  /** Targets for the item's next set (the circuit's, then the spotter's). */
  next: SetTargets;
  nextSetType: SetType;
  /** open = sets left; done = all planned sets; cut = the spotter stopped it; skipped = the user did. */
  status: 'open' | 'done' | 'cut' | 'skipped';
};

/** What the spotter said after the last set (shown on the screen). */
export type LastAdvice = { itemIndex: number; exerciseName: string; advice: SpotterAdvice };

type EffectBody =
  | { kind: 'start_focus_block'; input: StartFocusBlockInput }
  | { kind: 'end_focus_block'; blockId: string; endedAt: number; interrupted: boolean }
  | { kind: 'rate_block'; blockId: string; effort: number }
  | { kind: 'start_move_block'; input: StartMoveBlockInput }
  | { kind: 'log_set'; input: LogSetInput }
  | { kind: 'finish_move_block'; workoutId: string; durationMinutes: number }
  | { kind: 'skip_move_block'; workoutId: string; transitionId: string | null }
  | { kind: 'schedule_block_end'; notificationId: string; endsAt: number; title: string; body: string }
  | { kind: 'cancel_notification'; notificationId: string };

/** A side effect to perform: `id` orders and acknowledges it, `at` is when it was decided (epoch ms). */
export type CycleEffect = EffectBody & { id: number; at: number };

export type CycleEffectKind = CycleEffect['kind'];

type Base = {
  version: typeof CYCLE_STATE_VERSION;
  /** Whose cycle this is (null before the first start). */
  userId: string | null;
  /** Side effects still to perform, oldest first. */
  pending: CycleEffect[];
  /** The last effect id handed out. */
  effectSeq: number;
};

type Core = {
  userId: string;
  mode: CycleMode;
  plan: CyclePlan;
  /** The study_sessions row; null for a move-only cycle. */
  sessionId: string | null;
  cycleStartedAt: number;
  stats: CycleStats;
};

export type IdleState = Base & {
  phase: 'idle';
  /** The cycle that just finished, until the summary is dismissed. */
  summary: CycleSummary | null;
};

export type FocusState = Base &
  Core & {
    phase: 'focus';
    blockId: string;
    /** 1 for the cycle's first block. */
    blockNumber: number;
    /** When the block started (interval_blocks.started_at), epoch ms. */
    startedAt: number;
    timer: TimerState;
    /** The block's recorded end (see the header); set when it has ended but the circuit is not ready yet. */
    endedAt: number | null;
    interrupted: boolean;
    /** The move block's circuit, prepared while the timer runs; null until it is ready. */
    circuit: Circuit | null;
    /** Ids of the rows the following move block will create. */
    workoutId: string;
    transitionId: string;
    /** Our id of the block-end alert. */
    notificationId: string;
  };

export type MoveState = Base &
  Core & {
    phase: 'move';
    workoutId: string;
    /** null for a move-only cycle (no transition row). */
    transitionId: string | null;
    /** The focus block just finished (its effort can be rated), or null. */
    blockId: string | null;
    /** Number of that block (0 when move-only). */
    blockNumber: number;
    effortRating: number | null;
    circuit: Circuit;
    /** Per circuit item, same order. */
    items: ItemProgress[];
    position: MovePosition;
    /** Sets logged in this workout: the next set's set_index. */
    setsLogged: number;
    startedAt: number;
    /** When the last set was logged (for the rest taken before the next one). */
    lastSetAt: number | null;
    /** When the last set was logged or item skipped (double-tap guard). */
    lastStepAt: number | null;
    /** The rest timer after the last set; null when not resting. */
    rest: TimerState | null;
    lastAdvice: LastAdvice | null;
  };

export type ReturnState = Base &
  Core & {
    phase: 'return';
    /** The last focus block (its effort can still be rated). */
    blockId: string | null;
    blockNumber: number;
    effortRating: number | null;
    countdown: TimerState;
  };

export type ActiveCycleState = FocusState | MoveState | ReturnState;
export type CycleState = IdleState | ActiveCycleState;
export type CyclePhase = CycleState['phase'];

/** Ids for a focus block and the move block that follows it. */
export type BlockIds = { blockId: string; workoutId: string; transitionId: string };

export type CycleEvent =
  /** Start a cycle with its first focus block. */
  | { type: 'start'; at: number; userId: string; plan: CyclePlanInput; ids: BlockIds & { sessionId: string } }
  /** Start a move block on its own ("Just train"); the circuit must be built already. */
  | { type: 'start_move'; at: number; userId: string; plan: CyclePlanInput; workoutId: string; circuit: Circuit }
  /** The clock moved (each second while visible, and on load / app foreground). ids: for a block the return countdown may start. */
  | { type: 'tick'; at: number; ids?: BlockIds }
  /** The circuit for the move block after this focus block is ready. */
  | { type: 'circuit_ready'; at: number; blockId: string; circuit: Circuit }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  /** End the focus block early (it is recorded as interrupted) and go to the move block. */
  | { type: 'end_block'; at: number }
  /**
   * A set of the current item is done: `done` reps (or seconds) at `weightLbs` (null = bodyweight).
   * `unit` and `equipment` (the exercise's) are for the spotter. With `expectedSetIndex`, the set is
   * only logged when it is still the workout's next set (a tap on a stale screen does nothing).
   */
  | {
      type: 'log_set';
      at: number;
      setId: string;
      done: number;
      weightLbs: number | null;
      rpe: number | null;
      unit: Unit;
      equipment: readonly string[];
      expectedSetIndex?: number;
    }
  | { type: 'skip_rest'; at: number }
  /** Skip the rest of this item for today. itemIndex must be the current item. */
  | { type: 'skip_exercise'; at: number; itemIndex: number }
  /** Replace an open item's exercise (built with replaceItem from swap.ts). */
  | { type: 'swap'; at: number; itemIndex: number; item: CircuitItem }
  /** How the focus block felt, 1–5 (the effort row in the move or return phase). */
  | { type: 'rate_block'; at: number; effort: number }
  /** End the move block now (a block with no sets counts as skipped). */
  | { type: 'finish_move'; at: number }
  /** Skip the move block (after sets were logged, the same as finish_move). */
  | { type: 'skip_move'; at: number }
  /** Start the next focus block without waiting for the countdown. */
  | { type: 'start_now'; at: number; ids: BlockIds }
  /**
   * Schedule the coming block-end alert again (the notification permission may have been granted
   * since, or Android dropped the alarm). It keeps its id, so this only ever replaces it.
   */
  | { type: 'reschedule_alert'; at: number }
  /** Finish the cycle from any phase. */
  | { type: 'finish'; at: number }
  | { type: 'dismiss_summary' }
  /** A pending effect was performed. */
  | { type: 'effect_done'; effectId: number };

export type CycleEventType = CycleEvent['type'];

const EMPTY_STATS: CycleStats = { blocks: 0, focusMs: 0, moveBlocks: 0, sets: 0 };

export function initialCycleState(userId: string | null = null): IdleState {
  return { version: CYCLE_STATE_VERSION, userId, pending: [], effectSeq: 0, phase: 'idle', summary: null };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The allowed value nearest to `value` (the first one on a tie), or `fallback` when value is not a number. */
function nearest(value: unknown, allowed: readonly number[], fallback: number): number {
  const n = finite(value);
  if (n === null) return fallback;
  return allowed.reduce((best, option) => (Math.abs(option - n) < Math.abs(best - n) ? option : best), allowed[0]);
}

/** The plan with every value within its range (see CYCLE_RULES); missing values get their defaults. */
export function normalizePlan(input: CyclePlanInput): CyclePlan {
  const minutes = finite(input.blockMinutes);
  const blockMinutes =
    minutes === null
      ? R.blockMinutes.default
      : Math.min(R.blockMinutes.max, Math.max(R.blockMinutes.min, Math.round(minutes)));
  const moveKind: WorkoutKind = input.moveKind === 'full' ? 'full' : 'micro';
  const moveMinutes =
    moveKind === 'micro'
      ? nearest(input.moveMinutes, R.microMinutes, R.defaultMicroMinutes)
      : nearest(input.moveMinutes, R.fullMinutes, R.defaultFullMinutes);
  const back = finite(input.returnSeconds);
  const returnSeconds = back === null ? R.returnSeconds : Math.min(R.maxReturnSeconds, Math.max(0, Math.round(back)));
  const equipment = [...new Set((input.equipment ?? []).filter((item): item is string => typeof item === 'string'))];
  return {
    focusSubject: (typeof input.focusSubject === 'string' ? input.focusSubject : '').trim().slice(0, 200),
    blockMinutes,
    presetId: input.presetId ?? null,
    split: { lower: input.split.lower, upper: input.split.upper, core: input.split.core, cardio: input.split.cardio },
    setupId: input.setupId ?? null,
    location: input.location === 'gym' ? 'gym' : 'home',
    equipment,
    moveKind,
    moveMinutes,
    returnSeconds,
  };
}

/**
 * Our id of a block's end-of-block alert (scheduling it again replaces it): the study session and the
 * block's number in it, so the next block's alert can be scheduled when the return countdown starts,
 * before that block has its ids.
 */
export function blockEndNotificationId(sessionId: string | null, blockNumber: number): string {
  return `block-end-${sessionId ?? 'none'}-${blockNumber}`;
}

/** The end-of-block alert's words. */
export function blockEndNotice(plan: CyclePlan): { title: string; body: string } {
  const move =
    plan.moveKind === 'micro' ? `your ${plan.moveMinutes}-minute circuit` : `your ${plan.moveMinutes}-minute session`;
  return { title: 'Focus block done', body: `Time to move: ${move} is ready.` };
}

/** The targets a circuit item starts with. */
export function itemTargets(item: CircuitItem): SetTargets {
  return { targetReps: item.targetReps, targetSeconds: item.targetSeconds, targetWeightLbs: item.targetWeightLbs };
}

function initialProgress(item: CircuitItem): ItemProgress {
  return {
    setsDone: 0,
    setsBefore: 0,
    history: [],
    next: itemTargets(item),
    nextSetType: 'normal',
    status: item.sets > 0 ? 'open' : 'done',
  };
}

/** The target of the item's next set: reps, or seconds for a timed item. */
export function targetOf(item: Pick<CircuitItem, 'measure'>, next: SetTargets): number | null {
  return item.measure === 'time' ? next.targetSeconds : next.targetReps;
}

/** What the move screen shows for the current item. */
export type Station = {
  index: number;
  item: CircuitItem;
  progress: ItemProgress;
  /** Reps (or seconds) to aim for, or null. */
  target: number | null;
  targetWeightLbs: number | null;
  /** 1-based number of the next planned set of this item ("Set 2 of 3"); a rest-pause set repeats the last. */
  setNumber: number;
  plannedSets: number;
  /** Micro: the round ("Round 2 of 3"); full: 1. */
  round: number;
  rounds: number;
  /** The next set is a rest-pause mini-set (just the missing reps, right after a short rest). */
  restPause: boolean;
};

/** The item the user does next, or null when there is none. */
export function currentStation(state: MoveState): Station | null {
  const index = state.position.itemIndex;
  const item = state.circuit.items[index];
  const progress = state.items[index];
  if (!item || !progress || progress.status !== 'open') return null;
  return {
    index,
    item,
    progress,
    target: targetOf(item, progress.next),
    targetWeightLbs: progress.next.targetWeightLbs,
    setNumber: Math.max(1, Math.min(item.sets, progress.setsDone + (progress.nextSetType === 'rest_pause' ? 0 : 1))),
    plannedSets: item.sets,
    round: state.position.round,
    rounds: state.circuit.rounds,
    restPause: progress.nextSetType === 'rest_pause',
  };
}

// ---------------------------------------------------------------------------------------------
// Building blocks.

function baseOf(state: CycleState): Base {
  return { version: CYCLE_STATE_VERSION, userId: state.userId, pending: state.pending, effectSeq: state.effectSeq };
}

function coreOf(state: ActiveCycleState): Core {
  return {
    userId: state.userId,
    mode: state.mode,
    plan: state.plan,
    sessionId: state.sessionId,
    cycleStartedAt: state.cycleStartedAt,
    stats: state.stats,
  };
}

function addEffects<S extends CycleState>(state: S, at: number, bodies: readonly EffectBody[]): S {
  let seq = state.effectSeq;
  const added = bodies.map((body) => {
    seq += 1;
    return { ...body, id: seq, at } as CycleEffect;
  });
  return { ...state, pending: [...state.pending, ...added], effectSeq: seq };
}

function hasOpenItem(circuit: Circuit): boolean {
  return circuit.items.some((item) => item.sets > 0);
}

/** A new focus block (the first of the cycle when createSession). */
function beginFocus(
  base: Base,
  core: Core,
  blockNumber: number,
  at: number,
  ids: BlockIds,
  createSession: boolean,
): FocusState {
  const timer = startTimer(at, core.plan.blockMinutes * 60_000);
  const notificationId = blockEndNotificationId(core.sessionId, blockNumber);
  const focus: FocusState = {
    ...base,
    ...core,
    phase: 'focus',
    blockId: ids.blockId,
    blockNumber,
    startedAt: at,
    timer,
    endedAt: null,
    interrupted: false,
    circuit: null,
    workoutId: ids.workoutId,
    transitionId: ids.transitionId,
    notificationId,
  };
  return addEffects(focus, at, [
    {
      kind: 'start_focus_block',
      input: {
        userId: core.userId,
        sessionId: core.sessionId ?? '',
        createSession,
        focusSubject: core.plan.focusSubject,
        blockId: ids.blockId,
        plannedMinutes: core.plan.blockMinutes,
        startedAt: at,
      },
    },
    { kind: 'schedule_block_end', notificationId, endsAt: timer.endsAt ?? at, ...blockEndNotice(core.plan) },
  ]);
}

/**
 * Records the end of the focus block (stays in focus; see endFocus). `clockEnd` is when it ended on the
 * clock; the recorded end is the start plus the time focused until then (see the header). A state saved
 * before blocks kept their start has no startedAt: its end is the clock's, as before.
 */
function closeBlock(state: FocusState, clockEnd: number, interrupted: boolean, at: number): FocusState {
  const focusedMs = elapsedMs(state.timer, clockEnd);
  const start = finite(state.startedAt);
  const endedAt = start === null ? clockEnd : start + focusedMs;
  const stats = { ...state.stats, blocks: state.stats.blocks + 1, focusMs: state.stats.focusMs + focusedMs };
  return addEffects({ ...state, endedAt, interrupted, stats }, at, [
    { kind: 'end_focus_block', blockId: state.blockId, endedAt, interrupted },
    { kind: 'cancel_notification', notificationId: state.notificationId },
  ]);
}

/** Ends the focus block and hands off to the move block (or waits for the circuit). */
function endFocus(state: FocusState, endedAt: number, interrupted: boolean, at: number): CycleState {
  const closed = closeBlock(state, endedAt, interrupted, at);
  return closed.circuit ? handoff(closed, closed.circuit, at) : closed;
}

/** The timer has run out: the block ended when it reached zero. */
function reachedEnd(state: FocusState, at: number): CycleState {
  return endFocus(state, state.timer.endsAt ?? at, false, at);
}

/** The alert at the end of the block a return countdown starts: its id and when it rings. */
function nextBlockAlert(state: ReturnState): Extract<EffectBody, { kind: 'schedule_block_end' }> {
  const startsAt = state.countdown.endsAt ?? 0;
  return {
    kind: 'schedule_block_end',
    notificationId: blockEndNotificationId(state.sessionId, state.blockNumber + 1),
    endsAt: startsAt + state.plan.blockMinutes * 60_000,
    ...blockEndNotice(state.plan),
  };
}

/** The return countdown; the next block's alert is scheduled now (see the header). */
function toReturn(
  state: ActiveCycleState,
  at: number,
  last: { blockId: string | null; blockNumber: number; effortRating: number | null },
): ReturnState {
  const back: ReturnState = {
    ...baseOf(state),
    ...coreOf(state),
    phase: 'return',
    ...last,
    countdown: startTimer(at, state.plan.returnSeconds * 1000),
  };
  return addEffects(back, at, [nextBlockAlert(back)]);
}

/** Ends the cycle from the return countdown: the next block's alert is withdrawn. */
function finishReturn(state: ReturnState, finishedAt: number, at: number): IdleState {
  const { notificationId } = nextBlockAlert(state);
  return finishCycle(addEffects(state, at, [{ kind: 'cancel_notification', notificationId }]), finishedAt);
}

/** The zero-tap handoff: the move block starts with the circuit prepared during the focus block. */
function handoff(state: FocusState, circuit: Circuit, at: number): CycleState {
  const last = { blockId: state.blockId, blockNumber: state.blockNumber, effortRating: null };
  // Nothing to do (no exercise fits): straight on to the return countdown, with no workout rows.
  if (!hasOpenItem(circuit)) return toReturn(state, at, last);
  const items = circuit.items.map(initialProgress);
  const move: MoveState = {
    ...baseOf(state),
    ...coreOf(state),
    phase: 'move',
    workoutId: state.workoutId,
    transitionId: state.transitionId,
    ...last,
    circuit,
    items,
    position: { round: 1, itemIndex: items.findIndex((item) => item.status === 'open') },
    setsLogged: 0,
    startedAt: at,
    lastSetAt: null,
    lastStepAt: null,
    rest: null,
    lastAdvice: null,
  };
  return addEffects(move, at, [
    {
      kind: 'start_move_block',
      input: {
        userId: state.userId,
        workoutId: state.workoutId,
        kind: circuit.kind,
        loggedAt: at,
        presetId: state.plan.presetId,
        setupId: state.plan.setupId,
        transition: { id: state.transitionId, blockId: state.blockId, proposal: circuit },
      },
    },
  ]);
}

function finishCycle(state: ActiveCycleState, at: number): IdleState {
  return {
    ...baseOf(state),
    phase: 'idle',
    summary: { ...state.stats, mode: state.mode, startedAt: state.cycleStartedAt, finishedAt: at },
  };
}

/** When the move block's work ended: its last set, or `at` before any (see the header). */
function moveEnd(state: MoveState, at: number): number {
  return state.lastSetAt === null ? at : Math.min(at, state.lastSetAt);
}

/** Closes the move block's rows: finished with its length, or skipped when no set was logged. */
function closeMove(state: MoveState, at: number): MoveState {
  if (state.setsLogged === 0) {
    return addEffects(state, at, [
      { kind: 'skip_move_block', workoutId: state.workoutId, transitionId: state.transitionId },
    ]);
  }
  const durationMinutes = Math.max(0, Math.round((moveEnd(state, at) - state.startedAt) / 60_000));
  const stats = { ...state.stats, moveBlocks: state.stats.moveBlocks + 1 };
  return addEffects({ ...state, stats }, at, [
    { kind: 'finish_move_block', workoutId: state.workoutId, durationMinutes },
  ]);
}

/** The move block is over: back to studying (return), or the end of a move-only cycle. */
function completeMove(state: MoveState, at: number): CycleState {
  const closed = closeMove(state, at);
  // A move-only cycle is its workout: it ends when the workout did (the summary counts its minutes).
  if (closed.mode === 'move_only') return finishCycle(closed, moveEnd(state, at));
  return toReturn(closed, at, {
    blockId: closed.blockId,
    blockNumber: closed.blockNumber,
    effortRating: closed.effortRating,
  });
}

/** The next open item after `from`, in circuit order, wrapping (a wrap starts a new micro round). */
export function nextOpenPosition(
  items: readonly ItemProgress[],
  from: number,
  round: number,
  kind: WorkoutKind,
): MovePosition | null {
  const n = items.length;
  for (let step = 1; step <= n; step += 1) {
    const index = (from + step) % n;
    if (items[index].status === 'open') {
      const wrapped = from + step >= n;
      return { itemIndex: index, round: kind === 'micro' && wrapped ? round + 1 : round };
    }
  }
  return null;
}

function isDoubleTap(state: MoveState, at: number): boolean {
  return state.lastStepAt !== null && at >= state.lastStepAt && at - state.lastStepAt < R.doubleTapMs;
}

function wholeOrZero(value: number): number {
  const n = finite(value);
  return n === null ? 0 : Math.max(0, Math.round(n));
}

function logSet(state: MoveState, event: Extract<CycleEvent, { type: 'log_set' }>): CycleState {
  const { at } = event;
  if (event.expectedSetIndex !== undefined && event.expectedSetIndex !== state.setsLogged) return state;
  if (isDoubleTap(state, at)) return state;
  const index = state.position.itemIndex;
  const item = state.circuit.items[index];
  const progress = state.items[index];
  if (!item || !progress || progress.status !== 'open') return state;

  const rawTarget = targetOf(item, progress.next);
  const target = rawTarget === null ? null : wholeOrZero(rawTarget);
  const done = wholeOrZero(event.done);
  const weight = finite(event.weightLbs);
  const weightLbs = weight !== null && weight > 0 ? weight : null;
  const rpeValue = finite(event.rpe);
  const rpe = rpeValue !== null && rpeValue >= 1 && rpeValue <= 10 ? rpeValue : null;
  const workSeconds = item.measure === 'time' ? done : done * PRESCRIPTION.secondsPerRep;
  // The rest taken before this set: the time since the last set, less this set's own work.
  const restSeconds =
    state.lastSetAt === null ? null : Math.max(0, Math.round((at - state.lastSetAt) / 1000 - workSeconds));
  const last: LoggedSet = {
    target,
    done,
    targetWeightLbs: progress.next.targetWeightLbs,
    weightLbs,
    rpe,
    restSeconds,
    setType: progress.nextSetType,
  };

  const advice = adviseNextSet({
    measure: item.measure,
    unit: event.unit,
    equipment: event.equipment,
    plannedSets: Math.max(1, item.sets - progress.setsBefore),
    plannedRestSeconds: item.restSeconds,
    last,
    earlier: progress.history,
    // Micro: while another station is open, this exercise's next set comes after it, a round later.
    roundRobin:
      state.circuit.kind === 'micro' && state.items.some((entry, i) => i !== index && entry.status === 'open'),
  });
  const restPause = advice.action === 'rest_pause' && advice.next !== null;
  const setsDone = progress.setsDone + (last.setType === 'rest_pause' ? 0 : 1);
  const over = advice.next === null || (!restPause && setsDone >= item.sets);
  const updated: ItemProgress = {
    ...progress,
    setsDone,
    history: [...progress.history, last],
    next: advice.next ?? progress.next,
    nextSetType: over ? 'normal' : advice.setType,
    status: over ? (advice.action === 'cut_set' ? 'cut' : 'done') : 'open',
  };
  const items = state.items.map((entry, i) => (i === index ? updated : entry));

  const logged: MoveState = addEffects(
    {
      ...state,
      items,
      setsLogged: state.setsLogged + 1,
      stats: { ...state.stats, sets: state.stats.sets + 1 },
      lastSetAt: at,
      lastStepAt: at,
      lastAdvice: { itemIndex: index, exerciseName: item.name, advice },
    },
    at,
    [
      {
        kind: 'log_set',
        input: {
          id: event.setId,
          userId: state.userId,
          workoutId: state.workoutId,
          transitionId: state.transitionId,
          exerciseId: item.exerciseId,
          exerciseName: item.name,
          setIndex: state.setsLogged,
          reps: done,
          weightLbs,
          rpe,
          targetReps: target,
          targetWeightLbs: progress.next.targetWeightLbs,
          restSeconds,
          setType: last.setType,
          loggedAt: at,
        },
      },
    ],
  );

  // Straight sets (full) stay on the item while it has sets left; a rest-pause set always comes next.
  const stay = restPause || (state.circuit.kind === 'full' && !over);
  const position = stay
    ? state.position
    : nextOpenPosition(items, index, state.position.round, state.circuit.kind);
  if (position === null) return completeMove({ ...logged, rest: null }, at);
  // Rest before the same exercise again is the spotter's; before another station, the item's change-over.
  const seconds = position.itemIndex === index ? advice.restSeconds : item.restSeconds;
  return { ...logged, position, rest: seconds > 0 ? startTimer(at, seconds * 1000) : null };
}

function skipExercise(state: MoveState, event: Extract<CycleEvent, { type: 'skip_exercise' }>): CycleState {
  const { at, itemIndex } = event;
  if (itemIndex !== state.position.itemIndex || isDoubleTap(state, at)) return state;
  const progress = state.items[itemIndex];
  if (!progress || progress.status !== 'open') return state;
  const items = state.items.map((entry, i) =>
    i === itemIndex ? { ...entry, status: 'skipped' as const, nextSetType: 'normal' as const } : entry,
  );
  const skipped: MoveState = { ...state, items, lastStepAt: at };
  const position = nextOpenPosition(items, itemIndex, state.position.round, state.circuit.kind);
  if (position === null) return completeMove({ ...skipped, rest: null }, at);
  return { ...skipped, position };
}

function isCircuitItem(value: unknown): value is CircuitItem {
  const item = value as CircuitItem | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.exerciseId === 'string' &&
    typeof item.name === 'string' &&
    (item.measure === 'reps' || item.measure === 'time') &&
    Number.isInteger(item.sets) &&
    item.sets >= 0 &&
    finite(item.restSeconds) !== null
  );
}

function swap(state: MoveState, event: Extract<CycleEvent, { type: 'swap' }>): CycleState {
  const { itemIndex, item } = event;
  const current = state.circuit.items[itemIndex];
  const progress = state.items[itemIndex];
  if (!current || !progress || progress.status !== 'open' || !isCircuitItem(item)) return state;
  if (item.exerciseId === current.exerciseId) return state;
  const circuitItems = state.circuit.items.map((entry, i) => (i === itemIndex ? item : entry));
  const circuit: Circuit = { ...state.circuit, items: circuitItems, estimatedSeconds: estimateCircuitSeconds(circuitItems) };
  const swapped: ItemProgress = {
    setsDone: progress.setsDone,
    setsBefore: progress.setsDone,
    history: [],
    next: itemTargets(item),
    nextSetType: 'normal',
    status: item.sets > progress.setsDone ? 'open' : 'done',
  };
  const items = state.items.map((entry, i) => (i === itemIndex ? swapped : entry));
  const lastAdvice = state.lastAdvice?.itemIndex === itemIndex ? null : state.lastAdvice;
  const next: MoveState = { ...state, circuit, items, lastAdvice };
  if (swapped.status === 'open' || itemIndex !== state.position.itemIndex) return next;
  const position = nextOpenPosition(items, itemIndex, state.position.round, state.circuit.kind);
  return position === null ? completeMove({ ...next, rest: null }, event.at) : { ...next, position };
}

function rate<S extends MoveState | ReturnState>(state: S, event: Extract<CycleEvent, { type: 'rate_block' }>): S {
  const { effort } = event;
  if (state.blockId === null || !Number.isInteger(effort) || effort < R.effort.min || effort > R.effort.max) {
    return state;
  }
  if (state.effortRating === effort) return state;
  return addEffects({ ...state, effortRating: effort }, event.at, [
    { kind: 'rate_block', blockId: state.blockId, effort },
  ]);
}

function nextBlock(state: ReturnState, startAt: number, ids: BlockIds): FocusState {
  return beginFocus(baseOf(state), coreOf(state), state.blockNumber + 1, startAt, ids, false);
}

// ---------------------------------------------------------------------------------------------
// The reducer.

function reduceIdle(state: IdleState, event: CycleEvent): CycleState {
  switch (event.type) {
    case 'start': {
      const plan = normalizePlan(event.plan);
      const core: Core = {
        userId: event.userId,
        mode: 'study',
        plan,
        sessionId: event.ids.sessionId,
        cycleStartedAt: event.at,
        stats: EMPTY_STATS,
      };
      return beginFocus({ ...baseOf(state), userId: event.userId }, core, 1, event.at, event.ids, true);
    }
    case 'start_move': {
      const { circuit } = event;
      if (!circuit || !Array.isArray(circuit.items) || !hasOpenItem(circuit)) return state;
      const items = circuit.items.map(initialProgress);
      const move: MoveState = {
        ...baseOf(state),
        userId: event.userId,
        mode: 'move_only',
        plan: normalizePlan(event.plan),
        sessionId: null,
        cycleStartedAt: event.at,
        stats: EMPTY_STATS,
        phase: 'move',
        workoutId: event.workoutId,
        transitionId: null,
        blockId: null,
        blockNumber: 0,
        effortRating: null,
        circuit,
        items,
        position: { round: 1, itemIndex: items.findIndex((item) => item.status === 'open') },
        setsLogged: 0,
        startedAt: event.at,
        lastSetAt: null,
        lastStepAt: null,
        rest: null,
        lastAdvice: null,
      };
      return addEffects(move, event.at, [
        {
          kind: 'start_move_block',
          input: {
            userId: event.userId,
            workoutId: event.workoutId,
            kind: circuit.kind,
            loggedAt: event.at,
            presetId: move.plan.presetId,
            setupId: move.plan.setupId,
            transition: null,
          },
        },
      ]);
    }
    case 'dismiss_summary':
      return state.summary ? { ...state, summary: null } : state;
    default:
      return state;
  }
}

function reduceFocus(state: FocusState, event: CycleEvent): CycleState {
  switch (event.type) {
    case 'tick':
      return state.endedAt === null && isDone(state.timer, event.at) ? reachedEnd(state, event.at) : state;
    case 'pause': {
      if (state.endedAt !== null || isPaused(state.timer)) return state;
      if (isDone(state.timer, event.at)) return reachedEnd(state, event.at);
      return addEffects({ ...state, timer: pauseTimer(state.timer, event.at) }, event.at, [
        { kind: 'cancel_notification', notificationId: state.notificationId },
      ]);
    }
    case 'resume': {
      if (state.endedAt !== null || !isPaused(state.timer)) return state;
      const timer = resumeTimer(state.timer, event.at);
      return addEffects({ ...state, timer }, event.at, [
        {
          kind: 'schedule_block_end',
          notificationId: state.notificationId,
          endsAt: timer.endsAt ?? event.at,
          ...blockEndNotice(state.plan),
        },
      ]);
    }
    case 'end_block':
      if (state.endedAt !== null) return state;
      return isDone(state.timer, event.at) ? reachedEnd(state, event.at) : endFocus(state, event.at, true, event.at);
    case 'reschedule_alert': {
      if (state.endedAt !== null || isPaused(state.timer) || isDone(state.timer, event.at)) return state;
      return addEffects(state, event.at, [
        {
          kind: 'schedule_block_end',
          notificationId: state.notificationId,
          endsAt: state.timer.endsAt ?? event.at,
          ...blockEndNotice(state.plan),
        },
      ]);
    }
    case 'circuit_ready': {
      if (event.blockId !== state.blockId || state.circuit !== null || !event.circuit) return state;
      const ready: FocusState = { ...state, circuit: event.circuit };
      return ready.endedAt !== null ? handoff(ready, event.circuit, event.at) : ready;
    }
    case 'finish': {
      if (state.endedAt !== null) return finishCycle(state, event.at);
      const done = isDone(state.timer, event.at);
      const closed = closeBlock(state, done ? (state.timer.endsAt ?? event.at) : event.at, !done, event.at);
      return finishCycle(closed, event.at);
    }
    default:
      return state;
  }
}

function reduceMove(state: MoveState, event: CycleEvent): CycleState {
  switch (event.type) {
    case 'tick': {
      // MOVE_STALE: left open (the app closed mid-workout): close it at its last set and finish there,
      // so a move-only summary counts the same minutes as the stored workout (as completeMove does).
      const lastTouched = state.lastStepAt ?? state.startedAt;
      if (event.at - lastTouched > R.moveStaleMs) {
        return finishCycle(closeMove(state, event.at), moveEnd(state, lastTouched));
      }
      return state.rest && isDone(state.rest, event.at) ? { ...state, rest: null } : state;
    }
    case 'log_set':
      return logSet(state, event);
    case 'skip_rest':
      return state.rest ? { ...state, rest: null } : state;
    case 'skip_exercise':
      return skipExercise(state, event);
    case 'swap':
      return swap(state, event);
    case 'rate_block':
      return rate(state, event);
    case 'finish_move':
    case 'skip_move':
      return completeMove(state, event.at);
    case 'finish':
      return finishCycle(closeMove(state, event.at), event.at);
    default:
      return state;
  }
}

function reduceReturn(state: ReturnState, event: CycleEvent): CycleState {
  switch (event.type) {
    case 'tick': {
      if (!isDone(state.countdown, event.at)) return state;
      // The next block started when the countdown ended, looked at or not (see the header).
      const end = state.countdown.endsAt ?? event.at;
      if (event.at - nextBlockAlert(state).endsAt > R.returnStaleMs) return finishReturn(state, end, event.at);
      if (!event.ids) return state;
      const focus = nextBlock(state, end, event.ids);
      // Back only after that block's time was up (its alert rang): it ends, and the workout follows.
      return isDone(focus.timer, event.at) ? reachedEnd(focus, event.at) : focus;
    }
    case 'start_now':
      return nextBlock(state, event.at, event.ids);
    case 'reschedule_alert': {
      const alert = nextBlockAlert(state);
      return alert.endsAt > event.at ? addEffects(state, event.at, [alert]) : state;
    }
    case 'rate_block':
      return rate(state, event);
    case 'finish':
      return finishReturn(state, event.at, event.at);
    default:
      return state;
  }
}

/**
 * The next state for an event. Pure: no clock, no ids, no I/O. Returns the same object when the event
 * changes nothing.
 */
export function cycleReducer(state: CycleState, event: CycleEvent): CycleState {
  if (event.type === 'effect_done') {
    if (!state.pending.some((effect) => effect.id === event.effectId)) return state;
    return { ...state, pending: state.pending.filter((effect) => effect.id !== event.effectId) };
  }
  switch (state.phase) {
    case 'idle':
      return reduceIdle(state, event);
    case 'focus':
      return reduceFocus(state, event);
    case 'move':
      return reduceMove(state, event);
    case 'return':
      return reduceReturn(state, event);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a persisted state.

const PHASES: readonly CyclePhase[] = ['idle', 'focus', 'move', 'return'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimer(value: unknown): value is TimerState {
  return (
    isObject(value) &&
    finite(value.durationMs) !== null &&
    (value.endsAt === null || finite(value.endsAt) !== null) &&
    (value.pausedRemainingMs === null || finite(value.pausedRemainingMs) !== null)
  );
}

function isCircuit(value: unknown): value is Circuit {
  return isObject(value) && Array.isArray(value.items) && value.items.every(isCircuitItem);
}

function looksValid(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.pending) || finite(value.effectSeq) === null) return false;
  if (value.phase === 'idle') return true;
  if (typeof value.userId !== 'string' || !isObject(value.plan) || !isObject(value.stats)) return false;
  switch (value.phase) {
    case 'focus':
      return typeof value.blockId === 'string' && isTimer(value.timer) && (value.circuit === null || isCircuit(value.circuit));
    case 'move':
      return (
        typeof value.workoutId === 'string' &&
        isCircuit(value.circuit) &&
        Array.isArray(value.items) &&
        value.items.length === value.circuit.items.length &&
        isObject(value.position) &&
        (value.rest === null || isTimer(value.rest))
      );
    case 'return':
      return isTimer(value.countdown);
    default:
      return false;
  }
}

/**
 * The machine state read back from local_state: the saved state when it is a valid state of this
 * version that belongs to `userId`, else a fresh idle state (an unreadable or foreign cycle is
 * dropped, together with its pending effects, rather than crashing the screen).
 */
export function parseCycleState(value: unknown, userId: string | null): CycleState {
  if (!isObject(value) || value.version !== CYCLE_STATE_VERSION) return initialCycleState(userId);
  if (!PHASES.includes(value.phase as CyclePhase) || !looksValid(value)) return initialCycleState(userId);
  if (value.userId !== null && value.userId !== undefined && value.userId !== userId) return initialCycleState(userId);
  return value as unknown as CycleState;
}
