import { Stack } from 'expo-router';

import { useReviewReminders } from '@/features/study/hooks';
import { useTheme } from '@/theme';

/**
 * The signed-in screens. Every screen but Home and the cycle shows a header with a visible back
 * button: the way out is always on screen, not only the system gesture. The cycle screen has no
 * header; it draws its own exit button, so a running timer fills the screen.
 */
export default function AppLayout() {
  const { colors, reduceMotion } = useTheme();
  return (
    <>
      <ReviewReminders />
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
        <Stack.Screen name="plans/index" options={{ title: 'Study plans' }} />
        <Stack.Screen name="plans/new" options={{ title: 'New plan' }} />
        <Stack.Screen name="plans/[id]/index" options={{ title: 'Plan' }} />
        <Stack.Screen name="plans/[id]/edit" options={{ title: 'Plan settings' }} />
        <Stack.Screen name="plans/[id]/add" options={{ title: 'Add material' }} />
        <Stack.Screen name="plans/[id]/check/[sourceId]" options={{ title: 'Check the transcription' }} />
        <Stack.Screen name="plans/[id]/outline" options={{ title: 'Review the outline' }} />
        <Stack.Screen name="plans/[id]/cards/index" options={{ title: 'Cards' }} />
        <Stack.Screen name="plans/[id]/cards/[cardId]" options={{ title: 'Card' }} />
        <Stack.Screen name="plans/[id]/map" options={{ title: 'Concept map' }} />
        <Stack.Screen name="history" options={{ title: 'History' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="sync-check" options={{ title: 'Sync check' }} />
        <Stack.Screen name="timer-check" options={{ title: 'Timer check' }} />
      </Stack>
    </>
  );
}

/**
 * Keeps the daily "cards to review" reminder in step with the cards due (on start, on return to the
 * app, after syncs and answers, and when its setting changes). Its own component, so its live
 * queries re-render only itself, never the navigator.
 */
function ReviewReminders(): null {
  useReviewReminders();
  return null;
}
