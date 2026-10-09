/**
 * `tracy-worker`: works off the study pipeline's job queue (tracy_events), one step per call
 * (spec decision 1 and "Job pipeline"; the step machine is worker.ts).
 *
 * Who calls it (verify_jwt is off in config.toml; nobody calls it with a user JWT):
 *   - pg_cron every minute, but only while a job is queued (private.kick_tracy_worker), with
 *     { "reason": "jobs" }, and once a day with { "reason": "sweep" } (orphaned upload files);
 *   - the study function right after it queues work, and this function itself while more work is
 *     queued, with { "reason": "kick", "hop": n }.
 * Every call must carry the header x-dualrep-worker-secret = DUALREP_WORKER_SECRET (the same value
 * is in Vault as dualrep_worker_secret, where the cron job reads it; the Deploy backend workflow sets
 * both). It is compared in constant time; anything else gets 403.
 *
 * Responses: 202 { ok: true, reason } at once (the work continues in the background with
 * EdgeRuntime.waitUntil, so pg_net's 5 s timeout never cuts a step short); 403 wrong secret;
 * 405 not POST; 503 not configured. The wall clock is 150 s on the Free plan: one Tracy call
 * (≤ 110 s) per step fits with room for the reads and writes.
 */
import { missingSettings, parseConfig } from '../_shared/config.ts';
import { embedDocuments } from '../_shared/gemini.ts';
import { inBackground, json, secretsMatch } from '../_shared/http.ts';
import { kickWorker } from '../_shared/kick.ts';
import { createAdminStore } from '../_shared/supabase.ts';
import { Tracy } from '../_shared/tracy.ts';
import { runOneStep, sweepOrphans } from './worker.ts';

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, code: 'method_not_allowed' });
  const cfg = parseConfig((name) => Deno.env.get(name));
  if (!cfg.workerSecret) {
    console.error(JSON.stringify({ fn: 'tracy-worker', error: 'not_configured', missing: ['DUALREP_WORKER_SECRET'] }));
    return json(503, { ok: false, code: 'not_configured' });
  }
  if (!(await secretsMatch(req.headers.get('x-dualrep-worker-secret'), cfg.workerSecret))) {
    return json(403, { ok: false, code: 'forbidden' });
  }
  const missing = missingSettings(cfg, ['supabaseUrl', 'secretKey']);
  if (missing.length) {
    console.error(JSON.stringify({ fn: 'tracy-worker', error: 'not_configured', missing }));
    return json(503, { ok: false, code: 'not_configured' });
  }

  const body = await req.json().catch(() => ({})) as { reason?: unknown; hop?: unknown };
  const reason = body?.reason === 'sweep' ? 'sweep' : 'jobs';
  const hop = Number.isInteger(body?.hop) ? Math.max(0, Math.min(1000, body.hop as number)) : 0;
  const store = createAdminStore(cfg);

  let task: Promise<unknown>;
  if (reason === 'sweep') {
    task = sweepOrphans(store, log);
  } else {
    if (!cfg.tracyUrl || !cfg.tracySecret) {
      console.error(JSON.stringify({ fn: 'tracy-worker', warning: 'tracy_not_configured', missing: missingSettings(cfg, ['tracyUrl', 'tracySecret']) }));
    }
    task = runOneStep({
      store,
      tracy: cfg.tracyUrl && cfg.tracySecret ? new Tracy({ url: cfg.tracyUrl, secret: cfg.tracySecret }) : null,
      caps: cfg.caps,
      embed: cfg.geminiKey ? (texts) => embedDocuments(texts, { apiKey: cfg.geminiKey }) : undefined,
      kick: (next) => kickWorker(cfg, { reason: 'kick', hop: next }),
      log,
    }, hop);
  }
  await inBackground(task.catch((err) => {
    const e = err as { name?: string; code?: string };
    console.error(JSON.stringify({ fn: 'tracy-worker', reason, error: e?.name ?? 'Error', code: e?.code ?? null }));
  }));
  return json(202, { ok: true, reason });
});
