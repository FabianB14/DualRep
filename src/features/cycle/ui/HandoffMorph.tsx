import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { motionFor, useTheme } from '@/theme';

import { FocusDial, focusRingSize, type WindowFrame } from './FocusDial';

/** If the card has not been laid out by then, the morph is skipped and the card simply shows. */
export const MORPH_LAYOUT_WAIT_MS = 400;

/** Slack after the animation before the overlay is removed (one or two frames). */
const SETTLE_MS = 34;

/** The card's own content shows from this point of the morph (the shape is mostly a card by then). */
const CONTENT_FROM = 0.45;

/** The ring has faded out by this point of the morph. */
const RING_UNTIL = 0.4;

type Geometry = { width: number; height: number; dx: number; dy: number };

export type HandoffMorphProps = {
  /** Play the morph: the focus block has just ended on screen. */
  active: boolean;
  /** Where the focus ring was (window coordinates), or null to grow from the card's center. */
  from: WindowFrame | null;
  /** Called once the morph is over (or skipped): the card is then shown as it is. */
  onDone(): void;
  /** The exercise card. Its surface must be the body tint with the large radius (Card tint="body"). */
  children: ReactNode;
};

/**
 * The zero-tap handoff (docs/EXECUTION_PLAN.md "Product loop" step 3): the focus ring morphs into the
 * first exercise card.
 *
 * Behind the card a shape starts as the ring's disc, where the ring was on screen, and grows into the
 * card's rounded rectangle where the card is: width, height, corner radius and position interpolate,
 * and its color moves from the study tint to the movement tint. The ring fades out over the first
 * part, and the card's content fades in over the last part, landing exactly on the shape (same size,
 * radius and color), so the hand-over is seamless. One shared value drives it all on the UI thread
 * (motion.duration.morph, the standard easing).
 *
 * Reduced motion: nothing moves or grows; the ring fades out where it was while the card fades in
 * (motionFor's short cross-fade).
 *
 * When `active` is false (the app was opened after the block had already ended, or the morph is over)
 * the card is rendered as it is. The card stays in the accessibility tree throughout; the ring copy
 * is decorative and never takes touches.
 */
export function HandoffMorph({ active, from, onDone, children }: HandoffMorphProps) {
  const { colors, radius, reduceMotion } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const slotRef = useRef<View>(null);
  const doneRef = useRef(onDone);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const progress = useSharedValue(active ? 0 : 1);
  const start = from?.width ?? focusRingSize(windowWidth);
  const spec = motionFor('morph', reduceMotion);

  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!active) {
      progress.set(1);
      return;
    }
    if (geometry === null) {
      // Wait for the card's layout, but never leave the screen behind a ring.
      const timer = setTimeout(() => doneRef.current(), MORPH_LAYOUT_WAIT_MS);
      return () => clearTimeout(timer);
    }
    progress.set(0);
    progress.set(withTiming(1, { duration: spec.duration, easing: Easing.bezier(...spec.easing) }));
    const timer = setTimeout(() => doneRef.current(), spec.duration + SETTLE_MS);
    return () => clearTimeout(timer);
  }, [active, geometry, progress, spec.duration, spec.easing]);

  const measure = () => {
    if (!active || geometry !== null) return;
    slotRef.current?.measureInWindow((x, y, width, height) => {
      if (!(width > 0 && height > 0)) return;
      const dx = from ? from.x + from.width / 2 - (x + width / 2) : 0;
      const dy = from ? from.y + from.height / 2 - (y + height / 2) : 0;
      setGeometry({ width, height, dx, dy });
    });
  };

  const fade = spec.kind === 'fade';
  const startColor = colors.mind.subtle;
  const endColor = colors.body.subtle;
  const endRadius = radius.lg;

  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), fade ? [0, 1] : [0, CONTENT_FROM, 1], fade ? [0, 1] : [0, 0, 1], Extrapolation.CLAMP),
  }));

  const ringStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, fade ? 1 : RING_UNTIL], [1, 0], Extrapolation.CLAMP),
  }));

  const shapeStyle = useAnimatedStyle(() => {
    if (geometry === null) return { opacity: 0 };
    const t = progress.get();
    if (fade) {
      return {
        opacity: 1,
        width: start,
        height: start,
        transform: [{ translateX: geometry.dx }, { translateY: geometry.dy }],
      };
    }
    return {
      opacity: 1,
      width: interpolate(t, [0, 1], [start, geometry.width]),
      height: interpolate(t, [0, 1], [start, geometry.height]),
      borderRadius: interpolate(t, [0, 1], [start / 2, endRadius]),
      backgroundColor: interpolateColor(t, [0, 1], [startColor, endColor]),
      transform: [
        { translateX: interpolate(t, [0, 1], [geometry.dx, 0]) },
        { translateY: interpolate(t, [0, 1], [geometry.dy, 0]) },
      ],
    };
  });

  return (
    <View ref={slotRef} testID="handoff-slot" collapsable={false} onLayout={measure} style={active ? styles.raised : undefined}>
      {active ? (
        <View
          testID="handoff-morph"
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={styles.layer}
        >
          <Animated.View testID="handoff-shape" style={[styles.shape, shapeStyle]}>
            <Animated.View testID="handoff-ring" style={ringStyle}>
              <FocusDial size={start} progress={0} clock="0:00" caption="Done" decorative />
            </Animated.View>
          </Animated.View>
        </View>
      ) : null}
      <Animated.View style={contentStyle}>{children}</Animated.View>
    </View>
  );
}

export type HandoffFadeProps = {
  /** Fade in with the morph (true while it plays). */
  active: boolean;
  children: ReactNode;
  /** Space between the children (they are laid out in a column). */
  gap?: number;
};

/**
 * The rest of the move screen during the handoff: it fades in over the second half of the morph, so
 * the eye follows the ring into the card first. Without a morph it is simply shown.
 */
export function HandoffFade({ active, children, gap }: HandoffFadeProps) {
  const { reduceMotion } = useTheme();
  const opacity = useSharedValue(active ? 0 : 1);
  const spec = motionFor('morph', reduceMotion);

  useEffect(() => {
    if (!active) {
      opacity.set(1);
      return;
    }
    const half = Math.round(spec.duration / 2);
    opacity.set(0);
    opacity.set(withDelay(half, withTiming(1, { duration: half, easing: Easing.bezier(...spec.easing) })));
  }, [active, opacity, spec.duration, spec.easing]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={[{ gap }, style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  // Above the screen's later content while the shape travels from where the ring was.
  raised: { zIndex: 1 },
  layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  shape: { alignItems: 'center', justifyContent: 'center' },
});
