/**
 * Splitting text into the passages (source_chunks) that topics and cards cite.
 *
 * Tracy chunks text pages itself (/ai/extract). Transcribed pages (photos of notes, scanned PDF
 * pages) are chunked here, with the same rules, so every chunk of every source looks alike to the
 * outline and card builders: about 900 characters, never more than 1,600, split on paragraphs, then
 * lines, then sentences, then hard; each chunk labelled with the Markdown heading it sits under.
 * `chunkPageText` is a line-by-line port of chunkPageText in tracy-ai's src/extract.js; keep them in
 * step (the tests below pin the shared behaviour).
 */

export interface TextChunk {
  /** The nearest Markdown heading above the chunk ('' when there is none). */
  title: string;
  content: string;
}

export function chunkPageText(
  text: string,
  { target = 900, max = 1600 }: { target?: number; max?: number } = {},
): TextChunk[] {
  const paras = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= max) {
      pieces.push(p);
      continue;
    }
    let buf = '';
    for (const part of p.split(/\n|(?<=[.!?])\s+/)) {
      for (let s = part; s.length; s = s.slice(max)) {
        const bit = s.slice(0, max);
        if (buf && (buf + ' ' + bit).length > target) {
          pieces.push(buf);
          buf = bit;
        } else {
          buf = buf ? buf + ' ' + bit : bit;
        }
      }
    }
    if (buf) pieces.push(buf);
  }
  const chunks: TextChunk[] = [];
  let buf = '';
  let bufTitle = '';
  let title = '';
  for (const p of pieces) {
    const heading = /^#{1,6}\s/.test(p) ? p.replace(/^#{1,6}\s+/, '').split('\n')[0].trim() : null;
    if (buf && (buf + '\n\n' + p).length > target) {
      chunks.push({ title: bufTitle, content: buf });
      buf = '';
    }
    if (heading) title = heading;
    if (!buf) bufTitle = title;
    buf = buf ? buf + '\n\n' + p : p;
  }
  if (buf) chunks.push({ title: bufTitle, content: buf });
  return chunks;
}

/**
 * Breaks lines longer than `width` at the last space before it, so text without sentence punctuation
 * or line breaks (dictation can come out as one long line) is split by chunkPageText at word
 * boundaries instead of every 1,600 characters mid-word. A line with no space in the second half of
 * the width (one very long word, or a language written without spaces) is cut hard at the width,
 * never between the two halves of an emoji (a UTF-16 surrogate pair). A pre-pass, so chunkPageText
 * stays a line-by-line port of tracy-ai's. Lines that are short enough, and paragraphs (blank
 * lines), are left as they are.
 */
export function breakLongLines(text: string, width = 800): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const out: string[] = [];
      let rest = line;
      while (rest.length > width) {
        const space = rest.lastIndexOf(' ', width);
        let at = space > width / 2 ? space : width;
        if (at === width && at > 1 && /[\uD800-\uDBFF]/.test(rest[at - 1])) at -= 1;
        out.push(rest.slice(0, at).trimEnd());
        rest = rest.slice(at).trimStart();
      }
      out.push(rest);
      return out.join('\n');
    })
    .join('\n');
}

/** One page as Tracy transcribes it (dualrep_transcribe_notes / _pdf_pages). */
export interface TranscribedPage {
  page: number;
  blank: boolean;
  transcript: string;
  legibility?: string;
  uncertain?: string[];
  diagrams?: string[];
}

/**
 * The text kept for a transcribed page: the transcript, then one `[Diagram: …]` line per drawing
 * Tracy described (diagrams are part of the notes, and the person sees and can edit these lines on
 * the review screen like the rest). A blank page is ''.
 */
export function transcribedPageText(page: TranscribedPage): string {
  if (page.blank) return '';
  const text = (page.transcript ?? '').trim();
  const diagrams = (page.diagrams ?? [])
    .map((d) => String(d).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((d) => `[Diagram: ${d}]`);
  return [text, diagrams.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * The title of a chunk for the outline digest: its leading Markdown heading, if it starts with one
 * (docx and web pages keep headings as `# …`; plain PDF text has none). source_chunks has no title
 * column, so this is recovered from the content. null when there is none.
 */
export function chunkHeading(content: string): string | null {
  const m = /^#{1,6}\s+(.+)/.exec(content.trimStart());
  if (!m) return null;
  const title = m[1].trim().slice(0, 200);
  return title || null;
}
