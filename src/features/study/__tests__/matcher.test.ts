import { describe, expect, it } from '@jest/globals';

import {
  allowedEdits,
  answerAlternatives,
  checkTypedAnswer,
  isTypable,
  normalizeAnswer,
  osaDistance,
  type MatchResult,
} from '../matcher';

describe('normalizeAnswer', () => {
  it.each([
    ['Mitochondria', 'mitochondria'],
    ['  The   Mitochondria. ', 'mitochondria'],
    ['an apple a day', 'apple day'],
    ['Café', 'cafe'],
    ['Ångström', 'angstrom'],
    ['it’s the cell’s “powerhouse”', 'its cells powerhouse'],
    ["it's", 'its'],
    ['cell-membrane', 'cell membrane'],
    ['Krebs (citric acid) cycle!', 'krebs citric acid cycle'],
    ['9.81 m/s2', '9.81 m s2'],
    ['9,81', '9.81'],
    ['-40 °C', '-40 c'],
    ['−40', '-40'],
    ['minus-5', 'minus 5'],
    ['1,000', '1.000'],
    ['end.', 'end'],
    ['日本語', '日本語'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalizeAnswer(input)).toBe(expected);
  });
});

describe('answerAlternatives', () => {
  it('splits on ; and |, trims, and drops empty parts', () => {
    expect(answerAlternatives('Krebs cycle; citric acid cycle')).toEqual(['Krebs cycle', 'citric acid cycle']);
    expect(answerAlternatives('TCA | Krebs cycle ;; ')).toEqual(['TCA', 'Krebs cycle']);
    expect(answerAlternatives('the; ;a')).toEqual([]);
  });
});

describe('osaDistance and allowedEdits', () => {
  it('counts insertions, deletions, substitutions and adjacent transpositions', () => {
    expect(osaDistance('', 'abc')).toBe(3);
    expect(osaDistance('abc', '')).toBe(3);
    expect(osaDistance('abc', 'abc')).toBe(0);
    expect(osaDistance('abc', 'acb')).toBe(1);
    expect(osaDistance('kitten', 'sitting')).toBe(3);
    expect(osaDistance('mitochondira', 'mitochondria')).toBe(1);
    expect(osaDistance('ca', 'abc')).toBe(3); // OSA, not unrestricted Damerau (which gives 2)
  });

  it('allows 0 edits up to 4 characters, 1 up to 8, 2 up to 15, then 15%', () => {
    expect([1, 4, 5, 8, 9, 15, 16, 20, 40].map(allowedEdits)).toEqual([0, 0, 1, 1, 2, 2, 2, 3, 6]);
  });
});

describe('isTypable', () => {
  it('only basic and cloze cards with short answers', () => {
    expect(isTypable({ cardType: 'basic', answer: 'Mitochondria' })).toBe(true);
    expect(isTypable({ cardType: 'cloze', answer: 'ATP synthase' })).toBe(true);
    expect(isTypable({ cardType: 'basic', answer: 'Krebs cycle; citric acid cycle' })).toBe(true);
    expect(isTypable({ cardType: 'why', answer: 'Mitochondria' })).toBe(false);
    expect(isTypable({ cardType: 'write_from_memory', answer: 'Mitochondria' })).toBe(false);
    expect(isTypable({ cardType: 'basic', answer: 'one two three four five' })).toBe(true);
    expect(isTypable({ cardType: 'basic', answer: 'one two three four five six' })).toBe(false);
    expect(isTypable({ cardType: 'basic', answer: 'the a an' })).toBe(false);
    expect(isTypable({ cardType: 'basic', answer: 'x'.repeat(41) })).toBe(false);
    expect(isTypable({ cardType: 'basic', answer: 'short; but this alternative is far too long to type in' })).toBe(false);
    expect(
      isTypable({ cardType: 'basic', answer: 'Because the enzyme lowers the activation energy of the reaction' }),
    ).toBe(false);
  });
});

