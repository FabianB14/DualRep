/**
 * One step of one job per invocation (spec "Job pipeline"). index.ts wires the real clients; tests
 * pass fakes. No Deno APIs here.
 *
 *   claim the oldest queued job, cards and embed jobs last (claim_tracy_events: running, attempt
 *   counted, locked now), unless `maxRunning` jobs are running already (Tracy on Render's free plan
 *   handles one heavy job at a time)
 *   └─ needs Tracy? GET /health (5 s). Asleep -> release_tracy_event (attempt not counted), stop:
 *      the health call wakes Render's free service and the next cron minute goes ahead. After
 *      MAX_RELEASES in a row Tracy is down rather than asleep, and the job fails with a message.
 *   └─ run the stage's step: read what it needs, make ONE call (Tracy ≤ 110 s, or Gemini), write rows
 *   └─ apply the outcome, fenced: only while the job is still `running` with this run's attempts and
 *      lock time, so a run presumed dead can never overwrite a job that was retried meanwhile
 *        done      -> succeeded (+ follow-ups: the next jobs, topic and source status)
 *        continue  -> back to the queue with a new cursor (the next PDF window or embedding batch)
 *        retry     -> back to the queue (validator findings go to Tracy next time), until attempt 3
 *        fail      -> failed with a short, content-free error the phone shows next to "Try again"
 *        cancel    -> cancelled (the source, file or topic is gone)
 *        release   -> put back uncounted (Tracy asleep, or busy and did no work)
 *   └─ more work queued and progress made? kick this function again (hop + 1, at most MAX_HOPS in a
 *      row); otherwise pg_cron's next minute picks the work up.
 *
 * Two-phase steps (outline, cards): Tracy's answer is stored in the job's output (still running)
 * before any row is written, and rows have derived ids. A step cut short after that is retried from
 * the stored answer: no second Tracy call, no duplicate rows.
 */
import { chunkHeading, chunkPageText, transcribedPageText, type TranscribedPage } from '../_shared/chunker.ts';
import type { Caps } from '../_shared/config.ts';
import { buildDigest, expandIds, outlineEntries, readingOrder, shrunkEntries } from '../_shared/digest.ts';
import {
  type CallFailure,
  classifyGeminiFailure,
  classifyTracyFailure,
  type FailureAction,
  MESSAGES,
} from '../_shared/errors.ts';
import { afterJob } from '../_shared/followups.ts';
import { embedText } from '../_shared/gemini.ts';
import { MAX_HOPS } from '../_shared/kick.ts';
import {
  CARD_TYPES,
  type CardsInput,
  cardsJobs,
  type CardsOutput,
  cardRows,
  chunkOrdinals,
  chunkRows,
  draftTopicRows,
  EMBED_BATCH,
  EMBED_MODEL_MARKER,
  type EmbedInput,
  EXISTING_CARDS_LIMIT,
  EXISTING_QUESTION_CHARS,
  type ExtractInput,
  isSavedCards,
  isSavedOutline,
  type JobRow,
  linkedExistingIds,
  MAX_ATTEMPTS,
  MAX_RELEASES,
  maxCardsFor,
  maxTopicsFor,
  type OutlineInput,
  type OutlineOutput,
  pageBatches,
  planApproval,
  planExtractWindow,
  previousErrors,
  type SavedCards,
  type SavedOutline,
  saveOutline,
  type Stage,
  STAGE_INFO,
  stageOf,
} from '../_shared/pipeline.ts';
import type { Fence, JobPatch, SourceFileRow, SourceRow, Store } from '../_shared/store.ts';
import type { CallResult, TaskResult } from '../_shared/tracy.ts';

/** The Tracy calls the worker makes (the Tracy class, or a fake). */
export interface TracyApi {
  health(): Promise<boolean>;
  extract(body: { url: string; kind: 'pdf' | 'doc' | 'link'; first_page: number; request_id: string }): Promise<
    CallResult<import('../_shared/pipeline.ts').ExtractResponse>
  >;
  task<T>(task: string, input: Record<string, unknown>, requestId: string): Promise<CallResult<TaskResult<T>>>;
}

