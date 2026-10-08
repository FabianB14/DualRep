import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button, ListGroup, ListRow, Notice, Screen, Stepper, Text, TextField } from '@/components';
import {
  describeSplit,
  newPresetDraft,
  PRESET_NAME_MAX,
  presetDraftErrors,
  resolvePreset,
  SPLIT_REGION_LABELS,
  SPLIT_STEP,
  splitTotal,
  type PresetDraft,
} from '@/features/presets/presets';
import { createPreset, deletePreset, updatePreset } from '@/features/presets/presetsRepo';
import { usePresets } from '@/features/presets/usePresets';
import { updateProfile } from '@/features/settings/profileRepo';
import { useProfile } from '@/features/settings/useProfile';
import { SPLIT_REGIONS } from '@/features/training/types';
import { haptic, useTheme } from '@/theme';

/**
 * The custom split editor (`/presets/new`, optionally `?from=<preset id>` to start from a copy, or
 * `/presets/<id>` for one of the user's presets): a name and four percentages in steps of 5 that
 * must add up to 100 before it can be saved. A system preset opens read-only, with a way to copy it.
 */
export default function PresetEditorScreen() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const isNew = id === 'new';
  const { space } = useTheme();
  const { profile, userId } = useProfile();
  const presets = usePresets();
  const saved = isNew ? undefined : presets.byId.get(id);
  const isDefault = !isNew && resolvePreset(presets, profile.defaultPresetId).id === id;

  // The form shows the saved preset (or a new draft) until the user changes something; from then on
  // it shows their edits. So it fills in as soon as the presets have been read, without copying them.
  const base = useMemo<PresetDraft | null>(() => {
    if (isNew) return newPresetDraft(from ? presets.byId.get(from) : null);
    return saved && !saved.system ? { name: saved.name, split: { ...saved.split } } : null;
  }, [from, isNew, presets.byId, saved]);
  const [edits, setEdits] = useState<PresetDraft | null>(null);
  const draft = edits ?? base;
  const [makeDefault, setMakeDefault] = useState(true);
  const [showNameError, setShowNameError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (leaving) return <Screen edges={['bottom', 'left', 'right']}>{null}</Screen>;

  if (saved?.system) {
    return (
      <Screen
        edges={['bottom', 'left', 'right']}
        footer={
          <Button
            label="Copy as a custom split"
            size="comfortable"
            onPress={() => router.replace({ pathname: '/presets/[id]', params: { id: 'new', from: saved.id } })}
          />
        }
      >
        <Stack.Screen options={{ title: saved.name }} />
        <Text variant="title">{saved.name}</Text>
        <Text tone="secondary">{describeSplit(saved.split)}</Text>
        <Notice message="The six built-in presets can’t be changed. Copy one to make your own version." />
      </Screen>
    );
  }
  if (!isNew && !presets.isLoading && !saved && edits === null) {
    return (
      <Screen edges={['bottom', 'left', 'right']} footer={<Button label="Back" size="comfortable" onPress={() => router.back()} />}>
        <Notice tone="warning" title="Preset not found" message="This preset isn't on this phone. It may have been deleted." />
      </Screen>
    );
  }
  if (draft === null) return <Screen edges={['bottom', 'left', 'right']}>{null}</Screen>;

  const errors = presetDraftErrors(draft);
  const total = splitTotal(draft.split);
  const canSave = !errors.split && !busy;

  const save = async () => {
    if (!userId || busy) return;
    if (errors.name || errors.split) {
      setShowNameError(true);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isNew) await createPreset(userId, draft, { makeDefault: makeDefault && profile.synced });
      else await updatePreset(id, userId, draft);
      haptic('success');
      router.back();
    } catch (problem) {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
      setBusy(false);
    }
  };

  const chooseAsDefault = async () => {
    if (!userId) return;
    try {
      const written = await updateProfile(userId, { defaultPresetId: id });
      haptic(written ? 'success' : 'warning');
    } catch (problem) {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete this preset?', 'Past workouts stay in your history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (!userId) return;
          deletePreset(id, userId).then(
            () => {
              haptic('success');
              setLeaving(true);
              router.back();
            },
            (problem: unknown) => setError(`Couldn't delete on this phone: ${String(problem)}`),
          );
        },
      },
    ]);
  };

  const totalMessage =
    total === 100 ? 'Total 100%. Ready to save.' : total < 100 ? `Total ${total}%. Add ${100 - total}% more.` : `Total ${total}%. Take away ${total - 100}%.`;

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={
        <>
          <Text
            tone={total === 100 ? 'success' : 'warning'}
            align="center"
            accessibilityLiveRegion="polite"
            style={{ fontWeight: '600' }}
          >
            {totalMessage}
          </Text>
          <Button
            label={isNew ? 'Save preset' : 'Save changes'}
            size="comfortable"
            accent="body"
            loading={busy}
            disabled={!canSave}
            onPress={save}
          />
        </>
      }
    >
      <Stack.Screen options={{ title: isNew ? 'New custom split' : saved?.name ?? 'Custom split' }} />

      <TextField
        label="Name"
        value={draft.name}
        maxLength={PRESET_NAME_MAX}
        placeholder="For example: Legs and core"
        onChangeText={(name) => setEdits((current) => ({ ...(current ?? draft), name }))}
        onBlur={() => setShowNameError(true)}
        error={showNameError ? errors.name : null}
        autoCapitalize="sentences"
        returnKeyType="done"
      />

      <Text tone="secondary">How much of each workout goes to each part of the body. The four parts add up to 100%.</Text>

      <View style={{ gap: space[5] }}>
        {SPLIT_REGIONS.map((region) => (
          <Stepper
            key={region}
            label={SPLIT_REGION_LABELS[region]}
            value={draft.split[region]}
            min={0}
            max={100}
            step={SPLIT_STEP}
            accent="body"
            format={(value) => `${value}%`}
            onChange={(value) =>
              setEdits((current) => {
                const previous = current ?? draft;
                return { ...previous, split: { ...previous.split, [region]: value } };
              })
            }
          />
        ))}
      </View>

      {isNew && profile.synced ? (
        <ListGroup>
          <ListRow
            title="Make it my default"
            subtitle="New cycles will start with this split"
            accessory="checkbox"
            accent="body"
            checked={makeDefault}
            onPress={() => setMakeDefault((value) => !value)}
          />
        </ListGroup>
      ) : null}

      {error ? <Notice tone="danger" title="Something went wrong" message={error} /> : null}

      {!isNew ? (
        <View style={{ gap: space[2] }}>
          {isDefault ? (
            <Text tone="secondary">This is your default preset.</Text>
          ) : (
            <Button
              label="Make default"
              variant="secondary"
              accent="body"
              disabled={!profile.synced}
              accessibilityHint="New cycles will start with this split"
              onPress={chooseAsDefault}
            />
          )}
          <Button label="Delete preset" variant="ghost" accent="body" onPress={confirmDelete} />
        </View>
      ) : null}
    </Screen>
  );
}