describe('checkTypedAnswer', () => {
  // [typed, expected, result] — the research prototype's table, plus the cases its review added.
  const table: [string, string, MatchResult][] = [
    ['Mitochondria', 'mitochondria', 'exact'],
    ['the mitochondria', 'Mitochondria', 'exact'],
    ['mitochondira', 'mitochondria', 'close'],
    ['its the mitochondria', 'mitochondria', 'close'],
    ['in the mitochondria', 'mitochondria', 'close'],
    ['it is in the mitochondria', 'mitochondria', 'wrong'], // 3 extra words: too much around it
    ['nucleus', 'mitochondria', 'wrong'],
    ['mitochondria nucleus ribosome golgi', 'mitochondria', 'wrong'],
    ['mitochondrial', 'mitochondria', 'close'],
    ['ATP', 'ATP', 'exact'],
    ['ADP', 'ATP', 'wrong'],
    ['Krebs cycle', 'Krebs cycle; citric acid cycle', 'exact'],
    ['citric acid cycle', 'Krebs cycle; citric acid cycle', 'exact'],
    ['citric acid cylce', 'Krebs cycle; citric acid cycle', 'close'],
    ['1914', '1914', 'exact'],
    ['1915', '1914', 'wrong'],
    ['in 1914', '1914', 'close'],
    ['Café', 'cafe', 'exact'],
    ['Friedrich Nietzche', 'Friedrich Nietzsche', 'close'],
    ['photosynthesis', 'Photosynthesis', 'exact'],
    ['photosynthsis', 'photosynthesis', 'close'],
    ['9.81 m/s2', '9.81 m/s2', 'exact'],
    ['9,81 m/s2', '9.81 m/s2', 'exact'],
    ['9.8 m/s2', '9.81 m/s2', 'wrong'],
    ['-40', '−40', 'exact'],
    ['40', '-40', 'wrong'],
    ['cat', 'car', 'wrong'],
    ['Ca', 'Ca', 'exact'],
    ['', 'x', 'wrong'],
    ['   ', 'mitochondria', 'wrong'],
    ['Golgi apparatus', 'Golgi apparatus', 'exact'],
    ['golgi aparatus', 'Golgi apparatus', 'close'],
    ['apparatus golgi', 'Golgi apparatus', 'wrong'],
    ['xitochondria', 'mitochondria', 'wrong'], // a first-letter slip is never "close"
    ['i think its the mitochondria', 'mitochondria', 'wrong'], // still 3 extra words
    ['i think mitochondria', 'mitochondria', 'close'], // filler around the one answer
    ['hypotonc', 'hypotonic', 'close'], // a typo after a shared prefix is still a typo
    ['endothermc', 'endothermic', 'close'],
  ];

  it.each(table)('%j against %j is %s', (typed, expected, result) => {
    expect(checkTypedAnswer(typed, expected).result).toBe(result);
  });

  // Known false accepts: a different word one or two edits away. Accepted as "close" by design (the
  // screen shows the expected spelling); listed so a change in behaviour is noticed.
  const falseAccepts: [string, string][] = [
    ['mitochondrion', 'mitochondria'],
    ['sodium chlorite', 'sodium chloride'],
    ['dentin', 'dentine'],
    ['ileum', 'ilium'],
  ];
  it.each(falseAccepts)('known false accept: %j for %j is close', (typed, expected) => {
    expect(checkTypedAnswer(typed, expected).result).toBe('close');
  });

  // Near misses that are rejected (the user can still tap "Count it as right").
  const rejected: [string, string][] = [
    ['affect', 'effect'],
    ['ATP', 'ADP'],
    ['mitosis', 'meiosis'],
    ['nucleolus', 'nucleus'],
    ['bacterium', 'bacteria'],
    ['1066', '1067'],
    // Hedged, negated or both-ways answers: the expected words are there, but the answer says more.
    ['ribosome or mitochondria', 'mitochondria'],
    ['mitosis or meiosis', 'mitosis'],
    ['meiosis not mitosis', 'mitosis'],
    ['not true', 'true'],
    ['false not true', 'true'],
    ['increase or decrease', 'increase'],
    ['oxidation and reduction', 'reduction'],
    ['mitochondria vs nucleus', 'mitochondria'],
    ['no mitochondria', 'mitochondria'],
    // Opposite prefixes are different words, not misspellings.
    ['hypertonic', 'hypotonic'],
    ['hyperthyroidism', 'hypothyroidism'],
    ['exothermic', 'endothermic'],
    ['endergonic', 'exergonic'],
    ['absorption', 'adsorption'],
    ['intracellular', 'intercellular'],
    ['hypertonic solution', 'hypotonic solution'],
  ];
  it.each(rejected)('rejected: %j for %j', (typed, expected) => {
    expect(checkTypedAnswer(typed, expected).result).toBe('wrong');
  });

  it('rates exact and close as Good, wrong as the user’s choice, and names the matched alternative', () => {
    expect(checkTypedAnswer('Krebs cycle', 'TCA; Krebs cycle')).toEqual({ result: 'exact', rating: 3, expected: 'Krebs cycle' });
    expect(checkTypedAnswer('krebs cylce', 'TCA; Krebs cycle')).toEqual({ result: 'close', rating: 3, expected: 'Krebs cycle' });
    expect(checkTypedAnswer('glycolysis', 'TCA; Krebs cycle')).toEqual({ result: 'wrong', rating: null, expected: 'TCA' });
    expect(checkTypedAnswer('anything', '')).toEqual({ result: 'wrong', rating: null, expected: '' });
  });

  it('prefers an exact alternative over an earlier close one', () => {
    expect(checkTypedAnswer('cycle', 'cycles; cycle')).toEqual({ result: 'exact', rating: 3, expected: 'cycle' });
  });
});
