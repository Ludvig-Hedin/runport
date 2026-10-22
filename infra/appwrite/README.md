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

## Owner login for the platform tool

The `platform` MCP tool logs in as the owner. Store the login once:

```bash
security add-generic-password -s builder-platform -a appwrite-owner-email -w
security add-generic-password -s builder-platform -a appwrite-owner-password -w
```

## Upgrade

Only on purpose, after `bun run spike` and the end-to-end check pass on the new
version. Back up first.
