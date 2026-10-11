import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { chunkHeading, chunkPageText, transcribedPageText } from './chunker.ts';
import { CHUNKER_GOLDEN } from './testing/chunker_golden.ts';

Deno.test('chunkPageText matches Tracy chunkPageText exactly (golden output)', () => {
  for (const [name, { input, chunks }] of Object.entries(CHUNKER_GOLDEN)) {
    assertEquals(chunkPageText(input), chunks, name);
  }
});

Deno.test('chunkPageText splits a long single-paragraph page under the cap and loses nothing', () => {
  const page = 'Photosynthesis converts light energy into chemical energy. '.repeat(60);
  const chunks = chunkPageText(page);
  assert(chunks.length > 1);
  assert(chunks.every((c) => c.content.length <= 1600));
  assertEquals(
    chunks.map((c) => c.content).join(' ').replace(/\s+/g, ' ').trim(),
    page.replace(/\s+/g, ' ').trim(),
  );
});

Deno.test('chunkPageText hard-cuts text without sentence breaks', () => {
  const blob = 'x'.repeat(5000);
  const chunks = chunkPageText(blob);
  assert(chunks.every((c) => c.content.length <= 1600));
  assertEquals(chunks.map((c) => c.content).join('').replace(/\s+/g, ''), blob);
});

Deno.test('chunkPageText labels a chunk with the heading it sits under', () => {
  const text = '# One\n\n' + 'a'.repeat(800) + '\n\n# Two\n\n' + 'b'.repeat(800);
  assertEquals(chunkPageText(text).map((c) => c.title), ['One', 'Two']);
  assertEquals(chunkPageText(''), []);
});

Deno.test('transcribedPageText keeps the transcript and lists diagrams; a blank page is empty', () => {
  assertEquals(
    transcribedPageText({
      page: 1,
      blank: false,
      transcript: '  ## Krebs cycle\n\nAcetyl-CoA enters.  ',
      diagrams: ['arrow from  NADH to ETC', ' '],
    }),
    '## Krebs cycle\n\nAcetyl-CoA enters.\n\n[Diagram: arrow from NADH to ETC]',
  );
  assertEquals(transcribedPageText({ page: 2, blank: true, transcript: '', diagrams: ['x'] }), '');
  assertEquals(transcribedPageText({ page: 3, blank: false, transcript: 'Only text' }), 'Only text');
});

Deno.test('chunkHeading reads a leading Markdown heading only', () => {
  assertEquals(chunkHeading('# Week 2: Enzymes\n\nbody'), 'Week 2: Enzymes');
  assertEquals(chunkHeading('\n### Deep\nbody'), 'Deep');
  assertEquals(chunkHeading('No heading # here'), null);
  assertEquals(chunkHeading('#hashtag'), null);
});
