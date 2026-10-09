/**
 * The study pipeline as pure transitions: what a job of each stage needs, what its result turns into
 * (rows to write, jobs to enqueue next), and when a source moves on. No I/O here; the worker
 * (tracy-worker/worker.ts) and the study function (study/handlers.ts) do the reads and writes and
 * call these to decide. Spec: "Job pipeline" in the Phase 2 build spec, mirrored in
 * docs/DATA_MODEL.md.
 *
 *   submit_source ─▶ extract (pdf/doc/link) ─┬─▶ transcribe (scanned PDF pages, ≤ 4 per job)
 *                                            └─▶ (all done) ─▶ outline ─▶ approve_outline ─▶ cards × n
 *   submit_source ─▶ transcribe × photos (notes) ─▶ confirm_transcripts ─▶ outline ─▶ …
 *   (embed runs beside the outline when GEMINI_API_KEY is set; it never blocks anything)
 *   An outline that only adds material to topics the plan already has proposes nothing to review:
 *   the worker approves it itself and queues its cards jobs (tracy-worker/worker.ts stepOutline).
 */
import { cardId, cardLinkId, cardsJobId, chunkId, draftTopicId } from './ids.ts';
import type { OutlineDecision } from './contracts.ts';

export const STAGES = ['extract', 'transcribe', 'outline', 'cards', 'embed'] as const;
export type Stage = (typeof STAGES)[number];
export type PipelineJob = 'study_builder' | 'handwriting';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** What each stage is: its tracy_events.job, whether it calls Tracy (and so needs it awake). */
export const STAGE_INFO: Record<Stage, { job: PipelineJob; needsTracy: boolean }> = {
  extract: { job: 'study_builder', needsTracy: true },
  transcribe: { job: 'handwriting', needsTracy: true },
  outline: { job: 'study_builder', needsTracy: true },
  cards: { job: 'study_builder', needsTracy: true },
  embed: { job: 'study_builder', needsTracy: false },
};

/** Tries per step (the claim counts them; claim_tracy_events fails a stale job after the third). */
export const MAX_ATTEMPTS = 3;
/** dualrep_transcribe_pdf_pages takes at most 4 pages per call. */
export const PDF_PAGES_PER_JOB = 4;
/** dualrep_build_cards takes at most 40 chunks (each ≤ 1,600 chars here, so ≤ 64,000 < 100,000). */
export const CHUNKS_PER_CARDS_JOB = 40;
/** Card types Phase 2 asks for (write_from_memory comes with handwriting answers, Phase 3). */
export const CARD_TYPES = ['basic', 'cloze', 'why'] as const;
/** Existing cards shown to the card builder (Tracy's limit is 300), and how much of each question. */
export const EXISTING_CARDS_LIMIT = 300;
export const EXISTING_QUESTION_CHARS = 300;
/** Chunks per Gemini batchEmbedContents call (Gemini's maximum is 100). */
export const EMBED_BATCH = 50;
export const EMBED_MODEL_MARKER = 'gemini-embedding-2@1536#p1';

/** tracy_events as the Edge Functions read it (service role: every column). */
export interface JobRow {
  id: string;
  user_id: string;
  job: string;
  stage: string | null;
  status: JobStatus;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  attempts: number;
  locked_at: string | null;
  plan_id: string | null;
  source_id: string | null;
  created_at: string;
}

/** A job the Edge Functions insert themselves (uncounted stages, deterministic id: see ids.ts). */
export interface NewJob {
  id: string;
  user_id: string;
  job: PipelineJob;
  stage: Stage;
  plan_id: string | null;
  source_id: string | null;
  input: Record<string, unknown>;
}

/** The stage of a claimed job, or null for a job this pipeline does not run. */
export function stageOf(job: Pick<JobRow, 'job' | 'stage'>): Stage | null {
  const stage = STAGES.find((s) => s === job.stage);
  return stage && STAGE_INFO[stage].job === job.job ? stage : null;
}

const OPEN: JobStatus[] = ['queued', 'running'];
export const isOpen = (job: Pick<JobRow, 'status'>) => OPEN.includes(job.status);

// ---- Job inputs (server-only JSON in tracy_events.input) ----------------------------------------

export interface ExtractInput {
  source_id: string;
  plan_id: string;
  kind: 'pdf' | 'doc' | 'link';
  /** The first page of the next window (1-based). */
  cursor_page: number;
  /** Scanned pages that were not transcribed because the monthly page limit was used up. */
  skipped_pages?: number[];
  /** Scanned pages found so far. */
  scanned_pages?: number;
}

