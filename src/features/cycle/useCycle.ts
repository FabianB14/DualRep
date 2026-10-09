import { useQuery } from '@powersync/react-native';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import {
  cancelAllAlerts,
  cancelScheduled,
  getNotificationPermission,
  registerVisibleTimer,
  scheduleBlockEnd,
} from '@/features/timer/notifications';
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

/**
 * After a block that quizzed from a study plan: the daily review reminder is rescheduled with this
 * phone's setting (Phase 2: "rescheduled on app start / foreground / block end / sync"). The study
 * engine is loaded on demand, as ProgressRing loads Reanimated, so this module (which Settings also
 * imports, for sign-out) does not pull it and its database and notification modules in at import:
 * the screens that study have loaded it anyway, and the tests of the store and of Settings, which
 * replace only the cycle's own I/O, keep working without it. Never throws.
 */
export function rescheduleReviewsAfterStudyBlock(userId: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const study = require('../study/hooks') as typeof import('../study/hooks');
    study.rescheduleReviewReminderNow(userId).catch(() => undefined);
  } catch {
    // No reminder this time; the next app start or foreground reschedules it.
  }
}

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
    studyBlockEnded: rescheduleReviewsAfterStudyBlock,
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
 * Sign-out: finishes a running cycle (as "Finish" would, after catching up with the clock), so its
 * focus block, workout and transition are closed instead of left open on the server for good; waits
 * for those writes, and any closing write still waiting from before, to land on the phone; stops the
 * store; then withdraws every alert. Call before AuthProvider.signOut() clears the
 * local database (and give the upload queue a moment first, so the closing writes reach the server):
 * no write of this account may land after the clear, and no block-end alert may ring (or open the
 * cycle screen) for an account that is signed out. The cycle may be saved on the phone without its
 * screen ever having been opened since launch, so the user's store is loaded here if need be. Never
 * throws.
 */
export async function stopCycleForSignOut(
  userId: string | null,
  makeDeps: () => CycleStoreDeps = defaultCycleStoreDeps,
): Promise<void> {
  const store = userId ? cycleStoreFor(userId, makeDeps) : shared;
  shared = null;
  await store?.finishAndStop();
  await cancelAllAlerts();
}

/**
 * Notifications were just allowed (Settings): schedules the running block's end alert, which could
 * not be scheduled while they were off. The cycle screen does the same whenever it opens or the app
 * comes back; this covers turning them on from Settings and going back to Home. Never throws.
 */
export async function rescheduleCycleAlert(
  userId: string | null,
  makeDeps: () => CycleStoreDeps = defaultCycleStoreDeps,
): Promise<void> {
  if (!userId) return;
  const store = cycleStoreFor(userId, makeDeps);
  await store.load();
  store.rescheduleAlert();
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
 * killed, hands off as soon as the user is back. Each time the screen opens or the app comes back,
 * if notifications are allowed, the coming block-end alert is scheduled again: a block started
 * while they were off (or before the user turned them on in Settings) then still rings. Must be used
 * under `PowerSyncContext.Provider` and `AuthProvider`.
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
    let mounted = true;
    const reschedule = () => {
      void getNotificationPermission().then((permission) => {
        if (mounted && permission === 'granted') store.rescheduleAlert();
      });
    };
    void store.load().then(reschedule);
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
      if (status === 'active') {
        startTicking();
        reschedule();
      } else {
        stopTicking();
      }
    });
    return () => {
      mounted = false;
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
