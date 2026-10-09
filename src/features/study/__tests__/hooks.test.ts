import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  rescheduleReviewReminderNow,
  SELF_TEST_STATE_KEY,
  useDueCount,
  usePlans,
  useReviewReminders,
  useSourceProgress,
  useStudyQueue,
  type StudyQueueOptions,
} from '../hooks';
import { BLOCK_ANSWERS_SQL, DUE_COUNT_SQL, NEW_TODAY_SQL, PLAN_JOBS_SQL, PLAN_SOURCE_FILES_SQL, PLAN_SOURCES_SQL, PLANS_SQL, QUEUE_DUE_SQL, QUEUE_NEW_SQL, TOPICS_SQL } from '../studyQueries';
import { endOfLocalDay } from '../queue';

const USER = '11111111-1111-4111-8111-111111111111';
const PLAN = '90000000-0000-4000-8000-000000000001';
const BLOCK = 'e0000000-0000-4000-8000-000000000001';
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 9, 10, 0, 30);
/** "Due today" counts and the queue's due query look up to the end of the local day. */
const END_OF_TODAY = new Date(endOfLocalDay(NOW)).toISOString();

const mockAuth: { user: { id: string } | null } = { user: { id: USER } };
jest.mock('../../../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));

/** Rows each query returns, by its SQL text. */
const mockRows = new Map<string, unknown[]>();
const mockCalls: { sql: string; params: unknown[]; options: unknown }[] = [];
jest.mock('@powersync/react-native', () => ({
  useQuery: (sql: string, params: unknown[] = [], options?: unknown) => {
    mockCalls.push({ sql, params, options });
    return { data: mockRows.get(sql) ?? [], isLoading: false };
  },
}));
const mockLocal: { values: Map<string, unknown> } = { values: new Map() };
jest.mock('../../cycle/localState', () => ({
  useLocalState: (key: string) => ({ value: mockLocal.values.get(key) ?? null, isLoading: false }),
  readLocalState: jest.fn(async () => null),
  writeLocalState: jest.fn(async () => undefined),
}));
jest.mock('../../history/useHistory', () => ({ useStartOfToday: () => '2026-10-09T00:00:00.000Z' }));
jest.mock('../reminders', () => ({ rescheduleReviewReminder: jest.fn(async () => ({ status: 'off' })) }));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const local = jest.requireMock('../../cycle/localState') as { writeLocalState: AnyMock; readLocalState: AnyMock };
const reminders = jest.requireMock('../reminders') as { rescheduleReviewReminder: AnyMock };

function render<T>(hook: () => T): { latest: () => T; rerender: () => void; renders: () => number } {
  const seen: T[] = [];
  function Probe() {
    seen.push(hook());
    return null;
  }
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(createElement(Probe));
  });
  return {
    latest: () => seen[seen.length - 1],
    rerender: () => act(() => (renderer as unknown as ReactTestRenderer).update(createElement(Probe))),
    renders: () => seen.length,
  };
}

const callFor = (sql: string) => mockCalls.filter((call) => call.sql === sql).at(-1);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW });
  mockRows.clear();
  mockCalls.length = 0;
  mockLocal.values.clear();
  mockAuth.user = { id: USER };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('plans and counts', () => {
  it('usePlans asks with the user and the end of the local day (due = due today), and shapes the rows', () => {
    mockRows.set(PLANS_SQL, [{ id: PLAN, owner_id: USER, title: 'Bio', scope: 'cumulative', goal: '', target_date: null, due_count: 3, new_count: 2, card_count: 9, source_count: 1 }]);
    const { latest } = render(() => usePlans());
    expect(callFor(PLANS_SQL)?.params).toEqual([USER, END_OF_TODAY, USER]);
    expect(latest().plans).toEqual([expect.objectContaining({ id: PLAN, title: 'Bio', dueCount: 3, newCount: 2, isOwner: true })]);
  });

  it('useDueCount counts what is due today across plans', () => {
    mockRows.set(DUE_COUNT_SQL, [{ n: 7 }]);
    const { latest } = render(() => useDueCount());
    expect(latest()).toEqual({ count: 7, isLoading: false });
    expect(callFor(DUE_COUNT_SQL)?.params).toEqual([USER, END_OF_TODAY]);
  });
});

