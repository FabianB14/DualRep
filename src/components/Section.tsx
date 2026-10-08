import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export type SectionProps = {
  /** A heading screen-reader users can jump to. */
  title: string;
  /** A line under the heading. */
  description?: string;
  children: ReactNode;
};

/** A titled group of controls on a form or settings screen. */
export function Section({ title, description, children }: SectionProps) {
  const { space } = useTheme();
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ gap: space[1] }}>
        <Text variant="subtitle" accessibilityRole="header">
          {title}
        </Text>
        {description ? (
          <Text variant="caption" tone="secondary">
            {description}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}
