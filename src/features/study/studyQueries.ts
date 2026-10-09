/**
 * The study screens' reads: SQL on the phone's database and the pure shaping of its rows. Everything
 * here works offline (it reads what PowerSync has synced and what this phone wrote).
 *
 * Rules every query follows:
 * - A card counts only when its topic is not a draft (`COALESCE(t.status, 'ready') <> 'draft'`): draft
 *   topics wait for the outline review and have no cards yet; a topic row that has not synced (or a
 *   topic from before topics.status existed) counts as ready. Confirmed topics count, so a topic left
 *   'confirmed' by a slow worker never hides cards that exist.
 * - card_states rows count only for cards on the phone (JOIN cards): a state of a card that was
 *   deleted or left the phone with a group is ignored.
 * - A state row still in state 0 (New), e.g. made by suspending a card never studied, is a new card,
 *   not a due one. Suspended cards are never asked.
 * - Timestamps are ISO text with milliseconds, so text comparison is time comparison.
 * - Parameters are positional (`?`) and repeated where a value is used twice.
 */
import { TABLE } from '@/db/constants';

import type { FsrsStateRow } from './fsrs';
import { parseIso } from './fsrs';
import type { BlockAnswer, DueCandidate, NewCandidate, StudyCard } from './queue';

const T = TABLE;

/** A card's topic is not a draft (see the header). Needs `t` joined (LEFT JOIN is fine). */
const NOT_DRAFT = `COALESCE(t.status, 'ready') <> 'draft'`;
/** An unsuspended state row that has been answered. Needs `s`. */
const ANSWERED = `COALESCE(s.suspended, 0) = 0 AND s.state <> 0`;

// ------------------------------------------------------------------------------------------------
// Plans
// ------------------------------------------------------------------------------------------------

export type PlanRow = {
  id: string;
  owner_id: string | null;
  group_id: string | null;
  title: string | null;
  scope: string | null;
  goal: string | null;
  target_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  source_count: number | null;
  card_count: number | null;
  due_count: number | null;
  new_count: number | null;
};

function plansSql(where: string): string {
  return `SELECT p.id, p.owner_id, p.group_id, p.title, p.scope, p.goal, p.target_date, p.created_at, p.updated_at,
  (SELECT COUNT(*) FROM ${T.plan_sources} ps WHERE ps.plan_id = p.id) AS source_count,
  (SELECT COUNT(*) FROM ${T.cards} c LEFT JOIN ${T.topics} t ON t.id = c.topic_id
     WHERE c.plan_id = p.id AND ${NOT_DRAFT}) AS card_count,
  (SELECT COUNT(*) FROM ${T.card_states} s JOIN ${T.cards} c ON c.id = s.card_id LEFT JOIN ${T.topics} t ON t.id = c.topic_id
     WHERE c.plan_id = p.id AND s.user_id = ? AND ${ANSWERED} AND s.due <= ? AND ${NOT_DRAFT}) AS due_count,
  (SELECT COUNT(*) FROM ${T.cards} c LEFT JOIN ${T.topics} t ON t.id = c.topic_id
     LEFT JOIN ${T.card_states} s ON s.card_id = c.id AND s.user_id = ?
     WHERE c.plan_id = p.id AND ${NOT_DRAFT} AND (s.id IS NULL OR (s.state = 0 AND COALESCE(s.suspended, 0) = 0))) AS new_count
FROM ${T.study_plans} p${where}
ORDER BY p.updated_at DESC, p.id`;
}

/** Params: user id, now (ISO), user id. Every plan on the phone (own and group), newest change first. */
export const PLANS_SQL = plansSql('');

/** Params: user id, now (ISO), user id, plan id. The same columns for one plan. */
export const PLAN_SQL = plansSql('\nWHERE p.id = ?');

export type PlanScope = 'single' | 'cumulative';

