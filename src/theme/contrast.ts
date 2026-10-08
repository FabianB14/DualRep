/**
 * WCAG 2.x contrast math (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio). Pure functions so the
 * palette can be checked in unit tests instead of by eye.
 */

/** Minimum ratios for level AA. */
export const WCAG_AA = {
  /** Body text (1.4.3). */
  text: 4.5,
  /** Large text (≥ 24 px regular or ≥ 18.66 px bold), icons and control boundaries (1.4.3, 1.4.11). */
  large: 3,
  ui: 3,
} as const;

/** Parses #rgb or #rrggbb into 0–255 channels. Throws on anything else so a typo fails loudly. */
export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a hex color: ${hex}`);
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  const value = parseInt(digits, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Relative luminance of an sRGB color, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colors, from 1 (identical) to 21 (black on white). Order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG's "large text" threshold: 18 pt (24 px) regular, or 14 pt (≈ 18.66 px) bold. */
export function isLargeText(fontSize: number, fontWeight: string | number = '400'): boolean {
  const weight = typeof fontWeight === 'number' ? fontWeight : fontWeight === 'bold' ? 700 : Number(fontWeight) || 400;
  return fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
}
