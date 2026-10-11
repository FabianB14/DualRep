/**
 * "What's next" for each source of a plan, derived on the phone from synced rows only (pure).
 *
 * The pipeline (the `study` function and the tracy-worker) leaves its traces in rows the phone
 * already has: sources.status, source_files (transcript, confirmed), topics.status, and the light
 * columns of tracy_events (stage, status, error, source_id). From them:
 *   failed job                 → the error, with Try again (study.retry_job)
 *   reading (extract/transcribe jobs open)
 *   every photo transcribed, some not confirmed → "Check the transcription"
 *   outline job open           → "Making the outline"
 *   outline done, no cards jobs yet → "Review the outline"
 *   cards jobs open            → "Making cards (n of m)"
 *   source ready               → done
 * Embedding jobs are optional background work: they never show and never block.
 *
 * A failed extraction or outline job counts until a later job of its stage (the next window of a
 * long PDF) is queued, running or done. A failed page transcription or cards job counts until it is
 * retried (or, a page, skipped): those are one job per page or per topic, so another page's or
 * topic's success never covers it. Try again (retry_job) puts the same job back in the queue. A
 * cancelled job is a skipped page (transcription) or a stopped step (the source is then failed, and
 * Try again restarts that job). Notes whose every page was skipped have nothing left to read: that
 * is a failure too, with Try again on the last skipped page. The last page that is not skipped can't
 * be skipped (it would leave the notes with nothing). Contract: supabase/functions/study/index.ts,
 * "What the phone follows".
 */

export type ProgressSource = { id: string; kind: string | null; status: string | null; title: string | null };
export type ProgressFile = { id: string; transcript: string | null; confirmed: boolean };
export type ProgressJob = {
  id: string;
  stage: string | null;
  status: string | null;
  error: string | null;
  /** Epoch ms or ISO; only the order matters. */
  createdAt: string | number | null;
};

export type SourceStep =
  /**
   * A step failed (its error, with Try again = retry_job on `jobId`), or the source was stopped. A
   * failed page transcription can also be skipped (`canSkip`: cancel_job on the same job).
   */
  | { step: 'failed'; message: string; jobId: string | null; canSkip: boolean }
  | { step: 'waiting' }
  | { step: 'reading'; done: number; total: number }
  | { step: 'check_transcripts'; unconfirmed: number }
  | { step: 'outlining' }
  | { step: 'review_outline'; draftTopics: number }
  | { step: 'making_cards'; done: number; total: number }
  | { step: 'ready' };

const OPEN = new Set(['queued', 'running']);