export interface TranscribePhotoInput {
  source_id: string;
  plan_id: string;
  source_file_id: string;
}

export interface TranscribePdfInput {
  source_id: string;
  plan_id: string;
  pdf_pages: number[];
}

export interface OutlineInput {
  source_id: string;
  plan_id: string;
}

export interface CardsInput {
  plan_id: string;
  source_id: string;
  topic_id: string;
  chunk_ids: string[];
  /** The outline's one-sentence summary of the topic (context for the card builder). */
  topic_summary?: string;
}

export interface EmbedInput {
  source_id: string;
  /** Chunks are embedded in id order; the next batch starts after this id. */
  after_chunk_id: string | null;
}

/** Validator findings of the previous attempt, sent back to Tracy so the model can fix them. */
export const previousErrors = (input: Record<string, unknown>): string[] =>
  Array.isArray(input.previous_errors)
    ? input.previous_errors.filter((e): e is string => typeof e === 'string').slice(0, 50)
    : [];

// ---- extract ------------------------------------------------------------------------------------

/** /ai/extract's answer (tracy-ai README "DualRep lane"). */
export interface ExtractResponse {
  format: string;
  total_pages: number | null;
  first_page: number | null;
  last_page: number | null;
  pages: {
    page: number | null;
    needs_transcription: boolean;
    chunks: { ordinal: number; title: string; content: string }[];
  }[];
}

export interface ChunkRowDraft {
  page: number | null;
  ordinal: number;
  content: string;
}

export interface ExtractWindow {
  chunks: ChunkRowDraft[];
  /** Pages without a text layer, to transcribe (sorted). */
  scanned: number[];
  /** The next window's first page, or null when the document is done. */
  nextCursor: number | null;
}

/** What one /ai/extract window becomes. */
export function planExtractWindow(cursor: number, res: ExtractResponse): ExtractWindow {
  const chunks: ChunkRowDraft[] = [];
  const scanned: number[] = [];
  for (const p of res.pages ?? []) {
    if (p.needs_transcription) {
      if (Number.isInteger(p.page) && (p.page as number) >= 1) scanned.push(p.page as number);
      continue;
    }
    for (const c of p.chunks ?? []) {
      const content = typeof c.content === 'string' ? c.content.trim() : '';
      if (content) chunks.push({ page: p.page ?? null, ordinal: c.ordinal, content });
    }
  }
  scanned.sort((a, b) => a - b);
  // Only a paged document (pdf) has more windows. Tracy reads at least one page per call, so the
  // cursor always moves; the `> cursor` guard keeps a misbehaving answer from looping forever.
  let nextCursor: number | null = null;
  if (
    Number.isInteger(res.total_pages) && Number.isInteger(res.last_page) &&
    (res.last_page as number) < (res.total_pages as number) && (res.last_page as number) + 1 > cursor
  ) {
    nextCursor = (res.last_page as number) + 1;
  }
  return { chunks, scanned, nextCursor };
}

