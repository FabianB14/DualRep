/**
 * The outline builder's view of a source: one entry per chunk, or, for a long source, one entry per
 * run of neighbouring chunks.
 *
 * dualrep_build_outline's answer must list every entry it was sent exactly once (in a topic or in
 * unassigned_chunk_ids), and that answer has to fit Tracy's output budget (max_tokens covers the
 * model's thinking too, and the call has 105 s). So the answer is kept small two ways:
 *   - entries carry short references ("c1", "c2", …) instead of 36-character chunk ids (about 3
 *     tokens each instead of about 25); `members` maps each back to its chunks;
 *   - at most OUTLINE_ENTRIES entries are sent (200: an answer of about 2,500 tokens with titles and
 *     summaries). A 100-page course PDF has about 300 chunks and a 200-page one about 700, so beyond
 *     the limit neighbouring chunks (in reading order) are grouped: one entry with an excerpt made
 *     of a slice of each member, expanded back to every chunk of the group. Neighbours almost always
 *     belong to the same topic, so nothing is lost but a little precision at topic boundaries.
 * An answer that is still cut off at its length limit (or too slow) is asked for again with half
 * as many entries (outlineEntries), never with the same input.
 */
import { chunkHeading } from './chunker.ts';

/** Tracy's dualrep_build_outline limits on its input. */
export const OUTLINE_LIMITS = { maxEntries: 300, maxExcerptChars: 400, maxTitleChars: 200 } as const;
/** How many entries the worker sends at first, and the fewest it shrinks to. */
export const OUTLINE_ENTRIES = 200;
export const MIN_OUTLINE_ENTRIES = 50;

/** The entry count for an outline attempt: the job's `max_entries` (set by a shrinking retry). */
export function outlineEntries(input: Record<string, unknown>): number {
  const n = input.max_entries;
  return Number.isInteger(n)
    ? Math.min(OUTLINE_ENTRIES, Math.max(MIN_OUTLINE_ENTRIES, n as number))
    : OUTLINE_ENTRIES;
}

/** The entry count for the next attempt after one whose answer was too long, or null at the floor. */
export function shrunkEntries(sent: number): number | null {
  return sent > MIN_OUTLINE_ENTRIES ? Math.max(MIN_OUTLINE_ENTRIES, Math.floor(sent / 2)) : null;
}

export interface DigestChunk {
  id: string;
  source_id: string;
  page: number | null;
  content: string;
}

export interface DigestEntry {
  id: string;
  source_id: string;
  page: number | null;
  title: string | null;
  excerpt: string;
}

export interface Digest {
  /** Each entry's id is a short reference for this call ("c1", "c2", …), not a chunk id. */
  entries: DigestEntry[];
  /** The chunk ids each reference stands for (one, unless chunks were grouped). */
  members: Map<string, string[]>;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `chunks` must be in reading order (see `readingOrder`). */
export function buildDigest(chunks: DigestChunk[], maxEntries: number = OUTLINE_ENTRIES): Digest {
  const size = Math.max(1, Math.ceil(chunks.length / Math.min(maxEntries, OUTLINE_LIMITS.maxEntries)));
  const entries: DigestEntry[] = [];
  const members = new Map<string, string[]>();
  for (let i = 0; i < chunks.length; i += size) {
    const group = chunks.slice(i, i + size);
    const first = group[0];
    // Each member gets an equal share of the excerpt (after the ' … ' separators), so the model sees
    // all of the group.
    const sep = ' … ';
    const share = Math.floor(
      (OUTLINE_LIMITS.maxExcerptChars - sep.length * (group.length - 1)) / group.length,
    );
    const excerpt = group
      .map((c) => squash(c.content).slice(0, Math.max(1, share)))
      .join(sep)
      .slice(0, OUTLINE_LIMITS.maxExcerptChars);
    const title = group.map((c) => chunkHeading(c.content)).find((t) => t !== null) ?? null;
    const ref = `c${entries.length + 1}`;
    entries.push({
      id: ref,
      source_id: first.source_id,
      page: first.page,
      title: title ? title.slice(0, OUTLINE_LIMITS.maxTitleChars) : null,
      excerpt,
    });
    members.set(ref, group.map((c) => c.id));
  }
  return { entries, members };
}

/**
 * Expands references from the outline's answer to the chunk ids they stand for (order kept). Tracy
 * accepts only references it was sent; anything else is dropped rather than taken for a chunk id.
 */
export function expandIds(ids: string[], members: Map<string, string[]>): string[] {
  return ids.flatMap((id) => members.get(id) ?? []);
}

/**
 * Puts a source's chunks in reading order: by page (a document without pages has page null and
 * comes first), then by position within the page. source_chunks stores no position, but chunk ids
 * are derived from it (ids.ts chunkId), so `ordinalOf` recovers it.
 */
export function readingOrder<T extends { id: string; page: number | null }>(
  chunks: T[],
  ordinalOf: (chunk: T) => number,
): T[] {
  return [...chunks].sort((a, b) => {
    const pa = a.page ?? -1;
    const pb = b.page ?? -1;
    if (pa !== pb) return pa - pb;
    return ordinalOf(a) - ordinalOf(b);
  });
}
