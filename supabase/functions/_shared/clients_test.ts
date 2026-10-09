/** The Tracy and Gemini clients, the config parser and the HTTP helpers, against fake fetches. */
import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { DEFAULT_CAPS, missingSettings, parseCap, parseConcurrency, parseConfig } from './config.ts';
import { EMBED_DIMENSIONS, embedDocuments, normalize } from './gemini.ts';
import { bearerToken, secretsMatch } from './http.ts';
import { kickWorker } from './kick.ts';
import { Tracy } from './tracy.ts';

type Seen = { url: string; init: RequestInit };
function fakeFetch(reply: (seen: Seen) => Response | Promise<Response>, log: Seen[] = []): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const seen = { url: String(input), init: init ?? {} };
    log.push(seen);
    return Promise.resolve(reply(seen));
  }) as typeof fetch;
}
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.test('Tracy.task sends the secret and request id and returns the validated output', async () => {
  const log: Seen[] = [];
  const tracy = new Tracy({
    url: 'https://tracy.example/',
    secret: 's3cret',
    fetch: fakeFetch(() => jsonResponse(200, { ok: true, task: 'dualrep_build_cards', output: { cards: [] }, model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } }), log),
  });
  const r = await tracy.task('dualrep_build_cards', { a: 1 }, 'job-1');
  assertEquals(r, { ok: true, data: { output: { cards: [] }, model: 'claude-sonnet-5-5', usage: { input_tokens: 1 } } });
  assertEquals(log[0].url, 'https://tracy.example/ai/tasks/dualrep_build_cards');
  assertEquals((log[0].init.headers as Record<string, string>)['x-service-secret'], 's3cret');
  assertEquals(JSON.parse(String(log[0].init.body)), { input: { a: 1 }, request_id: 'job-1' });
});

Deno.test('Tracy failures are reduced to status and code', async () => {
  const call = (reply: () => Response) => new Tracy({ url: 'https://t', secret: 's', fetch: fakeFetch(reply) }).task('x', {}, 'j');
  assertEquals(await call(() => jsonResponse(502, { ok: false, error: 'the cards cite "secret"', code: 'invalid_output', errors: ['cards[0].page must be 3'] })), {
    ok: false,
    failure: { kind: 'http', status: 502, code: 'invalid_output', errors: ['cards[0].page must be 3'] },
  });
  assertEquals(await call(() => new Response('<html>Service waking up</html>', { status: 503 })), { ok: false, failure: { kind: 'not_json', status: 503 } });
  assertEquals(await call(() => jsonResponse(200, { ok: false })), { ok: false, failure: { kind: 'http', status: 502, code: null, errors: undefined } });
  const thrown = (name: string) => new Tracy({ url: 'https://t', secret: 's', fetch: (() => Promise.reject(Object.assign(new Error('x'), { name }))) as typeof fetch }).task('x', {}, 'j');
  assertEquals(await thrown('TimeoutError'), { ok: false, failure: { kind: 'timeout' } });
  assertEquals(await thrown('TypeError'), { ok: false, failure: { kind: 'network' } });
});

Deno.test('Tracy.health is true only for a JSON { ok: true }', async () => {
  const health = (reply: () => Response) => new Tracy({ url: 'https://t', secret: 's', fetch: fakeFetch(reply) }).health();
  assert(await health(() => jsonResponse(200, { ok: true, assistant: 'Tracy' })));
  assert(!(await health(() => new Response('waking', { status: 503 }))));
  assert(!(await health(() => new Response('<html>', { status: 200 }))));
  assert(!(await new Tracy({ url: 'https://t', secret: 's', fetch: (() => Promise.reject(new TypeError('dns'))) as typeof fetch }).health()));
});

Deno.test('Tracy.extract posts the window to /ai/extract', async () => {
  const log: Seen[] = [];
  const page = { page: 1, needs_transcription: false, chunks: [] };
  const tracy = new Tracy({ url: 'https://t', secret: 's', fetch: fakeFetch(() => jsonResponse(200, { ok: true, format: 'pdf', total_pages: 1, first_page: 1, last_page: 1, pages: [page] }), log) });
  const r = await tracy.extract({ url: 'https://ref.supabase.co/x', kind: 'pdf', first_page: 1, request_id: 'j' });
  assert(r.ok && r.data.pages[0].page === 1);
  assertEquals(log[0].url, 'https://t/ai/extract');
});

