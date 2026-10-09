/**
 * The study engine's local writes (and the few one-off reads the reminder needs).
 *
 * - All local: each write is one PowerSync write transaction on the phone's SQLite database, so it
 *   works offline; PowerSync uploads the rows later. Nothing here calls Supabase. (Adding material,
 *   confirming transcripts and approving an outline start AI work and go through the online `study`
 *   function instead: see studyApi.ts and upload.ts.)
 * - Idempotent where it matters: ids are made before the write (newId()), an INSERT is skipped when a
 *   row with that id already exists, and an answer whose review id is already stored writes nothing.
 * - Columns and values follow the write policies in src/db/tables.ts and the CHECK constraints:
 *   timestamps are ISO strings with milliseconds, booleans 0/1, created_at/updated_at set on INSERT
 *   (updated_at on UPDATE too; the server overwrites it). Values a CHECK would refuse are refused here
 *   first (RangeError), so a bad write never reaches the upload queue.
 * - PowerSync's tables are views, so "upsert" is a SELECT, then UPDATE or INSERT, in one transaction
 *   (the same pattern as localState.ts).
 */
import { TABLE } from '@/db/constants';
import { db } from '@/db/database';
import { isoTimestamp } from '@/lib/time';

import { scheduleAnswer, schedulerFor, type CardStateColumns, type FsrsStateRow, type StudyGrade } from './fsrs';
import { DUE_COUNT_SQL, FIRST_DUE_AFTER_SQL, NEW_TODAY_SQL, type PlanScope } from './studyQueries';
import { cardStateId, isUuid } from './uuidv5';

const T = TABLE;

export const STUDY_LIMITS = {
  planTitle: 200,
  planGoal: 1000,
  /** The study function's limit for outline titles; hand-made topics follow it too. */
  topicTitle: 120,
  /** Tracy's card builder limits; hand-made cards follow them too. */
  question: 500,
  answer: 1000,
  linkNote: 200,
  /** The study function's limit (confirm_transcripts). */
  transcript: 20_000,
  /** reviews.duration_ms is capped at 10 minutes: a card left open longer says nothing about recall. */
  maxDurationMs: 600_000,
} as const;

export const CARD_TYPES = ['basic', 'cloze', 'why', 'write_from_memory'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const LINK_RELATIONS = ['related', 'why', 'analogy', 'prerequisite', 'contrast'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export type AnswerMode = 'self_graded' | 'typed';

function requireId(name: string, value: unknown): string {
  if (!isUuid(value)) throw new RangeError(`${name} must be a UUID, got ${String(value)}`);
  return value.toLowerCase();
}

/** Trimmed text of 1..max characters (or 0..max when `allowEmpty`). */
function text(name: string, value: unknown, max: number, allowEmpty = false): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!allowEmpty && trimmed === '') throw new RangeError(`${name} must not be empty`);
  if (trimmed.length > max) throw new RangeError(`${name} must be at most ${max} characters`);
  return trimmed;
}

