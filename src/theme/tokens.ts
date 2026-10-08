/**
 * DualRep design tokens.
 *
 * The brand has two sides: a cool "mind" hue for study (focus blocks, cards, quizzes) and a warm "body"
 * hue for movement (training blocks, sets). Everything else is calm neutrals, because the plan's
 * ADHD-friendly defaults ask for one action per screen, the next step always visible and high
 * contrast without glare:
 * - no pure white canvas and no pure black text (warm off-white / near-black instead), and no neon;
 * - every text/background pairing below meets WCAG AA in both modes (see CONTRAST_PAIRS and its test);
 * - accents are reserved for the one primary action and for status, so the eye has one place to go.
 *
 * This module has no React Native imports so the tests (and future tooling) can read it anywhere.
 */

export type ColorScheme = 'light' | 'dark';

/** A brand accent: a solid fill for the primary action, its text, and quieter variants. */
export type AccentColors = {
  /** Fill of a primary button / active step marker. */
  solid: string;
  /** Pressed state of the solid fill. */
  solidPressed: string;
  /** Text and icons placed on `solid` / `solidPressed`. */
  onSolid: string;
  /** Accent-colored text on the canvas or a surface (links, the active step's label). */
  text: string;
  /** Tinted background (highlighted card, current step). */
  subtle: string;
};

/** A status tone: text/icon color and the tinted background it sits on (pills, banners). */
export type ToneColors = {
  text: string;
  subtle: string;
};

export type Palette = {
  /** App canvas behind everything. */
  background: string;
  /** Cards, inputs, sheets. */
  surface: string;
  /** Sunken or secondary areas inside a surface (step list rows, code blocks). */
  surfaceMuted: string;
  text: string;
  textSecondary: string;
  /** Decorative hairlines (card outlines). Never the only way to see a control. */
  border: string;
  /** Boundaries that identify a control (text field outlines): ≥ 3:1 per WCAG 1.4.11. */
  borderStrong: string;
  /** Keyboard / accessibility focus ring. */
  focus: string;
  mind: AccentColors;
  body: AccentColors;
  neutral: ToneColors;
  success: ToneColors;
  warning: ToneColors;
  danger: ToneColors;
  info: ToneColors;
  /** Disabled controls. WCAG exempts inactive controls from contrast minimums; these stay legible anyway. */
  disabled: { background: string; text: string };
};

export const palettes: Record<ColorScheme, Palette> = {
  light: {
    background: '#F5F4F0',
    surface: '#FCFBF8',
    surfaceMuted: '#EDEBE6',
    text: '#1F2328',
    textSecondary: '#565C66',
    border: '#DEDBD4',
    borderStrong: '#7D838C',
    focus: '#3A55A4',
    mind: { solid: '#3A55A4', solidPressed: '#2F4687', onSolid: '#FCFBF8', text: '#3A55A4', subtle: '#E6EBF8' },
    body: { solid: '#A64B22', solidPressed: '#8A3D1A', onSolid: '#FCFBF8', text: '#A64B22', subtle: '#F8E9E1' },
    neutral: { text: '#4A5059', subtle: '#ECEAE5' },
    success: { text: '#1E6B43', subtle: '#E3F1E8' },
    warning: { text: '#8A5300', subtle: '#FBEFD9' },
    danger: { text: '#B3261E', subtle: '#FBE5E3' },
    info: { text: '#2F5D8A', subtle: '#E3EDF7' },
    disabled: { background: '#E4E2DC', text: '#7A7F87' },
  },
  dark: {
    background: '#14171B',
    surface: '#1D2127',
    surfaceMuted: '#262B32',
    text: '#E9E6E0',
    textSecondary: '#A9AFB8',
    border: '#30353D',
    borderStrong: '#757C87',
    focus: '#A8BCF5',
    mind: { solid: '#A8BCF5', solidPressed: '#C2D0F8', onSolid: '#14171B', text: '#A8BCF5', subtle: '#1E2740' },
    body: { solid: '#F2A985', solidPressed: '#F6C1A6', onSolid: '#14171B', text: '#F2A985', subtle: '#3A2419' },
    neutral: { text: '#C3C8CF', subtle: '#2A2F36' },
    success: { text: '#7FD3A1', subtle: '#173325' },
    warning: { text: '#F0C066', subtle: '#3A2C10' },
    danger: { text: '#F4A39C', subtle: '#3D1C1A' },
    info: { text: '#9CC3EC', subtle: '#182B3D' },
    disabled: { background: '#2A2F36', text: '#7F8690' },
  },
};

/** Dotted paths to every color in a palette, e.g. 'mind.onSolid'. */
type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];
export type ColorToken = Leaves<Palette>;

export function resolveColor(palette: Palette, token: ColorToken): string {
  const value = token.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], palette);
  if (typeof value !== 'string') throw new Error(`Unknown color token: ${token}`);
  return value;
}

export type ContrastPair = {
  fg: ColorToken;
  bg: ColorToken;
  /** 'text' needs 4.5:1; 'ui' (control boundaries, icons, large text) needs 3:1. */
  kind: 'text' | 'ui';
  use: string;
};

const TONES = ['neutral', 'success', 'warning', 'danger', 'info'] as const;
const ACCENTS = ['mind', 'body'] as const;

