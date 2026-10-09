import { Pressable, View } from 'react-native';

import { haptic, useTheme } from '@/theme';

import { Glyph } from './Glyph';
import { Text } from './Text';

export type ChipProps = {
  label: string;
  /** Selected chips are tinted and show a check mark, so the state never depends on color alone. */
  selected?: boolean;
  onPress?: () => void;
  accent?: 'mind' | 'body';
  disabled?: boolean;
  /**
   * What the chip is to a screen reader: 'checkbox' for a filter that toggles on and off, 'radio' for
   * one choice of several, 'button' (default) for a chip that opens something (e.g. "Preset: Full body").
   */
  role?: 'button' | 'checkbox' | 'radio';
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/** A compact, pill-shaped choice or filter. Still a full 48 dp touch target. */
export function Chip({
  label,
  selected = false,
  onPress,
  accent = 'mind',
  disabled = false,
  role = 'button',
  accessibilityLabel,
  accessibilityHint,
}: ChipProps) {
  const { colors, radius, space, touch } = useTheme();
  const accentColors = colors[accent];
  const textColor = disabled ? colors.disabled.text : selected ? accentColors.text : colors.text;

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        disabled,
        ...(role === 'button' ? { selected } : { checked: selected }),
      }}
      disabled={disabled}
      onPress={() => {
        haptic('select');
        onPress?.();
      }}
      style={({ pressed }) => ({
        minHeight: touch.min,
        paddingHorizontal: space[4],
        borderRadius: radius.pill,
        borderWidth: selected ? 1.5 : 1,
        borderColor: disabled ? colors.border : selected ? accentColors.solid : colors.borderStrong,
        backgroundColor: disabled
          ? colors.disabled.background
          : selected || pressed
            ? accentColors.subtle
            : colors.surface,
        justifyContent: 'center',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
        {selected ? <Glyph name="check" color={textColor} size={18} /> : null}
        <Text variant="label" style={{ color: textColor }} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
