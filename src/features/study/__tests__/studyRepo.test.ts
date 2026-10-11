/**
 * The study writes' SQL, against a recording fake of the database (like cycleRepo.test.ts): one
 * transaction per answer, the derived card_states id, UPDATE vs INSERT, the replay guard, the clamp.
 * studyQueries.test.ts runs the same functions against real SQLite.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CARD_STATE_ID_NAMESPACE } from '@/db/constants';

import { RATING } from '../fsrs';
import {
  answerCard,
  countDueCards,
  createCard,
  createCardLink,
  createPlan,
  createTopic,
  deletePlan,
  durationMs,
  firstDueAfter,
  markTranscriptsConfirmed,
  newCardsSince,
  saveTranscript,
  setCardSuspended,
  updateCard,
  updatePlan,
  validDate,
  type AnswerInput,
} from '../studyRepo';
import { uuidV5 } from '../uuidv5';

type Call = { via: 'tx' | 'db'; method: string; sql: string; params: unknown[] };
function mockCreateDb() {
  const calls: Call[] = [];
  /** Rows "already in a table", keyed by the first parameter of the SELECT that looks them up. */
  const rows = new Map<string, Record<string, unknown>>();
  const lists = { getAll: [] as unknown[] };
  const answers = { getOptional: null as unknown };
  const record = (via: Call['via'], method: string) => async (sql: string, params: unknown[] = []) => {
    calls.push({ via, method, sql, params });
    if (method === 'getOptional') {
      if (via === 'db') return answers.getOptional;
      return rows.get(String(params[0])) ?? null;
    }
    if (method === 'getAll') return lists.getAll;
    return { rowsAffected: 1 };
  };
  const tx = { execute: record('tx', 'execute'), getOptional: record('tx', 'getOptional'), getAll: record('tx', 'getAll') };
  return {
    calls,
    rows,
    lists,
    answers,
    transactions: 0,
    execute: record('db', 'execute'),
    getOptional: record('db', 'getOptional'),
    async writeTransaction<T>(callback: (context: typeof tx) => Promise<T>): Promise<T> {
      this.transactions += 1;
      return callback(tx);
    },
  };
}
jest.mock('../../../db/database', () => ({ db: mockCreateDb() }));
const mockDb = (jest.requireMock('../../../db/database') as { db: ReturnType<typeof mockCreateDb> }).db;

const USER = '11111111-1111-4111-8111-111111111111';
const CARD = '70000000-0000-4000-8000-000000000001';
const STATE_ID = '57743c5a-f966-538b-bccb-0919027b21c9';
const REVIEW = '80000000-0000-4000-8000-000000000001';
const BLOCK = '44444444-4444-4444-8444-444444444444';
const PLAN = '90000000-0000-4000-8000-000000000001';
const TOPIC = '91000000-0000-4000-8000-000000000001';
const T0 = Date.UTC(2026, 9, 9, 9, 0, 0, 0);
const ISO0 = '2026-10-09T09:00:00.000Z';
const MIN = 60_000;

const REVIEW_INSERT =
  'INSERT INTO reviews (id, user_id, card_id, interval_block_id, rating, answer_mode, reviewed_at, duration_ms, prev_state, elapsed_days, state, due_at, stability, difficulty, scheduled_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const STATE_SELECT =
  'SELECT id, state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review FROM card_states WHERE id = ?';
const STATE_INSERT =
  'INSERT INTO card_states (id, user_id, card_id, state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review, suspended, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const STATE_UPDATE =
  'UPDATE card_states SET state = ?, due = ?, stability = ?, difficulty = ?, scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, last_review = ?, updated_at = ? WHERE id = ?';

const answer: AnswerInput = {
  reviewId: REVIEW,
  userId: USER,
  cardId: CARD,
  blockId: BLOCK,
  grade: RATING.good,
  answerMode: 'self_graded',
  answeredAt: T0,
  shownAt: T0 - 8_000,
  fsrsParams: '{"enable_fuzz":false}',
};

