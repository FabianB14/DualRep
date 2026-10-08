import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { connectSync, disconnectAndClearSync } from '@/db/database';
import { cancelAllAlerts } from '@/features/timer/notifications';

import { getLocalDataOwner, setLocalDataOwner } from './localDataOwner';

/**
 * Starts PowerSync whenever someone is signed in. Renders nothing.
 *
 * - Signed in: connectSync (idempotent, does not wait for the network — offline, local reads and
 *   writes work at once and the SDK keeps retrying in the background).
 * - Explicit sign-out: AuthProvider.signOut() calls disconnectAndClearSync() before signing out.
 * - Session lost any other way (refresh token revoked): nothing is deleted here, so unsent writes
 *   survive if the same person signs back in. Meanwhile the connector returns no credentials, so
 *   nothing syncs down, and any upload attempt (the SDK tries again on the next local write or when
 *   the stream reconnects) is deferred by the connector (NoSessionError) without sending anything,
 *   until the same user signs in again and the queue goes up. If a different account signs in, the
 *   local database is cleared before connecting, and the previous account's alerts (a block-end alert
 *   scheduled before its session was lost) are withdrawn so they never ring for this one.
 * - Missing configuration: this component is not mounted (the root layout shows "Setup needed").
 *
 * Errors are logged, never thrown: a sync problem must not take the app down, and the Sync status card
 * shows the SDK's own connection and error state.
 */
export function SyncLifecycle({ powersyncUrl }: { powersyncUrl: string }): null {
  const { supabase, session } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    startSync(supabase, powersyncUrl, userId, () => cancelled).catch((error: unknown) => {
      console.warn('[sync] could not start sync', error);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, powersyncUrl, userId]);

  return null;
}

async function startSync(
  supabase: SupabaseClient,
  powersyncUrl: string,
  userId: string,
  isCancelled: () => boolean,
): Promise<void> {
  let owner: string | null | undefined;
  try {
    owner = await getLocalDataOwner();
  } catch (error) {
    // Unknown owner because secure storage failed: do not wipe (that could lose unsent writes).
    console.warn('[sync] could not read the local data owner', error);
    owner = undefined;
  }
  if (owner !== undefined && owner !== userId) {
    // Rows from another account (or of unknown origin) must never be shown to this one, nor its alerts.
    await cancelAllAlerts();
    await disconnectAndClearSync();
    await setLocalDataOwner(userId);
  }
  if (isCancelled()) return;
  await connectSync(supabase, powersyncUrl);
}
