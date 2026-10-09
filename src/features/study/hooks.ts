/**
 * The study screens' live reads (PowerSync watched queries on the phone's database; all work
 * offline) and the two hooks with behaviour: the focus block's queue and the review reminder.
 * Must be used under `PowerSyncContext.Provider` and `AuthProvider`.
 *
 * Time: queries that compare with "now" take it rounded to the minute (useMinute), so a screen that
 * re-renders every second (the focus timer) does not re-run them every second. The queue's own
 * decisions use the exact time the caller passes. "Due" counts are for the local day: a review is due
 * on its day, not at its minute (see QueueInput.reviewDueBy), so the counts, the queue and the daily
 * reminder agree on what today's block will ask.
 */
import { useQuery } from '@powersync/react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { TABLE } from '@/db/constants';
import { useLocalState, writeLocalState } from '@/features/cycle/localState';
import { useStartOfToday } from '@/features/history/useHistory';

import { parseIso } from './fsrs';
import {
  endOfLocalDay,
  newAllowance,
  newPerBlockFor,
  nextItem,
  queueCounts,
  resolveScope,
  type BlockAnswer,
  type QueueNext,
  type ResolvedScope,
  type StudyFilter,
} from './queue';
import { rescheduleReviewReminder } from './reminders';
import { describeStep, planNextStep, sourceNote, sourceStep, type PlanNextStep, type SourceStep, type StepText } from './sourceProgress';
import {
  BLOCK_ANSWERS_SQL,
  blockAnswerFromRow,
  CARD_LINKS_SQL,
  CARD_SQL,
  CARD_STATES_VERSION_SQL,
  cardFromRow,
  DUE_COUNT_SQL,
  dueCandidateFromRow,
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
  type CardLinkRow,
  type CardListRow,
  type CardSummary,
  type JobRow,
  type PlanRow,
  type PlanScope,
  type PlanSourceRow,
  type QueueStateRow,
  type SourceFileRow,
  type StudyPlan,
  type Topic,
  type TopicRow,
} from './studyQueries';
import { readStudyPrefs, useStudyPrefs } from './studyPrefs';

const MINUTE = 60_000;

/** The current time rounded down to the minute; moves on every minute and when the app comes back. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / MINUTE) * MINUTE);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / MINUTE) * MINUTE);
    const timer = setInterval(tick, MINUTE);
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') tick();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return now;
}

function useUserId(): string | null {
  const { user } = useAuth();
  return user?.id ?? null;
}

// ---- Plans --------------------------------------------------------------------------------------

/** The end of the local day (ISO), for "due today" counts; changes once a day. */
function useEndOfToday(): string {
  return new Date(endOfLocalDay(useMinute())).toISOString();
}

/** Every plan on the phone (own and group), newest change first, with counts (due = due today). */
export function usePlans(): { plans: StudyPlan[]; isLoading: boolean } {
  const userId = useUserId();
  const dueBy = useEndOfToday();
  const { data, isLoading } = useQuery<PlanRow>(PLANS_SQL, [userId ?? '', dueBy, userId ?? '']);
  const plans = useMemo(() => data.map((row) => planFromRow(row, userId)), [data, userId]);
  return { plans, isLoading };
}

/** One plan, or null while loading or when it is not on the phone (deleted, or a group left). */
export function usePlan(planId: string | null): { plan: StudyPlan | null; isLoading: boolean } {
  const userId = useUserId();
  const dueBy = useEndOfToday();
  const { data, isLoading } = useQuery<PlanRow>(PLAN_SQL, [userId ?? '', dueBy, userId ?? '', planId ?? '']);
  const row = data[0] ?? null;
  const plan = useMemo(() => (row ? planFromRow(row, userId) : null), [row, userId]);
  return { plan, isLoading };
}

/** Cards due today across every plan (Home's due count). */
export function useDueCount(): { count: number; isLoading: boolean } {
  const userId = useUserId();
  const dueBy = useEndOfToday();
  const { data, isLoading } = useQuery<{ n: number }>(DUE_COUNT_SQL, [userId ?? '', dueBy]);
  return { count: Number(data[0]?.n ?? 0), isLoading };
}