const sqlOf = () => mockDb.calls.map((call) => [call.method, call.sql, call.params]);

beforeEach(() => {
  mockDb.calls.length = 0;
  mockDb.rows.clear();
  mockDb.transactions = 0;
  mockDb.lists.getAll = [];
  mockDb.answers.getOptional = null;
});

describe('answerCard', () => {
  it('first answer: one transaction that inserts the review, then the state under the derived id', async () => {
    const result = await answerCard(answer);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.calls.every((call) => call.via === 'tx')).toBe(true);
    expect(STATE_ID).toBe(uuidV5(`${USER}:${CARD}`, CARD_STATE_ID_NAMESPACE));
    const difficulty = (result?.next.difficulty ?? 0) as number;
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM reviews WHERE id = ?', [REVIEW]],
      ['getOptional', STATE_SELECT, [STATE_ID]],
      [
        'execute',
        REVIEW_INSERT,
        [REVIEW, USER, CARD, BLOCK, 3, 'self_graded', ISO0, 8000, 0, 0, 1, '2026-10-09T09:10:00.000Z', 2.3065, difficulty, 0, ISO0, ISO0],
      ],
      ['execute', STATE_INSERT, [STATE_ID, USER, CARD, 1, '2026-10-09T09:10:00.000Z', 2.3065, difficulty, 0, 1, 1, 0, ISO0, 0, ISO0, ISO0]],
    ]);
    expect(difficulty).toBeCloseTo(2.11810397, 6);
    expect(result).toEqual({
      reviewedAt: T0,
      prevState: 0,
      next: expect.objectContaining({ state: 1, due: '2026-10-09T09:10:00.000Z', reps: 1, last_review: ISO0 }),
    });
  });

  it('later answers update the existing state with every FSRS column (the whole state uploads)', async () => {
    mockDb.rows.set(STATE_ID, {
      id: STATE_ID,
      state: 1,
      due: '2026-10-09T09:10:00.000Z',
      stability: 2.3065,
      difficulty: 2.11810397,
      scheduled_days: 0,
      learning_steps: 1,
      reps: 1,
      lapses: 0,
      last_review: ISO0,
    });
    const at = T0 + 10 * MIN + 30_000;
    const result = await answerCard({ ...answer, answeredAt: at, shownAt: at - 5_000, answerMode: 'typed' });
    const iso = '2026-10-09T09:10:30.000Z';
    const [, , , update] = mockDb.calls;
    expect(update.sql).toBe(STATE_UPDATE);
    expect(update.params).toEqual([2, '2026-10-11T09:10:30.000Z', 2.3065, result?.next.difficulty, 2, 0, 2, 0, iso, iso, STATE_ID]);
    const insert = mockDb.calls[2];
    expect(insert.sql).toBe(REVIEW_INSERT);
    expect(insert.params.slice(4, 15)).toEqual([3, 'typed', iso, 5000, 1, 0, 2, '2026-10-11T09:10:30.000Z', 2.3065, result?.next.difficulty, 2]);
    expect(mockDb.calls.filter((call) => call.sql.startsWith('INSERT INTO card_states'))).toEqual([]);
  });

  it('a review id that is already stored writes nothing (a retried tap, a replay after a crash)', async () => {
    mockDb.rows.set(REVIEW, { id: REVIEW });
    await expect(answerCard(answer)).resolves.toBeNull();
    expect(mockDb.calls.map((call) => call.method)).toEqual(['getOptional']);
  });

  it('clamps a review whose clock went back to the last review', async () => {
    const last = '2026-10-12T09:00:00.000Z';
    mockDb.rows.set(STATE_ID, {
      id: STATE_ID,
      state: 2,
      due: '2026-10-20T09:00:00.000Z',
      stability: 8,
      difficulty: 3,
      scheduled_days: 8,
      learning_steps: 0,
      reps: 3,
      lapses: 0,
      last_review: last,
    });
    const result = await answerCard({ ...answer, answeredAt: T0 });
    expect(result?.reviewedAt).toBe(Date.parse(last));
    const insert = mockDb.calls[2];
    expect(insert.params[6]).toBe(last); // reviewed_at
    expect(insert.params[9]).toBe(0); // elapsed_days, never negative
    expect(mockDb.calls[3].params[8]).toBe(last); // last_review never goes back
  });

  it('stores no block outside a focus block, and lowercases ids', async () => {
    await answerCard({ ...answer, blockId: null, userId: USER.toUpperCase(), cardId: CARD.toUpperCase() });
    expect(mockDb.calls[1].params).toEqual([STATE_ID]);
    expect(mockDb.calls[2].params.slice(0, 4)).toEqual([REVIEW, USER, CARD, null]);
  });

  it('refuses bad input before writing anything', async () => {
    await expect(answerCard({ ...answer, grade: 5 as 3 })).rejects.toThrow(RangeError);
    await expect(answerCard({ ...answer, answerMode: 'spoken' as 'typed' })).rejects.toThrow(RangeError);
    await expect(answerCard({ ...answer, cardId: 'card-1' })).rejects.toThrow(RangeError);
    await expect(answerCard({ ...answer, reviewId: '' })).rejects.toThrow(RangeError);
    await expect(answerCard({ ...answer, blockId: 'block' })).rejects.toThrow(RangeError);
    await expect(answerCard({ ...answer, answeredAt: Number.NaN })).rejects.toThrow(RangeError);
    expect(mockDb.calls.filter((call) => call.method === 'execute')).toEqual([]);
  });
});

