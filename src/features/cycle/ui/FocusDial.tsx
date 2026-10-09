import { View, type AccessibilityProps } from 'react-native';

import { ProgressRing, Text } from '@/components';
import { useTheme } from '@/theme';

/** The focus ring's largest size, in dp. */
export const FOCUS_RING_MAX = 280;

/** A rectangle on screen, in window coordinates (measureInWindow). */
export type WindowFrame = { x: number; y: number; width: number; height: number };

/** The focus ring's size on a window this wide: as big as fits beside the page margins, at most FOCUS_RING_MAX. */
export function focusRingSize(windowWidth: number): number {
  const fits = Math.round(windowWidth - 80);
  return Math.max(160, Math.min(FOCUS_RING_MAX, Number.isFinite(fits) ? fits : FOCUS_RING_MAX));
}

/** The ring's stroke for a ring of this size. */
export function ringStroke(size: number): number {
  return Math.max(8, Math.round(size / 20));
}

export type FocusDialProps = Pick<AccessibilityProps, 'accessibilityLiveRegion'> & {
  size: number;
  /** How much of the ring is filled, 0–1 (the time left: it empties as the block runs). */
  progress: number;
  /** The big number in the middle ("24:13"). */
  clock: string;
  /** A short line under it ("left", "Paused"). */
  caption?: string;
  accent?: 'mind' | 'body';
  /** Spoken name ("Focus timer"). */
  accessibilityLabel?: string;
  /** Spoken value ("24 minutes left"); give one that changes once a minute, not every second. */
  accessibilityValueText?: string;
  /** Hidden from screen readers (the copy drawn during the handoff morph). */
  decorative?: boolean;
};

/**
 * The timer face: a tinted disc with the progress ring around it and the time in the middle. The
 * clock digits are hidden from screen readers (they change every second); the ring's spoken value
 * carries the time instead, in whole minutes. The handoff morph starts from this exact shape: a disc
 * in the mind tint.
 */
export function FocusDial({
  size,
  progress,
  clock,
  caption,
  accent = 'mind',
  accessibilityLabel,
  accessibilityValueText,
  accessibilityLiveRegion,
  decorative = false,
}: FocusDialProps) {
  const { colors } = useTheme();
  const digits = Math.round(size * 0.2);
  return (
    <View
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={decorative}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors[accent].subtle }}
    >
      <ProgressRing
        size={size}
        strokeWidth={ringStroke(size)}
        progress={progress}
        color={colors[accent].solid}
        accessibilityLabel={accessibilityLabel}
        accessibilityValueText={accessibilityValueText}
        accessibilityLiveRegion={accessibilityLiveRegion}
      >
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ alignItems: 'center' }}>
          <Text
            variant="display"
            align="center"
            style={{
              fontSize: digits,
              lineHeight: Math.round(digits * 1.15),
              fontVariant: ['tabular-nums'],
              color: colors.text,
            }}
          >
            {clock}
          </Text>
          {caption ? (
            <Text variant="label" tone="secondary">
              {caption}
            </Text>
          ) : null}
        </View>
      </ProgressRing>
    </View>
  );
}
