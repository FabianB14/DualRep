/**
 * The worker's step machine end to end, against the in-memory store and a scripted Tracy: a course
 * PDF with a scanned page from upload to cards, handwritten notes, the failure paths (Tracy asleep,
 * error pages, rejected answers, refusals, outages), fencing, the two-phase steps, caps, embeddings
 * and the self-kick.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1.0.13';
import { DEFAULT_CAPS } from '../_shared/config.ts';
import { MESSAGES } from '../_shared/errors.ts';
import { chunkId, embedJobId, outlineJobId } from '../_shared/ids.ts';
import { MAX_HOPS } from '../_shared/kick.ts';
import { type CardsOutput, type ExtractResponse, MAX_RELEASES, type OutlineOutput } from '../_shared/pipeline.ts';
import { answer, failure } from '../_shared/testing/fake_tracy.ts';
import { OTHER, PLAN, scannedPage, scenario, SOURCE, SOURCE2, textPage, USER } from '../_shared/testing/scenario.ts';
import { runOneStep, sweepOrphans } from './worker.ts';

const PDF = `${USER}/${SOURCE}/1.pdf`;

/** Tracy answers for a 3-page PDF: page 1 has 5 text chunks, page 2 is a scan, page 3 one chunk. */
function scriptPdf(s: ReturnType<typeof scenario>) {
  s.tracy.onExtract = (b): { ok: true; data: ExtractResponse } => ({
    ok: true,
    data: b.first_page === 1
      ? { format: 'pdf', total_pages: 3, first_page: 1, last_page: 2, pages: [textPage(1, 5), scannedPage(2)] }
      : { format: 'pdf', total_pages: 3, first_page: 3, last_page: 3, pages: [textPage(3, 1, 'enzyme')] },
  });
  s.tracy.tasks.dualrep_transcribe_pdf_pages = (input) =>
    answer({
      status: 'draft',
      pages: (input.pages as number[]).map((page) => ({
        page,
        blank: false,
        transcript: '# Margin notes\n\nMitochondria make ATP.',
        legibility: 'fair',
        uncertain: [],
        diagrams: ['a cell with labels'],
      })),
    });
  // Two topics: the first half of the chunks and the rest (by the ids Tracy was sent).
  s.tracy.tasks.dualrep_build_outline = (input) => {
    const ids = (input.chunks as { id: string }[]).map((c) => c.id);
    const out: OutlineOutput = {
      topics: [
        { key: 't1', title: 'Cells', summary: 'What cells are.', existing_topic_id: null, chunk_ids: ids.slice(0, 4) },
        { key: 't2', title: 'Energy', summary: 'How cells get energy.', existing_topic_id: null, chunk_ids: ids.slice(4, -1) },
      ],
      unassigned_chunk_ids: ids.slice(-1),
    };
    return answer(out);
  };
  s.tracy.tasks.dualrep_build_cards = (input) => {
    const chunks = input.chunks as { id: string; page: number | null; content: string }[];
    const out: CardsOutput = {
      cards: chunks.map((c, i) => ({
        key: `c${i + 1}`,
        card_type: 'basic',
        question: `Question about ${c.id}?`,
        answer: 'An answer.',
        source_chunk_id: c.id,
        page: c.page,
        quote: c.content.slice(0, 20),
      })),
      links: chunks.length > 1 ? [{ from_key: 'c1', to: 'c2', relation: 'related', note: null }] : [],
    };
    return answer(out);
  };
}

async function submitPdf(s: ReturnType<typeof scenario>) {
  s.store.upload(PDF, 'application/pdf', 2_000_000);
  const r = await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'pdf', title: 'Lecture 3', files: [{ path: PDF }] });
  assertEquals(r.status, 202);
}

