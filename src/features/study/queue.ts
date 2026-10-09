/**
 * Which card comes next in a focus block: the quiz-first study queue (pure; no React, no database).
 *
 * A block runs, in priority order:
 *   0. the closing self-test, in the block's last 2–5 minutes: the cards this block introduced or got
 *      wrong, asked once more (at most 5);
 *   1. learning and relearning cards that are due (their 1- and 10-minute steps come back inside the
 *      same block);
 *   2. due reviews, interleaved across sources (a cumulative plan studying everything so far) or
 *      topics (otherwise): the group served least in this block goes next, ties to the most overdue;
 *   3. new cards, up to `newPerBlock` per block (5 in a 25-minute block) and `dailyNewCap` a day (20);
 *   4. a learning card due within a minute: wait for it ("Next card in 0:42", or ask it now);
 *   5. nothing left: start the self-test early, then free focus until the timer ends. There is no
 *      passive reread mode.
 *
 * Everything the queue needs to remember about a block comes from the database (this block's answers
 * in `reviews`, by interval_block_id), so a restart picks up where the block was, with nothing extra
 * saved. The only exception is when the self-test began (`selfTestFrom`), which the caller keeps; by
 * default it is derived from the time left.
 *
 * Reviews come first, as in Anki, unless the plan has a target date and unseen cards: then reviews
 * stop once they have used 60% of the block's study time, so new material keeps moving.
 *
 * Times are epoch ms. Candidates come from the queries in studyQueries.ts (already filtered to the
 * plan, the chosen source, unsuspended cards and non-draft topics).
 */
import { CARD_STATE, type FsrsStateRow } from './fsrs';

export const QUEUE_RULES = {
  /** The closing self-test: 12% of the block, at least 2 and at most 5 minutes, at most 5 cards. */
  selfTestShare: 0.12,
  selfTestMinMs: 2 * 60_000,
  selfTestMaxMs: 5 * 60_000,
  selfTestMaxItems: 5,
  /** New cards per block: one per 5 minutes of block, 2 to 8 (25 minutes → 5). */
  newPerBlockMin: 2,
  newPerBlockMax: 8,
  minutesPerNewCard: 5,
  /** New cards a day (a setting; this is the default). */
  dailyNewCap: 20,
  /** With a target date and unseen cards, reviews get at most this share of the block's study time. */
  reviewBudgetShare: 0.6,
  /** Assumed time of an answer whose duration was not recorded. */
  reviewEstimateMs: 10_000,
  /** A learning card due this soon is waited for instead of ending the block's study. */
  waitMs: 60_000,
} as const;

const R = QUEUE_RULES;

/** What a card shows, from cards (+ its topic and source). */
export type StudyCard = {
  cardId: string;
  question: string;
  answer: string;
  cardType: string;
  page: number | null;
  topicId: string | null;
  topicPosition: number;
  sourceId: string | null;
  /** The source's title, or null when the card has none or the source is not on the phone. */
  sourceTitle: string | null;
};

/** A card that has a state row and is not new: learning, review or relearning. */
export type DueCandidate = StudyCard & {
  state: number;
  /** Epoch ms. */
  due: number;
  /** The FSRS columns, for the answer and the button hints. */
  stateRow: FsrsStateRow;
};

/** A card never answered (no state row, or a state row still New, e.g. made by suspending). */
export type NewCandidate = StudyCard & { stateRow: FsrsStateRow | null };

/** One answer given in this block (reviews WHERE interval_block_id = the block). */
export type BlockAnswer = {
  cardId: string;
  prevState: number;
  rating: number;
  reviewedAt: number;
  durationMs: number | null;
  /** The card's source and topic, for interleaving (null when unknown). */
  sourceId: string | null;
  topicId: string | null;
};

export type QueueSettings = {
  newPerBlock: number;
  dailyNewCap: number;
};

