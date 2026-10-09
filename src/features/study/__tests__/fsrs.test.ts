/**
 * The ts-fsrs wrapper: parameters from profiles.fsrs_params, row ↔ card mapping, the clock-back
 * clamp, and the values a review produces (the probe numbers from the Phase 2 research, which ran
 * ts-fsrs 5.4.2 on Node and on Hermes with identical results).
 */
import { describe, expect, it } from '@jest/globals';

import {
  CARD_STATE,
  cardStateColumns,
  clampReviewTime,
  describeWait,
  DUALREP_FSRS_DEFAULTS,
  fsrsParametersFor,
  isGrade,
  parseFsrsParams,
  previewDue,
  RATING,
  scheduleAnswer,
  schedulerFor,
  toCardInput,
  utcDayDiff,
  type FsrsStateRow,
  type StudyGrade,
} from '../fsrs';

const T0 = Date.UTC(2026, 9, 9, 9, 0, 0, 0); // 2026-10-09T09:00:00.000Z
const MIN = 60_000;
const DAY = 86_400_000;
const exact = schedulerFor({ enable_fuzz: false });

/** A row as the phone stores it after a review (ISO text, numbers). */
function rowFrom(next: ReturnType<typeof scheduleAnswer>['next']): FsrsStateRow {
  return { ...next };
}

const W21 = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
  0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

describe('parseFsrsParams', () => {
  it('is empty for null, blank, unreadable or non-object values', () => {
    for (const value of [null, undefined, '', '   ', '{oops', 42, true, '"text"']) {
      expect(parseFsrsParams(value)).toEqual({});
    }
  });

  it('accepts a bare weights array of 17, 19 or 21 numbers (the optimizer output)', () => {
    expect(parseFsrsParams(W21)).toEqual({ w: W21 });
    expect(parseFsrsParams(JSON.stringify(W21.slice(0, 19)))).toEqual({ w: W21.slice(0, 19) });
    expect(parseFsrsParams(W21.slice(0, 17))).toEqual({ w: W21.slice(0, 17) });
    expect(parseFsrsParams(W21.slice(0, 20))).toEqual({});
    expect(parseFsrsParams([...W21.slice(0, 20), Number.NaN])).toEqual({});
    expect(parseFsrsParams([...W21.slice(0, 20), '1'])).toEqual({});
  });

  it('keeps each valid field of an object and drops the invalid ones', () => {
    const text = JSON.stringify({
      w: W21,
      request_retention: 0.85,
      maximum_interval: 365,
      enable_fuzz: false,
      enable_short_term: true,
      learning_steps: ['1m', '10m', '1h'],
      relearning_steps: [],
      unknown: 1,
    });
    expect(parseFsrsParams(text)).toEqual({
      w: W21,
      request_retention: 0.85,
      maximum_interval: 365,
      enable_fuzz: false,
      enable_short_term: true,
      learning_steps: ['1m', '10m', '1h'],
      relearning_steps: [],
    });
    expect(
      parseFsrsParams({
        w: [1, 2, 3],
        request_retention: 1,
        maximum_interval: 2.5,
        enable_fuzz: 'yes',
        learning_steps: ['10x'],
        relearning_steps: ['0m'],
      }),
    ).toEqual({});
    expect(parseFsrsParams({ request_retention: 0.5 })).toEqual({});
    expect(parseFsrsParams({ maximum_interval: 40000 })).toEqual({});
    expect(parseFsrsParams({ learning_steps: Array(11).fill('1m') })).toEqual({});
  });
});

