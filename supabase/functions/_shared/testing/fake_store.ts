/**
 * An in-memory Store and UserView for `deno test`, with the database behaviour the pipeline relies on:
 * claim (oldest queued, attempt counted, lock time set), release, the fenced finish, derived-id
 * inserts that ignore duplicates, the monthly cap (enqueue_tracy_event), cascades on delete, and the
 * `sources` bucket. Not a database: no RLS (UserView returns every row), no triggers beyond the
 * cascades noted, one month only.
 */
import type { CapReached } from '../errors.ts';
import type { JobRow, JobStatus, NewJob, Stage, TopicRow } from '../pipeline.ts';
import type {
  Approval,
  CardLinkRow,
  CardRow,
  ChunkRow,
  CountedEnqueue,
  Fence,
  JobPatch,
  PlanRow,
  SourceFileRow,
  SourceRow,
  Store,
  StoredObject,
  UserView,
} from '../store.ts';

export type FakeJob = JobRow & { cap_units: number; model?: string | null; usage?: unknown };
export type FakeChunk = ChunkRow & { embedding: number[] | null; embed_model: string | null };

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class FakeStore implements Store {
  jobs = new Map<string, FakeJob>();
  sources = new Map<string, SourceRow>();
  files = new Map<string, SourceFileRow>();
  chunks = new Map<string, FakeChunk>();
  plans = new Map<string, PlanRow>();
  planSources: { plan_id: string; source_id: string }[] = [];
  topics = new Map<string, TopicRow>();
  cards = new Map<string, CardRow>();
  links = new Map<string, CardLinkRow>();
  /** Bucket objects by full path. */
  objects = new Map<string, StoredObject & { orphanedSince?: boolean }>();
  paidUsers = new Set<string>();
  /** Set to make the next call of that method throw (simulated outage), then clear itself. */
  failNext: Partial<Record<keyof Store, boolean>> = {};
  private ms = Date.parse('2026-10-09T10:00:00.000Z');

  /** A strictly increasing timestamp (ISO, microsecond-style like Postgres). */
  tick(): string {
    this.ms += 1;
    return new Date(this.ms).toISOString().replace('Z', '000+00:00');
  }

  private maybeFail(name: keyof Store) {
    if (this.failNext[name]) {
      delete this.failNext[name];
      throw Object.assign(new Error('simulated'), { name: 'DbError', code: '08006' });
    }
  }

  // ---- seeding helpers (tests) ----

  addPlan(p: Partial<PlanRow> & { id: string; owner_id: string }): PlanRow {
    const row: PlanRow = { title: 'Biology 101', scope: 'cumulative', goal: '', target_date: null, ...p };
    this.plans.set(row.id, row);
    return row;
  }

  upload(path: string, mimetype: string, size = 1000) {
    this.objects.set(path, { name: path.split('/').pop()!, size, mimetype });
  }

  jobsOf(sourceId: string, stage?: Stage): FakeJob[] {
    return [...this.jobs.values()].filter((j) => j.source_id === sourceId && (!stage || j.stage === stage))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // ---- the job queue ----

  claimJob(maxRunning: number | null): Promise<JobRow | null> {
    this.maybeFail('claimJob');
    // Like claim_tracy_events: a run locked less than 3 minutes ago holds a place.
    const fresh = this.ms - 3 * 60_000;
    const running = [...this.jobs.values()].filter((j) =>
      j.status === 'running' && j.locked_at !== null && Date.parse(j.locked_at) > fresh
    ).length;
    if (maxRunning !== null && running >= maxRunning) return Promise.resolve(null);
    const next = [...this.jobs.values()].filter((j) => j.status === 'queued')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
    if (!next) return Promise.resolve(null);
    next.status = 'running';
    next.attempts += 1;
    next.locked_at = this.tick();
    return Promise.resolve(clone(next));
  }

  releaseJob(fence: Fence): Promise<boolean> {
    const j = this.jobs.get(fence.id);
    if (!j || j.status !== 'running' || j.attempts !== fence.attempts) return Promise.resolve(false);
    j.status = 'queued';
    j.attempts = Math.max(j.attempts - 1, 0);
    j.locked_at = null;
    j.releases = (j.releases ?? 0) + 1;
    return Promise.resolve(true);
  }

  finishJob(fence: Fence, patch: JobPatch): Promise<boolean> {
    this.maybeFail('finishJob');
    const j = this.jobs.get(fence.id);
    if (!j || j.status !== 'running' || j.attempts !== fence.attempts || j.locked_at !== fence.locked_at) {
      return Promise.resolve(false);
    }
    Object.assign(j, clone(patch));
    return Promise.resolve(true);
  }

  getJob(id: string): Promise<JobRow | null> {
    return Promise.resolve(clone(this.jobs.get(id) ?? null));
  }

  updateJobIf(id: string, from: JobStatus[], patch: JobPatch): Promise<JobRow | null> {
    const j = this.jobs.get(id);
    if (!j || !from.includes(j.status)) return Promise.resolve(null);
    Object.assign(j, clone(patch));
    return Promise.resolve(clone(j));
  }

  sourceJobs(sourceId: string): Promise<JobRow[]> {
    return Promise.resolve(this.jobsOf(sourceId).map((j) => ({ ...clone(j), output: null })));
  }

  planJobs(planId: string, stage: Stage): Promise<JobRow[]> {
    return Promise.resolve(
      [...this.jobs.values()].filter((j) => j.plan_id === planId && j.stage === stage).map(clone),
    );
  }

  insertJob(job: NewJob): Promise<boolean> {
    this.maybeFail('insertJob');
    if (this.jobs.has(job.id)) return Promise.resolve(false);
    this.jobs.set(job.id, {
      ...clone(job),
      status: 'queued',
      output: null,
      error: null,
      attempts: 0,
      locked_at: null,
      created_at: this.tick(),
      cap_units: 0,
    });
    return Promise.resolve(true);
  }

  /** check_tracy_cap: null when `units` more fit this month, else the refusal. */
  private capCheck(
    userId: string,
    stage: string | null,
    units: number,
    limits: { free_limit: number | null; paid_limit: number | null },
  ): CapReached | null {
    const used = [...this.jobs.values()]
      .filter((j) => j.user_id === userId && j.stage === stage && (j.status !== 'cancelled' || j.attempts > 0))
      .reduce((sum, j) => sum + j.cap_units, 0);
    const limit = this.paidUsers.has(userId) ? limits.paid_limit : limits.free_limit;
    if (limit !== null && used + units > limit) {
      return { stage: stage as CapReached['stage'], used, limit, resets_at: '2026-11-01T00:00:00.000Z' };
    }
    return null;
  }

  enqueueCounted(req: CountedEnqueue): Promise<{ ok: true; job: JobRow } | { ok: false; cap: CapReached }> {
    const counted = req.free_limit !== null || req.paid_limit !== null;
    if (counted) {
      const cap = this.capCheck(req.user_id, req.stage, req.units, req);
      if (cap) return Promise.resolve({ ok: false, cap });
    }
    const job: FakeJob = {
      id: crypto.randomUUID(),
      user_id: req.user_id,
      job: req.job,
      stage: req.stage,
      status: 'queued',
      input: clone(req.input),
      output: null,
      error: null,
      attempts: 0,
      locked_at: null,
      plan_id: req.plan_id,
      source_id: req.source_id,
      created_at: this.tick(),
      cap_units: counted ? req.units : 0,
    };
    this.jobs.set(job.id, job);
    return Promise.resolve({ ok: true, job: clone(job) });
  }

  requeueJob(
    id: string,
    limits: { free_limit: number | null; paid_limit: number | null },
  ): Promise<{ ok: true; job: JobRow | null } | { ok: false; cap: CapReached }> {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'failed' && j.status !== 'cancelled')) return Promise.resolve({ ok: true, job: null });
    if (j.status === 'cancelled' && j.attempts === 0 && j.cap_units > 0 && (limits.free_limit !== null || limits.paid_limit !== null)) {
      const cap = this.capCheck(j.user_id, j.stage, j.cap_units, limits);
      if (cap) return Promise.resolve({ ok: false, cap });
    }
    const { previous_errors: _drop, ...input } = j.input;
    Object.assign(j, { status: 'queued', error: null, attempts: 0, locked_at: null, releases: 0, input });
    return Promise.resolve({ ok: true, job: clone(j) });
  }

  applyApproval(a: Approval): Promise<void> {
    // One transaction: a failure leaves everything as it was.
    this.maybeFail('applyApproval');
    for (const k of a.keep) {
      const t = this.topics.get(k.id);
      if (t && t.plan_id === a.plan_id) {
        Object.assign(t, { title: k.title, position: k.position, status: t.status === 'draft' ? 'confirmed' : t.status });
      }
    }
    this.deleteTopicRows(a.cut.filter((id) => this.topics.get(id)?.plan_id === a.plan_id && this.topics.get(id)?.status === 'draft'));
    for (const job of a.jobs) {
      if (!this.jobs.has(job.id)) {
        this.jobs.set(job.id, { ...clone(job), status: 'queued', output: null, error: null, attempts: 0, locked_at: null, releases: 0, created_at: this.tick(), cap_units: 0 });
      }
    }
    for (const id of a.outline_ids) {
      const o = this.jobs.get(id);
      if (o && o.stage === 'outline' && o.status === 'succeeded' && o.output) {
        o.output = { ...(o.output as Record<string, unknown>), approved_at: a.approved_at };
      }
    }
    for (const id of a.ready_source_ids) {
      const src = this.sources.get(id);
      if (src) src.status = 'ready';
    }
    return Promise.resolve();
  }

  hasQueuedJobs(): Promise<boolean> {
    return Promise.resolve([...this.jobs.values()].some((j) => j.status === 'queued'));
  }

  // ---- sources, files, Storage ----

  getSource(id: string): Promise<SourceRow | null> {
    return Promise.resolve(clone(this.sources.get(id) ?? null));
  }

  insertSource(row: SourceRow): Promise<void> {
    if (this.sources.has(row.id)) throw Object.assign(new Error('duplicate'), { code: '23505' });
    this.sources.set(row.id, clone(row));
    return Promise.resolve();
  }

  setSourceStatus(id: string, status: SourceRow['status']): Promise<void> {
    const s = this.sources.get(id);
    if (s) s.status = status;
    return Promise.resolve();
  }

  deleteSource(id: string): Promise<void> {
    this.sources.delete(id);
    for (const [k, f] of this.files) if (f.source_id === id) this.files.delete(k);
    for (const [k, c] of this.chunks) {
      if (c.source_id === id) {
        this.chunks.delete(k);
        for (const card of this.cards.values()) if (card.source_chunk_id === k) (card as { source_chunk_id: string | null }).source_chunk_id = null;
      }
    }
    this.planSources = this.planSources.filter((p) => p.source_id !== id);
    for (const j of this.jobs.values()) if (j.source_id === id) j.source_id = null;
    return Promise.resolve();
  }

  linkPlanSource(planId: string, sourceId: string): Promise<void> {
    if (!this.planSources.some((p) => p.plan_id === planId && p.source_id === sourceId)) {
      this.planSources.push({ plan_id: planId, source_id: sourceId });
    }
    return Promise.resolve();
  }

  planHasSource(planId: string, sourceId: string): Promise<boolean> {
    return Promise.resolve(this.planSources.some((p) => p.plan_id === planId && p.source_id === sourceId));
  }

  sourceFiles(sourceId: string): Promise<SourceFileRow[]> {
    return Promise.resolve(
      [...this.files.values()].filter((f) => f.source_id === sourceId).sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
        .map(clone),
    );
  }

  insertSourceFiles(rows: Omit<SourceFileRow, 'transcript' | 'confirmed'>[]): Promise<void> {
    for (const r of rows) {
      if (!this.files.has(r.id)) this.files.set(r.id, { ...clone(r), transcript: null, confirmed: false });
    }
    return Promise.resolve();
  }

  updateSourceFile(id: string, patch: Partial<Pick<SourceFileRow, 'transcript' | 'confirmed'>>): Promise<void> {
    const f = this.files.get(id);
    if (f) Object.assign(f, patch);
    return Promise.resolve();
  }

  listFolder(prefix: string): Promise<StoredObject[]> {
    return Promise.resolve(
      [...this.objects.entries()].filter(([path]) => path.startsWith(prefix + '/') && !path.slice(prefix.length + 1).includes('/'))
        .map(([, o]) => ({ name: o.name, size: o.size, mimetype: o.mimetype })),
    );
  }

  signedUrl(path: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(`https://ref.supabase.co/storage/v1/object/sign/sources/${path}?token=t&e=${expiresInSeconds}`);
  }

  orphanedObjects(limit: number): Promise<string[]> {
    const used = new Set([...this.files.values()].map((f) => f.storage_path));
    return Promise.resolve([...this.objects.keys()].filter((p) => !used.has(p) && this.objects.get(p)?.orphanedSince).slice(0, limit));
  }

  removeObjects(paths: string[]): Promise<void> {
    for (const p of paths) this.objects.delete(p);
    return Promise.resolve();
  }

  // ---- chunks ----

  upsertChunks(rows: ChunkRow[]): Promise<void> {
    for (const r of rows) {
      const prev = this.chunks.get(r.id);
      this.chunks.set(r.id, { embedding: prev?.embedding ?? null, embed_model: prev?.embed_model ?? null, ...clone(r) });
    }
    return Promise.resolve();
  }

  sourceChunks(sourceId: string): Promise<ChunkRow[]> {
    return Promise.resolve(
      [...this.chunks.values()].filter((c) => c.source_id === sourceId).sort((a, b) => a.id.localeCompare(b.id))
        .map(({ embedding: _e, embed_model: _m, ...c }) => clone(c)),
    );
  }

  chunksByIds(ids: string[]): Promise<ChunkRow[]> {
    return Promise.resolve(
      ids.map((id) => this.chunks.get(id)).filter((c): c is FakeChunk => !!c)
        .map(({ embedding: _e, embed_model: _m, ...c }) => clone(c)),
    );
  }

  deleteSourceChunks(sourceId: string): Promise<void> {
    for (const [k, c] of this.chunks) if (c.source_id === sourceId) this.chunks.delete(k);
    return Promise.resolve();
  }

  chunksToEmbed(sourceId: string, afterId: string | null, limit: number): Promise<ChunkRow[]> {
    return Promise.resolve(
      [...this.chunks.values()]
        .filter((c) => c.source_id === sourceId && c.embedding === null && (!afterId || c.id > afterId))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit)
        .map(({ embedding: _e, embed_model: _m, ...c }) => clone(c)),
    );
  }

  saveEmbeddings(rows: { chunk: ChunkRow; embedding: number[]; model: string }[]): Promise<void> {
    for (const r of rows) {
      const c = this.chunks.get(r.chunk.id);
      if (c) {
        c.embedding = r.embedding;
        c.embed_model = r.model;
      }
    }
    return Promise.resolve();
  }

  // ---- plans, topics, cards ----

  getPlan(id: string): Promise<PlanRow | null> {
    return Promise.resolve(clone(this.plans.get(id) ?? null));
  }

  planTopics(planId: string): Promise<TopicRow[]> {
    return Promise.resolve(
      [...this.topics.values()].filter((t) => t.plan_id === planId).sort((a, b) => a.position - b.position).map(clone),
    );
  }

  getTopic(id: string): Promise<TopicRow | null> {
    return Promise.resolve(clone(this.topics.get(id) ?? null));
  }

  insertTopics(rows: TopicRow[]): Promise<void> {
    this.maybeFail('insertTopics');
    for (const r of rows) if (!this.topics.has(r.id)) this.topics.set(r.id, clone(r));
    return Promise.resolve();
  }

  setTopicStatusIf(id: string, from: TopicRow['status'], to: TopicRow['status']): Promise<void> {
    const t = this.topics.get(id);
    if (t && t.status === from) t.status = to;
    return Promise.resolve();
  }

  /** Deletes topics, cascading to their cards and the cards' links (as the foreign keys do). */
  deleteTopicRows(ids: string[]) {
    for (const id of ids) {
      this.topics.delete(id);
      for (const [k, c] of this.cards) {
        if (c.topic_id === id) {
          this.cards.delete(k);
          for (const [lk, l] of this.links) if (l.from_card_id === k || l.to_card_id === k) this.links.delete(lk);
        }
      }
    }
  }

  planCards(planId: string, topicId: string, limit: number): Promise<{ id: string; question: string }[]> {
    const all = [...this.cards.values()].filter((c) => c.plan_id === planId);
    const own = all.filter((c) => c.topic_id === topicId);
    const rest = all.filter((c) => c.topic_id !== topicId);
    return Promise.resolve([...own, ...rest].slice(0, limit).map((c) => ({ id: c.id, question: c.question })));
  }

  existingCardIds(ids: string[]): Promise<Set<string>> {
    return Promise.resolve(new Set(ids.filter((id) => this.cards.has(id))));
  }

  insertCards(rows: CardRow[]): Promise<void> {
    for (const r of rows) {
      if (!this.chunks.has(r.source_chunk_id)) throw Object.assign(new Error('fk'), { code: '23503' });
      if (!this.cards.has(r.id)) this.cards.set(r.id, clone(r));
    }
    return Promise.resolve();
  }

  insertCardLinks(rows: CardLinkRow[]): Promise<void> {
    for (const r of rows) {
      if (!this.cards.has(r.from_card_id) || !this.cards.has(r.to_card_id)) {
        throw Object.assign(new Error('fk'), { code: '23503' });
      }
      if (!this.links.has(r.id)) this.links.set(r.id, clone(r));
    }
    return Promise.resolve();
  }

  /** The caller's view (no RLS: every row is visible; ownership is in the row). */
  userView(): UserView {
    return {
      plan: (id) => Promise.resolve(this.plans.has(id) ? { id, owner_id: this.plans.get(id)!.owner_id } : null),
      source: (id) => Promise.resolve(this.sources.has(id) ? { id, owner_id: this.sources.get(id)!.owner_id } : null),
      job: (id) => Promise.resolve(this.jobs.has(id) ? { id, user_id: this.jobs.get(id)!.user_id } : null),
    };
  }
}
