import { useQuery } from '@powersync/react-native';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';

import {
  focusBlockFromRow,
  groupWorkouts,
  HISTORY_LIMIT,
  RECENT_BLOCKS_SQL,
  RECENT_SETS_SQL,
  RECENT_WORKOUTS_SQL,
  startOfLocalDay,
  summarizeToday,
  TODAY_BLOCKS_SQL,
  TODAY_SETS_SQL,
  type BlockRow,
  type FocusBlockEntry,
  type HistorySetRow,
  type TodaySummary,
  type WorkoutEntry,
  type WorkoutRow,
} from './history';

/**
 * Recent focus blocks and workouts (with their sets), live from the local database. Must be used under
 * `PowerSyncContext.Provider` and `AuthProvider`.
 */
export function useHistory(limit: number = HISTORY_LIMIT): {
  blocks: FocusBlockEntry[];
  workouts: WorkoutEntry[];
  isLoading: boolean;
} {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const blocks = useQuery<BlockRow>(RECENT_BLOCKS_SQL, [userId, limit]);
  const workouts = useQuery<WorkoutRow>(RECENT_WORKOUTS_SQL, [userId, limit]);
  const sets = useQuery<HistorySetRow>(RECENT_SETS_SQL, [userId, limit]);
  return useMemo(
    () => ({
      blocks: blocks.data.map(focusBlockFromRow),
      workouts: groupWorkouts(workouts.data, sets.data),
      isLoading: blocks.isLoading || workouts.isLoading || sets.isLoading,
    }),
    [blocks.data, blocks.isLoading, workouts.data, workouts.isLoading, sets.data, sets.isLoading],
  );
}

/**
 * The start of the phone's local day, as ISO text. It moves on at midnight (checked when the app
 * comes back to the foreground and once a minute while it is open), so "today" never goes stale.
 */
export function useStartOfToday(): string {
  const [start, setStart] = useState(() => startOfLocalDay(Date.now()));
  useEffect(() => {
    const check = () => setStart(startOfLocalDay(Date.now()));
    const timer = setInterval(check, 60_000);
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') check();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return useMemo(() => new Date(start).toISOString(), [start]);
}

/** Today's focus blocks, focus minutes and sets, live, and when today started (ISO). */
export function useTodaySummary(): TodaySummary & { since: string; isLoading: boolean } {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const since = useStartOfToday();
  const blocks = useQuery<BlockRow>(TODAY_BLOCKS_SQL, [userId, since]);
  const sets = useQuery<{ n: number }>(TODAY_SETS_SQL, [userId, since]);
  const count = sets.data[0]?.n ?? 0;
  return useMemo(
    () => ({ ...summarizeToday(blocks.data, count), since, isLoading: blocks.isLoading || sets.isLoading }),
    [blocks.data, blocks.isLoading, count, since, sets.isLoading],
  );
}
