import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { buildDigest, type DigestChunk, expandIds, OUTLINE_LIMITS, readingOrder } from './digest.ts';

const S = '70000000-0000-4000-8000-000000000001';
const chunk = (i: number, content = `Passage ${i} ` + 'text '.repeat(150)): DigestChunk => ({
  id: `c${String(i).padStart(4, '0')}`,
  source_id: S,
  page: Math.floor(i / 3) + 1,
  content,
});

Deno.test('up to 600 chunks: one entry each, excerpt at most 400 characters, heading as title', () => {
  const chunks = [chunk(0, '# Cells\n\nCells are the unit of life.'), ...Array.from({ length: 9 }, (_, i) => chunk(i + 1))];
  const d = buildDigest(chunks);
  assertEquals(d.entries.length, 10);
  assertEquals(d.entries[0], { id: 'c0000', source_id: S, page: 1, title: 'Cells', excerpt: '# Cells Cells are the unit of life.' });
  assert(d.entries.every((e) => e.excerpt.length <= OUTLINE_LIMITS.maxExcerptChars));
  assertEquals(d.entries[1].title, null);
  assertEquals(expandIds(['c0003'], d.members), ['c0003']);
});

Deno.test('more than 600 chunks: neighbours are grouped and expand back to every chunk once', () => {
  const chunks = Array.from({ length: 1301 }, (_, i) => chunk(i));
  const d = buildDigest(chunks);
  assert(d.entries.length <= OUTLINE_LIMITS.maxEntries);
  assertEquals(d.entries.length, Math.ceil(1301 / 3));
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
