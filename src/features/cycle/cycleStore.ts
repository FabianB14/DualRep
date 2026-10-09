/**
 * Runs the cycle machine (cycleMachine.ts) for one signed-in user: keeps the state, saves it to
 * local_state, performs the side effects the reducer queues, prepares circuits, and fires haptics.
 * useCycle wraps one shared store per user, so two screens (or React's double mount in development)
 * never run the same effect twice. It is plain TypeScript with its I/O passed in (CycleStoreDeps), so
 * it is tested without a database.
 *
 * CRASH SAFETY. The reducer appends each write to `pending` in the state. The store:
 *   1. saves the new state (with the effect in it) to local_state,
 *   2. only then performs the effect (one at a time, oldest first),
 *   3. then dispatches effect_done, which removes it, and saves again.
 * A crash before 2 leaves the effect pending in the saved state, so it runs after the restart: a set
 * the user logged is never lost. A crash between 2 and 3 runs it again after the restart, and every
 * effect is idempotent (ids are made in the event; cycleRepo skips an INSERT whose row exists;
 * notifications use our own ids), so nothing is written twice. Effects run in order, so a transition
 * is never uploaded before the block it points to.
 *
 * A failed write is retried with backoff (1 s, 2 s, 4 s … 30 s) and reported in `error`; later
 * effects wait behind it so the order holds. The report clears once a retry has gone through: an
 * effect performed, or a save with nothing left to write or perform. A write the repo refuses as
 * invalid (RangeError) can never succeed, so it is dropped and reported instead of blocking the loop.
 */
import type { LoggedSet } from '@/features/training/spotter';
import { replaceItem } from '@/features/training/swap';
import type { Circuit, LibraryExercise, Unit } from '@/features/training/types';
import type { AlertContent } from '@/features/timer/notifications';
import type { HapticIntent } from '@/theme/haptics';

import { applySessionAdvice, buildCycleCircuit, circuitVariant } from './circuitPrep';
import {
  cycleReducer,
  normalizePlan,
  parseCycleState,
  targetOf,
  type BlockIds,
  type CycleEffect,
  type CycleEvent,
  type CyclePhase,
  type CyclePlan,
  type CyclePlanInput,
  type CycleState,
} from './cycleMachine';
import type {
  endFocusBlock,
  finishMoveBlock,
  logSet,
  rateBlock,
  skipMoveBlock,
  startFocusBlock,
  startMoveBlock,
} from './cycleRepo';

export type CycleRepo = {
  startFocusBlock: typeof startFocusBlock;
  endFocusBlock: typeof endFocusBlock;
  rateBlock: typeof rateBlock;
  startMoveBlock: typeof startMoveBlock;
  logSet: typeof logSet;
  finishMoveBlock: typeof finishMoveBlock;
  skipMoveBlock: typeof skipMoveBlock;
  lastSessionSetsFor(
    exerciseIds: readonly string[],
    options?: { excludeWorkoutId?: string | null },
  ): Promise<Map<string, LoggedSet[]>>;
};

export type CycleStoreDeps = {
  /** Reads the saved state (any JSON value, or null). */
  readState(): Promise<unknown>;
  writeState(state: CycleState): Promise<void>;
  repo: CycleRepo;
  scheduleBlockEnd(endsAtMs: number, content: AlertContent): Promise<string | null>;
  cancelScheduled(id: string): Promise<void>;
  haptic(intent: HapticIntent): void;
  now(): number;
  newId(): string;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * A focus block that quizzed from a study plan has been closed on the phone (its end is written):
   * the daily review reminder is rescheduled, since this block's answers changed what is due. Not
   * awaited and never during sign-out (finishAndStop). Optional: without it nothing happens.
   */
  studyBlockEnded?(userId: string): void;
};

/** What circuits are built from: the live library and the profile's unit. */
export type CycleContext = {
  /** The exercises default circuits may use (useLibrary().circuitPool). */
  library: readonly LibraryExercise[];
  /** Every exercise on the phone by id (useLibrary().byId): equipment for the spotter, swap originals. */
  byId: ReadonlyMap<string, LibraryExercise>;
  unit: Unit;
};

