/**
 * The focus block's study panel, with the study engine replaced: the queue (hooks.ts) hands the panel
 * the cards given here, and the answer write (studyRepo.answerCard) is recorded. The ratings' "back
 * in" hints use the real FSRS scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ThemeProvider } from '@/theme';

import type { QueueCard, QueueNext } from '../../queue';
import type { StudyQueue, StudyQueueOptions } from '../../hooks';
import type { StudyPlan } from '../../studyQueries';
import { DEFAULT_STUDY_PREFS, type StudyPrefs } from '../../studyPrefs';
import { StudyPanel, type StudyPanelProps } from '../StudyPanel';

const USER = '11111111-1111-4111-8111-111111111111';
const PLAN = '90000000-0000-4000-8000-000000000001';
const BLOCK = 'e0000000-0000-4000-8000-000000000001';
const C1 = 'c0000000-0000-4000-8000-000000000001';
const C2 = 'c0000000-0000-4000-8000-000000000002';
const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

jest.mock('@powersync/react-native', () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
jest.mock('../../../../db/database', () => ({ db: {} }));
jest.mock('../../../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  AndroidHaptics: {},
}));
let mockIds = 0;
jest.mock('../../../../lib/ids', () => ({ newId: () => `review-${(mockIds += 1)}` }));

const mockState: {
  plan: StudyPlan | null;
  planLoading: boolean;
  queue: StudyQueue;
  options: StudyQueueOptions[];
  prefs: StudyPrefs;
  progress: { sources: unknown[]; nextStep: unknown; draftTopics: number; isLoading: boolean };
} = {
  plan: null,
  planLoading: false,
  queue: null as unknown as StudyQueue,
  options: [],
  prefs: DEFAULT_STUDY_PREFS,
  progress: { sources: [], nextStep: { kind: 'add_material' }, draftTopics: 0, isLoading: false },
};
jest.mock('../../hooks', () => ({
  usePlan: () => ({ plan: mockState.plan, isLoading: mockState.planLoading }),
  useStudyQueue: (options: StudyQueueOptions) => {
    mockState.options.push(options);
    return mockState.queue;
  },
  useFsrsParams: () => null,
  useSourceProgress: () => mockState.progress,
}));
jest.mock('../../studyPrefs', () => ({
  ...(jest.requireActual('../../studyPrefs') as object),
  useStudyPrefs: () => ({ prefs: mockState.prefs, isLoading: false, save: async () => mockState.prefs }),
}));
jest.mock('../../studyRepo', () => ({ answerCard: jest.fn() }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const repo = jest.requireMock('../../studyRepo') as { answerCard: AnyMock };

function plan(overrides: Partial<StudyPlan> = {}): StudyPlan {
  return {
    id: PLAN,
    ownerId: USER,
    groupId: null,
    title: 'Biology 101',
    scope: 'cumulative',
    goal: '',
    targetDate: null,
    sourceCount: 2,
    cardCount: 40,
    dueCount: 8,
    newCount: 5,
    isOwner: true,
    ...overrides,
  };
}

/** A card the queue offers. A review card has a state (due now, last seen 3 days ago). */
function card(reason: QueueCard['reason'], overrides: Partial<QueueCard> = {}): QueueCard {
  const answered = reason !== 'new';
  return {
    cardId: C1,
    question: 'What makes most of the cell’s ATP?',
    answer: 'Mitochondria',
    cardType: 'basic',
    page: 12,
    topicId: null,
    topicPosition: 0,
    sourceId: null,
    sourceTitle: 'Lecture 3',
    stateRow: answered
      ? {
          state: reason === 'review' ? 2 : 1,
          due: new Date(NOW).toISOString(),
          stability: 3,
          difficulty: 5,
          scheduled_days: 3,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          last_review: new Date(NOW - 3 * DAY).toISOString(),
        }
      : null,
    reason,
    ...overrides,
  };
}

const SECOND = card('review', { cardId: C2, question: 'What is the powerhouse’s membrane called?', answer: 'Inner membrane' });

