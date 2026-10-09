import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import {
  buildDigest,
  type DigestChunk,
  expandIds,
  MIN_OUTLINE_ENTRIES,
  OUTLINE_ENTRIES,
  OUTLINE_LIMITS,
  outlineEntries,
  readingOrder,
  shrunkEntries,
} from './digest.ts';

const S = '70000000-0000-4000-8000-000000000001';
const chunk = (i: number, content = `Passage ${i} ` + 'text '.repeat(150)): DigestChunk => ({
  id: `c${String(i).padStart(4, '0')}`,
  source_id: S,
  page: Math.floor(i / 3) + 1,
  content,
});

Deno.test('up to 200 chunks: one entry each under a short reference, excerpt at most 400 characters, heading as title', () => {
  const chunks = [chunk(0, '# Cells\n\nCells are the unit of life.'), ...Array.from({ length: 9 }, (_, i) => chunk(i + 1))];
  const d = buildDigest(chunks);
  assertEquals(d.entries.length, 10);
  // "c1" instead of a 36-character chunk id: the answer has to repeat every one of them.
  assertEquals(d.entries[0], { id: 'c1', source_id: S, page: 1, title: 'Cells', excerpt: '# Cells Cells are the unit of life.' });
  assert(d.entries.every((e) => e.excerpt.length <= OUTLINE_LIMITS.maxExcerptChars));
  assertEquals(d.entries[1].title, null);
  assertEquals(expandIds(['c4'], d.members), ['c0003']);
  // Only references that were sent: anything else is never taken for a chunk id.
  assertEquals(expandIds(['c0003', 'c99'], d.members), []);
});

Deno.test('more than 200 chunks: neighbours are grouped and expand back to every chunk once', () => {
  const chunks = Array.from({ length: 1301 }, (_, i) => chunk(i));
  const d = buildDigest(chunks);
  assert(d.entries.length <= OUTLINE_ENTRIES);
  assertEquals(d.entries.length, Math.ceil(1301 / 7));
  assert(d.entries.every((e) => e.excerpt.length <= OUTLINE_LIMITS.maxExcerptChars));
  // Every member contributes to its group's excerpt.
  assert(d.entries[0].excerpt.includes('Passage 0') && d.entries[0].excerpt.includes('Passage 2'));
  const all = expandIds(d.entries.map((e) => e.id), d.members);
  assertEquals(all, chunks.map((c) => c.id));
});

Deno.test('readingOrder: page first (no page before page 1), then position within the page', () => {
  const rows = [
    { id: 'b', page: 2 },
    { id: 'a2', page: 1 },
    { id: 'a1', page: 1 },
    { id: 'n', page: null },
  ];
  const ord = new Map([['a1', 0], ['a2', 1], ['b', 0], ['n', 0]]);
  assertEquals(readingOrder(rows, (r) => ord.get(r.id)!).map((r) => r.id), ['n', 'a1', 'a2', 'b']);
});

Deno.test('the entry count: 200 at first, halved after an answer that was too long, never under 50', () => {
  assertEquals(outlineEntries({}), OUTLINE_ENTRIES);
  assertEquals(outlineEntries({ max_entries: 75 }), 75);
  assertEquals(outlineEntries({ max_entries: 5 }), MIN_OUTLINE_ENTRIES);
  assertEquals(outlineEntries({ max_entries: 9999 }), OUTLINE_ENTRIES);
  assertEquals(outlineEntries({ max_entries: '75' }), OUTLINE_ENTRIES);
  assertEquals([shrunkEntries(200), shrunkEntries(150), shrunkEntries(75), shrunkEntries(50), shrunkEntries(20)], [100, 75, 50, null, null]);
  assert(OUTLINE_ENTRIES <= OUTLINE_LIMITS.maxEntries);
  // 700 chunks (a 200-page course PDF) at the smallest size: groups of 14 neighbours, 50 entries.
  const chunks = Array.from({ length: 700 }, (_, i) => chunk(i));
  assertEquals(buildDigest(chunks, MIN_OUTLINE_ENTRIES).entries.length, 50);
});
