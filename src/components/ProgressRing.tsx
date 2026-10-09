import { createElement, type ComponentType, type ReactNode } from 'react';
import { View, type AccessibilityProps } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useTheme } from '@/theme';

import type { AnimatedArcProps } from './ProgressRingArc';
import { clampProgress, dashOffset, ringGeometry } from './progressRingMath';

export { clampProgress, dashOffset, ringGeometry } from './progressRingMath';

export type ProgressRingProps = Pick<AccessibilityProps, 'accessibilityLabel' | 'accessibilityLiveRegion'> & {
  /** Outer width and height in dp. */
  size: number;
  strokeWidth: number;
  /**
   * How much of the ring is filled, 0–1. A plain number re-renders the ring; a Reanimated shared value
   * animates it on the UI thread without re-rendering (e.g. withTiming between timer ticks).
   */
  progress: number | SharedValue<number>;
  /** Fill color (default: the mind accent). */
  color?: string;
  /** Color of the unfilled track (default: the hairline border color). */
  trackColor?: string;
  /** Fill counter-clockwise from the top (the default fills clockwise). */
  counterClockwise?: boolean;
  /** Shown in the middle (the remaining time, a label). */
  children?: ReactNode;
  /**
   * Spoken value, e.g. "12 minutes left". Defaults to the percentage for a numeric progress; give it
   * for a shared value, which is not read during render.
   */
  accessibilityValueText?: string;
};

/**
 * A circular progress ring drawn with react-native-svg: a full track circle and an arc on top whose
 * strokeDashoffset hides the unfilled part. It starts at 12 o'clock. Used for the focus timer (the
 * cycle screen animates it with a shared value) and anywhere else a fraction is shown.
 */
export function ProgressRing({
  size,
  strokeWidth,
  progress,
  color,
  trackColor,
  counterClockwise = false,
  children,
  accessibilityLabel,
  accessibilityLiveRegion,
  accessibilityValueText,
}: ProgressRingProps) {
  const { colors } = useTheme();
  const { radius, circumference, center } = ringGeometry(size, strokeWidth);
  const fill = color ?? colors.mind.solid;
  const track = trackColor ?? colors.border;
  const percent = typeof progress === 'number' ? Math.round(clampProgress(progress) * 100) : undefined;

  const arc = {
    cx: center,
    cy: center,
    r: radius,
    stroke: fill,
    strokeWidth,
    strokeLinecap: 'round' as const,
    fill: 'none',
    strokeDasharray: `${circumference} ${circumference}`,
  };

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion={accessibilityLiveRegion}
      accessibilityValue={
        accessibilityValueText !== undefined
          ? { text: accessibilityValueText }
          : percent !== undefined
            ? { min: 0, max: 100, now: percent }
            : undefined
      }
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {/* An SVG circle's path starts at 3 o'clock; rotating it a quarter turn starts the arc at the top. */}
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={center} cy={center} r={radius} stroke={track} strokeWidth={strokeWidth} fill="none" />
        {typeof progress !== 'number' ? (
          <AnimatedArc arc={arc} circumference={circumference} progress={progress} counterClockwise={counterClockwise} />
        ) : clampProgress(progress) > 0 ? (
          <Circle {...arc} strokeDashoffset={dashOffset(circumference, progress, counterClockwise)} />
        ) : // A zero-length round cap still draws a dot, so an empty ring draws no arc.
        null}
      </Svg>
      {children}
    </View>
  );
}

let animatedArc: ComponentType<AnimatedArcProps> | null = null;

/**
 * The Reanimated arc, loaded the first time a ring is given a shared value. Loading it on demand keeps
 * `@/components` importable where Reanimated's native runtime is missing (jest), so screens and
 * components can be tested without mocking Reanimated; in the app Reanimated is loaded anyway.
 */
function loadAnimatedArc(): ComponentType<AnimatedArcProps> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  animatedArc ??= (require('./ProgressRingArc') as typeof import('./ProgressRingArc')).AnimatedArc;
  return animatedArc;
}

function AnimatedArc(props: AnimatedArcProps) {
  // Always the same component once loaded, so React keeps its state between renders.
  return createElement(loadAnimatedArc(), props);
}