export interface WorkerDeps {
  store: Store;
  /** null when TRACY_URL or TRACY_SERVICE_SECRET is not set. */
  tracy: TracyApi | null;
  caps: Caps;
  /** Embeds texts (Gemini); undefined when GEMINI_API_KEY is not set. */
  embed?: (texts: string[]) => Promise<CallResult<number[][]>>;
  /** Wakes this function again. */
  kick?: (hop: number) => Promise<unknown>;
  /** How many jobs may run at once (DUALREP_WORKER_CONCURRENCY); null or unset = no limit. */
  maxRunning?: number | null;
  /** One metadata line per step (never content). */
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
}

/**
 * What a step came to. `code` (failures only) is what went wrong upstream, for the log: Tracy's
 * error code, an HTTP status, 'network', 'timeout' or 'not_json'. Never shown to the person.
 */
export type Outcome =
  | { kind: 'done'; output: unknown; model?: string | null; usage?: unknown; note?: string | null; input?: Record<string, unknown> }
  | { kind: 'continue'; input: Record<string, unknown>; output?: unknown }
  | { kind: 'retry'; message: string; previousErrors?: string[]; code?: string; input?: Record<string, unknown> }
  | { kind: 'fail'; message: string; code?: string }
  | { kind: 'cancel'; message: string | null }
  | { kind: 'release'; reason: string }
  | { kind: 'lost' };

export type StepResult =
  | { kind: 'idle' }
  | { kind: 'step'; jobId: string; stage: Stage | null; outcome: Outcome['kind']; applied: boolean; kicked: boolean };

/** Signed URLs for Tracy (or Anthropic's fetcher) live 10 minutes: enough for a Render cold start. */
const SIGNED_URL_SECONDS = 600;

interface StepCtx {
  deps: WorkerDeps;
  job: JobRow;
  fence: Fence;
}

const failureCode = (f: CallFailure) => (f.kind === 'http' ? f.code ?? String(f.status) : f.kind);

const fromFailure = (a: FailureAction, f: CallFailure): Outcome =>
  a.action === 'release'
    ? { kind: 'release', reason: a.reason }
    : a.action === 'retry'
    ? { kind: 'retry', message: a.message, previousErrors: a.previousErrors, code: failureCode(f) }
    : { kind: 'fail', message: a.message, code: failureCode(f) };

const fromTracy = (f: CallFailure, stage: Stage, kind?: string | null) =>
  fromFailure(classifyTracyFailure(f, { stage, kind }), f);

/** The worker downloads with the service role, so a path outside the source's folder is never used. */
const inOwnFolder = (file: SourceFileRow, source: SourceRow) =>
  file.storage_path.startsWith(`${source.owner_id}/${source.id}/`) && !file.storage_path.includes('..');

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// ---- extract ------------------------------------------------------------------------------------

