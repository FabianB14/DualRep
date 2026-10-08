import { useState, type Ref } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export type TextFieldProps = Omit<TextInputProps, 'style'> & {
  ref?: Ref<TextInput>;
  label: string;
  /** Shown under the field in the danger color and announced by screen readers. */
  error?: string | null;
  /** Helper text under the field when there is no error. */
  hint?: string;
  /** Larger, letter-spaced text (e.g. the 6-digit code). */
  large?: boolean;
};

/**
 * A labelled text input. The label is always visible (no placeholder-as-label, which disappears while
 * typing), the outline meets 3:1 contrast, focus thickens it in the focus color, and errors are both
 * shown and announced.
 */
export function TextField({
  ref,
  label,
  error,
  hint,
  large = false,
  onFocus,
  onBlur,
  accessibilityLabel,
  editable = true,
  ...rest
}: TextFieldProps) {
  const { colors, radius, space, touch, typography } = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error ? colors.danger.text : focused ? colors.focus : colors.borderStrong;

  return (
    <View style={{ gap: space[2] }}>
      <Text variant="label">{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={error ?? hint}
        accessibilityState={{ disabled: !editable }}
        editable={editable}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.mind.solid}
        cursorColor={colors.mind.solid}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          large ? typography.title : typography.bodyLarge,
          styles.input,
          {
            minHeight: touch.comfortable,
            borderRadius: radius.md,
            borderWidth: focused || error ? 2 : 1.5,
            borderColor,
            paddingHorizontal: space[4],
            color: editable ? colors.text : colors.disabled.text,
            backgroundColor: editable ? colors.surface : colors.disabled.background,
          },
          large && { letterSpacing: 6, textAlign: 'center' },
        ]}
        {...rest}
      />
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite" accessibilityRole="alert">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="secondary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    // Android adds its own vertical padding to TextInput; keep the height predictable.
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
});