function order(value: string | number | null): number {
  if (typeof value === 'number') return value;
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export const GENERIC_ERROR = 'Something went wrong while preparing this material.';
export const STOPPED_MESSAGE = 'Stopped before it was finished.';
export const ALL_SKIPPED_MESSAGE = 'Every page was skipped, so there is nothing to study yet.';
/** Stages with one job per page or topic: a failure stands until that job itself is retried. */
const PER_ITEM_STAGES = new Set(['transcribe', 'cards']);

/**
 * The step a source is at. `draftTopics` = draft topics in the plan (they wait for the outline
 * review; the phone cannot tell which source a draft came from, and the outline review covers all).
 */
export function sourceStep(
  source: ProgressSource,
  files: readonly ProgressFile[],
  jobs: readonly ProgressJob[],
  draftTopics: number,
): SourceStep {
  const all = jobs.filter((job) => job.stage !== 'embed').sort((a, b) => order(a.createdAt) - order(b.createdAt));
  // A cancelled job is out of the way: a skipped page, or a stopped step (then the source is failed).
  const live = all.filter((job) => job.status !== 'cancelled');
  const ofStage = (stage: string) => live.filter((job) => job.stage === stage);
  const open = (list: ProgressJob[]) => list.filter((job) => OPEN.has(job.status ?? ''));
  const succeeded = (list: ProgressJob[]) => list.filter((job) => job.status === 'succeeded');

  // A failure stands until a later job of its stage is open or done; page transcriptions and cards
  // are one job per page or topic, so another page's or topic's success never covers a failed one.
  const failed = [...live].reverse().find(
    (job) =>
      job.status === 'failed' &&
      (PER_ITEM_STAGES.has(job.stage ?? '') ||
        !live.some((later) => later.stage === job.stage && later.status !== 'failed' && order(later.createdAt) > order(job.createdAt))),
  );
  if (failed) {
    // Skipping a page is offered while another page of the notes is still in (skipping the last one
    // would leave nothing to study); a scanned PDF's text stays whatever is skipped.
    const otherPage = live.some((job) => job.stage === 'transcribe' && job.id !== failed.id);
    const canSkip = failed.stage === 'transcribe' && (source.kind !== 'notes' || otherPage);
    return { step: 'failed', message: failed.error?.trim() || GENERIC_ERROR, jobId: failed.id, canSkip };
  }
  if (source.status === 'failed') {
    // Stopped (cancel_job on its extraction or outline): Try again puts that job back in the queue.
    const stopped = [...all].reverse().find((job) => job.status === 'cancelled' && job.stage !== 'transcribe');
    return { step: 'failed', message: stopped ? STOPPED_MESSAGE : GENERIC_ERROR, jobId: stopped?.id ?? null, canSkip: false };
  }

  const cards = ofStage('cards');
  if (source.status === 'ready' && open(cards).length === 0) return { step: 'ready' };

  const transcribe = all.filter((job) => job.stage === 'transcribe');
  const skipped = transcribe.filter((job) => job.status === 'cancelled').length;
  if (open(transcribe).length > 0) {
    const finished = succeeded(transcribe).length + skipped;
    const total = source.kind === 'notes' ? Math.max(files.length, transcribe.length) : transcribe.length;
    return { step: 'reading', done: finished, total };
  }
  if (open(ofStage('extract')).length > 0) return { step: 'reading', done: 0, total: 0 };

  const outline = ofStage('outline');
  if (source.kind === 'notes' && outline.length === 0 && files.length > 0) {
    const transcribed = files.filter((file) => file.transcript !== null);
    if (transcribed.length === 0 && skipped > 0 && skipped >= files.length) {
      // Every page skipped: Try again puts the last one back (retry_job takes a cancelled job).
      const last = [...transcribe].reverse().find((job) => job.status === 'cancelled');
      return { step: 'failed', message: ALL_SKIPPED_MESSAGE, jobId: last?.id ?? null, canSkip: false };
    }
    // A page whose transcription was skipped has no transcript and never will.
    const allRead = files.length - transcribed.length <= skipped;
    if (!allRead) return { step: 'reading', done: transcribed.length + skipped, total: files.length };
    const unconfirmed = transcribed.filter((file) => !file.confirmed).length;
    if (unconfirmed > 0) return { step: 'check_transcripts', unconfirmed };
  }

  if (open(outline).length > 0) return { step: 'outlining' };
  if (cards.length === 0 && succeeded(outline).length > 0) return { step: 'review_outline', draftTopics: Math.max(0, draftTopics) };
  if (open(cards).length > 0) return { step: 'making_cards', done: succeeded(cards).length, total: cards.length };
  if (cards.length > 0) return { step: 'ready' };

  if (live.length === 0 && (source.status === 'pending' || source.status === null)) return { step: 'waiting' };
  return { step: 'reading', done: 0, total: 0 };
}

/**
 * A note the pipeline left on a finished step (a succeeded job's `error`, e.g. scanned pages skipped
 * because the monthly page limit was used up), newest first; null when there is none.
 */
export function sourceNote(jobs: readonly ProgressJob[]): string | null {
  const noted = jobs
    .filter((job) => job.status === 'succeeded' && typeof job.error === 'string' && job.error.trim() !== '')
    .sort((a, b) => order(b.createdAt) - order(a.createdAt));
  return noted[0]?.error?.trim() ?? null;
}

export type StepText = {
  title: string;
  /** A second line, or null. */
  detail: string | null;
  /** The action the step offers: the screen decides the button's place. */
  action: 'retry' | 'check_transcripts' | 'review_outline' | null;
  tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success';
};

/** The step in plain words. */
export function describeStep(step: SourceStep): StepText {
  switch (step.step) {
    case 'failed':
      return { title: 'Couldn’t finish', detail: step.message, action: step.jobId ? 'retry' : null, tone: 'danger' };
    case 'waiting':
      return { title: 'Waiting to start', detail: null, action: null, tone: 'neutral' };
    case 'reading':
      return {
        title: 'Reading your material',
        detail: step.total > 0 ? `${step.done} of ${step.total} done` : null,
        action: null,
        tone: 'info',
      };
    case 'check_transcripts':
      return {
        title: 'Check the transcription',
        detail: step.unconfirmed === 1 ? '1 page to check' : `${step.unconfirmed} pages to check`,
        action: 'check_transcripts',
        tone: 'warning',
      };
    case 'outlining':
      return { title: 'Making the outline', detail: null, action: null, tone: 'info' };
    case 'review_outline':
      return {
        title: 'Review the outline',
        detail: step.draftTopics === 1 ? '1 new topic' : step.draftTopics > 1 ? `${step.draftTopics} new topics` : null,
        action: 'review_outline',
        tone: 'warning',
      };
    case 'making_cards':
      return { title: `Making cards (${step.done} of ${step.total})`, detail: null, action: null, tone: 'info' };
    case 'ready':
      return { title: 'Ready', detail: null, action: null, tone: 'success' };
  }
}

export type PlanNextStep =
  | { kind: 'check_transcripts'; sourceId: string; unconfirmed: number }
  | { kind: 'review_outline'; sourceId: string }
  | { kind: 'retry'; sourceId: string; jobId: string | null; message: string; canSkip: boolean }
  | { kind: 'study' }
  | { kind: 'working'; sourceId: string }
  | { kind: 'add_material' };

/**
 * The plan's one next step (one primary action per screen): what needs the user first (checking a
 * transcription, reviewing an outline, a failure), then studying when there are cards, then waiting
 * for the material being prepared, else adding material.
 */
export function planNextStep(steps: readonly { sourceId: string; step: SourceStep }[], cardCount: number): PlanNextStep {
  for (const { sourceId, step } of steps) {
    if (step.step === 'check_transcripts') return { kind: 'check_transcripts', sourceId, unconfirmed: step.unconfirmed };
  }
  for (const { sourceId, step } of steps) if (step.step === 'review_outline') return { kind: 'review_outline', sourceId };
  for (const { sourceId, step } of steps) {
    if (step.step === 'failed') return { kind: 'retry', sourceId, jobId: step.jobId, message: step.message, canSkip: step.canSkip };
  }
  if (cardCount > 0) return { kind: 'study' };
  const working = steps.find(({ step }) => step.step !== 'ready');
  if (working) return { kind: 'working', sourceId: working.sourceId };
  return { kind: 'add_material' };
}