Deno.test('a course PDF with a scanned page goes from upload to cards', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'processing');

  // 1: the first window: 5 chunks, the scanned page queued for transcription, the job re-queued.
  let r = await s.step();
  assertEquals(r.kind === 'step' && [r.stage, r.outcome], ['extract', 'continue']);
  const extract = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals([extract.status, extract.attempts, extract.input.cursor_page], ['queued', 0, 3]);
  assertEquals(s.store.jobsOf(SOURCE, 'transcribe').map((j) => [j.input.pdf_pages, j.cap_units]), [[[2], 1]]);
  assertEquals(s.tracy.calls[0].body.url, `https://ref.supabase.co/storage/v1/object/sign/sources/${PDF}?token=t&e=600`);
  assertEquals(s.tracy.calls[0].body.request_id, extract.id);

  // 2: the last window. The outline still waits for the transcription.
  r = await s.step();
  assertEquals(r.kind === 'step' && [r.stage, r.outcome], ['extract', 'done']);
  assertEquals(s.store.jobsOf(SOURCE, 'extract')[0].status, 'succeeded');
  assertEquals(s.store.jobsOf(SOURCE, 'outline'), []);

  // 3: the scanned page becomes a chunk (with its diagram line); now the outline is queued.
  r = await s.step();
  assertEquals(r.kind === 'step' && [r.stage, r.outcome], ['transcribe', 'done']);
  const scanned = s.store.chunks.get(await chunkId(SOURCE, 2, 0));
  assertEquals(scanned?.content, '# Margin notes\n\nMitochondria make ATP.\n\n[Diagram: a cell with labels]');
  assertEquals(s.store.chunks.size, 7);
  assertEquals(s.store.jobsOf(SOURCE, 'outline').map((j) => j.id), [await outlineJobId(SOURCE)]);

  // 4: the outline: draft topics after the plan's topics, chunks in reading order.
  r = await s.step();
  assertEquals(r.kind === 'step' && [r.stage, r.outcome], ['outline', 'done']);
  const outlineCall = s.tracy.callsOf('dualrep_build_outline')[0].body;
  assertEquals((outlineCall.chunks as { page: number }[]).map((c) => c.page), [1, 1, 1, 1, 1, 2, 3]);
  assertEquals(outlineCall.max_topics, 2);
  assertEquals((outlineCall.plan as { scope: string }).scope, 'cumulative');
  const drafts = [...s.store.topics.values()].sort((a, b) => a.position - b.position);
  assertEquals(drafts.map((t) => [t.title, t.status, t.position]), [['Cells', 'draft', 0], ['Energy', 'draft', 1]]);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'processing');

  // The person keeps both, Energy first, renamed.
  const approve = await s.call({
    action: 'approve_outline',
    plan_id: PLAN,
    source_id: null,
    topics: [{ id: drafts[1].id, keep: true, title: 'Cell energy' }, { id: drafts[0].id, keep: true }],
  });
  assertEquals(approve.status, 202);
  assertEquals([...s.store.topics.values()].map((t) => [t.title, t.status, t.position]).sort(), [['Cell energy', 'confirmed', 0], ['Cells', 'confirmed', 1]]);

  // 5-6: cards per topic; each topic turns ready; the source turns ready after the last.
  const results = await s.drain();
  assertEquals(results.map((x) => x.kind === 'step' && x.stage), ['cards', 'cards']);
  assertEquals([...s.store.topics.values()].map((t) => t.status), ['ready', 'ready']);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'ready');
  assertEquals(s.store.cards.size, 6); // 4 chunks + 2 chunks (one chunk was unassigned)
  for (const c of s.store.cards.values()) assert(s.store.chunks.has(c.source_chunk_id));
  assertEquals([...s.store.links.values()].every((l) => l.created_by === USER), true);
  assertEquals(s.store.links.size, 2);
  // Every job finished; nothing failed.
  assertEquals([...s.store.jobs.values()].map((j) => j.status).filter((x) => x !== 'succeeded'), []);
  // The worker kicked itself while work was queued.
  assert(s.kicks.length > 3);
});

/** Uploads and submits `n` photos of handwritten notes as source `id`, then transcribes them all. */
async function notesTranscribed(s: ReturnType<typeof scenario>, id: string, n: number, text: string) {
  const files = Array.from({ length: n }, (_, i) => ({ path: `${USER}/${id}/${i + 1}.jpg` }));
  for (const f of files) s.store.upload(f.path, 'image/jpeg', 400_000);
  const r = await s.call({ action: 'submit_source', plan_id: PLAN, source_id: id, kind: 'notes', title: 'Notes', files });
  assertEquals(r.status, 202);
  s.tracy.tasks.dualrep_transcribe_notes = (input) =>
    answer({ status: 'draft', page: { page: input.page, blank: false, transcript: `${text} (page ${input.page}).`, legibility: 'good', uncertain: [], diagrams: [] } });
  await s.drain();
}

