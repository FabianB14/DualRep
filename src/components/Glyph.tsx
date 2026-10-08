import Svg, { Path } from 'react-native-svg';

/**
 * The few line icons the app draws. They are SVG paths (react-native-svg is already installed) rather
 * than an icon font, so nothing extra is bundled or loaded at startup. Icons are always decorative:
 * the control next to or around them carries the accessible name.
 */
export type GlyphName = 'chevron-right' | 'check' | 'minus' | 'plus' | 'close';

const PATHS: Record<GlyphName, string> = {
  'chevron-right': 'M9 5l7 7-7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
};

export type GlyphProps = {
  name: GlyphName;
  color: string;
  /** Width and height in dp (the paths are drawn on a 24-unit grid). */
  size?: number;
  strokeWidth?: number;
};

export function Glyph({ name, color, size = 20, strokeWidth = 2.25 }: GlyphProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path d={PATHS[name]} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
