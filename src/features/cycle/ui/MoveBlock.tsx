import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';

import { Button, Chip, Notice, Screen, Stepper, Text } from '@/components';
import { formatClock, isDone, remainingMs } from '@/features/timer/timerMath';
import { isBodyweightOnly } from '@/features/training/circuits';
import { alternativesFor } from '@/features/training/swap';
import type { LibraryExercise, Unit } from '@/features/training/types';
import { formatWeight, fromLbs, loadIncrement, toLbs } from '@/features/training/units';
import { useLibrary } from '@/features/training/useLibrary';
import { useTheme } from '@/theme';

import { currentStation, type MoveState } from '../cycleMachine';
import type { SetActuals } from '../cycleStore';
import { BlockRating } from './BlockRating';
import { adviceTone, restLabel, spokenTarget, stationProgressLabel } from './cycleText';
import { ExerciseCard } from './ExerciseCard';
import type { WindowFrame } from './FocusDial';
import { HandoffFade, HandoffMorph } from './HandoffMorph';
import { SpotterNote } from './SpotterNote';
import { SwapPanel } from './SwapPanel';
import { TopBar } from './TopBar';

/** The optional effort chips under the set: what each one logs as RPE. */
export const EFFORT_CHIPS: readonly { rpe: number; label: string }[] = [
  { rpe: 6, label: 'Easy' },
  { rpe: 8, label: 'Solid' },
  { rpe: 10, label: 'All out' },
];

/** How far the −/+ buttons go. */
const LIMITS = {
  reps: { min: 0, max: 100, step: 1 },
  seconds: { min: 0, max: 600, step: 5 },
  weight: { lb: 1500, kg: 700 },
} as const;

/** At most this many swap alternatives are offered. */
const SWAP_CHOICES = 5;

export type MoveActions = {
  logSet(actual?: SetActuals): void;
  skipRest(): void;
  skipExercise(): void;
  swapExercise(itemIndex: number, replacement: LibraryExercise): Promise<void>;
  rateBlock(effort: number): void;
  finishMove(): void;
  skipMove(): void;
  finish(): void;
};

export type MoveBlockProps = {
  state: MoveState;
  now: number;
  unit: Unit;
  error: string | null;
  /** Play the handoff morph (the focus block just ended on screen). */
  handoff: boolean;
  /** Where the focus ring was, for the morph. */
  ringFrame: WindowFrame | null;
  onHandoffDone(): void;
  actions: MoveActions;
};

/** What the user changed for the set on screen; `key` names that set, so a new set starts clean. */
type SetDraft = {
  key: string;
  /** Reps (or seconds) done; null = the target. */
  done: number | null;
  /** Pounds; undefined = the target, null = no weight. */
  weightLbs: number | null | undefined;
  rpe: number | null;
  swapOpen: boolean;
};

function freshDraft(key: string): SetDraft {
  return { key, done: null, weightLbs: undefined, rpe: null, swapOpen: false };
}

/**
 * The move block: the current exercise card and the one-tap set logger. "Done" logs the set as the
 * target; the −/+ buttons and the effort chips change it first if needed. After each set the
 * spotter's note and the rest countdown (skippable) show; "Swap" and "Skip" handle an exercise that
 * does not suit today. The effort rating for the focus block just finished sits at the bottom and
 * blocks nothing.
 *
 * The screen stays awake for the whole move block (docs/ANDROID.md 1.4), and only then: this is the
 * only component that calls useKeepAwake, and it unmounts when the move block ends.
 */
