/**
 * The study panel's card flow and its words (pure, so the flow and the phrasing are unit-tested; the
 * panel itself is StudyPanel.tsx).
 *
 * A card the queue offers is pinned as the panel's open card, so it never changes under the user
 * while they read it (the queue's own choice moves on as cards fall due). It goes through stages:
 *
 *   learn ──Quiz me──▶ question ──Show answer──▶ revealed ──rating──▶ (written; next card)
 *   (new cards only)            └─Check (typed)─▶ right: written as Good; next card
 *                                                 wrong: the answer, then "I missed it" / "Count it as right"
 *
 * - A new card is shown, then quizzed: its question and answer together first ("read it"), then the
 *   answer hides and the user recalls it. Every other card (recall, the closing self-test) is
 *   quiz-first: the question alone.
 * - Self-grading uses 2 buttons (Missed it / Got it) or 4 (Again / Hard / Good / Easy) from this
 *   phone's setting, each with when the card comes back. Typed answers (opt-in, short answers only;
 *   matcher.ts) are rated Good when they match and never Hard or Easy.
 * - The answer mode is fixed when the card is pinned, so changing a setting mid-card changes nothing.
 * - `shownAt` is when the quiz began (the question alone on screen): reviews.duration_ms measures
 *   recall, not reading a new card.
 */
import { formatClock } from '@/features/timer/timerMath';

import { describeWait, parseIso, RATING, type StudyGrade } from '../fsrs';
import type { TypedVerdict } from '../matcher';
import type { QueueCard, QueueNext, QueueReason } from '../queue';
import type { AnswerMode, AnswerResult } from '../studyRepo';
import type { RatingButton } from '../studyPrefs';

export type CardStage =
  /** A new card, question and answer together: read it, then "Quiz me". */
  | 'learn'
  /** The question alone: "Show answer", or type and "Check". */
  | 'question'
  /** Self-graded: the answer and the rating buttons. */
  | 'revealed'
  /** Typed and not matched: the answer, "I missed it" or "Count it as right". */
  | 'wrong';

export type OpenCard = {
  /** The focus block the card was pinned in (interval_blocks.id). */
  blockId: string;
  card: QueueCard;
  stage: CardStage;
  mode: AnswerMode;
  /** reviews.id, made at the first attempt to save, so a retried save is recognised as the same answer. */
  reviewId: string | null;
  /** When the quiz began (epoch ms); null while a new card is being read. */
  shownAt: number | null;
  /** What the user typed (typed mode). */
  typed: string;
  /** The typed answer's check, once made. */
  verdict: TypedVerdict | null;
  /** When the card comes back for each grade (epoch ms), worked out when the answer is revealed. */
  preview: Record<StudyGrade, number> | null;
  /** When `preview` was worked out (the hints count from it). */
  previewAt: number | null;
};

/** Pins a card the queue offers. */
export function openCard(card: QueueCard, blockId: string, now: number, mode: AnswerMode): OpenCard {
  const learn = card.reason === 'new';
  return {
    blockId,
    card,
    stage: learn ? 'learn' : 'question',
    mode,
    reviewId: null,
    shownAt: learn ? null : now,
    typed: '',
    verdict: null,
    preview: null,
    previewAt: null,
  };
}

/** "Quiz me" on a new card: the answer hides and the quiz begins now. */
export function quizMe(open: OpenCard, now: number): OpenCard {
  if (open.stage !== 'learn') return open;
  return { ...open, stage: 'question', shownAt: now };
}

/** "Show answer" (self-graded), with when the card would come back for each grade. */
export function reveal(open: OpenCard, preview: Record<StudyGrade, number> | null, now: number): OpenCard {
  if (open.stage !== 'question') return open;
  return { ...open, stage: 'revealed', preview, previewAt: now };
}

/** A typed answer was checked and did not match: the answer shows with the two choices. */
export function markWrong(open: OpenCard, verdict: TypedVerdict): OpenCard {
  if (open.stage !== 'question') return open;
  return { ...open, stage: 'wrong', verdict };
}

/** Whether the answer is on screen. */
export function answerVisible(stage: CardStage): boolean {
  return stage !== 'question';
}

/** The card's kind, as its label says it. */
export function reasonLabel(reason: QueueReason): string {
  switch (reason) {
    case 'self_test':
      return 'Self-test';
    case 'new':
      return 'New card';
    default:
      return 'Recall';
  }
}

