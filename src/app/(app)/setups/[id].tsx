import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button, Chip, ListGroup, ListRow, Notice, Screen, Section, SegmentedControl, Text, TextField } from '@/components';
import { useProfile } from '@/features/settings/useProfile';
import { updateProfile } from '@/features/settings/profileRepo';
import {
  emptySetupDraft,
  LOCATION_LABELS,
  resolveSetup,
  SETUP_LOCATIONS,
  SETUP_NAME_MAX,
  setupDraftErrors,
  TEMPLATE_CHOICES,
  templateDraft,
  toggleEquipment,
  type SetupDraft,
} from '@/features/setups/setups';
import { createSetup, deleteSetup, updateSetup } from '@/features/setups/setupsRepo';
import { useSetups } from '@/features/setups/useSetups';
import { EQUIPMENT_GROUPS, EQUIPMENT_LABELS, normalizeEquipmentList } from '@/features/training/equipment';
import type { SetupLocation } from '@/features/training/types';
import { haptic, useTheme } from '@/theme';

/** Short template names for the chips (the list screen uses the longer labels). */
const TEMPLATE_CHIP: Record<(typeof TEMPLATE_CHOICES)[number]['template'], string> = {
  home_bodyweight: 'Just my body',
  home_basic: 'Dumbbells and bands',
  gym: 'Full gym',
};

/**
 * Edit a setup, or make a new one (`/setups/new`): name, gym or home, and the gear checklist, with
 * templates to fill it in one tap. An existing setup can be made the default or deleted.
 */
export default function SetupEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { space } = useTheme();
  const { profile, userId } = useProfile();
  const { setups, byId, isLoading } = useSetups();
  const saved = isNew ? undefined : byId.get(id);
  const isDefault = !isNew && resolveSetup(setups, profile.defaultSetupId)?.id === id;

  // The form shows the saved setup (or a blank one) until the user changes something; from then on
  // it shows their edits. So it fills in as soon as the setup has been read, without copying it.
  const base = useMemo<SetupDraft | null>(() => {
    if (isNew) return emptySetupDraft(setups.map((setup) => setup.name));
    return saved ? { name: saved.name, location: saved.location, equipment: normalizeEquipmentList(saved.equipment) } : null;
  }, [isNew, saved, setups]);
  const [edits, setEdits] = useState<SetupDraft | null>(null);
  const draft = edits ?? base;
  const [nameTouched, setNameTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (leaving) return <Screen edges={['bottom', 'left', 'right']}>{null}</Screen>;
  if (!isNew && !isLoading && !saved && edits === null) {
    return (
      <Screen edges={['bottom', 'left', 'right']} footer={<Button label="Back" size="comfortable" onPress={() => router.back()} />}>
        <Notice tone="warning" title="Setup not found" message="This setup isn't on this phone. It may have been deleted." />
      </Screen>
    );
  }
  if (draft === null) return <Screen edges={['bottom', 'left', 'right']}>{null}</Screen>;

  const errors = setupDraftErrors(draft);
  const otherNames = setups.filter((setup) => setup.id !== id).map((setup) => setup.name);

  const update = (patch: Partial<SetupDraft>) => setEdits((current) => ({ ...(current ?? draft), ...patch }));

  const applyTemplate = (template: (typeof TEMPLATE_CHOICES)[number]['template']) => {
    const filled = templateDraft(template, otherNames);
    update({ location: filled.location, equipment: filled.equipment, ...(isNew && !nameTouched ? { name: filled.name } : {}) });
  };

  const save = async () => {
    if (!userId || busy) return;
    if (errors.name) {
      setShowErrors(true);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isNew) await createSetup(userId, draft, { makeDefault: setups.length === 0 });
      else await updateSetup(id, userId, draft);
      haptic('success');
      router.back();
    } catch (problem) {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
      setBusy(false);
    }
  };

  const makeDefault = async () => {
    if (!userId) return;
    try {
      const written = await updateProfile(userId, { defaultSetupId: id });
      haptic(written ? 'success' : 'warning');
      if (!written) setError('Your account has not finished its first sync yet. Connect to the internet once, then try again.');
    } catch (problem) {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete this setup?', 'Your past workouts stay in your history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (!userId) return;
          deleteSetup(id, userId).then(
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

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={<Button label={isNew ? 'Save setup' : 'Save changes'} size="comfortable" loading={busy} onPress={save} />}
    >
      <Stack.Screen options={{ title: isNew ? 'New setup' : saved?.name ?? 'Setup' }} />

      <TextField
        label="Name"
        value={draft.name}
        maxLength={SETUP_NAME_MAX}
        onChangeText={(name) => {
          setNameTouched(true);
          update({ name });
        }}
        error={showErrors ? errors.name : null}
        autoCapitalize="sentences"
        returnKeyType="done"
      />

      <SegmentedControl<SetupLocation>
        label="Where is it?"
        value={draft.location}
        options={SETUP_LOCATIONS.map((location) => ({ value: location, label: LOCATION_LABELS[location] }))}
        onChange={(location) => update({ location })}
      />

      <Section title="Start from" description="Fills in the checklist below. You can change it after.">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {TEMPLATE_CHOICES.map((choice) => (
            <Chip key={choice.template} label={TEMPLATE_CHIP[choice.template]} onPress={() => applyTemplate(choice.template)} />
          ))}
        </View>
      </Section>

      <Section title="Gear here" description="Exercises that need only your body always fit.">
        {EQUIPMENT_GROUPS.map((group) => (
          <ListGroup key={group.title} title={group.title}>
            {group.items.map((item) => (
              <ListRow
                key={item}
                title={EQUIPMENT_LABELS[item]}
                accessory="checkbox"
                checked={draft.equipment.includes(item)}
                onPress={() => update({ equipment: toggleEquipment(draft.equipment, item) })}
              />
            ))}
          </ListGroup>
        ))}
      </Section>

      {error ? <Notice tone="danger" title="Something went wrong" message={error} /> : null}

      {!isNew ? (
        <View style={{ gap: space[2] }}>
          {isDefault ? (
            <Text tone="secondary">This is your default setup.</Text>
          ) : (
            <Button
              label="Make default"
              variant="secondary"
              disabled={!profile.synced}
              accessibilityHint="New cycles will use this setup"
              onPress={makeDefault}
            />
          )}
          {!profile.synced && !isDefault ? (
            <Text variant="caption" tone="secondary">
              You can choose a default once your account has synced. Until then your first setup is used.
            </Text>
          ) : null}
          <Button label="Delete setup" variant="ghost" onPress={confirmDelete} />
        </View>
      ) : null}
    </Screen>
  );
}
