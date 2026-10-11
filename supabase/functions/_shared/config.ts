/**
 * The functions' settings, parsed from environment variables. Pure: the caller passes a getter
 * (`(name) => Deno.env.get(name)` in the functions, a map in tests).
 *
 * Injected by Supabase: SUPABASE_URL, SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS (JSON
 * dictionaries; the legacy SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are the fallback).
 * Set by the Deploy backend workflow (`supabase secrets set`): TRACY_URL, TRACY_SERVICE_SECRET,
 * DUALREP_WORKER_SECRET, optional GEMINI_API_KEY, and optionally the monthly caps and
 * DUALREP_WORKER_CONCURRENCY below.
 */

export type Getter = (name: string) => string | undefined;

export interface Caps {
  /** Sources per month (counted on the extract stage). */
  sources: { free: number | null; paid: number | null };
  /** Pages and photos per month (counted on the transcribe stage). */
  pages: { free: number | null; paid: number | null };
}

export interface Config {
  supabaseUrl: string;
  secretKey: string;
  publishableKey: string;
  /** Tracy's base URL without a trailing slash, or '' when unset. */
  tracyUrl: string;
  tracySecret: string;
  workerSecret: string;
  /** '' = embeddings off (spec decision 4: only set with Gemini billing on). */
  geminiKey: string;
  caps: Caps;
  /**
   * How many jobs may run at once across all users (null = no limit). Default 1: Tracy on Render's
   * free plan (512 MB, 0.1 CPU) runs out of memory with two scanned-PDF renders at once.
   */
  workerConcurrency: number | null;
}

/** Spec decision 5. */
export const DEFAULT_CAPS: Caps = {
  sources: { free: 5, paid: 30 },
  pages: { free: 20, paid: 200 },
};

/** A cap: a whole number, or 'none' / 'off' / 'unlimited' for no limit; anything else = default. */
export function parseCap(value: string | undefined, fallback: number | null): number | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (v === 'none' || v === 'off' || v === 'unlimited') return null;
  return /^\d{1,6}$/.test(v) ? Number(v) : fallback;
}

export const DEFAULT_WORKER_CONCURRENCY = 1;

/** DUALREP_WORKER_CONCURRENCY: 1 to 10, or 'none' for no limit; anything else = the default. */
export function parseConcurrency(value: string | undefined): number | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'none' || v === 'off' || v === 'unlimited') return null;
  return /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 10 ? Number(v) : DEFAULT_WORKER_CONCURRENCY;
}

function keyFromDictionary(json: string | undefined): string {
  if (!json) return '';
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.default === 'string') return parsed.default;
    const first = Object.values(parsed ?? {}).find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : '';
  } catch {
    return '';
  }
}

export function parseConfig(get: Getter): Config {
  return {
    supabaseUrl: (get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    secretKey: keyFromDictionary(get('SUPABASE_SECRET_KEYS')) || (get('SUPABASE_SERVICE_ROLE_KEY') ?? ''),
    publishableKey: keyFromDictionary(get('SUPABASE_PUBLISHABLE_KEYS')) || (get('SUPABASE_ANON_KEY') ?? ''),
    // A URL copied from the browser after the /health check still works.
    tracyUrl: (get('TRACY_URL') ?? '').trim().replace(/\/+$/, '').replace(/\/health$/i, ''),
    tracySecret: get('TRACY_SERVICE_SECRET') ?? '',
    workerSecret: get('DUALREP_WORKER_SECRET') ?? '',
    geminiKey: (get('GEMINI_API_KEY') ?? '').trim(),
    caps: {
      sources: {
        free: parseCap(get('DUALREP_CAP_SOURCES_FREE'), DEFAULT_CAPS.sources.free),
        paid: parseCap(get('DUALREP_CAP_SOURCES_PAID'), DEFAULT_CAPS.sources.paid),
      },
      pages: {
        free: parseCap(get('DUALREP_CAP_PAGES_FREE'), DEFAULT_CAPS.pages.free),
        paid: parseCap(get('DUALREP_CAP_PAGES_PAID'), DEFAULT_CAPS.pages.paid),
      },
    },
    workerConcurrency: parseConcurrency(get('DUALREP_WORKER_CONCURRENCY')),
  };
}

/** The settings a function cannot run without (names only, for the log and a 503). */
export function missingSettings(cfg: Config, need: (keyof Config)[]): string[] {
  const names: Partial<Record<keyof Config, string>> = {
    supabaseUrl: 'SUPABASE_URL',
    secretKey: 'SUPABASE_SECRET_KEYS',
    publishableKey: 'SUPABASE_PUBLISHABLE_KEYS',
    tracyUrl: 'TRACY_URL',
    tracySecret: 'TRACY_SERVICE_SECRET',
    workerSecret: 'DUALREP_WORKER_SECRET',
  };
  return need.filter((k) => !cfg[k]).map((k) => names[k] ?? k);
}
