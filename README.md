<p><img src="brand/logo.svg" alt="Sitedock" height="48"></p>

Your own home for web apps and websites. An AI agent (Claude Code, Codex)
creates the app, its login, database, files and email in one step, and you
own every part of it. Built so one person can run many small apps without
Vercel, Clerk, Convex or Resend.

> Status: early. Works on one Mac. Not online yet, see [What works](#what-works).

## What you get

- **Login** for every app: one-time code by email by default, or email and
  password, plus Google and GitHub sign-in.
- **Database, files and live updates** per app, on self-hosted
  [Appwrite](https://github.com/appwrite/appwrite).
- **Email** through a small gateway with hard daily caps, delivered by Amazon
  SES. Newsletters can never use up the room login codes need.
- **Websites too:** any Next.js site, with a password lock and search engine
  indexing off until you turn it on.
- **Agent first:** an MCP tool (`sitedock`) creates an app, its project, keys,
  mail sender, private GitHub repo and local copy in one call.

## What works

| Part | State |
|---|---|
| Appwrite on your Mac, login, data per user, files | Works, tested end to end |
| `create_app` MCP tool | Works locally |
| Mail gateway with caps, local test inbox | Works locally, 31 tests |
| Amazon SES delivery | Built, waiting for an AWS account |
| Hosting online (Railway) | Not started |
| Own admin panel | Not started; Appwrite's admin is used meanwhile |
| Backups | Not started |

## Layout

```
infra/appwrite/      Appwrite setup and local overrides
infra/mail-gateway/  SMTP gateway: caps, sender checks, SES or test inbox
mcp/                 sitedock MCP server (Bun, TypeScript)
templates/           Next.js starter kit copied into each new app
docs/                plans, research and spike results
brand/               logo
```

Start with [infra/appwrite/README.md](infra/appwrite/README.md).

## License

MIT, see [LICENSE](LICENSE). Third-party software and trademarks are listed in
[NOTICE](NOTICE). Sitedock is not affiliated with Appwrite.