Deno.test('the gate: a course PDF and handwritten notes become one cumulative plan', async () => {
  const s = scenario({ scope: 'cumulative' });
  scriptPdf(s);
  await submitPdf(s);
  await s.drain();
  const pdfDrafts = [...s.store.topics.values()].sort((a, b) => a.position - b.position);
  await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: pdfDrafts.map((t) => ({ id: t.id, keep: true })) });
  await s.drain();
  const cells = pdfDrafts[0];
  assertEquals([...s.store.topics.values()].map((t) => t.status), ['ready', 'ready']);
  const pdfCards = s.store.cards.size;

  // Photos of notes: transcribed, checked and confirmed by the person (one correction).
  await notesTranscribed(s, SOURCE2, 2, 'Osmosis moves water across a membrane');
  const files = [...s.store.files.values()].filter((f) => f.source_id === SOURCE2).sort((a, b) => a.page! - b.page!);
  assertEquals(files.map((f) => f.confirmed), [false, false]);
  const confirmed = await s.call({
    action: 'confirm_transcripts',
    plan_id: PLAN,
    source_id: SOURCE2,
    files: [{ id: files[1].id, transcript: 'Cells divide by mitosis (page 2).' }],
  });
  assertEquals(confirmed.status, 202);

  // The outline sees the plan's approved topics and folds the notes into them: page 2 continues
  // "Cells", page 1 is a new topic.
  s.tracy.tasks.dualrep_build_outline = (input) => {
    const existing = input.existing_topics as { id: string; title: string }[];
    assertEquals(existing.map((t) => t.title), ['Cells', 'Energy']);
    const chunks = input.chunks as { id: string; page: number }[];
    const out: OutlineOutput = {
      topics: [
        { key: 't1', title: 'Osmosis', summary: 'Water and membranes.', existing_topic_id: null, chunk_ids: chunks.filter((c) => c.page === 1).map((c) => c.id) },
        { key: 't2', title: 'Cells', summary: 'Cell division.', existing_topic_id: existing[0].id, chunk_ids: chunks.filter((c) => c.page === 2).map((c) => c.id) },
      ],
      unassigned_chunk_ids: [],
    };
    return answer(out);
  };
  const r = await s.step();
  assertEquals(r.kind === 'step' && [r.stage, r.outcome], ['outline', 'done']);
  const drafts = [...s.store.topics.values()].filter((t) => t.status === 'draft');
  assertEquals(drafts.map((t) => [t.title, t.position]), [['Osmosis', 2]], 'only the new topic waits for review');
  assertEquals(s.store.jobsOf(SOURCE2, 'cards'), [], 'nothing is made before the review');

  const approved = await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: [{ id: drafts[0].id, keep: true }] });
  assertEquals(approved.status, 202);
  // Cards for the new topic and for the existing topic the notes continue.
  assertEquals(s.store.jobsOf(SOURCE2, 'cards').map((j) => j.input.topic_id).sort(), [drafts[0].id, cells.id].sort());
  const results = await s.drain();
  assertEquals(results.map((x) => x.kind === 'step' && x.stage), ['cards', 'cards']);
  assertEquals([...s.store.topics.values()].map((t) => t.status), ['ready', 'ready', 'ready']);
  assertEquals(s.store.sources.get(SOURCE2)?.status, 'ready');
  assert(s.store.cards.size > pdfCards);
  // Each new card cites a chunk of the notes, and the page it came from.
  const notesChunks = new Set([...s.store.chunks.values()].filter((c) => c.source_id === SOURCE2).map((c) => c.id));
  const notesCards = [...s.store.cards.values()].filter((c) => notesChunks.has(c.source_chunk_id));
  assertEquals(notesCards.map((c) => [c.topic_id === cells.id, c.page]).sort(), [[false, 1], [true, 2]]);
});

