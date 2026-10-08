import { useQuery } from '@powersync/react-native';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import { cancelAllAlerts, cancelScheduled, registerVisibleTimer, scheduleBlockEnd } from '@/features/timer/notifications';
import type { LibraryExercise, Unit } from '@/features/training/types';
import { useLibrary } from '@/features/training/useLibrary';
import { newId } from '@/lib/ids';
import { haptic } from '@/theme';

import { CYCLE_STATE_KEY, type CyclePlanInput, type CycleState } from './cycleMachine';
import {
  endFocusBlock,
  finishMoveBlock,
  lastSessionSetsFor,
  logSet,
  rateBlock,
  skipMoveBlock,
  startFocusBlock,
  startMoveBlock,
} from './cycleRepo';
import { CycleStore, type CycleSnapshot, type CycleStoreDeps, type SetActuals } from './cycleStore';
import { readLocalState, writeLocalState } from './localState';

/** The real I/O: local_state, the repo, notifications, haptics, the clock and device ids. */
export function defaultCycleStoreDeps(): CycleStoreDeps {
  return {
    readState: () => readLocalState(CYCLE_STATE_KEY),
    writeState: (state) => writeLocalState(CYCLE_STATE_KEY, state),
    repo: {
      startFocusBlock,
      endFocusBlock,
      rateBlock,
      startMoveBlock,
      logSet,
      finishMoveBlock,
      skipMoveBlock,
      lastSessionSetsFor,
    },
    scheduleBlockEnd: (endsAtMs, content) => scheduleBlockEnd(endsAtMs, content),
    cancelScheduled,
    haptic,
    now: () => Date.now(),
    newId,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

let shared: CycleStore | null = null;

/**
 * The one store for this user. Every useCycle shares it, so effects run once however many screens
 * (or development double mounts) use the hook. Another user gets a new store; the old one stops.
 */
export function cycleStoreFor(userId: string, makeDeps: () => CycleStoreDeps = defaultCycleStoreDeps): CycleStore {
  if (shared && shared.userId === userId && !shared.isDisposed) return shared;
  shared?.dispose();
  shared = new CycleStore(userId, makeDeps());
  return shared;
}

/** Stops the shared store at once (the user is gone). For an explicit sign-out use stopCycleForSignOut. */
export function resetCycleStore(): void {
  shared?.dispose();
  shared = null;
}

/**
 * Sign-out: stops the shared store and waits for its save or write in progress, then withdraws every
 * alert. Call before AuthProvider.signOut() clears the local database: no write of this account may
 * land after the clear, and no block-end alert may ring (or open the cycle screen) for an account
 * that is signed out. The store runs whether or not the cycle screen is open, so the screen's own
 * sign-out handling is not enough. Never throws.
 */
export async function stopCycleForSignOut(): Promise<void> {
  const store = shared;
  shared = null;
  await store?.stop();
  await cancelAllAlerts();
}

export type UseCycleResult = {
  /** null while the saved cycle is being read. */
  state: CycleState | null;
  loading: boolean;
  /** A plain-words saving problem (the store keeps retrying), or null. */
  error: string | null;
  /** The clock for rendering timers (timerMath with `now`); updated every second while the app is open. */
  now: number;
  /** The profile's unit for showing and adjusting weights. */
  unit: Unit;
  start(plan: CyclePlanInput): void;
  /** "Just train": resolves to false when it did not start (already running, nothing fits). */
  startMoveOnly(plan: CyclePlanInput): Promise<boolean>;
  pause(): void;
  resume(): void;
  /** End the focus block early (recorded as interrupted) and go to the move block. */
  endBlock(): void;
  /** "Done": logs the current set; pass what changed from the target (reps/seconds, weight, effort). */
  logSet(actual?: SetActuals): void;
  skipRest(): void;
  skipExercise(): void;
  swapExercise(itemIndex: number, replacement: LibraryExercise): Promise<void>;
  rateBlock(effort: number): void;
  finishMove(): void;
  skipMove(): void;
  startNow(): void;
  finish(): void;
  dismissSummary(): void;
};

const NO_SNAPSHOT: CycleSnapshot = { state: null, error: null };
const noSubscribe = () => () => undefined;
const noSnapshot = () => NO_SNAPSHOT;

/**
 * The cycle for the screen: the machine state (loaded from local_state, saved on every change), the
 * actions, and a clock. While the app is open it ticks once a second (and at once when the app comes
 * back to the foreground), so a block that ended while the phone was locked, or while the app was
 * killed, hands off as soon as the user is back. Must be used under `PowerSyncContext.Provider` and
 * `AuthProvider`.
 */
export function useCycle(): UseCycleResult {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { circuitPool, byId } = useLibrary();
  const { data: profile } = useQuery<{ unit_pref: string | null }>(
    `SELECT unit_pref FROM ${TABLE.profiles} WHERE id = ?`,
    [userId ?? ''],
  );
  const unit: Unit = profile[0]?.unit_pref === 'kg' ? 'kg' : 'lb';

  const store = useMemo(() => (userId ? cycleStoreFor(userId) : null), [userId]);
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!userId) resetCycleStore();
  }, [userId]);

  useEffect(() => {
    store?.setContext({ library: circuitPool, byId, unit });
  }, [store, circuitPool, byId, unit]);

  useEffect(() => {
    if (!store) return;
    void store.load();
    const release = registerVisibleTimer();
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      setNow(Date.now());
      store.tick();
    };
    const startTicking = () => {
      if (interval !== null) return;
      tick();
      interval = setInterval(tick, 1000);
    };
    const stopTicking = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };
    if (AppState.currentState !== 'background') startTicking();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') startTicking();
      else stopTicking();
    });
    return () => {
      subscription.remove();
      stopTicking();
      release();
    };
  }, [store]);

  const actions = useMemo(
    () => ({
      start: (plan: CyclePlanInput) => store?.start(plan),
      startMoveOnly: async (plan: CyclePlanInput) => (store ? store.startMoveOnly(plan) : false),
      pause: () => store?.pause(),
      resume: () => store?.resume(),
      endBlock: () => store?.endBlock(),
      logSet: (actual?: SetActuals) => store?.logSet(actual),
      skipRest: () => store?.skipRest(),
      skipExercise: () => store?.skipExercise(),
      swapExercise: async (itemIndex: number, replacement: LibraryExercise) => {
        await store?.swapExercise(itemIndex, replacement);
      },
      rateBlock: (effort: number) => store?.rateBlock(effort),
      finishMove: () => store?.finishMove(),
      skipMove: () => store?.skipMove(),
      startNow: () => store?.startNow(),
      finish: () => store?.finish(),
      dismissSummary: () => store?.dismissSummary(),
    }),
    [store],
  );

  return { state: snapshot.state, loading: snapshot.state === null, error: snapshot.error, now, unit, ...actions };
}
