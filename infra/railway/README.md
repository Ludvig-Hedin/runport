# Runport on Railway

Project `runport` (Amsterdam). Public entry: the `router` service
at https://admin.runport.app (also
https://router-production-146b.up.railway.app): `/v1` is the Appwrite API, everything
else the admin. The admin sleeps when idle; the router waits for it to wake.

- `.railway/railway.ts` describes every service, volume and the file bucket.
- `./apply.sh plan` previews, `./apply.sh apply` applies. Secrets come from the
  Keychain service `runport-prod` and are generated once if missing. Never
  run `railway config apply` directly: the SD_* secrets would be missing.
- `router`, `mail-gateway`, `backup` and `monitor` are built from this repo:
  `railway up router --path-as-root --service router`, `../mail-gateway`
  for the gateway, `ops` for both `backup` and `monitor`.
- Mail: the gateway posts to the `runport-mail` Worker
  (`infra/cloudflare-mail`, deploy with `bunx wrangler deploy`), which sends
  with Cloudflare Email Sending from runport.app (apps.ludvighedin.com still allowed). Transactional mail
  only; newsletters need another path.
- `backup` runs nightly at 01:00 UTC. It stores Appwrite and analytics database
  dumps and a Forgejo volume archive under `backups/` for 14 days. It
  prunes each set of archives after verifying that night's copy and keeps
  its newest good copy.
  `monitor` runs every five minutes and emails ludvig@ludvighedin.com
  when a service is down or a backup is stale.
  Usage statistics are off, so there is no ClickHouse. Appwrite's
  cleanup (`appwrite-task-maintenance`) runs nightly at 01:30 UTC as a
  cron. There is no scheduler or interval task: they serve functions,
  messaging and Appwrite-managed domains, which Runport does not use.
- Owner login for the admin: Keychain `runport-prod` / `owner-email` and
  `owner-password`.
- Own addresses: `bun mcp/src/custom-domain.ts <domain> <service> <port>
  <folder>` uses the Keychain item `cloudflare-dns-token` to publish the
  service's routing CNAME before registering the domain. It then applies
  the exact CNAME and verification TXT that Railway returns.
- The encryption key (`openssl-key`) makes stored data readable. Losing it
  loses the data. Back it up outside this Mac.

Put an app online: `PLATFORM_KEYCHAIN_SERVICE=runport-prod
PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1
bun mcp/src/deploy-app.ts <slug>`. Each app gets its own Railway project, so
`apply.sh` never touches apps.

## App alerts

The router forwards authenticated registration and error reports to the
existing mail gateway. The gateway keeps counts and pending alerts in a
separate SQLite file beside its daily-cap database on `/data`. It sends plain
Swedish alerts to the single owner account set by `ALERT_TO` in the gateway.
Without a valid address, app alerts are disabled and ordinary mail keeps
working. Alerts have daily limits of four per app and 30 across Runport,
within the gateway's total cap. By default, ten percent of the total cap is
reserved for Appwrite account mail. No extra service is needed.

`deploy-app` registers the Railway web service using the local app registry.
New apps inherit server and browser reporting from the starter. Existing
apps need the reporting files copied into their source and a new deploy to
report code errors. Redeploying also switches the app's Appwrite account
mail to the separate login credential. Per app, the gateway allows 120
reports per minute each for server and browser errors. It accepts up to five
new server fingerprints per Stockholm day and counts repeats for 30 days.
Browser reports require a signed page grant and are limited per visitor and
app before forwarding. The gateway accepts up to 300 browser reports per
minute across all apps and sends one digest for the previous Stockholm day.
It retries confirmed temporary refusals with backoff and avoids resending
when delivery is uncertain. Queued alerts stay with their original Railway
registration when a slug is reused.

