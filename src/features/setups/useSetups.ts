import { useQuery } from '@powersync/react-native';
import { useMemo } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import type { EquipmentSetupRow } from '@/db/schema';
import type { Setup } from '@/features/training/types';

import { setupFromRow } from './setups';

/**
 * The user's equipment setups, live from the local database, oldest first (so "the first setup" is
 * stable). Empty until the user makes one. Must be used under `PowerSyncContext.Provider` and
 * `AuthProvider`.
 */
export function useSetups(): { setups: Setup[]; byId: ReadonlyMap<string, Setup>; isLoading: boolean } {
  const { user } = useAuth();
  const { data, isLoading } = useQuery<EquipmentSetupRow>(
    `SELECT id, name, location, equipment, created_at FROM ${TABLE.equipment_setups} WHERE user_id = ? ORDER BY created_at, id`,
    [user?.id ?? ''],
  );
  return useMemo(() => {
    const setups = data.map(setupFromRow);
    return { setups, byId: new Map(setups.map((setup) => [setup.id, setup])), isLoading };
  }, [data, isLoading]);
}