/** A real calendar date 'YYYY-MM-DD', or null. */
export function validDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new RangeError(`Not a date: ${String(value)}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Not a date: ${value}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`Not a date: ${value}`);
  }
  return value;
}

function scope(value: unknown): PlanScope {
  if (value !== 'single' && value !== 'cumulative') throw new RangeError(`scope must be single or cumulative, got ${String(value)}`);
  return value;
}

// ------------------------------------------------------------------------------------------------
// Answering a card
// ------------------------------------------------------------------------------------------------

export type AnswerInput = {
  /** reviews.id, made when the card was shown, so a retried write is recognised. */
  reviewId: string;
  userId: string;
  cardId: string;
  /** The running focus block (interval_blocks.id), or null outside one. */
  blockId: string | null;
  grade: StudyGrade;
  answerMode: AnswerMode;
  /** When the answer was given (epoch ms). */
  answeredAt: number;
  /** When the card was shown (epoch ms), or null when unknown. */
  shownAt: number | null;
  /** profiles.fsrs_params (JSON text or value); null = DualRep's defaults. */
  fsrsParams?: unknown;
};

export type AnswerResult = {
  reviewedAt: number;
  prevState: number;
  next: CardStateColumns;
};

/** reviews.duration_ms: shown → answered, capped at 10 minutes; null when unknown or the clock went back. */
export function durationMs(shownAt: number | null, answeredAt: number): number | null {
  if (shownAt === null || !Number.isFinite(shownAt) || !Number.isFinite(answeredAt)) return null;
  const ms = Math.round(answeredAt - shownAt);
  if (ms < 0) return null;
  return Math.min(ms, STUDY_LIMITS.maxDurationMs);
}

type StoredState = FsrsStateRow & { id: string };

/**
 * Records one answer, atomically (Phase 2 decision 9): INSERT the review, then UPDATE the card's
 * card_states row (or INSERT it, with the derived UUIDv5 id, the first time). The review time is
 * clamped to the card's last review (fsrs.ts). A review id that is already stored writes nothing and
 * resolves to null, so a retried tap or a write repeated after a crash never answers twice.
 *
 * Uploads: the review is an insert-ignore PUT; the state a PUT (first answer) or a PATCH that sends
 * the whole FSRS state (patchTogether in tables.ts), so the server's stale-write guard keeps or skips
 * a whole state and two offline phones never leave a mix of both.
 */
export async function answerCard(input: AnswerInput): Promise<AnswerResult | null> {
  const reviewId = requireId('reviewId', input.reviewId);
  const userId = requireId('userId', input.userId);
  const cardId = requireId('cardId', input.cardId);
  const blockId = input.blockId === null ? null : requireId('blockId', input.blockId);
  if (input.answerMode !== 'self_graded' && input.answerMode !== 'typed') {
    throw new RangeError(`Unknown answer mode: ${String(input.answerMode)}`);
  }
  const stateId = cardStateId(userId, cardId);
  const scheduler = schedulerFor(input.fsrsParams ?? null);
  return db.writeTransaction(async (tx) => {
    const replay = await tx.getOptional<{ id: string }>(`SELECT id FROM ${T.reviews} WHERE id = ?`, [reviewId]);
    if (replay) return null;
    const row = await tx.getOptional<StoredState>(
      `SELECT id, state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review FROM ${T.card_states} WHERE id = ?`,
      [stateId],
    );
    const outcome = scheduleAnswer(row, input.answeredAt, input.grade, scheduler);
    const at = isoTimestamp(outcome.reviewedAt);
    const next = outcome.next;
    await tx.execute(
      `INSERT INTO ${T.reviews} (id, user_id, card_id, interval_block_id, rating, answer_mode, reviewed_at, duration_ms, prev_state, elapsed_days, state, due_at, stability, difficulty, scheduled_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reviewId,
        userId,
        cardId,
        blockId,
        input.grade,
        input.answerMode,
        at,
        durationMs(input.shownAt, input.answeredAt),
        outcome.prevState,
        outcome.elapsedDays,
        next.state,
        next.due,
        next.stability,
        next.difficulty,
        next.scheduled_days,
        at,
        at,
      ],
    );
    const values = [
      next.state,
      next.due,
      next.stability,
      next.difficulty,
      next.scheduled_days,
      next.learning_steps,
      next.reps,
      next.lapses,
      next.last_review,
    ];
    if (row) {
      await tx.execute(
        `UPDATE ${T.card_states} SET state = ?, due = ?, stability = ?, difficulty = ?, scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, last_review = ?, updated_at = ? WHERE id = ?`,
        [...values, at, stateId],
      );
    } else {
      await tx.execute(
        `INSERT INTO ${T.card_states} (id, user_id, card_id, state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review, suspended, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stateId, userId, cardId, ...values, 0, at, at],
      );
    }
    return { reviewedAt: outcome.reviewedAt, prevState: outcome.prevState, next };
  });
}

/**
 * Suspends a card (it is never asked) or brings it back. A card never studied gets an empty New
 * state with suspended = 1 (the derived id), so the switch syncs to the user's other phones.
 */
export async function setCardSuspended(userId: string, cardId: string, suspended: boolean, nowMs: number = Date.now()): Promise<void> {
  const user = requireId('userId', userId);
  const card = requireId('cardId', cardId);
  const id = cardStateId(user, card);
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    const row = await tx.getOptional<{ id: string }>(`SELECT id FROM ${T.card_states} WHERE id = ?`, [id]);
    if (row) {
      await tx.execute(`UPDATE ${T.card_states} SET suspended = ?, updated_at = ? WHERE id = ?`, [suspended ? 1 : 0, at, id]);
    } else if (suspended) {
      await tx.execute(
        `INSERT INTO ${T.card_states} (id, user_id, card_id, state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, last_review, suspended, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, NULL, 1, ?, ?)`,
        [id, user, card, at, at, at],
      );
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Plans
// ------------------------------------------------------------------------------------------------

export type NewPlanInput = {
  id: string;
  ownerId: string;
  title: string;
  scope: PlanScope;
  goal?: string;
  /** 'YYYY-MM-DD' or null. */
  targetDate?: string | null;
  createdAt: number;
};

/** Creates a study plan on this phone (offline is fine). */
export async function createPlan(input: NewPlanInput): Promise<void> {
  const id = requireId('id', input.id);
  const ownerId = requireId('ownerId', input.ownerId);
  const title = text('title', input.title, STUDY_LIMITS.planTitle);
  const goal = text('goal', input.goal ?? '', STUDY_LIMITS.planGoal, true);
  const targetDate = validDate(input.targetDate ?? null);
  const planScope = scope(input.scope);
  const at = isoTimestamp(input.createdAt);
  await db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional(`SELECT id FROM ${T.study_plans} WHERE id = ?`, [id]);
    if (existing) return;
    await tx.execute(
      `INSERT INTO ${T.study_plans} (id, owner_id, title, scope, goal, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ownerId, title, planScope, goal, targetDate, at, at],
    );
  });
}

