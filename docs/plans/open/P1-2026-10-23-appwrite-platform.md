---
stage: accepted
priority: P1
owner: Ludvig
created: 2026-10-23
artifact: docs/plans/assets/P1-2026-10-23-appwrite-platform.html
---

# Own app platform on self-hosted Appwrite

Say "create a todo app with login" in Claude Code and get a running app with
accounts and a database, without signing up for anything per app.

## Summary

| | |
|---|---|
| What | Run Appwrite on the Mac for accounts, data and files, and add one small tool so Claude can create and set up apps on it by itself. |
| Why now | Appwrite 2.x (September 2026) is the first version small enough to run on a laptop and built for agents. Every app today still means Vercel + Convex + Clerk + GitHub setup by hand. |
| Effort | Stage 1 (works on the Mac): about 3 days of agent work. Online, name and own panel follow as separate stages. |
| The ask | Go with Railway for hosting later, which means Appwrite handles accounts, data and files while Railway runs the apps? |

## Owner decisions (2026-10-23)

- Order: make it work with minimal edits, then rename, then restyle.
- Run locally first. Later online on Railway or Render. Not Hetzner.
- Apps built on the platform use Appwrite for accounts and data. Clerk and
  Convex are not used inside those apps.
- App links will live under a subdomain of a domain he already owns.
- "Rename and restyle" means our own simple panel on top. Appwrite's admin stays
  behind it for advanced work.
- Hosting online: Railway. Appwrite does accounts, data and files; Railway runs
  the apps. Approved 2026-10-23 ("railway. kör").

## Owner decisions (2026-10-24)

- Goal: the platform replaces Vercel, Clerk, Convex and Resend for all his
  future apps. Claude or Codex must be able to do everything in it.
- Email is built in: app emails (verification, login codes, receipts) and
  newsletters to lists. Open source, self-hosted where sensible.
- Delivery provider still open: he will use Amazon SES if setup is simple and
  spending can be capped hard; otherwise Resend or self-hosted. Must not risk
  a surprise bill.
- Sign-in in every new app: one-time code by email by default, switchable to
  email and password. Google and GitHub sign-in as well.
- Only Ludvig logs in to the admin.
- Name: Sitedock (chosen 2026-10-24 from his shortlist "appdock or Sitedock";
  Appdock is a registered software trademark and has no free domain).
  sitedock.ai was unregistered on 2026-10-24; buying it needs his approval.
- Public open-source repo, MIT license, Appwrite credited in NOTICE.
- New sites and apps are not indexed by search engines until he turns it on.
- Mail delivery: Cloudflare Email Sending (decided 2026-10-24, replaces
  Amazon SES: "vill inte använda aws"). Live for apps.ludvighedin.com.
- Online addresses: `*.apps.ludvighedin.com` for now; he may buy a domain
  for Sitedock itself later.
- Admin look: neutral dark mode, blue instead of Appwrite pink, no all-caps
  labels (done 2026-10-24). Sidebar cleanup and admin toggles proposed, not
  yet approved.

## What I assumed

- **Railway split** (pending owner confirmation, see The decision): Appwrite
  does accounts, database and files. Apps run as Railway services. Appwrite
  Sites and Functions are not used, because Railway and Render cannot run them.
- Single user (Ludvig). No sign-ups, billing or teams for others.
- Appwrite itself stays unmodified, pinned to 2.6.1, only configured.
- GitHub stays the place for code. Each app gets its own private repo.
- Deleting an app asks for confirmation and never deletes the GitHub repo.
- Stage 1 apps open only on this Mac (`localhost`), not on the phone or for
  others.
- Test apps from stage 1 are not moved online. Online starts fresh.
- No email in stage 1: no verification or password reset mails. Online needs an
  email sender, decided then.
- New code uses Bun and TypeScript.

## Review of the ChatGPT plan

The ChatGPT conversation is in the owner's chat of 2026-10-22 (not linked).
Its plan: self-host Appwrite 2.x, connect Claude through Appwrite's MCP, build
a "create app" orchestrator, then a Clerk + Convex + Next.js dashboard, in 10
working days, with a VPS or Mac as host.

Right:

- Appwrite is a good base: accounts, database, storage, realtime in one
  open-source install.
- Do not build a cloud. Build only the missing "create app" layer.
- Appwrite's own MCP works inside one existing project only, so a small tool of
  our own is needed to create new projects.
- 2.6.1 is the current version (released 21 October 2026).
- Prove the flow before spending time on looks.

Wrong or missing:

1. **Appwrite's new admin screen is not public source.** Console IV runs a
   private codebase (`github.com/appwrite/new` returns 404). Rebranding means
   our own panel. Only the old Svelte admin (Appwrite 1.9) is open source.
2. **Railway and Render cannot run Appwrite hosting.** Sites and Functions start
   containers through the Docker socket, which those hosts do not expose.
   Railway's Appwrite templates list Sites, Functions and per-project domains
   as not working. Accounts, database and storage work.
3. **Creating a project from code is unproven on self-hosted.** A January 2026
   forum thread shows `appwrite projects create` failing with a missing
   `projects.write` scope. Test first.