function queue(next: QueueNext | null, counts = { due: 8, fresh: 3 }): StudyQueue {
  return {
    next,
    counts,
    scope: { sourceId: null, note: null },
    newLeft: counts.fresh,
    isLoading: next === null,
    markAnswered: jest.fn((cardId: string) => {
      // The queue moves on once the answer is in (the hook leaves the card out until its rows refresh).
      if (mockState.queue.next?.type === 'card' && mockState.queue.next.card.cardId === cardId) {
        mockState.queue = { ...mockState.queue, next: { type: 'card', card: SECOND, selfTestFrom: null } };
      }
    }),
  };
}

function answerResult(dueInMs: number) {
  return {
    reviewedAt: NOW,
    prevState: 2,
    next: {
      state: 2,
      due: new Date(NOW + dueInMs).toISOString(),
      stability: 9,
      difficulty: 5,
      scheduled_days: 3,
      learning_steps: 0,
      reps: 4,
      lapses: 0,
      last_review: new Date(NOW).toISOString(),
    },
  };
}

const BASE_PROPS: StudyPanelProps = {
  planId: PLAN,
  filter: 'all',
  blockId: BLOCK,
  blockMs: 25 * MIN,
  remainingMs: 20 * MIN,
  now: NOW,
  paused: false,
};

const mounted: ReactTestRenderer[] = [];

function tree(props: Partial<StudyPanelProps> = {}) {
  return (
    <ThemeProvider>
      <StudyPanel {...BASE_PROPS} {...props} />
    </ThemeProvider>
  );
}

async function render(props: Partial<StudyPanelProps> = {}): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(tree(props));
  });
  mounted.push(renderer!);
  return renderer!;
}

async function rerender(renderer: ReactTestRenderer, props: Partial<StudyPanelProps> = {}) {
  await act(async () => renderer.update(tree(props)));
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) =>
      [node.props.children]
        .flat()
        .filter((c: unknown) => typeof c === 'string' || typeof c === 'number')
        .join(''),
    )
    .join(' | ');
}

function buttons(renderer: ReactTestRenderer, label: string): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onClick === 'function',
  );
}

const has = (renderer: ReactTestRenderer, label: string) => buttons(renderer, label).length > 0;

async function press(renderer: ReactTestRenderer, label: string) {
  const [button] = buttons(renderer, label);
  if (!button) throw new Error(`no button "${label}" in: ${textOf(renderer)}`);
  await act(async () => button.props.onClick({}));
}

async function type(renderer: ReactTestRenderer, label: string, text: string) {
  const input = renderer.root.find((node) => (node.type as unknown) === 'TextInput' && node.props.accessibilityLabel === label);
  await act(async () => input.props.onChangeText(text));
}

let clock = NOW;

beforeEach(() => {
  jest.clearAllMocks();
  mockIds = 0;
  clock = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  mockState.plan = plan();
  mockState.planLoading = false;
  mockState.options = [];
  mockState.prefs = DEFAULT_STUDY_PREFS;
  mockState.queue = queue({ type: 'card', card: card('review'), selfTestFrom: null });
  mockState.progress = { sources: [], nextStep: { kind: 'add_material' }, draftTopics: 0, isLoading: false };
  repo.answerCard.mockImplementation(async () => answerResult(3 * DAY));
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  jest.restoreAllMocks();
});