export type PlanPatch = {
  title?: string;
  scope?: PlanScope;
  goal?: string;
  targetDate?: string | null;
};

/**
 * Changes a plan (only the keys present). Switching scope never touches card_states: progress is
 * kept. Resolves to false when the plan is not on the phone. Throws when the patch is empty.
 */
export async function updatePlan(planId: string, patch: PlanPatch, nowMs: number = Date.now()): Promise<boolean> {
  const id = requireId('planId', planId);
  const columns: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    columns.push('title');
    params.push(text('title', patch.title, STUDY_LIMITS.planTitle));
  }
  if (patch.scope !== undefined) {
    columns.push('scope');
    params.push(scope(patch.scope));
  }
  if (patch.goal !== undefined) {
    columns.push('goal');
    params.push(text('goal', patch.goal, STUDY_LIMITS.planGoal, true));
  }
  if (patch.targetDate !== undefined) {
    columns.push('target_date');
    params.push(validDate(patch.targetDate));
  }
  if (columns.length === 0) throw new RangeError('Nothing to update');
  const at = isoTimestamp(nowMs);
  const assignments = [...columns, 'updated_at'].map((column) => `${column} = ?`).join(', ');
  return db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional(`SELECT id FROM ${T.study_plans} WHERE id = ?`, [id]);
    if (!existing) return false;
    await tx.execute(`UPDATE ${T.study_plans} SET ${assignments} WHERE id = ?`, [...params, at, id]);
    return true;
  });
}

/**
 * Deletes a plan and, on this phone, everything that hangs off it: the server cascades the same
 * rows, but local views do not, so they are deleted here too and the screens update at once. The
 * user's own sources that no other plan uses go with it (their files are swept from Storage later).
 * Answers (reviews) and card states stay: they are the user's history, and the server removes the
 * states of deleted cards itself. Only the owner can delete a plan: resolves to false (and deletes
 * nothing) for anyone else, or when the plan is not on the phone.
 */
export async function deletePlan(planId: string, userId: string): Promise<boolean> {
  const id = requireId('planId', planId);
  const user = requireId('userId', userId);
  return db.writeTransaction(async (tx) => {
    const plan = await tx.getOptional<{ owner_id: string | null }>(`SELECT owner_id FROM ${T.study_plans} WHERE id = ?`, [id]);
    if (!plan || plan.owner_id !== user) return false;
    const orphanSources = `SELECT ps.source_id FROM ${T.plan_sources} ps
      JOIN ${T.sources} src ON src.id = ps.source_id
      WHERE ps.plan_id = ? AND src.owner_id = ?
        AND NOT EXISTS (SELECT 1 FROM ${T.plan_sources} other WHERE other.source_id = ps.source_id AND other.plan_id <> ?)`;
    const sources = await tx.getAll<{ source_id: string }>(orphanSources, [id, user, id]);
    await tx.execute(`DELETE FROM ${T.card_links} WHERE plan_id = ?`, [id]);
    await tx.execute(`DELETE FROM ${T.cards} WHERE plan_id = ?`, [id]);
    await tx.execute(`DELETE FROM ${T.topics} WHERE plan_id = ?`, [id]);
    await tx.execute(`DELETE FROM ${T.plan_sources} WHERE plan_id = ?`, [id]);
    for (const { source_id } of sources) {
      await tx.execute(`DELETE FROM ${T.source_files} WHERE source_id = ?`, [source_id]);
      await tx.execute(`DELETE FROM ${T.sources} WHERE id = ?`, [source_id]);
    }
    await tx.execute(`DELETE FROM ${T.study_plans} WHERE id = ?`, [id]);
    return true;
  });
}