describe('useSourceProgress', () => {
  it('gives each source its step and the plan its next step', () => {
    mockRows.set(PLAN_SOURCES_SQL, [
      { plan_source_id: 'ps2', source_id: 's2', added_at: '2026-10-05T09:00:00.000Z', title: 'Notes', kind: 'notes', url: null, status: 'processing', owner_id: USER, card_count: 0 },
      { plan_source_id: 'ps1', source_id: 's1', added_at: '2026-10-01T09:00:00.000Z', title: 'Lecture', kind: 'pdf', url: null, status: 'ready', owner_id: USER, card_count: 12 },
    ]);
    mockRows.set(PLAN_SOURCE_FILES_SQL, [
      { id: 'f1', source_id: 's2', storage_path: 'x', page: 1, transcript: 'one', confirmed: 0 },
      { id: 'f2', source_id: 's2', storage_path: 'y', page: 2, transcript: 'two', confirmed: 1 },
    ]);
    mockRows.set(PLAN_JOBS_SQL, [
      { id: 'j1', job: 'handwriting', stage: 'transcribe', status: 'succeeded', error: null, plan_id: PLAN, source_id: 's2', created_at: '2026-10-05T09:00:01.000Z' },
      { id: 'j2', job: 'handwriting', stage: 'transcribe', status: 'succeeded', error: null, plan_id: PLAN, source_id: 's2', created_at: '2026-10-05T09:00:02.000Z' },
    ]);
    mockRows.set(TOPICS_SQL, [{ id: 't1', plan_id: PLAN, title: 'Cells', position: 0, status: 'ready', card_count: 12 }]);
    const { latest } = render(() => useSourceProgress(PLAN));
    const result = latest();
    expect(result.sources.map((s) => [s.sourceId, s.step.step, s.text.title])).toEqual([
      ['s2', 'check_transcripts', 'Check the transcription'],
      ['s1', 'ready', 'Ready'],
    ]);
    expect(result.nextStep).toEqual({ kind: 'check_transcripts', sourceId: 's2', unconfirmed: 1 });
    expect(callFor(PLAN_JOBS_SQL)?.params).toEqual([PLAN, PLAN]);
  });
});

