/**
 * Golden output of tracy-ai's chunkPageText (src/extract.js) for three inputs, captured on 2026-10-09.
 * chunker_test.ts checks that the port in chunker.ts produces exactly the same chunks, so passages made
 * from transcripts here look like the ones Tracy makes from text pages. Regenerate when Tracy's
 * chunker changes (run its chunkPageText on these inputs and paste the result).
 */
export const CHUNKER_GOLDEN: Record<string, { input: string; chunks: { title: string; content: string }[] }> = {
  "mixed": {
    "input": "# Week 2: Enzymes\n\nEnzymes speed up reactions. They are proteins.\n\n## Active site\n\nThe substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. \n\nShort tail paragraph.",
    "chunks": [
      {
        "title": "Week 2: Enzymes",
        "content": "# Week 2: Enzymes\n\nEnzymes speed up reactions. They are proteins.\n\n## Active site"
      },
      {
        "title": "Active site",
        "content": "The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site. The substrate binds to the active site."
      },
      {
        "title": "Active site",
        "content": "Short tail paragraph."
      }
    ]
  },
  "lines": {
    "input": "line one\nline two\nline three\n\nSentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? ",
    "chunks": [
      {
        "title": "",
        "content": "line one\nline two\nline three"
      },
      {
        "title": "",
        "content": "Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question? Sentence number one is here. Another sentence follows! A question?"
      }
    ]
  },
  "crlf": {
    "input": "First para.\r\n\r\nSecond para.\r\n\r\n# Head\r\n\r\nUnder head.",
    "chunks": [
      {
        "title": "",
        "content": "First para.\n\nSecond para.\n\n# Head\n\nUnder head."
      }
    ]
  }
};
