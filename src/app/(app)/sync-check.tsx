import { useQuery, useStatus } from '@powersync/react-native';
import { useEffect, useReducer } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, Card, Screen, StatusPill, Text } from '@/components';
import { SYNC_CHECK_SUBJECT_PREFIX, SYNC_CHECK_TABLE } from '@/db/constants';
import { db } from '@/db/database';
import { useUploadFailures, useUploadQueueCount } from '@/db/hooks';
import type { StudySessionRow } from '@/db/schema';
import { createProbeRow, verifyOnServer } from '@/db/syncCheck';
import { StepList } from '@/features/sync/StepList';
import {
  describeCheckResult,
  initialSyncCheckState,
  stepIndex,
  STEPS,
  STILL_ONLINE_MESSAGE,
  syncCheckReducer,
  type StepId,
} from '@/features/sync/syncCheckFlow';
import { SyncStatusCard } from '@/features/sync/SyncStatusCard';
import { haptic, useTheme } from '@/theme';

type ProbeRow = Pick<StudySessionRow, 'id' | 'focus_subject' | 'created_at'>;

/** An id no row has: asking for it only tells us whether the server answers at all. */
const PROBE_REACHABILITY_ID = '00000000-0000-0000-0000-000000000000';

/** What each step asks the user to do, in plain words. */
const INSTRUCTIONS: Record<StepId, string> = {
  'airplane-on':
    'Open quick settings and turn on airplane mode. Also turn Wi-Fi off if it stays on. This proves the app works with no connection.',
  'create-row': 'Tap the button below. It saves a test row on this phone only — no internet needed.',
  'airplane-off': 'Turn airplane mode off (and Wi-Fi back on). Stay on this screen.',
  'wait-upload': 'The phone is sending the test row to the server. This moves on by itself when the count reaches 0.',
  'check-server': 'Ask the server directly whether the test row is in Postgres.',
};

/**
 * The Phase 0 gate: a row created offline on the phone must appear in Postgres after reconnecting.
 * One step and one primary action at a time; everything else on the screen is supporting evidence.
 */