The five-minute job rotates through up to 20 apps per run. It checks Railway
deployment and instance state and probes each running app's public URL.
A confirmed sleeper stays asleep unless an open incident needs a verified
recovery. The probe allows a second attempt after a cold start. Outages
can send one notice and its recovery per one-hour incident window. Deleting
an app from the registry or confirming the service is gone in Railway retires
its alerts. Railway can return the same error for missing and inaccessible
services, so the monitor confirms absence from the authorized environment's
service listing. API errors preserve the last known state. A Railway rate
limit pauses checks for the retry delay.

The schema contract test takes Railway's published schema file.

```sh
(cd infra/railway/ops && bun install --frozen-lockfile)
mkdir -p output/app-alerts-schema
curl -fsSL https://raw.githubusercontent.com/railwayapp/cli/1e9b3663192e097a499471f932e0dcd29e8b2e07/src/gql/schema.json -o output/app-alerts-schema/railway-schema.json
RAILWAY_CLI_SCHEMA="$PWD/output/app-alerts-schema/railway-schema.json" bun test infra/railway/ops/test/app-alert-schema.test.ts
```

**Rollout prerequisite.** Land the other shared Railway changes first.
Wire `checkDeployedApps()` from `ops/app-alert-monitor.ts` into the existing
monitor after its platform checks, with `RUNPORT_ALERT_MONITOR_KEY` derived
by `monitorKey()` from the gateway master key and a dedicated Railway monitor
token in `RAILWAY_MONITOR_TOKEN`. The module can also be run directly with
`bun app-alert-monitor.ts` using those variables. Deploy the updated gateway
and router before provisioning app reporting. Set the gateway's `ALERT_TO`
to the same owner address configured in the platform monitor. Back up the
gateway's existing SQLite data before rollout and compare the cap counts
afterward.

## Runport Git

Forgejo runs with SQLite on a 2 GB volume. Railway serves HTTPS at
`git.runport.app` and only routes to port 3000. Accounts are owner-created
and repositories are private. Git Actions and SSH are disabled.
The service stays awake so the five-minute monitor can probe it and Git
clients can connect on their first request.

Use `./apply.sh plan` and `./apply.sh apply` to configure the Git service.
The apply command checks a pinned plan and allows only Git, its new volume,
and the Git settings for the backup and monitor jobs. Use `./apply.sh apply
--no-op` to verify that Railway accepts the saved plan when there are no
changes. The apply command leaves ownership of an unchanged plan alone.
Review the plan first,
then `./apply.sh deploy-git` to upload its image build. When HTTPS and the
private backup endpoint work, run `./apply.sh deploy-backup`. Wait for the
first Git archive before running `./apply.sh deploy-monitor`.
Create a dedicated Forgejo user without administrator privileges. Store
its password as `git-provision-password` and its access token as
`git-provision-token` under the `runport-prod` Keychain service. Give the
provisioning token `write:user` and `write:repository` scopes so the MCP
can create private repositories. The MCP uses the password to mint a separate
`write:repository` token scoped to each repository and stores only that token
with Git's macOS credential helper.

For a custom `PLATFORM_GIT_URL`, explicitly set
`PLATFORM_GIT_KEYCHAIN_SERVICE` and append `@<HTTPS origin>` to the two
Keychain account names. The production credential names are used only for
`https://git.runport.app`. The private backup endpoint uses its own
`git-backup-token`, which `apply.sh` creates once.

Each archive has `gitea/` (including config and SQLite) and `git/`
(including repositories). The backup helper briefly stops Forgejo to capture
one consistent copy and restarts it before sending the archive. The monitor
skips the Git HTTP check during that maintenance window and still checks
backup freshness.

Verify a restore by extracting the archive into an empty, isolated
directory. Run `sqlite3 <copy>/gitea/forgejo.db 'PRAGMA integrity_check;'`
and `git --git-dir=<copied-repository> fsck --full` before starting
a throwaway Forgejo instance on the copy. Treat the archive as sensitive.
To recover the service, stop Forgejo and restore those two directories to
a fresh volume mounted at `/data`, preserving file ownership. Keep the
previous volume until the restored service passes its checks.