// ------------------------------------------------------------------------------------------------
// Transcripts (edited offline; confirmed online through the study function)
// ------------------------------------------------------------------------------------------------

/** Saves the user's edit of a photo's transcript on this phone (not yet confirmed). */
export async function saveTranscript(fileId: string, transcript: string, nowMs: number = Date.now()): Promise<void> {
  const id = requireId('fileId', fileId);
  if (typeof transcript !== 'string') throw new RangeError('transcript must be text');
  if (transcript.length > STUDY_LIMITS.transcript) throw new RangeError(`transcript must be at most ${STUDY_LIMITS.transcript} characters`);
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${T.source_files} SET transcript = ?, updated_at = ? WHERE id = ?`, [transcript, at, id]);
  });
}

/**
 * Marks transcripts confirmed on this phone, after the study function accepted them (it writes the
 * same values on the server), so the screen moves on before the next sync.
 */
export async function markTranscriptsConfirmed(
  files: readonly { id: string; transcript: string }[],
  nowMs: number = Date.now(),
): Promise<void> {
  const checked = files.map((file) => ({ id: requireId('fileId', file.id), transcript: String(file.transcript ?? '') }));
  if (checked.length === 0) return;
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    for (const file of checked) {
      await tx.execute(`UPDATE ${T.source_files} SET transcript = ?, confirmed = ?, updated_at = ? WHERE id = ?`, [
        file.transcript,
        1,
        at,
        file.id,
      ]);
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Topics, cards and links made by hand (the plan's owner)
// ------------------------------------------------------------------------------------------------

export type NewTopicInput = { id: string; planId: string; title: string; position: number; createdAt: number };

/** A topic made by hand: ready at once. */
export async function createTopic(input: NewTopicInput): Promise<void> {
  const id = requireId('id', input.id);
  const planId = requireId('planId', input.planId);
  const title = text('title', input.title, STUDY_LIMITS.topicTitle);
  if (!Number.isInteger(input.position)) throw new RangeError(`position must be a whole number, got ${input.position}`);
  const at = isoTimestamp(input.createdAt);
  await db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional(`SELECT id FROM ${T.topics} WHERE id = ?`, [id]);
    if (existing) return;
    await tx.execute(
      `INSERT INTO ${T.topics} (id, plan_id, title, position, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, planId, title, input.position, 'ready', at, at],
    );
  });
}

export async function renameTopic(topicId: string, title: string, nowMs: number = Date.now()): Promise<void> {
  const id = requireId('topicId', topicId);
  const name = text('title', title, STUDY_LIMITS.topicTitle);
  const at = isoTimestamp(nowMs);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${T.topics} SET title = ?, updated_at = ? WHERE id = ?`, [name, at, id]);
  });
}

export type NewCardInput = {
  id: string;
  topicId: string;
  question: string;
  answer: string;
  cardType?: CardType;
  createdAt: number;
};

function cardType(value: unknown): CardType {
  if (!CARD_TYPES.includes(value as CardType)) throw new RangeError(`Unknown card type: ${String(value)}`);
  return value as CardType;
}

/**
 * A card made by hand. Its plan is the topic's (the server copies it from the topic again); it has
 * no source (cards.source_id is server-derived and never sent). Resolves to false when the topic is
 * not on the phone.
 */
export async function createCard(input: NewCardInput): Promise<boolean> {
  const id = requireId('id', input.id);
  const topicId = requireId('topicId', input.topicId);
  const question = text('question', input.question, STUDY_LIMITS.question);
  const answer = text('answer', input.answer, STUDY_LIMITS.answer);
  const type = cardType(input.cardType ?? 'basic');
  const at = isoTimestamp(input.createdAt);
  return db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional(`SELECT id FROM ${T.cards} WHERE id = ?`, [id]);
    if (existing) return true;
    const topic = await tx.getOptional<{ plan_id: string }>(`SELECT plan_id FROM ${T.topics} WHERE id = ?`, [topicId]);
    if (!topic) return false;
    await tx.execute(
      `INSERT INTO ${T.cards} (id, topic_id, plan_id, question, answer, card_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, topicId, topic.plan_id, question, answer, type, at, at],
    );
    return true;
  });
}

export type CardPatch = { question?: string; answer?: string; cardType?: CardType };

