/**
 * Deterministic ids for the rows the Edge Functions write.
 *
 * Every row the pipeline makes (source files, chunks, follow-up jobs, draft topics, cards, links) gets
 * a UUIDv5 derived from what it is, e.g. "chunk 3 of page 12 of source S" or "the outline job of
 * source S". Writing the same thing twice then hits the same primary key, so:
 *   - a step that is retried after a crash, or a request the phone sends twice, never duplicates rows
 *     (inserts ignore the existing row);
 *   - a follow-up job is enqueued at most once even when two workers finish at the same moment (the
 *     second insert finds the id taken), with no lock or extra column.
 * The namespace below is DualRep's own and must never change (it would re-derive every id).
 * Pure: Web Crypto only (Deno and Node 22 both have crypto.subtle), no Deno APIs.
 */

/** UUIDv5 namespace for server-made ids. (Not the card_states namespace, which belongs to the phone.) */
export const SERVER_ID_NAMESPACE = '1689dae2-a02e-4c59-b2ad-51fab8769792';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A UUID in Postgres' canonical lowercase text form (what the database returns). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** RFC 9562 UUIDv5 (SHA-1) of `name` (UTF-8) in `namespace`. */
export async function uuidv5(name: string, namespace: string): Promise<string> {
  if (!isUuid(namespace)) throw new RangeError('namespace must be a lowercase UUID');
  const ns = new Uint8Array(16);
  const hex = namespace.replace(/-/g, '');
  for (let i = 0; i < 16; i++) ns[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(16 + nameBytes.length);
  data.set(ns);
  data.set(nameBytes, 16);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC variant
  const h = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const id = (name: string) => uuidv5(name, SERVER_ID_NAMESPACE);

/** source_files.id of file n (1-based) of a source. */
export const sourceFileId = (sourceId: string, n: number) => id(`${sourceId}:file:${n}`);

/**
 * source_chunks.id of chunk `ordinal` (0-based) of a page of a source. page null = a document
 * without pages (docx, web page). Text pages and transcribed pages share the scheme: a page is one
 * or the other, never both.
 */
export const chunkId = (sourceId: string, page: number | null, ordinal: number) =>
  id(`${sourceId}:chunk:${page ?? 'none'}:${ordinal}`);

/** The one outline job of a source. */
export const outlineJobId = (sourceId: string) => id(`${sourceId}:job:outline`);

/** The one embedding job of a source (it re-queues itself until every chunk has a vector). */
export const embedJobId = (sourceId: string) => id(`${sourceId}:job:embed`);

/** Cards job `batch` (0-based) for one topic of a source's outline. */
export const cardsJobId = (sourceId: string, topicId: string, batch: number) =>
  id(`${sourceId}:job:cards:${topicId}:${batch}`);

/** A draft topic proposed by an outline job (key = the outline's topic key). */
export const draftTopicId = (outlineJobId: string, key: string) => id(`${outlineJobId}:topic:${key}`);

/** A card made by a cards job (key = the card's key in Tracy's answer). */
export const cardId = (jobId: string, key: string) => id(`${jobId}:card:${key}`);

/** Link number `index` of a cards job's answer. */
export const cardLinkId = (jobId: string, index: number) => id(`${jobId}:link:${index}`);
