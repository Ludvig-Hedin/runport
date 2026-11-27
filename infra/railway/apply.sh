#!/bin/bash
# Plans or applies Runport's Railway project (.railway/railway.ts).
# Secrets live in the macOS Keychain (service "runport-prod"); missing ones
# are generated once. Usage: ./apply.sh plan | ./apply.sh apply
set -euo pipefail
cd "$(dirname "$0")"
SERVICE=runport-prod

deploy_main_source() (
  if [ "$#" -ne 1 ]; then
    echo "usage: $0 deploy-gateway|deploy-monitor|deploy-backup" >&2
    exit 64
  fi
  case "$1" in
    deploy-gateway) service=mail-gateway; source_path=infra/mail-gateway ;;
    deploy-monitor) service=monitor; source_path=infra/railway/ops ;;
    deploy-backup) service=backup; source_path=infra/railway/ops ;;
    *) exit 64 ;;
  esac
  commit=$(git rev-parse HEAD)
  main=$(git ls-remote --exit-code origin refs/heads/main)
  if [ "$commit" != "${main%%[[:space:]]*}" ] || ! git diff --quiet HEAD -- apply.sh; then
    echo "Deploy from an unmodified apply.sh at the published main commit." >&2
    exit 1
  fi
  umask 077
  deploy_dir=$(mktemp -d)
  trap 'rm -r -- "$deploy_dir"' EXIT
  git -C ../.. archive "$commit:$source_path" | tar -xf - -C "$deploy_dir"
  # Railway source uploads are separate from configuration plans. Pin both
  # the uploaded tree and the production target instead of using the link.
  railway up "$deploy_dir" --path-as-root --detach --message "Runport $service $commit" \
    --project c93df5f9-ac8b-453d-815a-e9fedd991ca1 \
    --environment d95ac74a-26dc-4738-8765-3ab1389e057f --service "$service"
)

case "${1:-plan}" in
  deploy-gateway|deploy-monitor|deploy-backup) deploy_main_source "$@"; exit ;;
esac

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
export SD_ANALYTICS_DB_PASS=$(ensure analytics-db-password)
export SD_ANALYTICS_APP_SECRET=$(ensure analytics-app-secret)
export SD_ANALYTICS_INGEST_SECRET=$(ensure analytics-ingest-secret)
export SD_EXECUTOR_SECRET=$(ensure executor-secret)
export SD_JOBS_SECRET=$(ensure jobs-secret)
export SD_GEO_SECRET=$(ensure geo-secret 64)
export SD_TRACKING_SECRET=$(ensure tracking-secret 64)
export SD_USAGE_PASS=$(ensure usage-pass)
export SD_MAIL_MASTER_KEY=$(ensure mail-master-key)
# Same derivation as infra/mail-gateway/src/identity.ts for the system sender.
export SD_SMTP_SYSTEM_PASSWORD=$(printf 'mail-gateway-system' | openssl dgst -sha256 -hmac "$SD_MAIL_MASTER_KEY" -r | cut -d' ' -f1)
export SD_CF_MAIL_TOKEN=$(get cloudflare-mail-token)
export SD_PUBLIC_DOMAIN=$(get public-domain || true)
if [ -z "$SD_PUBLIC_DOMAIN" ]; then echo "Set the router domain first: security add-generic-password -s $SERVICE -a public-domain -w <domain>" >&2; exit 1; fi
export SD_GIT_BACKUP_TOKEN=$(ensure git-backup-token)
export SD_APP_ALERT_RAILWAY_TOKEN=$(get app-alert-railway-token || true)
if [ -n "$SD_APP_ALERT_RAILWAY_TOKEN" ]; then
  export SD_APP_ALERT_MONITOR_KEY=$(bun -e 'import { createHmac } from "node:crypto"; process.stdout.write(createHmac("sha256", process.env.SD_MAIL_MASTER_KEY).update("runport-app-alerts:monitor").digest("hex"));')
fi

case "${1:-plan}" in
  plan) railway config plan "${@:2}" ;;
  apply|apply-analytics|apply-app-alerts)
    if [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != "--no-op" ]; }; then
      echo "usage: $0 $1 [--no-op]" >&2; exit 64
    fi
    git diff --quiet HEAD -- .railway || { echo "Commit the Railway configuration before applying it." >&2; exit 1; }
    if [ "$1" = "apply-app-alerts" ] && [ -z "$SD_APP_ALERT_RAILWAY_TOKEN" ]; then
      echo "App alerts need the app-alert-railway-token in the runport-prod Keychain." >&2; exit 1
    fi
    umask 077
    plan_dir=$(mktemp -d)
    trap 'rm -f -- "$plan_dir/plan.json"; rmdir -- "$plan_dir"' EXIT
    # Let Railway use the same source hash here and at apply time. For this
    # nested configuration it hashes the directory instead of HEAD:.railway.
    railway config plan --out "$plan_dir/plan.json"
    if [ "$1" = "apply-analytics" ]; then
      bun check-git-plan.ts "$plan_dir/plan.json" --analytics "${@:2}"
    elif [ "$1" = "apply-app-alerts" ]; then
      bun check-git-plan.ts "$plan_dir/plan.json" --app-alerts "${@:2}"
    else
      bun check-git-plan.ts "$plan_dir/plan.json" "${@:2}"
    fi
    railway config apply --yes --plan "$plan_dir/plan.json"
    ;;
  deploy-git) railway up git --path-as-root --service git --detach ;;
  deploy-analytics) railway up analytics --path-as-root --service analytics --detach ;;
  *) echo "usage: $0 plan|apply|apply-analytics|apply-app-alerts|deploy-git|deploy-analytics|deploy-gateway|deploy-backup|deploy-monitor" >&2; exit 64 ;;
esac
