import { secureStorage } from '@/lib/secureStorage';

/**
 * Remembers which account the local database belongs to.
 *
 * The local database is only wiped on an explicit sign-out. When the session ends any other way (the
 * refresh token was revoked, or the stored session became unreadable), the rows stay so that writes
 * still waiting to upload are not lost if the same person signs back in. This marker makes that safe:
 * if a different account signs in next, SyncLifecycle clears the database before connecting, so one
 * person never sees another person's rows.
 */
const OWNER_KEY = 'dualrep-local-data-owner';

/** The owner's user id; null when unknown. Throws if secure storage cannot be read. */
export function getLocalDataOwner(): Promise<string | null> {
  return secureStorage.getItem(OWNER_KEY);
}

export function setLocalDataOwner(userId: string): Promise<void> {
  return secureStorage.setItem(OWNER_KEY, userId);
}

export function clearLocalDataOwner(): Promise<void> {
  return secureStorage.removeItem(OWNER_KEY);
}
