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
app before forwarding. They feed one digest for the previous Stockholm day.
The gateway retries confirmed temporary refusals with backoff and avoids
resending when delivery is uncertain.

The five-minute job rotates through up to 20 apps per run. It checks Railway
deployment and instance state and probes each running app's public URL.
A confirmed sleeper stays asleep unless an open incident needs a verified
recovery. The probe allows a second attempt after a cold start. Outages
can send one notice and its recovery per one-hour incident window. Deleting
an app from the registry or confirming the service is gone in Railway retires
its alerts. API errors preserve the last known state. A Railway rate limit
pauses checks for the retry delay.

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
