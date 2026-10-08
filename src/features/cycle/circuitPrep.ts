/**
 * Preparing the move block while the focus block runs: the default circuit for the cycle's plan
 * (circuits.ts), with each exercise's targets moved on from its last session by the spotter
 * (adviseNextSession: raise, hold or lower, never more than +5% load). Pure; the store reads the
 * history (cycleRepo.lastSessionSetsFor) and passes it in.
 */
import { buildDefaultCircuit, estimateCircuitSeconds } from '@/features/training/circuits';
import { adviseNextSession, type LoggedSet } from '@/features/training/spotter';
import type { Circuit, LibraryExercise, Unit } from '@/features/training/types';

import type { CyclePlan } from './cycleMachine';

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 in the phone's time zone (so a "day" turns over at local midnight). */
export function localDayNumber(at: number): number {
  const offsetMs = new Date(at).getTimezoneOffset() * 60_000;
  return Math.floor((at - offsetMs) / DAY_MS);
}

/**
 * The circuit builder's `variant` for a block: the local day number plus the block's number in the
 * cycle, so the circuits change from one move block to the next and from day to day, and the same
 * block of the same day always gets the same circuit (e.g. after a restart).
 */
export function circuitVariant(at: number, blockNumber: number): number {
  return localDayNumber(at) + Math.max(0, Math.floor(blockNumber) - 1);
}

/** The default circuit for the plan, from the exercises default circuits may use (useLibrary().circuitPool). */
export function buildCycleCircuit(plan: CyclePlan, library: readonly LibraryExercise[], variant: number): Circuit {
  return buildDefaultCircuit({
    split: plan.split,
    location: plan.location,
    equipment: plan.equipment,
    minutes: plan.moveMinutes,
    kind: plan.moveKind,
    library,
    variant,
  });
}

export type SessionAdviceContext = {
  unit: Unit;
  /** The library by id, for each exercise's equipment (its load steps). */
  byId: ReadonlyMap<string, Pick<LibraryExercise, 'equipment'>>;
};

/**
 * The circuit with each item's targets taken from adviseNextSession on its last session's sets
 * (oldest first). Items with no history, or none the spotter can judge, keep the default targets.
 * Returns the same circuit object when nothing changed.
 */
export function applySessionAdvice(
  circuit: Circuit,
  history: ReadonlyMap<string, readonly LoggedSet[]>,
  context: SessionAdviceContext,
): Circuit {
  let changed = false;
  const items = circuit.items.map((item) => {
    const sets = history.get(item.exerciseId);
    if (!sets || sets.length === 0) return item;
    const advice = adviseNextSession(sets, {
      measure: item.measure,
      unit: context.unit,
      equipment: context.byId.get(item.exerciseId)?.equipment ?? [],
    });
    if (!advice) return item;
    changed = true;
    return {
      ...item,
      targetReps: item.measure === 'reps' ? (advice.targetReps ?? item.targetReps) : null,
      targetSeconds: item.measure === 'time' ? (advice.targetSeconds ?? item.targetSeconds) : null,
      targetWeightLbs: advice.targetWeightLbs,
    };
  });
  return changed ? { ...circuit, items, estimatedSeconds: estimateCircuitSeconds(items) } : circuit;
}
