import { useQuery } from '@powersync/react-native';
import { useMemo } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import type { ProfileRow } from '@/db/schema';

import { profileFromRow, type ProfileSettings } from './profile';

/**
 * The signed-in user's settings, live from the local database (works offline). Before the profile
 * row has synced, `profile` holds the defaults with `synced: false`. Must be used under
 * `PowerSyncContext.Provider` and `AuthProvider`.
 */
export function useProfile(): { profile: ProfileSettings; userId: string | null; isLoading: boolean } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { data, isLoading } = useQuery<ProfileRow>(`SELECT * FROM ${TABLE.profiles} WHERE id = ?`, [userId ?? '']);
  const row = data[0] ?? null;
  const profile = useMemo(() => profileFromRow(row), [row]);
  return { profile, userId, isLoading };
}