export type StudyPlan = {
  id: string;
  ownerId: string | null;
  groupId: string | null;
  title: string;
  scope: PlanScope;
  goal: string;
  /** 'YYYY-MM-DD' or null. */
  targetDate: string | null;
  sourceCount: number;
  cardCount: number;
  /** Cards due now (answered before, not suspended). */
  dueCount: number;
  /** Cards never answered. */
  newCount: number;
  /** True when the signed-in user owns it (may edit, add material, change cards). */
  isOwner: boolean;
};

const count = (value: number | null | undefined) => (typeof value === 'number' && value > 0 ? Math.floor(value) : 0);

export function planFromRow(row: PlanRow, userId: string | null): StudyPlan {
  return {
    id: row.id,
    ownerId: row.owner_id,
    groupId: row.group_id,
    title: row.title ?? '',
    scope: row.scope === 'cumulative' ? 'cumulative' : 'single',
    goal: row.goal ?? '',
    targetDate: typeof row.target_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.target_date) ? row.target_date.slice(0, 10) : null,
    sourceCount: count(row.source_count),
    cardCount: count(row.card_count),
    dueCount: count(row.due_count),
    newCount: count(row.new_count),
    isOwner: userId !== null && row.owner_id === userId,
  };
}

// ------------------------------------------------------------------------------------------------
// A plan's sources, their files and jobs (for the per-source progress)
// ------------------------------------------------------------------------------------------------

export type PlanSourceRow = {
  plan_source_id: string;
  source_id: string;
  added_at: string | null;
  title: string | null;
  kind: string | null;
  url: string | null;
  status: string | null;
  owner_id: string | null;
  card_count: number | null;
};

/** Params: plan id. Newest first. A source row not on the phone (a group mate's) has null fields. */
export const PLAN_SOURCES_SQL = `SELECT ps.id AS plan_source_id, ps.source_id, ps.added_at, src.title, src.kind, src.url, src.status, src.owner_id,
  (SELECT COUNT(*) FROM ${T.cards} c WHERE c.plan_id = ps.plan_id AND c.source_id = ps.source_id) AS card_count
FROM ${T.plan_sources} ps
LEFT JOIN ${T.sources} src ON src.id = ps.source_id
WHERE ps.plan_id = ?
ORDER BY ps.added_at DESC, ps.id`;

export type SourceFileRow = {
  id: string;
  source_id: string;
  storage_path: string | null;
  page: number | null;
  transcript: string | null;
  confirmed: number | null;
};

/** Params: plan id. The files of the plan's sources, in page order. */
export const PLAN_SOURCE_FILES_SQL = `SELECT f.id, f.source_id, f.storage_path, f.page, f.transcript, f.confirmed
FROM ${T.source_files} f
WHERE f.source_id IN (SELECT ps.source_id FROM ${T.plan_sources} ps WHERE ps.plan_id = ?)
ORDER BY f.source_id, f.page, f.created_at, f.id`;

/** Params: source id. One source's files, in page order. */
export const SOURCE_FILES_SQL = `SELECT f.id, f.source_id, f.storage_path, f.page, f.transcript, f.confirmed
FROM ${T.source_files} f
WHERE f.source_id = ?
ORDER BY f.page, f.created_at, f.id`;

