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

## Visitor analytics

The `analytics` service runs Umami on a loopback listener behind the Runport
gateway. Every public domain on the service reaches the gateway. It denies
the original collector and accepts `/runport/ingest` POSTs only with a
server-side credential matched to the event's website. It uses its own database and
login on the existing PostgreSQL server. The nightly job saves a separate
14-day dump under `backups/analytics-*.dump`. The five-minute monitor logs
analytics health and backup freshness.

For a first install, check `./apply.sh plan` and take a verified Appwrite
backup. On the linked Runport project, run `./setup-analytics.sh database`
before applying the configuration. Deploy `analytics` from `infra/railway/analytics`.
Wait for it to be healthy while it is still private, then run
`./setup-analytics.sh admin` and `./setup-analytics.sh provisioner`.
For an existing Runport installation, pass an existing Runport website UUID
to `provisioner` to transfer that site from the bootstrap admin. Verify the
provisioner can see the site and the default admin password is rejected before
adding `analytics.runport.app` through `mcp/src/custom-domain.ts`. Verify the
DNS token and put the CNAME in place first. Umami's admin password lives in
Keychain `runport-prod` / `analytics-admin-password`.

Deploy the `ops` directory to `backup` and `monitor` to activate the new checks.
For the gateway cutover on an existing production install, inspect the plan,
then use `./apply.sh apply-analytics`, `./apply.sh deploy-analytics`, and
`./apply.sh deploy-monitor` in that order. The analytics apply rejects Git
changes and accepts only the collector transition and analytics probe settings.
The monitor checks `GET /runport/ingest`, including a database read, without
recording an event. Analytics failures and recoveries use the monitor's
existing throttling and appear in its logs.

To verify an analytics backup restore, use an uploaded dump from a staging
fixture. Download it, verify its checksum, and pass it with the source counts
to `ops/verify-analytics-restore.sh`. The check uses a fresh local PostgreSQL
cluster reachable only through its temporary socket.

The online Runport tools provision one analytics site per app. Other Runport
installations can set `PLATFORM_ANALYTICS_URL`, `PLATFORM_ANALYTICS_USERNAME`,
`PLATFORM_ANALYTICS_PASSWORD`, and `PLATFORM_ANALYTICS_INGEST_SECRET` explicitly.
Use a non-admin Umami account. The ingestion secret is the gateway's
32-byte hex secret. Each app gets its own derived credential.

### Upgrade an existing app

Merge the starter's `app/visitor-analytics.tsx`, `app/runport-metrics/` and
`lib/analytics*.ts` into the app. Preserve custom code while copying these
files. Import `VisitorAnalytics` in the root `app/layout.tsx` and mount
`<VisitorAnalytics />` inside the body. If the app has a site lock, keep its
proxy in front of both metrics routes. Apply the starter's relative redirects
in `app/unlock/submit/route.ts` if the app still uses absolute unlock redirects.

Review the routes and custom events in `lib/analytics-policy.ts`, then redeploy
with `mcp/src/deploy-app.ts`. The deployment detects a missing integration
and reports that analytics was skipped.

Put an app online: `PLATFORM_KEYCHAIN_SERVICE=runport-prod
PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1
bun mcp/src/deploy-app.ts <slug>`. Each app gets its own Railway project, so
`apply.sh` never touches apps.

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
