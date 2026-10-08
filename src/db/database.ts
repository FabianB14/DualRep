// React Native's global declarations (__DEV__); TypeScript 6 no longer loads them implicitly.
/// <reference types="react-native" />
import { createConsoleLogger, LogLevels, PowerSyncDatabase } from '@powersync/react-native';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SupabaseConnector } from './connector';
import { DB_FILENAME } from './constants';
import { AppSchema } from './schema';

/**
 * The app's single local database. Constructing it opens nothing yet (op-sqlite opens lazily on first
 * use), so importing this module is cheap; it does need the native module, i.e. a development build.
 */
export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: DB_FILENAME },
  logger: createConsoleLogger({ minLevel: __DEV__ ? LogLevels.info : LogLevels.warn }),
});

/** Which Supabase client and PowerSync URL the current connection was opened with. */
let connectedWith: { supabase: SupabaseClient; powersyncUrl: string } | null = null;

/**
 * connect/disconnect calls are chained so that, e.g., a sign-out that happens while a connect is still
 * in flight runs after it and wins, instead of the two interleaving.
 */
let lifecycle: Promise<void> = Promise.resolve();

function serialize(task: () => Promise<void>): Promise<void> {
  const run = lifecycle.then(task);
  // Keep the chain alive after a failure; the caller still sees the rejection through `run`.
  lifecycle = run.catch(() => undefined);
  return run;
}

/**
 * Starts syncing for the signed-in user. Idempotent: calling it again with the same client and URL
 * (e.g. on every auth state event) does nothing while that connection is open. It does not wait for
 * the network — offline, the SDK keeps retrying in the background and local reads/writes work.
 * All streams use auto_subscribe, so no stream needs to be subscribed explicitly.
 */
export function connectSync(supabase: SupabaseClient, powersyncUrl: string): Promise<void> {
  return serialize(async () => {
    if (connectedWith?.supabase === supabase && connectedWith.powersyncUrl === powersyncUrl) return;
    await db.init();
    await db.connect(new SupabaseConnector(supabase, powersyncUrl));
    connectedWith = { supabase, powersyncUrl };
  });
}

/**
 * Stops syncing and deletes all local data, including the local-only upload_failures log, so the next
 * user on this device never sees the previous user's rows. Writes still waiting in the upload queue
 * are lost too: callers should warn before signing out while getUploadQueueCount() > 0.
 */
export function disconnectAndClearSync(): Promise<void> {
  return serialize(async () => {
    connectedWith = null;
    await db.disconnectAndClear();
  });
}
