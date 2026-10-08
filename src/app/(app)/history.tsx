import { useState } from 'react';
import { View } from 'react-native';

import { Card, ListGroup, ListRow, Notice, Screen, SegmentedControl, Text } from '@/components';
import {
  describeBlock,
  describeSet,
  describeWhen,
  describeWorkout,
  type ExerciseGroup,
  type WorkoutEntry,
} from '@/features/history/history';
import { useHistory } from '@/features/history/useHistory';
import { useProfile } from '@/features/settings/useProfile';
import { exerciseMeasure } from '@/features/training/library';
import type { LibraryExercise, Measure, Unit } from '@/features/training/types';
import { useLibrary } from '@/features/training/useLibrary';
import { useTheme } from '@/theme';

type Tab = 'workouts' | 'blocks';

/** Reps or seconds for a group of sets: the exercise's measure when it is on the phone, else guessed from the name. */
function measureOf(group: ExerciseGroup, byId: ReadonlyMap<string, LibraryExercise>): Measure {
  const known = group.exerciseId ? byId.get(group.exerciseId) : undefined;
  return known?.measure ?? exerciseMeasure({ id: group.exerciseId ?? '', name: group.name, movementPattern: null });
}

/**
 * What was done, newest first: workouts with their sets (grouped by exercise name, which survives the
 * exercise being deleted) and focus blocks with their length, effort and whether they ended early.
 * Read from the phone, so it includes what has not uploaded yet.
 */
export default function HistoryScreen() {
  const { space } = useTheme();
  const [tab, setTab] = useState<Tab>('workouts');
  const { blocks, workouts, isLoading } = useHistory();
  const { byId } = useLibrary();
  const { profile } = useProfile();
  // "Today" and "Yesterday" are relative to when the screen opened.
  const [now] = useState(() => Date.now());

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <SegmentedControl<Tab>
        label="Show"
        value={tab}
        options={[
          { value: 'workouts', label: 'Workouts' },
          { value: 'blocks', label: 'Focus blocks' },
        ]}
        onChange={setTab}
      />

      {tab === 'workouts' ? (
        workouts.length === 0 ? (
          isLoading ? null : (
            <Notice
              title="No workouts yet"
              message="Sets show up here as soon as you log them, even with no connection."
            />
          )
        ) : (
          <View style={{ gap: space[4] }}>
            {workouts.map((workout) => (
              <WorkoutCard key={workout.id} workout={workout} now={now} unit={profile.unit} byId={byId} />
            ))}
          </View>
        )
      ) : blocks.length === 0 ? (
        isLoading ? null : (
          <Notice title="No focus blocks yet" message="Each study block you start shows up here." />
        )
      ) : (
        <ListGroup>
          {blocks.map((block) => (
            <ListRow key={block.id} title={describeWhen(block.startedAt, now)} subtitle={describeBlock(block)} />
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}

function WorkoutCard({
  workout,
  now,
  unit,
  byId,
}: {
  workout: WorkoutEntry;
  now: number;
  unit: Unit;
  byId: ReadonlyMap<string, LibraryExercise>;
}) {
  const { space } = useTheme();
  return (
    <Card>
      <View style={{ gap: space[1] }}>
        <Text variant="subtitle" accessibilityRole="header">
          {describeWhen(workout.loggedAt, now)}
        </Text>
        <Text variant="caption" tone="secondary">
          {describeWorkout(workout)}
        </Text>
      </View>
      {workout.exercises.length === 0 ? (
        <Text tone="secondary">No sets logged.</Text>
      ) : (
        workout.exercises.map((group) => {
          const measure = measureOf(group, byId);
          return (
            <View key={group.name} style={{ gap: space[1] }} accessible>
              <Text variant="label">{group.name}</Text>
              {group.sets.map((set, index) => (
                <Text key={set.id} variant="caption" tone="secondary">
                  Set {index + 1}: {describeSet(set, measure, unit)}
                </Text>
              ))}
            </View>
          );
        })
      )}
    </Card>
  );
}
