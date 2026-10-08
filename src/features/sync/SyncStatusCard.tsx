import { useStatus } from '@powersync/react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Card, StatusPill, Text } from '@/components';
import { useUploadQueueCount } from '@/db/hooks';
import { useTheme } from '@/theme';

import { describeActivity, formatSince, summarizeSync } from './syncStatus';

/** Current time, refreshed on an interval so "3 min ago" stays true while the screen is open. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Live sync status: connection, last sync, activity and how many local writes are waiting to upload. */
export function SyncStatusCard() {
  const status = useStatus();
  const pendingUploads = useUploadQueueCount();
  const { offlineSession } = useAuth();
  const now = useNow(10_000);
  const { space } = useTheme();

  const snapshot = {
    connected: status.connected,
    connecting: status.connecting,
    uploading: status.dataFlowStatus.uploading,
    downloading: status.dataFlowStatus.downloading,
    lastSyncedAt: status.lastSyncedAt,
    uploadError: status.dataFlowStatus.uploadError,
    downloadError: status.dataFlowStatus.downloadError,
    pendingUploads,
    offlineSession,
  };
  const summary = summarizeSync(snapshot);
  const problem = snapshot.uploadError ?? (snapshot.connected ? undefined : snapshot.downloadError);

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] }}>
        <Text variant="subtitle">Sync</Text>
        <StatusPill tone={summary.tone} label={summary.label} accessibilityLabel={`Sync status: ${summary.label}`} />
      </View>
      <Text tone="secondary">{summary.detail}</Text>
      <View style={{ gap: space[2] }}>
        <Row label="Connected" value={snapshot.connected ? 'Yes' : snapshot.connecting ? 'Connecting…' : 'No'} />
        <Row label="Last synced" value={formatSince(snapshot.lastSyncedAt, now)} />
        <Row label="Activity" value={describeActivity(snapshot)} />
        <Row label="Waiting to upload" value={pendingUploads === null ? '…' : String(pendingUploads)} />
      </View>
      {problem ? (
        <Text variant="caption" tone="secondary" numberOfLines={3}>
          Last error: {problem.message}
        </Text>
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}
    >
      <Text tone="secondary">{label}</Text>
      <Text style={{ fontWeight: '600' }}>{value}</Text>
    </View>
  );
}