4. **Appwrite's MCP covers one project per config.** A reported self-hosted
   failure (forum, 1.9.5) was fixed in MCP v0.8.25, but each app still needs its
   own MCP config with its own project key.
5. **HTTPS per app online is real work** if Appwrite hosts apps: wildcard
   certificates via DNS challenge. With Railway hosting, Railway issues them.
6. **The Clerk + Convex dashboard in week 2 is early.** It breaks the chosen
   order and adds two services back.
7. **The Mac is tight.** About 12 GB free disk, Docker not running, 24 GB RAM
   shared with many agents.

## Stage 1: works on the Mac

Done when: in Claude Code, "create a todo app with login" produces an app
folder, a private GitHub repo and a running app at `http://localhost:<port>`
where you can sign up, add data, log out and log back in. No manual step except
the one-time setup.

What `create_app` does and does not do: it creates the backend project and a
running starter app. Building the actual features is Claude's normal work
afterwards, in that folder.

### Slice 0: prepare the Mac (about 1 hour)

- Ludvig opens Docker Desktop (agents cannot launch apps from the sandbox).
  Also after each restart, unless "Start Docker Desktop when you sign in" is on.
- Disk: need about 20 GB free (12 GB today). Clear rebuildable caches through
  the existing storage rules. If not enough, stop and ask.
- Docker Desktop: 8 GB RAM, 4 GB swap (Appwrite's minimum is 4 GB plus 2 GB
  swap). Apps and their builds run on the Mac with Bun, not in Docker.
- Proof: `docker info` responds, `df -h /` shows 20 GB or more free.

### Slice 1: install Appwrite 2.6.1 (half a day)

- `infra/appwrite/`: official installer, image `appwrite/appwrite:2.6.1`,
  combined topology, PostgreSQL. Port 20080 is only the setup wizard; Appwrite
  itself serves on 80/443. One edit to the generated compose file: bind 80/443
  to `127.0.0.1` so nothing outside the Mac reaches it. Endpoint
  `http://localhost/v1`.
- No Sites or Functions runtimes pulled (`_APP_SITES_RUNTIMES` and
  `_APP_FUNCTIONS_RUNTIMES` empty), to save disk. Otherwise stock.
- `.env` gitignored. The encryption key and owner password also go in the macOS
  Keychain (`security add-generic-password`), because losing them loses data.
- Create the owner account. Further console sign-ups are already blocked by
  default (`_APP_CONSOLE_WHITELIST_ROOT`).
- Nightly local backup: `pg_dump` of the Appwrite database plus the storage
  volume, kept 7 days, in `infra/appwrite/backups/` (gitignored).
- `infra/appwrite/README.md`: start, stop, backup, restore, upgrade.
- Proof: admin opens, a manual project can add a table and a user.

### Slice 2: spike, set up a project from code (2 hours)

Must prove all three admin steps, not only the first: create project, create a
scoped API key, add a web platform (`localhost`). Try in order:

1. Owner console session: email session against the console API
   (`X-Appwrite-Project: console`), then `POST /v1/projects`,
   `POST /v1/projects/{id}/keys` (scopes `users.*`, `tables.*`, `rows.*`,
   `files.*`, `buckets.*`), `POST /v1/projects/{id}/platforms`.
2. CLI: `appwrite login` then `appwrite init project` (reported working in the
   forum thread where `projects create` failed).
3. Organization API key with `projects.write` (documented for Cloud; test on
   self-hosted).

Fallback if all fail: Ludvig does the three steps in the admin per app (about
two minutes) and pastes project id and key into the chat. Result in
`docs/spikes/create-project.md`.

### Slice 3: starter kit and one app by hand (half a day)

- `templates/nextjs-appwrite/`: Next.js, Tailwind, Appwrite SDKs. Sign-up,
  login, logout, one signed-in page, one example table with per-user row
  permissions. `CLAUDE.md` tells agents how to add tables, run and deploy.
- **Auth runs server-side** (Appwrite's Next.js SSR pattern: `node-appwrite`
  creates the session, the app sets its own cookie on its own domain). This
  avoids Safari blocking cross-site cookies once Appwrite and apps live on
  different hosts.
- The project must list each app address as an allowed web platform
  (`localhost` now, the Railway domain later), or the browser blocks requests.
- Claude builds a todo app from it against a manually created project.
- Proof: sign up, add a todo, reload, log out, sign in as a second user and
  see none of the first user's todos.

### Slice 4: the "create app" tool (1 day)

`mcp/` is a TypeScript MCP server (stdio, Bun) named `platform`, registered in
Claude Code at user level.

Owner session: reads owner email and password from the Keychain, logs in to
the console API, keeps the session in memory, logs in again on a 401. Agents
never see the password.

GitHub: the MCP server runs outside the agent sandbox and uses the token from
`gh auth token` (Keychain). The template is a folder in this repo, so the tool
copies it, runs `git init`, commits, then `gh repo create <slug> --private
--source . --push`.

