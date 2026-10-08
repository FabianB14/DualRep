import { View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export type StatusPillProps = {
  label: string;
  tone?: StatusTone;
  /** Read by screen readers instead of the short label, e.g. "Sync status: connected". */
  accessibilityLabel?: string;
};

/**
 * A short status label. Color is never the only signal: the label states the status in words, and the
 * dot's shape differs for problems (square) so it also reads in grayscale.
 */
export function StatusPill({ label, tone = 'neutral', accessibilityLabel }: StatusPillProps) {
  const { colors, radius, space } = useTheme();
  const toneColors = colors[tone];
  const problem = tone === 'danger' || tone === 'warning';

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[1],
        borderRadius: radius.pill,
        backgroundColor: toneColors.subtle,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: problem ? 1 : 4,
          backgroundColor: toneColors.text,
        }}
      />
      <Text variant="caption" style={{ color: toneColors.text, fontWeight: '600' }}>
        {label}
      </Text>
    </View>
  );
}
