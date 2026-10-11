/**
 * The Store (store.ts) on supabase-js, plus the caller's JWT check and the as-the-user reads.
 * Deno only (npm import); the logic that uses it lives in pure modules and is tested with a fake.
 *
 * The admin client uses the project's secret key (service role, bypasses RLS). PostgREST serves at
 * most 1,000 rows per request (supabase/config.toml max_rows), so lists that can be longer are read
 * page by page. Errors are thrown as DbError with the Postgres code only: their messages and details
 * can quote row values, and they end up in logs.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import type { Config } from './config.ts';
import { parseCapReached } from './errors.ts';
import type { JobRow, JobStatus, NewJob, Stage, TopicRow } from './pipeline.ts';
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
} from './store.ts';

export class DbError extends Error {
  readonly code: string | null;
  constructor(op: string, err: { code?: string } | null) {
    super(`database call failed: ${op}`);
    this.name = 'DbError';
    this.code = err?.code ?? null;
  }
}

const BUCKET = 'sources';
const PAGE = 1000;
const JOB_COLUMNS = 'id,user_id,job,stage,status,input,error,attempts,locked_at,plan_id,source_id,created_at';

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/** The user id (JWT `sub`) of a valid, signed-in user's token, else null. */
export async function verifyUserJwt(cfg: Config, jwt: string): Promise<string | null> {
  const anon = createClient(cfg.supabaseUrl, cfg.publishableKey, clientOptions);
  try {
    // Checks the signature against the project's JWKS (asymmetric keys) or asks the Auth server
    // (legacy HS256), and the expiry.
    const { data, error } = await anon.auth.getClaims(jwt);
    if (error || !data) return null;
    const claims = data.claims as { sub?: unknown; role?: unknown };
    return claims.role === 'authenticated' && typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Reads as the caller (their RLS), for ownership checks. */
export function createUserView(cfg: Config, jwt: string): UserView {
  const db = createClient(cfg.supabaseUrl, cfg.publishableKey, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const one = async <T>(table: string, columns: string, id: string): Promise<T | null> => {
    const { data, error } = await db.from(table).select(columns).eq('id', id).maybeSingle();
    if (error) throw new DbError(`read ${table}`, error);
    return (data as T | null) ?? null;
  };
  return {
    plan: (id) => one('study_plans', 'id,owner_id', id),
    source: (id) => one('sources', 'id,owner_id', id),
    job: (id) => one('tracy_events', 'id,user_id', id),
  };
}

export function createAdminStore(cfg: Config): Store {
  return new SupabaseStore(createClient(cfg.supabaseUrl, cfg.secretKey, clientOptions));
}

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>;

class SupabaseStore implements Store {
  constructor(private readonly db: Db) {}

  /** Reads every row of a query, 1,000 at a time. */
  private async all<T>(op: string, query: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>) {
    const rows: T[] = [];
    for (let from = 0;; from += PAGE) {
      const { data, error } = await query(from, from + PAGE - 1);
      if (error) throw new DbError(op, error as { code?: string });
      const page = (data ?? []) as T[];
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  private check(op: string, error: { code?: string } | null) {
    if (error) throw new DbError(op, error);
  }

  // ---- the job queue ----

  async claimJob(maxRunning: number | null): Promise<JobRow | null> {
    const { data, error } = await this.db.rpc('claim_tracy_events', { p_limit: 1, p_max_running: maxRunning });
    this.check('claim_tracy_events', error);
    const rows = (data ?? []) as JobRow[];
    return rows[0] ?? null;
  }

  async releaseJob(fence: Fence): Promise<boolean> {
    const { data, error } = await this.db.rpc('release_tracy_event', { p_id: fence.id, p_attempts: fence.attempts });
    this.check('release_tracy_event', error);
    return data === true;
  }

  async finishJob(fence: Fence, patch: JobPatch): Promise<boolean> {
    let q = this.db.from('tracy_events').update(patch).eq('id', fence.id).eq('status', 'running')
      .eq('attempts', fence.attempts);
    q = fence.locked_at === null ? q.is('locked_at', null) : q.eq('locked_at', fence.locked_at);
    const { data, error } = await q.select('id');
    this.check('finish job', error);
    return (data ?? []).length === 1;
  }

  async getJob(id: string): Promise<JobRow | null> {
    const { data, error } = await this.db.from('tracy_events').select('*').eq('id', id).maybeSingle();
    this.check('read job', error);
    return (data as JobRow | null) ?? null;
  }

  async updateJobIf(id: string, from: JobStatus[], patch: JobPatch): Promise<JobRow | null> {
    const { data, error } = await this.db.from('tracy_events').update(patch).eq('id', id).in('status', from)
      .select('*');
    this.check('update job', error);
    return ((data ?? []) as JobRow[])[0] ?? null;
  }

  async sourceJobs(sourceId: string): Promise<JobRow[]> {
    // Without `output` (it can be large and the gates never need it).
    const rows = await this.all<JobRow>('source jobs', (a, b) =>
      this.db.from('tracy_events').select(JOB_COLUMNS).eq('source_id', sourceId).order('created_at')
        .order('id').range(a, b));
    return rows.map((r) => ({ ...r, output: null }));
  }

  async planJobs(planId: string, stage: Stage): Promise<JobRow[]> {
    return await this.all<JobRow>('plan jobs', (a, b) =>
      this.db.from('tracy_events').select('*').eq('plan_id', planId).eq('stage', stage).order('created_at')
        .order('id').range(a, b));
  }

  async insertJob(job: NewJob): Promise<boolean> {
    const { error } = await this.db.from('tracy_events').insert({ ...job, status: 'queued' });
    if (error?.code === '23505') return false; // the derived id exists: already queued once
    this.check('insert job', error);
    return true;
  }

  async enqueueCounted(req: CountedEnqueue) {
    const { data, error } = await this.db.rpc('enqueue_tracy_event', {
      p_user_id: req.user_id,
      p_job: req.job,
      p_stage: req.stage,
      p_input: req.input,
      p_plan_id: req.plan_id,
      p_source_id: req.source_id,
      p_free_limit: req.free_limit,
      p_paid_limit: req.paid_limit,
      p_units: req.units,
    });
    if (error) {
      const cap = parseCapReached(error, req.stage === 'transcribe' ? 'transcribe' : 'extract');
      if (cap) return { ok: false as const, cap };
      throw new DbError('enqueue_tracy_event', error);
    }
    return { ok: true as const, job: data as JobRow };
  }

  async requeueJob(id: string, limits: { free_limit: number | null; paid_limit: number | null }) {
    const { data, error } = await this.db.rpc('requeue_tracy_event', {
      p_id: id,
      p_free_limit: limits.free_limit,
      p_paid_limit: limits.paid_limit,
    });
    if (error) {
      const cap = parseCapReached(error, 'extract');
      if (cap) return { ok: false as const, cap };
      throw new DbError('requeue_tracy_event', error);
    }
    return { ok: true as const, job: ((data ?? []) as JobRow[])[0] ?? null };
  }

  async applyApproval(a: Approval): Promise<void> {
    const { error } = await this.db.rpc('apply_outline_approval', {
      p_plan_id: a.plan_id,
      p_keep: a.keep,
      p_cut: a.cut,
      p_jobs: a.jobs,
      p_outline_ids: a.outline_ids,
      p_approved_at: a.approved_at,
      p_ready_source_ids: a.ready_source_ids,
    });
    this.check('apply_outline_approval', error);
  }

  async hasQueuedJobs(): Promise<boolean> {
    const { data, error } = await this.db.from('tracy_events').select('id').eq('status', 'queued').limit(1);
    this.check('queued jobs', error);
    return (data ?? []).length > 0;
  }

  // ---- sources, files, Storage ----

  async getSource(id: string): Promise<SourceRow | null> {
    const { data, error } = await this.db.from('sources').select('id,owner_id,kind,title,url,status').eq('id', id)
      .maybeSingle();
    this.check('read source', error);
    return (data as SourceRow | null) ?? null;
  }

  async insertSource(row: SourceRow): Promise<void> {
    const { error } = await this.db.from('sources').insert(row);
    this.check('insert source', error);
  }

  async setSourceStatus(id: string, status: SourceRow['status']): Promise<void> {
    const { error } = await this.db.from('sources').update({ status }).eq('id', id);
    this.check('update source', error);
  }

  async deleteSource(id: string): Promise<void> {
    const { error } = await this.db.from('sources').delete().eq('id', id);
    this.check('delete source', error);
  }

  async linkPlanSource(planId: string, sourceId: string): Promise<void> {
    const { error } = await this.db.from('plan_sources').upsert(
      { plan_id: planId, source_id: sourceId },
      { onConflict: 'plan_id,source_id', ignoreDuplicates: true },
    );
    this.check('link plan source', error);
  }

  async planHasSource(planId: string, sourceId: string): Promise<boolean> {
    const { data, error } = await this.db.from('plan_sources').select('id').eq('plan_id', planId)
      .eq('source_id', sourceId).limit(1);
    this.check('read plan source', error);
    return (data ?? []).length > 0;
  }

  async sourceFiles(sourceId: string): Promise<SourceFileRow[]> {
    return await this.all<SourceFileRow>('source files', (a, b) =>
      this.db.from('source_files').select('id,source_id,owner_id,storage_path,page,transcript,confirmed')
        .eq('source_id', sourceId).order('page', { nullsFirst: true }).order('id').range(a, b));
  }

  async insertSourceFiles(rows: Omit<SourceFileRow, 'transcript' | 'confirmed'>[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.from('source_files').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    this.check('insert source files', error);
  }

  async updateSourceFile(id: string, patch: Partial<Pick<SourceFileRow, 'transcript' | 'confirmed'>>): Promise<void> {
    const { error } = await this.db.from('source_files').update(patch).eq('id', id);
    this.check('update source file', error);
  }

  async listFolder(prefix: string): Promise<StoredObject[]> {
    const { data, error } = await this.db.storage.from(BUCKET).list(prefix, { limit: 1000 });
    if (error) throw new DbError('list storage folder', null);
    return (data ?? [])
      .filter((o) => o.id !== null && o.metadata)
      .map((o) => ({
        name: o.name,
        size: Number(o.metadata?.size ?? 0),
        mimetype: String(o.metadata?.mimetype ?? ''),
      }));
  }

  async signedUrl(path: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.db.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) throw new DbError('sign storage url', null);
    return data.signedUrl;
  }

  async orphanedObjects(limit: number): Promise<string[]> {
    const { data, error } = await this.db.rpc('orphaned_source_objects', { p_limit: limit });
    this.check('orphaned_source_objects', error);
    return ((data ?? []) as { name: string }[]).map((r) => r.name);
  }

  async removeObjects(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 1000) {
      const { error } = await this.db.storage.from(BUCKET).remove(paths.slice(i, i + 1000));
      if (error) throw new DbError('remove storage objects', null);
    }
  }

  // ---- chunks ----

  async upsertChunks(rows: ChunkRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.db.from('source_chunks').upsert(rows.slice(i, i + 500), { onConflict: 'id' });
      this.check('upsert chunks', error);
    }
  }

  async sourceChunks(sourceId: string): Promise<ChunkRow[]> {
    return await this.all<ChunkRow>('source chunks', (a, b) =>
      this.db.from('source_chunks').select('id,source_id,owner_id,page,content').eq('source_id', sourceId)
        .order('id').range(a, b));
  }

  async chunksByIds(ids: string[]): Promise<ChunkRow[]> {
    const out: ChunkRow[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await this.db.from('source_chunks').select('id,source_id,owner_id,page,content')
        .in('id', ids.slice(i, i + 100));
      this.check('read chunks', error);
      out.push(...((data ?? []) as ChunkRow[]));
    }
    return out;
  }

  async deleteSourceChunks(sourceId: string): Promise<void> {
    const { error } = await this.db.from('source_chunks').delete().eq('source_id', sourceId);
    this.check('delete chunks', error);
  }

  async chunksToEmbed(sourceId: string, afterId: string | null, limit: number): Promise<ChunkRow[]> {
    let q = this.db.from('source_chunks').select('id,source_id,owner_id,page,content').eq('source_id', sourceId)
      .is('embedding', null);
    if (afterId) q = q.gt('id', afterId);
    const { data, error } = await q.order('id').limit(limit);
    this.check('chunks to embed', error);
    return (data ?? []) as ChunkRow[];
  }

  async saveEmbeddings(rows: { chunk: ChunkRow; embedding: number[]; model: string }[]): Promise<void> {
    if (!rows.length) return;
    // An upsert of whole rows is one request for the batch (an UPDATE per row would be 50).
    const { error } = await this.db.from('source_chunks').upsert(
      rows.map(({ chunk, embedding, model }) => ({
        ...chunk,
        embedding: `[${embedding.join(',')}]`,
        embed_model: model,
      })),
      { onConflict: 'id' },
    );
    this.check('save embeddings', error);
  }

  // ---- plans, topics, cards ----

  async getPlan(id: string): Promise<PlanRow | null> {
    const { data, error } = await this.db.from('study_plans').select('id,owner_id,title,scope,goal,target_date')
      .eq('id', id).maybeSingle();
    this.check('read plan', error);
    return (data as PlanRow | null) ?? null;
  }

  async planTopics(planId: string): Promise<TopicRow[]> {
    return await this.all<TopicRow>('plan topics', (a, b) =>
      this.db.from('topics').select('id,plan_id,title,position,status').eq('plan_id', planId).order('position')
        .order('id').range(a, b));
  }

  async getTopic(id: string): Promise<TopicRow | null> {
    const { data, error } = await this.db.from('topics').select('id,plan_id,title,position,status').eq('id', id)
      .maybeSingle();
    this.check('read topic', error);
    return (data as TopicRow | null) ?? null;
  }

  async insertTopics(rows: TopicRow[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.from('topics').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    this.check('insert topics', error);
  }

  async setTopicStatusIf(id: string, from: TopicRow['status'], to: TopicRow['status']): Promise<void> {
    const { error } = await this.db.from('topics').update({ status: to }).eq('id', id).eq('status', from);
    this.check('update topic status', error);
  }

  async planCards(planId: string, topicId: string, limit: number) {
    const { data: own, error: e1 } = await this.db.from('cards').select('id,question').eq('topic_id', topicId)
      .order('created_at').limit(limit);
    this.check('read topic cards', e1);
    const cards = (own ?? []) as { id: string; question: string }[];
    if (cards.length < limit) {
      const { data: rest, error: e2 } = await this.db.from('cards').select('id,question').eq('plan_id', planId)
        .neq('topic_id', topicId).order('created_at', { ascending: false }).limit(limit - cards.length);
      this.check('read plan cards', e2);
      cards.push(...((rest ?? []) as { id: string; question: string }[]));
    }
    return cards;
  }

  async existingCardIds(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await this.db.from('cards').select('id').in('id', ids.slice(i, i + 100));
      this.check('read cards', error);
      for (const r of (data ?? []) as { id: string }[]) found.add(r.id);
    }
    return found;
  }

  async insertCards(rows: CardRow[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.from('cards').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    this.check('insert cards', error);
  }

  async insertCardLinks(rows: CardLinkRow[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.from('card_links').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    this.check('insert card links', error);
  }
}
