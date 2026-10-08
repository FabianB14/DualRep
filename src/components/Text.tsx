import { Platform, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { monoFontFamily, useTheme, type TypeVariant } from '@/theme';

/** Text colors by role; accent and tone colors are only for short labels, never paragraphs. */
export type TextTone = 'primary' | 'secondary' | 'mind' | 'body' | 'success' | 'warning' | 'danger' | 'info' | 'onMind' | 'onBody';

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  tone?: TextTone;
  align?: 'left' | 'center' | 'right';
};

const HEADING_VARIANTS: readonly TypeVariant[] = ['display', 'headline', 'title'];

/**
 * Text from the type scale. Headings get accessibilityRole="header" so screen-reader users can jump
 * between sections. Font scaling stays on (users' font-size setting is respected).
 */
export function Text({ variant = 'body', tone = 'primary', align, style, ...rest }: TextProps) {
  const { colors, typography } = useTheme();
  const color = {
    primary: colors.text,
    secondary: colors.textSecondary,
    mind: colors.mind.text,
    body: colors.body.text,
    success: colors.success.text,
    warning: colors.warning.text,
    danger: colors.danger.text,
    info: colors.info.text,
    onMind: colors.mind.onSolid,
    onBody: colors.body.onSolid,
  }[tone];

  return (
    <RNText
      accessibilityRole={HEADING_VARIANTS.includes(variant) ? 'header' : undefined}
      style={[
        typography[variant],
        { color, textAlign: align },
        variant === 'mono' && { fontFamily: Platform.select(monoFontFamily) },
        style,
      ]}
      {...rest}
    />
  );
}
