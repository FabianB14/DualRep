import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { cardId, cardsJobId, chunkId, draftTopicId, outlineJobId } from './ids.ts';
import {
  cardRows,
  cardsJobs,
  cardsProgress,
  chunkOrdinals,
  CHUNKS_PER_CARDS_JOB,
  confirmGate,
  draftTopicRows,
  type ExtractResponse,
  failsSource,
  type JobRow,
  linkedExistingIds,
  maxCardsFor,
  maxTopicsFor,
  outlineGate,
  pageBatches,
  planApproval,
  planExtractWindow,
  previousErrors,
  saveOutline,
  stageOf,
  type TopicRow,
} from './pipeline.ts';

const S = '70000000-0000-4000-8000-000000000001';
const PLAN = '50000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';
const job = (stage: string, status: JobRow['status'], extra: Partial<JobRow> = {}) =>
  ({ id: crypto.randomUUID(), stage, status, input: {}, ...extra }) as JobRow;

Deno.test('stageOf accepts only the pipeline pairs of job and stage', () => {
  assertEquals(stageOf({ job: 'study_builder', stage: 'extract' }), 'extract');
  assertEquals(stageOf({ job: 'handwriting', stage: 'transcribe' }), 'transcribe');
  assertEquals(stageOf({ job: 'handwriting', stage: 'cards' }), null);
  assertEquals(stageOf({ job: 'study_builder', stage: null }), null);
  assertEquals(stageOf({ job: 'analyst', stage: 'outline' }), null);
});

Deno.test('planExtractWindow: text chunks, scanned pages and the next window', () => {
  const res: ExtractResponse = {
    format: 'pdf',
    total_pages: 212,
    first_page: 1,
    last_page: 100,
    pages: [
      { page: 1, needs_transcription: false, chunks: [{ ordinal: 0, title: 'Cells', content: ' Cells divide. ' }, { ordinal: 1, title: '', content: '  ' }] },
      { page: 2, needs_transcription: true, chunks: [] },
      { page: 4, needs_transcription: true, chunks: [] },
      { page: 3, needs_transcription: false, chunks: [{ ordinal: 0, title: '', content: 'Mitosis.' }] },
    ],
  };
  const w = planExtractWindow(1, res);
  assertEquals(w.chunks, [
    { page: 1, ordinal: 0, content: 'Cells divide.' },
    { page: 3, ordinal: 0, content: 'Mitosis.' },
  ]);
  assertEquals(w.scanned, [2, 4]);
  assertEquals(w.nextCursor, 101);
  assertEquals(planExtractWindow(101, { ...res, first_page: 101, last_page: 212, pages: [] }).nextCursor, null);
  // A document without pages (docx, web page) has one window.
  assertEquals(
    planExtractWindow(1, { format: 'docx', total_pages: null, first_page: null, last_page: null, pages: [{ page: null, needs_transcription: false, chunks: [{ ordinal: 0, title: '', content: 'x' }] }] }),
    { chunks: [{ page: null, ordinal: 0, content: 'x' }], scanned: [], nextCursor: null },
  );
  // A misbehaving answer that does not advance never loops.
  assertEquals(planExtractWindow(50, { ...res, last_page: 10 }).nextCursor, null);
});

Deno.test('pageBatches: sorted, distinct, at most 4 pages per job', () => {
  assertEquals(pageBatches([9, 2, 3, 2, 5, 7, 8, 1, 4]), [[1, 2, 3, 4], [5, 7, 8, 9]]);
  assertEquals(pageBatches([]), []);
});

Deno.test('chunkOrdinals recovers the position of each chunk within its page', async () => {
  const rows = [
    { id: await chunkId(S, 2, 1), page: 2 },
    { id: await chunkId(S, 2, 0), page: 2 },
    { id: await chunkId(S, null, 3), page: null },
  ];
  const ord = await chunkOrdinals(S, rows);
  assertEquals(ord.get(rows[0].id), 1);
  assertEquals(ord.get(rows[1].id), 0);
  assertEquals(ord.get(rows[2].id), 3);
});

