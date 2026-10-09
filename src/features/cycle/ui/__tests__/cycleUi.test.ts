import { describe, expect, it } from '@jest/globals';

import { SETUP_TEMPLATES } from '@/features/training/equipment';
import { LB_PER_KG } from '@/features/training/units';

import { currentStation, type CycleSummary, type MoveState } from '../../cycleMachine';
import {
  adviceTone,
  amountLabel,
  minutesLeftLabel,
  moveLabel,
  previewLine,
  restLabel,
  runningTotals,
  spokenTarget,
  stationProgressLabel,
  summarySentence,
  summaryStats,
  summaryTitle,
  targetLabel,
  wholeMinutesLeft,
} from '../cycleText';
import { focusRingSize, FOCUS_RING_MAX, ringStroke } from '../FocusDial';
import { endMorph, HANDOFF_WINDOW_MS, NO_HANDOFF, trackHandoff, type HandoffTrack } from '../handoff';
import { MOVE_LENGTH_OPTIONS, placeOf, planFromChoices, QUICK_SETUPS, type StartChoices } from '../startPlan';
import { describeAlternative } from '../SwapPanel';
import {
  after,
  circuitFor,
  endsAt,
  finishedState,
  focusState,
  HOME_PLAN,
  MIN,
  moveAfter,
  moveOnlyState,
  returnState,
  T0,
} from '../testing/cycleFixtures';

describe('cycleText', () => {
  it('says what a set aims for', () => {
    expect(amountLabel(10, 'reps')).toBe('10 reps');
    expect(amountLabel(1, 'reps')).toBe('1 rep');
    expect(amountLabel(40, 'time')).toBe('40 s');
    expect(amountLabel(null, 'reps')).toBe('No set target');
    expect(amountLabel(Number.NaN, 'time')).toBe('No set target');
    expect(targetLabel(10, 'reps', 25, 'lb')).toBe('10 reps · 25 lb');
    expect(targetLabel(8, 'reps', 20 * LB_PER_KG, 'kg')).toBe('8 reps · 20 kg');
    expect(targetLabel(40, 'time', null, 'lb')).toBe('40 s');
    expect(targetLabel(12, 'reps', 0, 'lb')).toBe('12 reps');
    expect(spokenTarget(10, 'reps', 25, 'lb')).toBe('10 reps at 25 lb');
    expect(spokenTarget(40, 'time', null, 'kg')).toBe('40 s');
  });

  it('previews the move block, with the first exercise once the circuit is ready', () => {
    const plan = { moveKind: 'micro' as const, moveMinutes: 10, location: 'home' as const };
    expect(moveLabel(plan)).toBe('10-min home circuit');
    expect(moveLabel({ moveKind: 'full', moveMinutes: 45, location: 'gym' })).toBe('45-min gym session');
    expect(previewLine(plan, null)).toBe('Next: 10-min home circuit');
    expect(previewLine(plan, { items: [] })).toBe('Next: 10-min home circuit');
    const circuit = circuitFor();
    expect(previewLine(plan, circuit)).toBe(`Next: 10-min home circuit · ${circuit.items[0].name} first`);
  });

  it('counts whole minutes the way the clock shows them, for one announcement a minute', () => {
    expect(wholeMinutesLeft(25 * MIN)).toBe(25);
    expect(wholeMinutesLeft(25 * MIN - 1)).toBe(25); // the clock still reads 25:00
    expect(wholeMinutesLeft(24 * MIN + 59_001)).toBe(25);
    expect(wholeMinutesLeft(24 * MIN + 59_000)).toBe(24); // 24:59
    expect(wholeMinutesLeft(-5)).toBe(0);
    expect(wholeMinutesLeft(Number.NaN)).toBe(0);
    expect(minutesLeftLabel(12 * MIN)).toBe('12 minutes left');
    expect(minutesLeftLabel(MIN + 500)).toBe('1 minute left');
    expect(minutesLeftLabel(30_000)).toBe('Less than a minute left');
    expect(restLabel(45_000)).toBe('Rest 0:45');
  });

  it('says where the user is in a micro circuit and in a full session', () => {
    const micro = moveAfter(focusState());
    const station = currentStation(micro)!;
    expect(stationProgressLabel(station, 'micro', micro.circuit.items.length)).toBe(
      `Round 1 of ${micro.circuit.rounds} · Exercise 1 of ${micro.circuit.items.length}`,
    );
    expect(stationProgressLabel({ ...station, setNumber: 2, plannedSets: 3 }, 'full', 5)).toBe('Set 2 of 3 · Exercise 1 of 5');
    expect(stationProgressLabel({ ...station, restPause: true }, 'full', 5)).toBe('Rest-pause set · Exercise 1 of 5');
  });

  it('colors the spotter by what it said', () => {
    expect(adviceTone('continue')).toBe('success');
    expect(adviceTone('cut_set')).toBe('warning');
    for (const action of ['extend_rest', 'drop_weight', 'lower_target', 'rest_pause'] as const) {
      expect(adviceTone(action)).toBe('info');
    }
  });

  it('sums up a study cycle and a "Just train" workout', () => {
    const study: CycleSummary = {
      mode: 'study',
      blocks: 2,
      focusMs: 49.6 * MIN,
      moveBlocks: 2,
      sets: 18,
      startedAt: T0,
      finishedAt: T0 + 80 * MIN,
    };
    expect(summaryStats(study)).toEqual([
      { value: 2, label: 'focus blocks' },
      { value: 50, label: 'focus minutes' },
      { value: 18, label: 'sets' },
    ]);
    expect(summarySentence(study)).toBe('2 focus blocks, 50 focus minutes, 18 sets.');
    expect(summaryTitle(study)).toBe('Nice work');
    expect(summaryTitle({ ...study, blocks: 0, sets: 0 })).toBe('Cycle ended');
    const train: CycleSummary = { ...study, mode: 'move_only', blocks: 0, focusMs: 0, sets: 1, finishedAt: T0 + 12.4 * MIN };
    expect(summaryStats(train)).toEqual([
      { value: 1, label: 'set' },
      { value: 12, label: 'minutes' },
    ]);
    expect(summaryTitle(train)).toBe('Workout done');
    expect(summaryTitle({ ...train, sets: 0 })).toBe('Workout ended');
    expect(runningTotals({ blocks: 1, focusMs: 25 * MIN, sets: 1 })).toBe('1 focus block · 25 min · 1 set');
    expect(finishedState().summary).not.toBeNull();
  });
});

