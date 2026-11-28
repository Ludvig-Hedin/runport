# This app

Next.js (App Router) + Appwrite, created by the `runport` tool. The backend
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

The app's private Git remote is on Runport Git or GitHub, as chosen at setup.

## How it is built

- **All Appwrite calls run on the server** (server components and server
  actions). Do not use the Appwrite web SDK in the browser.
- `lib/appwrite.ts`: `createSessionClient()` acts as the signed-in user, so row
  permissions apply. `createAdminClient()` has full project rights; use it only
  for sign-up, sign-in, setup and the private form submissions table.
- Sign-in: `lib/code-auth.ts` (email code), `lib/auth.ts` (password, reset,
  sign out), `lib/oauth.ts` + `app/auth/oauth/[state]/route.ts` (Google, GitHub).
  `lib/session.ts`: `getUser()` and the session cookie.
- **Auth screens are ready-made components** in `components/auth`, used like
  Clerk's: `<SignIn />`, `<SignUp />`, `<ForgotPassword />`,
  `<ResetPassword />`, `<SiteUnlock />`, `<UserButton />`, and
  `<SignedIn>` / `<SignedOut>` wrappers. Do not rebuild these screens; style
  them in `runport.config.ts`:
  - `appearance.variables`: colours (one value or `{ light, dark }`),
    `borderRadius`, `buttonRadius`, `fontFamily`.
  - `appearance.layout`: `logoUrl`, `socialButtonsPlacement` (`top` or
    `bottom`), `card` (`raised` or `flat`).
  - `appearance.elements`: extra Tailwind classes per part (`card`, `title`,
    `input`, `primaryButton`, `socialButton`, `userButtonAvatar`, …; the full
    list is `ELEMENTS` in `components/auth/appearance.ts`). They win over the
    built-in styles without `!`.
  - `appName` and `routes.afterSignIn` / `routes.afterSignOut`.
  Any component also takes an `appearance` prop for a one-off look.
- **Cookie consent** is built in (`components/consent`). No banner shows while
  `consent.categories` in `runport.config.ts` is empty, which is right for an
  app that only has its sign-in cookies. When you add something that sets
  other cookies (an ad pixel, a chat widget), add its category there and load
  it inside `<ConsentGate category="marketing">`, or check
  `useConsent("marketing")`. Put `<CookieSettingsLink />` in the footer.
- `proxy.ts` runs before every request: the site lock and the noindex header.
- `lib/rate-limit.ts` caps every sign-in and unlock step per email and visitor.
  The admin key skips Appwrite's own limits, so keep new auth actions behind
  `allowed()` too.
- Data uses Appwrite TablesDB. Tables are declared in `lib/schema.ts`. To add a
  table or column, add it there and run `bun run setup`.
- Mark a table `personal: true` in `lib/schema.ts` when each row belongs to
  one person. Setup adds an indexed `owner` column (and fills it for older
  rows that clearly have one owner). Set it on create with
  `...(await ownerData())` from `lib/owner.ts`, never from form input.
- Tables have row security on. A row created with the session client belongs
  to that user only. For shared data, pass explicit `permissions` to `createRow`.
- `app/items` is the example feature. Replace or rename it freely.
- **App error alerts** are enabled by `deploy-app`. Keep both instrumentation
  files, the grant in the root layout and the `/api/runport/error` route.
  Uncaught server render, route and action errors are grouped by code
  location. Admitted browser errors are counted in a daily summary.
  Only fixed error labels and a fingerprint reach Runport. Error messages,
  request URLs, headers, cookies and form data stay out of reports. Handled
  failures you convert into a response are outside Next.js error instrumentation.

## Switches (env vars)

All are read in `lib/config.ts`. Set them in `.env.local` locally or in the
host's variables, then restart or redeploy.

| Var | Default | Effect |
| --- | --- | --- |
| `AUTH_MODE` | `email-code` | `email-code`: /login emails a 6-digit code and creates new accounts; /signup redirects to /login. `password`: email + password with /signup, /forgot and /reset. |
| `AUTH_GOOGLE`, `AUTH_GITHUB` | off | `1` shows that button on /login. The platform sets the provider keys in Appwrite. |
| `APP_URL` | `http://localhost:$PORT` | Public address for OAuth and reset links. Its host must be a platform in the Appwrite project. |
| `SITE_PASSWORD` | unset | Locks every page behind /unlock. Changing it signs every visitor out of the lock. |
| `ALLOW_INDEXING` | off | `1` lets search engines index the site, but only when `RAILWAY_ENVIRONMENT_NAME` is unset or `production` and the site is not locked. Public pages opt in with `pageMetadata()`. In preview or lock mode the sitemap is empty, robots.txt disallows crawling, and responses carry a noindex header. |
| `RUNPORT_ERROR_URL`, `RUNPORT_ERROR_TOKEN` | unset | Server-only settings added by Runport on deployment. Leave them unset in local development. |
| `ANALYTICS_URL`, `ANALYTICS_SITE_ID`, `ANALYTICS_INGEST_TOKEN` | unset | Runport sets these for hosted apps. All three enable visitor analytics on production builds, excluding Railway preview environments. Keep the per-site token on the server. |

