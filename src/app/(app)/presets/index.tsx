import { router } from 'expo-router';
import { useState } from 'react';

import { Button, ListGroup, ListRow, Notice, Screen, Text } from '@/components';
import { describeSplit, resolvePreset, type Preset } from '@/features/presets/presets';
import { usePresets } from '@/features/presets/usePresets';
import { updateProfile } from '@/features/settings/profileRepo';
import { useProfile } from '@/features/settings/useProfile';
import { haptic } from '@/theme';

/**
 * Pick the default preset (how a workout's sets are split across the body): the six system presets
 * and the user's own. Tapping a row makes it the default; custom presets have an Edit button. The
 * footer starts a new custom split.
 */
export default function PresetsScreen() {
  const { profile, userId } = useProfile();
  const presets = usePresets();
  const current = resolvePreset(presets, profile.defaultPresetId);
  const [error, setError] = useState<string | null>(null);

  const choose = async (preset: Preset) => {
    if (!userId || preset.id === current.id) return;
    setError(null);
    try {
      const written = await updateProfile(userId, { defaultPresetId: preset.id });
      if (!written) {
        setError('Your account has not finished its first sync yet. Connect to the internet once, then try again.');
        haptic('warning');
      }
    } catch (problem) {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
    }
  };

  const row = (preset: Preset) => (
    <ListRow
      key={preset.id}
      title={preset.name}
      subtitle={describeSplit(preset.split)}
      accessory="radio"
      checked={preset.id === current.id}
      disabled={!profile.synced}
      accessibilityHint="Makes this your default preset"
      onPress={() => void choose(preset)}
      trailing={
        preset.system ? undefined : (
          <Button
            label="Edit"
            variant="ghost"
            fullWidth={false}
            accessibilityLabel={`Edit ${preset.name}`}
            onPress={() => router.push({ pathname: '/presets/[id]', params: { id: preset.id } })}
          />
        )
      }
    />
  );

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={
        <Button
          label="Make a custom split"
          size="comfortable"
          onPress={() => router.push({ pathname: '/presets/[id]', params: { id: 'new', from: current.id } })}
        />
      }
    >
      <Text tone="secondary">
        A preset decides how a workout’s sets are shared between lower body, upper body, core and cardio. New cycles
        start with your default; you can change it for a single cycle too.
      </Text>

      {!profile.synced ? (
        <Notice
          title="Default not saved yet"
          message="Your account has not finished its first sync. Until it has, cycles use Full body. Connect to the internet once to choose."
        />
      ) : null}

      <ListGroup title="Presets">{presets.system.map(row)}</ListGroup>

      {presets.custom.length > 0 ? <ListGroup title="Your presets">{presets.custom.map(row)}</ListGroup> : null}

      {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}
    </Screen>
  );
}
