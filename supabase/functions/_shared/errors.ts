/**
 * What a failed call means for a job, and the short message the phone shows.
 *
 * tracy_events.error syncs to the phone and appears next to "Try again", so every message here is a
 * fixed English sentence: it never contains the person's material, a URL, a model's words or an
 * upstream error text (Tracy's own error strings are content-free too, but they are not shown).
 *
 *   fail     the step cannot succeed as it is (a bad file, a refusal): the job fails now.
 *   retry    worth another attempt (network, timeout, a 5xx, an answer the validator rejected): the job
 *            goes back to the queue, up to MAX_ATTEMPTS; `previousErrors` go to Tracy next time.
 *   release  Tracy did no work on it (it said it is busy with another heavy job): put the job back
 *            without counting the attempt and stop until the next cron tick. The worker also releases
 *            a job whose /health check fails (Render's free service asleep), before any call.
 * Render's own HTML 502/503/504 page after a passing /health check is NOT a release: the request
 * reached Tracy and Tracy died or restarted under it (often out of memory on the free plan). It is
 * counted like any other failure, so a file that crashes Tracy fails after three attempts instead
 * of crashing it every minute for ever.
 */
import type { Stage } from './pipeline.ts';

export type FailureAction =
  | { action: 'fail'; message: string }
  | { action: 'retry'; message: string; previousErrors?: string[] }
  | { action: 'release'; reason: string };

/** How a call to Tracy (or Gemini) went wrong. */
export type CallFailure =
  | { kind: 'network' } // DNS, connection reset, …
  | { kind: 'timeout' }
  | { kind: 'not_json'; status: number } // an error page in front of the service
  | { kind: 'http'; status: number; code: string | null; errors?: string[] };

export const MESSAGES = {
  notSetUp: "The study builder isn't set up yet. Try again later.",
  tracyBusy: "Tracy couldn't finish this step. Try again.",
  tracySlow: "Tracy didn't answer in time. Try again.",
  tooLarge: 'The file is too large to read.',
  pageTooDetailed: 'A page here was scanned at too high a resolution to read. Skip it to carry on.',
  unsupported: "This file type can't be read.",
  encrypted: 'This PDF is password-protected. Upload a copy without a password.',
  pdfUnreadable: "This PDF couldn't be read.",
  docUnreadable: "This document couldn't be read.",
  noText: 'No readable text was found.',
  pageCapUsed: "This month's page limit is used up, so the scanned pages weren't read.",
  linkUnusable: "This link can't be used. Use a public https web page.",
  linkUnreachable: "The web page couldn't be downloaded.",
  pageMissing: "A page couldn't be found in the PDF.",
  refused: 'Tracy declined to work on this material.',
  tooLong: 'This part was too long to process. Try again.',
  tracyUnreachable: "Tracy couldn't be reached for a while. Try again later.",
  badAnswer: "Tracy's answer didn't pass the checks. Try again.",
  sourceGone: 'The material was deleted.',
  topicGone: 'The topic was deleted.',
  fileMissing: "The uploaded file couldn't be found.",
  embedFailed: "Search data couldn't be made for this material.",
  unknownJob: "This kind of job isn't handled here.",
  timedOut: 'This step took too long. Try again.',
} as const;

