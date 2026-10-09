# Exercise import (free-exercise-db)

Phase 1 loads the structured fields of [free-exercise-db](https://github.com/yuhonas/free-exercise-db)
(876 exercises) into `public.exercises` as library rows: `origin = 'dataset'`, `reviewed = false`, no
owner. Phones only see a library row once a person has reviewed it, so an import changes nothing in
the app until someone curates. The app never runs these scripts.

| File | What it does |
|---|---|
| `mapping.mjs` | DualRep's curation rules (equipment, location, movement pattern, body region, training category, demand level, micro_ok), written out in [research §A6](../../docs/research/exercise-data-and-fsrs.md). Pure functions. |
| `build-import-sql.mjs` | `node scripts/exercise-import/build-import-sql.mjs <exercises.json> --out <file.sql> [--allow-unpinned]`: checks the pinned sha256, validates the file, writes the import SQL. |
| `verify-import-sql.sh` | `bash scripts/exercise-import/verify-import-sql.sh <file.sql>`: proves a built file against every migration on a throwaway Postgres 16 (through `scripts/db-test.sh`; needs the same packages). |
| `map-free-exercise-db.mjs` | `<exercises.json> [--dump out.json] [--show field=value]`: the mapping's distributions, for curators (e.g. `--show movement_pattern=other`). |
| `enum-counts.mjs` | `<exercises.json> [schema.json]`: every enumerated value in a copy of the dataset, with counts. |
| `fixtures/spot-check.json` | Test rows: the §A6 spot-check table plus a few odd rows, with the instruction text replaced (see Licence). |
| `*.test.mjs` | `npm run test:scripts` (part of `npm run check`). |

## Running the import

1. GitHub → Actions → **Exercise import SQL** → Run workflow. (GitHub shows the button only once
   `exercise-import.yml` is on `main`.) It downloads `dist/exercises.json` at
   upstream commit `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5`, fails unless its sha256 is
   `5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf`, builds the SQL, proves it on a
   throwaway database (first import, re-import after curator edits, a third run that changes nothing),
   and uploads it as the artifact `dualrep-exercise-import-sql`.
2. Download and unzip the artifact. In the Supabase dashboard open **SQL Editor**, paste
   `dualrep-exercise-import.sql` and run it (or `psql "<connection string>" -f dualrep-exercise-import.sql`).
   It is one statement, so it is one transaction: all rows or none. It prints one row:

   | rows_in_file | inserted | updated | review_reset | unchanged | not_in_file |
   |---|---|---|---|---|---|
   | in the file | new rows | rows with a changed fact (or images/instructions cleared) | reviewed rows that changed and need a new review | rows left untouched | dataset rows in the database that the file no longer has |

3. Curate (below).

The file is about 200 KB. It has been proven with `psql` on Postgres 16 with every migration
applied, but not yet pasted into the hosted SQL Editor; if the editor struggles with it, use `psql`.

Locally, the same steps:

```sh
curl -fsSL -o /tmp/exercises.json \
  https://raw.githubusercontent.com/yuhonas/free-exercise-db/f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5/dist/exercises.json
node scripts/exercise-import/build-import-sql.mjs /tmp/exercises.json --out /tmp/dualrep-exercise-import.sql
bash scripts/exercise-import/verify-import-sql.sh /tmp/dualrep-exercise-import.sql
```

## What a run writes

Rows are matched by `dataset_id` (the upstream `id`; a CHECK keeps it on dataset rows only), so the
SQL can be run again after every upstream update without losing curators' work.

| Columns | New row | Row already imported |
|---|---|---|
| Dataset facts: `name`, `muscle_group`, `secondary_muscles`, `level`, `force`, `mechanic`, `dataset_category` | from the file | refreshed from the file |
| Curated: `equipment`, `location`, `movement_pattern`, `body_region`, `category`, `demand_level`, `micro_ok` | from `mapping.mjs` | **kept** (a curator's fixes survive) |
| `images`, `instructions` | `[]` | set to `[]` (D9) |
| `reviewed` | `false` | kept only if no dataset fact changed, else `false` |
| `origin`, `owner_id`, `group_id` | `'dataset'`, null, null | unchanged |

A row with nothing to change is not updated at all: its `updated_at` stays, and phones do not
download the library again.

The import never touches the Interverse starter library (`origin = 'interverse'`, seeded by the
migration `20261008120000_starter_library.sql`): those rows have no `dataset_id`, and the import
matches on `dataset_id` only. Once dataset rows are reviewed, the app's default circuits and swaps
can use them alongside the starter exercises (short circuits only take rows with `micro_ok` and a
demand level of 1 or 2). Each row's curated fields therefore decide where it can appear: check them
before setting `reviewed = true`. Dataset rows the file no longer has are left alone (a logged set may still
point at them) and counted in `not_in_file`.

## Curating

- Start with `movement_pattern = 'other'` and `location = 'gym'`, where the rules are least sure
  (§A6 "Residual error"). Fix the curated columns, then set `reviewed = true`, e.g.
  `update public.exercises set movement_pattern = '…', reviewed = true where dataset_id = '…';`
- Fix only curated columns. A dataset fact edited by hand is put back by the next import, and the row
  loses its review.
- A change to `mapping.mjs` only reaches rows imported after it. Rows already in the database keep
  their curated values; change those with a one-off `update`.

## Moving to a newer copy of the dataset

1. Download the new `exercises.json`; run `enum-counts.mjs` and `map-free-exercise-db.mjs` on it and
   compare with the pinned copy.
2. `build-import-sql.mjs --allow-unpinned` refuses a file with values the rules do not know (a new
   muscle, equipment or category) and lists them. Add the rules and tests first.
3. Update `PINNED_SHA256` and `DATASET_COMMIT` in `build-import-sql.mjs` and the two `env` values in
   `.github/workflows/exercise-import.yml` (`build-import-sql.test.mjs` fails while they differ).
4. Run the workflow and the SQL. Rows whose facts changed come back unreviewed (`review_reset`).

## Licence

Read [docs/DECISIONS.md](../../docs/DECISIONS.md) D9 first: the dataset's licence (the Unlicense) does
not clearly cover its images or instruction text, so the import brings in the structured fields
only, and DualRep writes its own instructions. For the same reason the test fixture keeps the
dataset's structured fields but not its instruction text.