describe('recall: quiz-first, self-graded', () => {
  it('asks the question alone, then shows the answer with two buttons and when the card comes back', async () => {
    const renderer = await render();
    let text = textOf(renderer);
    expect(text).toContain('Recall');
    expect(text).toContain('8 to recall · 3 new');
    expect(text).toContain('What makes most of the cell’s ATP?');
    expect(text).not.toContain('Mitochondria');
    expect(has(renderer, 'Got it')).toBe(false);

    clock = NOW + 4_000;
    await press(renderer, 'Show answer');
    text = textOf(renderer);
    expect(text).toContain('Mitochondria');
    expect(text).toContain('p. 12, Lecture 3');
    expect(has(renderer, 'Missed it')).toBe(true);
    expect(has(renderer, 'Got it')).toBe(true);
    expect(has(renderer, 'Hard')).toBe(false);
    // The real scheduler: Again comes back within minutes, Good in days.
    const [gotIt] = buttons(renderer, 'Got it');
    expect(gotIt.props.accessibilityHint).toMatch(/^Comes back in \d+ days?$/);
    expect(buttons(renderer, 'Missed it')[0].props.accessibilityHint).toMatch(/min$/);
  });

  it('each answer is one write tagged with the block, then the next card comes up', async () => {
    const renderer = await render();
    clock = NOW + 4_000;
    await press(renderer, 'Show answer');
    clock = NOW + 9_000;
    await press(renderer, 'Got it');
    expect(repo.answerCard).toHaveBeenCalledTimes(1);
    expect(repo.answerCard).toHaveBeenCalledWith({
      reviewId: 'review-1',
      userId: USER,
      cardId: C1,
      blockId: BLOCK,
      grade: 3,
      answerMode: 'self_graded',
      answeredAt: NOW + 9_000,
      shownAt: NOW,
      fsrsParams: null,
    });
    expect(mockState.queue.markAnswered).toHaveBeenCalledWith(C1, 'review-1');
    const text = textOf(renderer);
    expect(text).toContain('Got it. Back in 3 days.');
    expect(text).toContain('What is the powerhouse’s membrane called?');
    expect(has(renderer, 'Show answer')).toBe(true);
  });

  it('four buttons when the setting says so', async () => {
    mockState.prefs = { ...DEFAULT_STUDY_PREFS, answerButtons: 4 };
    const renderer = await render();
    await press(renderer, 'Show answer');
    for (const label of ['Again', 'Hard', 'Good', 'Easy']) expect(has(renderer, label)).toBe(true);
    await press(renderer, 'Easy');
    expect(repo.answerCard).toHaveBeenCalledWith(expect.objectContaining({ grade: 4, answerMode: 'self_graded' }));
    expect(textOf(renderer)).toContain('Easy. Back in 3 days.');
  });

  it('"Missed it" is Again', async () => {
    repo.answerCard.mockImplementationOnce(async () => answerResult(MIN));
    const renderer = await render();
    await press(renderer, 'Show answer');
    await press(renderer, 'Missed it');
    expect(repo.answerCard).toHaveBeenCalledWith(expect.objectContaining({ grade: 1 }));
    expect(textOf(renderer)).toContain('Missed it. Back in 1 min.');
  });
});

describe('new cards: shown, then quizzed', () => {
  it('reads the card first; the quiz (and its timing) starts at "Quiz me"', async () => {
    mockState.queue = queue({ type: 'card', card: card('new'), selfTestFrom: null });
    const renderer = await render();
    let text = textOf(renderer);
    expect(text).toContain('New card');
    expect(text).toContain('Read it, then test yourself.');
    expect(text).toContain('Mitochondria');
    expect(has(renderer, 'Show answer')).toBe(false);

    clock = NOW + 20_000;
    await press(renderer, 'Quiz me');
    text = textOf(renderer);
    expect(text).not.toContain('Mitochondria');
    expect(text).toContain('What makes most of the cell’s ATP?');
    await press(renderer, 'Show answer');
    clock = NOW + 26_000;
    await press(renderer, 'Got it');
    expect(repo.answerCard).toHaveBeenCalledWith(expect.objectContaining({ cardId: C1, grade: 3, shownAt: NOW + 20_000, answeredAt: NOW + 26_000 }));
  });
});

describe('the closing self-test', () => {
  it('says what it is', async () => {
    mockState.queue = queue({ type: 'card', card: card('self_test'), selfTestFrom: NOW });
    const renderer = await render({ remainingMs: 2 * MIN });
    const text = textOf(renderer);
    expect(text).toContain('Self-test');
    expect(text).toContain('This block’s new and missed cards, once more.');
    expect(has(renderer, 'Show answer')).toBe(true);
  });
});