/** Classifies a failed Tracy call made for a job of `stage` (kind = the source's kind). */
export function classifyTracyFailure(
  f: CallFailure,
  ctx: { stage: Stage; kind?: string | null },
): FailureAction {
  if (f.kind === 'network') return { action: 'retry', message: MESSAGES.tracyBusy };
  if (f.kind === 'timeout') return { action: 'retry', message: MESSAGES.tracySlow };
  if (f.kind === 'not_json') {
    // Render's HTML page: Tracy went down while it had the request (see the top of this file).
    if ([502, 503, 504].includes(f.status)) return { action: 'retry', message: MESSAGES.tracyBusy };
    // Express's own "Cannot POST" page: the Tracy on Render predates the DualRep lane (its pull
    // request isn't merged or deployed yet). Asking again won't help until it is.
    if (f.status === 404 || f.status === 405) return { action: 'fail', message: MESSAGES.notSetUp };
    return { action: 'retry', message: MESSAGES.tracyBusy };
  }
  const { status, code } = f;
  const link = ctx.kind === 'link';
  if (status === 401 || status === 403) return { action: 'fail', message: MESSAGES.notSetUp };
  switch (code) {
    case 'bad_url':
      // For a Storage file this means DUALREP_STORAGE_HOSTS on Render does not list this project.
      return { action: 'fail', message: link ? MESSAGES.linkUnusable : MESSAGES.notSetUp };
    case 'page_too_large':
      // Tracy couldn't render a scanned page in the memory it has left (a 600 dpi or 24 MP page
      // needs about 340 MB of the free plan's 512), or the page's image is over the API's limit.
      // The file itself is fine. Retried: the room depends on what Tracy holds at that moment, and
      // the render fails before the model is asked, so a retry costs no API call. After the third
      // attempt it fails, and skipping this batch lets the rest of the material carry on.
      return { action: 'retry', message: MESSAGES.pageTooDetailed };
    case 'too_large':
      // From a page transcription it means the same (a Tracy from before page_too_large existed
      // killed the render with this code): the file was read already, at extract.
      return ctx.stage === 'transcribe'
        ? { action: 'retry', message: MESSAGES.pageTooDetailed }
        : { action: 'fail', message: MESSAGES.tooLarge };
    case 'unsupported_type':
      return { action: 'fail', message: MESSAGES.unsupported };
    case 'pdf_encrypted':
      return { action: 'fail', message: MESSAGES.encrypted };
    case 'pdf_unreadable':
      return { action: 'fail', message: MESSAGES.pdfUnreadable };
    case 'doc_unreadable':
      return { action: 'fail', message: MESSAGES.docUnreadable };
    case 'no_text':
      return { action: 'fail', message: MESSAGES.noText };
    case 'page_out_of_range':
      return { action: 'fail', message: MESSAGES.pageMissing };
    case 'fetch_failed':
    case 'timeout':
      // A web page that can't be fetched won't get better by itself; a signed Storage URL may.
      return link
        ? { action: 'fail', message: MESSAGES.linkUnreachable }
        : { action: 'retry', message: MESSAGES.fileMissing };
    case 'refused':
      return { action: 'fail', message: MESSAGES.refused };
    case 'truncated':
      // Asking again with this note makes the model answer more briefly.
      return {
        action: 'retry',
        message: MESSAGES.tooLong,
        previousErrors: ['The previous answer was cut off at the length limit. Answer more briefly.'],
      };
    case 'invalid_output':
    case 'no_output':
      return {
        action: 'retry',
        message: MESSAGES.badAnswer,
        previousErrors: (f.errors ?? []).filter((e) => typeof e === 'string').slice(0, 50)
          .map((e) => e.slice(0, 500)),
      };
    case 'bad_input':
    case 'unknown_task':
      // Our request was wrong: retrying would send the same thing. Logged by the worker (code only).
      return { action: 'fail', message: MESSAGES.tracyBusy };
  }
  // Tracy runs one PDF read or page render at a time and turned this one away before starting.
  if (status === 503 && code === 'busy') return { action: 'release', reason: 'tracy_busy' };
  if (status === 503 && code && /unavailable$/.test(code)) {
    return { action: 'retry', message: MESSAGES.tracyBusy };
  }
  if (status >= 500) return { action: 'retry', message: MESSAGES.tracyBusy };
  if (status === 429) return { action: 'retry', message: MESSAGES.tracyBusy };
  return { action: 'fail', message: MESSAGES.tracyBusy };
}

/** Gemini (embeddings): only network trouble, rate limits and 5xx are worth retrying. */
export function classifyGeminiFailure(f: CallFailure): FailureAction {
  if (f.kind === 'network' || f.kind === 'timeout') return { action: 'retry', message: MESSAGES.embedFailed };
  const status = f.status;
  if (status === 429 || status >= 500) return { action: 'retry', message: MESSAGES.embedFailed };
  return { action: 'fail', message: MESSAGES.embedFailed };
}

/** A Postgres/PostgREST error as supabase-js reports it. */
export interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

export interface CapReached {
  stage: 'extract' | 'transcribe';
  used: number;
  limit: number;
  resets_at: string;
}

/**
 * enqueue_tracy_event's "monthly limit reached" (P0001, hint dualrep_cap_reached, JSON detail), or
 * null for any other error.
 */
export function parseCapReached(
  err: DbError | null | undefined,
  fallbackStage: CapReached['stage'],
  now: Date = new Date(),
): CapReached | null {
  if (!err || err.hint !== 'dualrep_cap_reached') return null;
  try {
    const d = JSON.parse(err.details ?? '');
    if (
      (d.stage === 'extract' || d.stage === 'transcribe') && Number.isFinite(d.used) &&
      Number.isFinite(d.limit) && typeof d.resets_at === 'string'
    ) {
      return { stage: d.stage, used: d.used, limit: d.limit, resets_at: d.resets_at };
    }
  } catch {
    // fall through: a cap error with an unreadable detail still is a cap error
  }
  return { stage: fallbackStage, used: 0, limit: 0, resets_at: nextMonthUtc(now) };
}

/** The first moment of next month, UTC, as an ISO string with milliseconds. */
export function nextMonthUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}