async function stepExtract({ deps, job }: StepCtx): Promise<Outcome> {
  const input = job.input as unknown as ExtractInput;
  const source = await deps.store.getSource(input.source_id);
  if (!source) return { kind: 'cancel', message: MESSAGES.sourceGone };
  if (source.kind === 'notes') return { kind: 'fail', message: MESSAGES.unknownJob };
  let url: string;
  if (source.kind === 'link') {
    if (!source.url) return { kind: 'fail', message: MESSAGES.linkUnusable };
    url = source.url;
  } else {
    const file = (await deps.store.sourceFiles(source.id)).find((f) => inOwnFolder(f, source));
    if (!file) return { kind: 'fail', message: MESSAGES.fileMissing };
    url = await deps.store.signedUrl(file.storage_path, SIGNED_URL_SECONDS);
  }
  const cursor = Number.isInteger(input.cursor_page) && input.cursor_page >= 1 ? input.cursor_page : 1;
  const res = await deps.tracy!.extract({ url, kind: source.kind, first_page: cursor, request_id: job.id });
  if (!res.ok) return fromTracy(res.failure, 'extract', source.kind);

  const window = planExtractWindow(cursor, res.data);
  if (window.chunks.length) {
    await deps.store.upsertChunks(await chunkRows(source.id, source.owner_id, window.chunks));
  }

  // Scanned pages: one transcription job per 4 pages, counted against the monthly page limit. This
  // job is the only one that queues them and it runs one step at a time, so "already queued?" is a
  // safe check (a retried window must not queue or count its pages twice).
  const skipped = Array.isArray(input.skipped_pages) ? [...input.skipped_pages] : [];
  if (window.scanned.length) {
    const queued = new Set(
      (await deps.store.sourceJobs(source.id))
        .filter((j) => j.stage === 'transcribe' && Array.isArray(j.input?.pdf_pages))
        .map((j) => JSON.stringify(j.input.pdf_pages)),
    );
    for (const pages of pageBatches(window.scanned)) {
      if (queued.has(JSON.stringify(pages))) continue;
      const r = await deps.store.enqueueCounted({
        user_id: job.user_id,
        job: 'handwriting',
        stage: 'transcribe',
        input: { source_id: source.id, plan_id: input.plan_id, pdf_pages: pages },
        plan_id: input.plan_id,
        source_id: source.id,
        free_limit: deps.caps.pages.free,
        paid_limit: deps.caps.pages.paid,
        units: pages.length,
      });
      if (!r.ok) skipped.push(...pages);
    }
  }
  const next: Record<string, unknown> = {
    source_id: input.source_id,
    plan_id: input.plan_id,
    kind: input.kind,
    cursor_page: window.nextCursor ?? cursor,
    skipped_pages: skipped,
    scanned_pages: (input.scanned_pages ?? 0) + window.scanned.length,
  };
  if (window.nextCursor !== null) return { kind: 'continue', input: next };
  const n = skipped.length;
  return {
    kind: 'done',
    input: next,
    output: {
      format: res.data.format,
      total_pages: res.data.total_pages,
      scanned_pages: next.scanned_pages,
      skipped_pages: n,
    },
    note: n
      ? `${n} scanned page${n === 1 ? " wasn't" : "s weren't"} transcribed: this month's page limit is used up.`
      : null,
  };
}

// ---- transcribe ---------------------------------------------------------------------------------

async function stepTranscribe({ deps, job }: StepCtx): Promise<Outcome> {
  const input = job.input;
  const source = await deps.store.getSource(String(input.source_id ?? ''));
  if (!source) return { kind: 'cancel', message: MESSAGES.sourceGone };
  const plan = str(input.plan_id) ? await deps.store.getPlan(input.plan_id as string) : null;
  const subject = (plan?.title || source.title || '').trim().slice(0, 200) || null;
  const files = await deps.store.sourceFiles(source.id);

  if (str(input.source_file_id)) {
    // One photo of handwritten notes.
    const file = files.find((f) => f.id === input.source_file_id);
    if (!file) return { kind: 'cancel', message: MESSAGES.fileMissing };
    if (!inOwnFolder(file, source)) return { kind: 'fail', message: MESSAGES.fileMissing };
    const url = await deps.store.signedUrl(file.storage_path, SIGNED_URL_SECONDS);
    const res = await deps.tracy!.task<{ status: string; page: TranscribedPage }>(
      'dualrep_transcribe_notes',
      { image_url: url, page: file.page ?? 1, subject, previous_errors: previousErrors(input) },
      job.id,
    );
    if (!res.ok) return fromTracy(res.failure, 'transcribe', source.kind);
    const page = res.data.output.page;
    // A draft: source_files.confirmed stays false until the person confirms it.
    await deps.store.updateSourceFile(file.id, { transcript: transcribedPageText(page).slice(0, 20000) });
    return {
      kind: 'done',
      output: { pages: [summary(page)] },
      model: res.data.model,
      usage: res.data.usage,
    };
  }

  if (Array.isArray(input.pdf_pages)) {
    // Scanned pages of a PDF: transcribed and chunked straight away (a printed scan needs no review).
    const pages = (input.pdf_pages as unknown[]).filter((p): p is number => Number.isInteger(p) && (p as number) >= 1);
    const file = files.find((f) => inOwnFolder(f, source));
    if (!file || !pages.length) return { kind: 'fail', message: MESSAGES.fileMissing };
    const url = await deps.store.signedUrl(file.storage_path, SIGNED_URL_SECONDS);
    const res = await deps.tracy!.task<{ status: string; pages: TranscribedPage[] }>(
      'dualrep_transcribe_pdf_pages',
      { pdf_url: url, pages, subject, previous_errors: previousErrors(input) },
      job.id,
    );
    if (!res.ok) return fromTracy(res.failure, 'transcribe', source.kind);
    const drafts = res.data.output.pages.flatMap((p) =>
      chunkPageText(transcribedPageText(p)).map((c, ordinal) => ({ page: p.page, ordinal, content: c.content }))
    );
    if (drafts.length) await deps.store.upsertChunks(await chunkRows(source.id, source.owner_id, drafts));
    return {
      kind: 'done',
      output: { pages: res.data.output.pages.map(summary) },
      model: res.data.model,
      usage: res.data.usage,
    };
  }
  return { kind: 'fail', message: MESSAGES.unknownJob };
}

