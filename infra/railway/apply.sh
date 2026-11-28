#!/bin/bash
# Plans or applies Runport's Railway project (.railway/railway.ts).
# Secrets live in the macOS Keychain (service "runport-prod"); missing ones
# are generated once. Usage: ./apply.sh plan | ./apply.sh apply
set -euo pipefail
cd "$(dirname "$0")"
SERVICE=runport-prod
production_project=c93df5f9-ac8b-453d-815a-e9fedd991ca1
production_environment=d95ac74a-26dc-4738-8765-3ab1389e057f
gateway_service=8c4bedd8-5d19-42e7-8f05-3289f4f8dff0

require_published_main() {
  local commit main
  commit=$(git rev-parse HEAD)
  main=$(gh api --hostname github.com repos/Ludvig-Hedin/runport/git/ref/heads/main --jq .object.sha)
  if [ "$commit" != "$main" ] || ! git diff --quiet HEAD -- "$@"; then
    echo "Use the published main commit with unmodified release tooling." >&2
    exit 1
  fi
  printf '%s\n' "$commit"
}

verify_app_alert_target() {
  railway status --json | bun -e 'import { assertAppAlertsTarget } from "./check-git-plan.ts"; assertAppAlertsTarget(JSON.parse(await Bun.stdin.text()));'
}

deploy_main_source() (
  if { [ "$1" = "bootstrap-gateway-storage" ] && [ "$#" -ne 2 ]; } ||
      { [ "$1" != "bootstrap-gateway-storage" ] && [ "$#" -ne 1 ]; }; then
    echo "usage: $0 bootstrap-gateway-storage /absolute/path/to/cutover-snapshot.sqlite, or deploy-gateway|prepare-gateway-storage|deploy-router|deploy-monitor|deploy-backup|deploy-git|deploy-analytics" >&2
    exit 64
  fi
  case "$1" in
    deploy-gateway) service=mail-gateway; source_path=infra/mail-gateway ;;
    bootstrap-gateway-storage) service=mail-gateway; source_path=infra/mail-gateway ;;
    prepare-gateway-storage) service=mail-gateway; source_path=infra/railway/mail-storage ;;
    deploy-router) service=router; source_path=infra/railway/router ;;
    deploy-git) service=git; source_path=infra/railway/git ;;
    deploy-analytics) service=analytics; source_path=infra/railway/analytics ;;
    deploy-monitor) service=monitor; source_path=infra/railway/ops ;;
    deploy-backup) service=backup; source_path=infra/railway/ops ;;
    *) exit 64 ;;
  esac
  commit=$(require_published_main apply.sh check-mail-storage.ts mail-storage-state.graphql)
  message="Runport $service $commit"
  if [ "$1" = "deploy-gateway" ]; then
    check_mail_storage mounted
    railway ssh --project "$production_project" --environment "$production_environment" \
      --service "$gateway_service" -- test -f /data/.runport-quota-cutover-ready
  elif [ "$1" = "prepare-gateway-storage" ]; then
    check_mail_storage mounted-stopped
  elif [ "$1" = "bootstrap-gateway-storage" ]; then
    check_mail_storage detached-stopped "$2"
    message="Runport bootstrap mail-gateway $commit"
  fi
  umask 077
  deploy_dir=$(mktemp -d)
  trap 'rm -r -- "$deploy_dir"' EXIT
  git -C ../.. archive "$commit:$source_path" | tar -xpf - -C "$deploy_dir"
  # Railway source uploads are separate from configuration plans. Pin both
  # the uploaded tree and the production target instead of using the link.
  railway up "$deploy_dir" --path-as-root --detach --message "$message" \
    --project "$production_project" --environment "$production_environment" --service "$service"
)

check_mail_storage() {
  railway api --file mail-storage-state.graphql --compact \
    --var "project=$production_project" --var "environment=$production_environment" | bun check-mail-storage.ts "$@"
}