export type JobRow = {
  id: string;
  job: string | null;
  stage: string | null;
  status: string | null;
  error: string | null;
  plan_id: string | null;
  source_id: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** Params: plan id, plan id. The pipeline jobs of the plan and of its sources, oldest first. */
export const PLAN_JOBS_SQL = `SELECT e.id, e.job, e.stage, e.status, e.error, e.plan_id, e.source_id, e.created_at, e.updated_at
FROM ${T.tracy_events} e
WHERE e.stage IS NOT NULL
  AND (e.plan_id = ? OR e.source_id IN (SELECT ps.source_id FROM ${T.plan_sources} ps WHERE ps.plan_id = ?))
ORDER BY e.created_at, e.id`;

// ------------------------------------------------------------------------------------------------
// Topics, cards, links
// ------------------------------------------------------------------------------------------------

export type TopicRow = {
  id: string;
  plan_id: string;
  title: string | null;
  position: number | null;
  status: string | null;
  card_count: number | null;
};

/** Params: plan id. In outline order. */
export const TOPICS_SQL = `SELECT t.id, t.plan_id, t.title, t.position, t.status,
  (SELECT COUNT(*) FROM ${T.cards} c WHERE c.topic_id = t.id) AS card_count
FROM ${T.topics} t
WHERE t.plan_id = ?
ORDER BY t.position, t.created_at, t.id`;

export type TopicStatus = 'draft' | 'confirmed' | 'ready';

export type Topic = { id: string; planId: string; title: string; position: number; status: TopicStatus; cardCount: number };

export function topicFromRow(row: TopicRow): Topic {
  const status: TopicStatus = row.status === 'draft' || row.status === 'confirmed' ? row.status : 'ready';
  return {
    id: row.id,
    planId: row.plan_id,
    title: row.title ?? '',
    position: typeof row.position === 'number' ? row.position : 0,
    status,
    cardCount: count(row.card_count),
  };
}

export type CardListRow = {
  id: string;
  topic_id: string | null;
  plan_id: string | null;
  source_id: string | null;
  page: number | null;
  question: string | null;
  answer: string | null;
  card_type: string | null;
  source_title: string | null;
  state: number | null;
  due: string | null;
  suspended: number | null;
  reps: number | null;
};

const CARD_LIST_COLUMNS = `c.id, c.topic_id, c.plan_id, c.source_id, c.page, c.question, c.answer, c.card_type,
  src.title AS source_title, s.state, s.due, s.suspended, s.reps`;

/** Params: user id, plan id. The plan's cards (not draft topics) with the user's state, outline order. */
export const PLAN_CARDS_SQL = `SELECT ${CARD_LIST_COLUMNS}
FROM ${T.cards} c
LEFT JOIN ${T.topics} t ON t.id = c.topic_id
LEFT JOIN ${T.card_states} s ON s.card_id = c.id AND s.user_id = ?
LEFT JOIN ${T.sources} src ON src.id = c.source_id
WHERE c.plan_id = ? AND ${NOT_DRAFT}
ORDER BY t.position, c.created_at, c.id`;

/** Params: user id, card id. */
export const CARD_SQL = `SELECT ${CARD_LIST_COLUMNS}
FROM ${T.cards} c
LEFT JOIN ${T.card_states} s ON s.card_id = c.id AND s.user_id = ?
LEFT JOIN ${T.sources} src ON src.id = c.source_id
WHERE c.id = ?`;

export type CardSummary = {
  id: string;
  topicId: string | null;
  planId: string | null;
  sourceId: string | null;
  sourceTitle: string | null;
  page: number | null;
  question: string;
  answer: string;
  cardType: string;
  /** null when never answered. */
  state: number | null;
  due: string | null;
  suspended: boolean;
};

export function cardFromRow(row: CardListRow): CardSummary {
  return {
    id: row.id,
    topicId: row.topic_id,
    planId: row.plan_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    page: typeof row.page === 'number' ? row.page : null,
    question: row.question ?? '',
    answer: row.answer ?? '',
    cardType: row.card_type ?? 'basic',
    state: typeof row.state === 'number' ? row.state : null,
    due: row.due,
    suspended: row.suspended === 1,
  };
}

/** "p. 12, Lecture 3", "Lecture 3", "p. 12", or null. */
export function citation(page: number | null, sourceTitle: string | null): string | null {
  const title = sourceTitle?.trim() ? sourceTitle.trim() : null;
  const at = typeof page === 'number' && page > 0 ? `p. ${page}` : null;
  if (at && title) return `${at}, ${title}`;
  return at ?? title;
}

export type CardLinkRow = {
  id: string;
  from_card_id: string;
  to_card_id: string;
  relation: string | null;
  note: string | null;
  created_by: string | null;
  other_card_id: string;
  other_question: string | null;
};

/** Params: the card id, four times. Links from and to a card, with the other card's question. */
export const CARD_LINKS_SQL = `SELECT l.id, l.from_card_id, l.to_card_id, l.relation, l.note, l.created_by,
  CASE WHEN l.from_card_id = ? THEN l.to_card_id ELSE l.from_card_id END AS other_card_id,
  o.question AS other_question
FROM ${T.card_links} l
JOIN ${T.cards} o ON o.id = CASE WHEN l.from_card_id = ? THEN l.to_card_id ELSE l.from_card_id END
WHERE l.from_card_id = ? OR l.to_card_id = ?
ORDER BY l.created_at, l.id`;

/** Params: plan id. Every link of a plan (the concept map). */
export const PLAN_LINKS_SQL = `SELECT l.id, l.from_card_id, l.to_card_id, l.relation, l.note, l.created_by
FROM ${T.card_links} l
WHERE l.plan_id = ?
ORDER BY l.created_at, l.id`;

// ------------------------------------------------------------------------------------------------
// Due counts (Home, the reminder)
// ------------------------------------------------------------------------------------------------

/** Params: user id, until (ISO). Cards due by then across every plan. */
export const DUE_COUNT_SQL = `SELECT COUNT(*) AS n
FROM ${T.card_states} s
JOIN ${T.cards} c ON c.id = s.card_id
LEFT JOIN ${T.topics} t ON t.id = c.topic_id
WHERE s.user_id = ? AND ${ANSWERED} AND s.due <= ? AND ${NOT_DRAFT}`;

/** Params: user id, after (ISO). The first due time after then, across every plan (null when none). */
export const FIRST_DUE_AFTER_SQL = `SELECT MIN(s.due) AS due
FROM ${T.card_states} s
JOIN ${T.cards} c ON c.id = s.card_id
LEFT JOIN ${T.topics} t ON t.id = c.topic_id
WHERE s.user_id = ? AND ${ANSWERED} AND s.due > ? AND ${NOT_DRAFT}`;

/** Params: user id. Changes when a card state changes (a sync, an answer): the reminder watches it. */
export const CARD_STATES_VERSION_SQL = `SELECT MAX(updated_at) AS v, COUNT(*) AS n FROM ${T.card_states} WHERE user_id = ?`;

// ------------------------------------------------------------------------------------------------
// The focus block's queue (see queue.ts)
// ------------------------------------------------------------------------------------------------

export type QueueStateRow = FsrsStateRow & {
  state_id: string | null;
  card_id: string;
  question: string | null;
  answer: string | null;
  card_type: string | null;
  page: number | null;
  topic_id: string | null;
  source_id: string | null;
  topic_position: number | null;
  source_title: string | null;
};

const QUEUE_CARD_COLUMNS = `c.question, c.answer, c.card_type, c.page, c.topic_id, c.source_id,
  COALESCE(t.position, 0) AS topic_position, src.title AS source_title`;
const STATE_COLUMNS = `s.id AS state_id, s.state, s.due, s.stability, s.difficulty, s.scheduled_days, s.learning_steps,
  s.reps, s.lapses, s.last_review`;

/**
 * Params: user id, plan id, source id or null, the same source id, until (ISO: the block's end, so
 * learning steps that come due inside the block are included). Learning first, then by due.
 */
export const QUEUE_DUE_SQL = `SELECT s.card_id, ${STATE_COLUMNS}, ${QUEUE_CARD_COLUMNS}
FROM ${T.card_states} s
JOIN ${T.cards} c ON c.id = s.card_id
LEFT JOIN ${T.topics} t ON t.id = c.topic_id
LEFT JOIN ${T.sources} src ON src.id = c.source_id
WHERE s.user_id = ? AND ${ANSWERED} AND c.plan_id = ?
  AND (? IS NULL OR c.source_id = ?)
  AND ${NOT_DRAFT}
  AND s.due <= ?
ORDER BY CASE WHEN s.state IN (1, 3) THEN 0 ELSE 1 END, s.due
LIMIT 400`;

/**
 * Params: user id, plan id, source id or null, the same source id. Cards never answered, in the
 * order they are introduced: newest source first (cumulative plans), then outline order.
 */
export const QUEUE_NEW_SQL = `SELECT c.id AS card_id, ${STATE_COLUMNS}, ${QUEUE_CARD_COLUMNS}
FROM ${T.cards} c
LEFT JOIN ${T.topics} t ON t.id = c.topic_id
LEFT JOIN ${T.card_states} s ON s.card_id = c.id AND s.user_id = ?
LEFT JOIN ${T.plan_sources} ps ON ps.plan_id = c.plan_id AND ps.source_id = c.source_id
LEFT JOIN ${T.sources} src ON src.id = c.source_id
WHERE c.plan_id = ? AND (s.id IS NULL OR (s.state = 0 AND COALESCE(s.suspended, 0) = 0))
  AND (? IS NULL OR c.source_id = ?)
  AND ${NOT_DRAFT}
ORDER BY ps.added_at DESC, t.position, c.created_at, c.id
LIMIT 50`;

/** Params: user id, since (ISO: the start of the local day). New cards introduced since then. */
export const NEW_TODAY_SQL = `SELECT COUNT(DISTINCT card_id) AS n FROM ${T.reviews}
WHERE user_id = ? AND prev_state = 0 AND reviewed_at >= ?`;

export type BlockAnswerRow = {
  id: string;
  card_id: string;
  prev_state: number | null;
  rating: number | null;
  reviewed_at: string | null;
  duration_ms: number | null;
  source_id: string | null;
  topic_id: string | null;
};

/** Params: interval block id. This block's answers, in order. */
export const BLOCK_ANSWERS_SQL = `SELECT r.id, r.card_id, r.prev_state, r.rating, r.reviewed_at, r.duration_ms, c.source_id, c.topic_id
FROM ${T.reviews} r
LEFT JOIN ${T.cards} c ON c.id = r.card_id
WHERE r.interval_block_id = ?
ORDER BY r.reviewed_at, r.id`;

/** Params: study session id. The cycle's study results: answered, right (not Again), new. */
export const SESSION_REVIEWS_SQL = `SELECT COUNT(*) AS answered,
  COALESCE(SUM(CASE WHEN r.rating > 1 THEN 1 ELSE 0 END), 0) AS right_count,
  COUNT(DISTINCT CASE WHEN r.prev_state = 0 THEN r.card_id END) AS new_count
FROM ${T.reviews} r
JOIN ${T.interval_blocks} b ON b.id = r.interval_block_id
WHERE b.study_session_id = ?`;

function studyCard(row: QueueStateRow): StudyCard {
  return {
    cardId: row.card_id,
    question: row.question ?? '',
    answer: row.answer ?? '',
    cardType: row.card_type ?? 'basic',
    page: typeof row.page === 'number' ? row.page : null,
    topicId: row.topic_id,
    topicPosition: typeof row.topic_position === 'number' ? row.topic_position : 0,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
  };
}

function fsrsRow(row: QueueStateRow): FsrsStateRow {
  return {
    state: row.state,
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    last_review: row.last_review,
  };
}

/** A QUEUE_DUE_SQL row, or null when its due time cannot be read. */
export function dueCandidateFromRow(row: QueueStateRow): DueCandidate | null {
  const due = parseIso(row.due);
  if (due === null || typeof row.state !== 'number') return null;
  return { ...studyCard(row), state: row.state, due, stateRow: fsrsRow(row) };
}

/** A QUEUE_NEW_SQL row (its state row, if any, is a New one). */
export function newCandidateFromRow(row: QueueStateRow): NewCandidate {
  return { ...studyCard(row), stateRow: row.state_id ? fsrsRow(row) : null };
}

/** A BLOCK_ANSWERS_SQL row, or null when its time cannot be read. */
export function blockAnswerFromRow(row: BlockAnswerRow): BlockAnswer | null {
  const reviewedAt = parseIso(row.reviewed_at);
  if (reviewedAt === null) return null;
  return {
    cardId: row.card_id,
    prevState: typeof row.prev_state === 'number' ? row.prev_state : 0,
    rating: typeof row.rating === 'number' ? row.rating : 0,
    reviewedAt,
    durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
    sourceId: row.source_id,
    topicId: row.topic_id,
  };
}