describe('durationMs', () => {
  it('is shown → answered, capped at 10 minutes, null when unknown or negative', () => {
    expect(durationMs(T0, T0 + 4_200)).toBe(4200);
    expect(durationMs(T0, T0 + 30 * MIN)).toBe(600_000);
    expect(durationMs(null, T0)).toBeNull();
    expect(durationMs(T0 + 1, T0)).toBeNull();
    expect(durationMs(Number.NaN, T0)).toBeNull();
  });
});

describe('setCardSuspended', () => {
  it('updates an existing state', async () => {
    mockDb.rows.set(STATE_ID, { id: STATE_ID });
    await setCardSuspended(USER, CARD, true, T0);
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM card_states WHERE id = ?', [STATE_ID]],
      ['execute', 'UPDATE card_states SET suspended = ?, updated_at = ? WHERE id = ?', [1, ISO0, STATE_ID]],
    ]);
  });

  it('gives a never-studied card an empty suspended state, and does nothing to unsuspend one', async () => {
    await setCardSuspended(USER, CARD, true, T0);
    expect(mockDb.calls[1].sql).toBe(
      'INSERT INTO card_states (id, user_id, card_id, state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review, suspended, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, NULL, 1, ?, ?)',
    );
    expect(mockDb.calls[1].params).toEqual([STATE_ID, USER, CARD, ISO0, ISO0, ISO0]);
    mockDb.calls.length = 0;
    await setCardSuspended(USER, CARD, false, T0);
    expect(mockDb.calls.map((call) => call.method)).toEqual(['getOptional']);
  });
});