describe('parameters and schedulers', () => {
  it('DualRep defaults are ts-fsrs defaults with fuzz on', () => {
    expect(DUALREP_FSRS_DEFAULTS).toEqual({ enable_fuzz: true });
    const params = fsrsParametersFor(null);
    expect(params.enable_fuzz).toBe(true);
    expect(params.request_retention).toBe(0.9);
    expect(params.maximum_interval).toBe(36500);
    expect(params.enable_short_term).toBe(true);
    expect(params.learning_steps).toEqual(['1m', '10m']);
    expect(params.relearning_steps).toEqual(['10m']);
    expect(params.w).toHaveLength(21);
    expect(params.w[0]).toBeCloseTo(0.212, 6);
  });

  it('lays the profile settings over the defaults', () => {
    const params = fsrsParametersFor('{"request_retention":0.8,"enable_fuzz":false}');
    expect(params.request_retention).toBe(0.8);
    expect(params.enable_fuzz).toBe(false);
    expect(fsrsParametersFor('{"request_retention":2}').request_retention).toBe(0.9);
  });

  it('makes one scheduler per distinct setting', () => {
    expect(schedulerFor(null)).toBe(schedulerFor(undefined));
    expect(schedulerFor(null)).toBe(schedulerFor('{"request_retention":5}'));
    expect(schedulerFor('{"enable_fuzz":false}')).toBe(exact);
    expect(schedulerFor(null)).not.toBe(exact);
  });
});

describe('toCardInput', () => {
  const row: FsrsStateRow = {
    state: 2,
    due: '2026-10-11T09:10:30.000Z',
    stability: 2.3065,
    difficulty: 2.1,
    scheduled_days: 2,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    last_review: '2026-10-09T09:10:30.000Z',
  };

  it('maps the stored columns, with dates parsed and the dummy elapsed_days', () => {
    expect(toCardInput(row, T0)).toEqual({
      due: new Date('2026-10-11T09:10:30.000Z'),
      stability: 2.3065,
      difficulty: 2.1,
      elapsed_days: 0,
      scheduled_days: 2,
      learning_steps: 0,
      reps: 2,
      lapses: 0,
      state: 2,
      last_review: new Date('2026-10-09T09:10:30.000Z'),
    });
  });

  it('turns unreadable values into a New card’s', () => {
    const input = toCardInput(
      {
        state: 7,
        due: 'garbage',
        stability: null,
        difficulty: 12,
        scheduled_days: -1,
        learning_steps: Number.NaN,
        reps: 2.6,
        lapses: null,
        last_review: 'nope',
      },
      T0,
    );
    expect(input).toEqual({
      due: new Date(T0),
      stability: 0,
      difficulty: 10,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 3,
      lapses: 0,
      state: 0,
      last_review: null,
    });
  });
});

describe('clampReviewTime and utcDayDiff', () => {
  it('never lets a review be earlier than the last one', () => {
    expect(clampReviewTime(T0, null)).toBe(T0);
    expect(clampReviewTime(T0, '2026-10-09T08:00:00.000Z')).toBe(T0);
    expect(clampReviewTime(T0, '2026-10-12T09:00:00.000Z')).toBe(T0 + 3 * DAY);
    expect(clampReviewTime(T0, 'garbage')).toBe(T0);
    expect(() => clampReviewTime(Number.NaN, null)).toThrow(RangeError);
  });

  it('counts whole UTC calendar days, never negative', () => {
    expect(utcDayDiff(T0, T0 + 10 * MIN)).toBe(0);
    expect(utcDayDiff(Date.UTC(2026, 9, 9, 23, 59), Date.UTC(2026, 9, 10, 0, 1))).toBe(1);
    expect(utcDayDiff(T0, T0 + 4 * DAY + 3 * MIN)).toBe(4);
    expect(utcDayDiff(T0 + DAY, T0)).toBe(0);
    // Across the spring DST change in Europe: UTC days are unaffected.
    expect(utcDayDiff(Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 30, 12))).toBe(2);
  });
});

