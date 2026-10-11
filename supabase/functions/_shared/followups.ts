/**
 * What happens after a job ends, shared by the worker (a step finished) and the study function (the
 * person cancelled or retried a step). Every action here is safe to repeat: follow-up jobs have
 * derived ids (a second insert is a no-op) and status changes are idempotent. That is what lets the
 * worker run these both before and after it writes a job's final status (so neither a crash in
 * between nor two jobs finishing at the same moment can leave a source stuck).
 */
import { embedJobId, outlineJobId } from './ids.ts';
import {
  cardsProgress,
  failsSource,
  type JobRow,
  type JobStatus,
  type NewJob,
  outlineGate,
  type Stage,
} from './pipeline.ts';
import type { Store } from './store.ts';

/** Treats one job as having this status (the job about to be finished by the caller). */
export type StatusOverride = { id: string; status: JobStatus } | null;

const withOverride = <T extends Pick<JobRow, 'id' | 'status'>>(jobs: T[], o: StatusOverride): T[] =>
  o ? jobs.map((j) => (j.id === o.id ? { ...j, status: o.status } : j)) : jobs;

/**
 * Queues the outline job of a source (and its embedding job when embeddings are on). Returns the
 * ids; inserting an id that exists already does nothing.
 */
export async function startOutline(
  store: Store,
  opts: { userId: string; planId: string; sourceId: string; embeddings: boolean },
): Promise<string[]> {
  const jobs: NewJob[] = [{
    id: await outlineJobId(opts.sourceId),
    user_id: opts.userId,
    job: 'study_builder',
    stage: 'outline',
    plan_id: opts.planId,
    source_id: opts.sourceId,
    input: { source_id: opts.sourceId, plan_id: opts.planId },
  }];
  if (opts.embeddings) {
    jobs.push({
      id: await embedJobId(opts.sourceId),
      user_id: opts.userId,
      job: 'study_builder',
      stage: 'embed',
      plan_id: opts.planId,
      source_id: opts.sourceId,
      input: { source_id: opts.sourceId, after_chunk_id: null },
    });
  }
  for (const job of jobs) await store.insertJob(job);
  return jobs.map((j) => j.id);
}

/**
 * pdf, doc and link sources: starts the outline once extraction and every page transcription are
 * done (see outlineGate). Returns the ids it queued (none when it is not time yet).
 */
export async function maybeStartOutline(
  store: Store,
  opts: { sourceId: string; planId: string | null; embeddings: boolean; override?: StatusOverride },
): Promise<string[]> {
  const source = await store.getSource(opts.sourceId);
  if (!source || source.kind === 'notes' || !opts.planId) return [];
  const jobs = withOverride(await store.sourceJobs(source.id), opts.override ?? null);
  const gate = outlineGate(jobs, await outlineJobId(source.id));
  if (gate !== 'ready') return [];
  return await startOutline(store, {
    userId: source.owner_id,
    planId: opts.planId,
    sourceId: source.id,
    embeddings: opts.embeddings,
  });
}

/**
 * After a cards job ends (any way): its topic becomes ready once none of its cards jobs is open and
 * at least one succeeded; the source becomes ready once none of its cards jobs is open.
 */
export async function afterCards(store: Store, job: JobRow, override: StatusOverride = null): Promise<void> {
  const topicId = typeof job.input?.topic_id === 'string' ? job.input.topic_id : null;
  const sourceId = job.source_id ?? (typeof job.input?.source_id === 'string' ? job.input.source_id : null);
  if (!topicId || !sourceId) return;
  const jobs = withOverride(await store.sourceJobs(sourceId), override);
  const { topicDone, sourceDone } = cardsProgress(jobs, topicId);
  const topicMadeCards = jobs.some((j) => j.stage === 'cards' && j.input?.topic_id === topicId && j.status === 'succeeded');
  if (topicDone && topicMadeCards) await store.setTopicStatusIf(topicId, 'confirmed', 'ready');
  if (sourceDone) {
    const source = await store.getSource(sourceId);
    if (source && source.status !== 'ready') await store.setSourceStatus(sourceId, 'ready');
  }
}

/**
 * Everything that follows a job of `stage` ending with `status`. `override` makes the gates see the
 * job's new status before it is written.
 */
export async function afterJob(
  store: Store,
  job: JobRow,
  stage: Stage,
  status: 'succeeded' | 'failed' | 'cancelled',
  opts: { embeddings: boolean; override?: StatusOverride },
): Promise<string[]> {
  const sourceId = job.source_id ?? (typeof job.input?.source_id === 'string' ? job.input.source_id : null);
  if (!sourceId) return [];
  const planId = job.plan_id ?? (typeof job.input?.plan_id === 'string' ? job.input.plan_id : null);
  const override = opts.override ?? null;
  if (stage === 'cards') {
    await afterCards(store, job, override);
    return [];
  }
  if (status !== 'succeeded' && failsSource(stage)) {
    const source = await store.getSource(sourceId);
    if (source && source.status !== 'ready') await store.setSourceStatus(sourceId, 'failed');
    return [];
  }
  // A finished extraction or a finished/skipped page transcription may be the last thing the outline
  // was waiting for. (A failed transcription keeps it waiting: the person retries or skips it.)
  if ((stage === 'extract' && status === 'succeeded') || (stage === 'transcribe' && status !== 'failed')) {
    return await maybeStartOutline(store, { sourceId, planId, embeddings: opts.embeddings, override });
  }
  return [];
}