export type QueueInput = {
  now: number;
  /** The block's full length. */
  blockMs: number;
  /** Focus time left in the block (pauses excluded). */
  remainingMs: number;
  /** Learning, relearning and review cards due by the block's end (any order). */
  due: readonly DueCandidate[];
  /** New cards in the order they should be introduced. */
  fresh: readonly NewCandidate[];
  /** This block's answers (any order). */
  blockAnswers: readonly BlockAnswer[];
  /** New cards introduced today on this phone, this block's included. */
  newToday: number;
  settings: QueueSettings;
  /** 'source' for a cumulative plan studying everything so far, else 'topic'. */
  interleaveBy: 'source' | 'topic';
  /** True when the plan's pace needs new cards (a target date and unseen cards): the review budget applies. */
  prioritizeNew: boolean;
  /** When the self-test began, if the caller knows; else derived from remainingMs. */
  selfTestFrom?: number | null;
  /**
   * Review cards (FSRS state Review) due by this time count as due now; the app passes the end of
   * the local day (endOfLocalDay). FSRS schedules reviews in whole days, so a card reviewed at 09:02
   * comes back at 09:02 some days later and belongs to that day's 09:00 block, not to a moment two
   * minutes into it (asking it early by minutes changes nothing for FSRS, and fsrs.ts clamps the
   * time). Learning and relearning steps (minutes apart) stay exact. Default: `now`.
   */
  reviewDueBy?: number;
  /**
   * Cards answered a moment ago whose new state the queries have not returned yet (they refresh at
   * most once a second): left out so the same card is never asked twice in a row by mistake.
   */
  exclude?: ReadonlySet<string>;
};

export type QueueReason = 'self_test' | 'learning' | 'review' | 'new';

export type QueueCard = StudyCard & { stateRow: FsrsStateRow | null; reason: QueueReason };

export type QueueNext =
  /** Ask this card. `selfTestFrom` is set when this card starts the self-test (keep it). */
  | { type: 'card'; card: QueueCard; selfTestFrom: number | null }
  /** A learning card comes back at `until`: wait for it, or ask it now. */
  | { type: 'wait'; until: number; card: QueueCard }
  /** Nothing to ask: free focus until the timer ends. */
  | { type: 'done'; reason: 'self_test_done' | 'nothing_to_retest' | 'all_caught_up' };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The last millisecond of the phone's local day containing `ms` (daylight-saving changes included). */
export function endOfLocalDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(24, 0, 0, 0);
  return day.getTime() - 1;
}

/**
 * Whether a learning, relearning or review card is due now: a review by its day (`reviewDueBy`), a
 * learning step by its minute. New cards are never "due".
 */
export function isDueNow(card: Pick<DueCandidate, 'state' | 'due'>, input: Pick<QueueInput, 'now' | 'reviewDueBy'>): boolean {
  if (card.state === CARD_STATE.new) return false;
  const by = card.state === CARD_STATE.review ? Math.max(input.now, input.reviewDueBy ?? input.now) : input.now;
  return card.due <= by;
}

/** Length of the closing self-test for a block of `blockMs`. */
export function selfTestMs(blockMs: number): number {
  return clamp(Math.round(R.selfTestShare * Math.max(0, blockMs)), R.selfTestMinMs, R.selfTestMaxMs);
}

/** Default new cards per block of `blockMinutes`. */
export function newPerBlockFor(blockMinutes: number): number {
  const minutes = Number.isFinite(blockMinutes) ? blockMinutes : 25;
  return clamp(Math.round(minutes / R.minutesPerNewCard), R.newPerBlockMin, R.newPerBlockMax);
}

/** When the self-test window of this block began (or begins), in wall-clock ms. */
export function selfTestStart(input: Pick<QueueInput, 'now' | 'blockMs' | 'remainingMs' | 'selfTestFrom'>): number {
  if (typeof input.selfTestFrom === 'number' && Number.isFinite(input.selfTestFrom)) return input.selfTestFrom;
  return input.now - (selfTestMs(input.blockMs) - input.remainingMs);
}

/**
 * The self-test's cards: this block's cards answered as new (prev_state 0) or wrong (rating 1)
 * before the self-test began, oldest first, at most 5. `pending` are those not answered since.
 */
export function selfTestItems(
  answers: readonly BlockAnswer[],
  from: number,
): { all: string[]; pending: string[] } {
  const firstQualifying = new Map<string, number>();
  const answeredSince = new Set<string>();
  for (const answer of answers) {
    if (answer.reviewedAt >= from) {
      answeredSince.add(answer.cardId);
      continue;
    }
    if (answer.prevState === CARD_STATE.new || answer.rating === 1) {
      const seen = firstQualifying.get(answer.cardId);
      if (seen === undefined || answer.reviewedAt < seen) firstQualifying.set(answer.cardId, answer.reviewedAt);
    }
  }
  const all = [...firstQualifying.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, R.selfTestMaxItems)
    .map(([cardId]) => cardId);
  return { all, pending: all.filter((cardId) => !answeredSince.has(cardId)) };
}

