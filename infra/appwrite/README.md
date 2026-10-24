# Appwrite on this Mac

Pinned: `appwrite/appwrite:2.6.1`, combined topology, PostgreSQL.
API: `http://localhost/v1`. Admin screen: `http://localhost`.

The installer writes `docker-compose.yml` and `.env` into `appwrite/` here.
That folder is gitignored because `.env` holds the encryption key. The key is
also kept in the macOS Keychain (service `builder-platform`, account
`appwrite-openssl-key`), because losing it makes stored data unreadable.

## Start and stop

```bash
cd infra/appwrite/appwrite
docker compose up -d     # start
docker compose stop      # stop, keeps data
docker compose ps        # status
```

If the API stops answering after Docker restarts (`curl` gets "connection
reset"), restart the proxy: `docker compose restart traefik`.

## Email

Appwrite sends all mail through `../mail-gateway` (daily caps). Locally it
lands in the test inbox at http://localhost:8025 and never leaves the Mac.

## Owner login for the Sitedock tool

The owner account exists (created 2026-10-24) and the `sitedock` MCP tool logs
in with it. Email and password are in the Keychain, accounts
`appwrite-owner-email` and `appwrite-owner-password`. To sign in to the admin
screen, copy the password:

```bash
security find-generic-password -s builder-platform -a appwrite-owner-password -w | pbcopy
```

All published ports, MQTT included, are bound to `127.0.0.1` in `.env`, so
nothing outside this Mac reaches Appwrite.

## Admin colours

The admin runs our own build of the console image
(`sitedock/console:1.2.97-theme`, from `console-theme/`). It swaps the
Appwrite pinks for blue, makes the dark mode greys neutral and shows section
labels in sentence case. `docker-compose.override.yml` points the
`appwrite-console` service at it. Changed files get new names, so browsers
fetch them fresh instead of keeping the old colours.

```bash
cd infra/appwrite/appwrite
docker compose build appwrite-console && docker compose up -d appwrite-console
```

When upgrading the console image, change `BASE` and the tag in the override.
`patch.ts` stops the build if the main stylesheet is no longer found.

## Upgrade

Only on purpose, after `bun run spike` and the end-to-end check pass on the new
version. Back up first.
