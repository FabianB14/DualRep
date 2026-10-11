import { useEffect, useState } from 'react';
import { Alert, Linking, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, ListGroup, ListRow, Notice, Screen, Section, SegmentedControl, StatusPill, Stepper, Text } from '@/components';
import { getUploadQueueCount, waitForUploads } from '@/db/syncCheck';
import { CYCLE_STATE_KEY, parseCycleState } from '@/features/cycle/cycleMachine';
import { useLocalState } from '@/features/cycle/localState';
import { rescheduleCycleAlert, stopCycleForSignOut } from '@/features/cycle/useCycle';
import { BLOCK_MINUTES, formatMinutes, UNIT_LABELS, UNITS, type ProfilePatch } from '@/features/settings/profile';
import { updateProfile } from '@/features/settings/profileRepo';
import { signOutWarning } from '@/features/settings/signOut';
import { useProfile } from '@/features/settings/useProfile';
import { PREF_LIMITS, ratingButtons, useStudyPrefs, type StudyPrefsPatch } from '@/features/study/studyPrefs';
import { SyncStatusCard } from '@/features/sync/SyncStatusCard';
import type { NotificationPermission } from '@/features/timer/notifications';
import { useNotificationPermission } from '@/features/timer/useNotificationPermission';
import type { Unit } from '@/features/training/types';
import { haptic, useTheme } from '@/theme';

/** How long sign-out waits for the last writes (a running cycle's end) to upload when online. */
const SIGN_OUT_UPLOAD_WAIT_MS = 10_000;

type AnswerButtons = '2' | '4';

const ANSWER_BUTTON_OPTIONS: { value: AnswerButtons; label: string; accessibilityLabel: string }[] = [
  { value: '2', label: '2 buttons', accessibilityLabel: 'Two buttons: Missed it, Got it' },
  { value: '4', label: '4 buttons', accessibilityLabel: 'Four buttons: Again, Hard, Good, Easy' },
];

/** The reminder time is picked in quarter hours, as minutes after midnight. */
const REMINDER_RANGE = { min: 0, max: 23 * 60 + 45, step: 15 };

/** "6:00 PM" or "18:00", as the phone shows times. */
function formatTimeOfDay(minutes: number): string {
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Settings: default block length, units, how cards are answered, the daily review reminder,
 * end-of-block alerts, sync status and sign-out. Changes are saved on the phone at once. The profile
 * ones are uploaded later, and before the profile has synced they cannot be saved yet (the screen
 * says so instead of pretending); the study ones belong to this phone only and always save.
 */
export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { space } = useTheme();
  const { profile, userId } = useProfile();
  const { permission, request: requestPermission } = useNotificationPermission();
  const { prefs: study, save: saveStudy } = useStudyPrefs();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { value: savedCycle } = useLocalState<unknown>(CYCLE_STATE_KEY);
  const cycleRunning = parseCycleState(savedCycle, user?.id ?? null).phase !== 'idle';

  // Alerts allowed (here, or in system settings and back): a block already running gets its alert now.
  useEffect(() => {
    if (permission === 'granted' && cycleRunning) void rescheduleCycleAlert(user?.id ?? null);
  }, [permission, cycleRunning, user?.id]);

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

  const changeStudy = (patch: StudyPrefsPatch) => {
    setError(null);
    saveStudy(patch).catch((problem: unknown) => {
      setError(`Couldn't save on this phone: ${String(problem)}`);
      haptic('error');
    });
  };

  const askForAlerts = async () => {
    const result = await requestPermission();
    haptic(result === 'granted' ? 'success' : 'warning');
  };

  // Turning the reminder on asks for notifications in context (once); it is saved either way, and
  // rings as soon as they are allowed.
  const toggleReminder = async () => {
    const enabled = !study.reminder.enabled;
    changeStudy({ reminder: { enabled } });
    if (enabled && permission === 'undetermined') await askForAlerts();
  };

  const doSignOut = async () => {
    setSigningOut(true);
    try {
      // The running cycle first (it keeps running when its screen is closed): it is finished so its
      // rows are closed, none of its writes may land after this phone's data is cleared, and its
      // block-end alert must not ring afterwards. Online, its closing writes then go up before the clear.
      await stopCycleForSignOut(user?.id ?? null);
      await waitForUploads(SIGN_OUT_UPLOAD_WAIT_MS);
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const confirmSignOut = async () => {
    // Signing out deletes this phone's copy of the data, including writes not uploaded yet.
    const pendingUploads = await getUploadQueueCount().catch(() => 0);
    const warning = signOutWarning(pendingUploads, cycleRunning);
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
          message="Your account has not finished its first sync, so the block length and units can’t be saved yet. The app uses 25-minute blocks and pounds until then. Connect to the internet once."
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

      <Section title="Answering cards" description="These settings are for this phone only.">
        <View style={{ gap: space[2] }}>
          <SegmentedControl<AnswerButtons>
            label="After you see the answer"
            value={String(study.answerButtons) as AnswerButtons}
            options={ANSWER_BUTTON_OPTIONS}
            onChange={(value) => changeStudy({ answerButtons: value === '4' ? 4 : 2 })}
          />
          <Text variant="caption" tone="secondary">
            {ratingButtons(study.answerButtons)
              .map((button) => button.label)
              .join(' · ')}
          </Text>
        </View>
        <ListGroup>
          <ListRow
            title="Type short answers"
            subtitle="When the answer is a few words, type it and the phone checks it; small spelling slips count as right. Longer answers are still shown."
            accessory="checkbox"
            checked={study.typedAnswers}
            onPress={() => changeStudy({ typedAnswers: !study.typedAnswers })}
          />
        </ListGroup>
        <Stepper
          label="New cards a day"
          value={study.dailyNewCap}
          min={PREF_LIMITS.dailyNewCap.min}
          max={PREF_LIMITS.dailyNewCap.max}
          step={5}
          format={(value) => `${value} cards`}
          hint="Each new card brings reviews on the days after. Fewer new cards keep those days light."
          onChange={(value) => changeStudy({ dailyNewCap: value })}
        />
      </Section>

      <Section title="Daily review reminder" description="Only on days when cards are due. It shows how many, never what they say.">
        <ListGroup>
          <ListRow
            title="Remind me when cards are due"
            accessory="checkbox"
            checked={study.reminder.enabled}
            onPress={() => void toggleReminder()}
          />
        </ListGroup>
        <Stepper
          label="Reminder time"
          value={study.reminder.hour * 60 + study.reminder.minute}
          min={REMINDER_RANGE.min}
          max={REMINDER_RANGE.max}
          step={REMINDER_RANGE.step}
          format={formatTimeOfDay}
          disabled={!study.reminder.enabled}
          onChange={(value) => changeStudy({ reminder: { hour: Math.floor(value / 60), minute: value % 60 } })}
        />
        {study.reminder.enabled && permission === 'denied' ? (
          <Text variant="caption" tone="warning" accessibilityLiveRegion="polite">
            Notifications are off for DualRep, so the reminder can’t ring. Turn them on below.
          </Text>
        ) : null}
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