export type CycleSnapshot = {
  /** null until the saved state has been read. */
  state: CycleState | null;
  /** A plain-words problem with saving, or null. */
  error: string | null;
};

/** What the user changed on the set card before tapping "Done". Anything left out is the target. */
export type SetActuals = {
  /** Reps done, or seconds for a timed exercise. */
  done?: number;
  /** Pounds; null = bodyweight. */
  weightLbs?: number | null;
  /** Effort chips: Easy 6, Solid 8, All out 10. */
  rpe?: number | null;
  /** The set_index the screen showed; the tap is ignored if the workout has moved on. */
  expectedSetIndex?: number;
};

export const CYCLE_SAVE_ERROR = "Couldn't save on this phone. Trying again…";
export const CYCLE_LOAD_ERROR = "Couldn't read your cycle on this phone. Trying again…";

const MAX_RETRY_MS = 30_000;

/** The haptic for an automatic change the user did not tap for (buttons already tick on press). */
export function cycleHaptic(prev: CycleState, next: CycleState, event: CycleEvent): HapticIntent | null {
  if (prev.phase === 'focus' && (next.phase === 'move' || next.phase === 'return')) return 'success';
  if (event.type === 'tick' && prev.phase === 'return' && next.phase === 'focus') return 'handoff';
  if (event.type === 'log_set' && prev.phase === 'move' && next.phase !== 'move') return 'success';
  if (event.type === 'tick' && prev.phase === 'move' && next.phase === 'move' && prev.rest && !next.rest) {
    return 'select';
  }
  return null;
}

export class CycleStore {
  readonly userId: string;
  private readonly deps: CycleStoreDeps;
  private state: CycleState | null = null;
  private error: string | null = null;
  private snapshot: CycleSnapshot = { state: null, error: null };
  private readonly listeners = new Set<() => void>();
  private context: CycleContext | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  /** Sign-out is closing the cycle: nothing may be scheduled for this account any more. */
  private stopping = false;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private running = false;
  private failures = 0;
  private retryHandle: unknown = null;
  private readonly preparing = new Set<string>();
  private busy = false;
  /** The effects run in progress (resolved when there is none), so stop() can wait for it. */
  private effectsRun: Promise<void> = Promise.resolve();

  constructor(userId: string, deps: CycleStoreDeps) {
    this.userId = userId;
    this.deps = deps;
  }

