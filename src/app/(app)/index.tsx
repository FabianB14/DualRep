import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { Button, Screen, Text } from '@/components';
import { getUploadQueueCount } from '@/db/syncCheck';
import { SyncStatusCard } from '@/features/sync/SyncStatusCard';
import { useTheme } from '@/theme';

/** Phase 0 home: who is signed in, how sync is doing, and the one thing to do next — the sync check. */
export default function HomeScreen() {
  const { user, signOut } = useAuth();
  const { space } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  const doSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const confirmSignOut = async () => {
    // Signing out deletes this phone's copy of the data, including writes not uploaded yet.
    const pending = await getUploadQueueCount().catch(() => 0);
    const message =
      pending > 0
        ? `${pending} change${pending === 1 ? ' has' : 's have'} not been uploaded yet and will be lost. Connect to the internet first to keep ${pending === 1 ? 'it' : 'them'}.`
        : 'Your data stays safe on the server. This phone’s copy is removed.';
    Alert.alert('Sign out?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: pending > 0 ? 'Sign out and lose changes' : 'Sign out', style: 'destructive', onPress: () => void doSignOut() },
    ]);
  };

  return (
    <Screen footer={<Button label="Run the sync check" size="comfortable" onPress={() => router.push('/sync-check')} />}>
      <View style={{ gap: space[1], marginTop: space[4] }}>
        <Text variant="caption" tone="mind" style={{ fontWeight: '600' }}>
          Phase 0 · Foundation
        </Text>
        <Text variant="headline">DualRep</Text>
        <Text tone="secondary" numberOfLines={1}>
          Signed in as {user?.email ?? 'unknown'}
        </Text>
      </View>

      <SyncStatusCard />

      <Text tone="secondary">
        Next step: run the sync check. It proves that something you create with no signal reaches the server once
        you are back online.
      </Text>

      <View style={{ flexGrow: 1 }} />
      <Button variant="ghost" label="Sign out" loading={signingOut} onPress={confirmSignOut} />
    </Screen>
  );
}
