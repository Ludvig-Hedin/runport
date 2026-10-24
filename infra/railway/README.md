# Sitedock on Railway

Project `sitedock` (Amsterdam). Public entry: the `router` service
(https://router-production-146b.up.railway.app): `/v1` is the Appwrite API,
`/_mail` the password-protected test inbox, everything else the admin.

- `.railway/railway.ts` describes every service, volume and the file bucket.
- `./apply.sh plan` previews, `./apply.sh apply` applies. Secrets come from the
  Keychain service `sitedock-prod` and are generated once if missing. Never
  run `railway config apply` directly: the SD_* secrets would be missing.
- `router`, `clickhouse` and `mail-gateway` are built from this repo:
  `railway up router --path-as-root --service router` (and the same for
  `clickhouse` and `../mail-gateway`).
- Owner login for the admin: Keychain `sitedock-prod` / `owner-email` and
  `owner-password`. Test inbox: user `ludvig`, password in `mailpit-password`.
- The encryption key (`openssl-key`) makes stored data readable. Losing it
  loses the data. Back it up outside this Mac.

Put an app online: `PLATFORM_KEYCHAIN_SERVICE=sitedock-prod
PLATFORM_APPWRITE_ENDPOINT=https://router-production-146b.up.railway.app/v1
bun mcp/src/deploy-app.ts <slug>`. Each app gets its own Railway project, so
`apply.sh` never touches apps.