// ---- Sources and their progress -----------------------------------------------------------------

export type SourceView = {
  planSourceId: string;
  sourceId: string;
  title: string;
  kind: string | null;
  url: string | null;
  /** sources.status (pending, processing, ready, failed), or null when the source is not on the phone. */
  status: string | null;
  addedAt: number | null;
  cardCount: number;
  /** True when the signed-in user owns the source. */
  isOwner: boolean;
  step: SourceStep;
  /**
   * updated_at of the job a failed step names (`step.jobId`), else null. Try again puts that same job
   * back in the queue, so this tells the failure a screen acted on from a later one of the same job.
   */
  stepJobVersion: string | null;
  text: StepText;
  /** A note the pipeline left (e.g. scanned pages skipped at the monthly limit), or null. */
  note: string | null;
};

/**
 * A plan's sources, newest first, each with where it is in the pipeline, and the plan's one next
 * step (what to show as the primary action).
 */
export function useSourceProgress(planId: string | null): {
  sources: SourceView[];
  nextStep: PlanNextStep;
  draftTopics: number;
  isLoading: boolean;
} {
  const userId = useUserId();
  const id = planId ?? '';
  const sources = useQuery<PlanSourceRow>(PLAN_SOURCES_SQL, [id]);
  const files = useQuery<SourceFileRow>(PLAN_SOURCE_FILES_SQL, [id]);
  const jobs = useQuery<JobRow>(PLAN_JOBS_SQL, [id, id]);
  const topics = useQuery<TopicRow>(TOPICS_SQL, [id]);
  return useMemo(() => {
    const draftTopics = topics.data.filter((t) => t.status === 'draft').length;
    const cardCount = topics.data.reduce((sum, t) => sum + (t.status === 'draft' ? 0 : Number(t.card_count ?? 0)), 0);
    const views = sources.data.map((row): SourceView => {
      const sourceJobs = jobs.data
        .filter((j) => j.source_id === row.source_id)
        .map((j) => ({ id: j.id, stage: j.stage, status: j.status, error: j.error, createdAt: j.created_at }));
      const step = sourceStep(
        { id: row.source_id, kind: row.kind, status: row.status, title: row.title },
        files.data.filter((f) => f.source_id === row.source_id).map((f) => ({ id: f.id, transcript: f.transcript, confirmed: f.confirmed === 1 })),
        sourceJobs,
        draftTopics,
      );
      const stepJobId = step.step === 'failed' ? step.jobId : null;
      return {
        planSourceId: row.plan_source_id,
        sourceId: row.source_id,
        title: row.title ?? '',
        kind: row.kind,
        url: row.url,
        status: row.status,
        addedAt: parseIso(row.added_at),
        cardCount: Number(row.card_count ?? 0),
        isOwner: userId !== null && row.owner_id === userId,
        step,
        stepJobVersion: (stepJobId && jobs.data.find((j) => j.id === stepJobId)?.updated_at) || null,
        text: describeStep(step),
        note: sourceNote(sourceJobs),
      };
    });
    return {
      sources: views,
      nextStep: planNextStep(views.map((v) => ({ sourceId: v.sourceId, step: v.step })), cardCount),
      draftTopics,
      isLoading: sources.isLoading || files.isLoading || jobs.isLoading || topics.isLoading,
    };
  }, [sources.data, sources.isLoading, files.data, files.isLoading, jobs.data, jobs.isLoading, topics.data, topics.isLoading, userId]);
}

/** One source's files in page order (the transcription review). */
export function useSourceFiles(sourceId: string | null): { files: SourceFileRow[]; isLoading: boolean } {
  const { data, isLoading } = useQuery<SourceFileRow>(SOURCE_FILES_SQL, [sourceId ?? '']);
  return { files: data, isLoading };
}

// ---- Topics, cards, links -----------------------------------------------------------------------

