# Runport dashboard

Runport's own start page at https://dash.runport.app: every app with its
status, visitors, cost, last deploy and repo, plus Runport's cost against the
$20 plan minimum, the last nightly backup and platform health. Pause, resume
and delete per app. It is a Runport app itself, built from
`templates/nextjs-appwrite`, so the starter's rules still apply.

## Who gets in

Only verified emails in `DASHBOARD_OWNER_EMAILS` (`lib/owner-rules.ts`).
Sign-in is the email code only: `lib/config.ts` forces it, `lib/code-auth.ts`
sends no code to other addresses (they see `/no-access`), and `lib/owner.ts`
checks every page and every `/api/apps/*` route. Writes must come from the
exact `APP_URL` origin. The dashboard's Appwrite project has password, magic
link, phone, invite and anonymous sign-in turned off.

## Which apps it may touch

Only apps pinned in its `apps` table, which `mcp/src/sync-dashboard.ts`
fills from the Mac's app registry: Railway workspace, project, environment
and service ids plus the Appwrite project id, read from each app folder's
own Railway link and checked with Railway. At runtime `lib/ops/pins.ts`
checks the pins against Railway again; a mismatch or a duplicate shows
"Needs a check" and turns actions off. Names found on Railway are never
trusted on their own.

## Credentials (server only)

| What | Variable | Scope |
| --- | --- | --- |
| Railway | `RAILWAY_API_TOKEN` | workspace token, made by the owner in Railway; acts only on pinned ids |
| Per app Appwrite | `RUNPORT_APP_KEYS` | per app: a read key, and a `project.write` key used only after a verified backup |
| Visitors | `ANALYTICS_USERNAME` / `ANALYTICS_PASSWORD` | Umami view-only account in the "Runport sites" team |
| Own data | `APPWRITE_API_KEY` | the dashboard's own project |

No Appwrite console password and no Umami admin password at runtime.

## Delete (lib/ops)

`delete-flow.ts` is the order, with no I/O of its own (tested in
`test/delete-flow.test.ts`). A row in `deletions` keyed by the Railway
project id is both the lock and the saved progress:

1. refuse what the backup cannot restore: teams, functions, unknown column
   or password-hash types, files over 30 MB, other Railway services,
   environments or volumes (`backup.ts`, `pins.ts`);
2. stop the hosting (`hosting.ts`, confirmed), save which Appwrite client
   services are on, switch them off (server keys can still read);
3. back up users with password hashes, tables with columns, indexes and
   rows, and every file, into the private `app-backups` bucket, then read it
   all back and compare SHA-256 checksums;
4. save the verified backup id and checksum, then delete the Appwrite
   project, then the Railway project.

A failure before step 4 switches back on only the services that were on,
restarts the app if it was running, and marks the row "aborted". A retry
after step 4 re-checks the saved backup before continuing. Prove a backup
restores with `mcp/src/restore-app-backup.ts <backup name>` (into a new,
separate project, deleted again afterwards).

## Pause

`hosting.ts` stops the deployment that is actually serving (a sleeping one
cannot be stopped, so it is removed), waits until Railway confirms nothing
serves, and remembers that deployment in `app_state`; resume starts exactly
that one again.

## Deploy and test

- Deploy: from `mcp/`, `PLATFORM_KEYCHAIN_SERVICE=runport-prod
  PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1 bun src/deploy-dashboard.ts`.
  Targets are pinned in `runport.deploy.json` and checked first. `--keys=`
  limits which apps get new per-app keys (default all).
- Tests: `bun run test` (isolated fakes). Live end-to-end on real services
  only with the throwaway app from `mcp/src/dashboard-fixture.ts`.
- `bun run typecheck` before deploying.
