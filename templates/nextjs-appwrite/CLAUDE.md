# This app

Next.js (App Router) + Appwrite, created by the `sitedock` tool. The backend
(accounts, database, files) is an Appwrite project that already exists. Do not
sign up for other services for accounts or data.

## Run

```bash
bun install
bun run setup   # creates missing tables from lib/schema.ts, safe to rerun
bun run dev     # the port is in .env.local as PORT when the platform started it
```

`.env.local` holds `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` and
`APPWRITE_API_KEY`. It is gitignored. Never commit it or print the key.

## How it is built

- **All Appwrite calls run on the server** (server components and server
  actions). Do not use the Appwrite web SDK in the browser.
- `lib/appwrite.ts`: `createSessionClient()` acts as the signed-in user, so row
  permissions apply. `createAdminClient()` has full project rights; use it only
  for sign-up, sign-in and setup.
- Sign-in: `lib/code-auth.ts` (email code), `lib/auth.ts` (password, reset,
  sign out), `lib/oauth.ts` + `app/auth/oauth/[state]/route.ts` (Google, GitHub).
  `lib/session.ts`: `getUser()` and the session cookie.
- `proxy.ts` runs before every request: the site lock and the noindex header.
- `lib/rate-limit.ts` caps every sign-in and unlock step per email and visitor.
  The admin key skips Appwrite's own limits, so keep new auth actions behind
  `allowed()` too.
- Data uses Appwrite TablesDB. Tables are declared in `lib/schema.ts`. To add a
  table or column, add it there and run `bun run setup`.
- Tables have row security on. A row created with the session client belongs
  to that user only. For shared data, pass explicit `permissions` to `createRow`.
- `app/items` is the example feature. Replace or rename it freely.

## Switches (env vars)

All are read in `lib/config.ts`. Set them in `.env.local` locally or in the
host's variables, then restart or redeploy.

| Var | Default | Effect |
| --- | --- | --- |
| `AUTH_MODE` | `email-code` | `email-code`: /login emails a 6-digit code and creates new accounts; /signup redirects to /login. `password`: email + password with /signup, /forgot and /reset. |
| `AUTH_GOOGLE`, `AUTH_GITHUB` | off | `1` shows that button on /login. The platform sets the provider keys in Appwrite. |
| `APP_URL` | `http://localhost:$PORT` | Public address for OAuth and reset links. Its host must be a platform in the Appwrite project. |
| `SITE_PASSWORD` | unset | Locks every page behind /unlock. Changing it signs every visitor out of the lock. |
| `ALLOW_INDEXING` | off | `1` lets search engines index the site, but only when `RAILWAY_ENVIRONMENT_NAME` is unset or `production` and the site is not locked. Otherwise robots.txt, the meta tag and an `X-Robots-Tag` header say noindex. |

## Appwrite MCP

If `.mcp.json` exists, the Appwrite MCP server is scoped to this app's project
only. Use it to inspect tables, rows and users.

## Rules

- Keep the app's own cookie auth. It works when the app and Appwrite are on
  different domains.
- Check `bun run typecheck` and `bun run build` before saying something works.
