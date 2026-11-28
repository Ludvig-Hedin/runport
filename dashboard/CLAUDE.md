# Runport dashboard

Runport's own start page at https://dash.runport.app: every app with its
status, visitors, cost, last deploy and repo, plus Runport's cost against the
$20 plan minimum, the last nightly backup and platform health. Pause, resume
and delete per app. It is a Runport app itself, built from
`templates/nextjs-appwrite`, so the starter's rules below still apply.

## Who gets in

Only emails in `DASHBOARD_OWNER_EMAILS` (comma-separated). Sign-in is the
email code only: `lib/config.ts` forces it, `lib/code-auth.ts` sends no code
to other addresses (they see `/no-access`), and `lib/owner.ts` checks every
page and every `/api/apps/*` route. The dashboard's Appwrite project has
password, magic link, phone, invite and anonymous sign-in turned off.

## Where the data comes from (all on the server)

| What | Source | File |
| --- | --- | --- |
| Apps, status, deploy time, cost, pause, delete hosting | Railway GraphQL, workspace token `RAILWAY_API_TOKEN` | `lib/server/railway.ts` |
| Last backup | the `backup` job's own log lines on Railway | `lib/server/railway.ts` |
| Visitors | Umami at `ANALYTICS_URL`, admin login `ANALYTICS_ADMIN_PASSWORD` | `lib/server/analytics.ts` |
| App names, delete users/data/files | Appwrite console, `APPWRITE_CONSOLE_EMAIL` / `_PASSWORD` | `lib/server/appwrite-console.ts` |
| Backup before delete | the app's own key (from its Railway variables) → this project's `app-backups` bucket | `lib/server/app-data.ts` |
| Repo links | `apps` table, filled from the Mac's app list by `bun run sync-apps` | `scripts/sync-apps.ts` |

A Railway project counts as an app only when it is `<slug>-app` with a `web`
service pointing at this Runport's Appwrite with project `<slug>`
(`toRunportApp`). Actions never touch anything else, the `runport` project or
the dashboard itself.

## Delete

`app/api/apps/[slug]/delete/route.ts` streams its steps as JSON lines:
backup (users, rows, files copied into `app-backups`, plus a manifest
`<slug>-<time>.json`), check (read back and compare counts and file sizes),
delete the Appwrite project, delete the Railway project, then a row in
`deletions`. Nothing is deleted when the backup or its check fails. The repo,
the folder on the Mac and the visitor stats are kept.

## Deploy

From `mcp/`: `PLATFORM_KEYCHAIN_SERVICE=runport-prod
PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1 bun src/deploy-dashboard.ts`.
It creates or reuses the Railway project `runport-dashboard`, the Appwrite
project `dashboard`, tables and bucket, and sets every variable from Keychain
`runport-prod` through Railway's API. The Railway token must be made by a
person (Railway account settings > Tokens, workspace token) and stored as
`dashboard-railway-token` in that Keychain service.

## Rules

- Never print or log a token or key. `logFailure` logs only error messages.
- Keep the look in `components/dashboard/dashboard.css` and the tokens in
  `app/globals.css` (house style, light and dark).
- Check `bun run typecheck` before deploying.
