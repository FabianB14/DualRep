import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import {
  answerModeFor,
  applyPrefsPatch,
  DEFAULT_STUDY_PREFS,
  parseStudyDefaults,
  parseStudyPrefs,
  ratingButtons,
  readStudyDefaults,
  readStudyPrefs,
  saveStudyDefaults,
  saveStudyPrefs,
  STUDY_DEFAULTS_KEY,
  STUDY_PREFS_KEY,
  useStudyPrefs,
} from '../studyPrefs';

jest.mock('../../cycle/localState', () => ({
  readLocalState: jest.fn(async () => null),
  writeLocalState: jest.fn(async () => undefined),
  useLocalState: jest.fn(() => ({ value: null, isLoading: false })),
}));
type AnyMock = jest.Mock<(...args: any[]) => any>;
const local = jest.requireMock('../../cycle/localState') as Record<string, AnyMock>;

beforeEach(() => {
  jest.clearAllMocks();
  local.readLocalState.mockResolvedValue(null);
  local.writeLocalState.mockResolvedValue(undefined);
  local.useLocalState.mockReturnValue({ value: null, isLoading: false });
});

describe('parseStudyPrefs', () => {
  it('defaults: two buttons, no typing, reminder off at 18:00, 20 new a day, per-block from the length', () => {
    expect(parseStudyPrefs(null)).toEqual({
      answerButtons: 2,
      typedAnswers: false,
      reminder: { enabled: false, hour: 18, minute: 0 },
      dailyNewCap: 20,
      newPerBlock: null,
    });
    expect(parseStudyPrefs('junk')).toEqual(DEFAULT_STUDY_PREFS);
  });

  it('keeps valid fields and replaces invalid ones with defaults', () => {
    expect(
      parseStudyPrefs({ answerButtons: 4, typedAnswers: true, reminder: { enabled: true, hour: 7, minute: 30 }, dailyNewCap: 30, newPerBlock: 3 }),
    ).toEqual({ answerButtons: 4, typedAnswers: true, reminder: { enabled: true, hour: 7, minute: 30 }, dailyNewCap: 30, newPerBlock: 3 });
    expect(
      parseStudyPrefs({ answerButtons: 3, typedAnswers: 'yes', reminder: { enabled: 1, hour: 24, minute: -1 }, dailyNewCap: 500, newPerBlock: 0 }),
    ).toEqual(DEFAULT_STUDY_PREFS);
  });
});

describe('applyPrefsPatch and saving', () => {
  it('merges a change, the reminder field by field', () => {
    const next = applyPrefsPatch(DEFAULT_STUDY_PREFS, { reminder: { enabled: true }, answerButtons: 4 });
    expect(next).toEqual({ ...DEFAULT_STUDY_PREFS, answerButtons: 4, reminder: { enabled: true, hour: 18, minute: 0 } });
  });

  it('refuses values out of range', () => {
    expect(() => applyPrefsPatch(DEFAULT_STUDY_PREFS, { dailyNewCap: 1 })).toThrow(RangeError);
    expect(() => applyPrefsPatch(DEFAULT_STUDY_PREFS, { reminder: { hour: 25 } })).toThrow(RangeError);
    expect(() => applyPrefsPatch(DEFAULT_STUDY_PREFS, { answerButtons: 3 as 2 })).toThrow(RangeError);
  });

  it('reads and saves under the study-prefs key', async () => {
    local.readLocalState.mockResolvedValue({ typedAnswers: true });
    await expect(readStudyPrefs()).resolves.toEqual({ ...DEFAULT_STUDY_PREFS, typedAnswers: true });
    expect(local.readLocalState).toHaveBeenCalledWith(STUDY_PREFS_KEY);
    const saved = await saveStudyPrefs({ dailyNewCap: 30 });
    expect(saved).toEqual({ ...DEFAULT_STUDY_PREFS, typedAnswers: true, dailyNewCap: 30 });
    expect(local.writeLocalState).toHaveBeenCalledWith('study-prefs', saved);
    local.readLocalState.mockRejectedValueOnce(new Error('closed'));
    await expect(readStudyPrefs()).resolves.toEqual(DEFAULT_STUDY_PREFS);
  });

  it('useStudyPrefs watches the key and parses it', () => {
    local.useLocalState.mockReturnValue({ value: { answerButtons: 4 }, isLoading: false });
    let seen: ReturnType<typeof useStudyPrefs> | null = null;
    function Probe() {
      seen = useStudyPrefs();
      return null;
    }
    act(() => {
      create(createElement(Probe));
    });
    expect(local.useLocalState).toHaveBeenCalledWith('study-prefs');
    expect(seen!.prefs.answerButtons).toBe(4);
    expect(seen!.isLoading).toBe(false);
  });
});

describe('answering', () => {
  it('two buttons by default (Missed it / Got it), four on request', () => {
    expect(ratingButtons(2)).toEqual([
      { grade: 1, label: 'Missed it' },
      { grade: 3, label: 'Got it' },
    ]);
    expect(ratingButtons(4).map((b) => [b.grade, b.label])).toEqual([
      [1, 'Again'],
      [2, 'Hard'],
      [3, 'Good'],
      [4, 'Easy'],
    ]);
  });

  it('types only when the setting is on and the card suits it', () => {
    expect(answerModeFor({ cardType: 'basic', answer: 'ATP' }, { typedAnswers: true })).toBe('typed');
    expect(answerModeFor({ cardType: 'basic', answer: 'ATP' }, { typedAnswers: false })).toBe('self_graded');
    expect(answerModeFor({ cardType: 'why', answer: 'ATP' }, { typedAnswers: true })).toBe('self_graded');
    expect(answerModeFor({ cardType: 'basic', answer: 'a long answer with far too many words in it' }, { typedAnswers: true })).toBe('self_graded');
  });
});

describe('the start panel’s last choice', () => {
  it('reads and saves the plan and filter', async () => {
    expect(parseStudyDefaults(null)).toEqual({ planId: null, filter: 'all' });
    expect(parseStudyDefaults({ planId: 'p1', filter: 'newest' })).toEqual({ planId: 'p1', filter: 'newest' });
    expect(parseStudyDefaults({ planId: '', filter: 'odd' })).toEqual({ planId: null, filter: 'all' });
    local.readLocalState.mockResolvedValue({ planId: 'p2' });
    await expect(readStudyDefaults()).resolves.toEqual({ planId: 'p2', filter: 'all' });
    await saveStudyDefaults({ planId: 'p3', filter: 'newest' });
    expect(local.writeLocalState).toHaveBeenCalledWith(STUDY_DEFAULTS_KEY, { planId: 'p3', filter: 'newest' });
  });
});