/**
 * Every foreground/background combination the components use. The contrast test checks each one in
 * both schemes, so adding a component that puts text on a new background means adding its pair here.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(['background', 'surface', 'surfaceMuted', 'mind.subtle', 'body.subtle'] as const).flatMap(
    (bg): ContrastPair[] => [
      { fg: 'text', bg, kind: 'text', use: `body text on ${bg}` },
      { fg: 'textSecondary', bg, kind: 'text', use: `secondary text on ${bg}` },
    ],
  ),
  ...ACCENTS.flatMap((accent): ContrastPair[] => [
    { fg: `${accent}.onSolid`, bg: `${accent}.solid`, kind: 'text', use: `${accent} button label` },
    { fg: `${accent}.onSolid`, bg: `${accent}.solidPressed`, kind: 'text', use: `${accent} button label, pressed` },
    { fg: `${accent}.text`, bg: 'background', kind: 'text', use: `${accent} text on the canvas` },
    { fg: `${accent}.text`, bg: 'surface', kind: 'text', use: `${accent} text on a card` },
    { fg: `${accent}.text`, bg: `${accent}.subtle`, kind: 'text', use: `${accent} text on its tint` },
    { fg: `${accent}.solid`, bg: 'background', kind: 'ui', use: `${accent} button edge vs canvas` },
    { fg: `${accent}.solid`, bg: 'surface', kind: 'ui', use: `${accent} button edge vs card` },
  ]),
  ...TONES.flatMap((tone): ContrastPair[] => [
    { fg: `${tone}.text`, bg: `${tone}.subtle`, kind: 'text', use: `${tone} pill / banner` },
    { fg: `${tone}.text`, bg: 'surface', kind: 'text', use: `${tone} text on a card` },
    { fg: `${tone}.text`, bg: 'background', kind: 'text', use: `${tone} text on the canvas` },
  ]),
  { fg: 'borderStrong', bg: 'surface', kind: 'ui', use: 'text field outline on a card' },
  { fg: 'borderStrong', bg: 'background', kind: 'ui', use: 'text field outline on the canvas' },
  { fg: 'focus', bg: 'surface', kind: 'ui', use: 'focus ring on a card' },
  { fg: 'focus', bg: 'background', kind: 'ui', use: 'focus ring on the canvas' },
];

/** 4-pt spacing scale: `space[4]` is 16. Keys are multiples of 4 px. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;
export type SpaceToken = keyof typeof space;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Touch targets. Android's guidance is 48 dp minimum; the one primary action per screen gets 56. */
export const touch = {
  min: 48,
  comfortable: 56,
} as const;

export type FontWeight = '400' | '500' | '600' | '700';
export type TypeStyle = { fontSize: number; lineHeight: number; fontWeight: FontWeight; letterSpacing?: number };

/**
 * Type scale on the system font (Roboto on Android, SF on iOS); no custom font files to load. Nothing
 * is smaller than 14, and line heights are generous (≈ 1.4–1.5×) for easy scanning. Sizes are dp and
 * scale with the user's font-size setting.
 */
export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.25 },
  headline: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  subtitle: { fontSize: 18, lineHeight: 26, fontWeight: '600' },
  bodyLarge: { fontSize: 18, lineHeight: 26, fontWeight: '400' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  label: { fontSize: 16, lineHeight: 22, fontWeight: '600', letterSpacing: 0.1 },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  /** Ids and codes; rendered in the platform monospace font. */
  mono: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
} as const satisfies Record<string, TypeStyle>;
export type TypeVariant = keyof typeof typography;

/** Platform monospace families (selected with Platform.select by the Text component). */
export const monoFontFamily = { android: 'monospace', ios: 'Menlo', default: 'monospace' } as const;

/**
 * Motion. Durations are ms; easings are cubic-bezier control points (for Reanimated's Easing.bezier),
 * taken from Material 3 so motion feels native on Android. `morph` is reserved for the Phase 1
 * timer-ring → exercise-card handoff.
 *
 * Reduced motion: when the OS setting is on, use `motionFor()` — movement is replaced by a short
 * cross-fade (opacity only), never removed outright, so state changes are still noticeable.
 */
export const motion = {
  duration: { instant: 0, fast: 120, base: 200, slow: 320, morph: 520 },
  easing: {
    standard: [0.2, 0, 0, 1],
    decelerate: [0.05, 0.7, 0.1, 1],
    accelerate: [0.3, 0, 0.8, 0.15],
  },
  /** Spring for shared-element style transitions (Reanimated withSpring config). */
  spring: { damping: 22, stiffness: 180, mass: 1 },
} as const;
export type MotionDuration = keyof typeof motion.duration;

export type MotionSpec = {
  duration: number;
  easing: readonly [number, number, number, number];
  /** 'move' = transforms allowed; 'fade' = animate opacity only. */
  kind: 'move' | 'fade';
};

export function motionFor(
  duration: MotionDuration,
  reduceMotion: boolean,
  easing: keyof typeof motion.easing = 'standard',
): MotionSpec {
  if (reduceMotion) {
    return {
      duration: Math.min(motion.duration[duration], motion.duration.fast),
      easing: motion.easing.standard,
      kind: 'fade',
    };
  }
  return { duration: motion.duration[duration], easing: motion.easing[easing], kind: 'move' };
}

export type ElevationLevel = 0 | 1 | 2 | 3;

/**
 * Elevation. Android draws `elevation` shadows; iOS uses the shadow* props. Dark mode relies on lighter
 * surfaces rather than shadows (shadows vanish on dark backgrounds), so components pair a level with
 * `surface`/`surfaceMuted` instead of stacking shadows.
 */
export const elevation: Record<
  ElevationLevel,
  { elevation: number; shadowOpacity: number; shadowRadius: number; shadowOffsetY: number }
> = {
  0: { elevation: 0, shadowOpacity: 0, shadowRadius: 0, shadowOffsetY: 0 },
  1: { elevation: 1, shadowOpacity: 0.06, shadowRadius: 3, shadowOffsetY: 1 },
  2: { elevation: 3, shadowOpacity: 0.1, shadowRadius: 8, shadowOffsetY: 2 },
  3: { elevation: 6, shadowOpacity: 0.14, shadowRadius: 16, shadowOffsetY: 6 },
};
