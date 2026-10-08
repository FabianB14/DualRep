# Exercise import (Phase 1 prep, not wired up yet)

These two scripts come from the Phase 0 research on
[free-exercise-db](https://github.com/yuhonas/free-exercise-db). They are kept here so Phase 1 can
start from them. Nothing in the app or CI runs them.

- `enum-counts.mjs <exercises.json> [schema.json]` prints every enumerated value in the dataset with
  counts (876 exercises on 2026-10-08).
- `map-free-exercise-db.mjs <exercises.json> [--dump out.json]` applies DualRep's curation rules
  (equipment, location, movement pattern, body region, training category, demand level, micro_ok)
  and prints the distributions. The rules are written out in
  [docs/research/exercise-data-and-fsrs.md](../../docs/research/exercise-data-and-fsrs.md) §A6.

Before any import, read [docs/DECISIONS.md](../../docs/DECISIONS.md): the dataset's license does
not clearly cover its images or instruction text, so Phase 1 imports the structured fields only,
every row lands with `reviewed = false`, and a person reviews rows before Tracy can use them.

Get the data from `https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json`
and pin it by its sha256 (the research copy was
`5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf`).
