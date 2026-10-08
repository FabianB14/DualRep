import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { disconnectAndClearSync } from '@/db/database';
import { clearLocalDataOwner } from '@/features/sync/localDataOwner';
import { secureStorage } from '@/lib/secureStorage';
import { AUTH_STORAGE_KEY, readStoredSession } from '@/lib/supabase';

import { authErrorMessage } from './errors';
import { normalizeEmail } from './validation';

export type AuthResult = { ok: true } | { ok: false; message: string };

export type AuthContextValue = {
  supabase: SupabaseClient;
  session: Session | null;
  user: User | null;
  /** True until the first session check finishes (render a neutral screen, not the sign-in form). */
  loading: boolean;
  /**
   * True when the session is the copy saved on this device because supabase-js could not refresh an
   * expired token (offline). The app works locally; syncing resumes once the token refreshes online.
   */
  offlineSession: boolean;
  /** Emails a 6-digit sign-in code; creates the account on first use. */
  signInWithEmailCode(email: string): Promise<AuthResult>;
  verifyEmailCode(email: string, token: string): Promise<AuthResult>;
  /** Stops sync, deletes this device's local data (including unsent writes), then signs out. */
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

type AuthState = { session: Session | null; offlineSession: boolean; loading: boolean };

export function AuthProvider({ client, children }: { client: SupabaseClient; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, offlineSession: false, loading: true });

  useEffect(() => {
    let active = true;
    // Bumped on every auth event. Async fallbacks below only apply if no newer event has arrived.
    let version = 0;
    const apply = (session: Session | null, offlineSession: boolean) => {
      if (active) setState({ session, offlineSession, loading: false });
    };

    // Fast path: show the app from the stored session right away. supabase-js only reports the
    // initial session after refreshing an expired token, which offline means retrying for up to ~30 s.
    readStoredSession().then((stored) => {
      if (version === 0) apply(stored, false);
    });

    // The callback stays synchronous and never calls supabase-js (doing so inside it can deadlock).
    const { data } = client.auth.onAuthStateChange((event, session) => {
      version += 1;
      const seen = version;
      if (session) {
        apply(session, false);
      } else if (event === 'INITIAL_SESSION') {
        // null here means either "signed out" or "the expired token could not be refreshed offline";
        // in the second case supabase-js keeps the session in storage, so storage tells them apart.
        void readStoredSession().then((stored) => {
          if (seen === version) apply(stored, stored !== null);
        });
      } else {
        apply(null, false);
      }
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const signInWithEmailCode = useCallback(
    async (email: string): Promise<AuthResult> => {
      try {
        const { error } = await client.auth.signInWithOtp({
          email: normalizeEmail(email),
          options: { shouldCreateUser: true },
        });
        return error ? { ok: false, message: authErrorMessage(error) } : { ok: true };
      } catch (error) {
        return { ok: false, message: authErrorMessage(error as Error) };
      }
    },
    [client],
  );

  const verifyEmailCode = useCallback(
    async (email: string, token: string): Promise<AuthResult> => {
      try {
        const { error } = await client.auth.verifyOtp({ email: normalizeEmail(email), token: token.trim(), type: 'email' });
        // On success supabase-js emits SIGNED_IN, which updates the session above.
        return error ? { ok: false, message: authErrorMessage(error) } : { ok: true };
      } catch (error) {
        return { ok: false, message: authErrorMessage(error as Error) };
      }
    },
    [client],
  );

  const signOut = useCallback(async () => {
    // Local data first, so the next person on this phone never sees this account's rows even if the
    // network call below fails.
    try {
      await disconnectAndClearSync();
      await clearLocalDataOwner();
    } catch (error) {
      console.warn('[auth] could not clear local data during sign-out', error);
    }
    // 'local' revokes this device's session only; the account stays signed in on the user's other devices.
    const { error } = await client.auth.signOut({ scope: 'local' }).catch((e: unknown) => ({ error: e }));
    if (error) {
      // supabase-js keeps the session when it cannot load it first (an expired token while offline).
      // Signing out must work offline too, so remove the stored session directly; the server-side
      // refresh token then simply expires unused.
      console.warn('[auth] sign-out request failed; removing the stored session locally', error);
      await Promise.all(
        [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`, `${AUTH_STORAGE_KEY}-user`].map((key) =>
          secureStorage.removeItem(key).catch(() => undefined),
        ),
      );
    }
    // No auth event fires when storage was cleared directly, so update the state here as well.
    setState({ session: null, offlineSession: false, loading: false });
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      supabase: client,
      session: state.session,
      user: state.session?.user ?? null,
      loading: state.loading,
      offlineSession: state.offlineSession,
      signInWithEmailCode,
      verifyEmailCode,
      signOut,
    }),
    [client, state, signInWithEmailCode, verifyEmailCode, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
