// Restores a dashboard delete backup into a new, separate Appwrite project and
// checks it: same users (with password hashes), rows and file bytes. By
// default the restored project is deleted again afterwards, so this doubles
// as the proof that a backup works. Never touches the app it came from.
// Run: PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1 bun src/restore-app-backup.ts <backup name> [--keep]
import { appwriteApi } from "../../dashboard/lib/ops/appwrite-rest";
import type { BackupStore } from "../../dashboard/lib/ops/backup";
import { restoreBackup } from "../../dashboard/lib/ops/restore";
import { AppwriteAdmin } from "./appwrite-admin";
import { config } from "./config";
import { readSecret } from "./keychain";
import { consoleSession, READ_SCOPES } from "./sync-dashboard";

const backupName = process.argv[2] ?? "";
const keep = process.argv.includes("--keep");
if (!/^[a-z0-9][a-zA-Z0-9-]{0,80}$/.test(backupName)) throw new Error("Usage: bun src/restore-app-backup.ts <backup name> [--keep]");

const dashboardKey = await readSecret("dashboard-appwrite-key", "runport-prod");
const dashboard = appwriteApi(config.endpoint, "dashboard", dashboardKey);

// The saved checksum comes from the delete's own record, not from the file.
const q = encodeURIComponent(JSON.stringify({ method: "equal", attribute: "backup", values: [backupName] }));
const found = await dashboard.get<{ rows: { manifestId?: string; manifestSha?: string }[] }>(`/tablesdb/main/tables/deletions/rows?queries[]=${q}`);
const record = found.rows[0];
if (!record?.manifestId || !record.manifestSha) throw new Error("No verified backup with that name in the dashboard's records.");

const store: BackupStore = {
  put: async () => {
    throw new Error("Restore never writes to the backup store.");
  },
  get: (id) => dashboard.download("app-backups", id),
};

// A fresh project with a random id, so it can never be an existing app.
const target = `restore-${crypto.randomUUID().slice(0, 8)}`;
const admin = new AppwriteAdmin();
await admin.createProject(target, `Restore check (${backupName})`.slice(0, 120));
try {
  const session = await consoleSession();
  const scopes = [...READ_SCOPES, "users.write", "databases.write", "tables.write", "columns.write", "indexes.write", "rows.write", "buckets.write", "files.write"];
  const key = await session.call<{ secret: string }>("POST", `/projects/${target}/keys`, { keyId: "unique()", name: "restore-check", scopes, expire: null }).finally(session.close);
  const counts = await restoreBackup(store, record.manifestId, record.manifestSha, appwriteApi(config.endpoint, target, key.secret));
  console.log(`restored into ${target} and checked: ${counts.users} users, ${counts.tables} tables, ${counts.rows} rows, ${counts.files} files (${counts.bytes} bytes)`);
} finally {
  if (!keep) {
    await admin.deleteProject(target);
    console.log(`removed ${target}`);
  }
}
