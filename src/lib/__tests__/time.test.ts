import { describe, expect, it } from '@jest/globals';

import { isoTimestamp } from '../time';

describe('isoTimestamp', () => {
  it('writes UTC with milliseconds, so stored times compare as text', () => {
    expect(isoTimestamp(Date.UTC(2026, 9, 8, 9, 30, 0, 0))).toBe('2026-10-08T09:30:00.000Z');
    expect(isoTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoTimestamp(Date.UTC(2026, 9, 8, 9, 30, 0, 7)) < isoTimestamp(Date.UTC(2026, 9, 8, 10, 0, 0, 0))).toBe(true);
  });

  it('refuses a time that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => isoTimestamp(bad)).toThrow(RangeError);
    }
    expect(() => isoTimestamp(Number.NaN)).toThrow('Invalid timestamp: NaN');
  });
});