export default function SyncCheckScreen() {
  const { user, supabase } = useAuth();
  const { colors, space } = useTheme();
  const status = useStatus();
  const queueCount = useUploadQueueCount(1000);
  const failures = useUploadFailures();
  const { data: probes } = useQuery<ProbeRow>(
    `SELECT id, focus_subject, created_at FROM ${SYNC_CHECK_TABLE} WHERE focus_subject LIKE ? ORDER BY created_at DESC LIMIT 5`,
    [`${SYNC_CHECK_SUBJECT_PREFIX}%`],
  );
  const [state, dispatch] = useReducer(syncCheckReducer, initialSyncCheckState);

  useEffect(() => {
    dispatch({ type: 'queue-count', count: queueCount });
  }, [queueCount, state.step]);

  const probeStoredLocally = state.probe !== null && probes.some((row) => row.id === state.probe?.id);

  const createRow = async () => {
    if (!user) return;
    dispatch({ type: 'create-started' });
    // Gate precondition: the server must be unreachable right before the local write. PowerSync's
    // "connected" flag is not enough (it is also false when PowerSync is misconfigured), and Android
    // can keep Wi-Fi on in airplane mode. Any HTTP answer, even an error, means the phone is online.
    const reach = await verifyOnServer(supabase, PROBE_REACHABILITY_ID);
    if (reach !== 'offline') {
      dispatch({ type: 'create-failed', message: STILL_ONLINE_MESSAGE });
      haptic('warning');
      return;
    }
    try {
      const probe = await createProbeRow(user.id);
      dispatch({ type: 'create-succeeded', probe });
      haptic('success');
    } catch (error) {
      dispatch({ type: 'create-failed', message: `Could not save the row on this phone: ${String(error)}` });
      haptic('error');
    }
  };

  const checkServer = async () => {
    if (!state.probe) return;
    dispatch({ type: 'check-started' });
    const result = await verifyOnServer(supabase, state.probe.id);
    const streamConnected = db.currentStatus.connected;
    dispatch({ type: 'check-finished', result, streamConnected });
    haptic(result === 'found' && streamConnected ? 'success' : 'warning');
  };

  const primary = (() => {
    switch (state.step) {
      case 'airplane-on':
        return <Button label="Airplane mode is on" size="comfortable" onPress={() => dispatch({ type: 'airplane-on-confirmed' })} />;
      case 'create-row':
        return <Button label="Create test row" size="comfortable" loading={state.busy} onPress={createRow} />;
      case 'airplane-off':
        return <Button label="Airplane mode is off" size="comfortable" onPress={() => dispatch({ type: 'airplane-off-confirmed' })} />;
      case 'wait-upload':
        return (
          <Button
            label={`Waiting to upload: ${queueCount ?? '…'}`}
            size="comfortable"
            disabled
            accessibilityLabel={`Waiting to upload. ${queueCount ?? 'Unknown'} changes left.`}
          />
        );
      case 'check-server':
        return (
          <Button
            label={state.result ? 'Check Postgres again' : 'Check Postgres'}
            size="comfortable"
            loading={state.busy}
            onPress={checkServer}
          />
        );
      case 'passed':
        return <Button label="Run it again" variant="secondary" size="comfortable" onPress={() => dispatch({ type: 'restart' })} />;
    }
  })();

  return (
    <Screen edges={['bottom', 'left', 'right']} footer={primary}>
      <StepList steps={STEPS} current={stepIndex(state.step)} />

      {state.step === 'passed' ? (
        <Card accessibilityLiveRegion="polite" style={{ borderWidth: 2, borderColor: colors.success.text }}>
          <StatusPill tone="success" label="PASS" accessibilityLabel="Sync check passed" />
          <Text variant="title">The row made offline is in Postgres.</Text>
          <Text tone="secondary">That is the Phase 0 gate: offline writes on this phone reach the server.</Text>
        </Card>
      ) : (
        <Card tint="mind" accessibilityLiveRegion="polite">
          <Text variant="caption" tone="mind" style={{ fontWeight: '600' }}>
            Step {stepIndex(state.step) + 1} of {STEPS.length}
          </Text>
          <Text variant="title">{STEPS[stepIndex(state.step)].title}</Text>
          <Text>{INSTRUCTIONS[state.step]}</Text>
          <StepHint step={state.step} connected={status.connected} queueCount={queueCount} />
          {state.result ? (
            <Text tone={describeCheckResult(state.result).tone}>{describeCheckResult(state.result).text}</Text>
          ) : null}
          {state.error ? <Text tone="danger">{state.error}</Text> : null}
        </Card>
      )}

      {state.probe ? (
        <Card>
          <Text variant="subtitle">Test row</Text>
          <Text variant="mono" selectable>
            {state.probe.id}
          </Text>
          <Text tone="secondary">Created {new Date(state.probe.createdAt).toLocaleTimeString()}</Text>
          <StatusPill
            tone={probeStoredLocally ? 'success' : 'neutral'}
            label={probeStoredLocally ? 'Stored on this phone' : 'Looking for it on this phone…'}
          />
        </Card>
      ) : null}

      {failures.length > 0 ? (
        <Card>
          <Text variant="subtitle">Upload problems</Text>
          <Text tone="secondary">The server refused these changes, so they were set aside instead of retried.</Text>
          {failures.slice(0, 5).map((failure) => (
            <View key={failure.id} style={{ gap: space[1] }}>
              <StatusPill tone="danger" label={`${failure.error_code ?? 'no code'} · ${failure.op ?? ''} ${failure.table_name ?? ''}`} />
              <Text variant="caption" tone="secondary" numberOfLines={3}>
                {failure.error_message}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      <SyncStatusCard />

      <Card>
        <Text variant="subtitle">Test rows on this phone</Text>
        {probes.length === 0 ? (
          <Text tone="secondary">None yet.</Text>
        ) : (
          probes.map((row) => (
            <View key={row.id} style={{ gap: space[1] }}>
              <Text variant="mono" selectable numberOfLines={1}>
                {row.id}
              </Text>
              <Text variant="caption" tone="secondary">
                {row.created_at ? new Date(row.created_at).toLocaleString() : 'unknown time'}
                {row.id === state.probe?.id ? ' · this run' : ''}
              </Text>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

/** A live hint that tells the user whether the phone agrees with what the step expects. */
function StepHint({ step, connected, queueCount }: { step: StepId; connected: boolean; queueCount: number | null }) {
  if (step === 'airplane-on') {
    // PowerSync's stream state, not proof the phone is offline: the Create step checks that itself.
    return connected ? (
      <StatusPill tone="warning" label="Sync server still connected — wait a few seconds after switching" />
    ) : (
      <StatusPill tone="neutral" label="Sync server not connected" />
    );
  }
  if (step === 'airplane-off' || step === 'wait-upload') {
    return connected ? (
      <StatusPill tone="success" label="Sync server connected" />
    ) : (
      <StatusPill tone="neutral" label="Waiting for the sync server…" />
    );
  }
  if (step === 'create-row' && queueCount !== null && queueCount > 0) {
    return <StatusPill tone="neutral" label={`${queueCount} change${queueCount === 1 ? '' : 's'} already waiting to upload`} />;
  }
  return null;
}
