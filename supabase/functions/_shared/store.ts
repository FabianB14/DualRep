/**
 * The database and Storage operations the two functions need, as an interface. supabase.ts implements
 * it with supabase-js and the secret key (service role); the tests use an in-memory fake
 * (testing/fake_store.ts). Keeping the pipeline's logic behind this seam is what lets `deno test` run
 * the worker's steps and the study actions end to end without a database. Pure (types only).
 *
 * Every method acts as the service role: it bypasses RLS, so callers check ownership first
 * (UserView) and always pass the verified user id.
 */
import type { CapReached } from './errors.ts';
import type { JobRow, JobStatus, NewJob, Stage, TopicRow } from './pipeline.ts';
import type { SourceKind } from './contracts.ts';

/** The fencing token of a claimed job: a later update must still match all three. */
export type Fence = Pick<JobRow, 'id' | 'attempts' | 'locked_at'>;

export type JobPatch = Partial<
  Pick<JobRow, 'status' | 'input' | 'output' | 'error' | 'attempts' | 'locked_at' | 'releases'> & {
    model: string | null;
    usage: unknown;
  }
>;

export interface SourceRow {
  id: string;
  owner_id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
}

export interface SourceFileRow {
  id: string;
  source_id: string;
  owner_id: string;
  storage_path: string;
  page: number | null;
  transcript: string | null;
  confirmed: boolean;
}

export interface ChunkRow {
  id: string;
  source_id: string;
  owner_id: string;
  page: number | null;
  content: string;
}

export interface PlanRow {
  id: string;
  owner_id: string;
  title: string;
  scope: 'single' | 'cumulative';
  goal: string;
  target_date: string | null;
}

export interface CardRow {
  id: string;
  topic_id: string;
  plan_id: string;
  source_chunk_id: string;
  page: number | null;
  question: string;
  answer: string;
  card_type: string;
}

export interface CardLinkRow {
  id: string;
  from_card_id: string;
  to_card_id: string;
  plan_id: string;
  created_by: string;
  relation: string;
  note: string | null;
}

export interface StoredObject {
  /** The file name inside the listed folder. */
  name: string;
  size: number;
  mimetype: string;
}

export interface CountedEnqueue {
  user_id: string;
  job: 'study_builder' | 'handwriting';
  stage: Stage;
  input: Record<string, unknown>;
  plan_id: string | null;
  source_id: string | null;
  /** The monthly limits for this stage (null = no limit for that tier). */
  free_limit: number | null;
  paid_limit: number | null;
  units: number;
}

/** approve_outline's writes, applied in one transaction (apply_outline_approval). */
export interface Approval {
  plan_id: string;
  /** Kept drafts: their final title and position; they become confirmed. */
  keep: { id: string; title: string; position: number }[];
  /** Cut drafts (a topic that is no longer a draft is never deleted). */
  cut: string[];
  /** Cards jobs to queue (derived ids: one that exists is left alone). */
  jobs: NewJob[];
  /** The outline jobs to mark approved. */
  outline_ids: string[];
  approved_at: string;
  /** Sources with nothing kept: they are ready. */
  ready_source_ids: string[];
}