/** What the job keeps of a transcription (the text itself lives in source_files / source_chunks). */
const summary = (p: TranscribedPage) => ({
  page: p.page,
  blank: p.blank,
  legibility: p.legibility ?? null,
  uncertain: Array.isArray(p.uncertain) ? p.uncertain.length : 0,
});

// ---- outline ------------------------------------------------------------------------------------

async function stepOutline({ deps, job, fence }: StepCtx): Promise<Outcome> {
  const input = job.input as unknown as OutlineInput;
  const source = await deps.store.getSource(input.source_id);
  if (!source) return { kind: 'cancel', message: MESSAGES.sourceGone };
  const plan = await deps.store.getPlan(input.plan_id);
  if (!plan) return { kind: 'cancel', message: MESSAGES.sourceGone };
  const topics = await deps.store.planTopics(plan.id);
  let saved: SavedOutline | null = isSavedOutline(job.output) ? job.output : null;
  let model: string | null = null;
  let usage: unknown = null;

  if (!saved) {
    const chunks = await deps.store.sourceChunks(source.id);
    if (!chunks.length) {
      // A scan whose pages were all over the monthly page limit has nothing to outline; say why.
      const capped = (await deps.store.sourceJobs(source.id)).some((j) =>
        j.stage === 'extract' && Array.isArray(j.input?.skipped_pages) && j.input.skipped_pages.length > 0
      );
      return { kind: 'fail', message: capped ? MESSAGES.pageCapUsed : MESSAGES.noText };
    }
    const ordinals = await chunkOrdinals(source.id, chunks);
    const digest = buildDigest(
      readingOrder(chunks, (c) => ordinals.get(c.id) ?? Number.MAX_SAFE_INTEGER),
      outlineEntries(job.input),
    );
    const existing = plan.scope === 'cumulative'
      ? topics.filter((t) => t.status !== 'draft').slice(0, 200)
        .map((t) => ({ id: t.id, title: t.title.slice(0, 200), position: t.position }))
      : [];
    const res = await deps.tracy!.task<OutlineOutput>('dualrep_build_outline', {
      plan: { title: plan.title.slice(0, 200), scope: plan.scope, goal: plan.goal.slice(0, 1000), target_date: plan.target_date },
      existing_topics: existing,
      chunks: digest.entries,
      max_topics: Math.min(maxTopicsFor(chunks.length), digest.entries.length),
      previous_errors: previousErrors(job.input),
    }, job.id);
    if (!res.ok) {
      const outcome = fromTracy(res.failure, 'outline', source.kind);
      // The answer lists every entry once, so asking again with the same input fails the same way:
      // after an answer cut off at its length limit, or one too slow to arrive, the next attempt
      // sends half as many entries (neighbouring chunks grouped).
      const smaller = answerTooLong(res.failure) ? shrunkEntries(digest.entries.length) : null;
      return outcome.kind === 'retry' && smaller !== null ? { ...outcome, input: { max_entries: smaller } } : outcome;
    }
    saved = await saveOutline(job.id, res.data.output, (ids) => expandIds(ids, digest.members));
    model = res.data.model;
    usage = res.data.usage;
    // Phase 1: keep the answer before writing rows (still running, still fenced).
    if (!(await deps.store.finishJob(fence, { output: saved, model, usage }))) return { kind: 'lost' };
  }

  // New topics go after the plan's current ones (this outline's own drafts excluded, so a re-run
  // numbers them the same way).
  const own = new Set(saved.topics.map((t) => t.topic_id).filter(Boolean));
  const last = topics.filter((t) => !own.has(t.id)).reduce((max, t) => Math.max(max, t.position), -1);
  await deps.store.insertTopics(draftTopicRows(saved, plan.id, last));

  // An outline that only adds to topics the plan already has (a cumulative plan whose new material
  // belongs entirely to approved topics) proposes nothing for the person to review: the phone shows
  // draft topics only, so waiting for approve_outline would leave the source stuck at "Review the
  // outline". It is approved here instead: cards jobs for the topics it adds to (derived ids, so a
  // re-run queues nothing twice), or, when none is left to add to, the source is done.
  if (!saved.approved_at && saved.topics.every((t) => t.topic_id === null) && (await stillOurs(deps, fence))) {
    // The plan's topics as they are now (the person may have deleted one while Tracy worked).
    const approval = planApproval([{ job, saved }], await deps.store.planTopics(plan.id), []);
    const jobs = [];
    for (const entry of approval.cards) jobs.push(...(await cardsJobs(job.user_id, plan.id, entry)));
    for (const j of jobs) await deps.store.insertJob(j);
    if (!jobs.length) await deps.store.setSourceStatus(source.id, 'ready');
    saved = { ...saved, approved_at: (deps.now ?? (() => new Date()))().toISOString() };
  }
  return { kind: 'done', output: saved, ...(model ? { model, usage } : {}) };
}