describe('scheduleAnswer', () => {
  it('a new card answered Good goes to Learning, due in 10 minutes (probe values)', () => {
    const outcome = scheduleAnswer(null, T0, RATING.good, exact);
    expect(outcome.reviewedAt).toBe(T0);
    expect(outcome.prevState).toBe(CARD_STATE.new);
    expect(outcome.elapsedDays).toBe(0);
    expect(outcome.next).toEqual({
      state: 1,
      due: '2026-10-09T09:10:00.000Z',
      stability: 2.3065,
      difficulty: expect.closeTo(2.11810397, 6),
      scheduled_days: 0,
      learning_steps: 1,
      reps: 1,
      lapses: 0,
      last_review: '2026-10-09T09:00:00.000Z',
    });
  });

  it('the first answer per grade matches the probe table', () => {
    const at = (grade: StudyGrade) => scheduleAnswer(null, T0, grade, exact).next;
    expect(at(RATING.again)).toMatchObject({ state: 1, due: '2026-10-09T09:01:00.000Z', stability: 0.212, learning_steps: 0 });
    expect(at(RATING.again).difficulty).toBeCloseTo(6.4133, 4);
    expect(at(RATING.hard)).toMatchObject({ state: 1, due: '2026-10-09T09:06:00.000Z', stability: 1.2931 });
    expect(at(RATING.hard).difficulty).toBeCloseTo(5.11217071, 6);
    expect(at(RATING.easy)).toMatchObject({ state: 2, due: '2026-10-17T09:00:00.000Z', stability: 8.2956, scheduled_days: 8, difficulty: 1 });
  });

  it('a stored row (ISO text) schedules exactly like the card it came from: second Good → Review in 2 days', () => {
    const first = scheduleAnswer(null, T0, RATING.good, exact);
    const second = scheduleAnswer(rowFrom(first.next), T0 + 10 * MIN + 30_000, RATING.good, exact);
    expect(second.prevState).toBe(CARD_STATE.learning);
    expect(second.elapsedDays).toBe(0);
    expect(second.next).toMatchObject({
      state: 2,
      due: '2026-10-11T09:10:30.000Z',
      scheduled_days: 2,
      stability: 2.3065,
      reps: 2,
      last_review: '2026-10-09T09:10:30.000Z',
    });
  });

  it('a review card answered Again two days late relearns, with one lapse and the elapsed days', () => {
    const first = scheduleAnswer(null, T0, RATING.good, exact);
    const second = scheduleAnswer(rowFrom(first.next), T0 + 10 * MIN + 30_000, RATING.good, exact);
    const late = Date.parse(second.next.due) + 2 * DAY;
    const third = scheduleAnswer(rowFrom(second.next), late, RATING.again, exact);
    expect(third.prevState).toBe(CARD_STATE.review);
    expect(third.elapsedDays).toBe(4);
    expect(third.next.state).toBe(CARD_STATE.relearning);
    expect(third.next.lapses).toBe(1);
    expect(third.next.due).toBe(new Date(late + 10 * MIN).toISOString());
  });

  it('a clock set back (by an hour or by days) is clamped to the last review: no throw, no older last_review', () => {
    const first = scheduleAnswer(null, T0, RATING.good, exact);
    const row = rowFrom(first.next);
    for (const back of [60 * MIN, 3 * DAY]) {
      const outcome = scheduleAnswer(row, T0 - back, RATING.good, exact);
      expect(outcome.reviewedAt).toBe(T0);
      expect(outcome.next.last_review).toBe(row.last_review);
      expect(outcome.elapsedDays).toBe(0);
    }
  });

  it('fuzz (on by default) is deterministic, and every value fits the CHECK constraints over many answers', () => {
    const fuzzed = schedulerFor(null);
    const grades: StudyGrade[] = [3, 3, 3, 1, 3, 3, 4, 2, 3, 3, 1, 3];
    let row: FsrsStateRow | null = null;
    let at = T0;
    for (const grade of grades) {
      const a = scheduleAnswer(row, at, grade, fuzzed);
      const b = scheduleAnswer(row, at, grade, fuzzed);
      expect(b).toEqual(a);
      const next = a.next;
      expect(Number.isInteger(next.state) && next.state >= 0 && next.state <= 3).toBe(true);
      expect(Number.isInteger(next.scheduled_days) && next.scheduled_days >= 0).toBe(true);
      expect(next.difficulty).toBeGreaterThanOrEqual(1);
      expect(next.difficulty).toBeLessThanOrEqual(10);
      expect(next.stability).toBeGreaterThanOrEqual(0.001);
      expect(next.due >= next.last_review).toBe(true);
      expect(a.elapsedDays).toBeGreaterThanOrEqual(0);
      row = rowFrom(next);
      at = Date.parse(next.due) + 5 * MIN;
    }
  });

  it('refuses a grade outside 1–4', () => {
    for (const bad of [0, 5, 2.5, Number.NaN]) {
      expect(() => scheduleAnswer(null, T0, bad as StudyGrade, exact)).toThrow(RangeError);
    }
    expect(isGrade(1)).toBe(true);
    expect(isGrade('3')).toBe(false);
  });
});

