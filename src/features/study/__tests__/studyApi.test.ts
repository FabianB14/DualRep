/**
 * @jest-environment node
 *
 * The study function client: the wire format of each action (mirrors
 * supabase/functions/_shared/contracts.ts) and how every failure functions.invoke reports — with the
 * real functions-js error classes and real Responses — becomes a typed StudyApiError.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/functions-js';

import {
  approveOutline,
  callStudy,
  cancelJob,
  confirmTranscripts,
  describeCap,
  nextMonthUtc,
  retryJob,
  STUDY_TIMEOUT_MS,
  StudyApiError,
  studyErrorMessage,
  submitSource,
  toStudyApiError,
  type StudyFunctionsClient,
} from '../studyApi';

const PLAN = '90000000-0000-4000-8000-000000000001';
const SOURCE = 'a0000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';

type Invoke = StudyFunctionsClient['functions']['invoke'];
function client(result: Awaited<ReturnType<Invoke>> | (() => Promise<Awaited<ReturnType<Invoke>>>)) {
  const invoke = jest.fn<Invoke>(async () => (typeof result === 'function' ? result() : result));
  return { client: { functions: { invoke } }, invoke };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function failure(error: unknown, signal?: AbortSignal): Promise<StudyApiError> {
  const { client: c } = client({ data: null, error });
  try {
    await callStudy(c, { action: 'retry_job', job_id: PLAN }, signal ? { signal } : {});
  } catch (caught) {
    expect(caught).toBeInstanceOf(StudyApiError);
    return caught as StudyApiError;
  }
  throw new Error('expected a failure');
}

describe('requests', () => {
  it('submit_source sends the contract’s body to the study function, with a timeout', async () => {
    const response = { ok: true, source_id: SOURCE, status: 'processing', job_ids: ['j1'], already_submitted: false };
    const { client: c, invoke } = client({ data: response, error: null });
    const files = [{ path: `${USER}/${SOURCE}/1.jpg` }, { path: `${USER}/${SOURCE}/2.jpg` }];
    await expect(submitSource(c, { plan_id: PLAN, source_id: SOURCE, kind: 'notes', title: 'Week 2', url: null, files })).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('study', {
      body: { action: 'submit_source', plan_id: PLAN, source_id: SOURCE, kind: 'notes', title: 'Week 2', url: null, files },
      timeout: STUDY_TIMEOUT_MS,
    });
  });

  it('confirm_transcripts, approve_outline, retry_job and cancel_job', async () => {
    const { client: c, invoke } = client({ data: { ok: true }, error: null });
    const controller = new AbortController();
    await confirmTranscripts(c, { plan_id: PLAN, source_id: SOURCE, files: [{ id: 'f1', transcript: 'text' }] });
    await approveOutline(c, { plan_id: PLAN, source_id: null, topics: [{ id: 't1', keep: true, title: 'Cells' }, { id: 't2', keep: false }] }, { timeoutMs: 5000, signal: controller.signal });
    await retryJob(c, 'j1');
    await cancelJob(c, 'j2');
    expect(invoke.mock.calls.map(([name, options]) => [name, options.body, options.timeout, options.signal])).toEqual([
      ['study', { action: 'confirm_transcripts', plan_id: PLAN, source_id: SOURCE, files: [{ id: 'f1', transcript: 'text' }] }, STUDY_TIMEOUT_MS, undefined],
      [
        'study',
        { action: 'approve_outline', plan_id: PLAN, source_id: null, topics: [{ id: 't1', keep: true, title: 'Cells' }, { id: 't2', keep: false }] },
        5000,
        controller.signal,
      ],
      ['study', { action: 'retry_job', job_id: 'j1' }, STUDY_TIMEOUT_MS, undefined],
      ['study', { action: 'cancel_job', job_id: 'j2' }, STUDY_TIMEOUT_MS, undefined],
    ]);
  });

  it('without a configured client, says so', async () => {
    await expect(retryJob(null, 'j1')).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('a success that is not the function’s JSON is a server error', async () => {
    for (const data of ['<html>', null, { ok: false }, []]) {
      const { client: c } = client({ data, error: null });
      await expect(retryJob(c, 'j1')).rejects.toMatchObject({ kind: 'server' });
    }
  });
});

describe('error mapping', () => {
  it('no connection is offline; an abort by timeout is a timeout; one by the caller is cancelled', async () => {
    expect((await failure(new FunctionsFetchError(new TypeError('Network request failed')))).kind).toBe('offline');
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    expect((await failure(new FunctionsFetchError(abort))).kind).toBe('timeout');
    const controller = new AbortController();
    controller.abort();
    expect((await failure(new FunctionsFetchError(abort), controller.signal)).kind).toBe('cancelled');
  });

  it('a relay error is a server error', async () => {
    expect(await failure(new FunctionsRelayError(json(502, {})))).toMatchObject({ kind: 'server', status: 502 });
  });

  it('cap_reached (429) carries the stage, usage and reset time', async () => {
    const error = await failure(
      new FunctionsHttpError(
        json(429, { ok: false, code: 'cap_reached', error: 'Monthly limit reached.', stage: 'transcribe', used: 20, limit: 20, resets_at: '2026-11-01T00:00:00.000Z' }),
      ),
    );
    expect(error).toMatchObject({
      kind: 'cap_reached',
      status: 429,
      code: 'cap_reached',
      serverMessage: 'Monthly limit reached.',
      cap: { stage: 'transcribe', used: 20, limit: 20, resetsAt: Date.parse('2026-11-01T00:00:00.000Z') },
    });
  });

  it('maps each of the function’s codes', async () => {
    const cases: [number, string, string][] = [
      [400, 'bad_request', 'bad_request'],
      [400, 'bad_files', 'bad_files'],
      [401, 'unauthorized', 'signed_out'],
      [403, 'forbidden', 'forbidden'],
      [404, 'not_found', 'not_found'],
      [405, 'method_not_allowed', 'server'],
      [409, 'conflict', 'conflict'],
      [409, 'not_ready', 'not_ready'],
      [422, 'no_text', 'no_text'],
      [500, 'server_error', 'server'],
      [503, 'not_configured', 'not_configured'],
    ];
    for (const [status, code, kind] of cases) {
      const error = await failure(new FunctionsHttpError(json(status, { ok: false, code, error: `msg ${code}`, errors: ['files[0].path must be …', 3] })));
      expect([error.kind, error.status, error.code, error.serverMessage]).toEqual([kind, status, code, `msg ${code}`]);
      expect(error.errors).toEqual(['files[0].path must be …']);
    }
  });

  it('falls back on the HTTP status when the body is not the function’s', async () => {
    const plain = (status: number) => new FunctionsHttpError(new Response('nope', { status }));
    expect((await failure(plain(401))).kind).toBe('signed_out');
    expect((await failure(plain(404))).kind).toBe('not_configured'); // the function is not deployed
    expect((await failure(plain(503))).kind).toBe('not_configured');
    expect((await failure(plain(429))).kind).toBe('cap_reached');
    expect((await failure(plain(429))).cap).toBeNull();
    expect((await failure(plain(500))).kind).toBe('server');
    expect((await failure(new FunctionsHttpError(json(404, { ok: false, code: 'odd' })))).kind).toBe('not_found');
    expect((await failure(new FunctionsHttpError(json(409, { message: 'x' })))).kind).toBe('conflict');
  });

  it('a study function that is not deployed is "not set up", not "not found, try again"', async () => {
    // What Supabase itself answers when no function of that name is deployed, or its bundle is missing.
    for (const code of ['NOT_FOUND', 'NOT_FOUND_FUNCTION_BLOB']) {
      const error = await failure(new FunctionsHttpError(json(404, { code, message: 'Requested function was not found' })));
      expect([error.kind, error.code, error.serverMessage]).toEqual(['not_configured', null, null]);
    }
    // The function's own 404 (a plan that has not synced yet) still is not_found.
    expect((await failure(new FunctionsHttpError(json(404, { ok: false, code: 'not_found', error: 'x' })))).kind).toBe('not_found');
  });

  it('a cap body without a readable reset time resets next month', async () => {
    const error = await failure(new FunctionsHttpError(json(429, { ok: false, code: 'cap_reached', stage: 'extract' })));
    expect(error.cap).toEqual({ stage: 'extract', used: 0, limit: 0, resetsAt: expect.any(Number) });
    expect(nextMonthUtc(Date.UTC(2026, 11, 15))).toBe(Date.UTC(2027, 0, 1));
  });

  it('anything thrown by invoke itself becomes a StudyApiError too', async () => {
    const { client: c } = client(async () => {
      throw new FunctionsFetchError(new TypeError('fail'));
    });
    await expect(retryJob(c, 'j1')).rejects.toMatchObject({ kind: 'offline' });
    await expect(toStudyApiError(new Error('weird'))).resolves.toMatchObject({ kind: 'server' });
  });
});

describe('messages', () => {
  it('says what happened in plain words', () => {
    expect(studyErrorMessage(new StudyApiError('offline'))).toBe(
      'No internet connection. Adding and preparing material needs the internet; studying doesn’t.',
    );
    expect(studyErrorMessage(new StudyApiError('signed_out'))).toMatch(/Sign in again/);
    expect(studyErrorMessage(new StudyApiError('not_ready', { serverMessage: 'The photos are still being read.' }))).toBe(
      'The photos are still being read.',
    );
    expect(studyErrorMessage(new StudyApiError('not_ready'))).toBe('This step isn’t ready yet.');
    expect(studyErrorMessage(new StudyApiError('server', { serverMessage: 'internal detail' }))).toBe(
      'Something went wrong on the server. Try again.',
    );
    expect(studyErrorMessage(new Error('x'))).toBe('Something went wrong. Try again.');
    for (const kind of ['timeout', 'cancelled', 'not_configured', 'bad_request', 'bad_files', 'forbidden', 'not_found', 'conflict', 'no_text'] as const) {
      expect(studyErrorMessage(new StudyApiError(kind)).length).toBeGreaterThan(5);
    }
  });

  it('says when the monthly limit resets', () => {
    const cap = { stage: 'extract' as const, used: 5, limit: 5, resetsAt: Date.UTC(2026, 10, 1, 12) };
    const text = describeCap(cap);
    expect(text.startsWith('You’ve used all 5 sources for this month. More can be added from ')).toBe(true);
    expect(text).toContain(new Date(cap.resetsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }));
    expect(describeCap({ ...cap, stage: 'transcribe', limit: 0 })).toMatch(/^You’ve used this month’s handwritten and scanned pages\./);
    // The page limit also covers scanned PDF pages: it never blames notes the person did not add.
    expect(describeCap({ ...cap, stage: 'transcribe', limit: 20 })).toMatch(/^You’ve used all 20 handwritten and scanned pages for this month\./);
    expect(studyErrorMessage(new StudyApiError('cap_reached', { cap }))).toBe(text);
    expect(studyErrorMessage(new StudyApiError('cap_reached'))).toBe('You’ve reached this month’s limit. Try again next month.');
  });
});