Deno.test('an outline that only adds to existing topics needs no review: its cards are made at once', async () => {
  const s = scenario({ scope: 'cumulative' });
  scriptPdf(s);
  await submitPdf(s);
  await s.drain();
  const pdfDrafts = [...s.store.topics.values()].sort((a, b) => a.position - b.position);
  await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: null, topics: pdfDrafts.map((t) => ({ id: t.id, keep: true })) });
  await s.drain();

  await notesTranscribed(s, SOURCE2, 1, 'Mitochondria make ATP');
  await s.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE2, files: [] });
  s.tracy.tasks.dualrep_build_outline = (input) => {
    const ids = (input.chunks as { id: string }[]).map((c) => c.id);
    const energy = (input.existing_topics as { id: string; title: string }[]).find((t) => t.title === 'Energy')!;
    return answer({ topics: [{ key: 't1', title: 'Energy', summary: '', existing_topic_id: energy.id, chunk_ids: ids }], unassigned_chunk_ids: [] });
  };
  const results = await s.drain();
  assertEquals(results.map((x) => x.kind === 'step' && `${x.stage}:${x.outcome}`), ['outline:done', 'cards:done']);
  // No draft ever appeared (the phone would have had nothing to review), the source is done.
  assertEquals([...s.store.topics.values()].map((t) => t.status), ['ready', 'ready']);
  assertEquals(s.store.sources.get(SOURCE2)?.status, 'ready');
  const outline = s.store.jobs.get(await outlineJobId(SOURCE2))!;
  assertEquals((outline.output as { approved_at: string | null }).approved_at !== null, true);
  // A later approve_outline from the phone finds nothing new to approve.
  const again = await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: SOURCE2, topics: [] });
  assertEquals([again.status, (again.body as { already_approved: boolean }).already_approved], [200, true]);

  // When the topic it continued was deleted meanwhile, there is nothing to make: the source is done.
  const s2 = scenario({ scope: 'cumulative' });
  s2.store.topics.set('80000000-0000-4000-8000-000000000001', { id: '80000000-0000-4000-8000-000000000001', plan_id: PLAN, title: 'Old', position: 0, status: 'ready' });
  await notesTranscribed(s2, SOURCE2, 1, 'Something');
  await s2.call({ action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE2, files: [] });
  s2.tracy.tasks.dualrep_build_outline = (input) => {
    const ids = (input.chunks as { id: string }[]).map((c) => c.id);
    s2.store.topics.delete('80000000-0000-4000-8000-000000000001');
    return answer({ topics: [{ key: 't1', title: 'Old', summary: '', existing_topic_id: '80000000-0000-4000-8000-000000000001', chunk_ids: ids }], unassigned_chunk_ids: [] });
  };
  await s2.drain();
  assertEquals(s2.store.jobsOf(SOURCE2, 'cards'), []);
  assertEquals(s2.store.sources.get(SOURCE2)?.status, 'ready');
});

Deno.test('Tracy asleep: the job is put back uncounted and no kick follows', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  s.tracy.awake = false;
  s.kicks.length = 0;
  const r = await s.step();
  assertEquals(r.kind === 'step' && r.outcome, 'release');
  const job = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals([job.status, job.attempts, job.locked_at], ['queued', 0, null]);
  assertEquals(s.tracy.calls.length, 0);
  assertEquals(s.kicks, []);
});

Deno.test('Tracy unreachable for a quarter of an hour: the job fails with a message instead of waiting for ever', async () => {
  const s = scenario();
  await submitPdf(s);
  s.tracy.awake = false; // suspended by Render, or TRACY_URL points at the wrong place
  const results = await s.drain(MAX_RELEASES + 5);
  assertEquals(results.map((x) => x.kind === 'step' && x.outcome), [...Array(MAX_RELEASES - 1).fill('release'), 'fail']);
  const job = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals([job.status, job.error], ['failed', MESSAGES.tracyUnreachable]);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'failed');
  assertEquals(s.tracy.calls.length, 0);
});

Deno.test('reaching Tracy again starts the count of releases over', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  s.tracy.awake = false;
  await s.drain(MAX_RELEASES - 2);
  s.tracy.awake = true;
  s.tracy.onExtract = () => failure({ kind: 'network' });
  const reached = await s.step();
  assertEquals(reached.kind === 'step' && reached.outcome, 'retry');
  assertEquals(s.store.jobsOf(SOURCE, 'extract')[0].releases, 0);
  s.tracy.awake = false;
  const r = await s.drain(3);
  assertEquals(r.map((x) => x.kind === 'step' && x.outcome), ['release', 'release', 'release']);
});

