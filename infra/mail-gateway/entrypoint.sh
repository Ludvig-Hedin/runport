#!/bin/sh
set -eu
umask 077

bun /app/src/storage-permissions.ts "$(id -u bun)" "$(id -g bun)"
exec su-exec bun "$@"
