import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { haptic, useTheme } from '@/theme';

import { Glyph } from './Glyph';
import { Text } from './Text';

export type ListRowAccessory = 'chevron' | 'checkbox' | 'radio' | 'none';

export type ListRowProps = {
  title: string;
  /** A second line in the secondary color (a split, an equipment count, a date). */
  subtitle?: string;
  /** A short value on the right ("25 min", "Full body"). */
  value?: string;
  /** A small tinted tag after the title, e.g. "Default". */
  badge?: string;
  onPress?: () => void;
  /**
   * What the right edge shows: a chevron (opens another screen; the default for a pressable row), a
   * checkbox or a radio mark (the row toggles or picks; `checked` says which), or nothing.
   */
  accessory?: ListRowAccessory;
  checked?: boolean;
  /**
   * A separate control at the right edge (e.g. an "Edit" button). It sits beside the row, not inside
   * it, so a screen reader reaches both.
   */
  trailing?: ReactNode;
  disabled?: boolean;
  accent?: 'mind' | 'body';
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/**
 * One row of a list: a setup, a preset, a link to another screen, an equipment checkbox. At least
 * 56 dp tall, the whole row is the touch target, and its role matches what a tap does (button,
 * checkbox, radio).
 */
export function ListRow({
  title,
  subtitle,
  value,
  badge,
  onPress,
  accessory,
  checked = false,
  trailing,
  disabled = false,
  accent = 'mind',
  accessibilityLabel,
  accessibilityHint,
}: ListRowProps) {
  const { colors, radius, space, touch } = useTheme();
  const mark = accessory ?? (onPress ? 'chevron' : 'none');
  const role = mark === 'checkbox' ? 'checkbox' : mark === 'radio' ? 'radio' : onPress ? 'button' : undefined;
  const spoken =
    accessibilityLabel ?? [title, badge, value, subtitle].filter((part): part is string => Boolean(part)).join(', ');

  const body = (
    <>
      <View style={{ flex: 1, gap: space[1] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2] }}>
          <Text variant="label" style={{ color: disabled ? colors.disabled.text : colors.text, flexShrink: 1 }}>
            {title}
          </Text>
          {badge ? (
            <View
              style={{
                paddingHorizontal: space[2],
                paddingVertical: 2,
                borderRadius: radius.pill,
                backgroundColor: colors[accent].subtle,
              }}
            >
              <Text variant="caption" style={{ color: colors[accent].text, fontWeight: '600' }}>
                {badge}
              </Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text variant="caption" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text tone="secondary" numberOfLines={2} align="right" style={{ maxWidth: '50%' }}>
          {value}
        </Text>
      ) : null}
      {mark === 'chevron' ? <Glyph name="chevron-right" color={colors.textSecondary} /> : null}
      {mark === 'checkbox' ? <CheckMark checked={checked} accent={accent} disabled={disabled} shape="box" /> : null}
      {mark === 'radio' ? <CheckMark checked={checked} accent={accent} disabled={disabled} shape="circle" /> : null}
    </>
  );

  const rowStyle = {
    flex: 1,
    minHeight: touch.comfortable,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {onPress ? (
        <Pressable
          accessibilityRole={role}
          accessibilityLabel={spoken}
          accessibilityHint={accessibilityHint}
          accessibilityState={{
            disabled,
            ...(mark === 'checkbox' || mark === 'radio' ? { checked } : {}),
          }}
          disabled={disabled}
          android_ripple={{ color: colors[accent].subtle }}
          onPress={() => {
            haptic(mark === 'checkbox' || mark === 'radio' ? 'select' : 'tap');
            onPress();
          }}
          style={({ pressed }) => [rowStyle, pressed && { backgroundColor: colors.surfaceMuted }]}
        >
          {body}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={spoken} style={rowStyle}>
          {body}
        </View>
      )}
      {trailing ? <View style={{ paddingRight: space[3] }}>{trailing}</View> : null}
    </View>
  );
}

function CheckMark({
  checked,
  accent,
  disabled,
  shape,
}: {
  checked: boolean;
  accent: 'mind' | 'body';
  disabled: boolean;
  shape: 'box' | 'circle';
}) {
  const { colors, radius } = useTheme();
  const on = checked && !disabled;
  const size = 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: shape === 'circle' ? size / 2 : radius.sm / 2,
        borderWidth: 2,
        borderColor: disabled ? colors.border : checked ? colors[accent].solid : colors.borderStrong,
        backgroundColor: on && shape === 'box' ? colors[accent].solid : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {checked && shape === 'box' ? (
        <Glyph name="check" color={disabled ? colors.disabled.text : colors[accent].onSolid} size={18} strokeWidth={3} />
      ) : null}
      {checked && shape === 'circle' ? (
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: disabled ? colors.disabled.text : colors[accent].solid,
          }}
        />
      ) : null}
    </View>
  );
}

export type ListGroupProps = {
  children: ReactNode;
  /** Read before the rows by screen readers, and shown above them. */
  title?: string;
  /** A line under the title. */
  description?: string;
};

/** Rows on one surface, separated by hairlines (settings-style). Empty children are skipped. */
export function ListGroup({ children, title, description }: ListGroupProps) {
  const { colors, radius, space } = useTheme();
  const rows = Children.toArray(children).filter((child) => isValidElement(child));
  return (
    <View style={{ gap: space[2] }}>
      {title ? <Text variant="subtitle" accessibilityRole="header">{title}</Text> : null}
      {description ? (
        <Text variant="caption" tone="secondary">
          {description}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius.lg,
          overflow: 'hidden',
        }}
      >
        {rows.map((row, index) => (
          <Fragment key={isValidElement(row) && row.key !== null ? row.key : index}>
            {index > 0 ? (
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: space[4] }} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}
