import { describe, expect, it } from '@jest/globals';

import {
  describePace,
  endOfLocalDay,
  isDueNow,
  newAllowance,
  newIntroduced,
  newPerBlockFor,
  nextItem,
  pickReview,
  planPace,
  QUEUE_RULES,
  queueCounts,
  resolveScope,
  reviewTimeMs,
  selfTestItems,
  selfTestMs,
  type BlockAnswer,
  type DueCandidate,
  type NewCandidate,
  type QueueInput,
  type QueueNext,
} from '../queue';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const BLOCK = 25 * MIN;

function card(cardId: string, sourceId = 's1', topicId = 't1') {
  return {
    cardId,
    question: `Q ${cardId}`,
    answer: `A ${cardId}`,
    cardType: 'basic',
    page: null,
    topicId,
    topicPosition: 0,
    sourceId,
    sourceTitle: sourceId === null ? null : `Source ${sourceId}`,
  };
}

function due(cardId: string, state: number, dueAt: number, sourceId = 's1', topicId = 't1'): DueCandidate {
  return {
    ...card(cardId, sourceId, topicId),
    state,
    due: dueAt,
    stateRow: {
      state,
      due: new Date(dueAt).toISOString(),
      stability: 1,
      difficulty: 5,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      last_review: new Date(dueAt - MIN).toISOString(),
    },
  };
}

function fresh(cardId: string, sourceId = 's1'): NewCandidate {
  return { ...card(cardId, sourceId), stateRow: null };
}

function answer(cardId: string, prevState: number, rating: number, at: number, sourceId = 's1', topicId = 't1'): BlockAnswer {
  return { cardId, prevState, rating, reviewedAt: at, durationMs: 8_000, sourceId, topicId };
}

function input(overrides: Partial<QueueInput> = {}): QueueInput {
  return {
    now: NOW,
    blockMs: BLOCK,
    remainingMs: 20 * MIN,
    due: [],
    fresh: [],
    blockAnswers: [],
    newToday: 0,
    settings: { newPerBlock: 5, dailyNewCap: 20 },
    interleaveBy: 'source',
    prioritizeNew: false,
    ...overrides,
  };
}

function cardOf(next: QueueNext): string | null {
  return next.type === 'card' || next.type === 'wait' ? next.card.cardId : null;
}

describe('block rules', () => {
  it('the self-test is 12% of the block, 2 to 5 minutes', () => {
    expect(selfTestMs(25 * MIN)).toBe(3 * MIN);
    expect(selfTestMs(10 * MIN)).toBe(2 * MIN);
    expect(selfTestMs(50 * MIN)).toBe(5 * MIN);
    expect(selfTestMs(0)).toBe(2 * MIN);
  });

  it('new cards per block: one per 5 minutes, 2 to 8 (25 min → 5)', () => {
    expect(newPerBlockFor(25)).toBe(5);
    expect(newPerBlockFor(10)).toBe(2);
    expect(newPerBlockFor(30)).toBe(6);
    expect(newPerBlockFor(50)).toBe(8);
    expect(newPerBlockFor(5)).toBe(2);
    expect(newPerBlockFor(Number.NaN)).toBe(5);
    expect(QUEUE_RULES.dailyNewCap).toBe(20);
  });
});