merge_gateway_quota() (
  if [ "$#" -ne 2 ] || [ ! -f "$2" ]; then
    echo "usage: $0 merge-gateway-quota /absolute/path/to/uploaded-snapshot.sqlite" >&2
    exit 64
  fi
  require_published_main apply.sh check-mail-storage.ts mail-storage-state.graphql mail-storage/merge.ts >/dev/null
  check_mail_storage mounted
  snapshot_hash=$(shasum -a 256 <"$2" | cut -d' ' -f1)
  merge_hash=$(shasum -a 256 <mail-storage/merge.ts | cut -d' ' -f1)
  railway ssh --project "$production_project" --environment "$production_environment" --service "$gateway_service" -- sh -c "
    set -eu
    cd /tmp/runport-quota-cutover
    printf '%s  %s\n' '$snapshot_hash' overlay.sqlite '$merge_hash' merge.ts | sha256sum -c -
    if [ \"\$(id -u)\" -eq 0 ]; then
      exec su-exec bun bun merge.ts overlay.sqlite volume-before.sqlite
    fi
    test \"\$(id -un)\" = bun
    exec bun merge.ts overlay.sqlite volume-before.sqlite
  "
)

case "${1:-plan}" in
  deploy-gateway|bootstrap-gateway-storage|prepare-gateway-storage|deploy-router|deploy-monitor|deploy-backup|deploy-git|deploy-analytics) deploy_main_source "$@"; exit ;;
  merge-gateway-quota) merge_gateway_quota "$@"; exit ;;
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
export SD_APP_ALERT_MONITOR_KEY=$(bun -e 'import { createHmac } from "node:crypto"; process.stdout.write(createHmac("sha256", process.env.SD_MAIL_MASTER_KEY).update("runport-app-alerts:monitor").digest("hex"));')

case "${1:-plan}" in
  plan) railway config plan "${@:2}" ;;
  apply|apply-analytics|apply-app-alerts|apply-mail-storage)
    if [ "$1" = "apply-mail-storage" ]; then
      if [ "$#" -ne 2 ] || [ ! -f "$2" ]; then
        echo "usage: $0 apply-mail-storage /absolute/path/to/cutover-snapshot.sqlite" >&2; exit 64
      fi
    elif [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != "--no-op" ]; }; then
      echo "usage: $0 $1 [--no-op]" >&2; exit 64
    fi
    git diff --quiet HEAD -- .railway || { echo "Commit the Railway configuration before applying it." >&2; exit 1; }
    target_args=()
    if [ "$1" = "apply-app-alerts" ]; then
      require_published_main apply.sh check-git-plan.ts >/dev/null
      verify_app_alert_target
      target_args=(--environment "$production_environment")
    fi
    if [ "$1" = "apply-mail-storage" ]; then
      storage_commit=$(require_published_main apply.sh check-git-plan.ts check-mail-storage.ts mail-storage-state.graphql)
      check_mail_storage detached-bootstrapped "$2" "Runport bootstrap mail-gateway $storage_commit"
    fi
    umask 077
    plan_dir=$(mktemp -d)
    trap 'rm -f -- "$plan_dir/plan.json"; rmdir -- "$plan_dir"' EXIT
    # Let Railway use the same source hash here and at apply time. For this
    # nested configuration it hashes the directory instead of HEAD:.railway.
    # Bash 3 with nounset treats an empty array as unbound.
    railway config plan ${target_args[@]+"${target_args[@]}"} --out "$plan_dir/plan.json"
    if [ "$1" = "apply-analytics" ]; then
      bun check-git-plan.ts "$plan_dir/plan.json" --analytics "${@:2}"
    elif [ "$1" = "apply-app-alerts" ]; then
      bun check-git-plan.ts "$plan_dir/plan.json" --app-alerts "${@:2}"
      verify_app_alert_target
    elif [ "$1" = "apply-mail-storage" ]; then
      bun check-git-plan.ts "$plan_dir/plan.json" --mail-storage
      check_mail_storage detached-bootstrapped "$2" "Runport bootstrap mail-gateway $storage_commit"
    else
      bun check-git-plan.ts "$plan_dir/plan.json" "${@:2}"
    fi
    railway config apply ${target_args[@]+"${target_args[@]}"} --yes --plan "$plan_dir/plan.json"
    ;;
  *) echo "usage: $0 plan|apply|apply-analytics|apply-app-alerts|apply-mail-storage|bootstrap-gateway-storage|prepare-gateway-storage|merge-gateway-quota|deploy-git|deploy-analytics|deploy-gateway|deploy-router|deploy-backup|deploy-monitor" >&2; exit 64 ;;
esac
