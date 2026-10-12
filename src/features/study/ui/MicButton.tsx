import { Animated, Pressable, View } from 'react-native';

import { Glyph, Text } from '@/components';
import { haptic, useTheme } from '@/theme';

import type { DictationStatus } from '../useDictation';

export type MicButtonProps = {
  status: DictationStatus;
  /** The voice level, 0 … 1 (useDictation's `level`); grows the dot beside the label while listening. */
  level: Animated.Value;
  disabled?: boolean;
  onPress(): void;
};

const LABEL: Record<DictationStatus, string> = {
  off: 'Start speaking',
  starting: 'Pause',
  listening: 'Pause',
  stopping: 'Finishing…',
};

const SPOKEN: Record<DictationStatus, string> = {
  off: 'Start speaking',
  starting: 'Pause speaking',
  listening: 'Pause speaking',
  stopping: 'Finishing the last words',
};

/**
 * The one big mic control of the notes screen: a 56 dp, full-width toggle that says what a tap does
 * ("Start speaking" / "Pause") in words, not by colour or icon alone. While listening it is tinted and
 * a dot beside the label grows with the voice, so it is plain that the phone is hearing something;
 * with Reduce motion on the dot stays still.
 */
export function MicButton({ status, level, disabled = false, onPress }: MicButtonProps) {
  const { colors, radius, space, touch, reduceMotion } = useTheme();
  const on = status === 'starting' || status === 'listening';
  const inactive = disabled || status === 'stopping';
  const accent = colors.mind;
  const color = inactive ? colors.disabled.text : accent.text;
  const scale = reduceMotion ? 1 : level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8], extrapolate: 'clamp' });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={SPOKEN[status]}
      accessibilityHint={on ? 'Everything heard so far is kept' : status === 'off' ? 'Asks for the microphone the first time' : undefined}
      accessibilityState={{ disabled: inactive, busy: status === 'starting' || status === 'stopping' }}
      disabled={inactive}
      android_ripple={{ color: accent.subtle }}
      onPress={() => {
        haptic('select');
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: touch.comfortable,
        borderRadius: radius.pill,
        borderWidth: 2,
        borderColor: inactive ? colors.border : accent.solid,
        backgroundColor: on || pressed ? accent.subtle : colors.surface,
        paddingHorizontal: space[5],
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        {on ? (
          <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View
              style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: accent.solid, transform: [{ scale }] }}
            />
          </View>
        ) : (
          <Glyph name="mic" color={color} size={24} />
        )}
        <Text variant="label" style={{ color }}>
          {LABEL[status]}
        </Text>
        {on ? <Glyph name="pause" color={color} size={20} /> : null}
      </View>
    </Pressable>
  );
}