describe('typed answers', () => {
  beforeEach(() => {
    mockState.prefs = { ...DEFAULT_STUDY_PREFS, typedAnswers: true };
  });

  it('a near spelling counts as right (Good) and shows the spelling', async () => {
    const renderer = await render();
    expect(has(renderer, 'Show answer')).toBe(false);
    await type(renderer, 'Your answer', 'mitochondira');
    await press(renderer, 'Check');
    expect(repo.answerCard).toHaveBeenCalledWith(expect.objectContaining({ grade: 3, answerMode: 'typed', cardId: C1 }));
    expect(textOf(renderer)).toContain('Counted as right. Spelling: Mitochondria. Back in 3 days.');
  });

  it('an exact answer is simply right', async () => {
    const renderer = await render();
    await type(renderer, 'Your answer', 'the mitochondria');
    await press(renderer, 'Check');
    expect(textOf(renderer)).toContain('Right. Back in 3 days.');
  });

  it('a wrong one shows the answer: "I missed it" is Again, "Count it as right" is Good', async () => {
    repo.answerCard.mockImplementationOnce(async () => answerResult(MIN));
    const renderer = await render();
    await type(renderer, 'Your answer', 'ribosome');
    await press(renderer, 'Check');
    expect(repo.answerCard).not.toHaveBeenCalled();
    const text = textOf(renderer);
    expect(text).toContain('Not quite. You wrote: ribosome');
    expect(text).toContain('Mitochondria');
    await press(renderer, 'I missed it');
    expect(repo.answerCard).toHaveBeenCalledWith(expect.objectContaining({ grade: 1, answerMode: 'typed' }));
    expect(textOf(renderer)).toContain('Missed it. Back in 1 min.');

    // The next card: overruled.
    await type(renderer, 'Your answer', 'outer membrane');
    await press(renderer, 'Check');
    await press(renderer, 'Count it as right');
    expect(repo.answerCard).toHaveBeenLastCalledWith(expect.objectContaining({ cardId: C2, grade: 3, answerMode: 'typed' }));
    expect(textOf(renderer)).toContain('Counted as right. Back in 3 days.');
  });

  it('a card that does not suit typing is self-graded', async () => {
    mockState.queue = queue({
      type: 'card',
      card: card('review', { cardType: 'why', answer: 'Because the proton gradient drives ATP synthase.' }),
      selfTestFrom: null,
    });
    const renderer = await render();
    expect(has(renderer, 'Show answer')).toBe(true);
    await press(renderer, 'Show answer');
    await press(renderer, 'Got it');
    expect(repo.answerCard).toHaveBeenCalledWith(expect.objectContaining({ answerMode: 'self_graded' }));
  });
});

describe('the open card', () => {
  it('stays on screen while the queue’s choice moves on', async () => {
    const renderer = await render();
    mockState.queue = queue({ type: 'card', card: SECOND, selfTestFrom: null });
    await rerender(renderer, { now: NOW + 1_000, remainingMs: 20 * MIN - 1_000 });
    expect(textOf(renderer)).toContain('What makes most of the cell’s ATP?');
    expect(textOf(renderer)).not.toContain('powerhouse');
  });

  it('is hidden while paused, with nothing to answer, and back on resume', async () => {
    const renderer = await render();
    await press(renderer, 'Show answer');
    await rerender(renderer, { paused: true });
    let text = textOf(renderer);
    expect(text).toContain('Paused. Your card is hidden until you resume.');
    expect(text).not.toContain('ATP');
    expect(has(renderer, 'Got it')).toBe(false);
    await rerender(renderer, { paused: false });
    text = textOf(renderer);
    expect(text).toContain('Mitochondria');
    expect(has(renderer, 'Got it')).toBe(true);
  });

  it('is not pinned before the plan is read (its scope decides which cards)', async () => {
    mockState.plan = null;
    mockState.planLoading = true;
    const renderer = await render();
    expect(textOf(renderer)).toContain('Getting your cards…');
    expect(textOf(renderer)).not.toContain('ATP');
    mockState.plan = plan();
    mockState.planLoading = false;
    await rerender(renderer, { now: NOW + 1_000 });
    expect(textOf(renderer)).toContain('What makes most of the cell’s ATP?');
  });

  it('is not pinned while paused', async () => {
    const renderer = await render({ paused: true });
    expect(textOf(renderer)).not.toContain('ATP');
    await rerender(renderer, { paused: false });
    expect(textOf(renderer)).toContain('What makes most of the cell’s ATP?');
  });

  it('a save that fails keeps the card and retries as the same answer', async () => {
    repo.answerCard.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const renderer = await render();
    await press(renderer, 'Show answer');
    await press(renderer, 'Got it');
    expect(textOf(renderer)).toContain('Couldn’t save that answer on this phone. Try again.');
    expect(has(renderer, 'Got it')).toBe(true);
    await press(renderer, 'Got it');
    expect(repo.answerCard).toHaveBeenCalledTimes(2);
    expect(repo.answerCard.mock.calls.map(([input]) => (input as { reviewId: string }).reviewId)).toEqual(['review-1', 'review-1']);
    expect(textOf(renderer)).not.toContain('Couldn’t save');
    expect(textOf(renderer)).toContain('powerhouse');
  });

  it('an answer that was already saved just says so', async () => {
    repo.answerCard.mockResolvedValueOnce(null);
    const renderer = await render();
    await press(renderer, 'Show answer');
    await press(renderer, 'Got it');
    expect(textOf(renderer)).toContain('Got it. Saved.');
  });
});