## Public forms

The starter includes a public `/contact` page. To place its form on another page:

```tsx
import { ContactForm, PublicForm } from "@/components/forms";

<ContactForm />
<PublicForm id="feedback" fields={[
  { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
  { name: "feedback", label: "Feedback", type: "textarea", required: true },
]} />
```

Pass `fields` to `ContactForm` to replace its name, email and message fields.
Use one stable ID per form. Both components use the same `appearance` as sign-in
and accept their own `appearance` prop. A rejected submission keeps the filled
fields. A saved submission clears them.

Setup creates the server-only `main/form_submissions` table. Each row stores the
form ID, JSON payload and notification status. A saved message is acknowledged
even if the gateway is unavailable or reaches its separate form mail budget.
In Appwrite, filter the table by `notification = capped` to find messages saved
after that budget was exhausted. Other statuses are `sent`, `failed`,
`unconfigured`, and `pending` after an interrupted request. Replaying the
same signed submission creates one row and one email.

Runport provisions `RUNPORT_FORM_OWNER_EMAIL`, `RUNPORT_FORM_MAIL_URL`,
`RUNPORT_FORM_MAIL_APP`, `RUNPORT_FORM_MAIL_FROM` and a recipient-bound
`RUNPORT_FORM_MAIL_TOKEN`. Set `PLATFORM_FORM_OWNER_EMAIL` before creating or
deploying the app to select the owner inbox. If the app already has a different
`RUNPORT_FORM_OWNER_EMAIL` override on the host, the deploy tool keeps it and
issues a matching token. Visitor addresses are saved as fields only.

The built-in spam checks use a hidden field, a signed timer, simple content
checks and per-IP and per-email limits for one server process. IPv6 addresses
share one rate limit per /64. For optional
Cloudflare Turnstile, set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
Its script loads only on pages with a form when a site key is set.

## Search and sharing

1. Set `APP_URL` to the canonical origin and write the site description in
   `runport.config.ts`. Set `ALLOW_INDEXING=1` when the public production site
   is ready. Preview deployments and locked sites stay out of search.
2. Put public pages in `app/(public)`. Routes keep the same URL. Static
   pages in that group appear in `/sitemap.xml` on the next build and inherit
   the site's indexing switch.
3. Set page-specific metadata when you want its own canonical URL, title or
   description. The title gets the app name as a
   suffix and the description falls back to `seo.description`.

   ```tsx
   import { pageMetadata } from "@/lib/seo";

   export const generateMetadata = () =>
     pageMetadata({ title: "About", path: "/about", description: "Who we are." });
   ```

4. List individual URLs for dynamic pages in `lib/sitemap-urls.ts`. The async
   `additionalSitemapUrls()` function can query Appwrite and return `[{ path: "/posts/hello", lastModified: "2026-11-27" }]`.
   Only include published pages. This callback runs on sitemap requests while
   indexing is on. Keep private or individually noindex pages out of `(public)`
   and the callback.
5. Render `<WebsiteJsonLd />` from `@/components/seo/json-ld` on your public
   homepage. Set `seo.organization` to add the publisher. Use `<JsonLd data={…} />`
   for other structured data.

The /opengraph-image route renders a 1200 × 630 image using `appName` and the
light appearance colours. The Open Graph and Twitter card tags use it by default.
The app icon and Apple touch icon use the same initial and colours.

## Visitor analytics

Pageviews go to Runport's Umami through this app's own domain. The tracker
uses no cookies, skips visitors with Do Not Track or Global Privacy Control
enabled, and excludes page titles, URL query strings and fragments. A locked
site starts tracking after the visitor unlocks it. Leave any analytics variable
unset to disable tracking. Add public routes to `lib/analytics-policy.ts`.
Use `/items/[id]` for dynamic paths so actual IDs are excluded.

For a custom event, call `track("filter-applied", { filter: "open" })` in a
client component using `import { track } from "@/lib/analytics"`. First add
`"filter-applied": { filter: ["open", "all"] }` to `events` in that policy.
Unknown event names, fields, and values are discarded.

## Account deletion

People can close their account from the account page. Runport resumes
unfinished deletions every five minutes on deployed apps. For a deployment
outside Runport, set a server-only `RUNPORT_ACCOUNT_MAINTENANCE_KEY` and have
the scheduler send authenticated POSTs to `/api/runport/account-maintenance`.
Run `bun run setup` to create the queue and resume unfinished work.

Add a table to `lib/schema.ts` with `personal: true` when its rows should
be considered for deletion. A row is eligible only when its owner column
and all its permission roles name the person closing the account.

## Appwrite MCP

If `.mcp.json` exists, the Appwrite MCP server is scoped to this app's project
only. Use it to inspect tables, rows and users.

## Rules

- Keep the app's own cookie auth. It works when the app and Appwrite are on
  different domains.
- Check `bun run typecheck` and `bun run build` before saying something works.
