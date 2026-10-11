/**
 * The Phase 2 gate, on the phone's side: a cumulative plan (a course PDF and a page of handwritten
 * notes) studied in one 25-minute focus block a day for a week, offline. Each block reads its queue
 * from the phone's SQLite (the real SQL), asks what queue.ts picks, and records each answer with
 * answerCard (one local transaction: a review plus the card's FSRS state). Checked: new cards come in
 * at most 5 a block, every review due by the block's end is asked, due dates move forward as cards are
 * remembered, an Again brings a card back, every answer carries its block, and the daily reminder's
 * counts match what the next block then asks.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SqliteDb } from '../../history/testing/sqliteDb';
import { CARD_STATE, RATING, type StudyGrade } from '../fsrs';
import { endOfLocalDay, newPerBlockFor, nextItem, QUEUE_RULES } from '../queue';
import { answerCard, countDueCards, firstDueAfter, newCardsSince } from '../studyRepo';
import {
  BLOCK_ANSWERS_SQL,
  blockAnswerFromRow,
  dueCandidateFromRow,
  newCandidateFromRow,
  QUEUE_DUE_SQL,
  QUEUE_NEW_SQL,
  type BlockAnswerRow,
  type QueueStateRow,
} from '../studyQueries';

jest.mock('../../../db/database', () => ({
  db: jest.requireActual<typeof import('../../history/testing/sqliteDb')>('../../history/testing/sqliteDb').createSqliteDb(),
}));
const db = (jest.requireMock('../../../db/database') as { db: SqliteDb }).db;

const U = '11111111-1111-4111-8111-111111111111';
const PLAN = '90000000-0000-4000-8000-000000000001';
const PDF = 'a0000000-0000-4000-8000-000000000001';
const NOTES = 'a0000000-0000-4000-8000-000000000002';
const CELLS = 'b0000000-0000-4000-8000-000000000001';
const OSMOSIS = 'b0000000-0000-4000-8000-000000000002';
const DRAFT = 'b0000000-0000-4000-8000-000000000003';
const hex = (n: number) => n.toString(16).padStart(12, '0');
const card = (n: number) => `c0000000-0000-4000-8000-${hex(n)}`;
const blockOf = (day: number) => `e0000000-0000-4000-8000-${hex(day + 1)}`;
const reviewOf = (n: number) => `d0000000-0000-4000-8000-${hex(n)}`;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Day 0, 09:00 UTC. */
const START = Date.UTC(2026, 9, 12, 9, 0, 0);
const BLOCK_MS = 25 * MIN;
const ANSWER_MS = 20_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NO_FUZZ = '{"enable_fuzz":false}';
const PDF_CARDS = 12;
const NOTES_CARDS = 6;

function seed() {
  db.seed('study_plans', { id: PLAN, owner_id: U, title: 'Biology 101', scope: 'cumulative', goal: 'Pass', target_date: null, created_at: iso(START - DAY), updated_at: iso(START - DAY) });
  db.seed('sources', { id: PDF, owner_id: U, kind: 'pdf', title: 'Lecture 1', status: 'ready' });
  db.seed('sources', { id: NOTES, owner_id: U, kind: 'notes', title: 'Notes, 9 Oct', status: 'ready' });
  db.seed('plan_sources', { id: 'ps1', plan_id: PLAN, source_id: PDF, added_at: iso(START - DAY) });
  db.seed('plan_sources', { id: 'ps2', plan_id: PLAN, source_id: NOTES, added_at: iso(START - DAY / 2) });
  db.seed('topics', { id: CELLS, plan_id: PLAN, title: 'Cells', position: 0, status: 'ready', created_at: iso(START - DAY) });
  db.seed('topics', { id: OSMOSIS, plan_id: PLAN, title: 'Osmosis', position: 1, status: 'ready', created_at: iso(START - DAY) });
  db.seed('topics', { id: DRAFT, plan_id: PLAN, title: 'Not reviewed yet', position: 2, status: 'draft', created_at: iso(START - DAY) });
  for (let n = 1; n <= PDF_CARDS; n += 1) {
    db.seed('cards', { id: card(n), topic_id: CELLS, plan_id: PLAN, source_id: PDF, page: n, question: `Q${n}`, answer: `A${n}`, card_type: 'basic', created_at: iso(START - DAY + n) });
  }
  for (let n = PDF_CARDS + 1; n <= PDF_CARDS + NOTES_CARDS; n += 1) {
    // The notes continue "Cells" (folded into the existing topic) and add "Osmosis".
    const topic = n % 2 === 0 ? CELLS : OSMOSIS;
    db.seed('cards', { id: card(n), topic_id: topic, plan_id: PLAN, source_id: NOTES, page: 1, question: `Q${n}`, answer: `A${n}`, card_type: 'basic', created_at: iso(START - DAY / 2 + n) });
  }
  // A card of a draft topic (its outline isn't reviewed yet): never asked.
  db.seed('cards', { id: card(99), topic_id: DRAFT, plan_id: PLAN, source_id: NOTES, page: 2, question: 'Q99', answer: 'A99', card_type: 'basic', created_at: iso(START) });
}

