/** Shared setup for the worker and study tests: a user, a plan, the fakes, and helpers to drive them. */
import { handleStudy, type StudyDeps } from '../../study/handlers.ts';
import { runOneStep, type StepResult, type WorkerDeps } from '../../tracy-worker/worker.ts';
import { DEFAULT_CAPS, type Caps } from '../config.ts';
import type { StudyRequest } from '../contracts.ts';
import { checkStudyRequest } from '../validate.ts';
import { FakeStore } from './fake_store.ts';
import { FakeTracy } from './fake_tracy.ts';

export const USER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const PLAN = '50000000-0000-4000-8000-000000000001';
export const SOURCE = '70000000-0000-4000-8000-000000000001';
export const SOURCE2 = '70000000-0000-4000-8000-000000000002';

export interface Scenario {
  store: FakeStore;
  tracy: FakeTracy;
  kicks: number[];
  logs: Record<string, unknown>[];
  worker: WorkerDeps;
  study: StudyDeps;
  /** Validates and runs a study request as USER (or `as`). */
  call(body: Record<string, unknown>, as?: string): ReturnType<typeof handleStudy>;
  /** Runs worker steps until the queue is empty (or `max` steps). */
  drain(max?: number): Promise<StepResult[]>;
  step(hop?: number): Promise<StepResult>;
}

export function scenario(opts: { caps?: Caps; embeddings?: boolean; scope?: 'single' | 'cumulative' } = {}): Scenario {
  const store = new FakeStore();
  const tracy = new FakeTracy();
  const kicks: number[] = [];
  const logs: Record<string, unknown>[] = [];
  store.addPlan({ id: PLAN, owner_id: USER, scope: opts.scope ?? 'cumulative', title: 'Biology 101' });
  const caps = opts.caps ?? DEFAULT_CAPS;
  const worker: WorkerDeps = {
    store,
    tracy,
    caps,
    kick: (hop) => {
      kicks.push(hop);
      return Promise.resolve(true);
    },
    log: (e) => logs.push(e),
    ...(opts.embeddings ? { embed: (texts: string[]) => Promise.resolve({ ok: true as const, data: texts.map(() => [1, 0]) }) } : {}),
  };
  const study: StudyDeps = {
    store,
    user: store.userView(),
    userId: USER,
    config: { caps, geminiKey: opts.embeddings ? 'key' : '' },
    kick: () => {
      kicks.push(0);
      return Promise.resolve(true);
    },
    now: () => new Date('2026-10-09T12:00:00.000Z'),
  };
  const s: Scenario = {
    store,
    tracy,
    kicks,
    logs,
    worker,
    study,
    call(body, as = USER) {
      const checked = checkStudyRequest(body, as);
      if (!checked.ok) throw new Error(`invalid test request: ${checked.errors.join('; ')}`);
      return handleStudy(checked.value as StudyRequest, { ...study, userId: as });
    },
    step: (hop = 0) => runOneStep(worker, hop),
    async drain(max = 100) {
      const out: StepResult[] = [];
      for (let i = 0; i < max; i++) {
        const r = await runOneStep(worker, 0);
        if (r.kind === 'idle') break;
        out.push(r);
      }
      return out;
    },
  };
  return s;
}

/** A page of extracted text with `n` chunks. */
export const textPage = (page: number | null, n: number, word = 'cell') => ({
  page,
  chars: 100 * n,
  letters: 90 * n,
  needs_transcription: false,
  chunks: Array.from({ length: n }, (_, i) => ({ ordinal: i, title: '', content: `Page ${page} part ${i}: the ${word} is the unit of life.` })),
});

export const scannedPage = (page: number) => ({ page, chars: 0, letters: 0, needs_transcription: true, chunks: [] });