describe('nextItem: priority order', () => {
  it('learning steps due now come before reviews, reviews before new cards', () => {
    const base = input({
      due: [due('r1', 2, NOW - 5 * MIN), due('l1', 1, NOW - MIN)],
      fresh: [fresh('n1')],
    });
    expect(nextItem(base)).toMatchObject({ type: 'card', card: { cardId: 'l1', reason: 'learning' } });
    expect(nextItem({ ...base, due: [due('r1', 2, NOW - 5 * MIN)] })).toMatchObject({
      type: 'card',
      card: { cardId: 'r1', reason: 'review' },
    });
    expect(nextItem({ ...base, due: [] })).toMatchObject({ type: 'card', card: { cardId: 'n1', reason: 'new' } });
  });

  it('relearning counts as learning; the earliest due goes first; cards due later are not asked yet', () => {
    const next = nextItem(
      input({
        due: [due('l2', 1, NOW - MIN), due('rl', 3, NOW - 2 * MIN), due('later', 1, NOW + 5 * MIN), due('r-later', 2, NOW + MIN)],
      }),
    );
    expect(next).toMatchObject({ type: 'card', card: { cardId: 'rl', reason: 'learning' } });
  });

  it('never asks the card just answered again when anything else can be asked', () => {
    const answers = [answer('l1', 0, 1, NOW - 10_000)];
    const withOther = input({ due: [due('l1', 1, NOW - 1_000)], fresh: [fresh('n1')], blockAnswers: answers });
    expect(cardOf(nextItem(withOther))).toBe('n1');
    const alone = input({ due: [due('l1', 1, NOW - 1_000)], blockAnswers: answers });
    expect(nextItem(alone)).toMatchObject({ type: 'card', card: { cardId: 'l1', reason: 'learning' } });
  });

  it('leaves out cards answered a moment ago whose rows have not refreshed yet', () => {
    const next = nextItem(input({ fresh: [fresh('n1'), fresh('n2')], exclude: new Set(['n1']) }));
    expect(cardOf(next)).toBe('n2');
  });

  it('new cards come in the given order and stop at the block and daily caps', () => {
    const list = [fresh('n1'), fresh('n2'), fresh('n3')];
    expect(cardOf(nextItem(input({ fresh: list })))).toBe('n1');
    const fiveNew = ['a', 'b', 'c', 'd', 'e'].map((id, i) => answer(id, 0, 3, NOW - (10 - i) * MIN));
    expect(nextItem(input({ fresh: list, blockAnswers: fiveNew }))).toEqual({ type: 'done', reason: 'all_caught_up' });
    expect(nextItem(input({ fresh: list, newToday: 20 }))).toEqual({ type: 'done', reason: 'all_caught_up' });
    expect(cardOf(nextItem(input({ fresh: list, newToday: 19 })))).toBe('n1');
  });

  it('waits for a learning step due within a minute, not for one due later', () => {
    const soon = nextItem(input({ due: [due('l1', 1, NOW + 42_000)] }));
    expect(soon).toMatchObject({ type: 'wait', until: NOW + 42_000, card: { cardId: 'l1', reason: 'learning' } });
    expect(nextItem(input({ due: [due('l1', 1, NOW + 2 * MIN)] }))).toEqual({ type: 'done', reason: 'all_caught_up' });
  });
});

