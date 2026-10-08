import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Text } from '@/components';
import { haptic, useTheme } from '@/theme';

/**
 * Leaves the cycle screen for Home. The cycle keeps running (its state is on the phone), and Home
 * offers the way back.
 */
export function leaveCycleScreen(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export type TopBarProps = {
  /** What this phase is ("Focus block 2", "Workout"). */
  title: string;
  /** A second line ("Round 1 of 3 · Exercise 2 of 4"). */
  subtitle?: string;
  accent?: 'mind' | 'body';
  /** A control at the right edge. */
  trailing?: ReactNode;
  /** What the close button does (default: leave for Home). */
  onClose?: () => void;
  /** True while a cycle runs: the close button then says the cycle keeps going. */
  running?: boolean;
};

/**
 * The cycle screen's own header (the stack header is hidden so a running timer fills the screen):
 * a visible way back to Home on the left, where the phase is, and an optional action on the right.
 */
export function TopBar({ title, subtitle, accent = 'mind', trailing, onClose = leaveCycleScreen, running = false }: TopBarProps) {
  const { colors, radius, space, touch } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: touch.min }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        accessibilityHint={running ? 'Back to Today. Your cycle keeps running.' : 'Back to Today'}
        onPress={() => {
          haptic('tap');
          onClose();
        }}
        hitSlop={4}
        style={({ pressed }) => ({
          width: touch.min,
          height: touch.min,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          marginLeft: -space[3],
          backgroundColor: pressed ? colors.surfaceMuted : 'transparent',
        })}
      >
        <Glyph name="close" color={colors.text} size={24} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text variant="label" style={{ color: colors[accent].text }} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}