/** A plan's topics in outline order (drafts included: the outline review shows them). */
export function useTopics(planId: string | null): { topics: Topic[]; isLoading: boolean } {
  const { data, isLoading } = useQuery<TopicRow>(TOPICS_SQL, [planId ?? '']);
  const topics = useMemo(() => data.map(topicFromRow), [data]);
  return { topics, isLoading };
}

/** A plan's cards (not those of draft topics) with the user's state. */
export function usePlanCards(planId: string | null): { cards: CardSummary[]; isLoading: boolean } {
  const userId = useUserId();
  const { data, isLoading } = useQuery<CardListRow>(PLAN_CARDS_SQL, [userId ?? '', planId ?? '']);
  const cards = useMemo(() => data.map(cardFromRow), [data]);
  return { cards, isLoading };
}

/** One card, or null when it is not on the phone. */
export function useCard(cardId: string | null): { card: CardSummary | null; isLoading: boolean } {
  const userId = useUserId();
  const { data, isLoading } = useQuery<CardListRow>(CARD_SQL, [userId ?? '', cardId ?? '']);
  const row = data[0] ?? null;
  const card = useMemo(() => (row ? cardFromRow(row) : null), [row]);
  return { card, isLoading };
}

/** A card's links, both ways, with the other card's question. */
export function useCardLinks(cardId: string | null): { links: CardLinkRow[]; isLoading: boolean } {
  const id = cardId ?? '';
  const { data, isLoading } = useQuery<CardLinkRow>(CARD_LINKS_SQL, [id, id, id, id]);
  return { links: data, isLoading };
}

/** Every link of a plan (the concept map). */
export function usePlanLinks(
  planId: string | null,
): { links: { id: string; from_card_id: string; to_card_id: string; relation: string | null; note: string | null; created_by: string | null }[]; isLoading: boolean } {
  const { data, isLoading } = useQuery(PLAN_LINKS_SQL, [planId ?? '']);
  return { links: data, isLoading };
}

/** profiles.fsrs_params of the signed-in user (JSON text or null), for answerCard. */
export function useFsrsParams(): string | null {
  const userId = useUserId();
  const { data } = useQuery<{ fsrs_params: string | null }>(`SELECT fsrs_params FROM ${TABLE.profiles} WHERE id = ?`, [userId ?? '']);
  return data[0]?.fsrs_params ?? null;
}

/** A study session's results for the cycle summary: answered, right (not Again), new. */
export function useSessionReviews(sessionId: string | null): { answered: number; right: number; fresh: number } {
  const { data } = useQuery<{ answered: number; right_count: number; new_count: number }>(SESSION_REVIEWS_SQL, [sessionId ?? '']);
  const row = data[0];
  return { answered: Number(row?.answered ?? 0), right: Number(row?.right_count ?? 0), fresh: Number(row?.new_count ?? 0) };
}

// ---- The focus block's queue --------------------------------------------------------------------

/** local_state key: when the running block's self-test began, so a restart keeps it. */
export const SELF_TEST_STATE_KEY = 'study-self-test';

export type StudyQueueOptions = {
  planId: string | null;
  /** The running focus block (interval_blocks.id); null outside one. */
  blockId: string | null;
  scope: PlanScope;
  filter: StudyFilter;
  /** The block's full length and the focus time left (from the cycle's timer). */
  blockMs: number;
  remainingMs: number;
  /** The exact time of this render (the timer's tick). */
  now: number;
};

export type StudyQueue = {
  /** What to show; null while loading or without a plan. */
  next: QueueNext | null;
  counts: { due: number; fresh: number };
  /** The resolved source filter, with a line explaining a fallback. */
  scope: ResolvedScope;
  /** New cards the block and the day still allow. */
  newLeft: number;
  isLoading: boolean;
  /**
   * Tell the queue a card was just answered (after answerCard resolved), so it is not asked again
   * before the database queries refresh.
   */
  markAnswered(cardId: string, reviewId: string): void;
};

const EMPTY_ANSWERS: BlockAnswer[] = [];

