import { View } from 'react-native';

import { useTheme } from '@/theme';

import { Card } from './Card';
import { Text } from './Text';

export type Stat = { value: number; label: string };

export type StatCardProps = {
  /** Two to four numbers side by side, each with its label ("3 focus blocks"). */
  stats: readonly Stat[];
  /** Spoken instead of the numbers one by one; defaults to them as one sentence. */
  accessibilityLabel?: string;
};

/** "3 focus blocks, 75 focus minutes, 24 sets." */
export function statsSentence(stats: readonly Stat[]): string {
  return `${stats.map((stat) => `${stat.value} ${stat.label}`).join(', ')}.`;
}

/**
 * A row of big numbers with a label under each: today's totals on Home, a cycle's summary. A screen
 * reader hears the whole card as one sentence instead of numbers and labels as separate stops.
 */
export function StatCard({ stats, accessibilityLabel }: StatCardProps) {
  const { space } = useTheme();
  return (
    <Card accessible accessibilityLabel={accessibilityLabel ?? statsSentence(stats)}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space[3] }}>
        {stats.map((stat) => (
          <View key={stat.label} style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="title" accessibilityRole="text">
              {stat.value}
            </Text>
            <Text variant="caption" tone="secondary" align="center">
              {stat.label}
            </Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
