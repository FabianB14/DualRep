/**
 * The study function's actions against the in-memory store: ownership, validation of the uploads,
 * idempotent repeats, the monthly caps (and the clean rollback), confirming transcripts, approving
 * outlines, and retrying or cancelling a step.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.13';
import { DEFAULT_CAPS } from '../_shared/config.ts';
import { StudyError } from '../_shared/contracts.ts';
import { chunkId, outlineJobId, sourceFileId } from '../_shared/ids.ts';
import type { OutlineOutput } from '../_shared/pipeline.ts';
import { answer, failure } from '../_shared/testing/fake_tracy.ts';
import { OTHER, PLAN, scannedPage, scenario, SOURCE, SOURCE2, textPage, USER } from '../_shared/testing/scenario.ts';

const PDF = `${USER}/${SOURCE}/1.pdf`;
const submitPdf = { action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'pdf', title: 'Lecture 3', files: [{ path: PDF }] };
const photos = (n: number, source = SOURCE) => Array.from({ length: n }, (_, i) => ({ path: `${USER}/${source}/${i + 1}.jpg` }));

async function rejects(p: Promise<unknown>, code: string, status?: number): Promise<StudyError> {
  const err = await assertRejects(() => p, StudyError);
  assertEquals((err as StudyError).code, code);
  if (status) assertEquals((err as StudyError).status, status);
  return err as StudyError;
}

// ---- submit_source ------------------------------------------------------------------------------

Deno.test('submit_source writes the rows with the service role, queues extraction and wakes the worker', async () => {
  const s = scenario();
  s.store.upload(PDF, 'application/pdf', 3_000_000);
  const r = await s.call(submitPdf);
  assertEquals(r.status, 202);
  const job = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals(r.body, { ok: true, source_id: SOURCE, status: 'processing', job_ids: [job.id], already_submitted: false });
  assertEquals(s.store.sources.get(SOURCE), { id: SOURCE, owner_id: USER, kind: 'pdf', title: 'Lecture 3', url: null, status: 'processing' });
  assertEquals([...s.store.files.values()], [{
    id: await sourceFileId(SOURCE, 1),
    source_id: SOURCE,
    owner_id: USER,
    storage_path: PDF,
    page: null,
    transcript: null,
    confirmed: false,
  }]);
  assertEquals(s.store.planSources, [{ plan_id: PLAN, source_id: SOURCE }]);
  assertEquals([job.job, job.stage, job.plan_id, job.cap_units, job.input], ['study_builder', 'extract', PLAN, 1, { source_id: SOURCE, plan_id: PLAN, kind: 'pdf', cursor_page: 1 }]);
  assertEquals(s.kicks, [0]);

  // The phone sends it again (its first response was lost): nothing new.
  const again = await s.call(submitPdf);
  assertEquals(again.status, 200);
  assertEquals(again.body, { ok: true, source_id: SOURCE, status: 'processing', job_ids: [job.id], already_submitted: true });
  assertEquals(s.store.jobs.size, 1);
});

Deno.test('submit_source checks the plan and the source id belong to the caller', async () => {
  const s = scenario();
  s.store.upload(PDF, 'application/pdf');
  s.store.addPlan({ id: '50000000-0000-4000-8000-000000000009', owner_id: OTHER });
  await rejects(s.call({ ...submitPdf, plan_id: '50000000-0000-4000-8000-000000000009' }), 'forbidden', 403);
  await rejects(s.call({ ...submitPdf, plan_id: '50000000-0000-4000-8000-00000000000a' }), 'not_found', 404);
  s.store.sources.set(SOURCE, { id: SOURCE, owner_id: OTHER, kind: 'pdf', title: 'x', url: null, status: 'ready' });
  await rejects(s.call(submitPdf), 'conflict', 409);
  assertEquals(s.store.jobs.size, 0);
});

Deno.test('submit_source refuses files that are missing, of the wrong type or too large', async () => {
  const s = scenario();
  let err = await rejects(s.call(submitPdf), 'bad_files', 400);
  assertEquals(err.errors, ['files[0] has not been uploaded']);
  s.store.upload(PDF, 'text/plain');
  err = await rejects(s.call(submitPdf), 'bad_files');
  assertEquals(err.errors, ['files[0] was uploaded with the wrong content type']);
  s.store.upload(PDF, 'application/pdf', 26 * 1024 * 1024);
  err = await rejects(s.call(submitPdf), 'bad_files');
  assertEquals(err.errors, ['files[0] is larger than 25 MiB']);
  assertEquals(s.store.sources.size, 0);
});

Deno.test('over the monthly source limit: 429 with when it resets, and nothing is kept', async () => {
  const s = scenario({ caps: { sources: { free: 0, paid: 30 }, pages: DEFAULT_CAPS.pages } });
  s.store.upload(PDF, 'application/pdf');
  const err = await rejects(s.call(submitPdf), 'cap_reached', 429);
  assertEquals(err.body() as unknown, {
    ok: false,
    code: 'cap_reached',
    error: "You've used this month's new material. It resets on the 1st.",
    stage: 'extract',
    used: 0,
    limit: 0,
    resets_at: '2026-11-01T00:00:00.000Z',
  });
  assertEquals([s.store.sources.size, s.store.files.size, s.store.planSources.length, s.store.jobs.size], [0, 0, 0, 0]);
  // A subscriber's limit is the paid one.
  s.store.paidUsers.add(USER);
  assertEquals((await s.call(submitPdf)).status, 202);
});

Deno.test('notes: one counted transcription per photo; hitting the page limit gives every unit back', async () => {
  const s = scenario({ caps: { sources: DEFAULT_CAPS.sources, pages: { free: 2, paid: 200 } } });
  for (const f of photos(3)) s.store.upload(f.path, 'image/jpeg');
  const err = await rejects(
    s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'notes', title: 'Notes', files: photos(3) }),
    'cap_reached',
  );
  assertEquals((err.body() as unknown as { stage: string; used: number; limit: number }).stage, 'transcribe');
  assertEquals(s.store.sources.size, 0);
  assert([...s.store.jobs.values()].every((j) => j.status === 'cancelled' && j.attempts === 0));

  // The cancelled jobs cost nothing, so two photos still fit this month.
  for (const f of photos(2, SOURCE2)) s.store.upload(f.path, 'image/jpeg');
  const ok = await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE2, kind: 'notes', title: 'Notes', files: photos(2, SOURCE2) });
  assertEquals(ok.status, 202);
  const jobs = s.store.jobsOf(SOURCE2, 'transcribe');
  assertEquals(jobs.map((j) => [j.job, j.input.source_file_id, j.cap_units]), [
    ['handwriting', await sourceFileId(SOURCE2, 1), 1],
    ['handwriting', await sourceFileId(SOURCE2, 2), 1],
  ]);
  assertEquals([...s.store.files.values()].map((f) => f.page), [1, 2]);
});

// ---- confirm_transcripts ------------------------------------------------------------------------

async function transcribedNotes(s: ReturnType<typeof scenario>, pages = 2) {
  for (const f of photos(pages)) s.store.upload(f.path, 'image/jpeg');
  await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'notes', title: 'Notes', files: photos(pages) });
  s.tracy.tasks.dualrep_transcribe_notes = (input) =>
    answer({ status: 'draft', page: { page: input.page, blank: false, transcript: `# Page ${input.page}\n\nDraft text ${input.page}.`, legibility: 'good', uncertain: [], diagrams: [] } });
}

Deno.test('confirm_transcripts waits for every photo, saves the edits and queues the outline', async () => {
  const s = scenario();
  await transcribedNotes(s);
  await rejects(s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [] }), 'not_ready', 409);
  await s.drain();
  const file1 = await sourceFileId(SOURCE, 1);
  const r = await s.call({
    action: 'confirm_transcripts',
    plan_id: PLAN,
    source_id: SOURCE,
    files: [{ id: file1, transcript: '# Page 1\n\nCorrected text one.' }],
  });
  assertEquals(r.status, 202);
  assertEquals(r.body, { ok: true, source_id: SOURCE, chunks: 2, job_ids: [await outlineJobId(SOURCE)] });
  const files = [...s.store.files.values()].sort((a, b) => a.page! - b.page!);
  assertEquals(files.map((f) => [f.transcript, f.confirmed]), [
    ['# Page 1\n\nCorrected text one.', true],
    ['# Page 2\n\nDraft text 2.', true],
  ]);
  assertEquals(s.store.chunks.get(await chunkId(SOURCE, 1, 0))?.content, '# Page 1\n\nCorrected text one.');
  assertEquals(s.store.jobsOf(SOURCE, 'outline')[0].input, { source_id: SOURCE, plan_id: PLAN });

  const again = await s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [] });
  assertEquals(again.status, 200);
  assertEquals(s.store.jobsOf(SOURCE, 'outline').length, 1);
});

Deno.test('confirm_transcripts: a failed page must be retried or skipped; empty notes are refused', async () => {
  const s = scenario();
  await transcribedNotes(s);
  s.tracy.tasks.dualrep_transcribe_notes = (input) =>
    input.page === 2
      ? failure({ kind: 'http', status: 502, code: 'refused' })
      : answer({ status: 'draft', page: { page: 1, blank: true, transcript: '', legibility: 'good', uncertain: [], diagrams: [] } });
  await s.drain();
  const err = await rejects(s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [] }), 'not_ready');
  assertEquals(err.message, 'A page could not be transcribed. Try it again or skip it first.');
  // Skip page 2: cancelling a failed transcription skips it.
  const failed = s.store.jobsOf(SOURCE, 'transcribe').find((j) => j.status === 'failed')!;
  assertEquals((await s.call({ action: 'cancel_job', job_id: failed.id })).status, 200);
  await rejects(s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [] }), 'no_text', 422);
  assert([...s.store.files.values()].every((f) => !f.confirmed));
  await rejects(
    s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [{ id: SOURCE2, transcript: 'x' }] }),
    'bad_request',
  );
  const ok = await s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [{ id: await sourceFileId(SOURCE, 1), transcript: 'Typed by hand.' }] });
  assertEquals(ok.status, 202);
});

// ---- approve_outline ----------------------------------------------------------------------------

/** Two pdf sources of the plan, each with an outline waiting for review. */
async function twoOutlines(s: ReturnType<typeof scenario>) {
  for (const id of [SOURCE, SOURCE2]) {
    s.store.upload(`${USER}/${id}/1.pdf`, 'application/pdf');
    await s.call({ action: 'submit_source', plan_id: PLAN, source_id: id, kind: 'pdf', title: id, files: [{ path: `${USER}/${id}/1.pdf` }] });
  }
  s.tracy.onExtract = () => ({ ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 4)] } });
  s.tracy.tasks.dualrep_build_outline = (input) => {
    const ids = (input.chunks as { id: string }[]).map((c) => c.id);
    const src = (input.chunks as { source_id: string }[])[0].source_id;
    const out: OutlineOutput = {
      topics: [
        { key: 't1', title: `A ${src.slice(-1)}`, summary: '', existing_topic_id: null, chunk_ids: ids.slice(0, 2) },
        { key: 't2', title: `B ${src.slice(-1)}`, summary: '', existing_topic_id: null, chunk_ids: ids.slice(2) },
      ],
      unassigned_chunk_ids: [],
    };
    return answer(out);
  };
  await s.drain();
  return [...s.store.topics.values()].sort((a, b) => a.position - b.position);
}

