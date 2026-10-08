import { describe, expect, it } from '@jest/globals';

import { contrastRatio, hexToRgb, isLargeText, relativeLuminance, WCAG_AA } from '../contrast';
import {
  CONTRAST_PAIRS,
  motionFor,
  palettes,
  resolveColor,
  space,
  touch,
  typography,
  type ColorScheme,
  type Palette,
} from '../tokens';

const SCHEMES: ColorScheme[] = ['light', 'dark'];

/** Every leaf color in a palette, as [path, value]. */
function allColors(node: object, prefix = ''): [string, string][] {
  return Object.entries(node).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : allColors(value as object, `${prefix}${key}.`),
  );
}

describe('contrast math', () => {
  it('parses short and long hex colors', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#3A55A4')).toEqual([0x3a, 0x55, 0xa4]);
    expect(() => hexToRgb('rgb(0,0,0)')).toThrow('Not a hex color');
  });

  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    // #767676 on white is the well-known "just passes AA" gray (4.54:1).
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });

  it('classifies large text like WCAG', () => {
    expect(isLargeText(24)).toBe(true);
    expect(isLargeText(22, '600')).toBe(false);
    expect(isLargeText(19, '700')).toBe(true);
    expect(isLargeText(19, 'bold')).toBe(true);
    expect(isLargeText(16, '700')).toBe(false);
  });
});

describe.each(SCHEMES)('%s palette', (scheme) => {
  const palette: Palette = palettes[scheme];

  it.each(CONTRAST_PAIRS.map((pair) => [pair.use, pair] as const))('meets WCAG AA: %s', (_use, pair) => {
    const ratio = contrastRatio(resolveColor(palette, pair.fg), resolveColor(palette, pair.bg));
    const minimum = pair.kind === 'text' ? WCAG_AA.text : WCAG_AA.ui;
    expect({ pair: `${pair.fg} on ${pair.bg}`, ratio: Number(ratio.toFixed(2)), ok: ratio >= minimum }).toEqual({
      pair: `${pair.fg} on ${pair.bg}`,
      ratio: Number(ratio.toFixed(2)),
      ok: true,
    });
  });

  it('avoids glare: no pure white canvas or surface, no pure black text', () => {
    for (const [, value] of allColors(palette)) {
      expect(value.toUpperCase()).not.toBe('#FFFFFF');
      expect(value.toUpperCase()).not.toBe('#000000');
    }
  });

  it('keeps body text below maximum contrast (calm, not harsh)', () => {
    expect(contrastRatio(palette.text, palette.background)).toBeLessThan(17);
  });

  it('uses only valid hex colors', () => {
    for (const [path, value] of allColors(palette)) {
      expect([path, /^#[0-9A-F]{6}$/i.test(value)]).toEqual([path, true]);
    }
  });
});

describe('other tokens', () => {
  it('keeps the spacing scale on a 4-pt grid', () => {
    for (const [key, value] of Object.entries(space)) {
      expect(value).toBe(Number(key) * 4);
    }
  });

  it('meets the 48 dp touch target minimum', () => {
    expect(touch.min).toBeGreaterThanOrEqual(48);
    expect(touch.comfortable).toBeGreaterThan(touch.min);
  });

  it('never goes below 14 dp text and keeps line height ≥ 1.15×', () => {
    for (const style of Object.values(typography)) {
      expect(style.fontSize).toBeGreaterThanOrEqual(14);
      expect(style.lineHeight / style.fontSize).toBeGreaterThanOrEqual(1.15);
    }
  });

  it('replaces movement with a short fade under reduced motion', () => {
    expect(motionFor('morph', false)).toMatchObject({ duration: 520, kind: 'move' });
    expect(motionFor('morph', true)).toMatchObject({ duration: 120, kind: 'fade' });
    expect(motionFor('instant', true).duration).toBe(0);
  });
});
