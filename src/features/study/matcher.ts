/**
 * Typed short answers, checked on the phone (Phase 2 decision 10; grading by Tracy is Phase 3).
 *
 * Typing is opt-in (Settings → Type short answers) and only for cards it suits: `basic` and `cloze`
 * cards whose expected answer is short (every alternative at most 5 words and 40 characters after
 * normalizing). Any other card is self-graded, silently.
 *
 * The check is a forgiving heuristic, not a judge:
 * - Both sides are normalized: lower case, accents removed (when the runtime can decompose them),
 *   quotes and apostrophes unified, punctuation turned into spaces (decimal points and minus signs
 *   in numbers are kept), the articles a / an / the dropped, spaces collapsed.
 * - The expected answer may list alternatives separated by `;` or `|` ("Krebs cycle; citric acid
 *   cycle"), the convention Tracy's card builder follows.
 * - exact: equal after normalizing.
 * - close: every number matches exactly (9.8 is not 9.81, 1915 is not 1914), the first letter
 *   matches, and the spelling is off by at most a few edits (Damerau–Levenshtein, optimal string
 *   alignment: 0 edits up to 4 characters, 1 up to 8, 2 up to 15, then 15% of the length). Or the
 *   expected words appear, in order, inside an answer at most 2 words longer ("it's the
 *   mitochondria").
 * - wrong: anything else. The screen then shows the answer with "I missed it" (Again) and "Count it
 *   as right" (Good), so a false "wrong" costs one tap.
 *
 * Known false accepts (tested, see matcher.test.ts): a near-miss that is a different word, such as
 * "mitochondrion" for "mitochondria". The screen always shows the expected spelling after a close
 * match ("Counted as right. Spelling: mitochondria").
 *
 * Hermes notes: no `\p{…}` regex escapes (older Hermes rejects them) and `normalize('NFD')` is only
 * used when it really decomposes (it is a no-op on a build without Intl).
 */

export type MatchResult = 'exact' | 'close' | 'wrong';

/** What `checkTypedAnswer` says, plus the rating a typed answer gets (never Hard or Easy). */
export type TypedVerdict = {
  result: MatchResult;
  /** 3 (Good) for exact and close; null for wrong: the user picks Again or "Count it as right". */
  rating: 3 | null;
  /** The alternative the answer matched best, as written on the card (for "Spelling: …"). */
  expected: string;
};

export const MATCH_RULES = {
  maxWords: 5,
  maxChars: 40,
  /** How many extra words an answer may have around the expected ones. */
  extraWords: 2,
  typableTypes: ['basic', 'cloze'] as readonly string[],
} as const;

const ARTICLES = new Set(['a', 'an', 'the']);
// Combining diacritical marks U+0300–U+036F, written as escapes (no \p{} on older Hermes).
const COMBINING_MARKS = /[̀-ͯ]/g;
const CAN_DECOMPOSE = (() => {
  try {
    return 'é'.normalize('NFD').length === 2;
  } catch {
    return false;
  }
})();

// Placeholders that survive the punctuation pass (private-use characters, never typed).
const DECIMAL = '';
const MINUS = '';

/** The normalized form both sides are compared in. */
export function normalizeAnswer(input: string): string {
  let text = String(input ?? '').toLowerCase();
  if (CAN_DECOMPOSE) text = text.normalize('NFD').replace(COMBINING_MARKS, '');
  // Apostrophes of every kind vanish ("it's" → "its"); other quotes become spaces below.
  text = text.replace(/['‘’ʼ`]/g, '');
  // Keep a decimal point or comma between digits ("9.81", "9,81" → 9.81) and a leading minus sign.
  text = text.replace(/(\d)[.,](?=\d)/g, `$1${DECIMAL}`);
  text = text.replace(/(^|[\s(])[-−](?=\d)/g, `$1${MINUS}`);
  // Everything else that is not a letter or digit separates words. Letters: Latin, Greek, Cyrillic,
  // and any character above U+00FF that is not punctuation or a symbol we know (CJK stays as is).
  text = text.replace(/[\u0000-/:-@[-`{-¿×÷ -⁯←-⯿　-〿]+/g, ' ');
  text = text.split(DECIMAL).join('.').split(MINUS).join('-');
  return text
    .split(/\s+/)
    .filter((token) => token !== '' && !ARTICLES.has(token))
    .join(' ');
}

/** The expected answer's alternatives, as written (split on `;` or `|`), without empty ones. */
export function answerAlternatives(expected: string): string[] {
  return String(expected ?? '')
    .split(/[;|]/)
    .map((part) => part.trim())
    .filter((part) => normalizeAnswer(part) !== '');
}

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent transpositions). */
export function osaDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let before = new Array<number>(n + 1).fill(0);
  let previous = Array.from({ length: n + 1 }, (_, j) => j);
  let current = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    current[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], before[j - 2] + 1);
      }
    }
    [before, previous, current] = [previous, current, before];
  }
  return previous[n];
}

/** Spelling edits allowed for an expected answer of `length` characters. */
export function allowedEdits(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  if (length <= 15) return 2;
  return Math.floor(length * 0.15);
}

function numbersOf(normalized: string): string {
  return (normalized.match(/-?\d+(?:\.\d+)?/g) ?? []).join(' ');
}

function containsInOrder(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, k) => haystack[start + k] === token)) return true;
  }
  return false;
}

/** Whether a card can be answered by typing: a short basic or cloze answer. */
export function isTypable(card: { cardType: string; answer: string }): boolean {
  if (!MATCH_RULES.typableTypes.includes(card.cardType)) return false;
  const alternatives = answerAlternatives(card.answer).map(normalizeAnswer);
  return (
    alternatives.length > 0 &&
    alternatives.every((alt) => alt.length <= MATCH_RULES.maxChars && alt.split(' ').length <= MATCH_RULES.maxWords)
  );
}

function compare(got: string, expected: string): MatchResult {
  if (got === expected) return 'exact';
  if (numbersOf(got) !== numbersOf(expected)) return 'wrong';
  const gotTokens = got.split(' ');
  const expectedTokens = expected.split(' ');
  if (gotTokens.length - expectedTokens.length <= MATCH_RULES.extraWords && containsInOrder(gotTokens, expectedTokens)) {
    return 'close';
  }
  if (got[0] === expected[0] && osaDistance(got, expected) <= allowedEdits(expected.length)) return 'close';
  return 'wrong';
}

/**
 * Checks a typed answer against the card's expected answer. For a card that is not typable the
 * result is still computed (callers should not offer typing then; see isTypable).
 */
export function checkTypedAnswer(typed: string, expectedAnswer: string): TypedVerdict {
  const alternatives = answerAlternatives(expectedAnswer);
  const got = normalizeAnswer(typed);
  const first = alternatives[0] ?? String(expectedAnswer ?? '').trim();
  if (got === '' || alternatives.length === 0) return { result: 'wrong', rating: null, expected: first };
  let close: string | null = null;
  for (const alternative of alternatives) {
    const result = compare(got, normalizeAnswer(alternative));
    if (result === 'exact') return { result, rating: 3, expected: alternative };
    if (result === 'close' && close === null) close = alternative;
  }
  if (close !== null) return { result: 'close', rating: 3, expected: close };
  return { result: 'wrong', rating: null, expected: first };
}