Deno.test("Render's HTML error page after a passing /health is counted: a file that crashes Tracy fails and stops blocking the queue", async () => {
  const s = scenario();
  await submitPdf(s);
  // Another user's PDF, submitted later.
  const PLAN2 = '50000000-0000-4000-8000-000000000002';
  s.store.addPlan({ id: PLAN2, owner_id: OTHER });
  const PDF2 = `${OTHER}/${SOURCE2}/1.pdf`;
  s.store.upload(PDF2, 'application/pdf');
  await s.call({ action: 'submit_source', plan_id: PLAN2, source_id: SOURCE2, kind: 'pdf', title: 'Other', files: [{ path: PDF2 }] }, OTHER);
  s.tracy.onExtract = (b) =>
    b.url.includes(SOURCE)
      ? failure({ kind: 'not_json', status: 502 }) // Tracy runs out of memory on this file; Render answers
      : { ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 2)] } };
  for (let minute = 0; minute < 10; minute++) await s.step();
  const poison = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals([poison.status, poison.attempts, poison.error], ['failed', 3, MESSAGES.tracyBusy]);
  assertEquals(s.tracy.callsOf('extract').filter((c) => String(c.body.url).includes(SOURCE)).length, 3);
  assertEquals(s.store.jobsOf(SOURCE2, 'extract')[0].status, 'succeeded');
});

Deno.test('Tracy busy with another heavy job: put back uncounted', async () => {
  const s = scenario();
  await submitPdf(s);
  s.tracy.onExtract = () => failure({ kind: 'http', status: 503, code: 'busy' });
  const r = await s.step();
  assertEquals(r.kind === 'step' && r.outcome, 'release');
  assertEquals([s.store.jobsOf(SOURCE, 'extract')[0].attempts, s.store.jobsOf(SOURCE, 'extract')[0].releases], [0, 1]);
});

Deno.test('at most maxRunning jobs at once: a worker started while one runs finds nothing to claim', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  s.store.upload(`${USER}/${SOURCE2}/1.pdf`, 'application/pdf');
  await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE2, kind: 'pdf', title: 'Two', files: [{ path: `${USER}/${SOURCE2}/1.pdf` }] });
  // While the first extraction waits on Tracy, the cron minute starts another worker.
  let second: Awaited<ReturnType<typeof runOneStep>> | null = null;
  s.tracy.onExtract = async () => {
    if (!second) second = await runOneStep({ ...s.worker, maxRunning: 1 });
    return { ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 1)] } };
  };
  await runOneStep({ ...s.worker, maxRunning: 1 });
  assertEquals(second, { kind: 'idle' });
  assertEquals(s.tracy.callsOf('extract').length, 1);
  // Without a limit the second worker would have taken the other job.
  const t = scenario();
  scriptPdf(t);
  t.store.upload(PDF, 'application/pdf');
  t.store.upload(`${USER}/${SOURCE2}/1.pdf`, 'application/pdf');
  await t.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'pdf', title: 'One', files: [{ path: PDF }] });
  await t.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE2, kind: 'pdf', title: 'Two', files: [{ path: `${USER}/${SOURCE2}/1.pdf` }] });
  let other: Awaited<ReturnType<typeof runOneStep>> | null = null;
  t.tracy.onExtract = async () => {
    if (!other) other = await runOneStep({ ...t.worker, maxRunning: null });
    return { ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 1)] } };
  };
  await runOneStep({ ...t.worker, maxRunning: null });
  assertEquals((other as unknown as { kind: string }).kind, 'step');
});

Deno.test("rejected answers are retried with the validator's findings, then fail with a fixed message", async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  await s.drain(3); // extract × 2, transcribe
  const findings = ['topics[0].chunk_ids[1] is not a chunk id from the input'];
  s.tracy.tasks.dualrep_build_outline = () => failure({ kind: 'http', status: 502, code: 'invalid_output', errors: findings });
  const results = await s.drain();
  assertEquals(results.map((x) => x.kind === 'step' && x.outcome), ['retry', 'retry', 'fail']);
  const calls = s.tracy.callsOf('dualrep_build_outline');
  assertEquals(calls.map((c) => c.body.previous_errors), [[], findings, findings]);
  const outline = s.store.jobs.get(await outlineJobId(SOURCE))!;
  assertEquals([outline.status, outline.error, outline.attempts], ['failed', MESSAGES.badAnswer, 3]);
  // The outline is on the critical path: the source has failed (the phone shows "Try again").
  assertEquals(s.store.sources.get(SOURCE)?.status, 'failed');
});