| Tool | Does |
|---|---|
| `create_app(name)` | Creates the Appwrite project and a scoped key, registers `localhost` as web platform, copies the template to `~/Programming/apps/<slug>`, writes `.env.local` and a gitignored `.mcp.json` (Appwrite MCP v0.8.25+ scoped to this project), creates and pushes the private repo, installs, starts it on a free port. Returns folder, repo URL, local URL. |
| `list_apps()` | All apps with folder, repo, local URL. |
| `delete_app(slug, confirm)` | Deletes the Appwrite project and local folder after `confirm === slug`. Never deletes the repo. |

Rules:

- Idempotent: each step checks whether its result exists first, so rerunning
  `create_app` resumes after a failure. No automatic rollback; on failure it
  reports exactly what exists.
- Every call appends one line to `mcp/logs/actions.log`.
- If the spike failed, `create_app` asks for the project id instead of creating.
- Tests: unit tests for slug and input rules; one end-to-end script that
  creates and deletes a throwaway app.

### Slice 5: proof (half a day)

Two apps, one sentence each: a todo list with login, and a small project tool
with projects, tasks and image upload. Check: sign-up works, data survives
reload and an Appwrite restart, users cannot see each other's data, the two
apps do not share users. Record peak Docker RAM for the online cost estimate.
Results in `docs/spikes/stage-1-proof.md`.

Optional, if time: try Appwrite's own MCP (`mcp-server-appwrite`) with a
project key. Skip on failure.

## Stage 2: online on Railway

- Appwrite core on Railway (accounts, database, storage, realtime). Railway's
  template is on 2.2, so deploy the official 2.6.1 images ourselves, PostgreSQL
  as on the Mac.
- Its API on our subdomain, for example `api.apps.ludvighedin.com`.
- `create_app` gains: create a Railway service from the app repo, set env vars,
  attach `<slug>.apps.ludvighedin.com`, register that domain as web platform.
  GitHub push deploys automatically through Railway.
- `deploy_app`, `get_logs` through Railway's API.
- Email sender for verification and password reset (decide provider then).
- Backups of the Railway database.
- Cost estimate: Railway bills about $10 per GB RAM and $20 per vCPU a month,
  so Appwrite core at 2 to 3 GB is about 250 to 450 kr a month, each small app
  about 20 to 60 kr. Replace with measured numbers from slice 5.

Alternative if Ludvig declines Railway: full Appwrite on one virtual server
(not Hetzner, for example DigitalOcean 4 cores 8 GB, about 480 kr a month, about
620 kr with backups),
using Appwrite Sites for hosting and wildcard certificates via Cloudflare DNS.

## Stage 3: name

Pick the name. Put it on links, the MCP tool, email sender and the starter
kit's login pages. Appwrite's admin keeps its name.

## Stage 4: own panel

A simple web panel: your apps, link, status, last deploy, logs, open in Claude
Code, delete with confirmation. Same code as the MCP tool underneath.
Wireframes come with the stage 4 plan.

## What it costs

- Stage 1: nothing new.
- Stage 2: about 300 to 550 kr a month for a handful of apps. Estimate.
- No paid AI calls.

## Risks

| Risk | Mitigation |
|---|---|
| The Mac runs short of disk or memory. | Combined topology, no hosting runtimes, Docker capped at 6 GB, stop Appwrite when unused. |
| Projects cannot be set up from code. | About two minutes per app in the admin. Rest stays automatic. |
| Railway's Appwrite template lags behind Appwrite releases. | Pin the version; we can deploy the official images ourselves on Railway. |
| An Appwrite update breaks the tool. | Pinned. Upgrade only after the end-to-end script passes. |

## Not in this plan

- Other users, sign-ups, billing, teams.
- A self-hosted Git server. GitHub stays.
- Forking Appwrite's admin.
- Custom domains per app beyond our subdomain.
- Mobile apps.
- Appwrite Functions (Railway services or Next.js routes cover server code).

## Repo layout

```
builder-platform/
  infra/appwrite/        installer output, .env and backups (gitignored), README
  mcp/                   platform MCP server (Bun, TypeScript)
  templates/nextjs-appwrite/
  docs/plans/            this plan and its page
  docs/spikes/           spike and proof results
```

Created apps live in `~/Programming/apps/<slug>`, each with its own Git
history. Stage 1 starts with `git init` of this repo.

## Sources

- Appwrite 2.0 self-hosted: https://appwrite.io/blog/post/appwrite-2-self-hosted
- Install (2.6.1; 2 cores, 4 GB RAM, 2 GB swap): https://appwrite.io/docs/advanced/self-hosting/installation
- Sites on self-hosted, SSL: https://appwrite.io/docs/advanced/self-hosting/configuration/sites
- Releases: https://github.com/appwrite/appwrite/releases
- Appwrite MCP: https://github.com/appwrite/mcp
- Railway Appwrite template, no Sites/Functions: https://railway.com/deploy/appwrite-full-stack
- Forum, `projects.write` on self-hosted: https://appwrite.io/threads/1460842828031721671
- Forum, local MCP failure: https://appwrite.io/threads/1529032777398226984
