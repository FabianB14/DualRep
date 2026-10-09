/**
 * The `study` Edge Function's request and response shapes, its error codes and the limits it
 * enforces. Pure TypeScript (no Deno or npm imports): the function, its tests and the worker share it,
 * and the app's client (src/features/study/studyApi.ts) mirrors it by hand. The human-readable
 * version of the same contract is the comment at the top of supabase/functions/study/index.ts; keep
 * the two in step.
 */

export const SOURCE_KINDS = ['pdf', 'doc', 'link', 'notes'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const STUDY_ACTIONS = [
  'submit_source',
  'confirm_transcripts',
  'approve_outline',
  'retry_job',
  'cancel_job',
] as const;
export type StudyAction = (typeof STUDY_ACTIONS)[number];

/** Limits the function checks (the Storage bucket enforces the byte limit and MIME list too). */
export const STUDY_LIMITS = {
  /** = the `sources` bucket's file_size_limit (25 MiB). */
  maxFileBytes: 25 * 1024 * 1024,
  /** Photos in one notes source. */
  maxNotePhotos: 20,
  maxTitleChars: 200,
  maxUrlChars: 2048,
  /** A transcript as Tracy may write it (dualrep_transcribe_* validators). */
  maxTranscriptChars: 20000,
  /** A topic title as the outline validator accepts it. */
  maxTopicTitleChars: 120,
  /** Topics in one approve_outline request (40 per outline is Tracy's maximum; several outlines). */
  maxApproveTopics: 400,
} as const;

/**
 * The file types each kind accepts: file name extension -> the MIME type Storage must hold for it.
 * Files are named `<n>.<ext>`, n = the 1-based file number (= the page of a notes photo).
 */
export const KIND_FILE_TYPES: Record<SourceKind, Record<string, string>> = {
  pdf: { pdf: 'application/pdf' },
  doc: { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  notes: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
  link: {},
};

// ---- Requests -----------------------------------------------------------------------------------

export interface UploadedFile {
  /** `<user_id>/<source_id>/<n>.<ext>` in the `sources` bucket. */
  path: string;
}

export interface SubmitSourceRequest {
  action: 'submit_source';
  plan_id: string;
  /** Made on the phone; it is also the Storage folder the files were uploaded to. */
  source_id: string;
  kind: SourceKind;
  title: string;
  /** https URL, for kind 'link' only (null otherwise). */
  url: string | null;
  /** pdf and doc: exactly one file; notes: 1 to 20 photos; link: none. */
  files: UploadedFile[];
}

export interface TranscriptEdit {
  /** source_files.id */
  id: string;
  /** The person's corrected text (at most 20,000 characters). */
  transcript: string;
}

export interface ConfirmTranscriptsRequest {
  action: 'confirm_transcripts';
  plan_id: string;
  source_id: string;
  /** Edits for any of the source's files; files left out keep the stored transcript. */
  files: TranscriptEdit[];
}

export interface OutlineDecision {
  /** A draft topic's id (topics.id, status 'draft'). */
  id: string;
  /** The title to keep (1-120 characters); left out = keep the proposed title. */
  title?: string;
  /** false = cut the topic. */
  keep: boolean;
}

export interface ApproveOutlineRequest {
  action: 'approve_outline';
  plan_id: string;
  /**
   * The source whose outline is approved. null approves every outline of the plan that is waiting
   * for review together (the phone cannot tell which source a draft topic came from, so its review
   * screen shows all of them and sends null).
   */
  source_id: string | null;
  /** In the order the person wants them. Draft topics of those outlines that are not listed are cut. */
  topics: OutlineDecision[];
}

export interface JobRequest {
  action: 'retry_job' | 'cancel_job';
  /** tracy_events.id */
  job_id: string;
}

export type StudyRequest =
  | SubmitSourceRequest
  | ConfirmTranscriptsRequest
  | ApproveOutlineRequest
  | JobRequest;

// ---- Responses ----------------------------------------------------------------------------------

export interface SubmitSourceResponse {
  ok: true;
  source_id: string;
  /** 'processing' after a submit; the source's current status when it was submitted before. */
  status: 'pending' | 'processing' | 'ready' | 'failed';
  /** The queued jobs (one extract job, or one transcription job per photo). */
  job_ids: string[];
  /** true when this source had been submitted before (a retried request); nothing new was queued. */
  already_submitted: boolean;
}

export interface ConfirmTranscriptsResponse {
  ok: true;
  source_id: string;
  /** How many passages the confirmed transcripts became. */
  chunks: number;
  /** The outline job (and the embedding job when embeddings are on). */
  job_ids: string[];
}

export interface ApproveOutlineResponse {
  ok: true;
  plan_id: string;
  /** The sources whose outlines were approved. */
  source_ids: string[];
  kept: number;
  cut: number;
  /** The card-making jobs queued (one per kept topic, more for a long topic, plus existing topics). */
  job_ids: string[];
  /** true when these outlines had been approved before (a retried request). */
  already_approved: boolean;
}

export interface JobResponse {
  ok: true;
  job_id: string;
  status: 'queued' | 'cancelled';
}

export type StudyResponse =
  | SubmitSourceResponse
  | ConfirmTranscriptsResponse
  | ApproveOutlineResponse
  | JobResponse;

// ---- Errors -------------------------------------------------------------------------------------

/** HTTP status for each error code the function returns. */
export const STUDY_ERROR_STATUS = {
  bad_request: 400, // the body is malformed; `errors` names the fields (never their values)
  bad_files: 400, // the uploaded files are missing, of the wrong type or too large; `errors` says which
  unauthorized: 401, // no valid user session
  forbidden: 403, // the plan, source or job belongs to someone else
  not_found: 404, // no such plan, source or job (or the caller cannot see it)
  method_not_allowed: 405,
  conflict: 409, // the source id is taken by another source, or the source is in another plan
  not_ready: 409, // the step does not apply now (e.g. transcriptions still running); `error` says why
  no_text: 422, // the confirmed transcripts hold nothing to study
  cap_reached: 429, // the monthly limit for this stage is used up; see CapReachedBody
  server_error: 500,
  not_configured: 503, // the function's environment is incomplete
} as const;
export type StudyErrorCode = keyof typeof STUDY_ERROR_STATUS;

export interface StudyErrorBody {
  ok: false;
  code: StudyErrorCode;
  /** A short English sentence the app may show. Never contains the person's material. */
  error: string;
  /** For bad_request / bad_files: what is wrong, by field name and index. */
  errors?: string[];
}

/** The 429 body: which monthly limit, how much of it is used, and when it resets (UTC). */
export interface CapReachedBody extends StudyErrorBody {
  code: 'cap_reached';
  /** 'extract' = sources this month; 'transcribe' = pages and photos this month. */
  stage: 'extract' | 'transcribe';
  /** This month's usage before the refused request (below `limit` when the request needed more than was left). */
  used: number;
  limit: number;
  /** ISO timestamp with milliseconds: the first moment of next month, UTC. */
  resets_at: string;
}

/** Thrown inside the function and turned into a StudyErrorBody response. */
export class StudyError extends Error {
  readonly code: StudyErrorCode;
  readonly status: number;
  readonly errors?: string[];
  readonly extra?: Record<string, unknown>;
  constructor(
    code: StudyErrorCode,
    message: string,
    options: { errors?: string[]; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'StudyError';
    this.code = code;
    this.status = STUDY_ERROR_STATUS[code];
    this.errors = options.errors;
    this.extra = options.extra;
  }

  body(): StudyErrorBody {
    const body: StudyErrorBody = { ok: false, code: this.code, error: this.message };
    if (this.errors?.length) body.errors = this.errors;
    return { ...body, ...(this.extra ?? {}) };
  }
}
