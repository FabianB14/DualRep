/**
 * The outline builder's view of a source: one entry per chunk, or, for a long source, one entry per
 * run of neighbouring chunks.
 *
 * dualrep_build_outline accepts at most 600 chunk entries with a 400-character excerpt each, and its
 * validator demands that every entry lands in exactly one topic (or in unassigned_chunk_ids). A
 * 200-page course PDF has ~700 chunks, so beyond the limit neighbouring chunks (in reading order) are
 * grouped: the group is sent under its first chunk's id, with an excerpt made of a slice of each
 * member, and the answer is expanded back to every chunk of the group. Neighbours almost always belong
 * to the same topic, so nothing is lost but a little precision at topic boundaries.
 */
import { chunkHeading } from './chunker.ts';

/** Tracy's dualrep_build_outline limits. */
export const OUTLINE_LIMITS = { maxEntries: 600, maxExcerptChars: 400, maxTitleChars: 200 } as const;

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
  entries: DigestEntry[];
  /** The chunk ids an entry stands for (just itself unless chunks were grouped). */
  members: Map<string, string[]>;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `chunks` must be in reading order (see `readingOrder`). */
export function buildDigest(chunks: DigestChunk[], maxEntries: number = OUTLINE_LIMITS.maxEntries): Digest {
  const size = Math.max(1, Math.ceil(chunks.length / maxEntries));
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
    entries.push({
      id: first.id,
      source_id: first.source_id,
      page: first.page,
      title: title ? title.slice(0, OUTLINE_LIMITS.maxTitleChars) : null,
      excerpt,
    });
    members.set(first.id, group.map((c) => c.id));
  }
  return { entries, members };
}

/** Expands entry ids from the outline's answer to the chunk ids they stand for (order kept). */
export function expandIds(ids: string[], members: Map<string, string[]>): string[] {
  return ids.flatMap((id) => members.get(id) ?? [id]);
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
