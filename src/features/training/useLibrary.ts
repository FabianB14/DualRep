import { useQuery } from '@powersync/react-native';
import { useMemo } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import type { ExerciseRow } from '@/db/schema';

import { libraryView, type LibraryView } from './library';

export type UseLibraryResult = LibraryView & {
  /**
   * True until the first local read of the exercises table finishes. The bundled starter library is
   * in the view from the first render, so callers can build a circuit without waiting.
   */
  isLoading: boolean;
};

/**
 * The exercise library, live: every exercises row on the phone (library rows, the user's own and
 * group mates' shared ones) merged with the bundled starter library (see library.ts), plus the pool
 * the default circuits pick from for the signed-in user. Reads only the local database, so it works
 * offline; it re-renders when a sync or a local write changes the table. If the read fails, the view
 * keeps the starter library, so the loop still has exercises. Must be used under
 * `PowerSyncContext.Provider` and `AuthProvider`.
 */
export function useLibrary(): UseLibraryResult {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { data, isLoading } = useQuery<ExerciseRow>(`SELECT * FROM ${TABLE.exercises}`);
  const view = useMemo(() => libraryView(data, userId), [data, userId]);
  return useMemo(() => ({ ...view, isLoading }), [view, isLoading]);
}