export interface Store {
  // ---- the job queue (tracy_events) ----
  /**
   * claim_tracy_events: the oldest queued job, now running with its attempt counted; null when none
   * is queued or `maxRunning` jobs are running already (null = no limit).
   */
  claimJob(maxRunning: number | null): Promise<JobRow | null>;
  /** release_tracy_event: back to the queue without counting the attempt (its `releases` + 1). */
  releaseJob(fence: Fence): Promise<boolean>;
  /** Updates a claimed job only while it is still this run's (running, same attempts and lock). */
  finishJob(fence: Fence, patch: JobPatch): Promise<boolean>;
  getJob(id: string): Promise<JobRow | null>;
  /** Updates a job only while its status is one of `from`; returns the updated row or null. */
  updateJobIf(id: string, from: JobStatus[], patch: JobPatch): Promise<JobRow | null>;
  sourceJobs(sourceId: string): Promise<JobRow[]>;
  planJobs(planId: string, stage: Stage): Promise<JobRow[]>;
  /** Inserts a queued job with its derived id; false when that id exists already. */
  insertJob(job: NewJob): Promise<boolean>;
  /** enqueue_tracy_event with a monthly cap. */
  enqueueCounted(req: CountedEnqueue): Promise<{ ok: true; job: JobRow } | { ok: false; cap: CapReached }>;
  /**
   * requeue_tracy_event (retry_job): a failed or cancelled job back to the queue with fresh attempts;
   * job null when it is neither any more. A counted job whose units were given back (cancelled before
   * it ran) goes through the monthly cap again with these limits.
   */
  requeueJob(
    id: string,
    limits: { free_limit: number | null; paid_limit: number | null },
  ): Promise<{ ok: true; job: JobRow | null } | { ok: false; cap: CapReached }>;
  /** apply_outline_approval: all of approve_outline's writes, or none. */
  applyApproval(a: Approval): Promise<void>;
  hasQueuedJobs(): Promise<boolean>;

  // ---- sources, their files and Storage ----
  getSource(id: string): Promise<SourceRow | null>;
  insertSource(row: SourceRow): Promise<void>;
  setSourceStatus(id: string, status: SourceRow['status']): Promise<void>;
  deleteSource(id: string): Promise<void>;
  linkPlanSource(planId: string, sourceId: string): Promise<void>;
  planHasSource(planId: string, sourceId: string): Promise<boolean>;
  sourceFiles(sourceId: string): Promise<SourceFileRow[]>;
  /** Inserts file rows, ignoring ids that exist already. */
  insertSourceFiles(rows: Omit<SourceFileRow, 'transcript' | 'confirmed'>[]): Promise<void>;
  updateSourceFile(id: string, patch: Partial<Pick<SourceFileRow, 'transcript' | 'confirmed'>>): Promise<void>;
  /** The files in a folder of the `sources` bucket. */
  listFolder(prefix: string): Promise<StoredObject[]>;
  /** A signed download URL for a file of the `sources` bucket. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
  orphanedObjects(limit: number): Promise<string[]>;
  removeObjects(paths: string[]): Promise<void>;

  // ---- chunks ----
  /** Inserts or replaces chunks by id (an existing chunk keeps its embedding). */
  upsertChunks(rows: ChunkRow[]): Promise<void>;
  sourceChunks(sourceId: string): Promise<ChunkRow[]>;
  chunksByIds(ids: string[]): Promise<ChunkRow[]>;
  deleteSourceChunks(sourceId: string): Promise<void>;
  /** Chunks of a source without a vector, in id order after `afterId`. */
  chunksToEmbed(sourceId: string, afterId: string | null, limit: number): Promise<ChunkRow[]>;
  saveEmbeddings(rows: { chunk: ChunkRow; embedding: number[]; model: string }[]): Promise<void>;

  // ---- plans, topics, cards ----
  getPlan(id: string): Promise<PlanRow | null>;
  planTopics(planId: string): Promise<TopicRow[]>;
  getTopic(id: string): Promise<TopicRow | null>;
  /** Inserts topics, ignoring ids that exist already. */
  insertTopics(rows: TopicRow[]): Promise<void>;
  /** Sets a topic's status only while it is `from`. */
  setTopicStatusIf(id: string, from: TopicRow['status'], to: TopicRow['status']): Promise<void>;
  /** Up to `limit` cards of a plan, those of `topicId` first. */
  planCards(planId: string, topicId: string, limit: number): Promise<{ id: string; question: string }[]>;
  existingCardIds(ids: string[]): Promise<Set<string>>;
  /** Inserts cards and links, ignoring ids that exist already. */
  insertCards(rows: CardRow[]): Promise<void>;
  insertCardLinks(rows: CardLinkRow[]): Promise<void>;
}

/** Reads made as the calling user (RLS decides what they see). */
export interface UserView {
  plan(id: string): Promise<{ id: string; owner_id: string } | null>;
  source(id: string): Promise<{ id: string; owner_id: string } | null>;
  job(id: string): Promise<{ id: string; user_id: string } | null>;
}
