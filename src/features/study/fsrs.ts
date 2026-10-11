/**
 * FSRS on the phone (DECISIONS.md, Phase 2 decision 9): the one module that imports ts-fsrs.
 *
 * ts-fsrs 5.4.2 assigns four helpers to Date.prototype when it is imported (removed in 6.0), so it is
 * imported here only. Everything else in the app works with card_states rows and these functions.
 *
 * What this module decides:
 * - The scheduler's parameters: DualRep's defaults (ts-fsrs defaults plus fuzz, see
 *   DUALREP_FSRS_DEFAULTS), with the user's `profiles.fsrs_params` laid over them when set and valid.
 *   A bad value there is ignored field by field, never fatal: studying must always work.
 * - Row ↔ card: a card_states row is turned into ts-fsrs input explicitly (toCardInput) and the result
 *   back into exactly the columns we store (cardStateColumns). ts-fsrs passes unknown fields through
 *   to its result and still wants the deprecated `elapsed_days` on input, so neither direction spreads
 *   whole objects.
 * - The review time is clamped to max(now, last_review). A phone clock that went back would otherwise
 *   make ts-fsrs throw (more than a day back: "Invalid delta_t") or produce a last_review older than
 *   the stored one, which the server's stale-write guard (skip_stale_card_state) would silently skip.
 * - Every value is checked against the card_states / reviews CHECK constraints before it is returned,
 *   so a surprising result is refused here (RangeError) instead of being dropped by the server later.
 */
import {
  checkParameters,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type CardInput,
  type FSRS,
  type FSRSParameters,
  type Grade,
  type StepUnit,
} from 'ts-fsrs';

import { isoTimestamp } from '@/lib/time';

/** reviews.rating values (ts-fsrs Rating without Manual). */
export const RATING = { again: 1, hard: 2, good: 3, easy: 4 } as const;
export type StudyGrade = (typeof RATING)[keyof typeof RATING];

/** card_states.state / reviews.state values (ts-fsrs State). */
export const CARD_STATE = { new: 0, learning: 1, review: 2, relearning: 3 } as const;
export type CardStateValue = (typeof CARD_STATE)[keyof typeof CARD_STATE];

export function isGrade(value: unknown): value is StudyGrade {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/**
 * DualRep's scheduler defaults: ts-fsrs's (retention 0.9, maximum interval 36500 days, learning steps
 * 1 min and 10 min, relearning 10 min, the 21 FSRS-6 weights) with fuzz turned on. Fuzz spreads the
 * 20–40 cards one lecture creates over neighbouring days instead of making them all due on the same
 * day; ts-fsrs seeds it from the review itself, so the same answer always gives the same due date (a
 * replay of the reviews log reproduces the phone's result). `profiles.fsrs_params = null` means these.
 */
export const DUALREP_FSRS_DEFAULTS: Readonly<Partial<FSRSParameters>> = Object.freeze({ enable_fuzz: true });

/** The FSRS settings a profile may override. */
export type FsrsSettings = Partial<
  Pick<
    FSRSParameters,
    'w' | 'request_retention' | 'maximum_interval' | 'enable_fuzz' | 'enable_short_term' | 'learning_steps' | 'relearning_steps'
  >
>;

const STEP_PATTERN = /^\d+(\.\d+)?[mhd]$/;

function steps(value: unknown): StepUnit[] | undefined {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  if (!value.every((step) => typeof step === 'string' && STEP_PATTERN.test(step) && parseFloat(step) > 0)) return undefined;
  return value as StepUnit[];
}

function weights(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.every((n) => typeof n === 'number')) return undefined;
  try {
    return [...checkParameters(value as number[])];
  } catch {
    return undefined;
  }
}

/**
 * The valid fields of `profiles.fsrs_params` (JSON text on the phone, or an already parsed value).
 * Accepts an object with any of the FsrsSettings fields, or a bare array of 17, 19 or 21 weights (what
 * the FSRS optimizer prints). Invalid fields are left out, so the defaults apply to them.
 */