Deno.test('approve_outline: one call for every outline of the plan; cuts, order and names', async () => {
  const s = scenario();
  await rejects(s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: [] }), 'not_ready');
  const drafts = await twoOutlines(s);
  assertEquals(drafts.map((t) => [t.title, t.position, t.status]), [['A 1', 0, 'draft'], ['B 1', 1, 'draft'], ['A 2', 2, 'draft'], ['B 2', 3, 'draft']]);
  const [a1, b1, a2, b2] = drafts.map((t) => t.id);

  const r = await s.call({
    action: 'approve_outline',
    plan_id: PLAN,
    source_id: null,
    topics: [{ id: b2, keep: true, title: 'Renamed' }, { id: a1, keep: true }, { id: b1, keep: false }],
  });
  assertEquals(r.status, 202);
  const body = r.body as { kept: number; cut: number; job_ids: string[]; source_ids: string[] };
  assertEquals([body.kept, body.cut, body.job_ids.length, body.source_ids.sort()], [2, 2, 2, [SOURCE, SOURCE2]]);
  assertEquals([...s.store.topics.values()].map((t) => [t.id, t.title, t.position, t.status]).sort((x, y) => (x[2] as number) - (y[2] as number)), [
    [b2, 'Renamed', 0, 'confirmed'],
    [a1, 'A 1', 1, 'confirmed'],
  ]);
  assert(!s.store.topics.has(a2) && !s.store.topics.has(b1));
  assert(s.store.jobs.get(await outlineJobId(SOURCE))!.output && (s.store.jobs.get(await outlineJobId(SOURCE))!.output as { approved_at: string }).approved_at === '2026-10-09T12:00:00.000Z');

  const again = await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: [] });
  assertEquals(again.status, 200);
  assertEquals((again.body as { already_approved: boolean }).already_approved, true);
  assertEquals(s.store.jobs.size, 2 + 2 + 2); // extract × 2, outline × 2, cards × 2
});

