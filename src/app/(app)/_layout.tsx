import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

export default function AppLayout() {
  const { colors, reduceMotion } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: reduceMotion ? 'fade' : 'default',
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" />
      {/* A visible back button: the way out is always on screen, not only the system gesture. */}
      <Stack.Screen name="sync-check" options={{ headerShown: true, title: 'Sync check' }} />
    </Stack>
  );
}