describe('plans', () => {
  const plan = { id: PLAN, ownerId: USER, title: '  Biology 101 ', scope: 'cumulative' as const, goal: ' Pass ', targetDate: '2026-12-15', createdAt: T0 };

  it('creates a plan once', async () => {
    await createPlan(plan);
    expect(sqlOf()).toEqual([
      ['getOptional', 'SELECT id FROM study_plans WHERE id = ?', [PLAN]],
      [
        'execute',
        'INSERT INTO study_plans (id, owner_id, title, scope, goal, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [PLAN, USER, 'Biology 101', 'cumulative', 'Pass', '2026-12-15', ISO0, ISO0],
      ],
    ]);
    mockDb.calls.length = 0;
    mockDb.rows.set(PLAN, { id: PLAN });
    await createPlan(plan);
    expect(mockDb.calls.map((call) => call.method)).toEqual(['getOptional']);
  });

  it('refuses a plan without a title, an unknown scope or an impossible date', async () => {
    await expect(createPlan({ ...plan, title: '   ' })).rejects.toThrow(RangeError);
    await expect(createPlan({ ...plan, title: 'x'.repeat(201) })).rejects.toThrow(RangeError);
    await expect(createPlan({ ...plan, scope: 'weekly' as 'single' })).rejects.toThrow(RangeError);
    await expect(createPlan({ ...plan, targetDate: '2026-02-30' })).rejects.toThrow(RangeError);
    await expect(createPlan({ ...plan, targetDate: '15/12/2026' })).rejects.toThrow(RangeError);
    expect(validDate('')).toBeNull();
    expect(validDate(null)).toBeNull();
    expect(validDate('2028-02-29')).toBe('2028-02-29');
  });

  it('updates only the given columns, and reports a plan that is not on the phone', async () => {
    mockDb.rows.set(PLAN, { id: PLAN });
    await expect(updatePlan(PLAN, { scope: 'single', targetDate: null }, T0)).resolves.toBe(true);
    expect(mockDb.calls[1].sql).toBe('UPDATE study_plans SET scope = ?, target_date = ?, updated_at = ? WHERE id = ?');
    expect(mockDb.calls[1].params).toEqual(['single', null, ISO0, PLAN]);
    mockDb.rows.clear();
    await expect(updatePlan(PLAN, { title: 'New' }, T0)).resolves.toBe(false);
    await expect(updatePlan(PLAN, {}, T0)).rejects.toThrow('Nothing to update');
  });

  it('deletes a plan with its content, but only for its owner', async () => {
    const SOURCE = 'a0000000-0000-4000-8000-000000000001';
    mockDb.rows.set(PLAN, { owner_id: USER });
    mockDb.lists.getAll = [{ source_id: SOURCE }];
    await expect(deletePlan(PLAN, USER)).resolves.toBe(true);
    expect(mockDb.transactions).toBe(1);
    expect(mockDb.calls.filter((call) => call.method === 'execute').map((call) => [call.sql, call.params])).toEqual([
      ['DELETE FROM card_links WHERE plan_id = ?', [PLAN]],
      ['DELETE FROM cards WHERE plan_id = ?', [PLAN]],
      ['DELETE FROM topics WHERE plan_id = ?', [PLAN]],
      ['DELETE FROM plan_sources WHERE plan_id = ?', [PLAN]],
      ['DELETE FROM source_files WHERE source_id = ?', [SOURCE]],
      ['DELETE FROM sources WHERE id = ?', [SOURCE]],
      ['DELETE FROM study_plans WHERE id = ?', [PLAN]],
    ]);
    mockDb.calls.length = 0;
    mockDb.rows.set(PLAN, { owner_id: '22222222-2222-4222-8222-222222222222' });
    await expect(deletePlan(PLAN, USER)).resolves.toBe(false);
    expect(mockDb.calls.filter((call) => call.method === 'execute')).toEqual([]);
  });
});

describe('transcripts', () => {
  const FILE = 'b0000000-0000-4000-8000-000000000001';

  it('saves an edit without confirming it', async () => {
    await saveTranscript(FILE, 'Mitosis has four phases', T0);
    expect(sqlOf()).toEqual([
      ['execute', 'UPDATE source_files SET transcript = ?, updated_at = ? WHERE id = ?', ['Mitosis has four phases', ISO0, FILE]],
    ]);
    await expect(saveTranscript(FILE, 'x'.repeat(20_001), T0)).rejects.toThrow(RangeError);
  });

  it('marks confirmed transcripts in one transaction', async () => {
    await markTranscriptsConfirmed([{ id: FILE, transcript: 'final' }], T0);
    expect(mockDb.transactions).toBe(1);
    expect(sqlOf()).toEqual([
      ['execute', 'UPDATE source_files SET transcript = ?, confirmed = ?, updated_at = ? WHERE id = ?', ['final', 1, ISO0, FILE]],
    ]);
    await markTranscriptsConfirmed([], T0);
    expect(mockDb.transactions).toBe(1);
  });
});