Deno.test('approve_outline for one source; unknown topics are refused; cutting everything finishes the source', async () => {
  const s = scenario();
  const drafts = await twoOutlines(s);
  const err = await rejects(
    s.call({ action: 'approve_outline', plan_id: PLAN, source_id: SOURCE, topics: [{ id: drafts[2].id, keep: true }] }),
    'bad_request',
  );
  assertEquals(err.errors, ['topics[0].id is not a draft topic of this outline']);
  const r = await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: SOURCE, topics: [] });
  assertEquals([r.status, (r.body as { cut: number }).cut], [200, 2]);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'ready');
  assertEquals(s.store.sources.get(SOURCE2)?.status, 'processing');
  assertEquals([...s.store.topics.values()].map((t) => t.title), ['A 2', 'B 2']);
});

Deno.test('approve_outline sets aside drafts of an outline whose job did not finish', async () => {
  // The phone sends every draft of the plan. When an outline job saved its drafts but then failed
  // (its final write did not go through), those drafts wait for that job instead of blocking the
  // review of the other outline.
  const s = scenario();
  const drafts = await twoOutlines(s);
  const stuck = s.store.jobs.get(await outlineJobId(SOURCE2))!;
  stuck.status = 'failed';
  // An id that is no draft at all is still refused.
  const bogus = '80000000-0000-4000-8000-0000000000ff';
  const err = await rejects(
    s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: [...drafts.map((t) => ({ id: t.id, keep: true })), { id: bogus, keep: true }] }),
    'bad_request',
  );
  assertEquals(err.errors, ['topics[2].id is not a draft topic of this outline']);
  const r = await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: drafts.map((t) => ({ id: t.id, keep: true })) });
  assertEquals(r.status, 202);
  assertEquals((r.body as { source_ids: string[]; kept: number }).source_ids, [SOURCE]);
  assertEquals([...s.store.topics.values()].map((t) => [t.title, t.status]).sort(), [
    ['A 1', 'confirmed'],
    ['A 2', 'draft'],
    ['B 1', 'confirmed'],
    ['B 2', 'draft'],
  ]);
});

