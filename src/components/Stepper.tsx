import { Pressable, View } from 'react-native';

import { haptic, useTheme } from '@/theme';

import { Glyph } from './Glyph';
import { Text } from './Text';

export type StepperRange = { min: number; max: number; step: number };

/**
 * `value` moved by `delta` steps, kept inside [min, max] and on the step grid counted from `min`
 * (so 23 with step 5 from 10 moves to 25 or 20, never 28). Pure, so the rule is unit-tested.
 */
export function stepValue(value: number, delta: number, { min, max, step }: StepperRange): number {
  const size = step > 0 ? step : 1;
  const base = Number.isFinite(value) ? value : min;
  const at = (base - min) / size;
  // Off-grid values snap toward the direction of travel first, so one tap always moves at least to
  // the next grid point.
  const index = delta > 0 ? Math.floor(at + 1e-9) + delta : delta < 0 ? Math.ceil(at - 1e-9) + delta : Math.round(at);
  const next = min + index * size;
  return Math.min(max, Math.max(min, Math.round(next * 1000) / 1000));
}

export type StepperProps = {
  /** Visible label above the control; also names the buttons for screen readers. */
  label: string;
  value: number;
  onChange(value: number): void;
  min: number;
  max: number;
  /** Size of one step (default 1). */
  step?: number;
  /** How the value reads on screen and to screen readers, e.g. (v) => `${v} min`. */
  format?: (value: number) => string;
  /** Short helper line under the control. */
  hint?: string;
  accent?: 'mind' | 'body';
  disabled?: boolean;
  /** 'comfortable' (56 dp buttons and a larger number) when the stepper is the screen's main control. */
  size?: 'regular' | 'comfortable';
};

/**
 * A number picked with − and + buttons (block length, a split's percentages, reps). The buttons are
 * separate, labelled controls ("Decrease block length") so they work the same with touch, TalkBack
 * and Switch Access; the value is announced when it changes. A button turns inactive at the end of
 * the range instead of doing nothing silently.
 */
export function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format = String,
  hint,
  accent = 'mind',
  disabled = false,
  size = 'regular',
}: StepperProps) {
  const { colors, radius, space, touch } = useTheme();
  const range = { min, max, step };
  const text = format(value);
  const buttonSize = size === 'comfortable' ? touch.comfortable : touch.min;

  const change = (delta: number) => {
    const next = stepValue(value, delta, range);
    if (next === value) return;
    haptic('select');
    onChange(next);
  };

  const button = (delta: -1 | 1) => {
    const inactive = disabled || stepValue(value, delta, range) === value;
    const verb = delta < 0 ? 'Decrease' : 'Increase';
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${verb} ${label}`}
        accessibilityState={{ disabled: inactive }}
        disabled={inactive}
        onPress={() => change(delta)}
        hitSlop={4}
        style={({ pressed }) => ({
          width: buttonSize,
          height: buttonSize,
          borderRadius: radius.md,
          borderWidth: 1.5,
          borderColor: inactive ? colors.border : colors[accent].solid,
          backgroundColor: pressed ? colors[accent].subtle : colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: inactive ? 0.6 : 1,
        })}
      >
        <Glyph name={delta < 0 ? 'minus' : 'plus'} color={inactive ? colors.disabled.text : colors[accent].text} size={22} />
      </Pressable>
    );
  };

  return (
    <View style={{ gap: space[2] }}>
      <Text variant="label">{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        {button(-1)}
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text
            variant={size === 'comfortable' ? 'title' : 'subtitle'}
            align="center"
            // The 'title' size is for legibility, not a heading.
            accessibilityRole="text"
            accessibilityLabel={`${label}: ${text}`}
            accessibilityLiveRegion="polite"
          >
            {text}
          </Text>
        </View>
        {button(1)}
      </View>
      {hint ? (
        <Text variant="caption" tone="secondary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
