/**
 * Gemini embeddings for source chunks (optional: only when GEMINI_API_KEY is set; spec decision 4).
 *
 * gemini-embedding-2 at 1,536 dimensions (= source_chunks.embedding vector(1536)). The model ignores
 * taskType and title, so the task goes into the text as a prefix ("title: … | text: …"); the prefix
 * scheme is part of the stored marker (embed_model = 'gemini-embedding-2@1536#p1'), because changing
 * it changes the vectors. One request per chunk inside one batchEmbedContents call (several inputs in
 * one `content` would come back as a single averaged vector). Vectors are re-normalised. The key goes
 * in the x-goog-api-key header, never in the URL. Research: phase2-research apis.md §1.
 */
import type { CallResult } from './tracy.ts';

export const EMBED_MODEL = 'gemini-embedding-2';
export const EMBED_DIMENSIONS = 1536;

export const embedText = (title: string | null, text: string) => `title: ${title ?? 'none'} | text: ${text}`;

export async function embedDocuments(
  texts: string[],
  opts: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<CallResult<number[][]>> {
  if (texts.length === 0) return { ok: true, data: [] };
  if (texts.length > 100) throw new RangeError('at most 100 texts per batchEmbedContents call');
  const fetchImpl = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${EMBED_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBED_DIMENSIONS,
          })),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      },
    );
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, failure: { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' } };
  }
  const body = await res.json().catch(() => null) as { embeddings?: { values?: number[] }[] } | null;
  if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status, code: null } };
  const embeddings = body?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    return { ok: false, failure: { kind: 'http', status: 502, code: 'bad_embeddings' } };
  }
  const out: number[][] = [];
  for (const e of embeddings) {
    const v = e?.values;
    if (!Array.isArray(v) || v.length !== EMBED_DIMENSIONS || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      return { ok: false, failure: { kind: 'http', status: 502, code: 'bad_embeddings' } };
    }
    out.push(normalize(v));
  }
  return { ok: true, data: out };
}

/** L2-normalises a vector (idempotent; a zero vector stays zero). */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n > 0 ? v.map((x) => x / n) : v.slice();
}
