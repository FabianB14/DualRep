import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { readEnv } from './env';
import { secureStorage } from './secureStorage';

/**
 * Where supabase-js keeps the session in secure storage. Set explicitly (instead of the default
 * `sb-<project-ref>-auth-token`) so the app can read the stored session itself; see readStoredSession.
 */
export const AUTH_STORAGE_KEY = 'dualrep-auth';

const env = readEnv();

/**
 * The app's Supabase client, or null when the build has no valid configuration (the root layout then
 * shows "Setup needed" instead of the app, so nothing else should run with a null client).
 */
export const supabase: SupabaseClient | null = env.ok
  ? createClient(env.supabaseUrl, env.supabaseKey, {
      auth: {
        storage: secureStorage,
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // Native app: sign-in is a typed email code, never a redirect back with tokens in a URL.
        detectSessionInUrl: false,
      },
    })
  : null;

if (supabase) {
  const client = supabase;
  // On React Native supabase-js cannot tell when the app is in the foreground, so token refresh is
  // driven from AppState: refresh while visible, stop in the background (no timers while suspended).
  // The 'change' event does not fire for the state at launch, hence the explicit first call.
  if (AppState.currentState === 'active') client.auth.startAutoRefresh();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') client.auth.startAutoRefresh();
    else client.auth.stopAutoRefresh();
  });
}

/**
 * The session saved on this device, read straight from secure storage without any network call.
 *
 * Why: when the access token has expired and the phone is offline, supabase-js cannot refresh it and
 * reports "no session" (INITIAL_SESSION with null), although the session — and its refresh token —
 * is still stored and will refresh as soon as the network is back. An offline-first app must not
 * treat that as signed out, so AuthProvider falls back to this stored copy. It only contains what
 * supabase-js itself saved for this device, and anything that talks to the server still goes through
 * supabase-js, which refreshes (or rejects) the token properly.
 */
export async function readStoredSession(): Promise<Session | null> {
  try {
    const raw = await secureStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStoredSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<Session>;
  return (
    typeof session.access_token === 'string' &&
    typeof session.refresh_token === 'string' &&
    session.refresh_token.length > 0 &&
    typeof session.user === 'object' &&
    session.user !== null &&
    typeof session.user.id === 'string'
  );
}
