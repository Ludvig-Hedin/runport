#!/bin/sh
set -eu
umask 077

database=${DATA_FILE:-/data/limits.sqlite}
if [ "$(dirname "$database")" = "/data" ]; then
  mkdir -p /data
  chown bun:bun /data
  for file in "$database" "$database-wal" "$database-shm" "$database-journal" \
    "$database.app-alerts" "$database.app-alerts-wal" "$database.app-alerts-shm" "$database.app-alerts-journal"; do
    if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then
      echo "Gateway database path must be a regular file." >&2
      exit 1
    fi
    if [ -e "$file" ]; then
      chown bun:bun "$file"
    fi
  done
fi
exec su-exec bun "$@"
