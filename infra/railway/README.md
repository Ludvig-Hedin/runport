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
- `backup` runs nightly at 01:00 UTC: pg_dump to `backups/` in the bucket,
  kept 14 days. `monitor` runs every 5 minutes and emails
  ludvig@ludvighedin.com when the API, the gateway or the backup is wrong.
  Usage statistics are off, so there is no ClickHouse. Appwrite's
  cleanup (`appwrite-task-maintenance`) runs nightly at 01:30 UTC as a
  cron. There is no scheduler or interval task: they serve functions,
  messaging and Appwrite-managed domains, which Runport does not use.
- Owner login for the admin: Keychain `runport-prod` / `owner-email` and
  `owner-password`.
- Own addresses: `bun mcp/src/custom-domain.ts <domain> <service> <port>
  <folder>` registers the domain on Railway and creates its DNS records with
  the Keychain item `cloudflare-dns-token`. Without the token it stops
  before registering, because certificate attempts before DNS exists lock
  the name out at Let's Encrypt for an hour or more.
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