/** Distinct cards introduced (answered as new) in this block. */
export function newIntroduced(answers: readonly BlockAnswer[]): number {
  return new Set(answers.filter((a) => a.prevState === CARD_STATE.new).map((a) => a.cardId)).size;
}

/** Study time this block has spent on reviews (answers of cards that were in Review). */
export function reviewTimeMs(answers: readonly BlockAnswer[]): number {
  return answers
    .filter((a) => a.prevState === CARD_STATE.review)
    .reduce((sum, a) => sum + (typeof a.durationMs === 'number' && a.durationMs >= 0 ? a.durationMs : R.reviewEstimateMs), 0);
}

function lastAnswered(answers: readonly BlockAnswer[]): BlockAnswer | null {
  let last: BlockAnswer | null = null;
  for (const answer of answers) if (!last || answer.reviewedAt >= last.reviewedAt) last = answer;
  return last;
}

/** Prefer anything but `avoid`; fall back to it when it is all there is. */
function avoidRepeat<T extends { cardId: string }>(list: readonly T[], avoid: string | null): T[] {
  if (!avoid || list.length < 2) return [...list];
  const others = list.filter((item) => item.cardId !== avoid);
  return others.length > 0 ? others : [...list];
}

function byDue(a: DueCandidate, b: DueCandidate): number {
  return a.due - b.due || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0);
}

const groupOf = (by: 'source' | 'topic', item: { sourceId: string | null; topicId: string | null }) =>
  (by === 'source' ? item.sourceId : item.topicId) ?? '';

/**
 * The due review to ask next: groups (sources or topics) take turns. The group answered least in this
 * block goes first; among equals, the one with the most overdue card. Within a group, most overdue first.
 */
export function pickReview(
  reviews: readonly DueCandidate[],
  answers: readonly BlockAnswer[],
  by: 'source' | 'topic',
): DueCandidate | null {
  if (reviews.length === 0) return null;
  const served = new Map<string, number>();
  for (const answer of answers) {
    if (answer.prevState !== CARD_STATE.review) continue;
    const key = groupOf(by, answer);
    served.set(key, (served.get(key) ?? 0) + 1);
  }
  const best = new Map<string, DueCandidate>();
  for (const review of reviews) {
    const key = groupOf(by, review);
    const current = best.get(key);
    if (!current || byDue(review, current) < 0) best.set(key, review);
  }
  const groups = [...best.entries()].sort(
    ([keyA, a], [keyB, b]) => (served.get(keyA) ?? 0) - (served.get(keyB) ?? 0) || byDue(a, b),
  );
  return groups[0][1];
}

function asCard(item: DueCandidate | NewCandidate, reason: QueueReason): QueueCard {
  const { cardId, question, answer, cardType, page, topicId, topicPosition, sourceId, sourceTitle, stateRow } = item;
  return { cardId, question, answer, cardType, page, topicId, topicPosition, sourceId, sourceTitle, stateRow, reason };
}