/** The card forgotten once: first seen on day 0, answered Again when it comes back on day 2. */
const FORGOTTEN = card(14);
/** The grade the person gives: the forgotten card's first answer on day 2 is Again, everything else Good. */
function gradeFor(cardId: string, day: number, alreadyToday: number): StudyGrade {
  return cardId === FORGOTTEN && day === 2 && alreadyToday === 0 ? RATING.again : RATING.good;
}

let reviewSeq = 0;

type BlockLog = { day: number; asked: { cardId: string; reason: string }[]; newCards: number };

/** One 25-minute focus block on `day`, starting at 09:00, answering whatever the queue asks. */
async function studyBlock(day: number): Promise<BlockLog> {
  const blockId = blockOf(day);
  const start = START + day * DAY;
  const end = start + BLOCK_MS;
  const startOfDay = start - 9 * 60 * MIN;
  const asked: BlockLog['asked'] = [];
  let now = start;
  for (let guard = 0; guard < 400 && now < end; guard += 1) {
    // As useStudyQueue reads it: reviews are due by their day, learning steps by their minute.
    const until = iso(Math.max(end, endOfLocalDay(now)));
    const due = (await db.getAll<QueueStateRow>(QUEUE_DUE_SQL, [U, PLAN, null, null, until])).map(dueCandidateFromRow).filter((c) => c !== null);
    const fresh = (await db.getAll<QueueStateRow>(QUEUE_NEW_SQL, [U, PLAN, null, null])).map(newCandidateFromRow);
    const blockAnswers = (await db.getAll<BlockAnswerRow>(BLOCK_ANSWERS_SQL, [blockId])).map(blockAnswerFromRow).filter((a) => a !== null);
    const next = nextItem({
      now,
      blockMs: BLOCK_MS,
      remainingMs: end - now,
      due,
      fresh,
      blockAnswers,
      newToday: await newCardsSince(U, startOfDay),
      settings: { newPerBlock: newPerBlockFor(25), dailyNewCap: QUEUE_RULES.dailyNewCap },
      interleaveBy: 'source',
      prioritizeNew: false,
      reviewDueBy: endOfLocalDay(now),
    });
    if (next.type === 'done') break;
    if (next.type === 'wait') {
      now = Math.max(now + 1000, next.until);
      continue;
    }
    asked.push({ cardId: next.card.cardId, reason: next.card.reason });
    reviewSeq += 1;
    const result = await answerCard({
      reviewId: reviewOf(reviewSeq),
      userId: U,
      cardId: next.card.cardId,
      blockId,
      grade: gradeFor(next.card.cardId, day, asked.filter((a) => a.cardId === next.card.cardId).length - 1),
      answerMode: 'self_graded',
      answeredAt: now + ANSWER_MS,
      shownAt: now,
      fsrsParams: NO_FUZZ,
    });
    expect(result).not.toBeNull();
    now += ANSWER_MS;
  }
  return { day, asked, newCards: asked.filter((a) => a.reason === 'new').length };
}

type StateRow = { card_id: string; state: number; due: string; reps: number; lapses: number; last_review: string | null; scheduled_days: number };
const states = () => new Map(db.rows('card_states').map((r) => [r.card_id as string, r as unknown as StateRow]));

beforeEach(() => {
  db.reset();
  reviewSeq = 0;
  seed();
});

