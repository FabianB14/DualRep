/**
 * The study queries and writes against real SQLite (node:sqlite, the same tables and columns as the
 * PowerSync client schema): the SQL parses, its parameters line up, and it reads and writes the rows
 * the screens and the queue expect.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SqliteDb } from '../../history/testing/sqliteDb';
import { RATING } from '../fsrs';
import { nextItem } from '../queue';
import { answerCard, deletePlan, setCardSuspended } from '../studyRepo';
import {
  BLOCK_ANSWERS_SQL,
  blockAnswerFromRow,
  CARD_LINKS_SQL,
  CARD_SQL,
  CARD_STATES_VERSION_SQL,
  cardFromRow,
  citation,
  DUE_COUNT_SQL,
  dueCandidateFromRow,
  FIRST_DUE_AFTER_SQL,
  NEW_TODAY_SQL,
  newCandidateFromRow,
  PLAN_CARDS_SQL,
  PLAN_JOBS_SQL,
  PLAN_LINKS_SQL,
  PLAN_SOURCE_FILES_SQL,
  PLAN_SOURCES_SQL,
  PLAN_SQL,
  planFromRow,
  PLANS_SQL,
  QUEUE_DUE_SQL,
  QUEUE_NEW_SQL,
  SESSION_REVIEWS_SQL,
  SOURCE_FILES_SQL,
  topicFromRow,
  TOPICS_SQL,
  type BlockAnswerRow,
  type CardListRow,
  type PlanRow,
  type QueueStateRow,
  type TopicRow,
} from '../studyQueries';
import { cardStateId } from '../uuidv5';

jest.mock('../../../db/database', () => ({
  db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
}));
const db = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;

const U = '11111111-1111-4111-8111-111111111111';
const O = '22222222-2222-4222-8222-222222222222';
const P = '90000000-0000-4000-8000-000000000001';
const P2 = '90000000-0000-4000-8000-000000000002';
const S1 = 'a0000000-0000-4000-8000-000000000001';
const S2 = 'a0000000-0000-4000-8000-000000000002';
const S3 = 'a0000000-0000-4000-8000-000000000003';
const T1 = 'b0000000-0000-4000-8000-000000000001';
const T2 = 'b0000000-0000-4000-8000-000000000002';
const T3 = 'b0000000-0000-4000-8000-000000000003';
const T4 = 'b0000000-0000-4000-8000-000000000004';
const card = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;
const BLOCK = 'e0000000-0000-4000-8000-000000000001';
const SESSION = 'f0000000-0000-4000-8000-000000000001';

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW_ISO = iso(NOW);

function state(cardId: string, userId: string, extra: Record<string, unknown>) {
  db.seed('card_states', {
    id: cardStateId(userId, cardId),
    user_id: userId,
    card_id: cardId,
    state: 2,
    due: iso(NOW - MIN),
    stability: 5,
    difficulty: 5,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    last_review: iso(NOW - 3 * 24 * 60 * MIN),
    suspended: 0,
    created_at: iso(NOW - 10 * 24 * 60 * MIN),
    updated_at: iso(NOW - 3 * 24 * 60 * MIN),
    ...extra,
  });
}

function seedAll() {
  db.seed('study_plans', { id: P, owner_id: U, title: 'Biology', scope: 'cumulative', goal: 'Pass', target_date: '2026-12-15', created_at: iso(NOW - 9e8), updated_at: iso(NOW - 9e8) });
  db.seed('study_plans', { id: P2, owner_id: O, group_id: 'g', title: 'Group chem', scope: 'single', goal: '', target_date: null, created_at: iso(NOW - 8e8), updated_at: iso(NOW - 1e8) });
  db.seed('sources', { id: S1, owner_id: U, kind: 'pdf', title: 'Lecture 1', status: 'ready' });
  db.seed('sources', { id: S2, owner_id: U, kind: 'notes', title: 'Notes week 2', status: 'processing' });
  db.seed('sources', { id: S3, owner_id: U, kind: 'pdf', title: 'Shared reading', status: 'ready' });
  db.seed('plan_sources', { id: 'ps1', plan_id: P, source_id: S1, added_at: '2026-10-01T09:00:00.000Z' });
  db.seed('plan_sources', { id: 'ps2', plan_id: P, source_id: S2, added_at: '2026-10-05T09:00:00.000Z' });
  db.seed('plan_sources', { id: 'ps3', plan_id: P, source_id: S3, added_at: '2026-09-01T09:00:00.000Z' });
  db.seed('plan_sources', { id: 'ps4', plan_id: P2, source_id: S3, added_at: '2026-09-01T09:00:00.000Z' });
  db.seed('source_files', { id: 'f2', source_id: S2, owner_id: U, storage_path: `${U}/${S2}/2.jpg`, page: 2, transcript: 'page two', confirmed: 0, created_at: iso(NOW) });
  db.seed('source_files', { id: 'f1', source_id: S2, owner_id: U, storage_path: `${U}/${S2}/1.jpg`, page: 1, transcript: 'page one', confirmed: 1, created_at: iso(NOW) });
  db.seed('topics', { id: T1, plan_id: P, title: 'Cells', position: 0, status: 'ready', created_at: iso(NOW) });
  db.seed('topics', { id: T2, plan_id: P, title: 'Draft topic', position: 1, status: 'draft', created_at: iso(NOW) });
  db.seed('topics', { id: T3, plan_id: P, title: 'Confirmed', position: 2, status: 'confirmed', created_at: iso(NOW) });
  db.seed('topics', { id: T4, plan_id: P, title: 'Old row', position: 3, status: null, created_at: iso(NOW) });
  const cardRow = (n: number, topic: string, source: string | null, created: number) => ({
    id: card(n), topic_id: topic, plan_id: P, source_id: source, page: n, question: `Q${n}`, answer: `A${n}`, card_type: 'basic', created_at: iso(created),
  });
  db.seed('cards', cardRow(1, T1, S1, NOW - 50));
  db.seed('cards', cardRow(2, T1, S1, NOW - 40));
  db.seed('cards', cardRow(3, T2, S2, NOW - 30)); // draft topic: never counted
  db.seed('cards', cardRow(4, T3, S2, NOW - 20));
  db.seed('cards', cardRow(5, T4, null, NOW - 10)); // hand-made, topic without a status
  db.seed('cards', cardRow(6, T1, S2, NOW - 5));
  db.seed('cards', cardRow(7, T1, S2, NOW - 1));
  state(card(1), U, {}); // review due a minute ago
  state(card(2), U, { state: 1, due: iso(NOW + 5 * MIN) }); // learning, due inside the block
  state(card(3), U, {}); // due, but its topic is a draft
  state(card(4), U, { due: iso(NOW + 2 * 24 * 60 * MIN) }); // due in two days
  state(card(6), U, { state: 0, suspended: 1, reps: 0, last_review: null }); // suspended, never studied
  state(card(1), O, {}); // someone else's state
  state('c0000000-0000-4000-8000-0000000000ff', U, {}); // a card no longer on the phone
}

beforeEach(() => {
  db.reset();
  seedAll();
});

describe('plans', () => {
  it('lists every plan with its counts', async () => {
    const rows = await db.getAll<PlanRow>(PLANS_SQL, [U, NOW_ISO, U]);
    expect(rows.map((row) => row.id)).toEqual([P2, P]);
    const plan = planFromRow(rows[1], U);
    expect(plan).toEqual({
      id: P,
      ownerId: U,
      groupId: null,
      title: 'Biology',
      scope: 'cumulative',
      goal: 'Pass',
      targetDate: '2026-12-15',
      sourceCount: 3,
      cardCount: 6, // 7 cards, one in a draft topic
      dueCount: 1, // card 1 (card 2 is due later, card 3's topic is a draft)
      newCount: 2, // cards 5 and 7 (card 6 is suspended)
      isOwner: true,
    });
    expect(planFromRow(rows[0], U)).toMatchObject({ isOwner: false, scope: 'single', targetDate: null, cardCount: 0 });
  });

  it('reads one plan', async () => {
    const rows = await db.getAll<PlanRow>(PLAN_SQL, [U, NOW_ISO, U, P]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(P);
  });
});

describe('sources, files, jobs', () => {
  it('lists a plan’s sources newest first, with their card counts', async () => {
    const rows = await db.getAll(PLAN_SOURCES_SQL, [P]);
    expect(rows.map((row) => [row.source_id, row.title, row.card_count])).toEqual([
      [S2, 'Notes week 2', 4],
      [S1, 'Lecture 1', 2],
      [S3, 'Shared reading', 0],
    ]);
  });

  it('lists files in page order', async () => {
    expect((await db.getAll(PLAN_SOURCE_FILES_SQL, [P])).map((row) => row.id)).toEqual(['f1', 'f2']);
    expect((await db.getAll(SOURCE_FILES_SQL, [S2])).map((row) => [row.id, row.confirmed])).toEqual([
      ['f1', 1],
      ['f2', 0],
    ]);
  });

  it('lists the pipeline jobs of the plan and its sources, oldest first', async () => {
    db.seed('tracy_events', { id: 'j1', user_id: U, job: 'study_builder', stage: 'extract', status: 'succeeded', source_id: S1, plan_id: P, created_at: '2026-10-01T09:00:00.000Z' });
    db.seed('tracy_events', { id: 'j2', user_id: U, job: 'handwriting', stage: 'transcribe', status: 'running', source_id: S2, plan_id: null, created_at: '2026-10-05T09:00:00.000Z' });
    db.seed('tracy_events', { id: 'j3', user_id: U, job: 'transition_planner', stage: null, status: 'succeeded', created_at: '2026-10-05T09:00:00.000Z' });
    db.seed('tracy_events', { id: 'j4', user_id: U, job: 'study_builder', stage: 'outline', status: 'queued', source_id: null, plan_id: P, created_at: '2026-10-06T09:00:00.000Z' });
    expect((await db.getAll(PLAN_JOBS_SQL, [P, P])).map((row) => row.id)).toEqual(['j1', 'j2', 'j4']);
  });
});

describe('topics, cards, links', () => {
  it('lists topics in outline order with their statuses (a missing status is ready)', async () => {
    const topics = (await db.getAll<TopicRow>(TOPICS_SQL, [P])).map(topicFromRow);
    expect(topics.map((t) => [t.title, t.status, t.cardCount])).toEqual([
      ['Cells', 'ready', 4],
      ['Draft topic', 'draft', 1],
      ['Confirmed', 'confirmed', 1],
      ['Old row', 'ready', 1],
    ]);
  });

  it('lists a plan’s cards without draft topics, with the user’s state and the source title', async () => {
    const cards = (await db.getAll<CardListRow>(PLAN_CARDS_SQL, [U, P])).map(cardFromRow);
    expect(cards.map((c) => c.id)).toEqual([card(1), card(2), card(6), card(7), card(4), card(5)]);
    expect(cards[0]).toEqual({
      id: card(1),
      topicId: T1,
      planId: P,
      sourceId: S1,
      sourceTitle: 'Lecture 1',
      page: 1,
      question: 'Q1',
      answer: 'A1',
      cardType: 'basic',
      state: 2,
      due: iso(NOW - MIN),
      suspended: false,
    });
    expect(cards[2]).toMatchObject({ suspended: true, state: 0 });
    expect(cards[5]).toMatchObject({ sourceId: null, sourceTitle: null, state: null });
    const one = await db.getAll<CardListRow>(CARD_SQL, [U, card(4)]);
    expect(cardFromRow(one[0])).toMatchObject({ id: card(4), sourceTitle: 'Notes week 2' });
  });

  it('cites the page and the source', () => {
    expect(citation(12, 'Lecture 3')).toBe('p. 12, Lecture 3');
    expect(citation(null, 'Lecture 3')).toBe('Lecture 3');
    expect(citation(4, '  ')).toBe('p. 4');
    expect(citation(null, null)).toBeNull();
  });

  it('lists a card’s links both ways with the other card’s question, and a plan’s links', async () => {
    db.seed('card_links', { id: 'l1', from_card_id: card(1), to_card_id: card(2), plan_id: P, created_by: U, relation: 'why', created_at: iso(NOW) });
    db.seed('card_links', { id: 'l2', from_card_id: card(4), to_card_id: card(1), plan_id: P, created_by: U, relation: 'related', created_at: iso(NOW + 1) });
    const links = await db.getAll(CARD_LINKS_SQL, [card(1), card(1), card(1), card(1)]);
    expect(links.map((l) => [l.id, l.other_card_id, l.other_question])).toEqual([
      ['l1', card(2), 'Q2'],
      ['l2', card(4), 'Q4'],
    ]);
    expect((await db.getAll(PLAN_LINKS_SQL, [P])).map((l) => l.id)).toEqual(['l1', 'l2']);
  });
});

describe('due counts', () => {
  it('counts the user’s due cards on the phone, outside draft topics', async () => {
    expect((await db.get<{ n: number }>(DUE_COUNT_SQL, [U, NOW_ISO])).n).toBe(1);
    expect((await db.get<{ n: number }>(DUE_COUNT_SQL, [U, iso(NOW + 10 * MIN)])).n).toBe(2);
    expect((await db.get<{ n: number }>(DUE_COUNT_SQL, [O, NOW_ISO])).n).toBe(1);
  });

  it('finds the next due time after a moment', async () => {
    expect((await db.get<{ due: string | null }>(FIRST_DUE_AFTER_SQL, [U, NOW_ISO])).due).toBe(iso(NOW + 5 * MIN));
    expect((await db.get<{ due: string | null }>(FIRST_DUE_AFTER_SQL, [U, iso(NOW + 3 * 24 * 60 * MIN)])).due).toBeNull();
  });

  it('changes its version when a state changes', async () => {
    const before = await db.get(CARD_STATES_VERSION_SQL, [U]);
    await answerCard({ reviewId: 'd0000000-0000-4000-8000-000000000001', userId: U, cardId: card(1), blockId: null, grade: 3, answerMode: 'self_graded', answeredAt: NOW, shownAt: null });
    expect(await db.get(CARD_STATES_VERSION_SQL, [U])).not.toEqual(before);
  });
});

describe('the queue queries', () => {
  const dueRows = (source: string | null, until = iso(NOW + 25 * MIN)) =>
    db.getAll<QueueStateRow>(QUEUE_DUE_SQL, [U, P, source, source, until]);
  const newRows = (source: string | null) => db.getAll<QueueStateRow>(QUEUE_NEW_SQL, [U, P, source, source]);

  it('due cards up to the block’s end, learning first, then by due time', async () => {
    const rows = await dueRows(null);
    expect(rows.map((r) => r.card_id)).toEqual([card(2), card(1)]);
    const candidate = dueCandidateFromRow(rows[0]);
    expect(candidate).toMatchObject({ cardId: card(2), state: 1, due: NOW + 5 * MIN, sourceId: S1, sourceTitle: 'Lecture 1', topicPosition: 0 });
    expect(candidate?.stateRow).toEqual({
      state: 1, due: iso(NOW + 5 * MIN), stability: 5, difficulty: 5, scheduled_days: 3, learning_steps: 0, reps: 3, lapses: 0,
      last_review: iso(NOW - 3 * 24 * 60 * MIN),
    });
    expect((await dueRows(S2)).map((r) => r.card_id)).toEqual([]);
    expect((await dueRows(S1, NOW_ISO)).map((r) => r.card_id)).toEqual([card(1)]);
  });

  it('new cards: newest source first, then outline order; suspended and draft cards never', async () => {
    const rows = await newRows(null);
    expect(rows.map((r) => r.card_id)).toEqual([card(7), card(5)]);
    expect(newCandidateFromRow(rows[0])).toMatchObject({ cardId: card(7), stateRow: null, sourceTitle: 'Notes week 2' });
    expect((await newRows(S1)).map((r) => r.card_id)).toEqual([]);
    await setCardSuspended(U, card(6), false, NOW);
    expect((await newRows(S2)).map((r) => r.card_id)).toEqual([card(6), card(7)]);
    expect(newCandidateFromRow((await newRows(S2))[0]).stateRow).toMatchObject({ state: 0 });
  });

  it('an answer moves a new card from the new list to the due list, and the block’s answers feed the queue', async () => {
    const reviewId = 'd0000000-0000-4000-8000-000000000002';
    const result = await answerCard({ reviewId, userId: U, cardId: card(7), blockId: BLOCK, grade: RATING.good, answerMode: 'self_graded', answeredAt: NOW, shownAt: NOW - 6000, fsrsParams: '{"enable_fuzz":false}' });
    expect(result?.next).toMatchObject({ state: 1, due: iso(NOW + 10 * MIN) });
    expect(db.transactions).toBe(1);
    expect(db.rows('reviews')).toEqual([
      expect.objectContaining({ id: reviewId, user_id: U, card_id: card(7), interval_block_id: BLOCK, rating: 3, answer_mode: 'self_graded', reviewed_at: NOW_ISO, duration_ms: 6000, prev_state: 0, elapsed_days: 0, state: 1 }),
    ]);
    expect(db.rows('card_states', `card_id = '${card(7)}'`)).toEqual([
      expect.objectContaining({ id: cardStateId(U, card(7)), state: 1, reps: 1, suspended: 0, last_review: NOW_ISO }),
    ]);
    expect((await newRows(null)).map((r) => r.card_id)).toEqual([card(5)]);
    expect((await dueRows(null)).map((r) => r.card_id)).toEqual([card(2), card(7), card(1)]);

    // The same review again changes nothing.
    await expect(answerCard({ reviewId, userId: U, cardId: card(7), blockId: BLOCK, grade: RATING.again, answerMode: 'self_graded', answeredAt: NOW + 1000, shownAt: null })).resolves.toBeNull();
    expect(db.rows('reviews')).toHaveLength(1);

    const answers = (await db.getAll<BlockAnswerRow>(BLOCK_ANSWERS_SQL, [BLOCK])).map(blockAnswerFromRow);
    expect(answers).toEqual([{ cardId: card(7), prevState: 0, rating: 3, reviewedAt: NOW, durationMs: 6000, sourceId: S2, topicId: T1 }]);
    expect((await db.get<{ n: number }>(NEW_TODAY_SQL, [U, iso(NOW - 60 * MIN)])).n).toBe(1);

    // The queue, fed from these rows, asks the review due now next (not the card just answered).
    const due = (await dueRows(null)).map(dueCandidateFromRow).filter((c) => c !== null);
    const fresh = (await newRows(null)).map(newCandidateFromRow);
    const next = nextItem({
      now: NOW + 1000, blockMs: 25 * MIN, remainingMs: 24 * MIN, due, fresh, blockAnswers: answers.filter((a) => a !== null),
      newToday: 1, settings: { newPerBlock: 5, dailyNewCap: 20 }, interleaveBy: 'source', prioritizeNew: false,
    });
    expect(next).toMatchObject({ type: 'card', card: { cardId: card(1), reason: 'review' } });
  });

  it('sums a study session’s answers', async () => {
    db.seed('interval_blocks', { id: BLOCK, user_id: U, study_session_id: SESSION, planned_minutes: 25 });
    for (const [i, [cardId, prev, rating]] of ([[card(1), 2, 3], [card(5), 0, 1], [card(5), 1, 3]] as const).entries()) {
      db.seed('reviews', { id: `r${i}`, user_id: U, card_id: cardId, interval_block_id: BLOCK, rating, prev_state: prev, reviewed_at: iso(NOW + i) });
    }
    expect(await db.get(SESSION_REVIEWS_SQL, [SESSION])).toEqual({ answered: 3, right_count: 2, new_count: 1 });
  });
});

describe('deletePlan', () => {
  it('removes the plan’s rows and the user’s sources no other plan uses', async () => {
    await expect(deletePlan(P, U)).resolves.toBe(true);
    expect(db.rows('study_plans').map((r) => r.id)).toEqual([P2]);
    expect(db.rows('topics')).toEqual([]);
    expect(db.rows('cards')).toEqual([]);
    expect(db.rows('plan_sources').map((r) => r.id)).toEqual(['ps4']);
    expect(db.rows('sources').map((r) => r.id)).toEqual([S3]); // still in the group plan
    expect(db.rows('source_files')).toEqual([]);
    expect(db.rows('card_states').length).toBe(7); // history stays; the server removes states of deleted cards
  });

  it('does nothing for a plan someone else owns', async () => {
    await expect(deletePlan(P2, U)).resolves.toBe(false);
    expect(db.rows('study_plans')).toHaveLength(2);
  });
});