export async function updateCard(cardId: string, patch: CardPatch, nowMs: number = Date.now()): Promise<void> {
  const id = requireId('cardId', cardId);
  const columns: string[] = [];
  const params: unknown[] = [];
  if (patch.question !== undefined) {
    columns.push('question');
    params.push(text('question', patch.question, STUDY_LIMITS.question));
  }
  if (patch.answer !== undefined) {
    columns.push('answer');
    params.push(text('answer', patch.answer, STUDY_LIMITS.answer));
  }
  if (patch.cardType !== undefined) {
    columns.push('card_type');
    params.push(cardType(patch.cardType));
  }
  if (columns.length === 0) throw new RangeError('Nothing to update');
  const at = isoTimestamp(nowMs);
  const assignments = [...columns, 'updated_at'].map((column) => `${column} = ?`).join(', ');
  await db.writeTransaction(async (tx) => {
    await tx.execute(`UPDATE ${T.cards} SET ${assignments} WHERE id = ?`, [...params, at, id]);
  });
}

/** Deletes a card and its links on this phone (the server cascades both, and the card's states). */
export async function deleteCard(cardId: string): Promise<void> {
  const id = requireId('cardId', cardId);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`DELETE FROM ${T.card_links} WHERE from_card_id = ? OR to_card_id = ?`, [id, id]);
    await tx.execute(`DELETE FROM ${T.cards} WHERE id = ?`, [id]);
  });
}

export type NewLinkInput = {
  id: string;
  fromCardId: string;
  toCardId: string;
  /** The user making it: card_links.created_by is sent by the phone (a PUT sends the whole row). */
  createdBy: string;
  relation?: LinkRelation;
  note?: string | null;
  createdAt: number;
};

/**
 * Links two cards (the concept map). Its plan is the from-card's (the server copies it again).
 * Resolves to false when the from-card is not on the phone.
 */
export async function createCardLink(input: NewLinkInput): Promise<boolean> {
  const id = requireId('id', input.id);
  const from = requireId('fromCardId', input.fromCardId);
  const to = requireId('toCardId', input.toCardId);
  const createdBy = requireId('createdBy', input.createdBy);
  if (from === to) throw new RangeError('A card cannot be linked to itself');
  const relation = input.relation ?? 'related';
  if (!LINK_RELATIONS.includes(relation)) throw new RangeError(`Unknown relation: ${String(relation)}`);
  const note = input.note == null ? null : text('note', input.note, STUDY_LIMITS.linkNote, true) || null;
  const at = isoTimestamp(input.createdAt);
  return db.writeTransaction(async (tx) => {
    const existing = await tx.getOptional(`SELECT id FROM ${T.card_links} WHERE id = ?`, [id]);
    if (existing) return true;
    const card = await tx.getOptional<{ plan_id: string }>(`SELECT plan_id FROM ${T.cards} WHERE id = ?`, [from]);
    if (!card) return false;
    await tx.execute(
      `INSERT INTO ${T.card_links} (id, from_card_id, to_card_id, plan_id, created_by, relation, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, from, to, card.plan_id, createdBy, relation, note, at, at],
    );
    return true;
  });
}

export async function deleteCardLink(linkId: string): Promise<void> {
  const id = requireId('linkId', linkId);
  await db.writeTransaction(async (tx) => {
    await tx.execute(`DELETE FROM ${T.card_links} WHERE id = ?`, [id]);
  });
}

// ------------------------------------------------------------------------------------------------
// One-off reads (the reminder; hooks use the same SQL live)
// ------------------------------------------------------------------------------------------------

/** Cards due by `untilMs`, across every plan (the reminder's "N cards are due"). */
export async function countDueCards(userId: string, untilMs: number): Promise<number> {
  const row = await db.getOptional<{ n: number }>(DUE_COUNT_SQL, [userId, isoTimestamp(untilMs)]);
  return Number(row?.n ?? 0);
}

/** The first time after `afterMs` a card falls due (epoch ms), or null when none will. */
export async function firstDueAfter(userId: string, afterMs: number): Promise<number | null> {
  const row = await db.getOptional<{ due: string | null }>(FIRST_DUE_AFTER_SQL, [userId, isoTimestamp(afterMs)]);
  const ms = row?.due ? Date.parse(row.due) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** New cards introduced since `sinceMs` (the start of the local day: the daily cap). */
export async function newCardsSince(userId: string, sinceMs: number): Promise<number> {
  const row = await db.getOptional<{ n: number }>(NEW_TODAY_SQL, [userId, isoTimestamp(sinceMs)]);
  return Number(row?.n ?? 0);
}
