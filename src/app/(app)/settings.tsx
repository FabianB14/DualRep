import { useState } from 'react';
import { Alert, Linking, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, Notice, Screen, Section, SegmentedControl, StatusPill, Stepper, Text } from '@/components';
import { getUploadQueueCount } from '@/db/syncCheck';
import { stopCycleForSignOut } from '@/features/cycle/useCycle';
import { BLOCK_MINUTES, formatMinutes, UNIT_LABELS, UNITS, type ProfilePatch } from '@/features/settings/profile';
import { updateProfile } from '@/features/settings/profileRepo';
import { signOutWarning } from '@/features/settings/signOut';
import { useProfile } from '@/features/settings/useProfile';
import { SyncStatusCard } from '@/features/sync/SyncStatusCard';
import type { NotificationPermission } from '@/features/timer/notifications';
import { useNotificationPermission } from '@/features/timer/useNotificationPermission';
import type { Unit } from '@/features/training/types';
import { haptic, useTheme } from '@/theme';

/**
 * Settings: default block length, units, end-of-block alerts, sync status and sign-out. Changes are
 * saved on the phone at once (and uploaded later); before the profile has synced they cannot be saved
 * yet, and the screen says so instead of pretending.
 */
export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { space } = useTheme();
  const { profile, userId } = useProfile();
  const { permission, request: requestPermission } = useNotificationPermission();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The controls show the saved profile: a local write reaches the watched query within a few
  // milliseconds, so there is no separate "unsaved" state to keep in step.
  const save = (patch: ProfilePatch) => {
    if (!userId) return;
    setError(null);
    updateProfile(userId, patch).catch((problem: unknown) => {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
    });
  };

  const askForAlerts = async () => {
    const result = await requestPermission();
    haptic(result === 'granted' ? 'success' : 'warning');
  };

  const doSignOut = async () => {
    setSigningOut(true);
    try {
      // The running cycle first (it keeps running when its screen is closed): none of its writes may
      // land after this phone's data is cleared, and its block-end alert must not ring afterwards.
      await stopCycleForSignOut();
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const confirmSignOut = async () => {
    // Signing out deletes this phone's copy of the data, including writes not uploaded yet.
    const pendingUploads = await getUploadQueueCount().catch(() => 0);
    const warning = signOutWarning(pendingUploads);
    Alert.alert(warning.title, warning.message, [
      { text: 'Cancel', style: 'cancel' },
      { text: warning.confirmLabel, style: 'destructive', onPress: () => void doSignOut() },
    ]);
  };

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      {!profile.synced ? (
        <Notice
          title="Not synced yet"
          message="Your account has not finished its first sync, so these settings can’t be saved yet. The app uses 25-minute blocks and pounds until then. Connect to the internet once."
        />
      ) : null}

      <Section title="Focus blocks">
        <Stepper
          label="Default block length"
          value={profile.blockMinutes}
          min={BLOCK_MINUTES.min}
          max={BLOCK_MINUTES.max}
          step={BLOCK_MINUTES.step}
          format={formatMinutes}
          disabled={!profile.synced}
          hint="You can still change it for a single block when you start one."
          onChange={(value) => save({ blockMinutes: value })}
        />
      </Section>

      <Section title="Weights">
        <SegmentedControl<Unit>
          label="Show weights in"
          value={profile.unit}
          disabled={!profile.synced}
          options={UNITS.map((value) => ({ value, label: value, accessibilityLabel: UNIT_LABELS[value] }))}
          onChange={(value) => save({ unit: value })}
        />
      </Section>

      <Section title="End-of-block alerts">
        <NotificationStatus permission={permission} onAsk={askForAlerts} />
      </Section>

      <Section title="Sync">
        <SyncStatusCard />
      </Section>

      {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}

      <Section title="Account">
        <View style={{ gap: space[2] }}>
          <Text tone="secondary" numberOfLines={1}>
            Signed in as {user?.email ?? 'unknown'}
          </Text>
          <Button label="Sign out" variant="secondary" loading={signingOut} onPress={confirmSignOut} />
        </View>
      </Section>
    </Screen>
  );
}

function NotificationStatus({
  permission,
  onAsk,
}: {
  permission: NotificationPermission | null;
  onAsk: () => void;
}) {
  const { space } = useTheme();
  if (permission === null) return null;
  if (permission === 'granted') {
    return (
      <View style={{ gap: space[2] }} accessibilityLiveRegion="polite">
        <StatusPill tone="success" label="On" accessibilityLabel="End-of-block alerts: on" />
        <Text tone="secondary">Your phone rings when a focus block ends, even with the screen off.</Text>
      </View>
    );
  }
  if (permission === 'undetermined') {
    return (
      <View style={{ gap: space[2] }} accessibilityLiveRegion="polite">
        <StatusPill tone="neutral" label="Not set up" accessibilityLabel="End-of-block alerts: not set up" />
        <Text tone="secondary">Allow notifications so your phone rings when a focus block ends.</Text>
        <Button label="Turn on alerts" variant="secondary" onPress={onAsk} />
      </View>
    );
  }
  return (
    <View style={{ gap: space[2] }} accessibilityLiveRegion="polite">
      <StatusPill tone="warning" label="Off" accessibilityLabel="End-of-block alerts: off" />
      <Text tone="secondary">
        The timer still works on screen, but your phone won’t ring when a block ends. Turn notifications on for DualRep in
        system settings.
      </Text>
      <Button
        label="Open system settings"
        variant="secondary"
        onPress={() => {
          Linking.openSettings().catch(() => undefined);
        }}
      />
    </View>
  );
}