describe('trackHandoff', () => {
  const focus = focusState();
  const end = endsAt(focus);
  const move = moveAfter(focus);

  /** The track after rendering each [state, now] in turn. */
  function follow(...renders: [Parameters<typeof trackHandoff>[1], number][]): HandoffTrack {
    return renders.reduce((track, [state, now]) => trackHandoff(track, state, now), NO_HANDOFF);
  }

  it('morphs when the block ran out on screen', () => {
    const track = follow([focus, end - 1_000], [move, end]);
    expect(track).toEqual({ sighting: null, morph: move.workoutId });
    // Further renders of the same move block keep the morph until it is over, then never replay it.
    expect(trackHandoff(track, move, end + 1_000)).toBe(track);
    const over = endMorph(track, move.workoutId);
    expect(over.morph).toBeNull();
    expect(trackHandoff(over, move, end + 2_000)).toBe(over);
    expect(endMorph(over, move.workoutId)).toBe(over);
  });

  it('morphs when the user ends the block early (also while paused)', () => {
    const at = T0 + 5 * MIN;
    const early = after(focus, { type: 'end_block', at }) as MoveState;
    expect(early.phase).toBe('move');
    expect(follow([focus, at], [early, at]).morph).toBe(early.workoutId);
    const paused = after(focus, { type: 'pause', at });
    const ended = after(paused, { type: 'end_block', at: at + 30_000 });
    expect(follow([paused, at + 29_000], [ended, at + 30_000]).morph).not.toBeNull();
  });

  it('shows the card directly when the block ended while nobody was looking', () => {
    // The app comes back long after the end: the last live sighting is far behind the clock.
    expect(follow([focus, T0 + 10 * MIN], [move, end + 20 * MIN]).morph).toBeNull();
    // Just outside the window.
    expect(follow([focus, end - 1], [move, end - 1 + HANDOFF_WINDOW_MS + 1]).morph).toBeNull();
    // Cold start: the saved block is already over when first rendered, then hands off.
    expect(follow([null, end + MIN], [focus, end + MIN], [move, end + MIN]).morph).toBeNull();
    // Opened straight into the move block.
    expect(follow([move, end + MIN]).morph).toBeNull();
  });

  it('only morphs the move block of the block that was seen', () => {
    const other = moveAfter(focusState());
    expect(follow([focus, end - 500], [other, end]).morph).toBeNull();
    expect(follow([moveOnlyState(), T0]).morph).toBeNull();
  });

  it('returns the same object when nothing changed', () => {
    const seen = trackHandoff(NO_HANDOFF, focus, T0 + MIN);
    expect(trackHandoff(seen, focus, T0 + MIN)).toBe(seen);
    expect(trackHandoff(seen, null, T0 + MIN)).toBe(seen);
    expect(trackHandoff(NO_HANDOFF, returnState(), T0)).toBe(NO_HANDOFF);
    expect(trackHandoff(seen, returnState(), T0)).toBe(NO_HANDOFF);
    // The block ended without a live render: the old sighting is kept as it was.
    expect(trackHandoff(seen, focus, end + 1)).toBe(seen);
  });
});

