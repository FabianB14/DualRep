/**
 * The study function's five actions (contract: the comment at the top of index.ts). No Deno APIs:
 * index.ts passes the real Store / UserView; tests pass fakes.
 *
 * Pattern for each action: check ownership by reading as the user (RLS), check the state, write with
 * the service role for the verified user id, queue jobs, wake the worker. Every action is safe to send
 * twice (derived ids, "already done" answers), because the phone retries when a response is lost.
 */
import { chunkPageText } from '../_shared/chunker.ts';
import type { Caps } from '../_shared/config.ts';
import {
  type ApproveOutlineRequest,
  type ApproveOutlineResponse,
  type CapReachedBody,
  type ConfirmTranscriptsRequest,
  type ConfirmTranscriptsResponse,
  type JobRequest,
  type JobResponse,
  STUDY_LIMITS,
  StudyError,
  type StudyRequest,
  type StudyResponse,
  type SubmitSourceRequest,
  type SubmitSourceResponse,
} from '../_shared/contracts.ts';
import type { CapReached } from '../_shared/errors.ts';
import { afterJob, startOutline } from '../_shared/followups.ts';
import { outlineJobId, sourceFileId } from '../_shared/ids.ts';
import {
  cardsJobs,
  chunkRows,
  confirmGate,
  isSavedOutline,
  type JobRow,
  type NewJob,
  planApproval,
  type SavedOutline,
  stageOf,
} from '../_shared/pipeline.ts';
import type { Store, UserView } from '../_shared/store.ts';
import { parseFilePath } from '../_shared/validate.ts';

export interface StudyDeps {
  store: Store;
  user: UserView;
  /** The verified caller (JWT sub). */
  userId: string;
  config: { caps: Caps; geminiKey: string };
  /** Wakes the worker (fire and forget). */
  kick: () => Promise<unknown>;
  now?: () => Date;
}

export interface StudyResult {
  status: number;
  body: StudyResponse;
}

export function handleStudy(req: StudyRequest, deps: StudyDeps): Promise<StudyResult> {
  switch (req.action) {
    case 'submit_source':
      return submitSource(req, deps);
    case 'confirm_transcripts':
      return confirmTranscripts(req, deps);
    case 'approve_outline':
      return approveOutline(req, deps);
    case 'retry_job':
      return retryJob(req, deps);
    case 'cancel_job':
      return cancelJob(req, deps);
  }
}

// ---- ownership ----------------------------------------------------------------------------------

async function ownPlan(d: StudyDeps, planId: string) {
  const plan = await d.user.plan(planId);
  // Usually a plan made offline whose upload hasn't reached the server yet (the app waits and asks
  // again); otherwise it was deleted.
  if (!plan) throw new StudyError('not_found', 'This plan isn’t on the server yet. Wait a moment for it to sync, then try again.');
  if (plan.owner_id !== d.userId) throw new StudyError('forbidden', "Only the plan's owner can do this.");
}

async function ownSource(d: StudyDeps, sourceId: string) {
  const source = await d.user.source(sourceId);
  if (!source) throw new StudyError('not_found', 'This material was not found.');
  if (source.owner_id !== d.userId) throw new StudyError('forbidden', 'Only the owner of this material can do this.');
}

async function ownJob(d: StudyDeps, jobId: string): Promise<JobRow> {
  const visible = await d.user.job(jobId);
  if (!visible || visible.user_id !== d.userId) throw new StudyError('not_found', 'This step was not found.');
  const job = await d.store.getJob(jobId);
  if (!job) throw new StudyError('not_found', 'This step was not found.');
  return job;
}

function capError(cap: CapReached): StudyError {
  const what = cap.stage === 'transcribe' ? 'handwritten and scanned pages' : 'new material';
  const extra: Omit<CapReachedBody, 'ok' | 'code' | 'error'> = {
    stage: cap.stage,
    used: cap.used,
    limit: cap.limit,
    resets_at: cap.resets_at,
  };
  return new StudyError('cap_reached', `You've used this month's ${what}. It resets on the 1st.`, { extra });
}

// ---- submit_source ------------------------------------------------------------------------------

