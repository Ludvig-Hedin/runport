#!/bin/bash
# Initial installation only. Take a verified Appwrite backup first.
set -euo pipefail
cd "$(dirname "$0")"
SERVICE=runport-prod

get() { security find-generic-password -s "$SERVICE" -a "$1" -w 2>/dev/null; }
psql_railway() {
  local database=$1
  local -a args=(--service postgresql --environment production)
  if [ -n "${RAILWAY_SSH_IDENTITY:-}" ]; then args+=(--identity-file "$RAILWAY_SSH_IDENTITY"); fi
  railway ssh "${args[@]}" -- sh -c 'psql -X -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -f -' sh "$database"
}

case "${1:-}" in
  database)
    # Match the schema permissions on PG15+; never change Appwrite ACLs.
    password=$(get analytics-db-password)
    [[ "$password" =~ ^[a-f0-9]{64}$ ]] || exit 1
    {
      printf '%s\n' "\set analytics_password '$password'"
      cat <<'SQL'
SELECT NOT EXISTS (
  SELECT FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND acl.grantee = 0 AND acl.privilege_type = 'CREATE'
) AND NOT EXISTS (
  SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND acl.grantee = 0
    -- Appwrite's bundled PostGIS grants reads on its filtered catalog views
    -- and the standard spatial reference table. These contain no app rows.
    AND NOT (acl.privilege_type = 'SELECT' AND n.nspname = 'public'
      AND c.relname IN ('geography_columns', 'geometry_columns', 'spatial_ref_sys')
      AND EXISTS (
        SELECT FROM pg_depend d JOIN pg_extension x ON x.oid = d.refobjid
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND d.deptype = 'e' AND x.extname = 'postgis'
      ))
) AND NOT EXISTS (
  SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosecdef AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
) AS safe \gset
\if :safe
  CREATE ROLE runport_analytics LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD :'analytics_password';
  CREATE DATABASE runport_analytics OWNER runport_analytics;
\else
  DO $$ BEGIN RAISE EXCEPTION 'Appwrite grants database objects to PUBLIC'; END $$;
\endif
SQL
    } | psql_railway appwrite
    ;;
  admin)
    if ! get analytics-admin-password >/dev/null; then
      security add-generic-password -s "$SERVICE" -a analytics-admin-password -w "$(openssl rand -hex 32)"
    fi
    hash=$(get analytics-admin-password | bun -e 'console.log(await Bun.password.hash((await Bun.stdin.text()).trim(), { algorithm: "bcrypt", cost: 12 }))')
    {
      printf '%s\n' "\set new_admin_hash '$hash'"
      cat <<'SQL'
UPDATE "user" SET password = :'new_admin_hash'
WHERE username = 'admin' AND role = 'admin'
  AND password = '$2b$10$BUli0c.muyCW1ErNJc3jL.vFRFtFJWrT8/GcR4A.sUdCznaXiqFXa';
SQL
    } | psql_railway runport_analytics
    ;;
  *) echo "usage: $0 database|admin" >&2; exit 64 ;;
esac
