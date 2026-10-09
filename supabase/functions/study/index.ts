/**
 * `study`: the app's one Edge Function for starting and steering AI work on study material (spec
 * decision 2). Building a plan needs the internet; studying never does.
 *
 * ── Calling it ───────────────────────────────────────────────────────────────────────────────────
 *   POST /functions/v1/study            (supabase.functions.invoke('study', { body }))
 *   Authorization: Bearer <the signed-in user's access token>   (invoke sends it)
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...fields }. All ids are lowercase UUIDs.
 *
 *   Success: 202 when work was queued, 200 when nothing new was needed; body { "ok": true, ... }.
 *   Failure: { "ok": false, "code": "<code>", "error": "<short sentence the app may show>",
 *              "errors"?: ["<field-level problem>", ...] }
 *     400 bad_request     the body is malformed (errors[] names the fields, never their values)
 *     400 bad_files       an uploaded file is missing, of the wrong type or over 25 MiB (errors[])
 *     401 unauthorized    no valid session: sign in again
 *     403 forbidden       the plan, source or job is someone else's
 *     404 not_found       no such plan, source or job
 *     405 method_not_allowed
 *     409 conflict        the source id is taken, or the source is not in this plan
 *     409 not_ready       this step does not apply now (error says why, e.g. "Some pages are still
 *                         being transcribed.")
 *     422 no_text         the confirmed transcripts hold nothing to study
 *     429 cap_reached     the monthly limit is used up, or this request needs more than is left;
 *                         extra fields:
 *                         { "stage": "extract" | "transcribe", "used": 5, "limit": 5,
 *                           "resets_at": "2026-11-01T00:00:00.000Z" }
 *                         extract = sources this month, transcribe = pages and photos this month;
 *                         used = this month's usage before the request (used < limit: some is left)
 *     500 server_error    (retry later)
 *     503 not_configured  the backend is not deployed completely
 *
 * ── Actions ──────────────────────────────────────────────────────────────────────────────────────
 * submit_source: after the files are uploaded to Storage, create the source and queue its first step.
 *   { "action": "submit_source", "plan_id": "…", "source_id": "<made on the phone>",
 *     "kind": "pdf" | "doc" | "link" | "notes", "title": "Lecture 3" (1-200 chars),
 *     "url": "https://…" (kind link only, else null or absent),
 *     "files": [{ "path": "<user_id>/<source_id>/1.pdf" }] }
 *   files: pdf -> exactly one `1.pdf`; doc -> exactly one `1.docx`; notes -> 1 to 20 photos
 *   `<n>.jpg|jpeg|png|webp` (n = the page, 1-based, each once); link -> []. Each file must already be
 *   in the `sources` bucket with its content type (application/pdf, the docx type, image/jpeg,
 *   image/png, image/webp) and at most 25 MiB. The plan must be the caller's own.
 *   -> 202 { "ok": true, "source_id": "…", "status": "processing", "job_ids": ["…"],
 *            "already_submitted": false }
 *   Sending the same request again is safe: -> 200 with "already_submitted": true.
 *   Over the monthly limit -> 429 cap_reached, and nothing is kept (the uploaded files are swept
 *   after 3 days).
 *   The server writes the sources, source_files and plan_sources rows; the phone sees them by sync.
 *
 * confirm_transcripts: a notes source whose photos are all transcribed (every transcription job of
 *   the source succeeded, or was cancelled = skipped). Saves the person's edits, marks every file
 *   confirmed, turns the transcripts into passages and queues the outline.
 *   { "action": "confirm_transcripts", "plan_id": "…", "source_id": "…",
 *     "files": [{ "id": "<source_files.id>", "transcript": "corrected text (≤ 20,000 chars)" }] }
 *   files may be [] (no edits); a file left out keeps its stored transcript.
 *   -> 202 { "ok": true, "source_id": "…", "chunks": 7, "job_ids": ["<outline job>", …] }
 *   Again after success -> 200 with the same job ids. Still transcribing / a failed page ->
 *   409 not_ready. Nothing readable -> 422 no_text.
 *
 * approve_outline: the person reviewed the draft topics (topics.status = 'draft') of a plan.
 *   { "action": "approve_outline", "plan_id": "…", "source_id": "…" | null,
 *     "topics": [{ "id": "<draft topic id>", "title": "Renamed" (optional, 1-120 chars),
 *                  "keep": true | false }] }
 *   topics: in the order wanted. Every draft topic of the outline(s) that is not listed is cut, like
 *   keep: false. source_id null = every outline of the plan waiting for review (the normal call: the
 *   phone cannot tell which source a draft came from). Kept topics are renamed, numbered after the
 *   plan's other topics and become 'confirmed'; cut ones are deleted (only ever drafts). All of it
 *   in one transaction: a request that fails changes nothing and can be sent again. Cards are then
 *   made for each kept topic (and for existing topics the outline added material to): the topic
 *   turns 'ready' when its cards are in, the source turns 'ready' when all its cards jobs are done.
 *   -> 202 { "ok": true, "plan_id": "…", "source_ids": ["…"], "kept": 6, "cut": 2,
 *            "job_ids": ["…"], "already_approved": false }
 *   Again after success -> 200 with "already_approved": true. No outline waiting -> 409 not_ready.
 *   Drafts of an outline whose job did not finish are set aside untouched (reviewed with it later).
 *   An outline that only adds to existing topics (cumulative plans) never waits here: it proposes no
 *   draft, so the worker approves it itself and its cards are made straight away.
 *
 * retry_job: try a failed (or cancelled) step again: the same job goes back to the queue. It is not
 *   counted against the monthly limit again, unless it was cancelled before it ever ran (its units
 *   were given back then): such a job takes them again, in this month, and over the limit -> 429
 *   cap_reached. A job that ran stays counted even if it is cancelled again while it waits.
 *   { "action": "retry_job", "job_id": "<tracy_events.id>" }
 *   -> 202 { "ok": true, "job_id": "…", "status": "queued" }
 *   Not failed/cancelled, or the source has moved past this step -> 409 not_ready.
 *
 * cancel_job: stop a queued or running step, or skip a failed one. Cancelling a page transcription
 *   skips that page (the "Skip" next to a page that could not be read); cancelling extraction or
 *   the outline stops the source (status 'failed', so "Try again" shows); cancelling a cards job
 *   leaves its topic without those cards.
 *   { "action": "cancel_job", "job_id": "…" }
 *   -> 200 { "ok": true, "job_id": "…", "status": "cancelled" }
 *   Succeeded or already cancelled -> 409 not_ready.
 *
 * ── What the phone follows (synced rows; nothing else needs polling) ─────────────────────────────
 *   sources.status        pending -> processing -> ready | failed
 *   tracy_events          stage (extract | transcribe | outline | cards | embed), status, error
 *                         (short, content-free, shown next to "Try again"), plan_id, source_id. A
 *                         succeeded extract job may carry a note in `error` (e.g. scanned pages
 *                         skipped because the monthly page limit was used up).
 *   source_files          transcript (a draft until confirmed), confirmed
 *   topics.status         draft (review the outline) -> confirmed (making cards) -> ready
 *   cards, card_links     as they are made
 *
 * ── How it works ─────────────────────────────────────────────────────────────────────────────────
 * verify_jwt is off in config.toml: the gateway's check also admits the publishable key, which ships
 * in the APK, so this function verifies the user's JWT itself (auth.getClaims). Ownership is checked
 * by reading the plan/source/job as the user (RLS); then rows are written with the secret key
 * (service role), always for the verified user id. Jobs go into tracy_events (the monthly caps are
 * enforced atomically by enqueue_tracy_event) and the tracy-worker function is woken right away; its
 * cron schedule is the safety net. Handlers: handlers.ts. Shapes: ../_shared/contracts.ts.
 */
