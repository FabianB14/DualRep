import { Pressable, View } from 'react-native';

import { haptic, useTheme } from '@/theme';

import { Text } from './Text';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Spoken instead of the label, when the label alone is too short ("lb" → "Pounds"). */
  accessibilityLabel?: string;
};

export type SegmentedControlProps<T extends string> = {
  /** Visible label above the control, and the group's name for screen readers. */
  label?: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  accent?: 'mind' | 'body';
  disabled?: boolean;
};

/**
 * One choice out of two to four short options (units, gym or home, a tab). The selected segment is a
 * solid fill with its label in bold, and each segment is a radio button for screen readers.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  accent = 'mind',
  disabled = false,
}: SegmentedControlProps<T>) {
  const { colors, radius, space, touch } = useTheme();
  const accentColors = colors[accent];

  return (
    <View style={{ gap: space[2] }}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={{
          flexDirection: 'row',
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: radius.md,
          backgroundColor: colors.surface,
          padding: space[1],
          gap: space[1],
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.accessibilityLabel ?? option.label}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() => {
                if (selected) return;
                haptic('select');
                onChange(option.value);
              }}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: touch.min,
                borderRadius: radius.sm,
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: space[2],
                backgroundColor: disabled
                  ? colors.disabled.background
                  : selected
                    ? accentColors.solid
                    : pressed
                      ? accentColors.subtle
                      : 'transparent',
              })}
            >
              <Text
                variant="label"
                align="center"
                numberOfLines={1}
                style={{
                  color: disabled ? colors.disabled.text : selected ? accentColors.onSolid : colors.text,
                  fontWeight: selected ? '700' : '500',
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