/** One line under the label for some cards (what this step is), or null. */
export function reasonNote(reason: QueueReason, stage: CardStage): string | null {
  if (reason === 'new' && stage === 'learn') return 'Read it, then test yourself.';
  if (reason === 'self_test') return 'This block’s new and missed cards, once more.';
  return null;
}

/** The queue's counts: "8 to recall · 3 new", or null when there is nothing left. */
export function countsLine(counts: { due: number; fresh: number }): string | null {
  const parts = [counts.due > 0 ? `${counts.due} to recall` : null, counts.fresh > 0 ? `${counts.fresh} new` : null];
  const said = parts.filter((part): part is string => part !== null);
  return said.length > 0 ? said.join(' · ') : null;
}

/** "Back in 3 days", "Back in 10 min", "Back in a moment". */
export function backIn(dueMs: number | null, at: number): string {
  if (dueMs === null || !Number.isFinite(dueMs)) return 'Saved';
  const wait = describeWait(dueMs - at);
  return wait === 'now' ? 'Back in a moment' : `Back in ${wait}`;
}

/** The hint under a rating button: "10 min", "3 days", "under 1 min" (null without a preview). */
export function ratingHint(open: Pick<OpenCard, 'preview' | 'previewAt'>, grade: StudyGrade): string | null {
  if (!open.preview || open.previewAt === null) return null;
  const wait = describeWait(open.preview[grade] - open.previewAt);
  return wait === 'now' ? 'under 1 min' : wait;
}

/** What a button's grade is called when the answer is confirmed ("Got it", "Again"). */
export function gradeWord(grade: StudyGrade, buttons: readonly RatingButton[]): string {
  return buttons.find((button) => button.grade === grade)?.label ?? (grade === RATING.again ? 'Missed it' : 'Got it');
}

/** How the answer was given, for the line after it. */
export type AnswerOutcome =
  | { kind: 'graded'; word: string }
  | { kind: 'typed_right'; verdict: TypedVerdict }
  | { kind: 'typed_missed' }
  | { kind: 'typed_counted' };

/**
 * The line shown after an answer is saved: what it counted as and when the card comes back.
 * "Got it. Back in 3 days." / "Counted as right. Spelling: mitochondria. Back in 3 days."
 * A replayed save (`result` null: the answer was already stored) just says it is saved.
 */
export function feedbackLine(outcome: AnswerOutcome, result: AnswerResult | null): string {
  const back = result ? `${backIn(parseIso(result.next.due), result.reviewedAt)}.` : 'Saved.';
  switch (outcome.kind) {
    case 'graded':
      return `${outcome.word}. ${back}`;
    case 'typed_right':
      return outcome.verdict.result === 'exact'
        ? `Right. ${back}`
        : `Counted as right. Spelling: ${outcome.verdict.expected}. ${back}`;
    case 'typed_missed':
      return `Missed it. ${back}`;
    case 'typed_counted':
      return `Counted as right. ${back}`;
  }
}

/** The words when the queue has nothing to ask. */
export function doneMessage(reason: Extract<QueueNext, { type: 'done' }>['reason']): { title: string; detail: string } {
  switch (reason) {
    case 'self_test_done':
      return { title: 'Self-test done', detail: 'Free focus until the timer ends.' };
    case 'nothing_to_retest':
      return { title: 'Nice', detail: 'Nothing to re-test. Free focus until the timer ends.' };
    default:
      return { title: 'All caught up', detail: 'Free focus until the timer ends.' };
  }
}

/** "Next card in 0:42". */
export function waitLine(until: number, now: number): string {
  return `Next card in ${formatClock(Math.max(0, until - now))}`;
}

export const SAVE_PROBLEM = 'Couldn’t save that answer on this phone. Try again.';

/** The plan's next step, as the panel says it while the plan has no cards to ask (or null). */
export function notReadyLine(
  step: { kind: string; sourceId?: string; message?: string },
  sources: readonly { sourceId: string; title: string; text: { title: string } }[],
): string | null {
  switch (step.kind) {
    case 'working': {
      const source = sources.find((entry) => entry.sourceId === step.sourceId);
      return source ? `${source.title.trim() || 'Your material'}: ${source.text.title}.` : 'Your material is being prepared.';
    }
    case 'check_transcripts':
      return 'Check the transcription on the plan’s page to make its cards.';
    case 'review_outline':
      return 'Review the outline on the plan’s page to make cards.';
    case 'retry':
      return step.message ? `Couldn’t make the cards: ${step.message}` : 'Couldn’t make the cards.';
    case 'add_material':
      return 'Add material to this plan to make cards.';
    default:
      return null;
  }
}
