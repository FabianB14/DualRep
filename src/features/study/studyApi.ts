/**
 * The app's client for the `study` Edge Function (Phase 2 decision 2): the user actions that start AI
 * work. They need the internet; studying never does.
 *
 * The request and response shapes mirror supabase/functions/_shared/contracts.ts (and the comment at
 * the top of supabase/functions/study/index.ts) by hand: the app cannot import the Deno code. Keep
 * them in step; studyApi.test.ts pins the wire format.
 *
 * Calls go through supabase-js `functions.invoke`, which sends the signed-in user's JWT (refreshed
 * when needed) and the publishable key. Every failure becomes a StudyApiError with a `kind` the
 * screens switch on (offline, cap_reached, …) and a plain-English message (studyErrorMessage).
 */

// ---- The contract (mirrors supabase/functions/_shared/contracts.ts) ----------------------------

export const SOURCE_KINDS = ['pdf', 'doc', 'link', 'notes'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Limits the function checks (the Storage bucket enforces the byte limit and MIME list too). */
export const STUDY_API_LIMITS = {
  /** = the `sources` bucket's file_size_limit (25 MiB). */
  maxFileBytes: 25 * 1024 * 1024,
  maxNotePhotos: 20,
  maxTitleChars: 200,
  maxUrlChars: 2048,
  maxTranscriptChars: 20000,
  maxTopicTitleChars: 120,
  maxApproveTopics: 400,
} as const;

/** File name extension → the MIME type Storage must hold, per kind. Files are named `<n>.<ext>`. */
export const KIND_FILE_TYPES: Readonly<Record<SourceKind, Readonly<Record<string, string>>>> = {
  pdf: { pdf: 'application/pdf' },
  doc: { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  notes: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
  link: {},
};

export type UploadedFile = { path: string };

export type SubmitSourceRequest = {
  action: 'submit_source';
  plan_id: string;
  source_id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  files: UploadedFile[];
};

export type TranscriptEdit = { id: string; transcript: string };

export type ConfirmTranscriptsRequest = {
  action: 'confirm_transcripts';
  plan_id: string;
  source_id: string;
  files: TranscriptEdit[];
};

export type OutlineDecision = { id: string; title?: string; keep: boolean };

export type ApproveOutlineRequest = {
  action: 'approve_outline';
  plan_id: string;
  /** null approves every outline of the plan waiting for review together (what the phone sends). */
  source_id: string | null;
  /** In the order the person wants them; draft topics left out are cut. */
  topics: OutlineDecision[];
};

export type JobRequest = { action: 'retry_job' | 'cancel_job'; job_id: string };

export type StudyRequest = SubmitSourceRequest | ConfirmTranscriptsRequest | ApproveOutlineRequest | JobRequest;

export type SubmitSourceResponse = {
  ok: true;
  source_id: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  job_ids: string[];
  already_submitted: boolean;
};

export type ConfirmTranscriptsResponse = { ok: true; source_id: string; chunks: number; job_ids: string[] };

export type ApproveOutlineResponse = {
  ok: true;
  plan_id: string;
  source_ids: string[];
  kept: number;
  cut: number;
  job_ids: string[];
  already_approved: boolean;
};

export type JobResponse = { ok: true; job_id: string; status: 'queued' | 'cancelled' };

export const STUDY_ERROR_CODES = [
  'bad_request',
  'bad_files',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'not_ready',
  'no_text',
  'cap_reached',
  'server_error',
  'not_configured',
] as const;
export type StudyErrorCode = (typeof STUDY_ERROR_CODES)[number];

// ---- Errors as the app sees them ----------------------------------------------------------------

export type StudyApiErrorKind =
  /** No connection (the request never reached the server). */
  | 'offline'
  /** No answer in time. */
  | 'timeout'
  /** The caller cancelled (its AbortSignal fired). */
  | 'cancelled'
  /** No valid session: sign in again. */
  | 'signed_out'
  /** This month's limit for the stage is used up (see `cap`). */
  | 'cap_reached'
  | 'bad_request'
  | 'bad_files'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'not_ready'
  | 'no_text'
  /** The function is not deployed or configured yet. */
  | 'not_configured'
  /** Anything else that went wrong on the server. */
  | 'server';

export type CapInfo = {
  /** 'extract' = sources this month; 'transcribe' = pages and photos this month. */
  stage: 'extract' | 'transcribe';
  used: number;
  limit: number;
  /** Epoch ms of the reset (the first moment of next month, UTC). */
  resetsAt: number;
};

export class StudyApiError extends Error {
  readonly kind: StudyApiErrorKind;
  /** HTTP status, or null when there was no response. */
  readonly status: number | null;
  /** The function's error code, when it sent one. */
  readonly code: string | null;
  /** The function's short English sentence, when it sent one (never the user's material). */
  readonly serverMessage: string | null;
  /** For bad_request / bad_files: what is wrong, by field name. */
  readonly errors: readonly string[];
  readonly cap: CapInfo | null;

  constructor(
    kind: StudyApiErrorKind,
    details: { status?: number | null; code?: string | null; serverMessage?: string | null; errors?: readonly string[]; cap?: CapInfo | null } = {},
  ) {
    super(details.serverMessage || kind);
    this.name = 'StudyApiError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.serverMessage = details.serverMessage ?? null;
    this.errors = details.errors ?? [];
    this.cap = details.cap ?? null;
  }
}

export function isStudyApiError(error: unknown): error is StudyApiError {
  return error instanceof StudyApiError;
}

// ---- The call -----------------------------------------------------------------------------------

/** The part of a Supabase client this module uses (SupabaseClient satisfies it). */
export type StudyFunctionsClient = {
  functions: {
    invoke(
      name: string,
      options: { body: StudyRequest; signal?: AbortSignal; timeout?: number },
    ): Promise<{ data: unknown; error: unknown; response?: unknown }>;
  };
};

export const STUDY_FUNCTION = 'study';
/** How long a call may take. The function only checks, writes rows and queues jobs. */
export const STUDY_TIMEOUT_MS = 30_000;

export type CallOptions = { signal?: AbortSignal; timeoutMs?: number };

const KIND_BY_CODE: Partial<Record<string, StudyApiErrorKind>> = {
  bad_request: 'bad_request',
  bad_files: 'bad_files',
  unauthorized: 'signed_out',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  not_ready: 'not_ready',
  no_text: 'no_text',
  cap_reached: 'cap_reached',
  not_configured: 'not_configured',
  method_not_allowed: 'server',
  server_error: 'server',
};

function kindForStatus(status: number, hasBody: boolean): StudyApiErrorKind {
  if (status === 401) return 'signed_out';
  if (status === 429) return 'cap_reached';
  if (status === 404 && !hasBody) return 'not_configured'; // no such function deployed
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 503 && !hasBody) return 'not_configured';
  return 'server';
}

function capFrom(body: Record<string, unknown>): CapInfo | null {
  const stage = body.stage;
  const resetsAt = typeof body.resets_at === 'string' ? Date.parse(body.resets_at) : Number.NaN;
  if (stage !== 'extract' && stage !== 'transcribe') return null;
  return {
    stage,
    used: typeof body.used === 'number' ? body.used : 0,
    limit: typeof body.limit === 'number' ? body.limit : 0,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : nextMonthUtc(Date.now()),
  };
}

/** The first moment of the month after `nowMs`, UTC (epoch ms). */
export function nextMonthUtc(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

type ResponseLike = { status: number; json(): Promise<unknown> };

function isResponseLike(value: unknown): value is ResponseLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { json?: unknown }).json === 'function'
  );
}

