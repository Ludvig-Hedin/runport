#!/bin/bash
# Check a downloaded synthetic analytics dump in a fresh local cluster.
set -euo pipefail
dump=${1:-}
expected=${2:-}
if [ "$#" -ne 2 ] || [ ! -f "$dump" ] || [[ ! "$expected" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]]; then
  echo "usage: $0 downloaded-fixture.dump 'tables|websites|events|users'" >&2
  exit 64
fi
umask 077
work_dir=$(mktemp -d /tmp/runport-analytics-restore.XXXXXX)
trap 'pg_ctl -D "$work_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -r -- "$work_dir"' EXIT

# Never inherit a project or production connection. The fresh server accepts
# connections only on its own private socket, even if another cluster is running.
unset PGHOSTADDR PGSERVICE PGOPTIONS
export PGHOST="$work_dir" PGPORT=55432 PGUSER=restore_owner PGDATABASE=postgres
initdb -D "$work_dir/data" --auth=trust -U "$PGUSER" >/dev/null
pg_ctl -D "$work_dir/data" -o "-h '' -k $work_dir -p $PGPORT" -l "$work_dir/postgres.log" -w start >/dev/null
createdb runport_analytics_restore
pg_restore --exit-on-error --no-owner --no-acl -d runport_analytics_restore -- "$dump"
counts=$(psql -X -qAt -v ON_ERROR_STOP=1 -d runport_analytics_restore <<'SQL'
SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
       (SELECT count(*) FROM website),
       (SELECT count(*) FROM website_event),
       (SELECT count(*) FROM "user");
SQL
)
if [ "$counts" != "$expected" ]; then
  printf 'Expected %s, restored %s\n' "$expected" "$counts" >&2
  exit 1
fi
printf 'Analytics restore matched table and row counts (%s).\n' "$counts"
