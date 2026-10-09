import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  Chip,
  ListGroup,
  ListRow,
  Notice,
  Screen,
  Section,
  SegmentedControl,
  Text,
  TextField,
} from '@/components';
import {
  DEMAND_LABELS,
  draftMeasure,
  draftRegion,
  emptyExerciseDraft,
  EXERCISE_NAME_MAX,
  exerciseDraftErrors,
  locationFor,
  type ExerciseDraft,
  type PlaceChoice,
} from '@/features/library/customExercise';
import { createUserExercise } from '@/features/library/customExerciseRepo';
import { toggleEquipment } from '@/features/setups/setups';
import { EQUIPMENT_GROUPS, EQUIPMENT_LABELS } from '@/features/training/equipment';
import { BODY_REGION_LABELS, BODY_REGIONS, MOVEMENT_PATTERN_LABELS, MOVEMENT_PATTERNS } from '@/features/training/library';
import { MUSCLE_GROUPS } from '@/features/training/starterLibrary';
import type { DemandLevel } from '@/features/training/types';
import { haptic, useTheme } from '@/theme';

const PLACE_OPTIONS: { value: PlaceChoice; label: string; accessibilityLabel: string }[] = [
  { value: 'both', label: 'Anywhere', accessibilityLabel: 'Home or gym' },
  { value: 'home', label: 'Home only', accessibilityLabel: 'Home only' },
  { value: 'gym', label: 'Gym only', accessibilityLabel: 'Gym only' },
];

const DEMAND_VALUES = ['1', '2', '3'] as const;

/**
 * Add an exercise of your own (origin 'user'). It joins the library at once, offline, and the default
 * circuits can pick it when it fits the setup in use. How sets are counted (reps or seconds) follows
 * from the movement and the name, and is shown before saving.
 */
export default function NewExerciseScreen() {
  const { user } = useAuth();
  const { space } = useTheme();
  const [draft, setDraft] = useState<ExerciseDraft>(emptyExerciseDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = exerciseDraftErrors(draft);
  const region = draftRegion(draft);
  const measure = draftMeasure(draft);
  const location = locationFor(draft.equipment, draft.place);
  const update = (patch: Partial<ExerciseDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    if (!user || busy) return;
    if (errors.name || errors.pattern || errors.region) {
      setShowErrors(true);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await createUserExercise(user.id, draft);
      haptic('success');
      router.replace({ pathname: '/library/[id]', params: { id } });
    } catch (problem) {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
      setBusy(false);
    }
  };

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={<Button label="Save exercise" size="comfortable" accent="body" loading={busy} onPress={save} />}
    >
      <TextField
        label="Name"
        value={draft.name}
        maxLength={EXERCISE_NAME_MAX}
        placeholder="For example: Backpack squat"
        onChangeText={(name) => update({ name })}
        error={showErrors ? errors.name : null}
        autoCapitalize="sentences"
        returnKeyType="done"
      />

      <Section title="Kind of movement" description={`Sets will be counted in ${measure === 'time' ? 'seconds' : 'reps'}.`}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {MOVEMENT_PATTERNS.map((pattern) => (
            <Chip
              key={pattern}
              label={MOVEMENT_PATTERN_LABELS[pattern]}
              role="radio"
              accent="body"
              selected={draft.pattern === pattern}
              onPress={() => update({ pattern, region: null })}
            />
          ))}
        </View>
        {showErrors && errors.pattern ? (
          <Text variant="caption" tone="danger" accessibilityRole="alert">
            {errors.pattern}
          </Text>
        ) : null}
      </Section>

      <Section title="Part of the body">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {BODY_REGIONS.map((value) => (
            <Chip
              key={value}
              label={BODY_REGION_LABELS[value]}
              role="radio"
              accent="body"
              selected={region === value}
              onPress={() => update({ region: value })}
            />
          ))}
        </View>
        {showErrors && errors.region ? (
          <Text variant="caption" tone="danger" accessibilityRole="alert">
            {errors.region}
          </Text>
        ) : null}
      </Section>

      <Section title="Gear it needs" description="Leave all unchecked if it needs only your body.">
        {EQUIPMENT_GROUPS.map((group) => (
          <View key={group.title} style={{ gap: space[2] }}>
            <Text variant="label" tone="secondary">
              {group.title}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {group.items.map((item) => (
                <Chip
                  key={item}
                  label={EQUIPMENT_LABELS[item]}
                  role="checkbox"
                  accent="body"
                  selected={draft.equipment.includes(item)}
                  onPress={() => update({ equipment: toggleEquipment(draft.equipment, item) })}
                />
              ))}
            </View>
          </View>
        ))}
      </Section>

      <View style={{ gap: space[2] }}>
        <SegmentedControl<PlaceChoice>
          label="Where can you do it?"
          accent="body"
          value={draft.place}
          options={PLACE_OPTIONS}
          onChange={(place) => update({ place })}
        />
        {location === 'gym' && draft.place !== 'gym' ? (
          <Text variant="caption" tone="secondary">
            It needs gym gear, so it is saved as a gym exercise.
          </Text>
        ) : null}
      </View>

      <SegmentedControl<(typeof DEMAND_VALUES)[number]>
        label="How hard is it?"
        accent="body"
        value={String(draft.demand) as (typeof DEMAND_VALUES)[number]}
        options={DEMAND_VALUES.map((value) => ({ value, label: DEMAND_LABELS[Number(value) as DemandLevel] }))}
        onChange={(value) => update({ demand: Number(value) as DemandLevel })}
      />

      <ListGroup>
        <ListRow
          title="Use it in short circuits"
          subtitle="The 5–15 minute workouts between study blocks"
          accessory="checkbox"
          accent="body"
          checked={draft.microOk}
          onPress={() => update({ microOk: !draft.microOk })}
        />
      </ListGroup>

      <Section title="Main muscle (optional)">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {MUSCLE_GROUPS.map((muscle) => (
            <Chip
              key={muscle}
              label={muscle.charAt(0).toUpperCase() + muscle.slice(1)}
              role="radio"
              accent="body"
              selected={draft.muscleGroup === muscle}
              onPress={() => update({ muscleGroup: draft.muscleGroup === muscle ? null : muscle })}
            />
          ))}
        </View>
      </Section>

      <TextField
        label="How to do it (optional)"
        hint="One step per line."
        value={draft.steps}
        onChangeText={(steps) => update({ steps })}
        multiline
        numberOfLines={4}
      />

      {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}
    </Screen>
  );
}
