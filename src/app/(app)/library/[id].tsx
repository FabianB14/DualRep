import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, Card, ListGroup, ListRow, Notice, NumberedSteps, Screen, StatusPill, Text } from '@/components';
import { DEMAND_LABELS } from '@/features/library/customExercise';
import { deleteUserExercise } from '@/features/library/customExerciseRepo';
import { useTrainingDefaults } from '@/features/settings/useTrainingDefaults';
import { describeEquipment, fitsSetup } from '@/features/training/equipment';
import { BODY_REGION_LABELS, MOVEMENT_PATTERN_LABELS } from '@/features/training/library';
import type { ExerciseLocation, LibraryExercise } from '@/features/training/types';
import { useLibrary } from '@/features/training/useLibrary';
import { haptic, useTheme } from '@/theme';

const LOCATION_TEXT: Record<ExerciseLocation, string> = {
  both: 'Home or gym',
  home: 'At home',
  gym: 'At the gym',
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function originText(exercise: LibraryExercise, userId: string | null): string {
  if (exercise.origin === 'user') return exercise.ownerId === userId ? 'Added by you' : 'Shared by your group';
  if (exercise.origin === 'interverse') return 'DualRep original';
  return exercise.reviewed ? 'From the open exercise dataset' : 'From the open exercise dataset (not reviewed yet)';
}

/** One exercise: what it trains, the gear it needs, whether it fits the current setup, and how to do it. */
export default function ExerciseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { space } = useTheme();
  const { byId, isLoading } = useLibrary();
  const { setup } = useTrainingDefaults();
  const [error, setError] = useState<string | null>(null);
  const exercise = byId.get(id);

  if (!exercise) {
    return (
      <Screen edges={['bottom', 'left', 'right']} footer={<Button label="Back" size="comfortable" onPress={() => router.back()} />}>
        {isLoading ? null : (
          <Notice tone="warning" title="Exercise not found" message="This exercise isn't on this phone. It may have been deleted." />
        )}
      </Screen>
    );
  }

  const gear = exercise.equipment.filter((item) => item !== 'bodyweight');
  const fits = setup ? fitsSetup(exercise, setup) : null;
  const missing = setup ? gear.filter((item) => !setup.equipment.includes(item)) : [];
  const mine = exercise.origin === 'user' && exercise.ownerId === userId;

  const confirmDelete = () => {
    Alert.alert('Delete this exercise?', 'Sets you logged with it stay in your history under its name.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (!userId) return;
          deleteUserExercise(exercise.id, userId).then(
            () => {
              haptic('success');
              router.back();
            },
            (problem: unknown) => setError(`Couldn't delete on this phone: ${String(problem)}`),
          );
        },
      },
    ]);
  };

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title: exercise.name }} />

      <View style={{ gap: space[2] }}>
        <Text variant="title">{exercise.name}</Text>
        <Text tone="secondary">{originText(exercise, userId)}</Text>
      </View>

      {fits !== null && setup ? (
        <StatusPill
          tone={fits ? 'success' : 'warning'}
          label={fits ? `Fits ${setup.name}` : `Doesn't fit ${setup.name}`}
          accessibilityLabel={fits ? `Fits your setup ${setup.name}` : `Doesn't fit your setup ${setup.name}`}
        />
      ) : null}
      {fits === false && missing.length > 0 ? (
        <Text variant="caption" tone="secondary">
          Needs {describeEquipment(missing)}.
        </Text>
      ) : null}

      <ListGroup>
        <ListRow
          title="Movement"
          value={exercise.movementPattern ? MOVEMENT_PATTERN_LABELS[exercise.movementPattern] : 'Not set'}
        />
        <ListRow title="Works" value={exercise.bodyRegion ? BODY_REGION_LABELS[exercise.bodyRegion] : 'Not set'} />
        {exercise.muscleGroup ? <ListRow title="Main muscle" value={capitalize(exercise.muscleGroup)} /> : null}
        <ListRow title="Counted in" value={exercise.measure === 'time' ? 'Seconds' : 'Reps'} />
        <ListRow
          title="Gear"
          value={describeEquipment(gear) || 'None'}
        />
        <ListRow title="Where" value={LOCATION_TEXT[exercise.location]} />
        {exercise.demandLevel ? <ListRow title="Effort" value={DEMAND_LABELS[exercise.demandLevel]} /> : null}
        <ListRow title="Short circuits" value={exercise.microOk ? 'Yes' : 'Full sessions only'} />
      </ListGroup>

      <Card>
        <Text variant="subtitle" accessibilityRole="header">
          How to do it
        </Text>
        {exercise.instructions.length === 0 ? (
          <Text tone="secondary">No steps written for this exercise yet.</Text>
        ) : (
          <NumberedSteps steps={exercise.instructions} />
        )}
      </Card>

      {error ? <Notice tone="danger" title="Something went wrong" message={error} /> : null}
      {mine ? <Button label="Delete exercise" variant="ghost" onPress={confirmDelete} /> : null}
    </Screen>
  );
}