/** The next thing to show in the block. */
export function nextItem(rawInput: QueueInput): QueueNext {
  const exclude = rawInput.exclude;
  const input: QueueInput =
    exclude && exclude.size > 0
      ? {
          ...rawInput,
          due: rawInput.due.filter((d) => !exclude.has(d.cardId)),
          fresh: rawInput.fresh.filter((f) => !exclude.has(f.cardId)),
        }
      : rawInput;
  const { now, blockAnswers } = input;
  const last = lastAnswered(blockAnswers);
  const lastId = last?.cardId ?? null;
  const dueByCard = new Map(input.due.map((d) => [d.cardId, d]));
  const freshByCard = new Map(input.fresh.map((f) => [f.cardId, f]));
  const windowMs = selfTestMs(input.blockMs);
  const inWindow = input.remainingMs <= windowMs || (typeof input.selfTestFrom === 'number' && input.selfTestFrom <= now);

  // A card for the self-test: its due state if it has one (a learning step), else the new card row.
  const selfTestCard = (cardId: string): QueueCard | null => {
    const known = dueByCard.get(cardId) ?? freshByCard.get(cardId);
    return known ? asCard(known, 'self_test') : null;
  };

  // 0. The closing self-test.
  if (inWindow) {
    const from = selfTestStart(input);
    const { all, pending } = selfTestItems(blockAnswers, from);
    const askable = avoidRepeat(
      pending.map((cardId) => ({ cardId, card: selfTestCard(cardId) })).filter((x) => x.card !== null),
      lastId,
    );
    if (askable.length > 0) {
      const startsNow = typeof input.selfTestFrom === 'number' ? null : from;
      return { type: 'card', card: askable[0].card as QueueCard, selfTestFrom: startsNow };
    }
    return { type: 'done', reason: all.length > 0 ? 'self_test_done' : 'nothing_to_retest' };
  }

  // 1. Learning and relearning steps that are due.
  const learning = input.due
    .filter((d) => (d.state === CARD_STATE.learning || d.state === CARD_STATE.relearning) && d.due <= now)
    .sort(byDue);
  const learningPick = avoidRepeat(learning, lastId)[0];
  if (learningPick && !(learningPick.cardId === lastId && hasOther(input, lastId))) {
    return { type: 'card', card: asCard(learningPick, 'learning'), selfTestFrom: null };
  }

  // 2. Due reviews, interleaved, within the review budget.
  const reviews = input.due.filter((d) => d.state === CARD_STATE.review && isDueNow(d, input) && d.cardId !== lastId);
  const newLeft = newAllowance(input) > 0 && input.fresh.some((f) => f.cardId !== lastId);
  const budget = R.reviewBudgetShare * Math.max(0, input.blockMs - windowMs);
  const overBudget = input.prioritizeNew && newLeft && reviewTimeMs(blockAnswers) >= budget;
  if (!overBudget) {
    const review = pickReview(reviews, blockAnswers, input.interleaveBy);
    if (review) return { type: 'card', card: asCard(review, 'review'), selfTestFrom: null };
  }

  // 3. New cards.
  if (newAllowance(input) > 0) {
    const fresh = avoidRepeat(input.fresh, lastId)[0];
    if (fresh && fresh.cardId !== lastId) return { type: 'card', card: asCard(fresh, 'new'), selfTestFrom: null };
  }

  // Over the review budget but no new card could be shown after all: reviews again.
  if (overBudget) {
    const review = pickReview(reviews, blockAnswers, input.interleaveBy);
    if (review) return { type: 'card', card: asCard(review, 'review'), selfTestFrom: null };
  }

  // The card just answered, if it is all that is due (a learning step answered Again a minute ago).
  if (learningPick) return { type: 'card', card: asCard(learningPick, 'learning'), selfTestFrom: null };

  // 4. A learning step due within a minute: wait for it.
  const soon = input.due
    .filter((d) => (d.state === CARD_STATE.learning || d.state === CARD_STATE.relearning) && d.due > now)
    .sort(byDue)[0];
  if (soon && soon.due - now <= R.waitMs) return { type: 'wait', until: soon.due, card: asCard(soon, 'learning') };

  // 5. Nothing left: the self-test starts early (never with the card just answered: asking it again
  // at once tests nothing; its learning step brings it back later).
  const { pending } = selfTestItems(blockAnswers, now);
  const early = pending
    .filter((cardId) => cardId !== lastId)
    .map((cardId) => selfTestCard(cardId))
    .filter((card) => card !== null);
  if (early.length > 0) return { type: 'card', card: early[0], selfTestFrom: now };
  return { type: 'done', reason: 'all_caught_up' };
}

/** Whether anything other than `cardId` can be asked right now (a due card or an allowed new one). */
function hasOther(input: QueueInput, cardId: string | null): boolean {
  if (input.due.some((d) => d.cardId !== cardId && isDueNow(d, input))) return true;
  return newAllowance(input) > 0 && input.fresh.some((f) => f.cardId !== cardId);
}

/** How many more new cards this block may introduce (block and daily caps). */
export function newAllowance(input: Pick<QueueInput, 'blockAnswers' | 'newToday' | 'settings'>): number {
  const block = input.settings.newPerBlock - newIntroduced(input.blockAnswers);
  const day = input.settings.dailyNewCap - input.newToday;
  return Math.max(0, Math.min(block, day));
}

