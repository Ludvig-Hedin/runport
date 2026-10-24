# Mail gateway

Every email the platform sends passes through here: Appwrite's account mails
(login codes, verification, password reset) and each app's own messages.

- Senders log in over SMTP with their app id as username. Each app has its
  own password, an HMAC of the app id with the master key (Keychain
  `builder-platform` / `mail-gateway-master-key`, env `GATEWAY_MASTER_KEY`).
  See `src/identity.ts`.
- An app may only send as `<app id>@<allowed domain>`, and the visible From
  header must match. Appwrite itself (`appwrite`) may use any allowed address,
  because it sends account mails for every project.
- Daily caps count recipients, reset at Stockholm midnight:
  `MAIL_DAILY_LIMIT` (all apps, default 1000), `MAIL_APP_DAILY_LIMIT`
  (per app, login codes and other one-person mail, default 300) and
  `MAIL_APP_NEWS_DAILY_LIMIT` (per app, newsletters, default 500). Bulk sends
  log in as `<app>:news`. Newsletters may fill at most
  `MAIL_NEWS_SHARE_PERCENT` (default 70) of the total, so they never use up
  the room login codes need. Over a cap the email is refused, not queued.
- `DELIVERY=smtp` forwards to the local test inbox (Mailpit,
  http://localhost:8025). `DELIVERY=ses` sends through Amazon SES over HTTPS,
  which also works where outgoing SMTP is blocked (Railway Hobby).
- `SENDER_DOMAINS` limits who mail can claim to be from. Set it when SES is on.
- `GET /stats` on port 8080 inside the network: today's counts per app.

Settings live in `infra/appwrite/appwrite/.env`; the service is defined in
`docker-compose.override.yml` next to it.

```bash
cd infra/mail-gateway && bun test && bunx tsc --noEmit
```