// ---- retry_job / cancel_job ---------------------------------------------------------------------

Deno.test('retry_job puts the same job back with fresh attempts; the source is processing again', async () => {
  const s = scenario();
  s.store.upload(PDF, 'application/pdf');
  await s.call(submitPdf);
  s.tracy.onExtract = () => failure({ kind: 'http', status: 422, code: 'pdf_unreadable' });
  await s.drain();
  const job = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals([job.status, s.store.sources.get(SOURCE)?.status], ['failed', 'failed']);
  await rejects(s.call({ action: 'retry_job', job_id: job.id }, OTHER), 'not_found');
  const r = await s.call({ action: 'retry_job', job_id: job.id });
  assertEquals(r, { status: 202, body: { ok: true, job_id: job.id, status: 'queued' } });
  const back = s.store.jobs.get(job.id)!;
  assertEquals([back.status, back.attempts, back.error, back.cap_units], ['queued', 0, null, 1]);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'processing');
  assertEquals(s.store.jobs.size, 1);
  await rejects(s.call({ action: 'retry_job', job_id: job.id }), 'not_ready');
});

Deno.test('cancel_job: skipping the last scanned page starts the outline; cancelling extraction stops the source', async () => {
  const s = scenario();
  s.store.upload(PDF, 'application/pdf');
  await s.call(submitPdf);
  s.tracy.onExtract = () => ({ ok: true, data: { format: 'pdf', total_pages: 2, first_page: 1, last_page: 2, pages: [textPage(1, 2), scannedPage(2)] } });
  await s.step();
  const transcribe = s.store.jobsOf(SOURCE, 'transcribe')[0];
  s.kicks.length = 0;
  const r = await s.call({ action: 'cancel_job', job_id: transcribe.id });
  assertEquals(r.body, { ok: true, job_id: transcribe.id, status: 'cancelled' });
  assertEquals(s.store.jobsOf(SOURCE, 'outline').length, 1);
  assertEquals(s.kicks, [0]);
  await rejects(s.call({ action: 'cancel_job', job_id: transcribe.id }), 'not_ready');
  // Extraction can no longer be repeated once the outline is under way.
  await rejects(s.call({ action: 'retry_job', job_id: s.store.jobsOf(SOURCE, 'extract')[0].id }), 'not_ready');

  const t = scenario();
  t.store.upload(PDF, 'application/pdf');
  await t.call(submitPdf);
  const extract = t.store.jobsOf(SOURCE, 'extract')[0];
  await t.call({ action: 'cancel_job', job_id: extract.id });
  assertEquals([t.store.jobs.get(extract.id)?.status, t.store.sources.get(SOURCE)?.status], ['cancelled', 'failed']);
});
