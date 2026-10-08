import { ActivityIndicator, View } from 'react-native';

import { useTheme } from '@/theme';

/** A calm full-screen placeholder while the stored session is read (usually a few milliseconds). */
export function LoadingView() {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}
    >
      <ActivityIndicator size="large" color={colors.mind.solid} />
    </View>
  );
}
