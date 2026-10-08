import type { ReactNode } from 'react';
import { View, type AccessibilityProps } from 'react-native';

import { useTheme } from '@/theme';

import type { StatusTone } from './StatusPill';
import { Text } from './Text';

export type NoticeProps = Pick<AccessibilityProps, 'accessibilityLabel' | 'accessibilityLiveRegion'> & {
  /** Short heading in the tone's color ("Notifications are off"). */
  title?: string;
  message: string;
  tone?: StatusTone;
  /** An optional control under the message (e.g. "Open settings"). */
  action?: ReactNode;
};

/**
 * A quiet, non-blocking note: something worth knowing that needs no answer now (no profile synced
 * yet, notifications denied, an empty list, the spotter's advice after a set). A colored edge marks the
 * tone; the text itself stays in the regular colors so it is easy to read in both themes. A notice
 * whose message changes while the screen is open (the spotter's) is a live region, so a screen reader
 * reads each new message once.
 */
export function Notice({ title, message, tone = 'info', action, accessibilityLabel, accessibilityLiveRegion }: NoticeProps) {
  const { colors, radius, space } = useTheme();
  return (
    <View
      accessible={action === undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion={accessibilityLiveRegion}
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        overflow: 'hidden',
      }}
    >
      <View style={{ width: 4, backgroundColor: colors[tone].text }} />
      <View style={{ flex: 1, padding: space[4], gap: space[2] }}>
        {title ? (
          <Text variant="label" style={{ color: colors[tone].text }}>
            {title}
          </Text>
        ) : null}
        <Text tone="secondary">{message}</Text>
        {action}
      </View>
    </View>
  );
}
