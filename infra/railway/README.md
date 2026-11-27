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

Put an app online: `PLATFORM_KEYCHAIN_SERVICE=runport-prod
PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1
bun mcp/src/deploy-app.ts <slug>`. Each app gets its own Railway project, so
`apply.sh` never touches apps.

## App alerts

The router forwards authenticated registration and error reports to the
existing mail gateway. The gateway keeps counts and pending alerts in a
separate SQLite file beside its daily-cap database on `/data`. It sends plain
Swedish alerts to the owner's fixed address through the same delivery and
daily caps as app mail. No extra service is needed.

`deploy-app` registers the Railway web service using the local app registry.
New apps inherit server and browser reporting from the starter. Existing
apps need the reporting files copied into their source and a new deploy to
report code errors. Apps get separate budgets for server and browser errors,
each with up to 120 reports per minute and five new fingerprints per
Stockholm day. Repeated fingerprints increment the stored count. The
browser sends up to five distinct fingerprints per page. Once the gateway
attempts delivery, it avoids resending if the provider's reply is lost.

The five-minute check uses Railway deployment status for apps with Serverless
enabled, so the monitor never wakes them. It also checks the public service
address of always-on apps. A Railway API error leaves the last known app state
in place.

**Rollout prerequisite.** Land the other shared Railway changes first.
Wire `checkDeployedApps()` from `ops/app-alert-monitor.ts` into the existing
monitor after its platform checks, with `RUNPORT_ALERT_MONITOR_KEY` derived
by `monitorKey()` from the gateway master key and a dedicated Railway monitor
token in `RAILWAY_MONITOR_TOKEN`. The module can also be run directly with
`bun app-alert-monitor.ts` using those variables. Deploy the updated gateway
and router before provisioning app reporting. Back up the gateway's existing
SQLite data before rollout and compare the cap counts afterward.