/**
 * The focus block's study queue (queue.ts), fed from live queries. The queries re-run when the rows
 * change (throttled to once a second) and when the block's end moves (rounded to 5 minutes), never on
 * every timer tick; `nextItem` itself is cheap and runs on each render.
 */
export function useStudyQueue(options: StudyQueueOptions): StudyQueue {
  const userId = useUserId() ?? '';
  const planId = options.planId ?? '';
  const { prefs } = useStudyPrefs();
  const today = useStartOfToday();

  const sources = useQuery<PlanSourceRow>(PLAN_SOURCES_SQL, [planId]);
  const scope = useMemo(
    () =>
      resolveScope(
        options.scope,
        options.filter,
        sources.data.map((row) => ({ sourceId: row.source_id, title: row.title ?? '', addedAt: parseIso(row.added_at), cards: Number(row.card_count ?? 0) })),
      ),
    [options.scope, options.filter, sources.data],
  );
  const sourceId = scope.sourceId;

  // Due cards up to the end of the local day (reviews are due by their day) or a little past the
  // block's end when that is later (learning steps inside a block that runs past midnight; rounded up
  // to 5 minutes, so the parameter changes rarely); the queue decides what is due "now".
  const reviewDueBy = endOfLocalDay(options.now);
  const blockEnd = Math.ceil((options.now + options.remainingMs) / (5 * MINUTE)) * 5 * MINUTE;
  const until = new Date(Math.max(reviewDueBy, blockEnd)).toISOString();
  const throttle = { throttleMs: 1000 };
  const due = useQuery<QueueStateRow>(QUEUE_DUE_SQL, [userId, planId, sourceId, sourceId, until], throttle);
  const fresh = useQuery<QueueStateRow>(QUEUE_NEW_SQL, [userId, planId, sourceId, sourceId], throttle);
  const answers = useQuery<BlockAnswerRow>(BLOCK_ANSWERS_SQL, [options.blockId ?? ''], throttle);
  const newToday = useQuery<{ n: number }>(NEW_TODAY_SQL, [userId, today], throttle);
  const plan = useQuery<{ target_date: string | null }>(`SELECT target_date FROM ${TABLE.study_plans} WHERE id = ?`, [planId]);

  const dueList = useMemo(() => due.data.map(dueCandidateFromRow).filter((c) => c !== null), [due.data]);
  const freshList = useMemo(() => fresh.data.map(newCandidateFromRow), [fresh.data]);
  const blockAnswers = useMemo(
    () => (options.blockId ? answers.data.map(blockAnswerFromRow).filter((a) => a !== null) : EMPTY_ANSWERS),
    [answers.data, options.blockId],
  );

  // Cards answered a moment ago whose rows have not refreshed yet: cardId → reviewId, per block. A
  // card is left out until BOTH live queries show the answer: the block's answers (its review is
  // there) and the card's own due/new row (its last review is at or after that review). The queries
  // refresh on their own, so either can come first; going by the answers alone, a stale due row could
  // ask a learning card again a second after it was answered (and record a second answer).
  const blockId = options.blockId;
  const [answered, setAnswered] = useState<{ blockId: string | null; cards: ReadonlyMap<string, string> }>({
    blockId: null,
    cards: new Map(),
  });
  const exclude = useMemo(() => {
    const reviewedAt = new Map(answers.data.map((a) => [a.id, parseIso(a.reviewed_at)]));
    // The last review each candidate row shows (null: a row from before the card's first answer).
    const shownLastReview = new Map<string, number | null>();
    for (const candidate of [...dueList, ...freshList]) {
      shownLastReview.set(candidate.cardId, candidate.stateRow ? parseIso(candidate.stateRow.last_review) : null);
    }
    const cards = new Set<string>();
    if (answered.blockId === blockId) {
      for (const [cardId, reviewId] of answered.cards) {
        const at = reviewedAt.get(reviewId);
        if (at === undefined || at === null) {
          cards.add(cardId); // the block's answers have not caught up
          continue;
        }
        if (!shownLastReview.has(cardId)) continue; // not due or new any more: nothing to leave out
        const last = shownLastReview.get(cardId) ?? null;
        if (last === null || last < at) cards.add(cardId); // its row is from before the answer
      }
    }
    return cards;
  }, [answered, answers.data, blockId, dueList, freshList]);
  const markAnswered = useCallback(
    (cardId: string, reviewId: string) => {
      setAnswered((current) => ({
        blockId,
        cards: new Map(current.blockId === blockId ? current.cards : []).set(cardId, reviewId),
      }));
    },
    [blockId],
  );

  // When this block's self-test began, kept across restarts.
  const stored = useLocalState<{ blockId: string; from: number }>(SELF_TEST_STATE_KEY).value;
  const selfTestFrom = stored && stored.blockId === options.blockId && Number.isFinite(stored.from) ? stored.from : null;

  const settings = useMemo(
    () => ({
      newPerBlock: prefs.newPerBlock ?? newPerBlockFor(options.blockMs / MINUTE),
      dailyNewCap: prefs.dailyNewCap,
    }),
    [prefs.newPerBlock, prefs.dailyNewCap, options.blockMs],
  );
  const targetDate = plan.data[0]?.target_date ?? null;
  const isLoading = !options.planId || sources.isLoading || due.isLoading || fresh.isLoading || answers.isLoading || newToday.isLoading;

  const input = {
    now: options.now,
    blockMs: options.blockMs,
    remainingMs: options.remainingMs,
    due: dueList,
    fresh: freshList,
    blockAnswers,
    newToday: Number(newToday.data[0]?.n ?? 0),
    settings,
    interleaveBy: options.scope === 'cumulative' && sourceId === null ? ('source' as const) : ('topic' as const),
    prioritizeNew: Boolean(targetDate) && freshList.length > 0,
    selfTestFrom,
    exclude,
    reviewDueBy,
  };
  const next = isLoading ? null : nextItem(input);

  // Keep the self-test's start once the queue has begun it (once per block: an early start is "now",
  // which moves on every tick until the stored value comes back).
  const startedAt = next?.type === 'card' ? next.selfTestFrom : null;
  const savedFor = useRef<string | null>(null);
  useEffect(() => {
    if (startedAt === null || !blockId || selfTestFrom !== null || savedFor.current === blockId) return;
    savedFor.current = blockId;
    writeLocalState(SELF_TEST_STATE_KEY, { blockId, from: startedAt }).catch(() => undefined);
  }, [startedAt, blockId, selfTestFrom]);

  return {
    next,
    counts: queueCounts(input),
    scope,
    newLeft: newAllowance(input),
    isLoading,
    markAnswered,
  };
}