Deno.test('outlineGate waits for extraction and every page transcription', async () => {
  const outline = await outlineJobId(S);
  assertEquals(outlineGate([], outline), 'wait');
  assertEquals(outlineGate([job('extract', 'running')], outline), 'wait');
  assertEquals(outlineGate([job('extract', 'succeeded')], outline), 'ready');
  assertEquals(outlineGate([job('extract', 'succeeded'), job('transcribe', 'queued')], outline), 'wait');
  assertEquals(outlineGate([job('extract', 'succeeded'), job('transcribe', 'failed')], outline), 'wait');
  assertEquals(
    outlineGate([job('extract', 'succeeded'), job('transcribe', 'succeeded'), job('transcribe', 'cancelled')], outline),
    'ready',
  );
  assertEquals(outlineGate([job('extract', 'failed')], outline), 'blocked');
  assertEquals(outlineGate([job('extract', 'succeeded'), job('outline', 'failed', { id: outline })], outline), 'exists');
});

Deno.test('confirmGate: every photo finished, nothing confirmed yet', () => {
  assertEquals(confirmGate([job('transcribe', 'succeeded'), job('transcribe', 'cancelled')]), { ok: true });
  assertEquals(confirmGate([job('transcribe', 'running')]).ok, false);
  assertEquals(confirmGate([job('transcribe', 'failed')]).ok, false);
  assertEquals(confirmGate([job('transcribe', 'succeeded'), job('outline', 'queued')]).ok, false);
});

Deno.test('maxTopicsFor and maxCardsFor stay inside Tracy limits', () => {
  assertEquals([1, 5, 6, 100, 700, 5000].map(maxTopicsFor), [1, 1, 2, 20, 30, 30]);
  assertEquals([1, 2, 7, 13, 40].map(maxCardsFor), [2, 3, 11, 20, 20]);
});

Deno.test('previousErrors keeps strings only, at most 50', () => {
  assertEquals(previousErrors({ previous_errors: ['a', 3, 'b'] }), ['a', 'b']);
  assertEquals(previousErrors({ previous_errors: Array(60).fill('x') }).length, 50);
  assertEquals(previousErrors({}), []);
});

async function savedOutline() {
  const outlineId = await outlineJobId(S);
  const saved = await saveOutline(outlineId, {
    topics: [
      { key: 't1', title: ' Cells ', summary: 'What cells are.', existing_topic_id: null, chunk_ids: ['g1'] },
      { key: 't2', title: 'Enzymes', summary: 'How enzymes work.', existing_topic_id: null, chunk_ids: ['c3'] },
      { key: 't3', title: 'More on DNA', summary: '', existing_topic_id: 'old-dna', chunk_ids: ['c4'] },
    ],
    unassigned_chunk_ids: ['c5'],
  }, (ids) => ids.flatMap((id) => (id === 'g1' ? ['c1', 'c2'] : [id])));
  return { outlineId, saved };
}

Deno.test('saveOutline expands digest groups and derives the draft topic ids', async () => {
  const { outlineId, saved } = await savedOutline();
  assertEquals(saved.topics[0], {
    key: 't1',
    topic_id: await draftTopicId(outlineId, 't1'),
    existing_topic_id: null,
    title: 'Cells',
    summary: 'What cells are.',
    chunk_ids: ['c1', 'c2'],
  });
  assertEquals(saved.topics[2].topic_id, null);
  assertEquals(saved.approved_at, null);
  const rows = draftTopicRows(saved, PLAN, 4);
  assertEquals(rows.map((r) => [r.title, r.position, r.status]), [['Cells', 5, 'draft'], ['Enzymes', 6, 'draft']]);
});

Deno.test('planApproval: order, renames, cuts, phone deletions and existing topics', async () => {
  const { outlineId, saved } = await savedOutline();
  const [t1, t2] = [saved.topics[0].topic_id!, saved.topics[1].topic_id!];
  const topics: TopicRow[] = [
    { id: 'old-dna', plan_id: PLAN, title: 'DNA', position: 0, status: 'ready' },
    { id: 'other', plan_id: PLAN, title: 'Other', position: 3, status: 'ready' },
    { id: t1, plan_id: PLAN, title: 'Cells', position: 4, status: 'draft' },
    { id: t2, plan_id: PLAN, title: 'Enzymes', position: 5, status: 'draft' },
  ];
  const outlines = [{ job: { id: outlineId, user_id: USER, plan_id: PLAN, source_id: S }, saved }];
  const plan = planApproval(outlines, topics, [
    { id: t2, keep: true, title: '  Enzymes & catalysis ' },
    { id: t1, keep: true },
  ]);
  assertEquals(plan.errors, []);
  assertEquals(plan.keep, [
    { id: t2, title: 'Enzymes & catalysis', position: 4 },
    { id: t1, title: 'Cells', position: 5 },
  ]);
  assertEquals(plan.cut, []);
  assertEquals(plan.cards.map((c) => [c.topic_id, c.chunk_ids]), [[t2, ['c3']], [t1, ['c1', 'c2']], ['old-dna', ['c4']]]);

  // Not listed = cut; deleted on the phone = ignored; existing topic gone = no cards for it.
  const cut = planApproval(outlines, topics.filter((t) => t.id !== 'old-dna' && t.id !== t2), [{ id: t2, keep: true }]);
  assertEquals(cut.keep, []);
  assertEquals(cut.cut, [t1]);
  assertEquals(cut.cards, []);

  // A topic of the outline that is no longer a draft (confirmed or ready, with cards) is never cut,
  // even when the phone does not list it.
  const studied = planApproval(outlines, topics.map((t) => (t.id === t1 ? { ...t, status: 'ready' as const } : t)), [{ id: t2, keep: true }]);
  assertEquals(studied.cut, []);
  assertEquals(studied.keep.map((k) => k.id), [t2]);

  assertEquals(planApproval(outlines, topics, [{ id: 'old-dna', keep: true }]).errors, ['topics[0].id is not a draft topic of this outline']);
  assertEquals(planApproval(outlines, topics, [{ id: t1, keep: true }, { id: t1, keep: false }]).errors, ['topics[1].id is listed twice']);
});