/**
 * A failure that a shorter outline answer can avoid: cut off at max_tokens, or out of time (the
 * worker's own wait, or Tracy's 105 s budget, which comes back as model_error).
 */
const answerTooLong = (f: CallFailure) =>
  f.kind === 'timeout' || (f.kind === 'http' && (f.code === 'truncated' || f.code === 'model_error'));

/** Whether the claimed job is still this run's (not cancelled, retried or reaped meanwhile). */
async function stillOurs(deps: WorkerDeps, fence: Fence): Promise<boolean> {
  const current = await deps.store.getJob(fence.id);
  return current?.status === 'running' && current.attempts === fence.attempts && current.locked_at === fence.locked_at;
}

// ---- cards --------------------------------------------------------------------------------------

async function stepCards({ deps, job, fence }: StepCtx): Promise<Outcome> {
  const input = job.input as unknown as CardsInput;
  const topic = await deps.store.getTopic(input.topic_id);
  if (!topic || topic.status === 'draft') return { kind: 'cancel', message: MESSAGES.topicGone };
  const plan = await deps.store.getPlan(input.plan_id);
  if (!plan) return { kind: 'cancel', message: MESSAGES.sourceGone };
  let saved: SavedCards | null = isSavedCards(job.output) ? job.output : null;
  let model: string | null = null;
  let usage: unknown = null;

  if (!saved) {
    const chunks = (await deps.store.chunksByIds(input.chunk_ids ?? [])).filter((c) => c.content.trim());
    if (!chunks.length) return { kind: 'cancel', message: MESSAGES.sourceGone };
    const existing = await deps.store.planCards(plan.id, topic.id, EXISTING_CARDS_LIMIT);
    const res = await deps.tracy!.task<CardsOutput>('dualrep_build_cards', {
      plan: { title: plan.title.slice(0, 200), goal: plan.goal.slice(0, 1000), target_date: plan.target_date },
      // A topic made by hand can have a longer title than the card builder accepts.
      topic: { key: 't1', title: topic.title.slice(0, 200) || 'Topic', summary: input.topic_summary ?? '' },
      chunks: chunks.map((c) => ({ id: c.id, page: c.page, content: c.content.slice(0, 6000) })),
      existing_cards: existing.map((c) => ({ id: c.id, question: c.question.slice(0, EXISTING_QUESTION_CHARS) })),
      card_types: [...CARD_TYPES],
      max_cards: maxCardsFor(chunks.length),
      previous_errors: previousErrors(job.input),
    }, job.id);
    if (!res.ok) return fromTracy(res.failure, 'cards');
    saved = { phase: 'saved', ...res.data.output };
    model = res.data.model;
    usage = res.data.usage;
    if (!(await deps.store.finishJob(fence, { output: saved, model, usage }))) return { kind: 'lost' };
  }

  const existingIds = await deps.store.existingCardIds(linkedExistingIds(saved));
  const { cards, links } = await cardRows(job, input, saved, existingIds);
  // A chunk deleted since the answer (its source was deleted) would break the foreign key.
  const alive = new Set((await deps.store.chunksByIds([...new Set(cards.map((c) => c.source_chunk_id))])).map((c) => c.id));
  const rows = cards.filter((c) => alive.has(c.source_chunk_id));
  if (!rows.length) return { kind: 'cancel', message: MESSAGES.sourceGone };
  const kept = new Set(rows.map((c) => c.id));
  await deps.store.insertCards(rows);
  await deps.store.insertCardLinks(links.filter((l) => (kept.has(l.from_card_id)) && (kept.has(l.to_card_id) || existingIds.has(l.to_card_id))));
  return { kind: 'done', output: saved, ...(model ? { model, usage } : {}) };
}

