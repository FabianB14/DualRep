import { View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export type NumberedStepsProps = {
  /** The steps, in order, one short sentence each. */
  steps: readonly string[];
  /** The numbers' color: mind (study, settings) or body (exercises). */
  accent?: 'mind' | 'body';
};

/**
 * Steps to follow, numbered ("1. Stand with feet hip-width apart."): how to do an exercise, how to run
 * the timer check. The number sits in its own column so wrapped lines stay aligned, and a screen reader
 * hears each step as one item ("1. Stand with …") rather than the number on its own.
 */
export function NumberedSteps({ steps, accent = 'mind' }: NumberedStepsProps) {
  const { space } = useTheme();
  return (
    <View accessibilityRole="list" style={{ gap: space[2] }}>
      {steps.map((step, index) => (
        <View
          key={`${index}:${step}`}
          accessible
          accessibilityLabel={`${index + 1}. ${step}`}
          style={{ flexDirection: 'row', gap: space[3] }}
        >
          <Text tone={accent} style={{ fontWeight: '700', minWidth: 20 }}>
            {index + 1}.
          </Text>
          <Text style={{ flex: 1 }}>{step}</Text>
        </View>
      ))}
    </View>
  );
}
