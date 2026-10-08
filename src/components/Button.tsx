import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { haptic, useTheme } from '@/theme';

import { Text } from './Text';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  /** primary = the one main action on a screen; secondary = outlined; ghost = text only. */
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Brand side: 'mind' (study, default) or 'body' (movement). */
  accent?: 'mind' | 'body';
  /** 'comfortable' (56 dp) for a screen's primary action; 'regular' is the 48 dp minimum. */
  size?: 'regular' | 'comfortable';
  loading?: boolean;
  /** Stretch to the container width (the default; one big target is easiest to hit). */
  fullWidth?: boolean;
};

export function Button({
  label,
  variant = 'primary',
  accent = 'mind',
  size = 'regular',
  loading = false,
  disabled = false,
  fullWidth = true,
  onPress,
  accessibilityLabel,
  ...rest
}: ButtonProps) {
  const { colors, radius, space, touch } = useTheme();
  const accentColors = colors[accent];
  const inactive = disabled || loading;

  const labelColor = inactive && variant === 'primary' ? colors.disabled.text : variant === 'primary' ? accentColors.onSolid : accentColors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      android_ripple={variant === 'primary' ? undefined : { color: accentColors.subtle }}
      onPress={(event) => {
        haptic('tap');
        onPress?.(event);
      }}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: size === 'comfortable' ? touch.comfortable : touch.min,
          borderRadius: radius.md,
          paddingHorizontal: space[5],
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        variant === 'primary' && {
          backgroundColor: inactive ? colors.disabled.background : pressed ? accentColors.solidPressed : accentColors.solid,
        },
        variant === 'secondary' && {
          borderWidth: 1.5,
          borderColor: inactive ? colors.border : accentColors.solid,
          backgroundColor: pressed ? accentColors.subtle : 'transparent',
        },
        variant === 'ghost' && { backgroundColor: pressed ? accentColors.subtle : 'transparent' },
        inactive && variant !== 'primary' && { opacity: 0.6 },
      ]}
      {...rest}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator color={labelColor} style={{ marginRight: space[2] }} /> : null}
        <Text variant="label" style={{ color: labelColor }} numberOfLines={2} align="center">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
