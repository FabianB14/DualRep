/**
 * Calls to Tracy (tracy-ai on Render): GET /health, POST /ai/extract and POST /ai/tasks/dualrep_*.
 * Contracts: tracy-ai README "DualRep lane" (= the Phase 2 research tracy.md §4 and §6.1).
 *
 * Auth is the header X-Service-Secret: <SERVICE_SECRET_DUALREP> (TRACY_SERVICE_SECRET here). Tracy
 * stores nothing and logs metadata only; request_id (the job id) ties its log line to the job.
 * Each call has its own deadline under the Edge Function's 150 s: 5 s for the health check, 110 s for
 * a task or an extraction. Tracy's task budgets (90-105 s, input preparation such as rendering
 * scanned pages included) end at least 5 s before that, so its answer arrives before this side gives
 * up, and it never retries a model call itself.
 * Nothing here logs or returns Tracy's error text; failures are reduced to status + code.
 * Uses only fetch, so tests pass a fake.
 */
import type { CallFailure } from './errors.ts';
import type { ExtractResponse } from './pipeline.ts';

export type CallResult<T> = { ok: true; data: T } | { ok: false; failure: CallFailure };

export interface TaskResult<T> {
  output: T;
  model: string | null;
  usage: unknown;
}

export interface TracyOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  /** Per-call deadline for tasks and extraction (default 110 s). */
  timeoutMs?: number;
  /** Deadline for GET /health (default 5 s). */
  healthTimeoutMs?: number;
}

export class Tracy {
  private readonly url: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;

  constructor(opts: TracyOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.secret = opts.secret;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 110_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 5_000;
  }

  /**
   * Is Tracy awake? On Render's free plan a sleeping service takes about a minute to start; this
   * request is what wakes it. false = put the job back and let the next cron tick go ahead.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.url}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      const body = await res.json().catch(() => null);
      return !!body && body.ok === true;
    } catch {
      return false;
    }
  }

  /** POST /ai/extract: per-page text chunks of a signed Storage URL or a web page. */
  extract(body: {
    url: string;
    kind: 'pdf' | 'doc' | 'link';
    first_page: number;
    request_id: string;
  }): Promise<CallResult<ExtractResponse>> {
    return this.post<ExtractResponse>('/ai/extract', body, (json) => json as unknown as ExtractResponse);
  }

  /** POST /ai/tasks/<task>: a validated JSON answer. */
  task<T>(task: string, input: Record<string, unknown>, requestId: string): Promise<CallResult<TaskResult<T>>> {
    return this.post<TaskResult<T>>(
      `/ai/tasks/${encodeURIComponent(task)}`,
      { input, request_id: requestId },
      (json) => ({
        output: json.output as T,
        model: typeof json.model === 'string' ? json.model : null,
        usage: json.usage ?? null,
      }),
    );
  }

  private async post<T>(
    path: string,
    body: unknown,
    pick: (json: Record<string, unknown>) => T,
  ): Promise<CallResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-secret': this.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { ok: false, failure: { kind: isTimeout(err) ? 'timeout' : 'network' } };
    }
    let json: Record<string, unknown> | null = null;
    try {
      const text = await res.text();
      const parsed = JSON.parse(text);
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      if (isTimeout(err)) return { ok: false, failure: { kind: 'timeout' } };
      json = null;
    }
    if (!json) return { ok: false, failure: { kind: 'not_json', status: res.status } };
    if (!res.ok || json.ok !== true) {
      return {
        ok: false,
        failure: {
          kind: 'http',
          status: res.ok ? 502 : res.status,
          code: typeof json.code === 'string' ? json.code : null,
          errors: Array.isArray(json.errors) ? json.errors.filter((e): e is string => typeof e === 'string') : undefined,
        },
      };
    }
    return { ok: true, data: pick(json) };
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