describe('startPlan', () => {
  const base: StartChoices = {
    focusSubject: '  Biology  ',
    blockMinutes: 30,
    preset: { id: 'preset-1', split: { lower: 70, upper: 15, core: 15, cardio: 0 } },
    setup: { id: 'setup-1', location: 'gym', equipment: ['barbell', 'rack'] },
    quick: null,
    moveLength: '10',
    fullMinutes: 45,
  };

  it('makes the plan from the choices', () => {
    expect(planFromChoices(base)).toEqual({
      focusSubject: 'Biology',
      blockMinutes: 30,
      presetId: 'preset-1',
      split: { lower: 70, upper: 15, core: 15, cardio: 0 },
      setupId: 'setup-1',
      location: 'gym',
      equipment: ['barbell', 'rack'],
      moveKind: 'micro',
      moveMinutes: 10,
    });
    expect(planFromChoices({ ...base, moveLength: 'full', fullMinutes: 60 })).toMatchObject({ moveKind: 'full', moveMinutes: 60 });
    expect(planFromChoices({ ...base, moveLength: '5' })).toMatchObject({ moveKind: 'micro', moveMinutes: 5 });
  });

  it('needs a setup or a one-tap choice', () => {
    expect(planFromChoices({ ...base, setup: null })).toBeNull();
    expect(placeOf({ setup: null, quick: { template: 'home_bodyweight', setupId: null } })).toEqual({
      setupId: null,
      location: 'home',
      equipment: [],
    });
    expect(planFromChoices({ ...base, setup: null, quick: { template: 'gym', setupId: 'new-1' } })).toMatchObject({
      setupId: 'new-1',
      location: 'gym',
      equipment: SETUP_TEMPLATES.gym.equipment,
    });
    // A saved setup wins over the one-tap choice that made it.
    expect(placeOf({ setup: base.setup, quick: { template: 'home_bodyweight', setupId: 'x' } })?.setupId).toBe('setup-1');
  });

  it('offers 5, 10 and 15 minutes or a full session', () => {
    expect(MOVE_LENGTH_OPTIONS.map((option) => option.value)).toEqual(['5', '10', '15', 'full']);
  });

  it('offers the two one-tap setups, named as on the Setups screen', () => {
    expect(QUICK_SETUPS.map((choice) => [choice.template, choice.label])).toEqual([
      ['home_bodyweight', 'Home, just my body'],
      ['gym', 'Gym'],
    ]);
  });

  it('the home plan used by the screen tests starts', () => {
    expect(focusState({ plan: HOME_PLAN }).circuit?.items.length).toBeGreaterThan(0);
  });
});

describe('screen helpers', () => {
  it('sizes the ring to the window', () => {
    expect(focusRingSize(390)).toBe(FOCUS_RING_MAX);
    expect(focusRingSize(320)).toBe(240);
    expect(focusRingSize(100)).toBe(160);
    expect(focusRingSize(Number.NaN)).toBe(FOCUS_RING_MAX);
    expect(ringStroke(280)).toBe(14);
    expect(ringStroke(100)).toBe(8);
  });

  it('describes a swap alternative', () => {
    expect(describeAlternative({ movementPattern: 'squat', equipment: ['bodyweight'] })).toBe('Squat · Just your body');
    expect(describeAlternative({ movementPattern: 'horizontal_pull', equipment: ['dumbbell', 'bench'] })).toBe(
      'Row · Dumbbells, Bench',
    );
    expect(describeAlternative({ movementPattern: null, equipment: ['mystery'] })).toBe('mystery');
  });
});