/** Turns what functions.invoke reported into a StudyApiError. */
export async function toStudyApiError(error: unknown, signal?: AbortSignal): Promise<StudyApiError> {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  const context = typeof error === 'object' && error !== null ? (error as { context?: unknown }).context : undefined;
  if (name === 'FunctionsFetchError') {
    if (signal?.aborted) return new StudyApiError('cancelled');
    const inner = typeof context === 'object' && context !== null ? (context as { name?: unknown }).name : undefined;
    return new StudyApiError(inner === 'AbortError' || inner === 'TimeoutError' ? 'timeout' : 'offline');
  }
  if (name === 'FunctionsRelayError') {
    return new StudyApiError('server', { status: isResponseLike(context) ? context.status : null });
  }
  if (name === 'FunctionsHttpError' && isResponseLike(context)) {
    const status = context.status;
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = await context.json();
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
    const code = typeof body?.code === 'string' ? body.code : null;
    const kind = (code ? KIND_BY_CODE[code] : undefined) ?? kindForStatus(status, body !== null && code !== null);
    return new StudyApiError(kind, {
      status,
      code,
      serverMessage: typeof body?.error === 'string' ? body.error : null,
      errors: Array.isArray(body?.errors) ? (body.errors as unknown[]).filter((e): e is string => typeof e === 'string') : [],
      cap: kind === 'cap_reached' && body ? capFrom(body) : null,
    });
  }
  if (signal?.aborted) return new StudyApiError('cancelled');
  return new StudyApiError('server');
}