describe('useStudyQueue', () => {
  const options: StudyQueueOptions = {
    planId: PLAN,
    blockId: BLOCK,
    scope: 'cumulative',
    filter: 'all',
    blockMs: 25 * MIN,
    remainingMs: 20 * MIN,
    now: NOW,
  };
  const stateRow = (cardId: string, state: number, due: number) => ({
    card_id: cardId, state_id: `st-${cardId}`, state, due: new Date(due).toISOString(), stability: 3, difficulty: 5, scheduled_days: 2,
    learning_steps: 0, reps: 2, lapses: 0, last_review: new Date(due - 2 * 24 * 60 * MIN).toISOString(),
    question: `Q ${cardId}`, answer: `A ${cardId}`, card_type: 'basic', page: 4, topic_id: 't1', source_id: 's1', topic_position: 0, source_title: 'Lecture',
  });
  const newRow = (cardId: string) => ({ ...stateRow(cardId, 0, NOW), state_id: null, state: null, due: null, last_review: null });

  it('feeds the queries into the queue: a due review first', () => {
    mockRows.set(QUEUE_DUE_SQL, [stateRow('r1', 2, NOW - 5 * MIN)]);
    mockRows.set(QUEUE_NEW_SQL, [newRow('n1')]);
    const { latest } = render(() => useStudyQueue(options));
    const queue = latest();
    expect(queue.next).toMatchObject({ type: 'card', card: { cardId: 'r1', reason: 'review', sourceTitle: 'Lecture', page: 4 } });
    expect(queue.counts).toEqual({ due: 1, fresh: 1 });
    expect(queue.newLeft).toBe(5);
    expect(queue.scope).toEqual({ sourceId: null, note: null });
    // Reviews are due by their day: the due query looks up to the end of the local day (the block
    // ends at 10:20:30, well before), so it changes once a day.
    expect(callFor(QUEUE_DUE_SQL)?.params).toEqual([USER, PLAN, null, null, END_OF_TODAY]);
    expect(callFor(QUEUE_DUE_SQL)?.options).toEqual({ throttleMs: 1000 });
    expect(callFor(BLOCK_ANSWERS_SQL)?.params).toEqual([BLOCK]);
    expect(callFor(NEW_TODAY_SQL)?.params).toEqual([USER, '2026-10-09T00:00:00.000Z']);
  });

  it('a review due later today is asked at the block’s start; a block past midnight looks to its end', () => {
    // Last answered at 10:02 a few days ago: back at 10:02 today, two minutes into this block.
    mockRows.set(QUEUE_DUE_SQL, [stateRow('r2', 2, NOW + 2 * MIN)]);
    const { latest } = render(() => useStudyQueue(options));
    expect(latest().next).toMatchObject({ type: 'card', card: { cardId: 'r2', reason: 'review' } });
    expect(latest().counts.due).toBe(1);

    mockCalls.length = 0;
    const late = endOfLocalDay(NOW) + 1 - 10 * MIN; // 23:50 local
    render(() => useStudyQueue({ ...options, now: late, remainingMs: 25 * MIN }));
    // 23:50 + 25 min = 00:15 tomorrow: learning steps inside the block are still read.
    expect(callFor(QUEUE_DUE_SQL)?.params).toEqual([USER, PLAN, null, null, new Date(late + 25 * MIN).toISOString()]);
  });

  it('a card marked answered is not asked again before the rows refresh', () => {
    mockRows.set(QUEUE_NEW_SQL, [newRow('n1'), newRow('n2')]);
    const { latest, rerender, renders } = render(() => useStudyQueue(options));
    expect(latest().next).toMatchObject({ card: { cardId: 'n1' } });
    act(() => latest().markAnswered('n1', 'rev-1'));
    expect(latest().next).toMatchObject({ card: { cardId: 'n2' } });
    // Once the answer is in the block's rows, the card is forgotten (and the queue avoids repeating it).
    mockRows.set(BLOCK_ANSWERS_SQL, [{ id: 'rev-1', card_id: 'n1', prev_state: 0, rating: 3, reviewed_at: new Date(NOW).toISOString(), duration_ms: 5000, source_id: 's1', topic_id: 't1' }]);
    mockRows.set(QUEUE_NEW_SQL, [newRow('n2'), newRow('n3')]);
    mockRows.set(QUEUE_DUE_SQL, [stateRow('n1', 1, NOW + 10 * MIN)]);
    const before = renders();
    rerender();
    expect(renders()).toBeGreaterThan(before);
    expect(latest().next).toMatchObject({ card: { cardId: 'n2', reason: 'new' } });
    expect(latest().newLeft).toBe(4);
  });

  it('keeps the self-test’s start once the queue begins it, and uses a stored one', () => {
    const answered = { id: 'rev-1', card_id: 'n1', prev_state: 0, rating: 3, reviewed_at: new Date(NOW - 10 * MIN).toISOString(), duration_ms: 5000, source_id: 's1', topic_id: 't1' };
    mockRows.set(BLOCK_ANSWERS_SQL, [answered, { ...answered, id: 'rev-2', card_id: 'r9', prev_state: 2 }]);
    mockRows.set(QUEUE_DUE_SQL, [stateRow('n1', 1, NOW + 30 * MIN)]);
    const { latest } = render(() => useStudyQueue({ ...options, remainingMs: 2 * MIN }));
    expect(latest().next).toMatchObject({ type: 'card', card: { cardId: 'n1', reason: 'self_test' } });
    expect(local.writeLocalState).toHaveBeenCalledWith(SELF_TEST_STATE_KEY, { blockId: BLOCK, from: NOW - MIN });

    jest.clearAllMocks();
    mockLocal.values.set(SELF_TEST_STATE_KEY, { blockId: BLOCK, from: NOW - 5 * MIN });
    const stored = render(() => useStudyQueue({ ...options, remainingMs: 2 * MIN }));
    // The stored start (5 minutes ago) is after n1's answer, so n1 is still to be re-tested.
    expect(stored.latest().next).toMatchObject({ card: { cardId: 'n1', reason: 'self_test' }, selfTestFrom: null });
    expect(local.writeLocalState).not.toHaveBeenCalled();
  });

  it('nothing to show without a plan', () => {
    const { latest } = render(() => useStudyQueue({ ...options, planId: null }));
    expect(latest().next).toBeNull();
    expect(latest().isLoading).toBe(true);
  });

  it('the newest-source filter studies that source and interleaves by topic', () => {
    mockRows.set(PLAN_SOURCES_SQL, [
      { plan_source_id: 'ps2', source_id: 's2', added_at: '2026-10-05T09:00:00.000Z', title: 'Week 2', kind: 'pdf', url: null, status: 'ready', owner_id: USER, card_count: 4 },
      { plan_source_id: 'ps1', source_id: 's1', added_at: '2026-10-01T09:00:00.000Z', title: 'Week 1', kind: 'pdf', url: null, status: 'ready', owner_id: USER, card_count: 9 },
    ]);
    const { latest } = render(() => useStudyQueue({ ...options, filter: 'newest' }));
    expect(latest().scope).toEqual({ sourceId: 's2', note: null });
    expect(callFor(QUEUE_NEW_SQL)?.params).toEqual([USER, PLAN, 's2', 's2']);
  });
});

describe('the review reminder', () => {
  it('reschedules on start with this phone’s setting, and again when the app comes back', () => {
    mockLocal.values.set('study-prefs', { reminder: { enabled: true, hour: 19, minute: 15 } });
    const listeners: ((status: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (status: string) => void) => {
      listeners.push(listener);
      return { remove: () => undefined };
    }) as never);
    render(() => useReviewReminders());
    expect(reminders.rescheduleReviewReminder).toHaveBeenCalledWith(USER, { enabled: true, hour: 19, minute: 15 });
    act(() => listeners.forEach((listener) => listener('active')));
    expect(reminders.rescheduleReviewReminder).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('rescheduleReviewReminderNow reads the setting first', async () => {
    local.readLocalState.mockResolvedValueOnce({ reminder: { enabled: true, hour: 8, minute: 0 } });
    await rescheduleReviewReminderNow(USER);
    expect(reminders.rescheduleReviewReminder).toHaveBeenCalledWith(USER, { enabled: true, hour: 8, minute: 0 });
  });
});