Deno.test('outline: short references instead of chunk ids, and a shorter digest after an answer that was cut off', async () => {
  const s = scenario();
  await submitPdf(s);
  // A long course PDF: 300 passages.
  s.tracy.onExtract = () => ({ ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 300)] } });
  let calls = 0;
  s.tracy.tasks.dualrep_build_outline = (input) => {
    calls += 1;
    const ids = (input.chunks as { id: string }[]).map((c) => c.id);
    if (calls < 3) return failure({ kind: 'http', status: 502, code: calls === 1 ? 'truncated' : 'model_error' });
    return answer({
      topics: [{ key: 't1', title: 'All of it', summary: '', existing_topic_id: null, chunk_ids: ids }],
      unassigned_chunk_ids: [],
    } satisfies OutlineOutput);
  };
  await s.drain();
  const sent = s.tracy.callsOf('dualrep_build_outline').map((c) => c.body.chunks as { id: string }[]);
  // Never the same input twice: 150 entries (pairs of neighbours), then 75, then 50.
  assertEquals(sent.map((c) => c.length), [150, 75, 50]);
  assertEquals(sent[0].slice(0, 3).map((c) => c.id), ['c1', 'c2', 'c3']);
  assert(sent.every((c) => (s.tracy.callsOf('dualrep_build_outline')[0].body.max_topics as number) <= c.length));
  // The answer's references expand back to every one of the 300 passages.
  const outline = s.store.jobs.get(await outlineJobId(SOURCE))!;
  assertEquals(outline.status, 'succeeded');
  const saved = outline.output as { topics: { chunk_ids: string[] }[] };
  assertEquals(new Set(saved.topics[0].chunk_ids), new Set([...s.store.chunks.keys()]));
  assertEquals(saved.topics[0].chunk_ids.length, 300);
});

Deno.test('outline: an answer still cut off at the smallest digest fails with the length message', async () => {
  const s = scenario();
  await submitPdf(s);
  s.tracy.onExtract = () => ({ ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 20)] } });
  s.tracy.tasks.dualrep_build_outline = () => failure({ kind: 'http', status: 502, code: 'truncated' });
  await s.drain();
  const sent = s.tracy.callsOf('dualrep_build_outline').map((c) => (c.body.chunks as unknown[]).length);
  assertEquals(sent, [20, 20, 20]); // 20 passages are already under the smallest digest
  assertEquals(s.store.jobs.get(await outlineJobId(SOURCE))?.error, MESSAGES.tooLong);
});

Deno.test('a refusal fails at once; the error never carries the material', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  await s.drain(4); // through the outline
  const drafts = [...s.store.topics.values()];
  await s.call({ action: 'approve_outline', plan_id: PLAN, source_id: SOURCE, topics: drafts.map((t) => ({ id: t.id, keep: true })) });
  s.tracy.tasks.dualrep_build_cards = () => failure({ kind: 'http', status: 502, code: 'refused' });
  await s.drain();
  const cards = s.store.jobsOf(SOURCE, 'cards');
  assertEquals(cards.map((j) => [j.status, j.error, j.attempts]), [['failed', MESSAGES.refused, 1], ['failed', MESSAGES.refused, 1]]);
  // No cards job is open any more, so the source is done; the topics stay confirmed (no cards).
  assertEquals(s.store.sources.get(SOURCE)?.status, 'ready');
  assertEquals([...s.store.topics.values()].map((t) => t.status), ['confirmed', 'confirmed']);
  for (const j of s.store.jobs.values()) assertFalse((j.error ?? '').includes('cell is the unit'));
  // The log has one metadata line per step, with the upstream code and never the material.
  assert(s.logs.some((l) => l.stage === 'cards' && l.outcome === 'fail' && l.code === 'refused'));
  const logged = JSON.stringify(s.logs);
  for (const text of ['unit of life', 'Mitochondria', 'Question about', 'token=']) assertFalse(logged.includes(text), text);
});