/**
 * Calls the study function with one action. Resolves to the function's success body; rejects with a
 * StudyApiError (never anything else).
 */
export async function callStudy<T extends { ok: true }>(
  client: StudyFunctionsClient | null,
  body: StudyRequest,
  options: CallOptions = {},
): Promise<T> {
  if (!client) throw new StudyApiError('not_configured');
  let result: { data: unknown; error: unknown };
  try {
    result = await client.functions.invoke(STUDY_FUNCTION, {
      body,
      timeout: options.timeoutMs ?? STUDY_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw await toStudyApiError(error, options.signal);
  }
  if (result.error) throw await toStudyApiError(result.error, options.signal);
  const data = result.data;
  if (typeof data !== 'object' || data === null || (data as { ok?: unknown }).ok !== true) {
    throw new StudyApiError('server');
  }
  return data as T;
}

export function submitSource(
  client: StudyFunctionsClient | null,
  request: Omit<SubmitSourceRequest, 'action'>,
  options?: CallOptions,
): Promise<SubmitSourceResponse> {
  return callStudy<SubmitSourceResponse>(client, { action: 'submit_source', ...request }, options);
}

export function confirmTranscripts(
  client: StudyFunctionsClient | null,
  request: Omit<ConfirmTranscriptsRequest, 'action'>,
  options?: CallOptions,
): Promise<ConfirmTranscriptsResponse> {
  return callStudy<ConfirmTranscriptsResponse>(client, { action: 'confirm_transcripts', ...request }, options);
}

export function approveOutline(
  client: StudyFunctionsClient | null,
  request: Omit<ApproveOutlineRequest, 'action'>,
  options?: CallOptions,
): Promise<ApproveOutlineResponse> {
  return callStudy<ApproveOutlineResponse>(client, { action: 'approve_outline', ...request }, options);
}

export function retryJob(client: StudyFunctionsClient | null, jobId: string, options?: CallOptions): Promise<JobResponse> {
  return callStudy<JobResponse>(client, { action: 'retry_job', job_id: jobId }, options);
}

export function cancelJob(client: StudyFunctionsClient | null, jobId: string, options?: CallOptions): Promise<JobResponse> {
  return callStudy<JobResponse>(client, { action: 'cancel_job', job_id: jobId }, options);
}

// ---- Plain-English messages ---------------------------------------------------------------------

/** "November 1" in the phone's language. */
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

/** The cap in plain words: "You've added 5 sources this month, the most for your plan. …" */
export function describeCap(cap: CapInfo): string {
  const what = cap.stage === 'extract' ? 'sources' : 'pages of notes';
  const used = cap.limit > 0 ? `You’ve used all ${cap.limit} ${what} for this month.` : `You’ve used this month’s ${what}.`;
  return `${used} More can be added from ${formatDay(cap.resetsAt)}.`;
}

/** What to tell the user about a failed study call. */
export function studyErrorMessage(error: unknown): string {
  if (!isStudyApiError(error)) return 'Something went wrong. Try again.';
  switch (error.kind) {
    case 'offline':
      return 'No internet connection. Adding and preparing material needs the internet; studying doesn’t.';
    case 'timeout':
      return 'The server took too long to answer. Try again.';
    case 'cancelled':
      return 'Cancelled.';
    case 'signed_out':
      return 'Your session has expired. Sign in again, then try again.';
    case 'cap_reached':
      return error.cap ? describeCap(error.cap) : 'You’ve reached this month’s limit. Try again next month.';
    case 'not_configured':
      return 'Adding material isn’t set up on the server yet. Try again later.';
    case 'bad_request':
      return 'The app sent something the server couldn’t read. Update the app and try again.';
    case 'bad_files':
    case 'forbidden':
    case 'not_found':
    case 'conflict':
    case 'not_ready':
    case 'no_text':
      return error.serverMessage ?? fallbackFor(error.kind);
    case 'server':
      return 'Something went wrong on the server. Try again.';
  }
}

function fallbackFor(kind: StudyApiErrorKind): string {
  switch (kind) {
    case 'bad_files':
      return 'The uploaded files couldn’t be used. Add them again.';
    case 'forbidden':
      return 'Only the plan’s owner can do this.';
    case 'not_found':
      return 'This was deleted, or hasn’t reached the server yet. Try again in a moment.';
    case 'conflict':
      return 'This material is already in another plan.';
    case 'not_ready':
      return 'This step isn’t ready yet.';
    case 'no_text':
      return 'There’s nothing to study in these pages yet. Add some text to the transcriptions.';
    default:
      return 'Something went wrong. Try again.';
  }
}