export function parseFsrsParams(value: unknown): FsrsSettings {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.trim() === '') return {};
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (Array.isArray(parsed)) {
    const w = weights(parsed);
    return w ? { w } : {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const raw = parsed as Record<string, unknown>;
  const settings: FsrsSettings = {};
  const w = weights(raw.w);
  if (w) settings.w = w;
  const retention = raw.request_retention;
  if (typeof retention === 'number' && retention >= 0.7 && retention <= 0.99) settings.request_retention = retention;
  const maxInterval = raw.maximum_interval;
  if (typeof maxInterval === 'number' && Number.isInteger(maxInterval) && maxInterval >= 1 && maxInterval <= 36500) {
    settings.maximum_interval = maxInterval;
  }
  if (typeof raw.enable_fuzz === 'boolean') settings.enable_fuzz = raw.enable_fuzz;
  if (typeof raw.enable_short_term === 'boolean') settings.enable_short_term = raw.enable_short_term;
  const learning = steps(raw.learning_steps);
  if (learning) settings.learning_steps = learning;
  const relearning = steps(raw.relearning_steps);
  if (relearning) settings.relearning_steps = relearning;
  return settings;
}

/** The full parameter set for a profile's fsrs_params (DualRep defaults + valid overrides). */
export function fsrsParametersFor(fsrsParams: unknown): FSRSParameters {
  return generatorParameters({ ...DUALREP_FSRS_DEFAULTS, ...parseFsrsParams(fsrsParams) });
}

const schedulers = new Map<string, FSRS>();

/**
 * The scheduler for a profile's fsrs_params, made once per distinct value (a profile rarely changes;
 * the cache holds at most a few entries).
 */
export function schedulerFor(fsrsParams: unknown = null): FSRS {
  const settings = parseFsrsParams(fsrsParams);
  const key = JSON.stringify(settings);
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    if (schedulers.size >= 8) schedulers.clear();
    scheduler = fsrs(generatorParameters({ ...DUALREP_FSRS_DEFAULTS, ...settings }));
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

/** The FSRS columns of a card_states row as read from the phone's database (any may be null). */
export type FsrsStateRow = {
  state: number | null;
  due: string | null;
  stability: number | null;
  difficulty: number | null;
  scheduled_days: number | null;
  learning_steps: number | null;
  reps: number | null;
  lapses: number | null;
  last_review: string | null;
};

function nonNegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function wholeNonNegative(value: number | null | undefined): number {
  return Math.round(nonNegative(value));
}

/** Epoch ms of an ISO timestamp, or null when missing or unreadable. */
export function parseIso(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * ts-fsrs input from a stored row. `elapsed_days` is required by the 5.x type but ignored (ts-fsrs
 * recomputes it from last_review). Unreadable values fall back to a New card's: a due date that
 * cannot be read counts as due now (`fallbackMs`), an unreadable last_review as none.
 */
export function toCardInput(row: FsrsStateRow, fallbackMs: number): CardInput {
  const state = typeof row.state === 'number' && Number.isInteger(row.state) && row.state >= 0 && row.state <= 3 ? row.state : 0;
  const lastReview = parseIso(row.last_review);
  return {
    due: new Date(parseIso(row.due) ?? fallbackMs),
    stability: nonNegative(row.stability),
    difficulty: Math.min(10, nonNegative(row.difficulty)),
    elapsed_days: 0,
    scheduled_days: wholeNonNegative(row.scheduled_days),
    learning_steps: wholeNonNegative(row.learning_steps),
    reps: wholeNonNegative(row.reps),
    lapses: wholeNonNegative(row.lapses),
    state,
    last_review: lastReview === null ? null : new Date(lastReview),
  };
}

/**
 * When an answer counts as given: the answer time, but never before the card's last review (a phone
 * clock that was set back). Throws a RangeError for a time that is not a finite number.
 */
export function clampReviewTime(answeredAtMs: number, lastReview: string | null | undefined): number {
  if (!Number.isFinite(answeredAtMs)) throw new RangeError(`Invalid answer time: ${answeredAtMs}`);
  const last = parseIso(lastReview);
  return last === null ? answeredAtMs : Math.max(answeredAtMs, last);
}

/**
 * Whole UTC calendar days from `fromMs` to `toMs`, never negative: reviews.elapsed_days. The same
 * rule as ts-fsrs's dateDiffInDays, computed here so ts-fsrs 6 (which drops elapsed_days) changes
 * nothing.
 */
export function utcDayDiff(fromMs: number, toMs: number): number {
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  return Math.max(0, Math.round((day(toMs) - day(fromMs)) / 86_400_000));
}

/** card_states' FSRS columns as stored (timestamps as ISO text with ms). */
export type CardStateColumns = {
  state: CardStateValue;
  due: string;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  last_review: string;
};

function checkWhole(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of 0 or more, got ${value}`);
  return value;
}

/**
 * The columns to store for a card after a review at `reviewedAtMs`, checked against the CHECK
 * constraints (state 0–3, stability ≥ 0, difficulty 0–10, whole counts ≥ 0).
 */
export function cardStateColumns(card: Card, reviewedAtMs: number): CardStateColumns {
  const state = card.state as number;
  if (!Number.isInteger(state) || state < 0 || state > 3) throw new RangeError(`Invalid FSRS state: ${state}`);
  if (!Number.isFinite(card.stability) || card.stability < 0) throw new RangeError(`Invalid stability: ${card.stability}`);
  if (!Number.isFinite(card.difficulty) || card.difficulty < 0 || card.difficulty > 10) {
    throw new RangeError(`Invalid difficulty: ${card.difficulty}`);
  }
  return {
    state: state as CardStateValue,
    due: isoTimestamp(card.due.getTime()),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: checkWhole('scheduled_days', card.scheduled_days),
    learning_steps: checkWhole('learning_steps', card.learning_steps),
    reps: checkWhole('reps', card.reps),
    lapses: checkWhole('lapses', card.lapses),
    last_review: isoTimestamp(reviewedAtMs),
  };
}

export type ReviewOutcome = {
  /** The review time actually used (the answer time, clamped to the last review). */
  reviewedAt: number;
  /** The card's columns after the review. */
  next: CardStateColumns;
  /** The state before the review (0 for a card never answered). */
  prevState: CardStateValue;
  /** Whole UTC days since the last review (0 for the first). */
  elapsedDays: number;
};

/**
 * Schedules one answer: the card's state after rating it `grade` at `answeredAtMs`. `row` is its
 * card_states row, or null when the card was never answered (a new card starts at the review time).
 */
export function scheduleAnswer(
  row: FsrsStateRow | null,
  answeredAtMs: number,
  grade: StudyGrade,
  scheduler: FSRS = schedulerFor(),
): ReviewOutcome {
  if (!isGrade(grade)) throw new RangeError(`Invalid grade: ${String(grade)}`);
  const reviewedAt = clampReviewTime(answeredAtMs, row?.last_review);
  const input = row ? toCardInput(row, reviewedAt) : createEmptyCard(reviewedAt);
  const { card } = scheduler.next(input, reviewedAt, grade as Grade);
  const last = parseIso(row?.last_review);
  return {
    reviewedAt,
    next: cardStateColumns(card, reviewedAt),
    prevState: (row ? (input.state as CardStateValue) : CARD_STATE.new),
    elapsedDays: last === null ? 0 : utcDayDiff(last, reviewedAt),
  };
}

/**
 * When the card would come back for each grade (epoch ms), for the hints on the rating buttons
 * ("Back in 10 min"). Same clamp and parameters as scheduleAnswer.
 */
export function previewDue(
  row: FsrsStateRow | null,
  answeredAtMs: number,
  scheduler: FSRS = schedulerFor(),
): Record<StudyGrade, number> {
  const at = clampReviewTime(answeredAtMs, row?.last_review);
  const input = row ? toCardInput(row, at) : createEmptyCard(at);
  const preview = scheduler.repeat(input, at);
  return {
    1: preview[1].card.due.getTime(),
    2: preview[2].card.due.getTime(),
    3: preview[3].card.due.getTime(),
    4: preview[4].card.due.getTime(),
  };
}

/**
 * How long until a card comes back, in plain words: "1 min", "10 min", "3 hours", "1 day", "4 days",
 * "2 months", "1 year". Under a minute reads "now".
 */
export function describeWait(ms: number): string {
  const minutes = Math.round(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  if (days < 31) return days === 1 ? '1 day' : `${days} days`;
  const months = Math.round(days / 30.4);
  if (months < 12) return months === 1 ? '1 month' : `${months} months`;
  const years = Math.round(days / 365);
  return years === 1 ? '1 year' : `${years} years`;
}