async function submitSource(r: SubmitSourceRequest, d: StudyDeps): Promise<StudyResult> {
  const { store, userId } = d;
  await ownPlan(d, r.plan_id);

  const existing = await store.getSource(r.source_id);
  const earlierJobs = existing ? await store.sourceJobs(existing.id) : [];
  if (existing) {
    if (existing.owner_id !== userId) throw new StudyError('conflict', 'This source id is already used.');
    if (existing.kind !== r.kind) throw new StudyError('conflict', 'This source id is already used.');
  }

  // The files must really be in the caller's folder, of the right type and size.
  const files = r.files.map((f) => parseFilePath(f.path, userId, r.source_id, r.kind)!);
  if (files.length) {
    const stored = new Map((await store.listFolder(`${userId}/${r.source_id}`)).map((o) => [o.name, o]));
    const errors: string[] = [];
    files.forEach((f, i) => {
      const o = stored.get(`${f.n}.${f.ext}`);
      if (!o) errors.push(`files[${i}] has not been uploaded`);
      else if (o.size > STUDY_LIMITS.maxFileBytes) errors.push(`files[${i}] is larger than 25 MiB`);
      else if (o.mimetype !== f.mime) errors.push(`files[${i}] was uploaded with the wrong content type`);
    });
    if (errors.length) throw new StudyError('bad_files', 'Some files are missing or not accepted.', { errors });
  }

  // Rows, written with the service role for the verified user. Each write tolerates a repeat.
  if (!existing) {
    await store.insertSource({
      id: r.source_id,
      owner_id: userId,
      kind: r.kind,
      title: r.title,
      url: r.kind === 'link' ? r.url : null,
      status: 'pending',
    });
  }
  await store.linkPlanSource(r.plan_id, r.source_id);
  const fileRows = await Promise.all(files.map(async (f) => ({
    id: await sourceFileId(r.source_id, f.n),
    source_id: r.source_id,
    owner_id: userId,
    storage_path: f.path,
    page: r.kind === 'notes' ? f.n : null,
  })));
  await store.insertSourceFiles(fileRows);

  // The first step, counted against the monthly caps. A repeated request queues only what is missing.
  const toQueue: { stage: 'extract' | 'transcribe'; input: Record<string, unknown> }[] = [];
  if (r.kind === 'notes') {
    const covered = new Set(earlierJobs.filter((j) => j.stage === 'transcribe').map((j) => j.input?.source_file_id));
    for (const f of [...fileRows].sort((a, b) => (a.page ?? 0) - (b.page ?? 0))) {
      if (!covered.has(f.id)) {
        toQueue.push({ stage: 'transcribe', input: { source_id: r.source_id, plan_id: r.plan_id, source_file_id: f.id } });
      }
    }
  } else if (!earlierJobs.some((j) => j.stage === 'extract')) {
    toQueue.push({ stage: 'extract', input: { source_id: r.source_id, plan_id: r.plan_id, kind: r.kind, cursor_page: 1 } });
  }
  if (existing && toQueue.length === 0) {
    return {
      status: 200,
      body: {
        ok: true,
        source_id: r.source_id,
        status: existing.status,
        job_ids: earlierJobs.filter((j) => j.stage === 'extract' || j.stage === 'transcribe').map((j) => j.id),
        already_submitted: true,
      } satisfies SubmitSourceResponse,
    };
  }

  const queued: string[] = [];
  for (const q of toQueue) {
    const caps = q.stage === 'transcribe' ? d.config.caps.pages : d.config.caps.sources;
    const res = await store.enqueueCounted({
      user_id: userId,
      job: q.stage === 'transcribe' ? 'handwriting' : 'study_builder',
      stage: q.stage,
      input: q.input,
      plan_id: r.plan_id,
      source_id: r.source_id,
      free_limit: caps.free,
      paid_limit: caps.paid,
      units: 1,
    });
    if (!res.ok) {
      // Keep nothing: give back what this request queued (a job cancelled before it ran costs
      // nothing) and remove the source unless an earlier request had queued work for it.
      for (const id of queued) await store.updateJobIf(id, ['queued'], { status: 'cancelled' });
      if (earlierJobs.length === 0) await store.deleteSource(r.source_id);
      throw capError(res.cap);
    }
    queued.push(res.job.id);
  }
  await store.setSourceStatus(r.source_id, 'processing');
  await d.kick();
  return {
    status: 202,
    body: {
      ok: true,
      source_id: r.source_id,
      status: 'processing',
      job_ids: [
        ...earlierJobs.filter((j) => j.stage === 'extract' || j.stage === 'transcribe').map((j) => j.id),
        ...queued,
      ],
      already_submitted: false,
    } satisfies SubmitSourceResponse,
  };
}

// ---- confirm_transcripts ------------------------------------------------------------------------