Deno.test("outline: Tracy's answer is kept first, so a run cut short resumes without a second call", async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  await s.drain(3);
  s.store.failNext.insertTopics = true; // the database drops out after the answer was saved
  let r = await s.step();
  assertEquals(r.kind === 'step' && r.outcome, 'retry');
  const job = s.store.jobs.get(await outlineJobId(SOURCE))!;
  assertEquals([job.status, (job.output as { phase: string }).phase], ['queued', 'saved']);
  assertEquals(s.store.topics.size, 0);
  r = await s.step();
  assertEquals(r.kind === 'step' && r.outcome, 'done');
  assertEquals(s.tracy.callsOf('dualrep_build_outline').length, 1);
  assertEquals(s.store.topics.size, 2);
});

Deno.test('fencing: a job cancelled while Tracy works is never overwritten', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  await s.drain(3);
  const outlineId = await outlineJobId(SOURCE);
  const original = s.tracy.tasks.dualrep_build_outline;
  s.tracy.tasks.dualrep_build_outline = async (input, id) => {
    const r = await s.call({ action: 'cancel_job', job_id: outlineId });
    assertEquals(r.status, 200);
    return original(input, id);
  };
  const r = await s.step();
  assertEquals(r.kind === 'step' && [r.outcome, r.applied], ['lost', false]);
  const job = s.store.jobs.get(outlineId)!;
  assertEquals([job.status, job.output], ['cancelled', null]);
  assertEquals(s.store.topics.size, 0);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'failed');
});

Deno.test('scanned pages over the monthly page limit are skipped with a note; the text still gets an outline', async () => {
  const s = scenario({ caps: { sources: DEFAULT_CAPS.sources, pages: { free: 0, paid: 0 } } });
  scriptPdf(s);
  await submitPdf(s);
  await s.drain(3); // extract × 2, then the outline (nothing to transcribe)
  const extract = s.store.jobsOf(SOURCE, 'extract')[0];
  assertEquals(extract.status, 'succeeded');
  assertEquals(extract.error, "1 scanned page wasn't transcribed: this month's page limit is used up.");
  assertEquals(s.store.jobsOf(SOURCE, 'transcribe'), []);
  assertEquals(s.store.jobsOf(SOURCE, 'outline')[0].status, 'succeeded');
});

Deno.test('a scan entirely over the page limit fails its outline with the reason', async () => {
  const s = scenario({ caps: { sources: DEFAULT_CAPS.sources, pages: { free: 0, paid: 0 } } });
  s.store.upload(PDF, 'application/pdf');
  s.tracy.onExtract = () => ({ ok: true, data: { format: 'pdf', total_pages: 2, first_page: 1, last_page: 2, pages: [scannedPage(1), scannedPage(2)] } });
  await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'pdf', title: 'Scan', files: [{ path: PDF }] });
  await s.drain();
  assertEquals(s.store.jobsOf(SOURCE, 'outline')[0].error, MESSAGES.pageCapUsed);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'failed');
  assertEquals(s.tracy.callsOf('dualrep_build_outline').length, 0);
});

Deno.test('a link that cannot be fetched fails the source with a link message', async () => {
  const s = scenario();
  const r = await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'link', title: 'Wiki', url: 'https://example.org/cells', files: [] });
  assertEquals(r.status, 202);
  s.tracy.onExtract = (b) => {
    assertEquals([b.url, b.kind], ['https://example.org/cells', 'link']);
    return failure({ kind: 'http', status: 422, code: 'fetch_failed' });
  };
  await s.drain();
  assertEquals(s.store.jobsOf(SOURCE, 'extract')[0].error, MESSAGES.linkUnreachable);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'failed');
});

Deno.test('handwritten notes: each photo becomes a draft transcript the person confirms', async () => {
  const s = scenario();
  for (const n of [1, 2]) s.store.upload(`${USER}/${SOURCE}/${n}.jpg`, 'image/jpeg', 500_000);
  const submitted = await s.call({
    action: 'submit_source',
    plan_id: PLAN,
    source_id: SOURCE,
    kind: 'notes',
    title: 'Notes',
    files: [{ path: `${USER}/${SOURCE}/1.jpg` }, { path: `${USER}/${SOURCE}/2.jpg` }],
  });
  assertEquals(submitted.status, 202);
  s.tracy.tasks.dualrep_transcribe_notes = (input) =>
    answer({ status: 'draft', page: { page: input.page, blank: input.page === 2, transcript: input.page === 2 ? '' : 'Osmosis [?moves?] water.', legibility: 'fair', uncertain: ['moves'], diagrams: [] } });
  await s.drain();
  const calls = s.tracy.callsOf('dualrep_transcribe_notes');
  assertEquals(calls.map((c) => [c.body.page, c.body.subject]), [[1, 'Biology 101'], [2, 'Biology 101']]);
  assert(String(calls[0].body.image_url).includes(`${USER}/${SOURCE}/1.jpg`));
  const files = [...s.store.files.values()].sort((a, b) => a.page! - b.page!);
  assertEquals(files.map((f) => [f.page, f.transcript, f.confirmed]), [[1, 'Osmosis [?moves?] water.', false], [2, '', false]]);
  // Nothing more happens until the person confirms.
  assertEquals(s.store.jobsOf(SOURCE, 'outline'), []);
  assertEquals(s.store.sources.get(SOURCE)?.status, 'processing');
});