Deno.test('Gemini: key in the header, one request per text, vectors checked and normalised', async () => {
  const log: Seen[] = [];
  const vec = Array.from({ length: EMBED_DIMENSIONS }, () => 2);
  const r = await embedDocuments(['a', 'b'], {
    apiKey: 'k',
    fetch: fakeFetch(() => jsonResponse(200, { embeddings: [{ values: vec }, { values: vec }] }), log),
  });
  assert(r.ok);
  assert(r.ok && Math.abs(Math.hypot(...r.data[0]) - 1) < 1e-9);
  assert(!log[0].url.includes('k='));
  assertEquals((log[0].init.headers as Record<string, string>)['x-goog-api-key'], 'k');
  assertEquals(JSON.parse(String(log[0].init.body)).requests.length, 2);
  const short = await embedDocuments(['a'], { apiKey: 'k', fetch: fakeFetch(() => jsonResponse(200, { embeddings: [{ values: [1, 2] }] })) });
  assertEquals(short, { ok: false, failure: { kind: 'http', status: 502, code: 'bad_embeddings' } });
  assertEquals(await embedDocuments(['a'], { apiKey: 'k', fetch: fakeFetch(() => jsonResponse(429, {})) }), { ok: false, failure: { kind: 'http', status: 429, code: null } });
  assertEquals(normalize([0, 0]), [0, 0]);
});

Deno.test('config: keys from the JSON dictionaries, legacy fallback, caps', () => {
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://ref.supabase.co/',
    SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}',
    SUPABASE_ANON_KEY: 'legacy-anon',
    TRACY_URL: 'https://tracy.onrender.com/health/ ',
    DUALREP_CAP_SOURCES_FREE: '10',
    DUALREP_CAP_PAGES_PAID: 'none',
    DUALREP_CAP_PAGES_FREE: 'lots',
  };
  const cfg = parseConfig((k) => env[k]);
  assertEquals(cfg.supabaseUrl, 'https://ref.supabase.co');
  assertEquals(cfg.secretKey, 'sb_secret_x');
  assertEquals(cfg.publishableKey, 'legacy-anon');
  assertEquals(cfg.tracyUrl, 'https://tracy.onrender.com');
  assertEquals(cfg.caps, {
    sources: { free: 10, paid: DEFAULT_CAPS.sources.paid },
    pages: { free: DEFAULT_CAPS.pages.free, paid: null },
  });
  assertEquals(missingSettings(cfg, ['tracySecret', 'workerSecret', 'secretKey']), ['TRACY_SERVICE_SECRET', 'DUALREP_WORKER_SECRET']);
  assertEquals([parseCap('0', 5), parseCap('', 5), parseCap(' Unlimited ', 5), parseCap('-1', 5)], [0, 5, null, 5]);
  // One job at a time unless DUALREP_WORKER_CONCURRENCY says otherwise (1-10, or none).
  assertEquals(cfg.workerConcurrency, 1);
  assertEquals([parseConcurrency('3'), parseConcurrency('none'), parseConcurrency('0'), parseConcurrency('11'), parseConcurrency('x')], [3, null, 1, 1, 1]);
});

Deno.test('secretsMatch: equal secrets only; an unset secret never matches', async () => {
  assert(await secretsMatch('abc', 'abc'));
  assert(!(await secretsMatch('abd', 'abc')));
  assert(!(await secretsMatch('abcd', 'abc')));
  assert(!(await secretsMatch(null, 'abc')));
  assert(!(await secretsMatch('', '')));
  assertEquals(bearerToken('Bearer eyJ.a.b'), 'eyJ.a.b');
  assertEquals(bearerToken('Basic x'), null);
  assertEquals(bearerToken(null), null);
});

Deno.test('kickWorker posts to the worker with its secret and reports a 202', async () => {
  const log: Seen[] = [];
  const ok = await kickWorker({ supabaseUrl: 'https://ref.supabase.co', workerSecret: 'w' }, { reason: 'kick', hop: 2 }, fakeFetch(() => jsonResponse(202, { ok: true }), log));
  assert(ok);
  assertEquals(log[0].url, 'https://ref.supabase.co/functions/v1/tracy-worker');
  assertEquals((log[0].init.headers as Record<string, string>)['x-dualrep-worker-secret'], 'w');
  assertEquals(JSON.parse(String(log[0].init.body)), { reason: 'kick', hop: 2 });
  assert(!(await kickWorker({ supabaseUrl: '', workerSecret: 'w' }, { reason: 'kick', hop: 0 })));
});