// ---- The review reminder ------------------------------------------------------------------------

/**
 * Keeps the daily review reminder in step: reschedules on app start, when the app comes back to the
 * foreground, when card states change (a sync, answers; at most every 30 s) and when the setting
 * changes. Mount it once, in the signed-in part of the app.
 */
export function useReviewReminders(): void {
  const userId = useUserId();
  const { prefs, isLoading } = useStudyPrefs();
  const { data } = useQuery<{ v: string | null; n: number }>(CARD_STATES_VERSION_SQL, [userId ?? ''], { throttleMs: 30_000 });
  const version = `${data[0]?.v ?? ''}|${data[0]?.n ?? 0}`;
  const [foreground, setForeground] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') setForeground((n) => n + 1);
    });
    return () => subscription.remove();
  }, []);
  const { enabled, hour, minute } = prefs.reminder;
  useEffect(() => {
    if (isLoading) return;
    rescheduleReviewReminder(userId, { enabled, hour, minute }).catch(() => undefined);
  }, [userId, enabled, hour, minute, version, foreground, isLoading]);
}

/** Reschedules the reminder now (e.g. when a focus block ends), with this phone's setting. */
export async function rescheduleReviewReminderNow(userId: string | null): Promise<void> {
  const prefs = await readStudyPrefs();
  await rescheduleReviewReminder(userId, prefs.reminder);
}
