import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");

export const config = {
  /** Appwrite API as seen from this Mac. */
  endpoint: process.env.PLATFORM_APPWRITE_ENDPOINT ?? "http://localhost/v1",
  /** Where created apps live, one folder per app. */
  appsDir: process.env.PLATFORM_APPS_DIR ?? join(homedir(), "Programming", "apps"),
  templateDir: join(repoRoot, "templates", "nextjs-appwrite"),
  logFile: join(repoRoot, "mcp", "logs", "actions.log"),
  /** macOS Keychain service that holds the Appwrite owner login. */
  keychainService: "builder-platform",
  /** Apps send as <slug>@<mailDomain> through the mail gateway (infra/mail-gateway). */
  mailDomain: process.env.PLATFORM_MAIL_DOMAIN ?? "apps.ludvighedin.com",
  /** The gateway as Appwrite reaches it on its internal network. */
  mailGateway: { host: "mail-gateway", port: 2525 },
  /** Local dev ports handed out to apps, one per app. */
  portRange: { first: 3101, last: 3199 },
};

export const registryFile = () => join(config.appsDir, ".platform.json");

/** Rights each app's server key gets. Enough for auth, tables and files. */
export const APP_KEY_SCOPES = [
  "users.read",
  "users.write",
  "sessions.write",
  "databases.read",
  "databases.write",
  "tables.read",
  "tables.write",
  "columns.read",
  "columns.write",
  "indexes.read",
  "indexes.write",
  "rows.read",
  "rows.write",
  "buckets.read",
  "buckets.write",
  "files.read",
  "files.write",
];