describe('between cards', () => {
  it('a learning step due in a moment: wait, or ask it now', async () => {
    mockState.queue = queue({ type: 'wait', until: NOW + 42_000, card: card('learning') }, { due: 0, fresh: 0 });
    const renderer = await render();
    expect(textOf(renderer)).toContain('Next card in 0:42');
    await press(renderer, 'Ask now');
    expect(textOf(renderer)).toContain('What makes most of the cell’s ATP?');
    expect(has(renderer, 'Show answer')).toBe(true);
  });

  it('nothing left: free focus', async () => {
    mockState.queue = queue({ type: 'done', reason: 'all_caught_up' }, { due: 0, fresh: 0 });
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('All caught up');
    expect(text).toContain('Free focus until the timer ends.');
  });

  it('while the queue loads', async () => {
    mockState.queue = queue(null);
    const renderer = await render();
    expect(textOf(renderer)).toContain('Getting your cards…');
  });

  it('shows why the filter fell back', async () => {
    mockState.queue = { ...queue({ type: 'done', reason: 'all_caught_up' }), scope: { sourceId: null, note: 'Lecture 5 isn’t ready yet. Studying everything so far.' } };
    const renderer = await render();
    expect(textOf(renderer)).toContain('Lecture 5 isn’t ready yet.');
  });
});

describe('the plan', () => {
  it('feeds the queue with the block, the timer and the plan’s scope and filter', async () => {
    await render({ filter: 'newest', remainingMs: 7 * MIN });
    expect(mockState.options.at(-1)).toEqual({
      planId: PLAN,
      blockId: BLOCK,
      scope: 'cumulative',
      filter: 'newest',
      blockMs: 25 * MIN,
      remainingMs: 7 * MIN,
      now: NOW,
    });
  });

  it('without cards yet: its next step, and free focus', async () => {
    mockState.plan = plan({ cardCount: 0 });
    mockState.progress = {
      sources: [{ sourceId: 's-1', title: 'Lecture 3', text: { title: 'Making cards (2 of 6)' } }],
      nextStep: { kind: 'working', sourceId: 's-1' },
      draftTopics: 0,
      isLoading: false,
    };
    const renderer = await render();
    const text = textOf(renderer);
    expect(text).toContain('No cards yet');
    expect(text).toContain('Lecture 3: Making cards (2 of 6).');
    expect(text).toContain('Free focus until the timer ends.');
    expect(has(renderer, 'Show answer')).toBe(false);
  });

  it('no longer on the phone (deleted, or its group left)', async () => {
    mockState.plan = null;
    const renderer = await render();
    expect(textOf(renderer)).toContain('This plan isn’t on this phone');
  });
});