// ---- embed --------------------------------------------------------------------------------------

async function stepEmbed({ deps, job }: StepCtx): Promise<Outcome> {
  if (!deps.embed) return { kind: 'cancel', message: null }; // the key was removed since
  const input = job.input as unknown as EmbedInput;
  const source = await deps.store.getSource(input.source_id);
  if (!source) return { kind: 'cancel', message: null };
  const batch = await deps.store.chunksToEmbed(source.id, input.after_chunk_id ?? null, EMBED_BATCH);
  if (!batch.length) return { kind: 'done', output: { embedded: true } };
  const res = await deps.embed(batch.map((c) => embedText(chunkHeading(c.content), c.content)));
  if (!res.ok) return fromFailure(classifyGeminiFailure(res.failure), res.failure);
  await deps.store.saveEmbeddings(batch.map((chunk, i) => ({ chunk, embedding: res.data[i], model: EMBED_MODEL_MARKER })));
  if (batch.length < EMBED_BATCH) return { kind: 'done', output: { embedded: true } };
  return { kind: 'continue', input: { source_id: input.source_id, after_chunk_id: batch[batch.length - 1].id } };
}

const STEPS: Record<Stage, (ctx: StepCtx) => Promise<Outcome>> = {
  extract: stepExtract,
  transcribe: stepTranscribe,
  outline: stepOutline,
  cards: stepCards,
  embed: stepEmbed,
};

// ---- the run ------------------------------------------------------------------------------------

const withoutRetryNotes = (input: Record<string, unknown>) => {
  const { previous_errors: _drop, ...rest } = input;
  return rest;
};

/** Writes an outcome (fenced) and runs the follow-ups. Returns whether the job was updated. */
async function apply(deps: WorkerDeps, job: JobRow, stage: Stage | null, fence: Fence, outcome: Outcome): Promise<boolean> {
  const store = deps.store;
  const embeddings = !!deps.embed;
  const finish = (patch: JobPatch) => store.finishJob(fence, { locked_at: null, ...patch });
  // Follow-ups run before the final write (with the job's new status assumed) and again after it:
  // before covers a run cut off right after the write, after covers two jobs finishing together.
  const follow = async (status: 'succeeded' | 'failed' | 'cancelled', before: boolean) => {
    if (!stage) return;
    try {
      await afterJob(store, job, stage, status, { embeddings, override: before ? { id: job.id, status } : null });
    } catch (err) {
      // The job's own status still gets written; the other pass (or a retry) repeats the follow-ups.
      const e = err as { name?: string; code?: string };
      deps.log?.({ fn: 'tracy-worker', job_id: job.id, stage, followups: before ? 'before' : 'after', error: e?.name ?? 'Error', code: e?.code ?? null });
    }
  };

  switch (outcome.kind) {
    case 'lost':
      return false;
    case 'release':
      return await store.releaseJob(fence);
    case 'continue':
      return await finish({
        status: 'queued',
        input: withoutRetryNotes(outcome.input),
        // A new step: its own three attempts (the lock time still fences out an old run). `ran`
        // remembers that this job did work, so a cancel while the next step waits keeps it counted.
        attempts: 0,
        ran: true,
        releases: 0,
        error: null,
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      });
    case 'retry': {
      let input = outcome.input ? { ...job.input, ...outcome.input } : job.input;
      if (outcome.previousErrors?.length) input = { ...input, previous_errors: outcome.previousErrors };
      // Tracy was reached, so the count of releases in a row starts again.
      return await finish({ status: 'queued', input, releases: 0 });
    }
    case 'done': {
      // Only while the job is still this run's (a cancel meanwhile must not start the next step).
      if (await stillOurs(deps, fence)) await follow('succeeded', true);
      const ok = await finish({
        status: 'succeeded',
        output: outcome.output ?? null,
        error: outcome.note ?? null,
        ...(outcome.input ? { input: withoutRetryNotes(outcome.input) } : { input: withoutRetryNotes(job.input) }),
        ...(outcome.model !== undefined ? { model: outcome.model, usage: outcome.usage ?? null } : {}),
      });
      if (ok) await follow('succeeded', false);
      return ok;
    }
    case 'fail':
    case 'cancel': {
      const status = outcome.kind === 'fail' ? 'failed' : 'cancelled';
      const ok = await finish({ status, error: outcome.message });
      if (ok) await follow(status, false);
      return ok;
    }
  }
}

