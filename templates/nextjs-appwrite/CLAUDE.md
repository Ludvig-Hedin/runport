# This app

Next.js (App Router) + Appwrite, created by the `platform` tool. The backend
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
- `lib/auth.ts`: sign up, sign in, sign out as server actions.
  `lib/session.ts`: `getUser()`.
- Data uses Appwrite TablesDB. Tables are declared in `lib/schema.ts`. To add a
  table or column, add it there and run `bun run setup`.
- Tables have row security on. A row created with the session client belongs
  to that user only. For shared data, pass explicit `permissions` to `createRow`.
- `app/items` is the example feature. Replace or rename it freely.

## Appwrite MCP

If `.mcp.json` exists, the Appwrite MCP server is scoped to this app's project
only. Use it to inspect tables, rows and users.

## Rules

- Keep the app's own cookie auth. It works when the app and Appwrite are on
  different domains.
- Check `bun run typecheck` and `bun run build` before saying something works.
