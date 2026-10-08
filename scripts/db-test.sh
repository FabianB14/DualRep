#!/usr/bin/env bash
# npm run db:test — tests the database schema against a throwaway local Postgres 16.
#
#   1. initdb into a temp dir and start Postgres listening only on a unix socket inside it (no system
#      service, no Docker, nothing shared with other runs);
#   2. apply scripts/db/supabase-stubs.sql (the parts of Supabase the schema relies on), every
#      supabase/migrations/*.sql in filename order, then supabase/seed.sql;
#   3. run every supabase/tests/*.test.sql (pgTAP, the same files `supabase test db` runs) and fail
#      on any failed test, plan mismatch or SQL error;
#   4. write supabase/schema.snapshot.json, the schema the sync-config validator compiles against.
# The server is always stopped and the temp dir removed, also on failure or Ctrl-C.
#
# Usage:  npm run db:test [-- supabase/tests/<name>.test.sql ...]   (default: every test file)
# Needs:  Postgres 16 server binaries with pgvector, pgTAP and uuid-ossp (contrib)
#         (Ubuntu: apt-get install postgresql-16 postgresql-16-pgvector postgresql-16-pgtap), and node.
# Env:    PG_BIN=/path/to/postgres/bin to pick the binaries (default: `pg_config --bindir`, then
#         /usr/lib/postgresql/16/bin).
# As root (e.g. a container), the server runs as the `postgres` OS user via runuser, because
# Postgres refuses to run as root.
set -euo pipefail

export LC_ALL=C  # stable glob order and messages

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUBS="$ROOT_DIR/scripts/db/supabase-stubs.sql"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"
SEED="$ROOT_DIR/supabase/seed.sql"
TESTS_DIR="$ROOT_DIR/supabase/tests"
SNAPSHOT="$ROOT_DIR/supabase/schema.snapshot.json"
SNAPSHOT_WRITER="$ROOT_DIR/scripts/db/write-schema-snapshot.mjs"

# Keep the caller's libpq environment from redirecting psql to some other server.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD PGSERVICE PGOPTIONS PGDATA

die() {
  echo "db-test: $*" >&2
  exit 1
}

has_server_binaries() {
  [[ -x "$1/initdb" && -x "$1/pg_ctl" && -x "$1/postgres" && -x "$1/psql" ]]
}

# True when the install next to these binaries has pgvector, pgTAP and uuid-ossp (or when that cannot
# be told, in which case the check after startup reports it).
has_extensions() {
  local share_dir
  [[ -x "$1/pg_config" ]] || return 0
  share_dir="$("$1/pg_config" --sharedir 2>/dev/null)" || return 0
  [[ -f "$share_dir/extension/vector.control" && -f "$share_dir/extension/pgtap.control" &&
    -f "$share_dir/extension/uuid-ossp.control" ]]
}

find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then
    has_server_binaries "$PG_BIN" || die "PG_BIN=$PG_BIN does not contain initdb, pg_ctl, postgres and psql"
    echo "$PG_BIN"
    return
  fi
  local candidate candidates=()
  # pg_config may belong to a client-only install (libpq-dev) or to another major version without
  # the extensions, so each candidate must have both the server and the extensions.
  if command -v pg_config >/dev/null 2>&1; then
    candidates+=("$(pg_config --bindir 2>/dev/null || true)")
  fi
  candidates+=(/usr/lib/postgresql/16/bin)
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" ]] && has_server_binaries "$candidate" && has_extensions "$candidate"; then
      echo "$candidate"
      return
    fi
  done
  die "Postgres 16 with pgvector, pgTAP and uuid-ossp not found. Install postgresql-16, postgresql-16-pgvector and postgresql-16-pgtap, or set PG_BIN."
}

PG_BIN="$(find_pg_bin)"
command -v node >/dev/null 2>&1 || die "node is required to write the schema snapshot"

# Postgres refuses to run as root, so as root the cluster belongs to the postgres OS user.
if [[ $EUID -eq 0 ]]; then
  id -u postgres >/dev/null 2>&1 || die "running as root needs a 'postgres' OS user to own the server"
  command -v runuser >/dev/null 2>&1 || die "running as root needs runuser (util-linux)"
  # Under /tmp so the postgres user can reach it whatever TMPDIR points at.
  WORK_DIR="$(mktemp -d /tmp/dualrep-db-test.XXXXXX)"
  chown postgres: "$WORK_DIR"
else
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dualrep-db-test.XXXXXX")"
fi
DATA_DIR="$WORK_DIR/data"

# Runs a server command as the cluster owner (from inside WORK_DIR, which that user can read).
as_cluster_owner() {
  if [[ $EUID -eq 0 ]]; then
    (cd "$WORK_DIR" && runuser -u postgres -- "$@")
  else
    "$@"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -f "$DATA_DIR/postmaster.pid" ]]; then
    as_cluster_owner "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The server listens on a unix socket in WORK_DIR only, so the port merely names the socket file;
# picking one that is also free on TCP keeps it unambiguous if someone enables TCP to debug.
pick_port() {
  local port attempt
  for attempt in $(seq 1 50); do
    port=$((49152 + (RANDOM + attempt) % 16000))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return
    fi
  done
  die "could not find a free port"
}
PORT="$(pick_port)"

echo "db-test: $("$PG_BIN/postgres" --version) from $PG_BIN"

as_cluster_owner "$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust --encoding=UTF8 \
  --locale=C --no-sync >"$WORK_DIR/initdb.log" 2>&1 || {
  cat "$WORK_DIR/initdb.log" >&2
  die "initdb failed"
}

cat >>"$DATA_DIR/postgresql.conf" <<EOF

