import { useQuery } from '@powersync/react-native';
import { useMemo } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import type { PresetRow } from '@/db/schema';

import { mergePresets, type PresetList } from './presets';

/**
 * Every preset the user can pick, live from the local database: the six system presets (bundled, so
 * they are there before the first sync) and the user's own. Must be used under
 * `PowerSyncContext.Provider` and `AuthProvider`.
 */
export function usePresets(): PresetList & { isLoading: boolean } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { data, isLoading } = useQuery<PresetRow>(`SELECT id, owner_id, name, kind, split FROM ${TABLE.presets}`);
  const list = useMemo(() => mergePresets(data, userId), [data, userId]);
  return useMemo(() => ({ ...list, isLoading }), [list, isLoading]);
}
