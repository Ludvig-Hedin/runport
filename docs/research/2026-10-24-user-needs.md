# What real apps and websites need before the platform is ready

Research date: 2026-10-24. Scope: what solo builders, indie hackers and small
agencies need from Vercel, Clerk, Convex and Resend, plus what they complain
about in self-hosted options (Supabase, Coolify, Dokploy, Appwrite, PocketBase).
Measured against this platform: self-hosted Appwrite 2.6.1, apps on Railway
(planned), mail gateway with daily caps in front of Amazon SES, and the
`create_app` MCP tool.

"Unverified" means I could not confirm it from a primary source (official docs,
the vendor's own page or a first-hand thread). Vendor comparison blogs count as
weak evidence.

## Summary

- **Self-hosting moves the boring safety work onto us.** Appwrite, Supabase and
  Convex all keep managed backups and point-in-time restore on their paid
  clouds only. Self-hosters must build and test backups themselves. This is
  the biggest gap today.
- **Email is now part of login.** With one-time codes as the default sign-in, a
  mail outage, an SES pause or a hit daily cap locks users out of every app.
  Gmail and SES both enforce rules (SPF, DKIM, DMARC, bounce and complaint
  limits, one-click unsubscribe for newsletters) that need a working feedback
  loop. The gateway does not have one yet.
- **The hosting basics people miss most after leaving Vercel** are
  push-to-deploy, zero-downtime deploys, one-click rollback, previews, SSL on
  custom domains and easy logs. Railway covers most of these. They still need
  to be wired into `create_app` so an agent can use them.
- **Self-hosted Next.js needs its own security patching.** Two critical Next.js
  and React flaws (2025) hit self-hosted apps but not Vercel-hosted ones, or
  needed a rebuild of every app. Self-hosted panels had critical flaws too
  (Coolify, 11 in January 2026).
- **Marketing sites have their own must-haves:** custom domains with redirects,
  forms with spam protection, noindex for staging, password protection and
  simple analytics. Editing by non-developers (a CMS) is a product decision.
  The current plan leaves out custom domains beyond our subdomain.

## Needs, evidence and priority

Priority: **Must** = before real apps and websites. **Should** = soon after.
**Later** = when a real case appears. "Have" = already in the stack, still to
verify on Railway.

### Hosting and deploys

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| Push-to-deploy from GitHub with build logs | Reddit replies to a dev who self-hosted Next.js listed what Vercel still did for him: CI/CD, SSL, logs and previews ([r/nextjs](https://www.reddit.com/r/nextjs/comments/1l3vqys/self_hosting_nextjs), read via a mirror) | Vercel, Railway, Coolify | Must |
| Zero-downtime deploys (health check before switching traffic) | Coolify's top HN complaint: "Any pending request when you update an app is simply killed" ([HN](https://news.ycombinator.com/item?id=43555996)). Railway keeps the old deploy serving until the new one returns 200 ([Railway](https://docs.railway.com/guides/ship-on-merge-pr-canaries)) | Vercel, Railway | Must |
| One-click rollback | Rollback reuses an earlier deploy's source, but only within the plan's retention window ([Railway](https://docs.railway.com/deployments/reference)). Rollback does not undo database changes (Coolify, unverified) | Vercel, Railway | Must |
| Custom domains with automatic SSL, apex and www | Marketing sites live on the client's own domain. Railway issues certificates. The plan leaves out "custom domains per app beyond our subdomain" | Vercel, Railway, Coolify | Must for websites (product question) |
| Env vars per environment, kept secret | `NEXT_PUBLIC_` values are baked in at build time. Several instances need the same Server Actions key ([Next.js](https://nextjs.org/docs/app/guides/self-hosting)) | Vercel, Railway | Must |
| Logs the agent can read | Agents must be able to diagnose failures without Ludvig copying logs. Railway exposes logs through its API and MCP | Vercel, Railway MCP | Must |
| Preview deploy per pull request | Railway PR environments copy the base environment, **including its variables** ([Railway](https://docs.railway.com/guides/preview-deployments-with-pr-environments)). Unless changed, previews write to the production Appwrite project | Vercel, Railway | Should |
| Previews hidden from Google | Vercel adds `X-Robots-Tag: noindex` to every preview automatically ([Vercel](https://vercel.com/kb/guide/avoiding-duplicate-content-with-vercel-app-urls)) | Vercel | Must once previews exist |
| Scheduled jobs (cron) | Railway: cron schedule per service, UTC, at most every 5 minutes, timing can drift a few minutes ([Railway](https://docs.railway.com/reference/cron-jobs)) | Vercel Cron, Railway | Should |
| Image optimization | Works with `next start`. Sharp may need memory tuning on Linux ([Next.js](https://nextjs.org/docs/app/guides/self-hosting)) | Vercel, Next.js server | Should |
| CDN for static files | Railway CDN is free but off by default per service. It skips responses that set cookies ([Railway](https://docs.railway.com/networking/cdn)) | Vercel Edge, Railway CDN, Cloudflare | Should |
| ISR and revalidation that survive restarts | The cache is on local disk per instance. Multiple instances need a shared handler such as Redis ([Next.js](https://nextjs.org/docs/app/guides/self-hosting)). On Railway without a volume the cache resets on each deploy (my inference) | Vercel, Redis cache handler | Should |
| Bot and DDoS protection | One team left Vercel after "an extreme increase in bots crawling the site" ([dev.to](https://dev.to/kvetoslavnovak/why-we-left-vercel-and-switched-to-self-hosting-1k65)). Railway's own firewall is unverified | Vercel Firewall, Cloudflare | Should |
| Build caching, version-skew protection | Rolling deploys can break open tabs unless `deploymentId` is set ([Next.js](https://nextjs.org/docs/app/guides/self-hosting)) | Vercel | Later |

### Auth

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| Email code login, switchable to password; Google and GitHub | Social login, magic links and email OTP are Clerk's headline features ([Clerk](https://clerk.com/features)). Appwrite has all of these (planned) | Clerk, Appwrite | Must (planned) |
| Rate limits on login and code sending | Self-hosted Appwrite rate limits are controlled by `_APP_OPTIONS_ABUSE`, and the docs warn to turn them back on for production ([Appwrite](https://appwrite.io/docs/advanced/self-hosting/production/rate-limits)). Appwrite says floods of codes hurt email reputation ([Appwrite blog](https://appwrite.io/blog/post/appwrite-firewall-use-cases)). Firewall presets may be Cloud only (unverified) | Clerk, Appwrite | Must |
| Bot check on sign-up and code request | Clerk sells fraud and bot sign-up detection ([Clerk](https://clerk.com/features)). Turnstile tokens only protect if the server validates them ([Cloudflare](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)) | Clerk, Turnstile | Must for public apps |
| Block throwaway email addresses | Appwrite email policies can block free, alias and disposable addresses at sign-up ([Appwrite](https://appwrite.io/docs/advanced/security/abuse-protection)) | Clerk, Appwrite | Should |
| MFA (authenticator app plus recovery codes) | Appwrite supports email, phone, TOTP and one-time recovery codes ([Appwrite](https://appwrite.io/docs/products/auth/mfa)). Ludvig's own admin login is the highest-value target | Clerk, Appwrite | Must for the admin, Should for apps |
| Ready-made, branded sign-in screens | Clerk's `<SignIn/>` and `<UserProfile/>` components are a main reason people pick it ([Clerk](https://clerk.com/features)). The starter kit has to supply these itself | Clerk | Should |
| See and sign out devices; secure SSR cookies | Session list and remote sign-out are standard ([Clerk](https://clerk.com/features)) | Clerk, Appwrite | Should |
| User admin: find, block, delete and export a user | Needed for support and GDPR requests. Appwrite's console has users (detail unverified) | Clerk dashboard, Appwrite console | Should |
| Organizations, teams, roles | Clerk charges per organization beyond free limits ([WorkOS, competitor](https://workos.com/blog/clerk-pricing)). Out of scope for now | Clerk, Appwrite Teams | Later |
| Passkeys, leaked-password check | Clerk offers passkeys and HaveIBeenPwned checks ([Clerk](https://clerk.com/features)). Appwrite passkeys unverified | Clerk | Later |

### Database and files

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| Automatic off-site backups with a tested restore | Appwrite Cloud has scheduled backups. Self-hosters "need to implement manual backup procedures": database, storage volumes and `.env`. Losing `_APP_OPENSSL_KEY_V1` makes encrypted data unreadable ([Appwrite](https://appwrite.io/docs/advanced/self-hosting/production/backups)). Supabase self-hosted also lacks managed backups ([Supabase](https://supabase.com/docs/guides/self-hosting)) | Convex, Supabase Cloud, Railway volume backups | Must |
| Safe Appwrite upgrades | Forum threads show failed migrations and a broken console after upgrades. The upgrade tool backs up only `docker-compose.yml` and `.env` ([Appwrite thread](https://appwrite.io/threads/1408067222357934191)) | Managed clouds | Must |
| Schema as code, typed client | Convex's end-to-end types are its most praised feature; renames still need migration code ([review, weak](https://makerstack.co/reviews/convex-review/)). Appwrite's CLI can deploy tables and generate types (exact commands unverified) | Convex, Appwrite CLI | Must for agents |
| Separate test data from live data | Follows from previews copying production variables (see above) | Supabase branching, Convex preview deploys | Must once previews exist |
| Realtime updates | Built into Appwrite. Needs a check that WebSockets work through Railway (unverified) | Convex, Appwrite | Have |
| Point-in-time restore | Cloud-only on Supabase and Appwrite ([Appwrite](https://appwrite.io/docs/advanced/security/backups)) | Supabase Pro, Appwrite Cloud | Later |
| Full-text search | Common request for content sites (no strong evidence found) | Postgres FTS, Meilisearch | Later |

### Email

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| SPF, DKIM and DMARC aligned to the From domain | Gmail requires SPF or DKIM for everyone. Above 5,000 a day it requires both plus DMARC and alignment. DKIM needs at least 1024 bits, 2048 recommended ([Google](https://support.google.com/a/answer/81126)) | Resend, SES | Must |
| Bounce and complaint handling, suppression list, early alarms | SES puts an account under review above 5% bounces or 0.1% complaints ([AWS](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html)). It can suppress hard bounces and complaints automatically ([AWS](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)). Alerts need a CloudWatch alarm ([AWS](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboard-cloudwatch-alarm.html)). Exact pause thresholds conflict between AWS pages | Resend (built in), SES plus SNS | Must |
| Login mail never starved by other mail | The gateway sends every app's login codes as one sender, `appwrite`, under the 300 a day per-app cap and the 1,000 a day total cap. Over the cap, mail is refused (`infra/mail-gateway/README.md`). One busy app, a newsletter or a code-request flood can stop logins everywhere | Separate transactional streams (Resend, Postmark) | Must |
| SES production access and spending guard | New SES accounts start in a sandbox (well known, not re-checked here). SES has no hard spending cap of its own (unverified). The gateway caps are the guard | SES | Must |
| One-click unsubscribe and list management for newsletters | Gmail requires one-click unsubscribe for marketing mail from bulk senders ([Google](https://support.google.com/a/answer/81126)). Yahoo expects opt-outs honored within 2 days ([weak](https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024)). Resend uses topics so people can choose what they get ([Resend](https://resend.com/docs/dashboard/broadcasts/introduction)) | Resend Broadcasts, Listmonk | Must before the first newsletter |
| Complaint visibility for Gmail | Gmail often sends no complaint events ([Resend](https://resend.com/docs/knowledge-base/why-are-my-emails-landing-on-the-suppression-list)). Postmaster Tools is the only signal; keep spam rate below 0.1% ([Google](https://support.google.com/a/answer/81126)) | Google Postmaster Tools | Should |
| Branded templates for codes, verification and reset per app | Users judge trust by the login email (no strong evidence found). Per-project templates in Appwrite are unverified | Resend + React Email, Appwrite templates | Should |
| Searchable delivery log per message | Needed to answer "I never got my code". Resend has this built in | Resend, SES event log | Should |

### Websites

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| Noindex toggle, with staging hidden by default | Vercel does this automatically for previews ([Vercel](https://vercel.com/kb/guide/avoiding-duplicate-content-with-vercel-app-urls)) | Vercel | Must (planned) |
| Password-protect a site | Vercel charges extra for it on Pro ([Vercel](https://vercel.com/docs/deployment-protection)). Agencies use it for client review | Vercel, Netlify | Must (planned) |
| Redirects (www and apex, old URLs) | Needed when a client's site moves. Built into `next.config.js` | Vercel, Next.js | Must for websites |
| Contact forms with spam protection and email alerts | Turnstile tokens must be checked on the server ([Cloudflare](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)). Form mail passes through the gateway caps | Formspree, Netlify Forms, Turnstile | Must for websites |
| Simple cookieless analytics | Plausible and Umami are cookieless and self-hostable. Plausible says no consent banner is needed ([Plausible](https://plausible.io/cookieless-web-analytics)); legal status per country is unverified | Vercel Analytics, Plausible, Umami | Should |
| Content editing for non-developers (CMS) | Payload is strongest for self-hosting. Keystatic is weak for marketing workflows. Tina has inline editing ([agency comparison, weak](https://www.luckymedia.dev/compare/payload-cms-vs-keystatic)) | Payload, Tina, Sanity | Should (product question) |
| SEO basics: titles, OG images, sitemap, robots | Built into Next.js metadata (no complaint evidence) | Next.js | Should (starter kit) |

### Operations

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| Uptime checks with phone alerts | Uptime Kuma: MIT, about 90k GitHub stars, 90+ notification channels ([GitHub](https://github.com/louislam/uptime-kuma)) | Vercel, Uptime Kuma, Better Stack | Must |
| Error tracking | Self-hosted Sentry needs Kafka and ClickHouse. GlitchTip accepts Sentry SDKs and runs in about 512 MB ([Railway template, weak](https://railway.com/deploy/glitchtip-sentry-alternative)) | Sentry, GlitchTip | Should |
| Security patching for Next.js, React and Appwrite | CVE-2025-29927 bypassed middleware on self-hosted Next.js but not on Vercel ([UpGuard](https://www.upguard.com/blog/critical-middleware-bypass-vulnerability-in-next-js-cve-2025-29927)). React2Shell (CVSS 10) required upgrading and rebuilding every app ([Bitsight](https://www.bitsight.com/blog/security-alert-cve-2025-66478-cve-2025-55182-nextjs-react-server-components-remote-code)) | Vercel (patches platform-side) | Must |
| Admin panels not open to the internet | Coolify disclosed 11 critical flaws in January 2026. Advice: keep the dashboard off the public internet ([The Hacker News](https://thehackernews.com/2026/01/coolify-discloses-11-critical-flaws.html)) | VPN, Cloudflare Access | Must |
| Hard spending limits | Railway soft alerts only email you. A hard limit takes workloads offline, minimum $10 ([Railway](https://docs.railway.com/reference/usage-limits)). "Surprise bill" is the top reason people leave Vercel ([dev.to, weak](https://dev.to/mr_manushukla/self-host-nextjs-without-vercel-in-2026-a-production-guide-to-the-stable-adapter-api-3ll6)) | Railway limits, gateway caps | Must |
| Clear errors and recovery | Coolify users: unhelpful errors, broken proxies with no feedback, no instance migration ([HN](https://news.ycombinator.com/item?id=43555996)) | Managed platforms | Should |
| Audit trail of agent actions | Useful when an agent deletes or changes something (no direct evidence) | Vercel activity log | Later |

### Agent-friendliness

| Need | Why users care (evidence) | Typical tool | Priority |
|---|---|---|---|
| Every step through MCP or CLI: create, deploy, logs, rollback, env, domain, backup, restore, delete | Appwrite's MCP works inside one project per config. A platform tool is needed for the rest (plan). Railway has its own MCP and CLI | Vercel MCP, Railway MCP, Appwrite MCP | Must |
| Non-interactive, idempotent tools with a dry run | Lets agents retry safely. Appwrite's CLI has a non-interactive CI mode (listing, unverified) | Appwrite CLI, Railway CLI | Should |
| Agent-readable docs (`llms.txt`, skills) | Next.js and Appwrite now publish these for agents ([Next.js](https://nextjs.org/docs/llms.txt), [Appwrite](https://appwrite.io/docs/tooling/ai/agents/claude-code)) | | Later |

## Top 10 launch blockers, ranked

1. **Backups with a tested restore.** Nightly off-site copies of the Appwrite
   database, file storage and the `.env` encryption key, plus one rehearsed
   restore to a fresh install. Nothing does this for us on self-hosted.
2. **Login mail that cannot be starved.** Give account mails (codes,
   verification, reset) their own budget, separate from app and newsletter
   mail. Today all login codes share one 300 a day cap. Alert before any cap
   is reached.
3. **Email deliverability loop.** SES out of sandbox, SPF, DKIM (2048 bit) and
   DMARC on each sending domain. SES bounce and complaint events feed the
   gateway and a suppression list. Alarms go off well below 5% bounces and
   0.1% complaints.
4. **Abuse protection on sign-in.** Turn on `_APP_OPTIONS_ABUSE`, rate-limit
   code requests per IP and per address, add a server-checked bot check
   (Turnstile) to sign-up, code requests and forms.
5. **Safe deploys the agent can drive.** Push-to-deploy with health checks,
   one-click rollback and logs, all reachable from `create_app` and sibling
   MCP tools.
6. **Patching and upgrade routine.** A weekly check and redeploy of all apps
   for Next.js and React security releases. Appwrite upgrades rehearsed on a
   copy after a backup. Admin console and Appwrite API admin routes kept
   behind MFA and off the open internet.
7. **Monitoring.** Uptime checks for Appwrite, the gateway and every app,
   alerting Ludvig's phone. Error tracking such as GlitchTip soon after.
8. **Cost guardrails.** Railway soft alert plus a hard limit, gateway caps
   tuned, and a monthly cost view. Note that a Railway hard limit takes
   everything offline.
9. **Staging that cannot touch live data or Google.** Previews and staging
   get noindex and optional password by default, and point at a separate
   Appwrite project, not production. Railway PR environments copy production
   variables unless changed.
10. **Website basics.** Custom domains with SSL and redirects, contact forms
    with spam protection, the planned noindex and password toggles, and simple
    analytics. Custom domains are outside the current plan, so this needs an
    owner decision.

Newsletters add one more blocker before the first send: lists with
double opt-in, one-click unsubscribe (RFC 8058 header plus footer link) and
opt-outs honored within two days.

## Open product questions this raises

- Should marketing sites get the client's own domain (for example
  `client.se`), or stay on our subdomain? The plan excludes custom domains now.
- Do clients or non-developers need to edit website text themselves? If yes,
  a CMS choice is needed (Payload, Tina or Keystatic).
- When a daily mail cap is hit, should login codes still go out while
  newsletters wait?

## Sources

- Next.js self-hosting guide: https://nextjs.org/docs/app/guides/self-hosting
- Next.js CDN caching: https://nextjs.org/docs/app/guides/cdn-caching
- Vercel preview noindex: https://vercel.com/kb/guide/avoiding-duplicate-content-with-vercel-app-urls
- Vercel deployment protection: https://vercel.com/docs/deployment-protection
- Railway PR environments: https://docs.railway.com/guides/preview-deployments-with-pr-environments
- Railway ship on merge and health checks: https://docs.railway.com/guides/ship-on-merge-pr-canaries
- Railway deployments and rollback: https://docs.railway.com/deployments/reference
- Railway cron jobs: https://docs.railway.com/reference/cron-jobs
- Railway CDN: https://docs.railway.com/networking/cdn
- Railway volume backups: https://docs.railway.com/volumes/backups
- Railway usage limits: https://docs.railway.com/reference/usage-limits
- Appwrite self-hosted backups: https://appwrite.io/docs/advanced/self-hosting/production/backups
- Appwrite backups (Cloud): https://appwrite.io/docs/advanced/security/backups
- Appwrite self-hosted rate limits: https://appwrite.io/docs/advanced/self-hosting/production/rate-limits
- Appwrite abuse protection: https://appwrite.io/docs/advanced/security/abuse-protection
- Appwrite Firewall blog (2026-09-23): https://appwrite.io/blog/post/appwrite-firewall-use-cases
- Appwrite MFA: https://appwrite.io/docs/products/auth/mfa
- Appwrite agents in Claude Code: https://appwrite.io/docs/tooling/ai/agents/claude-code
- Appwrite upgrade thread (backup scope): https://appwrite.io/threads/1408067222357934191
- Supabase self-hosting (platform-only features): https://supabase.com/docs/guides/self-hosting
- Supabase cloud vs self-hosted parity issue: https://github.com/supabase/supabase-js/issues/1581
- Clerk features: https://clerk.com/features
- WorkOS on Clerk pricing (competitor): https://workos.com/blog/clerk-pricing
- Convex review (weak): https://makerstack.co/reviews/convex-review/
- Google email sender guidelines: https://support.google.com/a/answer/81126
- Resend on Gmail and Yahoo rules: https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024
- Resend suppressions: https://resend.com/docs/dashboard/emails/email-suppressions
- Resend on Gmail complaints: https://resend.com/docs/knowledge-base/why-are-my-emails-landing-on-the-suppression-list
- Resend Broadcasts: https://resend.com/docs/dashboard/broadcasts/introduction
- SES reputation thresholds: https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html
- SES reputation alarms: https://docs.aws.amazon.com/ses/latest/dg/reputationdashboard-cloudwatch-alarm.html
- SES account-level suppression: https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html
- Cloudflare Turnstile server validation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Plausible cookieless analytics: https://plausible.io/cookieless-web-analytics
- Uptime Kuma: https://github.com/louislam/uptime-kuma
- GlitchTip on Railway (weak): https://railway.com/deploy/glitchtip-sentry-alternative
- CVE-2025-29927 (UpGuard): https://www.upguard.com/blog/critical-middleware-bypass-vulnerability-in-next-js-cve-2025-29927
- React2Shell CVE-2025-55182 / 66478 (Bitsight): https://www.bitsight.com/blog/security-alert-cve-2025-66478-cve-2025-55182-nextjs-react-server-components-remote-code
- Coolify 11 critical flaws: https://thehackernews.com/2026/01/coolify-discloses-11-critical-flaws.html
- HN, Coolify discussion: https://news.ycombinator.com/item?id=43555996
- HN, PocketBase discussion: https://news.ycombinator.com/item?id=46075320
- Why we left Vercel (bots): https://dev.to/kvetoslavnovak/why-we-left-vercel-and-switched-to-self-hosting-1k65
- Self-host Next.js in 2026 (cost reasons, weak): https://dev.to/mr_manushukla/self-host-nextjs-without-vercel-in-2026-a-production-guide-to-the-stable-adapter-api-3ll6
- r/nextjs self-hosting thread: https://www.reddit.com/r/nextjs/comments/1l3vqys/self_hosting_nextjs
- CMS comparison (agency, weak): https://www.luckymedia.dev/compare/payload-cms-vs-keystatic
- Local repo: infra/mail-gateway/README.md, docs/plans/open/P1-2026-10-23-appwrite-platform.md