export function MoveBlock({ state, now, unit, error, handoff, ringFrame, onHandoffDone, actions }: MoveBlockProps) {
  useKeepAwake();
  const { space } = useTheme();
  const { byId, circuitPool } = useLibrary();
  const station = currentStation(state);
  const { circuit } = state;
  const exercise = station ? (byId.get(station.item.exerciseId) ?? null) : null;

  const setKey = station ? `${state.setsLogged}:${station.index}:${station.item.exerciseId}` : 'none';
  const [stored, setDraft] = useState<SetDraft>(() => freshDraft(setKey));
  // A new set (logged, skipped, swapped): the adjustments of the last one do not carry over.
  if (stored.key !== setKey) setDraft(freshDraft(setKey));
  const draft = stored.key === setKey ? stored : freshDraft(setKey);
  const change = (patch: Partial<SetDraft>) => setDraft((prev) => ({ ...(prev.key === setKey ? prev : freshDraft(setKey)), ...patch }));

  // Only while the swap list is open (a few dozen exercises: cheap enough to rank on each render).
  const alternatives =
    station && draft.swapOpen
      ? alternativesFor(station.item, { location: state.plan.location, equipment: state.plan.equipment }, circuitPool, {
          kind: circuit.kind,
          exclude: circuit.items.map((item) => item.exerciseId),
          limit: SWAP_CHOICES,
        })
      : [];

  // Screen-reader users hear the handoff they cannot see: what to do first.
  const firstTarget = station ? spokenTarget(station.target, station.item.measure, station.targetWeightLbs, unit) : null;
  const firstName = station?.item.name ?? null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || announced.current === state.workoutId || firstName === null) return;
    announced.current = state.workoutId;
    AccessibilityInfo.announceForAccessibility(`Focus block done. Time to move: ${firstName}, ${firstTarget}.`);
  }, [handoff, state.workoutId, firstName, firstTarget]);

  const resting = state.rest !== null && !isDone(state.rest, now);
  const studying = state.mode === 'study';
  const endLabel = state.setsLogged === 0 ? 'Skip workout' : 'End workout';
  const endHint = studying ? 'Goes on to the countdown for your next focus block' : 'Ends this workout';
  const end = state.setsLogged === 0 ? actions.skipMove : actions.finishMove;

  const topBar = (
    <TopBar
      running
      title="Workout"
      subtitle={station ? stationProgressLabel(station, circuit.kind, circuit.items.length) : undefined}
      accent="body"
      trailing={
        studying ? (
          <Button
            label="Finish"
            variant="ghost"
            accent="body"
            fullWidth={false}
            accessibilityLabel="Finish for now"
            accessibilityHint="Ends the workout and the cycle, and shows a summary"
            onPress={actions.finish}
          />
        ) : undefined
      }
    />
  );

  if (!station) {
    // Only for a moment between the last set and the next phase (or a circuit with nothing left).
    return (
      <Screen footer={<Button label={endLabel} accent="body" size="comfortable" onPress={end} />}>
        {topBar}
        <Text variant="title">That was every exercise.</Text>
      </Screen>
    );
  }

  const { item } = station;
  const timed = item.measure === 'time';
  const target = station.target ?? 0;
  const done = draft.done ?? target;
  const weightLbs = draft.weightLbs !== undefined ? draft.weightLbs : station.targetWeightLbs;
  const equipment = exercise?.equipment ?? [];
  const loaded = station.targetWeightLbs !== null || (exercise !== null && !isBodyweightOnly(exercise));
  const range = timed ? LIMITS.seconds : LIMITS.reps;
  // The weight buttons count real load steps (units.ts: 5 lb, 2.5 kg, 2 kg dumbbells, 4 kg kettlebells),
  // so −/+ always lands on a weight that exists; an off-grid target (from the other unit) snaps to the
  // next step in the direction tapped. Rounded so float noise from the lb ↔ kg round trip is not a step.
  const increment = loadIncrement(unit, equipment);
  const weightSteps = weightLbs === null ? 0 : Math.round((fromLbs(weightLbs, unit) / increment) * 1e6) / 1e6;
  const logged = spokenTarget(done, item.measure, weightLbs, unit);

  const logSet = () => {
    const actual: SetActuals = { expectedSetIndex: state.setsLogged };
    if (draft.done !== null) actual.done = draft.done;
    if (draft.weightLbs !== undefined) actual.weightLbs = draft.weightLbs;
    if (draft.rpe !== null) actual.rpe = draft.rpe;
    actions.logSet(actual);
  };

  const footer = (
    <Button
      label="Done"
      accent="body"
      size="comfortable"
      accessibilityLabel={`Done: log ${logged}`}
      accessibilityHint="Logs this set"
      onPress={logSet}
    />
  );

  return (
    <Screen footer={footer}>
      {topBar}
      {error ? <Notice tone="warning" message={error} /> : null}
      <HandoffMorph active={handoff} from={ringFrame} onDone={onHandoffDone}>
        <ExerciseCard
          station={station}
          kind={circuit.kind}
          itemCount={circuit.items.length}
          unit={unit}
          instructions={exercise?.instructions ?? []}
        />
      </HandoffMorph>
      <HandoffFade active={handoff} gap={space[5]}>
        {resting && state.rest ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <View style={{ flex: 1 }}>
              <Text
                variant="title"
                style={{ fontVariant: ['tabular-nums'] }}
                accessibilityLabel={`Rest, ${formatClock(remainingMs(state.rest, now))} left`}
              >
                {restLabel(remainingMs(state.rest, now))}
              </Text>
              <Text variant="caption" tone="secondary">
                Then the set above.
              </Text>
            </View>
            <Button label="Skip rest" variant="secondary" accent="body" fullWidth={false} onPress={actions.skipRest} />
          </View>
        ) : null}

        {state.lastAdvice ? (
          <SpotterNote
            exerciseName={state.lastAdvice.exerciseName}
            message={state.lastAdvice.advice.message}
            tone={adviceTone(state.lastAdvice.advice.action)}
          />
        ) : null}

        <View style={{ gap: space[4] }}>
          <Stepper
            label={timed ? 'Seconds' : 'Reps'}
            value={done}
            min={range.min}
            max={range.max}
            step={range.step}
            accent="body"
            format={(value) => (timed ? `${value} s` : String(value))}
            onChange={(value) => change({ done: value })}
          />
          {loaded ? (
            <Stepper
              label="Weight"
              value={weightSteps}
              min={0}
              max={Math.ceil(LIMITS.weight[unit] / increment)}
              step={1}
              accent="body"
              hint={weightLbs === null ? 'Set the weight you use, so the spotter can track it.' : undefined}
              format={(steps) => (steps > 0 ? formatWeight(toLbs(steps * increment, unit), unit) : 'None')}
              onChange={(steps) => change({ weightLbs: steps > 0 ? toLbs(steps * increment, unit) : null })}
            />
          ) : null}
          <View style={{ gap: space[2] }}>
            <Text variant="label">How hard was it? (optional)</Text>
            <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {EFFORT_CHIPS.map((chip) => (
                <Chip
                  key={chip.rpe}
                  label={chip.label}
                  role="radio"
                  accent="body"
                  selected={draft.rpe === chip.rpe}
                  onPress={() => change({ rpe: draft.rpe === chip.rpe ? null : chip.rpe })}
                />
              ))}
            </View>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: space[3] }}>
          <View style={{ flex: 1 }}>
            <Button
              label="Swap"
              variant="secondary"
              accent="body"
              accessibilityHint="Shows other exercises that fit your setup"
              accessibilityState={{ expanded: draft.swapOpen }}
              onPress={() => change({ swapOpen: !draft.swapOpen })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Skip"
              variant="secondary"
              accent="body"
              accessibilityLabel="Skip this exercise"
              accessibilityHint="Leaves this exercise out for today"
              onPress={actions.skipExercise}
            />
          </View>
        </View>
        {draft.swapOpen ? (
          <SwapPanel
            options={alternatives}
            onClose={() => change({ swapOpen: false })}
            onPick={(replacement) => {
              change({ swapOpen: false });
              void actions.swapExercise(station.index, replacement);
            }}
          />
        ) : null}

        {state.blockId !== null ? <BlockRating value={state.effortRating} onRate={actions.rateBlock} /> : null}

        <Button label={endLabel} variant="ghost" accent="body" accessibilityHint={endHint} onPress={end} />
      </HandoffFade>
    </Screen>
  );
}
