import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { Circle } from 'react-native-svg';

import { clampProgress, dashOffset } from './progressRingMath';

export type AnimatedArcProps = {
  /** The arc circle's static props (center, radius, stroke, dash array). */
  arc: Record<string, unknown>;
  circumference: number;
  progress: SharedValue<number>;
  counterClockwise: boolean;
};

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * ProgressRing's arc driven by a shared value: the dash offset is recomputed on the UI thread on every
 * frame the value changes, with no React render. Loaded on demand by ProgressRing.
 */
export function AnimatedArc({ arc, circumference, progress, counterClockwise }: AnimatedArcProps) {
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: dashOffset(circumference, progress.value, counterClockwise),
    // Hide the round cap's dot at exactly 0.
    strokeOpacity: clampProgress(progress.value) > 0 ? 1 : 0,
  }));
  return <AnimatedCircle {...arc} animatedProps={animatedProps} />;
}