import { missingSettings, parseConfig } from '../_shared/config.ts';
import { StudyError } from '../_shared/contracts.ts';
import { bearerToken, inBackground, json } from '../_shared/http.ts';
import { isUuid } from '../_shared/ids.ts';
import { kickWorker } from '../_shared/kick.ts';
import { createAdminStore, createUserView, verifyUserJwt } from '../_shared/supabase.ts';
import { checkStudyRequest } from '../_shared/validate.ts';
import { handleStudy } from './handlers.ts';

const fail = (e: StudyError) => json(e.status, e.body());

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return fail(new StudyError('method_not_allowed', 'Use POST.'));
  }
  const cfg = parseConfig((name) => Deno.env.get(name));
  const missing = missingSettings(cfg, ['supabaseUrl', 'secretKey', 'publishableKey']);
  if (missing.length) {
    console.error(JSON.stringify({ fn: 'study', error: 'not_configured', missing }));
    return fail(new StudyError('not_configured', "The study service isn't set up yet."));
  }

  const jwt = bearerToken(req.headers.get('authorization'));
  const userId = jwt ? await verifyUserJwt(cfg, jwt) : null;
  if (!jwt || !userId || !isUuid(userId)) {
    return fail(new StudyError('unauthorized', 'Sign in again to continue.'));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(new StudyError('bad_request', 'The request is not valid JSON.'));
  }
  const checked = checkStudyRequest(body, userId);
  if (!checked.ok) {
    return fail(new StudyError('bad_request', 'The request is not valid.', { errors: checked.errors }));
  }

  const started = Date.now();
  try {
    const result = await handleStudy(checked.value, {
      store: createAdminStore(cfg),
      user: createUserView(cfg, jwt),
      userId,
      config: cfg,
      kick: () => inBackground(kickWorker(cfg, { reason: 'kick', hop: 0 })),
    });
    console.log(JSON.stringify({
      fn: 'study',
      action: checked.value.action,
      status: result.status,
      ms: Date.now() - started,
    }));
    return json(result.status, result.body);
  } catch (err) {
    if (err instanceof StudyError) {
      console.log(JSON.stringify({
        fn: 'study',
        action: checked.value.action,
        status: err.status,
        code: err.code,
        ms: Date.now() - started,
      }));
      return fail(err);
    }
    // Names and codes only: a database message can quote the values it choked on.
    const e = err as { name?: string; code?: string };
    console.error(JSON.stringify({ fn: 'study', action: checked.value.action, error: e?.name ?? 'Error', code: e?.code ?? null }));
    return fail(new StudyError('server_error', 'Something went wrong. Try again in a moment.'));
  }
});