/** Claims one job and runs one step of it. */
export async function runOneStep(deps: WorkerDeps, hop = 0): Promise<StepResult> {
  const log = deps.log ?? (() => {});
  const job = await deps.store.claimJob(deps.maxRunning ?? null);
  if (!job) return { kind: 'idle' };
  const started = Date.now();
  const fence: Fence = { id: job.id, attempts: job.attempts, locked_at: job.locked_at };
  const stage = stageOf(job);

  let outcome: Outcome;
  if (!stage) {
    outcome = { kind: 'fail', message: MESSAGES.unknownJob };
  } else if (STAGE_INFO[stage].needsTracy && !deps.tracy) {
    outcome = { kind: 'fail', message: MESSAGES.notSetUp };
  } else if (STAGE_INFO[stage].needsTracy && !(await deps.tracy!.health())) {
    outcome = { kind: 'release', reason: 'tracy_asleep' };
  } else {
    try {
      outcome = await STEPS[stage]({ deps, job, fence });
    } catch (err) {
      // A database or Storage error (or a bug): try again later. Name and code only in the log.
      const e = err as { name?: string; code?: string };
      log({ fn: 'tracy-worker', job_id: job.id, stage, error: e?.name ?? 'Error', code: e?.code ?? null });
      outcome = { kind: 'retry', message: MESSAGES.tracyBusy, code: e?.code ?? e?.name ?? 'error' };
    }
  }

  // The third attempt is the last: a retry then becomes a failure.
  if (outcome.kind === 'retry' && job.attempts >= MAX_ATTEMPTS) {
    outcome = { kind: 'fail', message: outcome.message, code: outcome.code };
  }
  // Put back again and again: Tracy is down, not asleep. Say so instead of "Reading…" for ever.
  if (outcome.kind === 'release' && (job.releases ?? 0) + 1 >= MAX_RELEASES) {
    outcome = { kind: 'fail', message: MESSAGES.tracyUnreachable, code: outcome.reason };
  }
  const applied = await apply(deps, job, stage, fence, outcome);
  // Kick again only after progress: after a release or a retry the next cron minute is the back-off.
  const progressed = applied && ['done', 'continue', 'fail', 'cancel'].includes(outcome.kind);
  let kicked = false;
  if (progressed && deps.kick && hop < MAX_HOPS && (await deps.store.hasQueuedJobs())) {
    await deps.kick(hop + 1);
    kicked = true;
  }
  log({
    fn: 'tracy-worker',
    job_id: job.id,
    stage,
    attempt: job.attempts,
    outcome: outcome.kind,
    code: 'code' in outcome ? outcome.code ?? null : outcome.kind === 'release' ? outcome.reason : null,
    applied,
    kicked,
    hop,
    ms: Date.now() - started,
  });
  return { kind: 'step', jobId: job.id, stage, outcome: outcome.kind, applied, kicked };
}

/**
 * Removes files of the `sources` bucket that no source_files row points at any more (older than
 * 3 days; see orphaned_source_objects). Storage refuses SQL deletes, so this goes through its API.
 */
export async function sweepOrphans(store: Store, log: (entry: Record<string, unknown>) => void = () => {}) {
  let removed = 0;
  for (let round = 0; round < 5; round++) {
    const names = await store.orphanedObjects(1000);
    if (!names.length) break;
    await store.removeObjects(names);
    removed += names.length;
    if (names.length < 1000) break;
  }
  log({ fn: 'tracy-worker', sweep: 'sources', removed });
  return removed;
}