describe('topics, cards and links', () => {
  const NEW_CARD = 'c0000000-0000-4000-8000-000000000001';

  it('a hand-made topic is ready at once', async () => {
    await createTopic({ id: TOPIC, planId: PLAN, title: 'Cells', position: 3, createdAt: T0 });
    expect(mockDb.calls[1].sql).toBe(
      'INSERT INTO topics (id, plan_id, title, position, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    expect(mockDb.calls[1].params).toEqual([TOPIC, PLAN, 'Cells', 3, 'ready', ISO0, ISO0]);
  });

  it('a hand-made card takes its topic’s plan and never sends a source', async () => {
    mockDb.rows.set(TOPIC, { plan_id: PLAN });
    await expect(createCard({ id: NEW_CARD, topicId: TOPIC, question: ' What? ', answer: 'That', createdAt: T0 })).resolves.toBe(true);
    const insert = mockDb.calls.find((call) => call.sql.startsWith('INSERT INTO cards'));
    expect(insert?.sql).toBe(
      'INSERT INTO cards (id, topic_id, plan_id, question, answer, card_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    expect(insert?.params).toEqual([NEW_CARD, TOPIC, PLAN, 'What?', 'That', 'basic', ISO0, ISO0]);
    mockDb.rows.clear();
    await expect(createCard({ id: NEW_CARD, topicId: TOPIC, question: 'Q', answer: 'A', createdAt: T0 })).resolves.toBe(false);
    await expect(createCard({ id: NEW_CARD, topicId: TOPIC, question: '', answer: 'A', createdAt: T0 })).rejects.toThrow(RangeError);
    await expect(
      createCard({ id: NEW_CARD, topicId: TOPIC, question: 'Q', answer: 'A', cardType: 'essay' as 'basic', createdAt: T0 }),
    ).rejects.toThrow(RangeError);
  });

  it('updates a card’s text', async () => {
    await updateCard(NEW_CARD, { answer: ' B ', cardType: 'why' }, T0);
    expect(sqlOf()).toEqual([
      ['execute', 'UPDATE cards SET answer = ?, card_type = ?, updated_at = ? WHERE id = ?', ['B', 'why', ISO0, NEW_CARD]],
    ]);
  });

  it('a link takes the from-card’s plan and its creator; never a card to itself', async () => {
    const LINK = 'd0000000-0000-4000-8000-000000000001';
    mockDb.rows.set(CARD, { plan_id: PLAN });
    await createCardLink({ id: LINK, fromCardId: CARD, toCardId: NEW_CARD, createdBy: USER, relation: 'why', note: ' because ', createdAt: T0 });
    const insert = mockDb.calls.find((call) => call.sql.startsWith('INSERT INTO card_links'));
    expect(insert?.params).toEqual([LINK, CARD, NEW_CARD, PLAN, USER, 'why', 'because', ISO0, ISO0]);
    await expect(createCardLink({ id: LINK, fromCardId: CARD, toCardId: CARD, createdBy: USER, createdAt: T0 })).rejects.toThrow(RangeError);
    await expect(
      createCardLink({ id: LINK, fromCardId: CARD, toCardId: NEW_CARD, createdBy: USER, relation: 'causes' as 'why', createdAt: T0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('reads', () => {
  it('counts due cards up to a time, finds the next due time and today’s new cards', async () => {
    mockDb.answers.getOptional = { n: 7 };
    await expect(countDueCards(USER, T0)).resolves.toBe(7);
    expect(mockDb.calls[0].params).toEqual([USER, ISO0]);
    mockDb.answers.getOptional = { due: '2026-10-10T08:00:00.000Z' };
    await expect(firstDueAfter(USER, T0)).resolves.toBe(Date.parse('2026-10-10T08:00:00.000Z'));
    mockDb.answers.getOptional = { due: null };
    await expect(firstDueAfter(USER, T0)).resolves.toBeNull();
    mockDb.answers.getOptional = { n: 4 };
    await expect(newCardsSince(USER, T0)).resolves.toBe(4);
  });
});
