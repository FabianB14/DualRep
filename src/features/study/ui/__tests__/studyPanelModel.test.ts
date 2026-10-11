import { describe, expect, it, jest } from '@jest/globals';

import type { QueueCard } from '../../queue';
import { ratingButtons } from '../../studyPrefs';
import {
  answerVisible,
  backIn,
  countsLine,
  doneMessage,
  feedbackLine,
  gradeWord,
  markWrong,
  notReadyLine,
  openCard,
  quizMe,
  ratingHint,
  reasonLabel,
  reasonNote,
  reveal,
  waitLine,
} from '../studyPanelModel';

// studyPrefs (the rating buttons) sits on local_state: PowerSync's native module is not in jest.
jest.mock('@powersync/react-native', () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
jest.mock('../../../../db/database', () => ({ db: {} }));

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BLOCK = 'e0000000-0000-4000-8000-000000000001';

function card(reason: QueueCard['reason']): QueueCard {
  return {
    cardId: 'c0000000-0000-4000-8000-000000000001',
    question: 'What makes most of the cell’s ATP?',
    answer: 'Mitochondria',
    cardType: 'basic',
    page: 12,
    topicId: null,
    topicPosition: 0,
    sourceId: null,
    sourceTitle: 'Lecture 3',
    stateRow: null,
    reason,
  };
}

const RESULT = (due: number) => ({
  reviewedAt: NOW,
  prevState: 2,
  next: {
    state: 2 as const,
    due: new Date(due).toISOString(),
    stability: 3,
    difficulty: 5,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 4,
    lapses: 0,
    last_review: new Date(NOW).toISOString(),
  },
});

describe('the card flow', () => {
  it('a recall card is quiz-first: the question alone, timed from when it is shown', () => {
    const open = openCard(card('review'), BLOCK, NOW, 'self_graded');
    expect(open).toMatchObject({ stage: 'question', shownAt: NOW, reviewId: null, blockId: BLOCK, mode: 'self_graded' });
    expect(answerVisible(open.stage)).toBe(false);
    expect(quizMe(open, NOW + 5_000)).toBe(open);
  });

  it('a new card is shown, then quizzed: the quiz is timed from "Quiz me"', () => {
    const open = openCard(card('new'), BLOCK, NOW, 'self_graded');
    expect(open).toMatchObject({ stage: 'learn', shownAt: null });
    expect(answerVisible(open.stage)).toBe(true);
    const quiz = quizMe(open, NOW + 20_000);
    expect(quiz).toMatchObject({ stage: 'question', shownAt: NOW + 20_000 });
    expect(answerVisible(quiz.stage)).toBe(false);
  });

  it('reveal and a wrong typed answer only follow the question', () => {
    const question = openCard(card('learning'), BLOCK, NOW, 'self_graded');
    const preview = { 1: NOW + MIN, 2: NOW + 6 * MIN, 3: NOW + 10 * MIN, 4: NOW + 3 * DAY };
    const revealed = reveal(question, preview, NOW + 3_000);
    expect(revealed).toMatchObject({ stage: 'revealed', preview, previewAt: NOW + 3_000 });
    expect(reveal(revealed, null, NOW)).toBe(revealed);
    const learn = openCard(card('new'), BLOCK, NOW, 'typed');
    expect(reveal(learn, null, NOW)).toBe(learn);
    const verdict = { result: 'wrong' as const, rating: null, expected: 'Mitochondria' };
    expect(markWrong(learn, verdict)).toBe(learn);
    expect(markWrong(openCard(card('review'), BLOCK, NOW, 'typed'), verdict)).toMatchObject({ stage: 'wrong', verdict });
  });

  it('rating hints say when the card comes back for each grade', () => {
    const open = reveal(openCard(card('review'), BLOCK, NOW, 'self_graded'), { 1: NOW + 20_000, 2: NOW + 6 * MIN, 3: NOW + 3 * DAY, 4: NOW + 9 * DAY }, NOW);
    expect([1, 2, 3, 4].map((grade) => ratingHint(open, grade as 1 | 2 | 3 | 4))).toEqual(['under 1 min', '6 min', '3 days', '9 days']);
    expect(ratingHint(openCard(card('review'), BLOCK, NOW, 'self_graded'), 3)).toBeNull();
  });
});

describe('the words', () => {
  it('labels and notes', () => {
    expect(reasonLabel('review')).toBe('Recall');
    expect(reasonLabel('learning')).toBe('Recall');
    expect(reasonLabel('new')).toBe('New card');
    expect(reasonLabel('self_test')).toBe('Self-test');
    expect(reasonNote('new', 'learn')).toBe('Read it, then test yourself.');
    expect(reasonNote('new', 'question')).toBeNull();
    expect(reasonNote('self_test', 'question')).toBe('This block’s new and missed cards, once more.');
    expect(reasonNote('review', 'question')).toBeNull();
  });

  it('counts', () => {
    expect(countsLine({ due: 8, fresh: 3 })).toBe('8 to recall · 3 new');
    expect(countsLine({ due: 0, fresh: 3 })).toBe('3 new');
    expect(countsLine({ due: 1, fresh: 0 })).toBe('1 to recall');
    expect(countsLine({ due: 0, fresh: 0 })).toBeNull();
  });

  it('when a card comes back', () => {
    expect(backIn(NOW + 3 * DAY, NOW)).toBe('Back in 3 days');
    expect(backIn(NOW + 10 * MIN, NOW)).toBe('Back in 10 min');
    expect(backIn(NOW + 10_000, NOW)).toBe('Back in a moment');
    expect(backIn(null, NOW)).toBe('Saved');
  });

  it('the line after an answer', () => {
    const buttons = ratingButtons(2);
    expect(gradeWord(3, buttons)).toBe('Got it');
    expect(gradeWord(1, buttons)).toBe('Missed it');
    expect(gradeWord(4, ratingButtons(4))).toBe('Easy');
    expect(feedbackLine({ kind: 'graded', word: 'Got it' }, RESULT(NOW + 3 * DAY))).toBe('Got it. Back in 3 days.');
    expect(feedbackLine({ kind: 'typed_right', verdict: { result: 'exact', rating: 3, expected: 'ATP' } }, RESULT(NOW + 3 * DAY))).toBe(
      'Right. Back in 3 days.',
    );
    expect(
      feedbackLine({ kind: 'typed_right', verdict: { result: 'close', rating: 3, expected: 'Mitochondria' } }, RESULT(NOW + 3 * DAY)),
    ).toBe('Counted as right. Spelling: Mitochondria. Back in 3 days.');
    expect(feedbackLine({ kind: 'typed_missed' }, RESULT(NOW + MIN))).toBe('Missed it. Back in 1 min.');
    expect(feedbackLine({ kind: 'typed_counted' }, RESULT(NOW + 2 * DAY))).toBe('Counted as right. Back in 2 days.');
    // A save that was already stored (a retried tap after a crash).
    expect(feedbackLine({ kind: 'graded', word: 'Got it' }, null)).toBe('Got it. Saved.');
  });

  it('nothing to ask, or a card coming back soon', () => {
    expect(doneMessage('all_caught_up')).toEqual({ title: 'All caught up', detail: 'Free focus until the timer ends.' });
    expect(doneMessage('nothing_to_retest').detail).toBe('Nothing to re-test. Free focus until the timer ends.');
    expect(doneMessage('self_test_done').title).toBe('Self-test done');
    expect(waitLine(NOW + 42_000, NOW)).toBe('Next card in 0:42');
    expect(waitLine(NOW - 1, NOW)).toBe('Next card in 0:00');
  });

  it('a plan without cards: its next step', () => {
    const sources = [{ sourceId: 's-1', title: 'Lecture 3', text: { title: 'Making cards (2 of 6)' } }];
    expect(notReadyLine({ kind: 'working', sourceId: 's-1' }, sources)).toBe('Lecture 3: Making cards (2 of 6).');
    expect(notReadyLine({ kind: 'working', sourceId: 's-9' }, sources)).toBe('Your material is being prepared.');
    expect(notReadyLine({ kind: 'check_transcripts', sourceId: 's-1' }, sources)).toContain('Check the transcription');
    expect(notReadyLine({ kind: 'review_outline', sourceId: 's-1' }, sources)).toContain('Review the outline');
    expect(notReadyLine({ kind: 'retry', sourceId: 's-1', message: 'The file could not be read.' }, sources)).toBe(
      'Couldn’t make the cards: The file could not be read.',
    );
    expect(notReadyLine({ kind: 'add_material' }, sources)).toBe('Add material to this plan to make cards.');
    expect(notReadyLine({ kind: 'study' }, sources)).toBeNull();
  });
});