describe('nextItem: interleaving', () => {
  it('reviews take turns between sources: least served first, ties to the most overdue', () => {
    const reviews = [
      due('a1', 2, NOW - 50 * MIN, 'A'),
      due('a2', 2, NOW - 40 * MIN, 'A'),
      due('a3', 2, NOW - 30 * MIN, 'A'),
      due('b1', 2, NOW - 20 * MIN, 'B'),
      due('b2', 2, NOW - 10 * MIN, 'B'),
      due('c1', 2, NOW - 5 * MIN, 'C'),
    ];
    const order: string[] = [];
    let remaining = reviews;
    const answers: BlockAnswer[] = [];
    for (let i = 0; i < reviews.length; i += 1) {
      const next = nextItem(input({ due: remaining, blockAnswers: answers, now: NOW + i * 1000 }));
      const id = cardOf(next) as string;
      order.push(id);
      const picked = reviews.find((r) => r.cardId === id) as DueCandidate;
      answers.push(answer(id, 2, 3, NOW + i * 1000, picked.sourceId as string, picked.topicId as string));
      remaining = remaining.filter((r) => r.cardId !== id);
    }
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('interleaves by topic for a single source or the newest-source filter', () => {
    const reviews = [due('x1', 2, NOW - 9 * MIN, 's1', 'T1'), due('x2', 2, NOW - 8 * MIN, 's1', 'T1'), due('y1', 2, NOW - MIN, 's1', 'T2')];
    const answers = [answer('x1', 2, 3, NOW - 1000, 's1', 'T1')];
    const next = nextItem(input({ due: reviews.slice(1), blockAnswers: answers, interleaveBy: 'topic' }));
    expect(cardOf(next)).toBe('y1');
    // By source, all three are one group: the most overdue goes next.
    expect(cardOf(nextItem(input({ due: reviews.slice(1), blockAnswers: answers, interleaveBy: 'source' })))).toBe('x2');
  });

  it('pickReview handles cards without a source as one group, and nothing to pick', () => {
    expect(pickReview([], [], 'source')).toBeNull();
    const nulls = [{ ...due('n1', 2, NOW - MIN), sourceId: null }, { ...due('n2', 2, NOW - 2 * MIN), sourceId: null }];
    expect(pickReview(nulls, [], 'source')?.cardId).toBe('n2');
  });
});

describe('nextItem: the review budget', () => {
  const reviews = [due('r1', 2, NOW - 10 * MIN), due('r2', 2, NOW - 9 * MIN)];
  // 0.6 × (25 − 3) min = 13.2 min of reviews.
  const longReviews = Array.from({ length: 4 }, (_, i) => ({ ...answer(`old${i}`, 2, 3, NOW - (20 - i) * MIN), durationMs: 4 * MIN }));

  it('without a target date, reviews run until they are done', () => {
    const next = nextItem(input({ due: reviews, fresh: [fresh('n1')], blockAnswers: longReviews, prioritizeNew: false }));
    expect(cardOf(next)).toBe('r1');
  });

  it('with a target date, new cards get their turn once reviews used 60% of the study time', () => {
    const next = nextItem(input({ due: reviews, fresh: [fresh('n1')], blockAnswers: longReviews, prioritizeNew: true }));
    expect(next).toMatchObject({ type: 'card', card: { cardId: 'n1', reason: 'new' } });
    const under = nextItem(input({ due: reviews, fresh: [fresh('n1')], blockAnswers: longReviews.slice(0, 3), prioritizeNew: true }));
    expect(cardOf(under)).toBe('r1');
  });

  it('over budget with no new card allowed, reviews continue', () => {
    const next = nextItem(input({ due: reviews, fresh: [fresh('n1')], blockAnswers: longReviews, prioritizeNew: true, newToday: 20 }));
    expect(cardOf(next)).toBe('r1');
  });

  it('counts review time from durations, with an estimate when one is missing', () => {
    expect(reviewTimeMs([answer('a', 2, 3, NOW), { ...answer('b', 2, 3, NOW), durationMs: null }, answer('n', 0, 3, NOW)])).toBe(
      8_000 + QUEUE_RULES.reviewEstimateMs,
    );
  });
});

describe('nextItem: the closing self-test', () => {
  const t = (minutesAgo: number) => NOW - minutesAgo * MIN;
  const answers = [
    answer('n1', 0, 3, t(20)), // new
    answer('r1', 2, 3, t(19)), // a right review: not re-tested
    answer('r2', 2, 1, t(18)), // a lapse
    answer('n2', 0, 3, t(15)),
    answer('n1', 1, 3, t(10)), // n1's learning step
    answer('r3', 2, 3, t(8)), // the last answer before the self-test: a right review
  ];
  const candidates = [due('n1', 2, NOW + 2 * 24 * 60 * MIN), due('r2', 3, NOW + 5 * MIN), due('n2', 1, NOW + 30_000)];

  it('in the last minutes, asks this block’s new and missed cards again, oldest first', () => {
    const next = nextItem(input({ remainingMs: 3 * MIN, due: candidates, blockAnswers: answers, fresh: [fresh('z')] }));
    expect(next).toEqual({ type: 'card', card: expect.objectContaining({ cardId: 'n1', reason: 'self_test' }), selfTestFrom: NOW });
  });

  it('goes through the items once, then frees the rest of the block', () => {
    const from = NOW;
    const withOne = [...answers, answer('n1', 2, 3, NOW + 1000)];
    const second = nextItem(input({ now: NOW + 2000, remainingMs: 3 * MIN - 2000, due: candidates, blockAnswers: withOne, selfTestFrom: from }));
    expect(second).toMatchObject({ type: 'card', card: { cardId: 'r2', reason: 'self_test' }, selfTestFrom: null });
    const all = [...withOne, answer('r2', 3, 3, NOW + 3000), answer('n2', 1, 3, NOW + 4000)];
    expect(nextItem(input({ now: NOW + 5000, remainingMs: 2 * MIN, due: candidates, blockAnswers: all, selfTestFrom: from }))).toEqual({
      type: 'done',
      reason: 'self_test_done',
    });
  });

  it('with nothing to re-test, says so', () => {
    const reviewsOnly = [answer('r1', 2, 3, t(5))];
    expect(nextItem(input({ remainingMs: MIN, blockAnswers: reviewsOnly, due: [due('r9', 2, NOW - MIN)] }))).toEqual({
      type: 'done',
      reason: 'nothing_to_retest',
    });
  });

  it('starts early when nothing else is left, and the caller keeps the start', () => {
    const early = nextItem(input({ due: candidates.filter((c) => c.cardId !== 'n2'), blockAnswers: answers }));
    expect(early).toEqual({ type: 'card', card: expect.objectContaining({ cardId: 'n1', reason: 'self_test' }), selfTestFrom: NOW });
    const later = [...answers, answer('n1', 2, 3, NOW + 1000), answer('r2', 3, 3, NOW + 2000), answer('n2', 1, 3, NOW + 3000)];
    expect(nextItem(input({ now: NOW + 4000, due: candidates, blockAnswers: later, selfTestFrom: NOW }))).toEqual({
      type: 'done',
      reason: 'self_test_done',
    });
  });

  it('an early self-test never starts with the card just answered', () => {
    const justNow = [answer('n1', 0, 3, NOW - 5_000)];
    expect(nextItem(input({ due: [due('n1', 1, NOW + 10 * MIN)], blockAnswers: justNow }))).toEqual({ type: 'done', reason: 'all_caught_up' });
    // Ten minutes later its learning step is due: it is asked as that.
    const later = nextItem(input({ now: NOW + 10 * MIN, remainingMs: 10 * MIN, due: [due('n1', 1, NOW + 10 * MIN)], blockAnswers: justNow }));
    expect(later).toMatchObject({ type: 'card', card: { cardId: 'n1', reason: 'learning' } });
  });

  it('takes at most 5 cards, and skips one that is no longer on the phone', () => {
    const many = Array.from({ length: 7 }, (_, i) => answer(`c${i}`, 0, 3, t(20 - i)));
    const items = selfTestItems(many, NOW);
    expect(items.all).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(selfTestItems([...many, answer('c0', 1, 3, NOW + 1)], NOW).pending).toEqual(['c1', 'c2', 'c3', 'c4']);
    const gone = nextItem(input({ remainingMs: MIN, blockAnswers: [answer('ghost', 0, 3, t(5))] }));
    expect(gone).toEqual({ type: 'done', reason: 'self_test_done' });
  });
});

describe('counts and allowances', () => {
  it('counts distinct new cards introduced and what is left of the caps', () => {
    const answers = [answer('a', 0, 3, NOW), answer('a', 1, 3, NOW + 1), answer('b', 0, 1, NOW + 2), answer('c', 2, 3, NOW + 3)];
    expect(newIntroduced(answers)).toBe(2);
    expect(newAllowance({ blockAnswers: answers, newToday: 2, settings: { newPerBlock: 5, dailyNewCap: 20 } })).toBe(3);
    expect(newAllowance({ blockAnswers: answers, newToday: 19, settings: { newPerBlock: 5, dailyNewCap: 20 } })).toBe(1);
    expect(newAllowance({ blockAnswers: answers, newToday: 25, settings: { newPerBlock: 5, dailyNewCap: 20 } })).toBe(0);
  });

  it('queueCounts reports cards due now and new cards still allowed', () => {
    const counts = queueCounts(
      input({
        due: [due('r1', 2, NOW - MIN), due('l1', 1, NOW), due('later', 2, NOW + MIN)],
        fresh: [fresh('n1'), fresh('n2'), fresh('n3')],
        newToday: 18,
      }),
    );
    expect(counts).toEqual({ due: 2, fresh: 2 });
  });
});

describe('resolveScope', () => {
  const sources = [
    { sourceId: 'old', title: 'Lecture 1', addedAt: 1000, cards: 30 },
    { sourceId: 'mid', title: 'Lecture 2', addedAt: 2000, cards: 25 },
    { sourceId: 'new', title: 'Lecture 3', addedAt: 3000, cards: 0 },
  ];

  it('cumulative, everything so far: every card', () => {
    expect(resolveScope('cumulative', 'all', sources)).toEqual({ sourceId: null, note: null });
  });

  it('cumulative, newest: the newest source, or everything while it is still being made', () => {
    expect(resolveScope('cumulative', 'newest', sources)).toEqual({
      sourceId: null,
      note: 'Lecture 3 isn’t ready yet. Studying everything so far.',
    });
    expect(resolveScope('cumulative', 'newest', sources.slice(0, 2))).toEqual({ sourceId: 'mid', note: null });
    expect(resolveScope('cumulative', 'newest', [])).toEqual({ sourceId: null, note: null });
  });

  it('single: the only source, or the newest with cards after a switch back', () => {
    expect(resolveScope('single', 'all', [sources[0]])).toEqual({ sourceId: 'old', note: null });
    expect(resolveScope('single', 'newest', [])).toEqual({ sourceId: null, note: null });
    expect(resolveScope('single', 'all', sources)).toEqual({ sourceId: 'mid', note: 'Single source: Lecture 2' });
    expect(resolveScope('single', 'all', sources.map((s) => ({ ...s, cards: 0 })))).toEqual({ sourceId: null, note: null });
  });
});

describe('planPace', () => {
  const now = new Date(2026, 9, 9, 10, 0).getTime(); // local time

  it('is null without a target date or with an unreadable one', () => {
    expect(planPace(100, null, now, 20)).toBeNull();
    expect(planPace(100, '9 Oct', now, 20)).toBeNull();
  });

  it('spreads unseen cards over the days before the target date', () => {
    expect(planPace(200, '2026-10-19', now, 20)).toEqual({ daysLeft: 10, neededPerDay: 20, seeable: 200, behind: false });
    expect(planPace(200, '2026-10-16', now, 20)).toEqual({ daysLeft: 7, neededPerDay: 29, seeable: 140, behind: true });
    expect(planPace(0, '2026-10-16', now, 20)).toEqual({ daysLeft: 7, neededPerDay: 0, seeable: 0, behind: false });
    expect(planPace(30, '2026-10-09', now, 20)).toEqual({ daysLeft: 0, neededPerDay: 30, seeable: 0, behind: true });
    expect(planPace(30, '2026-10-01', now, 20)).toEqual({ daysLeft: 0, neededPerDay: 30, seeable: 0, behind: true });
  });

  it('says so only when behind', () => {
    expect(describePace(planPace(200, '2026-10-16', now, 20), 200)).toBe(
      'At this pace you’ll see 140 of 200 cards before the target date.',
    );
    expect(describePace(planPace(200, '2026-10-19', now, 20), 200)).toBeNull();
    expect(describePace(planPace(1, '2026-10-09', now, 20), 1)).toBe('The target date has come. 1 card not seen yet.');
    expect(describePace(null, 5)).toBeNull();
  });
});

describe('reviews are due by their day (reviewDueBy)', () => {
  const REVIEW = 2;
  const LEARNING = 1;

  it('endOfLocalDay is the last millisecond of the local day', () => {
    const morning = new Date(2026, 9, 14, 9, 0, 0, 0).getTime();
    expect(endOfLocalDay(morning)).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime() - 1);
    expect(endOfLocalDay(endOfLocalDay(morning))).toBe(endOfLocalDay(morning));
  });

  it('a review due minutes into the block is asked at its start; a learning step waits for its minute', () => {
    // Studied at 10:02 three days ago: the card comes back at 10:02 today, two minutes into a 10:00 block.
    const review = due('r', REVIEW, NOW + 2 * MIN);
    const learning = due('l', LEARNING, NOW + 30 * MIN);
    const today = endOfLocalDay(NOW);
    expect(nextItem(input({ due: [review, learning], reviewDueBy: today }))).toMatchObject({ type: 'card', card: { cardId: 'r', reason: 'review' } });
    expect(queueCounts(input({ due: [review, learning], reviewDueBy: today })).due).toBe(1);
    expect(isDueNow(learning, { now: NOW, reviewDueBy: today })).toBe(false);
    // Without it (the default) the review is not due yet and the block has nothing to ask.
    expect(nextItem(input({ due: [review] }))).toEqual({ type: 'done', reason: 'all_caught_up' });
    // A review due tomorrow is not today's.
    expect(nextItem(input({ due: [due('t', REVIEW, today + 1)], reviewDueBy: today }))).toEqual({ type: 'done', reason: 'all_caught_up' });
  });
});