/** Scanned pages in batches for dualrep_transcribe_pdf_pages. */
export function pageBatches(pages: number[], size: number = PDF_PAGES_PER_JOB): number[][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

/** Turns chunk drafts into source_chunks rows with their derived ids. */
export async function chunkRows(
  sourceId: string,
  ownerId: string,
  drafts: ChunkRowDraft[],
): Promise<{ id: string; source_id: string; owner_id: string; page: number | null; content: string }[]> {
  return await Promise.all(drafts.map(async (d) => ({
    id: await chunkId(sourceId, d.page, d.ordinal),
    source_id: sourceId,
    owner_id: ownerId,
    page: d.page,
    content: d.content,
  })));
}

/**
 * Recovers each chunk's position within its page from its derived id (source_chunks has no position
 * column). Chunks whose id was not derived (none today) sort last.
 */
export async function chunkOrdinals(
  sourceId: string,
  chunks: { id: string; page: number | null }[],
): Promise<Map<string, number>> {
  const byPage = new Map<number | null, Set<string>>();
  for (const c of chunks) {
    const set = byPage.get(c.page) ?? new Set<string>();
    set.add(c.id);
    byPage.set(c.page, set);
  }
  const out = new Map<string, number>();
  for (const [page, ids] of byPage) {
    // A page's chunks are always written together, numbered 0..n-1, so n ids cover them; a few
    // more keep a stray gap from hiding one (each id is a SHA-1, and the CPU budget is 2 s).
    const limit = ids.size + 4;
    for (let k = 0; k < limit && out.size < chunks.length; k++) {
      const id = await chunkId(sourceId, page, k);
      if (ids.has(id)) out.set(id, k);
    }
  }
  return out;
}

// ---- The outline gate ---------------------------------------------------------------------------

/**
 * Whether a pdf/doc/link source may get its outline job now:
 *   'exists'  it already has one (nothing to do; retried via retry_job if it failed);
 *   'blocked' its extraction failed or was cancelled (the source has failed);
 *   'wait'    extraction or a page transcription is still queued or running, or a transcription
 *             failed (the person retries or cancels it; either way this gate is asked again);
 *   'ready'   enqueue the outline now.
 * Asked by each finishing extract/transcribe job after its own status is written, and by cancel and
 * retry, so whichever finishes last starts the outline; the derived outline id makes a double start
 * impossible.
 */
export type OutlineGate = 'exists' | 'blocked' | 'wait' | 'ready';

export function outlineGate(
  jobs: Pick<JobRow, 'id' | 'stage' | 'status'>[],
  outlineId: string,
): OutlineGate {
  if (jobs.some((j) => j.id === outlineId || j.stage === 'outline')) return 'exists';
  const extract = jobs.filter((j) => j.stage === 'extract');
  if (extract.some((j) => j.status === 'failed' || j.status === 'cancelled')) return 'blocked';
  if (extract.length === 0 || extract.some((j) => j.status !== 'succeeded')) return 'wait';
  const transcribe = jobs.filter((j) => j.stage === 'transcribe');
  if (transcribe.some((j) => isOpen(j) || j.status === 'failed')) return 'wait';
  return 'ready';
}

/**
 * Whether a notes source may be confirmed: every photo's transcription is finished (succeeded, or
 * cancelled = skipped) and no outline exists yet. Returns a reason for the person when not.
 */
export function confirmGate(
  jobs: Pick<JobRow, 'stage' | 'status'>[],
): { ok: true } | { ok: false; reason: string } {
  const transcribe = jobs.filter((j) => j.stage === 'transcribe');
  if (jobs.some((j) => j.stage === 'outline')) {
    return { ok: false, reason: 'These notes are already confirmed.' };
  }
  if (transcribe.some(isOpen)) {
    return { ok: false, reason: 'Some pages are still being transcribed.' };
  }
  if (transcribe.some((j) => j.status === 'failed')) {
    return { ok: false, reason: 'A page could not be transcribed. Try it again or skip it first.' };
  }
  return { ok: true };
}

// ---- outline ------------------------------------------------------------------------------------

/** How many topics to ask for: about one per five passages, between 1 and 30. */
export const maxTopicsFor = (chunkCount: number) => Math.min(30, Math.max(1, Math.ceil(chunkCount / 5)));

/** dualrep_build_outline's answer. */
export interface OutlineOutput {
  topics: {
    key: string;
    title: string;
    summary: string;
    existing_topic_id: string | null;
    chunk_ids: string[];
  }[];
  unassigned_chunk_ids: string[];
}

/** One topic of a saved outline (tracy_events.output of the outline job, server-only). */
export interface SavedOutlineTopic {
  key: string;
  /** The draft topic row made for it; null when it continues an existing topic. */
  topic_id: string | null;
  /** The plan's existing topic it continues (cumulative plans), else null. */
  existing_topic_id: string | null;
  title: string;
  summary: string;
  /** Every chunk of the topic (digest groups already expanded). */
  chunk_ids: string[];
}

export interface SavedOutline {
  /** 'saved' = Tracy answered and this was stored; the rows may still need writing. */
  phase: 'saved';
  topics: SavedOutlineTopic[];
  unassigned_chunk_ids: string[];
  /** Set by approve_outline. */
  approved_at: string | null;
}

export async function saveOutline(
  outlineJobId: string,
  out: OutlineOutput,
  expand: (ids: string[]) => string[],
): Promise<SavedOutline> {
  const topics: SavedOutlineTopic[] = [];
  for (const t of out.topics) {
    topics.push({
      key: t.key,
      topic_id: t.existing_topic_id ? null : await draftTopicId(outlineJobId, t.key),
      existing_topic_id: t.existing_topic_id ?? null,
      title: t.title.trim().slice(0, 120),
      summary: (t.summary ?? '').trim().slice(0, 300),
      chunk_ids: expand(t.chunk_ids),
    });
  }
  return {
    phase: 'saved',
    topics,
    unassigned_chunk_ids: expand(out.unassigned_chunk_ids ?? []),
    approved_at: null,
  };
}

export function isSavedOutline(value: unknown): value is SavedOutline {
  const v = value as SavedOutline | null;
  return !!v && v.phase === 'saved' && Array.isArray(v.topics);
}

/** The draft topics an outline adds, numbered after the plan's current last position. */
export function draftTopicRows(saved: SavedOutline, planId: string, afterPosition: number) {
  return saved.topics
    .filter((t) => t.topic_id !== null)
    .map((t, i) => ({
      id: t.topic_id as string,
      plan_id: planId,
      title: t.title,
      position: afterPosition + 1 + i,
      status: 'draft' as const,
    }));
}

// ---- approve_outline ----------------------------------------------------------------------------

export interface TopicRow {
  id: string;
  plan_id: string;
  title: string;
  position: number;
  status: 'draft' | 'confirmed' | 'ready';
}

export interface OutlineToApprove {
  job: Pick<JobRow, 'id' | 'user_id' | 'plan_id' | 'source_id'>;
  saved: SavedOutline;
}

export interface ApprovalPlan {
  /** Field-level problems with the request (400). */
  errors: string[];
  /** Kept draft topics: their final title and position; they become 'confirmed'. */
  keep: { id: string; title: string; position: number }[];
  /** Cut draft topics (deleted). */
  cut: string[];
  /** One entry per topic that needs cards, before batching (see cardsJobs). */
  cards: { source_id: string; topic_id: string; chunk_ids: string[]; summary: string }[];
}

/**
 * Applies the person's review to one or more outlines of a plan. `topics` is the plan's topics as they
 * are now (the phone may have renamed or deleted drafts meanwhile). Kept drafts go after the plan's
 * other topics in the order of `decisions`; existing topics an outline continued keep their place and
 * get cards from the new material as long as they still exist.
 */
export function planApproval(
  outlines: OutlineToApprove[],
  topics: TopicRow[],
  decisions: OutlineDecision[],
): ApprovalPlan {
  const errors: string[] = [];
  const live = new Map(topics.map((t) => [t.id, t]));
  // draft topic id -> its outline topic
  const drafts = new Map<string, { o: OutlineToApprove; t: SavedOutlineTopic }>();
  for (const o of outlines) {
    for (const t of o.saved.topics) if (t.topic_id) drafts.set(t.topic_id, { o, t });
  }
  const seen = new Set<string>();
  decisions.forEach((d, i) => {
    if (!drafts.has(d.id)) errors.push(`topics[${i}].id is not a draft topic of this outline`);
    else if (seen.has(d.id)) errors.push(`topics[${i}].id is listed twice`);
    seen.add(d.id);
  });
  if (errors.length) return { errors, keep: [], cut: [], cards: [] };

  // Positions: after every topic of the plan that is not one of these drafts.
  const others = topics.filter((t) => !drafts.has(t.id));
  let position = others.reduce((max, t) => Math.max(max, t.position), -1);
  const keep: ApprovalPlan['keep'] = [];
  const cards: ApprovalPlan['cards'] = [];
  const kept = new Set<string>();
  for (const d of decisions) {
    const row = live.get(d.id);
    if (!d.keep || !row) continue; // cut, or already deleted on the phone
    const { o, t } = drafts.get(d.id)!;
    const title = (d.title ?? row.title).trim().slice(0, 120) || t.title;
    position += 1;
    keep.push({ id: d.id, title, position });
    kept.add(d.id);
    if (t.chunk_ids.length) {
      cards.push({ source_id: o.job.source_id!, topic_id: d.id, chunk_ids: t.chunk_ids, summary: t.summary });
    }
  }
  const cut = [...drafts.keys()].filter((id) => live.has(id) && !kept.has(id));
  for (const o of outlines) {
    for (const t of o.saved.topics) {
      if (t.existing_topic_id && live.has(t.existing_topic_id) && t.chunk_ids.length) {
        cards.push({
          source_id: o.job.source_id!,
          topic_id: t.existing_topic_id,
          chunk_ids: t.chunk_ids,
          summary: t.summary,
        });
      }
    }
  }
  return { errors, keep, cut, cards };
}

/** Cards jobs for one topic: its chunks in batches of at most 40, each job with its derived id. */
export async function cardsJobs(
  userId: string,
  planId: string,
  entry: ApprovalPlan['cards'][number],
): Promise<NewJob[]> {
  const jobs: NewJob[] = [];
  for (let b = 0, i = 0; i < entry.chunk_ids.length; b++, i += CHUNKS_PER_CARDS_JOB) {
    const input: CardsInput = {
      plan_id: planId,
      source_id: entry.source_id,
      topic_id: entry.topic_id,
      chunk_ids: entry.chunk_ids.slice(i, i + CHUNKS_PER_CARDS_JOB),
      topic_summary: entry.summary,
    };
    jobs.push({
      id: await cardsJobId(entry.source_id, entry.topic_id, b),
      user_id: userId,
      job: 'study_builder',
      stage: 'cards',
      plan_id: planId,
      source_id: entry.source_id,
      input: input as unknown as Record<string, unknown>,
    });
  }
  return jobs;
}

// ---- cards --------------------------------------------------------------------------------------

/** Cards to ask for: about 1.5 per passage, between 2 and 20 (Tracy's maximum). */
export const maxCardsFor = (chunkCount: number) => Math.min(20, Math.max(2, Math.ceil(chunkCount * 1.5)));

/** dualrep_build_cards's answer. */
export interface CardsOutput {
  cards: {
    key: string;
    card_type: string;
    question: string;
    answer: string;
    source_chunk_id: string;
    page: number | null;
    quote: string;
  }[];
  links: { from_key: string; to: string; relation: string; note: string | null }[];
}

export interface SavedCards extends CardsOutput {
  phase: 'saved';
}

export function isSavedCards(value: unknown): value is SavedCards {
  const v = value as SavedCards | null;
  return !!v && v.phase === 'saved' && Array.isArray(v.cards) && Array.isArray(v.links);
}

/**
 * The cards and card_links rows of a cards job's answer. Links to an existing card that has been
 * deleted since are dropped (`existingIds` = the existing cards that still exist).
 */
export async function cardRows(
  job: Pick<JobRow, 'id' | 'user_id'>,
  input: Pick<CardsInput, 'plan_id' | 'topic_id'>,
  out: CardsOutput,
  existingIds: Set<string>,
) {
  const idOf = new Map<string, string>();
  for (const c of out.cards) idOf.set(c.key, await cardId(job.id, c.key));
  const cards = out.cards.map((c) => ({
    id: idOf.get(c.key)!,
    topic_id: input.topic_id,
    plan_id: input.plan_id,
    source_chunk_id: c.source_chunk_id,
    page: c.page,
    question: c.question,
    answer: c.answer,
    card_type: c.card_type,
  }));
  const links = [];
  for (let i = 0; i < out.links.length; i++) {
    const l = out.links[i];
    const from = idOf.get(l.from_key);
    const to = idOf.get(l.to) ?? (existingIds.has(l.to) ? l.to : undefined);
    if (!from || !to || from === to) continue;
    links.push({
      id: await cardLinkId(job.id, i),
      from_card_id: from,
      to_card_id: to,
      plan_id: input.plan_id,
      created_by: job.user_id,
      relation: l.relation,
      note: l.note,
    });
  }
  return { cards, links };
}

/** The existing card ids a cards answer links to (to check they still exist). */
export const linkedExistingIds = (out: CardsOutput) => {
  const keys = new Set(out.cards.map((c) => c.key));
  return [...new Set(out.links.map((l) => l.to).filter((to) => !keys.has(to)))];
};

/**
 * After a cards job ends (any way): its topic is done when none of the topic's cards jobs is still
 * queued or running; the source is done when none of its cards jobs is.
 */
export function cardsProgress(
  jobs: Pick<JobRow, 'stage' | 'status' | 'input'>[],
  topicId: string,
): { topicDone: boolean; sourceDone: boolean } {
  const cards = jobs.filter((j) => j.stage === 'cards');
  return {
    topicDone: !cards.some((j) => isOpen(j) && j.input?.topic_id === topicId),
    sourceDone: !cards.some(isOpen),
  };
}

// ---- What happens to the source when a step ends without success -------------------------------

/**
 * Whether a job that failed or was cancelled leaves its source unable to go on: extraction (no text)
 * and the outline (no topics) are on the critical path; a transcription waits for the person (retry
 * or skip); a cards job only affects its topic; embeddings are optional.
 */
export const failsSource = (stage: Stage) => stage === 'extract' || stage === 'outline';
