import { View, type ViewProps } from 'react-native';

import { useTheme, type ElevationLevel } from '@/theme';

export type CardProps = ViewProps & {
  /** 'mind' / 'body' tint marks the card that holds the current step; default is a plain surface. */
  tint?: 'none' | 'mind' | 'body';
  elevation?: ElevationLevel;
};

/** A surface that groups related content. */
export function Card({ tint = 'none', elevation: level = 1, style, children, ...rest }: CardProps) {
  const { colors, radius, space, elevation, scheme } = useTheme();
  const shadow = elevation[level];
  const background = tint === 'none' ? colors.surface : colors[tint].subtle;
  const border = tint === 'none' ? colors.border : colors[tint].solid;

  return (
    <View
      style={[
        {
          backgroundColor: background,
          borderColor: border,
          borderWidth: 1,
          borderRadius: radius.lg,
          padding: space[4],
          gap: space[3],
          // Shadows are invisible on dark backgrounds; the lighter surface does the lifting there.
          elevation: scheme === 'light' ? shadow.elevation : 0,
          shadowColor: '#000000',
          shadowOpacity: scheme === 'light' ? shadow.shadowOpacity : 0,
          shadowRadius: shadow.shadowRadius,
          shadowOffset: { width: 0, height: shadow.shadowOffsetY },
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