  // -- React binding ------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CycleSnapshot => this.snapshot;

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Stops all work (sign-out, another user): nothing is saved or written after this. */
  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.listeners.clear();
  }

  /**
   * dispose(), then resolves once nothing of this store is still writing: the save and the effect in
   * progress (if any) have finished. Sign-out waits for this before the local database is cleared, so
   * no write of the signed-out account lands after the clear. Never rejects.
   */
  async stop(): Promise<void> {
    this.dispose();
    await Promise.all([this.effectsRun.catch(() => undefined), this.writing?.catch(() => undefined)]);
  }

  /**
   * Sign-out: finishes a running cycle the way "Finish" does, so its rows are closed (the focus block's
   * end, the workout's length, or its skip) instead of staying open on the server for good once this
   * phone's copy is cleared; waits for those writes to land on the phone; then stop(). It first
   * catches up with the clock, as the cycle screen and a fresh load do, so the result is the same
   * whether or not the store was loaded before. A write still waiting is sent even when the cycle is
   * already over (a workout the load or that tick closed as stale). A write that fails is not retried
   * here (sign-out goes ahead). Never rejects.
   */
  async finishAndStop(): Promise<void> {
    this.stopping = true;
    try {
      await this.load();
      if (!this.disposed && this.state) {
        this.tick();
        if (this.phase() !== 'idle') this.finish();
        this.kick();
        // Runs every pending effect in order, and returns early only when one fails.
        await this.effectsRun;
      }
    } catch {
      // Nothing to finish, or it could not be read: sign-out goes ahead.
    }
    await this.stop();
  }

  setContext(context: CycleContext): void {
    this.context = context;
    this.prepareIfNeeded();
  }

  /** Reads the saved state once (later calls return the same promise), then catches up with the clock. */
  load(): Promise<void> {
    if (!this.loading) this.loading = this.loadOnce();
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    let saved: unknown;
    try {
      saved = await this.deps.readState();
    } catch {
      if (this.disposed) return;
      this.loading = null;
      this.retryLater(CYCLE_LOAD_ERROR);
      return;
    }
    if (this.disposed) return;
    this.state = parseCycleState(saved, this.userId);
    this.failures = 0;
    this.setError(null);
    this.publish();
    // A block that ended while the app was closed hands off now; effects left pending by a crash run.
    this.tick();
    this.kick();
  }

  // -- Events -------------------------------------------------------------------------------

  /** Applies an event: new state, saved, haptic, then pending effects and circuit preparation. */
  dispatch(event: CycleEvent): void {
    const prev = this.state;
    if (!prev || this.disposed) return;
    const next = cycleReducer(prev, event);
    if (next === prev) return;
    this.state = next;
    this.publish();
    this.dirty = true;
    this.flush().catch(() => this.retryLater(CYCLE_SAVE_ERROR));
    const intent = cycleHaptic(prev, next, event);
    if (intent) this.deps.haptic(intent);
    this.kick();
  }

  /** The current phase, read fresh (not narrowed across awaits and dispatches). */
  private phase(): CyclePhase | null {
    return this.state?.phase ?? null;
  }

  private blockIds(): BlockIds {
    return { blockId: this.deps.newId(), workoutId: this.deps.newId(), transitionId: this.deps.newId() };
  }

  /** The clock moved: ends a block or a rest, starts the next block after the countdown. */
  tick(): void {
    const ids = this.state?.phase === 'return' ? this.blockIds() : undefined;
    this.dispatch({ type: 'tick', at: this.deps.now(), ids });
  }

  start(plan: CyclePlanInput): void {
    if (this.state?.phase !== 'idle') return;
    this.dispatch({
      type: 'start',
      at: this.deps.now(),
      userId: this.userId,
      plan,
      ids: { sessionId: this.deps.newId(), ...this.blockIds() },
    });
  }

  /** "Just train": builds the circuit, then starts a move block on its own. False if it did not start. */
  async startMoveOnly(planInput: CyclePlanInput): Promise<boolean> {
    if (this.phase() !== 'idle' || this.busy || this.disposed) return false;
    this.busy = true;
    try {
      const plan = normalizePlan(planInput);
      const circuit = await this.buildCircuit(plan, circuitVariant(this.deps.now(), 1), null);
      if (this.phase() !== 'idle') return false;
      this.dispatch({
        type: 'start_move',
        at: this.deps.now(),
        userId: this.userId,
        plan,
        workoutId: this.deps.newId(),
        circuit,
      });
      return this.phase() === 'move';
    } finally {
      this.busy = false;
    }
  }

  pause(): void {
    this.dispatch({ type: 'pause', at: this.deps.now() });
  }

  resume(): void {
    this.dispatch({ type: 'resume', at: this.deps.now() });
  }

  endBlock(): void {
    this.dispatch({ type: 'end_block', at: this.deps.now() });
  }

  /** Logs the current set; anything not in `actual` is taken as the target (one tap on "Done"). */
  logSet(actual: SetActuals = {}): void {
    const state = this.state;
    if (state?.phase !== 'move') return;
    const index = state.position.itemIndex;
    const item = state.circuit.items[index];
    const progress = state.items[index];
    if (!item || !progress) return;
    const target = targetOf(item, progress.next);
    this.dispatch({
      type: 'log_set',
      at: this.deps.now(),
      setId: this.deps.newId(),
      done: actual.done ?? target ?? 0,
      weightLbs: actual.weightLbs !== undefined ? actual.weightLbs : progress.next.targetWeightLbs,
      rpe: actual.rpe ?? null,
      unit: this.context?.unit ?? 'lb',
      equipment: this.context?.byId.get(item.exerciseId)?.equipment ?? [],
      expectedSetIndex: actual.expectedSetIndex,
    });
  }

  skipRest(): void {
    this.dispatch({ type: 'skip_rest', at: this.deps.now() });
  }

  skipExercise(): void {
    const state = this.state;
    if (state?.phase !== 'move') return;
    this.dispatch({ type: 'skip_exercise', at: this.deps.now(), itemIndex: state.position.itemIndex });
  }

  /**
   * Swaps an item's exercise for `replacement` (from alternativesFor). Its targets are the defaults
   * for the new exercise, moved on from its own last session when there is one.
   */
  async swapExercise(itemIndex: number, replacement: LibraryExercise): Promise<void> {
    const state = this.state;
    if (state?.phase !== 'move' || this.busy) return;
    const item = state.circuit.items[itemIndex];
    if (!item) return;
    this.busy = true;
    try {
      const original = this.context?.byId.get(item.exerciseId) ?? null;
      const swapped = replaceItem(item, replacement, state.circuit.kind, original);
      const history = await this.history([swapped.exerciseId], state.workoutId);
      const single: Circuit = { ...state.circuit, items: [swapped] };
      const [advised] = applySessionAdvice(single, history, this.adviceContext()).items;
      this.dispatch({ type: 'swap', at: this.deps.now(), itemIndex, item: advised });
    } finally {
      this.busy = false;
    }
  }

  rateBlock(effort: number): void {
    this.dispatch({ type: 'rate_block', at: this.deps.now(), effort });
  }

  finishMove(): void {
    this.dispatch({ type: 'finish_move', at: this.deps.now() });
  }

  skipMove(): void {
    this.dispatch({ type: 'skip_move', at: this.deps.now() });
  }

  startNow(): void {
    if (this.state?.phase !== 'return') return;
    this.dispatch({ type: 'start_now', at: this.deps.now(), ids: this.blockIds() });
  }

  finish(): void {
    this.dispatch({ type: 'finish', at: this.deps.now() });
  }

  /**
   * Schedules the coming block-end alert again (call when notifications are allowed): a block started
   * while they were not allowed gets its alert now, and one Android dropped comes back. It keeps its
   * id, so this never adds a second alert.
   */
  rescheduleAlert(): void {
    this.dispatch({ type: 'reschedule_alert', at: this.deps.now() });
  }

  dismissSummary(): void {
    this.dispatch({ type: 'dismiss_summary' });
  }

  // -- Circuits -----------------------------------------------------------------------------

  private adviceContext(): { unit: Unit; byId: ReadonlyMap<string, LibraryExercise> } {
    return { unit: this.context?.unit ?? 'lb', byId: this.context?.byId ?? new Map<string, LibraryExercise>() };
  }

  private async history(exerciseIds: string[], excludeWorkoutId: string | null): Promise<Map<string, LoggedSet[]>> {
    try {
      return await this.deps.repo.lastSessionSetsFor(exerciseIds, { excludeWorkoutId });
    } catch {
      // No history is fine: the default targets apply.
      return new Map();
    }
  }

  private async buildCircuit(plan: CyclePlan, variant: number, excludeWorkoutId: string | null): Promise<Circuit> {
    let circuit: Circuit;
    try {
      circuit = buildCycleCircuit(plan, this.context?.library ?? [], variant);
    } catch {
      // Never leave the loop stuck: an empty circuit hands straight on to the next focus block.
      return {
        version: 1,
        source: 'default',
        kind: plan.moveKind,
        minutes: plan.moveMinutes,
        rounds: 1,
        items: [],
        estimatedSeconds: 0,
        location: plan.location,
        split: plan.split,
      };
    }
    const history = await this.history(
      circuit.items.map((item) => item.exerciseId),
      excludeWorkoutId,
    );
    return applySessionAdvice(circuit, history, this.adviceContext());
  }

  /** While a focus block runs without its circuit, builds it (once per block). */
  private prepareIfNeeded(): void {
    const state = this.state;
    if (!state || state.phase !== 'focus' || state.circuit !== null || !this.context || this.disposed) return;
    const { blockId } = state;
    if (this.preparing.has(blockId)) return;
    this.preparing.add(blockId);
    this.buildCircuit(state.plan, circuitVariant(state.cycleStartedAt, state.blockNumber), state.workoutId).then(
      (circuit) => this.dispatch({ type: 'circuit_ready', at: this.deps.now(), blockId, circuit }),
      () => this.preparing.delete(blockId),
    );
  }

  // -- Saving and effects -------------------------------------------------------------------

  /** Resolves once the latest state is saved (waits for a write in progress, then writes what is newer). */
  private async flush(): Promise<void> {
    for (;;) {
      if (this.writing) {
        await this.writing;
        continue;
      }
      if (!this.dirty || this.disposed || !this.state) return;
      this.dirty = false;
      const snapshot = this.state;
      this.writing = this.deps.writeState(snapshot).then(
        () => {
          this.writing = null;
          this.savedOk();
        },
        (error: unknown) => {
          this.writing = null;
          this.dirty = true;
          throw error;
        },
      );
    }
  }

  /** A save went through: with nothing left to save or perform, a save problem shown earlier is over. */
  private savedOk(): void {
    if (this.dirty || (this.state?.pending.length ?? 0) > 0) return;
    this.failures = 0;
    if (this.error === CYCLE_SAVE_ERROR) this.setError(null);
  }

  private kick(): void {
    if (this.disposed) return;
    if (!this.state) {
      void this.load();
      return;
    }
    if (!this.running) this.effectsRun = this.runEffects();
    this.prepareIfNeeded();
  }

  private async runEffects(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const effect = this.state?.pending[0];
        if (!effect) break;
        try {
          // The state holding this effect must be on disk before the effect runs (see the header).
          await this.flush();
          if (this.disposed) return;
          await this.perform(effect);
        } catch (error) {
          if (!(error instanceof RangeError)) {
            this.retryLater(CYCLE_SAVE_ERROR);
            return;
          }
          // Invalid input can never be written: drop it rather than block every later write.
          this.setError(`A change was not saved: ${error.message}`);
          this.dispatch({ type: 'effect_done', effectId: effect.id });
          continue;
        }
        if (this.failures > 0 || this.error === CYCLE_SAVE_ERROR) {
          this.failures = 0;
          this.setError(null);
        }
        this.dispatch({ type: 'effect_done', effectId: effect.id });
      }
    } finally {
      this.running = false;
    }
  }

  private async perform(effect: CycleEffect): Promise<void> {
    const { repo } = this.deps;
    switch (effect.kind) {
      case 'start_focus_block':
        return repo.startFocusBlock(effect.input);
      case 'end_focus_block':
        await repo.endFocusBlock(effect.blockId, effect.endedAt, effect.interrupted, effect.at);
        if (effect.studyPlanId) this.studyBlockEnded();
        return;
      case 'rate_block':
        return repo.rateBlock(effect.blockId, effect.effort, effect.at);
      case 'start_move_block':
        return repo.startMoveBlock(effect.input);
      case 'log_set':
        return repo.logSet(effect.input);
      case 'finish_move_block':
        return repo.finishMoveBlock(effect.workoutId, effect.durationMinutes, effect.at);
      case 'skip_move_block':
        return repo.skipMoveBlock(effect.workoutId, effect.transitionId, effect.at);
      case 'schedule_block_end':
        await this.deps.scheduleBlockEnd(effect.endsAt, {
          title: effect.title,
          body: effect.body,
          identifier: effect.notificationId,
        });
        return;
      case 'cancel_notification':
        return this.deps.cancelScheduled(effect.notificationId);
    }
  }

  /** Tells the deps a study block is over (see CycleStoreDeps.studyBlockEnded). Never throws. */
  private studyBlockEnded(): void {
    if (this.disposed || this.stopping) return;
    try {
      this.deps.studyBlockEnded?.(this.userId);
    } catch {
      // A reminder that could not be rescheduled must never hold up the cycle.
    }
  }

  /** Schedules one retry (a failure noticed twice, by the save and by the runner, waits for the same one). */
  private retryLater(message: string): void {
    if (this.disposed) return;
    this.setError(message);
    if (this.retryHandle !== null) return;
    this.failures += 1;
    const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** (this.failures - 1));
    this.retryHandle = this.deps.setTimeout(() => {
      this.retryHandle = null;
      if (this.dirty && !this.writing) this.flush().catch(() => this.retryLater(CYCLE_SAVE_ERROR));
      this.kick();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) this.deps.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private setError(error: string | null): void {
    if (this.error === error) return;
    this.error = error;
    this.publish();
  }

  private publish(): void {
    this.snapshot = { state: this.state, error: this.error };
    for (const listener of [...this.listeners]) listener();
  }
}
