/**
 * Wakes the tracy-worker function right away instead of waiting for the next cron minute. The
 * worker answers 202 at once and works in the background, so this waits for that answer only
 * (5 s at most). A failed kick changes nothing: pg_cron calls the worker every minute while work is
 * queued. `hop` counts self-kicks in a row; the worker stops kicking itself after MAX_HOPS so a long
 * run of quick steps stays under the platform's limit on chained function calls and cron takes over.
 * Uses only fetch.
 */

export const MAX_HOPS = 20;

export interface KickBody {
  reason: 'kick';
  hop: number;
}

export async function kickWorker(
  cfg: { supabaseUrl: string; workerSecret: string },
  body: KickBody,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.supabaseUrl || !cfg.workerSecret) return false;
  try {
    const res = await fetchImpl(`${cfg.supabaseUrl}/functions/v1/tracy-worker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dualrep-worker-secret': cfg.workerSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel();
    return res.status === 202;
  } catch {
    return false;
  }
}