describe('a week of reviews (the Phase 2 gate)', () => {
  it('introduces new cards gradually, asks every due review, and spaces remembered cards further apart', async () => {
    const logs: BlockLog[] = [];
    const remindedDue: number[] = [];
    const history = new Map<string, number[]>(); // card -> its due times after each day's block
    for (let day = 0; day < 7; day += 1) {
      // The 09:00 reminder (before the block): the cards due that day, as rescheduleReviewReminder counts them.
      remindedDue.push(await countDueCards(U, endOfLocalDay(START + day * DAY)));
      const log = await studyBlock(day);
      logs.push(log);
      for (const [id, s] of states()) history.set(id, [...(history.get(id) ?? []), Date.parse(s.due)]);

      const blockEnd = START + day * DAY + BLOCK_MS;
      // After the block no review due today is left unasked (a short queue fits in the block).
      const leftToday = [...states().values()].filter((st) => st.state === CARD_STATE.review && Date.parse(st.due) <= endOfLocalDay(blockEnd));
      expect(leftToday).toEqual([]);
    }

    // New cards: at most 5 a block, the newest source (the notes) first.
    for (const log of logs) expect(log.newCards).toBeLessThanOrEqual(5);
    expect(logs[0].newCards).toBe(5);
    // Newest source first (the notes), in outline order: the notes' "Cells" cards, then "Osmosis".
    const notesCards = Array.from({ length: NOTES_CARDS }, (_, i) => card(PDF_CARDS + 1 + i));
    const firstNew = logs[0].asked.filter((a) => a.reason === 'new').map((a) => a.cardId);
    expect(firstNew.every((id) => notesCards.includes(id))).toBe(true);
    expect(firstNew.slice(0, 3)).toEqual([card(14), card(16), card(18)]);
    const introduced = logs.reduce((sum, log) => sum + log.newCards, 0);
    expect(introduced).toBe(Math.min(PDF_CARDS + NOTES_CARDS, 5 * 7));

    // The reminder: nothing is due before the first block; afterwards it counts the reviews the next
    // block then asks (learning steps from yesterday and due reviews).
    expect(remindedDue[0]).toBe(0);
    for (let day = 1; day < 7; day += 1) {
      const reviewsAsked = new Set(logs[day].asked.filter((a) => a.reason === 'review' || a.reason === 'learning').map((a) => a.cardId));
      expect(reviewsAsked.size).toBeGreaterThanOrEqual(remindedDue[day]);
    }
    expect(remindedDue.slice(1).some((n) => n > 0)).toBe(true);

    // Never a card of a draft topic.
    expect(db.rows('reviews').some((r) => r.card_id === card(99))).toBe(false);

    // Every answer carries the block it was given in, and each card's reps = its reviews.
    const reviews = db.rows('reviews');
    for (const r of reviews) {
      const day = Math.floor((Date.parse(r.reviewed_at as string) - START) / DAY);
      expect(r.interval_block_id).toBe(blockOf(day));
    }
    for (const [id, s] of states()) {
      expect(s.reps).toBe(reviews.filter((r) => r.card_id === id).length);
    }

    // Remembered cards: once in review, each later answer pushes the due date further out.
    const remembered = [...states().values()].filter((s) => s.card_id !== FORGOTTEN && s.state === CARD_STATE.review);
    expect(remembered.length).toBeGreaterThan(5);
    for (const s of remembered) {
      const times = history.get(s.card_id) ?? [];
      for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
    const intervals = reviews
      .filter((r) => r.card_id === card(PDF_CARDS + 1) && r.state === CARD_STATE.review)
      .map((r) => Number(r.scheduled_days));
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < intervals.length; i += 1) expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);

    // The forgotten card (Again on day 2) lapsed once, was asked again in the same block, and comes back
    // sooner than the cards remembered alongside it.
    const forgotten = states().get(FORGOTTEN);
    expect(forgotten?.lapses).toBe(1);
    expect(logs[2].asked.filter((a) => a.cardId === FORGOTTEN).length).toBeGreaterThanOrEqual(2);
    const sameDayCards = logs[0].asked.filter((a) => a.reason === 'new' && a.cardId !== FORGOTTEN).map((a) => a.cardId);
    for (const id of sameDayCards) {
      expect(Date.parse(forgotten?.due ?? '')).toBeLessThan(Date.parse(states().get(id)?.due ?? ''));
    }

    // After the week the reminder knows when the next card falls due.
    const lastBlockEnd = START + 6 * DAY + BLOCK_MS;
    const next = await firstDueAfter(U, lastBlockEnd);
    expect(next).not.toBeNull();
    expect(next as number).toBeGreaterThan(lastBlockEnd);
  });
});
