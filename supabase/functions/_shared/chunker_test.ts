import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import { breakLongLines, chunkHeading, chunkPageText, transcribedPageText } from './chunker.ts';
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

Deno.test('breakLongLines: unpunctuated dictation is split at word boundaries', () => {
  const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' '); // ~23,000 chars, one line
  const broken = breakLongLines(words);
  const lines = broken.split('\n');
  assert(lines.every((l) => l.length <= 800));
  assertEquals(lines.join(' '), words); // nothing lost, only spaces became line breaks
  const chunks = chunkPageText(broken);
  // Every chunk starts and ends on a whole word (the hard 1,600-character cut would split words).
  assert(chunks.every((c) => /^word\d+/.test(c.content) && /word\d+$/.test(c.content)));
  assert(chunks.every((c) => c.content.length <= 1600));
  // Short lines and paragraphs are untouched.
  assertEquals(breakLongLines('# Title\n\nA short line.\nAnother.'), '# Title\n\nA short line.\nAnother.');
  // A single "word" longer than the width is cut hard.
  assertEquals(breakLongLines('x'.repeat(1700)).split('\n').map((l) => l.length), [800, 800, 100]);
});

Deno.test('breakLongLines: a hard cut never splits an emoji, and line breaks of any style are kept', () => {
  // 799 letters, then an emoji (two UTF-16 units at 799 and 800): cutting at 800 would split it.
  const line = 'x'.repeat(799) + '\u{1F600}' + 'y'.repeat(300);
  const parts = breakLongLines(line).split('\n');
  assertEquals(parts.map((l) => l.length), [799, 302]);
  assertEquals(parts[1].startsWith('\u{1F600}'), true);
  assertEquals(parts.join(''), line);
  assertEquals(breakLongLines('a\r\nb\rc'), 'a\nb\nc');
  assertEquals(breakLongLines(''), '');
});