describe('cardStateColumns', () => {
  const card = {
    due: new Date(T0 + 10 * MIN),
    stability: 2,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 1,
    reps: 1,
    lapses: 0,
    state: 1,
    last_review: new Date(T0),
  };

  it('stores timestamps as ISO text with ms and keeps only the stored columns', () => {
    expect(cardStateColumns(card, T0)).toEqual({
      state: 1,
      due: '2026-10-09T09:10:00.000Z',
      stability: 2,
      difficulty: 5,
      scheduled_days: 0,
      learning_steps: 1,
      reps: 1,
      lapses: 0,
      last_review: '2026-10-09T09:00:00.000Z',
    });
  });

  it('refuses values the database would refuse', () => {
    const bad = (extra: Record<string, unknown>) => ({ ...card, ...extra }) as unknown as Parameters<typeof cardStateColumns>[0];
    expect(() => cardStateColumns(bad({ state: 4 }), T0)).toThrow(RangeError);
    expect(() => cardStateColumns(bad({ difficulty: 10.5 }), T0)).toThrow(RangeError);
    expect(() => cardStateColumns(bad({ stability: -1 }), T0)).toThrow(RangeError);
    expect(() => cardStateColumns(bad({ scheduled_days: 1.5 }), T0)).toThrow(RangeError);
    expect(() => cardStateColumns(bad({ reps: -1 }), T0)).toThrow(RangeError);
    expect(() => cardStateColumns(bad({ due: new Date(Number.NaN) }), T0)).toThrow(RangeError);
  });
});

describe('previewDue and describeWait', () => {
  it('gives each grade’s next due time, in grade order for a new card', () => {
    const due = previewDue(null, T0, exact);
    expect(due[1]).toBe(T0 + MIN);
    expect(due[2]).toBe(T0 + 6 * MIN);
    expect(due[3]).toBe(T0 + 10 * MIN);
    expect(due[4]).toBe(T0 + 8 * DAY);
  });

  it('clamps the preview like an answer', () => {
    const row = rowFrom(scheduleAnswer(null, T0, RATING.good, exact).next);
    expect(previewDue(row, T0 - 3 * DAY, exact)).toEqual(previewDue(row, T0, exact));
  });

  it('describes waits in plain words', () => {
    const cases: [number, string][] = [
      [0, 'now'],
      [20_000, 'now'],
      [MIN, '1 min'],
      [10 * MIN, '10 min'],
      [59 * MIN, '59 min'],
      [60 * MIN, '1 hour'],
      [5 * 60 * MIN, '5 hours'],
      [DAY, '1 day'],
      [8 * DAY, '8 days'],
      [45 * DAY, '1 month'],
      [200 * DAY, '7 months'],
      [365 * DAY, '1 year'],
      [3 * 365 * DAY, '3 years'],
      [-5, 'now'],
      [Number.NaN, 'now'],
    ];
    for (const [ms, text] of cases) expect(describeWait(ms)).toBe(text);
  });
});
