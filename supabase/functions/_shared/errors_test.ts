import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { classifyGeminiFailure, classifyTracyFailure, MESSAGES, nextMonthUtc, parseCapReached } from './errors.ts';

const http = (status: number, code: string | null, errors?: string[]) => ({ kind: 'http' as const, status, code, errors });

Deno.test("Render's HTML 502/503/504 after the request was sent is counted (Tracy died under it); busy is released", () => {
  for (const status of [502, 503, 504]) {
    assertEquals(classifyTracyFailure({ kind: 'not_json', status }, { stage: 'extract' }), { action: 'retry', message: MESSAGES.tracyBusy });
  }
  assertEquals(classifyTracyFailure({ kind: 'not_json', status: 200 }, { stage: 'extract' }).action, 'retry');
  // Tracy turned the call away before doing anything (one PDF read or render at a time).
  assertEquals(classifyTracyFailure(http(503, 'busy'), { stage: 'transcribe' }), { action: 'release', reason: 'tracy_busy' });
});

Deno.test("a Tracy without the DualRep lane (Express's HTML 404) fails as not set up", () => {
  for (const status of [404, 405]) {
    assertEquals(classifyTracyFailure({ kind: 'not_json', status }, { stage: 'outline' }), {
      action: 'fail',
      message: MESSAGES.notSetUp,
    });
  }
});

Deno.test('network trouble, timeouts and 5xx are retried', () => {
  assertEquals(classifyTracyFailure({ kind: 'network' }, { stage: 'cards' }).action, 'retry');
  assertEquals(classifyTracyFailure({ kind: 'timeout' }, { stage: 'cards' }), { action: 'retry', message: MESSAGES.tracySlow });
  assertEquals(classifyTracyFailure(http(502, 'model_error'), { stage: 'cards' }).action, 'retry');
  assertEquals(classifyTracyFailure(http(503, 'render_unavailable'), { stage: 'transcribe' }).action, 'retry');
  assertEquals(classifyTracyFailure(http(500, null), { stage: 'outline' }).action, 'retry');
});

Deno.test("the validator's findings go back to Tracy on the retry", () => {
  const a = classifyTracyFailure(http(502, 'invalid_output', ['cards[0].quote is not an exact passage of its chunk']), { stage: 'cards' });
  assertEquals(a, {
    action: 'retry',
    message: MESSAGES.badAnswer,
    previousErrors: ['cards[0].quote is not an exact passage of its chunk'],
  });
  const t = classifyTracyFailure(http(502, 'truncated'), { stage: 'cards' });
  assertEquals(t.action, 'retry');
  assert(t.action === 'retry' && t.previousErrors?.length === 1);
});

Deno.test('bad files, refusals and setup problems fail at once with a fixed message', () => {
  const cases: [number, string, string, string | null][] = [
    [413, 'too_large', MESSAGES.tooLarge, 'pdf'],
    [415, 'unsupported_type', MESSAGES.unsupported, 'pdf'],
    [422, 'pdf_encrypted', MESSAGES.encrypted, 'pdf'],
    [422, 'pdf_unreadable', MESSAGES.pdfUnreadable, 'pdf'],
    [422, 'doc_unreadable', MESSAGES.docUnreadable, 'doc'],
    [422, 'no_text', MESSAGES.noText, 'doc'],
    [422, 'fetch_failed', MESSAGES.linkUnreachable, 'link'],
    [400, 'bad_url', MESSAGES.linkUnusable, 'link'],
    [400, 'bad_url', MESSAGES.notSetUp, 'pdf'],
    [403, 'forbidden', MESSAGES.notSetUp, null],
    [502, 'refused', MESSAGES.refused, null],
    [400, 'bad_input', MESSAGES.tracyBusy, null],
  ];
  for (const [status, code, message, kind] of cases) {
    assertEquals(classifyTracyFailure(http(status, code), { stage: 'extract', kind }), { action: 'fail', message }, code);
  }
  // A Storage download that failed may work next time.
  assertEquals(classifyTracyFailure(http(422, 'fetch_failed'), { stage: 'extract', kind: 'pdf' }).action, 'retry');
});

Deno.test('every message is a fixed sentence (nothing from the request or the answer)', () => {
  for (const m of Object.values(MESSAGES)) {
    assert(m.length < 120 && /[.!]$/.test(m), m);
    assert(!/https?:|\{|\}/.test(m), m);
  }
});

Deno.test('Gemini: retry rate limits and outages, fail the rest', () => {
  assertEquals(classifyGeminiFailure(http(429, null)).action, 'retry');
  assertEquals(classifyGeminiFailure(http(503, null)).action, 'retry');
  assertEquals(classifyGeminiFailure({ kind: 'timeout' }).action, 'retry');
  assertEquals(classifyGeminiFailure(http(400, null)).action, 'fail');
});

Deno.test('parseCapReached reads enqueue_tracy_event P0001 detail', () => {
  const err = {
    code: 'P0001',
    message: 'monthly limit reached for transcribe',
    hint: 'dualrep_cap_reached',
    details: '{"stage" : "transcribe", "used" : 20, "limit" : 20, "resets_at" : "2026-11-01T00:00:00.000Z"}',
  };
  assertEquals(parseCapReached(err, 'extract'), { stage: 'transcribe', used: 20, limit: 20, resets_at: '2026-11-01T00:00:00.000Z' });
  assertEquals(parseCapReached({ code: '23505', hint: null }, 'extract'), null);
  assertEquals(parseCapReached(null, 'extract'), null);
  assertEquals(
    parseCapReached({ hint: 'dualrep_cap_reached', details: 'garbled' }, 'extract', new Date('2026-12-15T12:00:00Z')),
    { stage: 'extract', used: 0, limit: 0, resets_at: '2027-01-01T00:00:00.000Z' },
  );
  assertEquals(nextMonthUtc(new Date('2026-10-31T23:59:59Z')), '2026-11-01T00:00:00.000Z');
});
