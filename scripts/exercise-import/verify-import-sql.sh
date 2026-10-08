#!/usr/bin/env bash
# Proves an import file from build-import-sql.mjs against the real schema before anyone pastes it into
# Supabase. scripts/db-test.sh starts a throwaway Postgres 16 with every migration applied and runs a
# pgTAP test written here (in a temp dir, nothing is added to the repo) that:
#   1. runs the import on the migrated database: every row inserted, all as unreviewed dataset rows
#      with no owner, images or instructions, and the CHECK constraints accept every value;
#   2. plays a curator (a curated fix + reviewed, a reviewed row whose dataset name changed, a reviewed
#      untouched row, images added by hand, a dataset row the file no longer has) and runs the import
#      again: only the rows with something to change are rewritten, the fix and the reviews survive,
#      the changed row is refreshed and needs a new review, images and instructions are cleared;
#   3. runs it a third time: nothing changes;
#   and checks the summary row the import prints each time.
#
# Usage:  bash scripts/exercise-import/verify-import-sql.sh <import.sql>
# Needs:  what scripts/db-test.sh needs (Postgres 16 with pgvector, pgTAP and uuid-ossp; node).
# Like every db-test.sh run, it rewrites supabase/schema.snapshot.json (same content unless the
# migrations changed).
set -euo pipefail

die() {
  echo "verify-import-sql: $*" >&2
  exit 1
}

