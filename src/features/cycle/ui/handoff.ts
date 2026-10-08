/**
 * When the screen plays the handoff morph (the focus ring turning into the first exercise card).
 *
 * The morph shows a change the user is watching. It plays when the screen saw the focus block live
 * (running or paused, not yet ended) a moment before the move block for that same block appeared:
 * the timer reached zero on screen, or the user tapped "End block early". It does not play when the
 * block ended while nobody was looking (the phone locked, the app in the background or killed): the
 * screen then opens straight on the exercise card, with no replayed animation.
 *
 * "A moment" is HANDOFF_WINDOW_MS of the cycle clock. The clock ticks once a second while the app is
 * open and jumps to the real time when the app comes back to the foreground, so a block that ended
 * in the background is always further away than the window.
 *
 * Pure: the screen keeps a HandoffTrack in state and moves it on with trackHandoff on every render
 * (the same object back when nothing changed, so it can be compared by identity).
 */
import { isDone } from '@/features/timer/timerMath';

import type { CycleState } from '../cycleMachine';

/** How recently the focus block must have been seen live for its end to be animated. */
export const HANDOFF_WINDOW_MS = 3_000;

export type HandoffTrack = {
  /** The focus block last seen running or paused on screen, and the clock then. */
  sighting: { blockId: string; at: number } | null;
  /** The workout whose card is morphing in, until the morph is over. */
  morph: string | null;
};

export const NO_HANDOFF: HandoffTrack = { sighting: null, morph: null };

/** The track after rendering `state` at clock `now`. Returns `prev` itself when nothing changed. */
export function trackHandoff(prev: HandoffTrack, state: CycleState | null, now: number): HandoffTrack {
  if (state === null) return prev;
  if (state.phase === 'focus') {
    const live = state.endedAt === null && !isDone(state.timer, now);
    // A block that ended without being seen live (a restart after the end) keeps no sighting.
    if (!live) return prev;
    if (prev.morph === null && prev.sighting?.blockId === state.blockId && prev.sighting.at === now) return prev;
    return { sighting: { blockId: state.blockId, at: now }, morph: null };
  }
  if (state.phase === 'move') {
    if (prev.morph === state.workoutId) return prev;
    const seen = prev.sighting;
    if (seen && state.blockId === seen.blockId && now >= seen.at && now - seen.at <= HANDOFF_WINDOW_MS) {
      return { sighting: null, morph: state.workoutId };
    }
    return seen === null ? prev : { sighting: null, morph: prev.morph };
  }
  return prev.sighting === null && prev.morph === null ? prev : NO_HANDOFF;
}

/** The track once the morph for `workoutId` has finished (the card is simply shown from then on). */
export function endMorph(prev: HandoffTrack, workoutId: string): HandoffTrack {
  return prev.morph === workoutId ? { ...prev, morph: null } : prev;
}