Deno.test('embeddings run beside the outline in batches and never block it', async () => {
  const s = scenario({ embeddings: true });
  s.store.upload(PDF, 'application/pdf');
  s.tracy.onExtract = () => ({ ok: true, data: { format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [textPage(1, 120)] } });
  s.tracy.tasks.dualrep_build_outline = () => failure({ kind: 'http', status: 502, code: 'refused' });
  await s.call({ action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'pdf', title: 'Big', files: [{ path: PDF }] });
  const results = await s.drain();
  assertEquals(results.map((x) => x.kind === 'step' && `${x.stage}:${x.outcome}`), [
    'extract:done',
    'outline:fail',
    'embed:continue',
    'embed:continue',
    'embed:done',
  ]);
  assert([...s.store.chunks.values()].every((c) => c.embedding !== null && c.embed_model === 'gemini-embedding-2@1536#p1'));
  assertEquals(s.store.jobs.get(await embedJobId(SOURCE))?.status, 'succeeded');
});

Deno.test('a database outage mid-step is retried, then fails after the third attempt', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  s.tracy.onExtract = () => {
    s.store.failNext.insertJob = true;
    throw Object.assign(new Error('boom'), { name: 'DbError' });
  };
  const results = await s.drain();
  assertEquals(results.map((x) => x.kind === 'step' && x.outcome), ['retry', 'retry', 'fail']);
  assertEquals(s.store.jobsOf(SOURCE, 'extract')[0].error, MESSAGES.tracyBusy);
  assert(s.logs.some((l) => l.error === 'DbError'));
});

Deno.test('jobs outside the pipeline, and a Tracy that is not configured, fail clearly', async () => {
  const s = scenario();
  s.store.jobs.set('a0000000-0000-4000-8000-000000000001', {
    id: 'a0000000-0000-4000-8000-000000000001',
    user_id: USER,
    job: 'analyst',
    stage: null,
    status: 'queued',
    input: {},
    output: null,
    error: null,
    attempts: 0,
    locked_at: null,
    plan_id: null,
    source_id: null,
    created_at: s.store.tick(),
    cap_units: 0,
  });
  await s.step();
  assertEquals(s.store.jobs.get('a0000000-0000-4000-8000-000000000001')?.error, MESSAGES.unknownJob);

  await submitPdf(s);
  const r = await runOneStep({ ...s.worker, tracy: null });
  assertEquals(r.kind === 'step' && r.outcome, 'fail');
  assertEquals(s.store.jobsOf(SOURCE, 'extract')[0].error, MESSAGES.notSetUp);
});

Deno.test('the self-kick stops after MAX_HOPS in a row', async () => {
  const s = scenario();
  scriptPdf(s);
  await submitPdf(s);
  s.kicks.length = 0;
  await s.step(MAX_HOPS); // makes progress, work stays queued, but the chain is long enough
  assertEquals(s.kicks, []);
  await s.step(3);
  assertEquals(s.kicks, [4]);
});

Deno.test('the sweep removes files no source_files row points at', async () => {
  const s = scenario();
  s.store.upload(`${USER}/${SOURCE}/1.pdf`, 'application/pdf');
  s.store.objects.get(`${USER}/${SOURCE}/1.pdf`)!.orphanedSince = true;
  s.store.upload(`${USER}/${SOURCE}/2.pdf`, 'application/pdf');
  assertEquals(await sweepOrphans(s.store), 1);
  assertEquals([...s.store.objects.keys()], [`${USER}/${SOURCE}/2.pdf`]);
});
