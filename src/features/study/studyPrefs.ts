/**
 * Study settings that belong to this phone, not to the account (Phase 2 decision 10): how answers
 * are given (2 or 4 rating buttons, typed short answers), the daily review reminder, and the new-card
 * pace. Kept in the local-only `local_state` table (key `study-prefs`), like the alert settings: a
 * tablet used for typing and a phone used on the bus may well want different ones. Cleared with the
 * rest of the local data on sign-out.
 *
 * Also the start panel's last choice (key `study-defaults`): the plan and filter a new cycle starts
 * with.
 */
import { useCallback, useMemo } from 'react';

import { readLocalState, useLocalState, writeLocalState } from '@/features/cycle/localState';

import { RATING, type StudyGrade } from './fsrs';
import { isTypable } from './matcher';
import { QUEUE_RULES, type StudyFilter } from './queue';

export const STUDY_PREFS_KEY = 'study-prefs';
export const STUDY_DEFAULTS_KEY = 'study-defaults';

export type ReminderPref = {
  enabled: boolean;
  /** Local time of day, 0–23 and 0–59. */
  hour: number;
  minute: number;
};

export type StudyPrefs = {
  /** 2: "Missed it" / "Got it" (Again / Good), the default. 4: Again / Hard / Good / Easy. */
  answerButtons: 2 | 4;
  /** Type short answers (checked on the phone, matcher.ts) instead of revealing them. Off by default. */
  typedAnswers: boolean;
  reminder: ReminderPref;
  /** New cards a day, 5–100 (default 20). */
  dailyNewCap: number;
  /** New cards per focus block, 1–20, or null: from the block's length (5 in 25 minutes). */
  newPerBlock: number | null;
};

export const PREF_LIMITS = { dailyNewCap: { min: 5, max: 100 }, newPerBlock: { min: 1, max: 20 } } as const;

export const DEFAULT_STUDY_PREFS: StudyPrefs = Object.freeze({
  answerButtons: 2,
  typedAnswers: false,
  // Off until the user turns it on; 18:00 is the time offered.
  reminder: Object.freeze({ enabled: false, hour: 18, minute: 0 }),
  dailyNewCap: QUEUE_RULES.dailyNewCap,
  newPerBlock: null,
}) as StudyPrefs;

function wholeIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Stored prefs (any JSON) read defensively: each missing or invalid field takes its default. */
export function parseStudyPrefs(value: unknown): StudyPrefs {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const reminder = typeof raw.reminder === 'object' && raw.reminder !== null ? (raw.reminder as Record<string, unknown>) : {};
  return {
    answerButtons: raw.answerButtons === 4 ? 4 : 2,
    typedAnswers: raw.typedAnswers === true,
    reminder: {
      enabled: reminder.enabled === true,
      hour: wholeIn(reminder.hour, 0, 23) ?? DEFAULT_STUDY_PREFS.reminder.hour,
      minute: wholeIn(reminder.minute, 0, 59) ?? DEFAULT_STUDY_PREFS.reminder.minute,
    },
    dailyNewCap: wholeIn(raw.dailyNewCap, PREF_LIMITS.dailyNewCap.min, PREF_LIMITS.dailyNewCap.max) ?? DEFAULT_STUDY_PREFS.dailyNewCap,
    newPerBlock: wholeIn(raw.newPerBlock, PREF_LIMITS.newPerBlock.min, PREF_LIMITS.newPerBlock.max),
  };
}

export type StudyPrefsPatch = Partial<Omit<StudyPrefs, 'reminder'>> & { reminder?: Partial<ReminderPref> };

/** The prefs after a change; values out of range are refused (RangeError) rather than stored. */
export function applyPrefsPatch(prefs: StudyPrefs, patch: StudyPrefsPatch): StudyPrefs {
  const next: StudyPrefs = { ...prefs, ...patch, reminder: { ...prefs.reminder, ...(patch.reminder ?? {}) } };
  const parsed = parseStudyPrefs(next);
  const same =
    parsed.answerButtons === next.answerButtons &&
    parsed.typedAnswers === next.typedAnswers &&
    parsed.reminder.enabled === next.reminder.enabled &&
    parsed.reminder.hour === next.reminder.hour &&
    parsed.reminder.minute === next.reminder.minute &&
    parsed.dailyNewCap === next.dailyNewCap &&
    parsed.newPerBlock === next.newPerBlock;
  if (!same) throw new RangeError('Invalid study setting');
  return parsed;
}

export async function readStudyPrefs(): Promise<StudyPrefs> {
  try {
    return parseStudyPrefs(await readLocalState<unknown>(STUDY_PREFS_KEY));
  } catch {
    return DEFAULT_STUDY_PREFS;
  }
}

/** Saves a change to this phone's study settings and returns them. */
export async function saveStudyPrefs(patch: StudyPrefsPatch): Promise<StudyPrefs> {
  const next = applyPrefsPatch(await readStudyPrefs(), patch);
  await writeLocalState(STUDY_PREFS_KEY, next);
  return next;
}

/** This phone's study settings, live. Must be used under `PowerSyncContext.Provider`. */
export function useStudyPrefs(): { prefs: StudyPrefs; isLoading: boolean; save: (patch: StudyPrefsPatch) => Promise<StudyPrefs> } {
  const { value, isLoading } = useLocalState<unknown>(STUDY_PREFS_KEY);
  const prefs = useMemo(() => parseStudyPrefs(value), [value]);
  const save = useCallback((patch: StudyPrefsPatch) => saveStudyPrefs(patch), []);
  return { prefs, isLoading, save };
}

// ---- How a card is answered ---------------------------------------------------------------------

export type RatingButton = { grade: StudyGrade; label: string };

/** The rating buttons after "Show answer". */
export function ratingButtons(answerButtons: 2 | 4): RatingButton[] {
  if (answerButtons === 4) {
    return [
      { grade: RATING.again, label: 'Again' },
      { grade: RATING.hard, label: 'Hard' },
      { grade: RATING.good, label: 'Good' },
      { grade: RATING.easy, label: 'Easy' },
    ];
  }
  return [
    { grade: RATING.again, label: 'Missed it' },
    { grade: RATING.good, label: 'Got it' },
  ];
}

/** Typed only when the setting is on and the card suits it (a short basic or cloze answer). */
export function answerModeFor(card: { cardType: string; answer: string }, prefs: Pick<StudyPrefs, 'typedAnswers'>): 'typed' | 'self_graded' {
  return prefs.typedAnswers && isTypable(card) ? 'typed' : 'self_graded';
}

// ---- The start panel's last choice --------------------------------------------------------------

export type StudyDefaults = { planId: string | null; filter: StudyFilter };

export function parseStudyDefaults(value: unknown): StudyDefaults {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    planId: typeof raw.planId === 'string' && raw.planId !== '' ? raw.planId : null,
    filter: raw.filter === 'newest' ? 'newest' : 'all',
  };
}

export async function readStudyDefaults(): Promise<StudyDefaults> {
  try {
    return parseStudyDefaults(await readLocalState<unknown>(STUDY_DEFAULTS_KEY));
  } catch {
    return parseStudyDefaults(null);
  }
}

export async function saveStudyDefaults(defaults: StudyDefaults): Promise<void> {
  await writeLocalState(STUDY_DEFAULTS_KEY, parseStudyDefaults(defaults));
}