# --- db-test.sh ---
listen_addresses = ''
port = $PORT
unix_socket_directories = '$WORK_DIR'
# The migration creates a logical-replication publication (for PowerSync).
wal_level = logical
# A throwaway cluster: durability only slows the run down.
fsync = off
synchronous_commit = off
full_page_writes = off
EOF

as_cluster_owner "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$WORK_DIR/postgres.log" -w -t 60 start >/dev/null || {
  cat "$WORK_DIR/postgres.log" >&2 || true
  die "Postgres did not start"
}

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK_DIR" -p "$PORT" -U postgres -d postgres)

# The migration creates vector and uuid-ossp in `extensions`; uuid-ossp ships with the postgresql-16
# package itself (contrib).
missing_extensions="$("${PSQL[@]}" -At -c "
  select string_agg(name, ', ' order by name)
  from unnest(array['vector', 'pgtap', 'uuid-ossp']) as name
  where name not in (select e.name from pg_available_extensions e)")"
if [[ -n "$missing_extensions" ]]; then
  die "Postgres extensions not installed: $missing_extensions (apt-get install postgresql-16 postgresql-16-pgvector postgresql-16-pgtap)"
fi

# Applies one SQL file in a single transaction (like the Supabase CLI does for a migration).
apply_sql() {
  local file="$1" log="$WORK_DIR/apply.log"
  if ! PGOPTIONS='-c client_min_messages=warning' "${PSQL[@]}" --single-transaction -f "$file" >"$log" 2>&1; then
    cat "$log" >&2
    die "failed to apply ${file#"$ROOT_DIR"/}"
  fi
  # Surface warnings without failing on them.
  if [[ -s "$log" ]]; then
    sed "s|^|  ${file##*/}: |" "$log" >&2
  fi
}

apply_sql "$STUBS"
shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)
((${#migrations[@]} > 0)) || die "no migrations in supabase/migrations"
for migration in "${migrations[@]}"; do
  apply_sql "$migration"
done
[[ -f "$SEED" ]] && apply_sql "$SEED"
echo "db-test: applied stubs, ${#migrations[@]} migration(s) and seed.sql"

# --- tests ---------------------------------------------------------------------------------------
if (($# > 0)); then
  test_files=("$@")
else
  test_files=("$TESTS_DIR"/*.test.sql)
fi
((${#test_files[@]} > 0)) || die "no test files in supabase/tests"

failed_files=0
total_tests=0
for test_file in "${test_files[@]}"; do
  [[ -f "$test_file" ]] || die "no such test file: $test_file"
  name="${test_file##*/}"
  status=0
  # The same psql flags pg_prove uses: unaligned, tuples only, so each TAP line stands alone.
  output="$(PGOPTIONS='-c client_min_messages=warning' "${PSQL[@]}" -A -t -P pager=off -f "$test_file" 2>&1)" || status=$?

  planned="$(grep -Em1 '^1\.\.[0-9]+$' <<<"$output" | cut -d. -f3 || true)"
  passed="$(grep -Ec '^ok [0-9]+' <<<"$output" || true)"
  failures="$(grep -Ec '^not ok [0-9]+' <<<"$output" || true)"

  problem=""
  if ((status != 0)); then
    problem="psql exited with status $status"
  elif grep -q 'ERROR:' <<<"$output"; then
    problem="SQL error"
  elif [[ -z "$planned" ]]; then
    problem="no plan (missing select plan(n))"
  elif ((failures > 0)); then
    problem="$failures failed"
  elif grep -q '^# Looks like' <<<"$output"; then
    problem="$(grep -m1 '^# Looks like' <<<"$output" | sed 's/^# //')"
  elif ((passed != planned)); then
    problem="planned $planned tests but $passed passed"
  fi

  if [[ -z "$problem" ]]; then
    printf 'PASS  %-40s %3d tests\n' "$name" "$passed"
    total_tests=$((total_tests + passed))
  else
    printf 'FAIL  %-40s %s\n' "$name" "$problem"
    # Everything except the passing lines: failures, their diagnostics and any SQL error.
    grep -Ev '^ok [0-9]+' <<<"$output" | sed 's/^/      /' || true
    failed_files=$((failed_files + 1))
  fi
done

# --- schema snapshot -----------------------------------------------------------------------------
# Written even when a test failed: it describes the migrated schema, which applied cleanly.
"${PSQL[@]}" -At >"$WORK_DIR/schema.raw.json" <<'SQL'
select json_build_object(
  'tables', coalesce((
    select json_agg(json_build_object(
      'name', c.relname,
      'rls', c.relrowsecurity,
      'columns', (
        select json_agg(json_build_object(
          'name', a.attname,
          'type', t.typname,
          'nullable', not a.attnotnull,
          'has_default', a.atthasdef or a.attidentity <> '' or a.attgenerated <> ''
        ) order by a.attnum)
        from pg_attribute a
        join pg_type t on t.oid = a.atttypid
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      )
    ) order by c.relname collate "C")
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  ), '[]'),
  'publication', coalesce((
    select json_agg(p.tablename order by p.tablename collate "C")
    from pg_publication_tables p
    where p.pubname = 'powersync' and p.schemaname = 'public'
  ), '[]')
);
SQL
node "$SNAPSHOT_WRITER" "$WORK_DIR/schema.raw.json" "$SNAPSHOT"
echo "db-test: wrote ${SNAPSHOT#"$ROOT_DIR"/}"

if ((failed_files > 0)); then
  die "$failed_files of ${#test_files[@]} test file(s) failed"
fi
echo "db-test: all ${#test_files[@]} test files passed ($total_tests tests)"