async function confirmTranscripts(r: ConfirmTranscriptsRequest, d: StudyDeps): Promise<StudyResult> {
  const { store, userId } = d;
  await ownPlan(d, r.plan_id);
  await ownSource(d, r.source_id);
  const source = await store.getSource(r.source_id);
  if (!source) throw new StudyError('not_found', 'This material was not found.');
  if (source.kind !== 'notes') throw new StudyError('not_ready', 'Only handwritten notes have transcripts to confirm.');
  if (!(await store.planHasSource(r.plan_id, r.source_id))) {
    throw new StudyError('conflict', 'This material is not part of this plan.');
  }

  const jobs = await store.sourceJobs(source.id);
  const outlineId = await outlineJobId(source.id);
  const embeddings = !!d.config.geminiKey;
  if (jobs.some((j) => j.id === outlineId)) {
    // Confirmed before (a repeated request): report what was queued then.
    const ids = jobs.filter((j) => j.id === outlineId || j.stage === 'embed').map((j) => j.id);
    const chunks = (await store.sourceChunks(source.id)).length;
    return { status: 200, body: { ok: true, source_id: source.id, chunks, job_ids: ids } satisfies ConfirmTranscriptsResponse };
  }
  const gate = confirmGate(jobs);
  if (!gate.ok) throw new StudyError('not_ready', gate.reason);

  const files = await store.sourceFiles(source.id);
  const known = new Set(files.map((f) => f.id));
  const errors = r.files.map((f, i) => (known.has(f.id) ? null : `files[${i}].id is not a file of this source`))
    .filter((e): e is string => e !== null);
  if (errors.length) throw new StudyError('bad_request', 'The request is not valid.', { errors });
  const edits = new Map(r.files.map((f) => [f.id, f.transcript]));

  // The passages, from the transcripts as the person confirmed them (page = the photo's number).
  const ordered = [...files].sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  const texts = ordered.map((f, i) => ({ file: f, page: f.page ?? i + 1, text: edits.get(f.id) ?? f.transcript ?? '' }));
  const drafts = texts.flatMap((t) =>
    chunkPageText(t.text).map((c, ordinal) => ({ page: t.page, ordinal, content: c.content }))
  );
  if (!drafts.length) {
    throw new StudyError('no_text', 'There is nothing to study in these pages yet. Type the notes into the transcript first.');
  }

  for (const t of texts) {
    await store.updateSourceFile(t.file.id, { ...(edits.has(t.file.id) ? { transcript: t.text } : {}), confirmed: true });
  }
  // Replace any passages from an earlier, interrupted confirmation.
  await store.deleteSourceChunks(source.id);
  await store.upsertChunks(await chunkRows(source.id, source.owner_id, drafts));
  const ids = await startOutline(store, { userId, planId: r.plan_id, sourceId: source.id, embeddings });
  await d.kick();
  return {
    status: 202,
    body: { ok: true, source_id: source.id, chunks: drafts.length, job_ids: ids } satisfies ConfirmTranscriptsResponse,
  };
}

// ---- approve_outline ----------------------------------------------------------------------------

async function approveOutline(r: ApproveOutlineRequest, d: StudyDeps): Promise<StudyResult> {
  const { store, userId } = d;
  await ownPlan(d, r.plan_id);
  if (r.source_id) {
    await ownSource(d, r.source_id);
    if (!(await store.planHasSource(r.plan_id, r.source_id))) {
      throw new StudyError('conflict', 'This material is not part of this plan.');
    }
  }
  const finished = (await store.planJobs(r.plan_id, 'outline')).filter((j) =>
    j.status === 'succeeded' && j.user_id === userId && isSavedOutline(j.output)
  );
  const outlines = finished.filter((j) => !r.source_id || j.source_id === r.source_id);
  const pending = outlines.filter((j) => !(j.output as SavedOutline).approved_at);

  if (!pending.length) {
    const approved = outlines.filter((j) => (j.output as SavedOutline).approved_at);
    if (!approved.length) throw new StudyError('not_ready', 'There is no outline to review yet.');
    // Approved before (a repeated request): report the cards jobs that were queued then.
    const sourceIds = [...new Set(approved.map((j) => j.source_id).filter((s): s is string => !!s))];
    const jobIds: string[] = [];
    for (const s of sourceIds) jobIds.push(...(await store.sourceJobs(s)).filter((j) => j.stage === 'cards').map((j) => j.id));
    return {
      status: 200,
      body: {
        ok: true,
        plan_id: r.plan_id,
        source_ids: sourceIds,
        kept: 0,
        cut: 0,
        job_ids: jobIds,
        already_approved: true,
      } satisfies ApproveOutlineResponse,
    };
  }

  const topics = await store.planTopics(r.plan_id);
  // The phone sends every draft topic of the plan (it cannot tell which outline made which). A draft
  // whose outline job is not finished (its final write failed after the drafts were saved, and it is
  // failed or being retried) is set aside untouched, instead of refusing the whole review: it is
  // reviewed with its outline once that job succeeds.
  const reviewable = new Set(
    finished.filter((j) => !(j.output as SavedOutline).approved_at)
      .flatMap((j) => (j.output as SavedOutline).topics.map((t) => t.topic_id))
      .filter((id): id is string => !!id),
  );
  const unfinished = new Set(topics.filter((t) => t.status === 'draft' && !reviewable.has(t.id)).map((t) => t.id));
  const decisions = r.topics.filter((d) => !unfinished.has(d.id));
  const plan = planApproval(pending.map((j) => ({ job: j, saved: j.output as SavedOutline })), topics, decisions);
  if (plan.errors.length) throw new StudyError('bad_request', 'The request is not valid.', { errors: plan.errors });

  const jobs: NewJob[] = [];
  for (const entry of plan.cards) jobs.push(...(await cardsJobs(userId, r.plan_id, entry)));
  const sourceIds = [...new Set(pending.map((j) => j.source_id).filter((s): s is string => !!s))];
  // Every write in one transaction. A request cut short changes nothing, so the drafts stay on the
  // phone's review screen and the person can send it again. (Written one call at a time, a failure
  // halfway left kept topics confirmed with no cards job and the outline unapproved, and the review
  // screen, which lists drafts only, had nothing left to send.)
  await store.applyApproval({
    plan_id: r.plan_id,
    keep: plan.keep,
    cut: plan.cut,
    jobs,
    outline_ids: pending.map((o) => o.id),
    approved_at: (d.now ?? (() => new Date()))().toISOString(),
    // Nothing kept from this source's outline: it is done.
    ready_source_ids: sourceIds.filter((s) => !jobs.some((j) => j.source_id === s)),
  });
  if (jobs.length) await d.kick();
  return {
    status: jobs.length ? 202 : 200,
    body: {
      ok: true,
      plan_id: r.plan_id,
      source_ids: sourceIds,
      kept: plan.keep.length,
      cut: plan.cut.length,
      job_ids: jobs.map((j) => j.id),
      already_approved: false,
    } satisfies ApproveOutlineResponse,
  };
}

