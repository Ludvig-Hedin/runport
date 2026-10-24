#!/bin/bash
# Plans or applies Sitedock's Railway project (.railway/railway.ts).
# Secrets live in the macOS Keychain (service "sitedock-prod"); missing ones
# are generated once. Usage: ./apply.sh plan | ./apply.sh apply
set -euo pipefail
cd "$(dirname "$0")"
SERVICE=sitedock-prod

get() { security find-generic-password -s "$SERVICE" -a "$1" -w 2>/dev/null; }
ensure() {
  local name=$1 bytes=${2:-32}
  if ! get "$name" >/dev/null; then
    security add-generic-password -s "$SERVICE" -a "$name" -w "$(openssl rand -hex "$bytes")"
  fi
  get "$name"
}

export SD_OPENSSL_KEY=$(ensure openssl-key 64)
export SD_DB_PASS=$(ensure db-pass)
export SD_DB_ROOT_PASS=$(ensure db-root-pass)
export SD_EXECUTOR_SECRET=$(ensure executor-secret)
export SD_JOBS_SECRET=$(ensure jobs-secret)
export SD_GEO_SECRET=$(ensure geo-secret 64)
export SD_TRACKING_SECRET=$(ensure tracking-secret 64)
export SD_USAGE_PASS=$(ensure usage-pass)
export SD_MAIL_MASTER_KEY=$(ensure mail-master-key)
# Same derivation as infra/mail-gateway/src/identity.ts for the system sender.
export SD_SMTP_SYSTEM_PASSWORD=$(printf 'mail-gateway-system' | openssl dgst -sha256 -hmac "$SD_MAIL_MASTER_KEY" -r | cut -d' ' -f1)
export SD_MAILPIT_AUTH="ludvig:$(ensure mailpit-password 12)"
export SD_PUBLIC_DOMAIN=$(get public-domain || true)
if [ -z "$SD_PUBLIC_DOMAIN" ]; then echo "Set the router domain first: security add-generic-password -s $SERVICE -a public-domain -w <domain>" >&2; exit 1; fi

case "${1:-plan}" in
  plan) railway config plan "${@:2}" ;;
  apply) railway config apply --yes ;;
  *) echo "usage: $0 plan|apply" >&2; exit 64 ;;
esac