/** Cards due now and new cards available, for the block's header ("12 due · 5 new"). */
export function queueCounts(input: Pick<QueueInput, 'now' | 'reviewDueBy' | 'due' | 'fresh' | 'blockAnswers' | 'newToday' | 'settings'>): {
  due: number;
  fresh: number;
} {
  const due = input.due.filter((d) => isDueNow(d, input)).length;
  return { due, fresh: Math.min(input.fresh.length, newAllowance(input)) };
}

// ------------------------------------------------------------------------------------------------
// Which source a block studies, and the plan's pace
// ------------------------------------------------------------------------------------------------

export type StudyScope = 'single' | 'cumulative';
/** 'all' = everything so far; 'newest' = the newest source only (cumulative plans). */
export type StudyFilter = 'all' | 'newest';

export type PlanSourceInfo = {
  sourceId: string;
  title: string;
  /** plan_sources.added_at, epoch ms (null when unknown). */
  addedAt: number | null;
  /** Cards of this source in the plan (ready to study). */
  cards: number;
};

export type ResolvedScope = {
  /** The source to study, or null for every card of the plan. */
  sourceId: string | null;
  /** One line explaining a fallback, or null. */
  note: string | null;
};

function newestFirst(a: PlanSourceInfo, b: PlanSourceInfo): number {
  return (b.addedAt ?? -Infinity) - (a.addedAt ?? -Infinity) || (a.sourceId < b.sourceId ? -1 : 1);
}

/**
 * The source a block studies. Switching scope or filter never touches card_states, so progress is
 * never reset; only what is asked changes.
 * - single: the plan's only source. A plan switched back from cumulative uses its newest source
 *   with cards, and says so.
 * - cumulative, all: every card of the plan.
 * - cumulative, newest: the newest source; if it has no cards yet (still being made), everything,
 *   and says so.
 */
export function resolveScope(scope: StudyScope, filter: StudyFilter, sources: readonly PlanSourceInfo[]): ResolvedScope {
  const sorted = [...sources].sort(newestFirst);
  if (scope === 'single') {
    if (sorted.length <= 1) return { sourceId: sorted[0]?.sourceId ?? null, note: null };
    const withCards = sorted.find((s) => s.cards > 0);
    if (!withCards) return { sourceId: null, note: null };
    return { sourceId: withCards.sourceId, note: `Single source: ${withCards.title || 'Untitled'}` };
  }
  if (filter === 'all' || sorted.length === 0) return { sourceId: null, note: null };
  const newest = sorted[0];
  if (newest.cards > 0) return { sourceId: newest.sourceId, note: null };
  return { sourceId: null, note: `${newest.title || 'The newest source'} isn’t ready yet. Studying everything so far.` };
}

export type Pace = {
  /** Days left to learn before the target date, today included (0 when it has passed). */
  daysLeft: number;
  /** New cards a day needed to see every unseen card in time. */
  neededPerDay: number;
  /** How many unseen cards the daily cap lets you see in time. */
  seeable: number;
  /** True when the cap is too low to see them all. */
  behind: boolean;
};

/** Local calendar day number of a 'YYYY-MM-DD' date or of epoch ms (days since 1970 in local time). */
function localDay(value: string | number): number | null {
  if (typeof value === 'number') {
    const d = new Date(value);
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

/**
 * The plan's pace toward its target date (study_plans.target_date), or null without one. The target
 * day itself is not counted (the exam is that day).
 */
export function planPace(unseen: number, targetDate: string | null, now: number, dailyNewCap: number): Pace | null {
  if (!targetDate) return null;
  const target = localDay(targetDate);
  const today = localDay(now);
  if (target === null || today === null) return null;
  const left = Math.max(0, Math.max(0, unseen));
  const daysLeft = Math.max(0, target - today);
  const neededPerDay = left === 0 ? 0 : daysLeft === 0 ? left : Math.ceil(left / daysLeft);
  const seeable = Math.min(left, Math.max(0, dailyNewCap) * daysLeft);
  return { daysLeft, neededPerDay, seeable, behind: seeable < left };
}

/** The pace line, or null when on track: "At this pace you'll see 140 of 200 cards before the exam." */
export function describePace(pace: Pace | null, unseen: number): string | null {
  if (!pace || !pace.behind) return null;
  if (pace.daysLeft === 0) return `The target date has come. ${unseen} card${unseen === 1 ? '' : 's'} not seen yet.`;
  return `At this pace you’ll see ${pace.seeable} of ${unseen} cards before the target date.`;
}