// ---- retry_job / cancel_job ---------------------------------------------------------------------

async function retryJob(r: JobRequest, d: StudyDeps): Promise<StudyResult> {
  const { store } = d;
  const job = await ownJob(d, r.job_id);
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw new StudyError('not_ready', 'Only a step that failed or was cancelled can be tried again.');
  }
  const stage = stageOf(job);
  if (!stage) throw new StudyError('not_ready', "This step can't be tried again here.");
  if ((stage === 'extract' || stage === 'transcribe') && job.source_id) {
    // Once the outline is under way, new passages would belong to no topic.
    const outline = (await store.sourceJobs(job.source_id)).find((j) => j.stage === 'outline');
    if (outline && ['queued', 'running', 'succeeded'].includes(outline.status)) {
      throw new StudyError('not_ready', 'This material has moved on to its outline, so this step can no longer be repeated.');
    }
  }
  if (stage === 'cards' && typeof job.input?.topic_id === 'string' && !(await store.getTopic(job.input.topic_id))) {
    throw new StudyError('not_ready', 'The topic of this step was deleted.');
  }
  // The same job goes back to the queue with three fresh attempts. Its cap units count already,
  // unless it was cancelled before it ever ran (they were given back): then it goes through the
  // monthly limit again, or "cancel, add more, retry" would get past it.
  const caps = stage === 'transcribe' ? d.config.caps.pages : stage === 'extract' ? d.config.caps.sources : null;
  const res = await store.requeueJob(job.id, { free_limit: caps?.free ?? null, paid_limit: caps?.paid ?? null });
  if (!res.ok) throw capError(res.cap);
  if (!res.job) throw new StudyError('not_ready', 'Only a step that failed or was cancelled can be tried again.');
  if (job.source_id && (stage === 'extract' || stage === 'outline' || stage === 'transcribe')) {
    const source = await store.getSource(job.source_id);
    if (source?.status === 'failed') await store.setSourceStatus(source.id, 'processing');
  }
  await d.kick();
  return { status: 202, body: { ok: true, job_id: job.id, status: 'queued' } satisfies JobResponse };
}

async function cancelJob(r: JobRequest, d: StudyDeps): Promise<StudyResult> {
  const { store } = d;
  const job = await ownJob(d, r.job_id);
  // queued/running: stop it (a running step's worker loses its fence and writes nothing more to the
  // job). failed: skip it (a page that can't be transcribed must not hold up the rest).
  if (!['queued', 'running', 'failed'].includes(job.status)) {
    throw new StudyError('not_ready', 'This step has already finished.');
  }
  const updated = await store.updateJobIf(job.id, ['queued', 'running', 'failed'], { status: 'cancelled', locked_at: null, error: null });
  if (!updated) throw new StudyError('not_ready', 'This step has already finished.');
  const stage = stageOf(updated);
  if (stage) {
    const queued = await afterJob(store, updated, stage, 'cancelled', { embeddings: !!d.config.geminiKey });
    if (queued.length) await d.kick();
  }
  return { status: 200, body: { ok: true, job_id: job.id, status: 'cancelled' } satisfies JobResponse };
}
