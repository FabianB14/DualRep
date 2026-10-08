import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

/**
 * The signed-in screens. Every screen but Home and the cycle shows a header with a visible back
 * button: the way out is always on screen, not only the system gesture. The cycle screen has no
 * header; it draws its own exit button, so a running timer fills the screen.
 */
export default function AppLayout() {
  const { colors, reduceMotion } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        contentStyle: { backgroundColor: colors.background },
        animation: reduceMotion ? 'fade' : 'default',
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false, title: 'Today' }} />
      <Stack.Screen name="cycle" options={{ headerShown: false, title: 'Study and move' }} />
      <Stack.Screen name="setups/index" options={{ title: 'Setups' }} />
      <Stack.Screen name="setups/[id]" options={{ title: 'Setup' }} />
      <Stack.Screen name="presets/index" options={{ title: 'Presets' }} />
      <Stack.Screen name="presets/[id]" options={{ title: 'Custom split' }} />
      <Stack.Screen name="library/index" options={{ title: 'Exercise library' }} />
      <Stack.Screen name="library/[id]" options={{ title: 'Exercise' }} />
      <Stack.Screen name="library/new" options={{ title: 'Add an exercise' }} />
      <Stack.Screen name="history" options={{ title: 'History' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="sync-check" options={{ title: 'Sync check' }} />
      <Stack.Screen name="timer-check" options={{ title: 'Timer check' }} />
    </Stack>
  );
}
