import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, View } from 'react-native';

import { Button, Card, Notice, NumberedSteps, Screen, SegmentedControl, StatusPill, Text } from '@/components';
import { describeAlertTest, TEST_MINUTES, type TestMinutes } from '@/features/settings/timerCheck';
import {
  getNotificationPermission,
  readAlertTestResult,
  requestNotificationPermission,
  scheduleAlertTest,
  type AlertTestResult,
  type NotificationPermission,
} from '@/features/timer/notifications';
import { haptic, useTheme } from '@/theme';

const STEPS = [
  'Pick 25 minutes for the real measurement (1 minute is a quick try).',
  'Tap “Schedule test alert”.',
  'Unplug the phone, lock it and leave it still. Don’t open it until the alert rings.',
  'When it rings, tap the alert. It opens this screen with the result. Don’t swipe the alert away instead.',
];

type Reading = { result: AlertTestResult; permission: NotificationPermission; at: number };

/** The test's state and the notification permission, as of now. */
async function read(): Promise<Reading> {
  const at = Date.now();
  const [result, permission] = await Promise.all([readAlertTestResult(at), getNotificationPermission()]);
  return { result, permission, at };
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/**
 * The D8 measurement: how late does Android ring a scheduled alert when the phone has been locked and
 * idle (Doze)? Schedules a test alert, then compares when Android posted it with when it was due.
 * The result decides whether the focus timer needs exact alarms (docs/ANDROID.md 1.3).
 */
export default function TimerCheckScreen() {
  const { space } = useTheme();
  const [minutes, setMinutes] = useState<TestMinutes>(25);
  const [reading, setReading] = useState<Reading | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = reading?.result ?? null;
  const permission = reading?.permission ?? null;
  const now = reading?.at ?? 0;

  const refresh = useCallback(() => read().then(setReading), []);

  // Read on open and whenever the app comes back to the foreground.
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  // While a test is pending, re-read every second (countdown, and the alert being posted).
  const pending = result?.status === 'waiting' || result?.status === 'delayed';
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  const schedule = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // The test is pointless without the permission. If Android can still ask, ask now (this screen is
    // the context: the user just chose to test the alert); a denied permission keeps the button off.
    if (permission === 'undetermined') await requestNotificationPermission();
    const test = await scheduleAlertTest(minutes);
    setBusy(false);
    if (!test) {
      setError('No alert could be scheduled. Check that notifications are allowed for DualRep.');
      haptic('error');
    } else {
      haptic('success');
    }
    await refresh();
  };

  const summary = result ? describeAlertTest(result, now) : null;
  const test = result && result.status !== 'none' ? result.test : null;

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={
        <Button
          label={test ? 'Schedule a new test alert' : 'Schedule test alert'}
          size="comfortable"
          loading={busy}
          disabled={permission === 'denied'}
          onPress={schedule}
        />
      }
    >
      <Text tone="secondary">
        This measures how late your phone rings the end-of-block alert when it has been locked for a while. Android may
        hold alerts back to save battery.
      </Text>

      {permission === 'denied' ? (
        <Notice
          tone="warning"
          title="Notifications are off"
          message="The test needs notifications. Turn them on for DualRep in system settings."
          action={
            <Button
              label="Open system settings"
              variant="secondary"
              onPress={() => {
                Linking.openSettings().catch(() => undefined);
              }}
            />
          }
        />
      ) : null}

      <SegmentedControl<string>
        label="Ring in"
        value={String(minutes)}
        options={TEST_MINUTES.map((value) => ({ value: String(value), label: `${value} min`, accessibilityLabel: `${value} minutes` }))}
        onChange={(value) => setMinutes(Number(value) as TestMinutes)}
      />

      <Card>
        <Text variant="caption" tone="mind" style={{ fontWeight: '600' }}>
          Result
        </Text>
        {summary ? (
          <>
            <StatusPill tone={summary.tone} label={summary.headline} />
            {/* Announced when the status changes, not on every second of the countdown above. */}
            <Text accessibilityLiveRegion="polite">{summary.detail}</Text>
          </>
        ) : (
          <Text tone="secondary">Reading…</Text>
        )}
        {test ? (
          <View style={{ gap: space[1] }}>
            <Text variant="caption" tone="secondary">
              Scheduled at {clockTime(test.scheduledAt)} for {test.minutes} min
            </Text>
            <Text variant="caption" tone="secondary">
              Due at {clockTime(test.dueAt)}
            </Text>
            {result?.status === 'fired' ? (
              <Text variant="caption" tone="secondary">
                Rang at {clockTime(result.firedAt)}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Card>

      <View style={{ gap: space[2] }}>
        <Text variant="subtitle" accessibilityRole="header">
          How to run it
        </Text>
        <NumberedSteps steps={STEPS} />
      </View>

      {error ? <Notice tone="danger" title="Not scheduled" message={error} /> : null}
    </Screen>
  );
}
