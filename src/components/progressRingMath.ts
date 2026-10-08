/**
 * Ring math shared by ProgressRing and its Reanimated arc. The two functions marked 'worklet' also
 * run on the UI thread inside useAnimatedProps.
 */

/** Geometry of a ring: the circle's radius sits mid-stroke so the stroke never clips at the edge. */
export function ringGeometry(size: number, strokeWidth: number): { radius: number; circumference: number; center: number } {
  const radius = Math.max(0, (size - strokeWidth) / 2);
  return { radius, circumference: 2 * Math.PI * radius, center: size / 2 };
}

/** Clamps a progress value to 0–1 (NaN reads as 0). Runs on the UI thread too. */
export function clampProgress(value: number): number {
  'worklet';
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * strokeDashoffset that shows `progress` (0–1) of the ring filled, with the dash array
 * `circumference circumference`. A positive offset keeps the start of the path (clockwise fill); a
 * negative one keeps its end, which fills counter-clockwise from the same start point.
 */
export function dashOffset(circumference: number, progress: number, counterClockwise = false): number {
  'worklet';
  const hidden = circumference * (1 - clampProgress(progress));
  return counterClockwise ? -hidden : hidden;
}
