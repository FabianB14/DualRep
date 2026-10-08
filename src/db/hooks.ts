import { usePowerSync, useQuery, useStatus } from '@powersync/react-native';
import { useEffect, useState } from 'react';

import { UPLOAD_FAILURES_TABLE } from './constants';
import type { UploadFailure } from './schema';

/**
 * Number of local writes waiting to be uploaded (null until first read). Must be used under
 * `PowerSyncContext.Provider`.
 *
 * The queue lives in PowerSync's internal ps_crud table, which watched queries do not observe, so the
 * count is re-read when the upload/connection state changes (an upload finishing, reconnecting) and on
 * a short poll that catches new local writes. Each read is a single COUNT on a small table.
 */
export function useUploadQueueCount(pollMs = 1000): number | null {
  const db = usePowerSync();
  const { connected, uploading, uploadError } = useStatus();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const read = () => {
      db.getUploadQueueStats().then(
        (stats) => {
          if (active) setCount(stats.count);
        },
        () => {
          // The database may be closing (sign-out); the next status change or tick reads again.
        },
      );
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // connected/uploading/uploadError are not read inside: they are listed so that a change re-reads now.
  }, [db, pollMs, connected, uploading, uploadError]);

  return count;
}

/** Live list of uploads the server rejected for good, newest first. */
export function useUploadFailures(): readonly UploadFailure[] {
  const { data } = useQuery<UploadFailure>(`SELECT * FROM ${UPLOAD_FAILURES_TABLE} ORDER BY created_at DESC`);
  return data;
}