if (($# != 1)); then
  echo "usage: bash scripts/exercise-import/verify-import-sql.sh <import.sql>" >&2
  exit 2
fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$1" ]] || die "no such file: $1"
SQL_FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROWS="$(sed -n 's/^-- Exercises: \([0-9][0-9]*\)$/\1/p' "$SQL_FILE")"
[[ -n "$ROWS" ]] || die "$1 has no '-- Exercises: N' line; was it written by build-import-sql.mjs?"
((ROWS >= 4)) || die "the check needs at least 4 exercises in the file (it has $ROWS)"

# Under /tmp so the paths stay short and free of quotes; psql (run as the current user) reads and
# writes here.
WORK_DIR="$(mktemp -d /tmp/dualrep-import-verify.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
[[ "$SQL_FILE$WORK_DIR" != *"'"* ]] || die "paths with a single quote are not supported: $SQL_FILE"
TEST_FILE="$WORK_DIR/exercise_import.test.sql"

{
  echo "\\set import_file '$SQL_FILE'"
  echo "\\set first_out '$WORK_DIR/first.out'"
  echo "\\set second_out '$WORK_DIR/second.out'"
  echo "\\set third_out '$WORK_DIR/third.out'"
  echo "\\set rows $ROWS"
  cat <<'SQL'
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- The import prints one row: rows_in_file|inserted|updated|review_reset|unchanged|not_in_file.
\pset format unaligned
\pset tuples_only on

create temp table library_before as
  select id, name, updated_at from public.exercises where origin <> 'dataset';

-- 1. First run ------------------------------------------------------------------------------------
\o :first_out
\i :import_file
\o
\set first_summary `cat :'first_out'`

select is(:'first_summary', format('%s|%s|0|0|0|0', :rows, :rows), 'first run: every exercise is inserted');
select is((select count(*) from public.exercises where origin = 'dataset'), :rows::bigint,
  'one dataset row per exercise in the file');
select is(
  (select count(*) from public.exercises
    where origin = 'dataset'
      and (reviewed or owner_id is not null or group_id is not null or images <> '[]' or instructions <> '[]')),
  0::bigint,
  'dataset rows arrive unreviewed, with no owner, group, images or instructions'
);
select is(
  (select count(*) from public.exercises
    where origin = 'dataset'
      and (muscle_group is null or movement_pattern is null or body_region is null or category is null
           or demand_level is null or dataset_category is null or level is null
           or jsonb_array_length(equipment) = 0)),
  0::bigint,
  'every dataset row has its curated fields filled in'
);
select set_eq(
  $$select id, name, updated_at from public.exercises where origin <> 'dataset'$$,
  $$select id, name, updated_at from library_before$$,
  'the import leaves every other library row alone'
);

-- 2. A curator works on four rows, then the import runs again ----------------------------------
create temp table picked as
  select dataset_id, name, row_number() over (order by dataset_id) as n
  from public.exercises where origin = 'dataset'
  order by dataset_id
  limit 4;

-- (1) a fixed curated field, then reviewed
update public.exercises e
  set reviewed = true,
      movement_pattern = case when e.movement_pattern = 'other' then 'core' else 'other' end,
      micro_ok = not e.micro_ok
  from picked p where p.dataset_id = e.dataset_id and p.n = 1;
-- (2) a fixed curated field and reviewed, but its dataset name changed since (the stored name
--     differs from the file), so the import must update it
update public.exercises e
  set reviewed = true,
      name = e.name || ' (old name)',
      equipment = e.equipment || '["band"]',
      body_region = case when e.body_region = 'full' then 'core' else 'full' end
  from picked p where p.dataset_id = e.dataset_id and p.n = 2;
-- (3) reviewed, nothing changed
update public.exercises e set reviewed = true
  from picked p where p.dataset_id = e.dataset_id and p.n = 3;
-- (4) reviewed, with images and instructions added by hand
update public.exercises e set reviewed = true, images = '["by-hand/0.jpg"]', instructions = '["By hand."]'
  from picked p where p.dataset_id = e.dataset_id and p.n = 4;
-- a dataset row the file no longer has
insert into public.exercises (name, origin, dataset_id, reviewed)
  values ('Retired upstream', 'dataset', 'Not_In_The_Import_File', true);

create temp table before_rerun as
  select dataset_id, ctid as tuple, name, equipment, body_region, movement_pattern, micro_ok, reviewed
  from public.exercises where origin = 'dataset';

\o :second_out
\i :import_file
\o
\set second_summary `cat :'second_out'`

select is(:'second_summary', format('%s|0|2|1|%s|1', :rows, :rows - 2),
  'second run: two rows updated, one needs a new review, the rest untouched, one not in the file');
select set_eq(
  $$select e.dataset_id from public.exercises e join before_rerun b using (dataset_id) where e.ctid <> b.tuple$$,
  $$select dataset_id from picked where n in (2, 4)$$,
  'only the rows with something to change are rewritten'
);
select results_eq(
  $$select e.reviewed, e.movement_pattern, e.micro_ok from public.exercises e join picked p using (dataset_id) where p.n = 1$$,
  $$select b.reviewed, b.movement_pattern, b.micro_ok from before_rerun b join picked p using (dataset_id) where p.n = 1$$,
  'a curated fix and its review survive a re-import'
);
select results_eq(
  $$select e.name, e.reviewed, e.equipment, e.body_region
    from public.exercises e join picked p using (dataset_id) where p.n = 2$$,
  $$select p.name, false, b.equipment, b.body_region
    from picked p join before_rerun b using (dataset_id) where p.n = 2$$,
  'a changed dataset fact is refreshed, keeps the curated fix, and needs a new review'
);
select is(
  (select e.reviewed from public.exercises e join picked p using (dataset_id) where p.n = 3),
  true,
  'an unchanged reviewed row stays reviewed'
);
select results_eq(
  $$select e.images, e.instructions, e.reviewed from public.exercises e join picked p using (dataset_id) where p.n = 4$$,
  $$values ('[]'::jsonb, '[]'::jsonb, true)$$,
  'images and instructions are cleared (D9) without costing the review'
);
select results_eq(
  $$select name, reviewed from public.exercises where dataset_id = 'Not_In_The_Import_File'$$,
  $$values ('Retired upstream', true)$$,
  'a dataset row the file no longer has is left alone'
);
select is((select count(*) from public.exercises where origin = 'dataset'), :rows::bigint + 1,
  'a re-import adds no duplicates');

-- 3. Third run: nothing left to do ----------------------------------------------------------------
create temp table before_third as select dataset_id, ctid as tuple from public.exercises where origin = 'dataset';

\o :third_out
\i :import_file
\o
\set third_summary `cat :'third_out'`

select is(:'third_summary', format('%s|0|0|0|%s|1', :rows, :rows), 'third run: nothing changes');
select is(
  (select count(*) from public.exercises e join before_third b using (dataset_id) where e.ctid <> b.tuple),
  0::bigint,
  'third run: no row is rewritten'
);

-- A signed-in user sees dataset rows only once they are reviewed: rows (1), (3), (4) and the retired
-- one. The rest, (2) included, wait for a curator.
insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'ada@example.com');
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
select is((select count(*) from public.exercises where origin = 'dataset'), 4::bigint,
  'a user sees only the reviewed dataset rows');
reset role;

select * from finish();
rollback;
SQL
} >"$TEST_FILE"

echo "verify-import-sql: checking ${SQL_FILE} ($ROWS exercises) against a throwaway database"
bash "$ROOT_DIR/scripts/db-test.sh" "$TEST_FILE"
