import type { StatusTone } from '@/components/StatusPill';

/**
 * Plain-words summaries of PowerSync's status for the status card. Pure (no SDK import) so the wording
 * is unit-tested; the card passes in fields of `useStatus()` and the upload queue count.
 */

export type SyncSnapshot = {
  connected: boolean;
  connecting: boolean;
  uploading: boolean;
  downloading: boolean;
  lastSyncedAt?: Date;
  uploadError?: Error;
  downloadError?: Error;
  /** Local writes not yet acknowledged by the server; null while unknown. */
  pendingUploads: number | null;
  /** The session is the device's stored copy because the token could not be refreshed (offline). */
  offlineSession?: boolean;
};

export type SyncSummary = { tone: StatusTone; label: string; detail: string };

export function summarizeSync(s: SyncSnapshot): SyncSummary {
  if (s.uploadError) {
    return {
      tone: 'warning',
      label: 'Upload problem',
      detail: 'Your changes are safe on this phone. The app keeps retrying the upload.',
    };
  }
  if (s.connected) {
    if (s.uploading) return { tone: 'info', label: 'Uploading', detail: 'Sending changes from this phone.' };
    if (s.downloading) return { tone: 'info', label: 'Downloading', detail: 'Getting the latest data.' };
    if (s.pendingUploads !== null && s.pendingUploads > 0) {
      return { tone: 'info', label: 'Uploading soon', detail: 'Changes are queued and will be sent shortly.' };
    }
    return { tone: 'success', label: 'Up to date', detail: 'This phone and the server match.' };
  }
  if (s.connecting) return { tone: 'neutral', label: 'Connecting', detail: 'Trying to reach the sync server.' };
  if (s.offlineSession) {
    return {
      tone: 'neutral',
      label: 'Offline',
      detail: 'Working from this phone. Syncing starts again when you are back online.',
    };
  }
  return {
    tone: 'neutral',
    label: 'Offline',
    detail: 'Changes are saved on this phone and upload when the connection is back.',
  };
}

/** "just now", "45 s ago", "3 min ago", "2 h ago", "4 days ago", or "never". */
export function formatSince(date: Date | undefined, now: Date): string {
  if (!date) return 'never';
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function describeActivity(s: Pick<SyncSnapshot, 'uploading' | 'downloading'>): string {
  if (s.uploading && s.downloading) return 'Uploading and downloading';
  if (s.uploading) return 'Uploading';
  if (s.downloading) return 'Downloading';
  return 'Idle';
}
