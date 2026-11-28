# Runport on Railway

Project `runport` (Amsterdam). Public entry: the `router` service
at https://admin.runport.app (also
https://router-production-146b.up.railway.app): `/v1` is the Appwrite API, everything
else the admin. The admin sleeps when idle; the router waits for it to wake.

- `.railway/railway.ts` describes every service, volume and the file bucket.
- `./apply.sh plan` previews, `./apply.sh apply` applies. Secrets come from the
  Keychain service `runport-prod` and are generated once if missing. Never
  run `railway config apply` directly: the SD_* secrets would be missing.
- `./apply.sh deploy-router`, `deploy-gateway`, `deploy-backup` and
  `deploy-monitor` upload the corresponding committed source from
  published `main` to production.
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

To add analytics for the first time, start with a linked Runport project
whose PostgreSQL, backup, monitor, and other base services are already in
place. Analytics uses the existing PostgreSQL volume. Run `./apply.sh plan`
and check that it only creates `analytics` and sets the analytics variables
on the shared jobs. Take a verified Appwrite backup and run
`./setup-analytics.sh database`, then use `./apply.sh apply-analytics` and
`./apply.sh deploy-analytics`.
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
recording an event. It logs analytics failures and stale backups. When the
configured recipient is `ludvig@ludvighedin.com`, it emails him once per
incident and once on recovery.

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
It retries explicit temporary refusals with backoff. Unrecognized replies
and lost delivery acknowledgements stay charged and deduplicated.
Permanent owner-address refusals are logged as failures and surfaced by
the monitor. Queued alerts stay with their original Railway registration
when a slug is reused.

`deploy-app` installs a project webhook with the local Railway CLI login.
Railway authenticates deliveries with a write-only header derived for that
app, project, environment, service and registration. Redeploys reuse an
existing registration. Retiring an app and registering it again rotates
the header and the webhook binding. The gateway stores only event state.
Railway delivery is best effort and may be out of
order. [Railway webhooks](https://docs.railway.com/observability/webhooks)

A crash, failed deployment or removal queues a public health check. The
gateway confirms an unsuccessful probe after at least a minute before opening
an incident. It ignores sleep events and removals
of superseded deployments. A deployment or restart can close an incident
after the app responds. The five-minute monitor processes pending checks and
delivers queued owner mail independently of platform checks. Each outage
window still allows one incident and one recovery. An app without a webhook
has no outage monitoring. Removing an app from the registry disables its
receiver. The Railway CLI login can create and list webhook rules. Editing or
removing an existing Railway rule requires dashboard access.

Back up the gateway data before applying the rollout. Run
`./apply.sh deploy-gateway` and `./apply.sh deploy-router` from published main.
Use `./apply.sh apply-app-alerts` to set the pinned gateway owner address and
the internal monitor key. The command verifies the linked project and pins
the plan and apply to Runport production. Registration is disabled until
the gateway has its owner address. Once the gateway is healthy, backfill the
two existing apps from their linked Railway projects. Supply the independently
verified project and production environment IDs for each app:

```sh
PLATFORM_KEYCHAIN_SERVICE=runport-prod bun mcp/src/backfill-app-alerts.ts \
  "todo:${TODO_PROJECT_ID}:${TODO_PRODUCTION_ENVIRONMENT_ID}" \
  "auth-preview:${AUTH_PREVIEW_PROJECT_ID}:${AUTH_PREVIEW_PRODUCTION_ENVIRONMENT_ID}"
```

Then run `./apply.sh deploy-monitor` from published main. Production needs no
Railway credential for monitoring. The backfill verifies the linked project and its production Railway domain,
backs up the local registry, and adds the project webhooks without rebuilding
the apps. It preserves account maintenance enrolment. When rolling out both
features, deploy the gateway that supports both app registrations before
running the backfill or the combined monitor.

### Gateway storage cutover

Run the cutover from published main with a short mail maintenance window.
Railway mounts volumes at runtime, so the existing overlay database must be
copied before attaching the disk.

1. Use a private local directory for the snapshots. Copy
   `mail-storage/snapshot.ts` to a temporary path in the running gateway and
   run it with Bun. It emits one private JSON line with the SQLite copy,
   row count and checksum. Extract the copy and validate its checksum and
   integrity before stopping the old deployment. The gateway can serve while
   snapshots are taken. Quotas can start low during the short serving window
   before the merge. The higher count for each key in the backed-up and live
   databases is kept.
2. With the old deployment stopped, run
   `./apply.sh bootstrap-gateway-storage /absolute/path/to/cutover-snapshot.sqlite`.
   Verify the gateway's health on the detached filesystem. The bootstrap image
   prepares file ownership at startup and then runs the gateway as `bun`.
   Take another snapshot and stop the bootstrap deployment. Keep both
   overlay snapshots. If the bootstrap received traffic, combine the two
   snapshots in a scratch database using `mergeQuotas` so the higher counter
   for each key goes into the final snapshot.
3. Run `./apply.sh apply-mail-storage /absolute/path/to/cutover-snapshot.sqlite`
   with the verified snapshot. This production-only pinned plan attaches only
   the existing `mail-gateway-data` volume at `/data`. It requires the
   stopped bootstrap from the same published main commit. Railway
   automatically redeploys that source with the attached volume. Check
   health and inspect the mount and its database as `bun`. Export a private
   backup of existing volume contents before the merge. Use SQLite snapshots
   for databases that are open, and verify checksums and integrity.
4. Copy the checked overlay snapshot and `mail-storage/merge.ts` to a private
   directory on the gateway, named `/tmp/runport-quota-cutover` and owned by
   `bun`. Save the snapshot as `overlay.sqlite` and the script as `merge.ts`.
   Run `./apply.sh merge-gateway-quota /absolute/path/to/cutover-snapshot.sqlite`.
   It checks the uploaded files' hashes, backs up the volume's quota database
   as `volume-before.sqlite`, merges the higher count for each key, checks
   integrity and counts, and writes the readiness receipt. Export the
   destination snapshot. Check for zero missing keys from either input.
5. Run `./apply.sh deploy-gateway` to start the gateway. This refuses to upload
   unless the correct volume is attached and reachable with the readiness
   receipt. Check `/health` and compare the post-start quota database against
   the snapshots. Then use `./apply.sh deploy-router` and
   `./apply.sh deploy-monitor` for the other source deployments.

If the mounted bootstrap exits, stop the failed deployment and use
`./apply.sh prepare-gateway-storage` to get a maintenance container with no
listeners. Inspect and back up the volume before fixing ownership or
restoring quota state. Continue with the same guarded merge and deployment.

If the quota merge fails, keep the overlay and volume backups, leave the
gateway on the mounted bootstrap, and inspect the reported error. Correct
the file transfer, checksums, ownership or SQLite input before retrying the
same guarded merge. If the command was interrupted after publishing a
complete backup, move that backup to private storage before retrying. Never
remove the serving database to retry the merge. Continue once its SQLite
integrity and both comparisons pass and the merge receipt exists.

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
