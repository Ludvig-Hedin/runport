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
  log in as `<app>:news`. Newsletters and forms share the automated-mail
  budget. `MAIL_NEWS_SHARE_PERCENT` can lower its 70% ceiling.
- Appwrite account mail uses `<app>:login` with its own gateway credential.
  It can use the reserved `MAIL_LOGIN_RESERVE` places, defaulting to ten
  percent of the overall cap. This covers login, verification and recovery.
- Platform app alerts go to the configured `ALERT_TO` mailbox. Their daily
  budgets are `MAIL_ALERT_DAILY_LIMIT` (default 30) and
  `MAIL_APP_ALERT_DAILY_LIMIT` (default four). They count against the
  overall cap and cannot use the account-mail reserve.
- `DELIVERY=smtp` forwards to the local test inbox (Mailpit,
  http://localhost:8025). `DELIVERY=ses` sends through Amazon SES over HTTPS,
  which also works where outgoing SMTP is blocked (Railway Hobby).
- `SENDER_DOMAINS` limits who mail can claim to be from. Set it when SES is on.
- `POST /runport-mail/form` accepts a single app-owner notification over
  HTTPS for hosted apps outside the private network. Its token is bound to
  the app ID and one owner inbox. Form notifications have their own limits of
  10 per app per hour, 50 per app per day and 10% of the platform daily cap.
  `MAIL_APP_FORM_HOURLY_LIMIT`, `MAIL_APP_FORM_DAILY_LIMIT` and `MAIL_FORM_SHARE_PERCENT`
  can lower those limits. Newsletters and form notifications together can use
  at most 70% of the daily capacity, leaving the rest for account mail.
  On Railway, deploy the gateway and router together to enable
  this route. Local apps use the gateway bound to loopback port 8026.
- `GET /stats` on port 8080 inside the network: today's counts per app.

Settings live in `infra/appwrite/appwrite/.env`; the service is defined in
`docker-compose.override.yml` next to it.

```bash
cd infra/mail-gateway && bun test && bunx tsc --noEmit
```