Deno.test('cardsJobs splits a long topic into jobs of at most 40 chunks with derived ids', async () => {
  const chunkIds = Array.from({ length: 85 }, (_, i) => `c${i}`);
  const jobs = await cardsJobs(USER, PLAN, { source_id: S, topic_id: 'topic-1', chunk_ids: chunkIds, summary: 'S' });
  assertEquals(jobs.map((j) => (j.input.chunk_ids as string[]).length), [CHUNKS_PER_CARDS_JOB, CHUNKS_PER_CARDS_JOB, 5]);
  assertEquals(jobs[2].id, await cardsJobId(S, 'topic-1', 2));
  assertEquals(jobs[0].input, { plan_id: PLAN, source_id: S, topic_id: 'topic-1', chunk_ids: chunkIds.slice(0, 40), topic_summary: 'S' });
  assertEquals([jobs[0].job, jobs[0].stage, jobs[0].user_id], ['study_builder', 'cards', USER]);
});

Deno.test('cardRows: derived ids, links to new or still-existing cards only, created_by = the user', async () => {
  const j = { id: '90000000-0000-4000-8000-000000000001', user_id: USER };
  const out = {
    cards: [
      { key: 'c1', card_type: 'basic', question: 'Q1', answer: 'A1', source_chunk_id: 'ch1', page: 3, quote: 'q' },
      { key: 'c2', card_type: 'cloze', question: 'The ____', answer: 'A2', source_chunk_id: 'ch2', page: null, quote: 'q' },
    ],
    links: [
      { from_key: 'c1', to: 'c2', relation: 'why', note: null },
      { from_key: 'c1', to: 'old-card', relation: 'related', note: 'n' },
      { from_key: 'c2', to: 'deleted-card', relation: 'contrast', note: null },
    ],
  };
  assertEquals(linkedExistingIds(out), ['old-card', 'deleted-card']);
  const { cards, links } = await cardRows(j, { plan_id: PLAN, topic_id: 'topic-1' }, out, new Set(['old-card']));
  assertEquals(cards[0], {
    id: await cardId(j.id, 'c1'),
    topic_id: 'topic-1',
    plan_id: PLAN,
    source_chunk_id: 'ch1',
    page: 3,
    question: 'Q1',
    answer: 'A1',
    card_type: 'basic',
  });
  assertEquals(links.map((l) => [l.from_card_id, l.to_card_id, l.created_by]), [
    [cards[0].id, cards[1].id, USER],
    [cards[0].id, 'old-card', USER],
  ]);
});

Deno.test('cardsProgress: topic and source are done when none of their cards jobs is open', () => {
  const jobs = [
    job('cards', 'succeeded', { input: { topic_id: 'a' } }),
    job('cards', 'running', { input: { topic_id: 'b' } }),
    job('outline', 'succeeded'),
  ];
  assertEquals(cardsProgress(jobs, 'a'), { topicDone: true, sourceDone: false });
  assertEquals(cardsProgress(jobs, 'b'), { topicDone: false, sourceDone: false });
  assertEquals(cardsProgress(jobs.slice(0, 1), 'a'), { topicDone: true, sourceDone: true });
});

Deno.test('failsSource: only extraction and the outline stop a source', () => {
  assert(failsSource('extract') && failsSource('outline'));
  assert(!failsSource('transcribe') && !failsSource('cards') && !failsSource('embed'));
});
