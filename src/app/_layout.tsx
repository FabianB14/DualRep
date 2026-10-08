// Must stay the first import: PowerSync's async-iterator APIs need Symbol.asyncIterator, which Hermes
// may not provide, before any module that uses them is evaluated.
import '@azure/core-asynciterator-polyfill';

import { PowerSyncContext } from '@powersync/react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider, Stack, type Theme as NavigationTheme } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { LoadingView } from '@/components';
import { db } from '@/db/database';
import { SetupNeeded } from '@/features/setup/SetupNeeded';
import { SyncLifecycle } from '@/features/sync/SyncLifecycle';
import { readEnv } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { ThemeProvider, useTheme } from '@/theme';

// Read once: the values are compiled into the bundle and cannot change while the app runs.
const env = readEnv();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SystemChrome />
          {env.ok && supabase ? (
            <SignedInApp client={supabase} powersyncUrl={env.powersyncUrl} />
          ) : (
            <SetupNeeded
              missing={env.ok ? [] : env.missing}
              invalid={env.ok ? [] : env.invalid}
              reasons={env.ok ? {} : env.reasons}
            />
          )}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Status-bar icons and the native root background follow the theme (no white flash in dark mode). */
function SystemChrome() {
  const { colors } = useTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => undefined);
  }, [colors.background]);
  return <StatusBar style="auto" />;
}

function SignedInApp({ client, powersyncUrl }: { client: SupabaseClient; powersyncUrl: string }) {
  return (
    <AuthProvider client={client}>
      <PowerSyncContext.Provider value={db}>
        <SyncLifecycle powersyncUrl={powersyncUrl} />
        <RootNavigator />
      </PowerSyncContext.Provider>
    </AuthProvider>
  );
}

/**
 * Signed-out users can only reach the (auth) group and signed-in users only the (app) group:
 * Stack.Protected removes the other group's screens, and expo-router redirects to the first
 * available screen whenever the guard flips (after verifying the code, or after signing out).
 */
function RootNavigator() {
  const { session, loading } = useAuth();
  const theme = useTheme();
  const navigationTheme = useMemo<NavigationTheme>(() => {
    const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.colors.mind.solid,
        background: theme.colors.background,
        card: theme.colors.background,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger.text,
      },
    };
  }, [theme]);

  if (loading) return <LoadingView />;
  const signedIn = session !== null;

  return (
    <NavigationThemeProvider value={navigationTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
          animation: theme.reduceMotion ? 'fade' : 'default',
        }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
    </NavigationThemeProvider>
  );
}
