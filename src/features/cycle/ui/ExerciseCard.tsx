import { useState } from 'react';
import { View } from 'react-native';

import { Button, Card, NumberedSteps, Text } from '@/components';
import type { Unit, WorkoutKind } from '@/features/training/types';
import { useTheme } from '@/theme';

import type { Station } from '../cycleMachine';
import { spokenTarget, stationProgressLabel, targetLabel } from './cycleText';

export type ExerciseCardProps = {
  station: Station;
  kind: WorkoutKind;
  itemCount: number;
  unit: Unit;
  /** The exercise's steps (from the library), or [] when there are none on the phone. */
  instructions: readonly string[];
};

/**
 * The current exercise: where the user is, its name, and the target ("10 reps · 25 lb", "40 s").
 * The steps are one tap away, folded by default so the target stays the first thing seen. The name
 * is a live region: when the card moves on to the next exercise, a screen reader says the new name.
 */
export function ExerciseCard({ station, kind, itemCount, unit, instructions }: ExerciseCardProps) {
  const { space } = useTheme();
  const [showSteps, setShowSteps] = useState(false);
  const { item } = station;
  const target = targetLabel(station.target, item.measure, station.targetWeightLbs, unit);
  const spoken = spokenTarget(station.target, item.measure, station.targetWeightLbs, unit);

  return (
    <Card tint="body" elevation={2}>
      <Text variant="caption" tone="body" style={{ fontWeight: '600' }}>
        {stationProgressLabel(station, kind, itemCount)}
      </Text>
      <View style={{ gap: space[1] }}>
        <Text variant="headline" accessibilityLiveRegion="polite">
          {item.name}
        </Text>
        <Text variant="title" accessibilityRole="text" accessibilityLabel={`Target: ${spoken}`}>
          {target}
        </Text>
      </View>
      {station.restPause ? (
        <Text tone="secondary">A rest-pause set: just the reps you missed, after a short rest.</Text>
      ) : null}
      {instructions.length > 0 ? (
        <View style={{ gap: space[2] }}>
          <Button
            label={showSteps ? 'Hide the steps' : 'How to do it'}
            variant="ghost"
            accent="body"
            fullWidth={false}
            accessibilityState={{ expanded: showSteps }}
            onPress={() => setShowSteps((open) => !open)}
          />
          {showSteps ? <NumberedSteps steps={instructions} accent="body" /> : null}
        </View>
      ) : null}
    </Card>
  );
}
