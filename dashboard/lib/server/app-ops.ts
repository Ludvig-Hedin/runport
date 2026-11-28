import "server-only";
import { randomUUID } from "node:crypto";
import { AppwriteException, ID } from "node-appwrite";
import { createAdminClient } from "@/lib/appwrite";
import { AppwriteHttpError, appwriteApi } from "@/lib/ops/appwrite-rest";
import { type BackupStore, countsOf, runBackup, snapshot, verifyBackup, Unsupported } from "@/lib/ops/backup";
import type { DeleteDeps, DeleteRecord, DeleteStore } from "@/lib/ops/delete-flow";
import { pauseHosting, resumeHosting } from "@/lib/ops/hosting";
import { DATABASE_ID } from "@/lib/schema";
import { readApi, writeApi } from "./registry";
import { deleteRailwayProject, gql, type RunportApp, toPins } from "./railway";

// Wires the pure flows in lib/ops to the real services.

export const BACKUP_BUCKET = "app-backups";

/** The dashboard's own private bucket, through its own key. */
export function backupStore(): BackupStore {
  const api = appwriteApi(process.env.APPWRITE_ENDPOINT ?? "", process.env.APPWRITE_PROJECT_ID ?? "", process.env.APPWRITE_API_KEY ?? "");
  return {
    async put(fileId, name, bytes) {
      await api.upload(BACKUP_BUCKET, fileId, name, bytes);
    },
    get: (fileId) => api.download(BACKUP_BUCKET, fileId),
  };
}

// --- Pause and resume ------------------------------------------------------

async function rememberPaused(slug: string, deploymentId: string | null): Promise<void> {
  const { tables } = createAdminClient();
  await tables.upsertRow({ databaseId: DATABASE_ID, tableId: "app_state", rowId: slug, data: { slug, pausedDeploymentId: deploymentId, pausedAt: new Date().toISOString() } });
}

async function pausedDeployment(slug: string): Promise<string | null> {
  const { tables } = createAdminClient();
  try {
    const row = await tables.getRow({ databaseId: DATABASE_ID, tableId: "app_state", rowId: slug });
    return (row.pausedDeploymentId as string | null) ?? null;
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return null;
    throw error;
  }
}

export async function pauseApp(app: RunportApp): Promise<void> {
  const stopped = await pauseHosting(gql, toPins(app.pins));
  if (stopped) await rememberPaused(app.pins.slug, stopped.id);
}

export async function resumeApp(app: RunportApp): Promise<void> {
  await resumeHosting(gql, toPins(app.pins), await pausedDeployment(app.pins.slug));
  await rememberPaused(app.pins.slug, null);
}

// --- What a delete removes --------------------------------------------------

export type Inventory = ReturnType<typeof countsOf> & { blocked: string | null };

export async function inventory(app: RunportApp): Promise<Inventory> {
  const api = readApi(app.pins);
  if (!api) return { users: 0, tables: 0, rows: 0, files: 0, bytes: 0, blocked: "This app has no backup key yet. Run sync-dashboard on the Mac." };
  if (app.extras.length) {
    const counts = countsOf(await snapshot(api).catch(() => ({ users: [], databases: [], buckets: [] })));
    return { ...counts, blocked: `It also has ${app.extras.join(", ")}, which the backup cannot keep.` };
  }
  try {
    return { ...countsOf(await snapshot(api)), blocked: null };
  } catch (error) {
    if (error instanceof Unsupported) return { users: 0, tables: 0, rows: 0, files: 0, bytes: 0, blocked: error.message };
    throw error;
  }
}

// --- Delete -------------------------------------------------------------------

/** Client-facing Appwrite services switched off during a delete. Server keys still read. */
const SERVICES = ["account", "users", "teams", "tablesdb", "databases", "storage", "functions", "messaging", "graphql"];

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function deleteStore(name: string): DeleteStore {
  const { tables } = createAdminClient();
  const ids = { databaseId: DATABASE_ID, tableId: "deletions" };
  const toRow = (r: Partial<DeleteRecord>) => ({
    ...(r.slug ? { slug: r.slug } : {}),
    ...(r.state ? { state: r.state } : {}),
    ...("owner" in r ? { owner: r.owner ?? null } : {}),
    ...("prevStatus" in r ? { prevStatus: r.prevStatus ?? null } : {}),
    ...("manifestId" in r ? { manifestId: r.manifestId ?? null } : {}),
    ...("manifestSha" in r ? { manifestSha: r.manifestSha ?? null } : {}),
    ...("backupName" in r ? { backup: r.backupName || "pending" } : {}),
    ...("counts" in r ? { counts: JSON.stringify(r.counts ?? {}) } : {}),
    ...("error" in r ? { error: r.error ? r.error.slice(0, 500) : null } : {}),
    ...(r.updatedAt ? { updatedAtMs: String(r.updatedAt) } : {}),
  });
  return {
    async create(record) {
      try {
        await tables.createRow({ ...ids, rowId: record.key, data: { name, backup: "pending", counts: "{}", ...toRow(record) } });
        return true;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 409) return false;
        throw error;
      }
    },
    async get(key) {
      try {
        const r = await tables.getRow({ ...ids, rowId: key });
        return {
          key,
          slug: String(r.slug),
          state: (str(r.state) ?? "done") as DeleteRecord["state"],
          owner: str(r.owner) ?? "",
          prevStatus: str(r.prevStatus),
          manifestId: str(r.manifestId),
          manifestSha: str(r.manifestSha),
          backupName: str(r.backup) === "pending" ? undefined : str(r.backup),
          counts: r.counts ? JSON.parse(String(r.counts)) : undefined,
          error: str(r.error),
          updatedAt: Number(r.updatedAtMs ?? 0) || Date.parse(String(r.$updatedAt)),
        };
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404) return null;
        throw error;
      }
    },
    async update(key, patch) {
      await tables.updateRow({ ...ids, rowId: key, data: toRow(patch) });
    },
  };
}

export function deleteDeps(app: RunportApp): DeleteDeps {
  const read = readApi(app.pins);
  const write = writeApi(app.pins);
  if (!read || !write) throw new Error("This app has no keys for a delete yet. Run sync-dashboard on the Mac.");
  const store = backupStore();
  const setServices = async (enabled: boolean) => {
    for (const service of SERVICES) {
      await write.send("PATCH", `/project/services/${service}`, { enabled }).catch((error) => {
        // A service this Appwrite version does not have.
        if (error instanceof AppwriteHttpError && error.status === 400) return;
        throw error;
      });
    }
  };
  return {
    store: deleteStore(app.pins.name),
    now: () => Date.now(),
    newOwner: () => randomUUID(),
    async preflight() {
      if (app.extras.length) throw new Unsupported(`It also has ${app.extras.join(", ")}, which the backup cannot keep.`);
      await snapshot(read);
    },
    async stopHosting() {
      const before = app.status;
      await pauseApp(app);
      return before;
    },
    async restartHosting(prev) {
      if (prev === "live" || prev === "sleeping") await resumeApp(app);
    },
    freezeWrites: () => setServices(false),
    unfreezeWrites: () => setServices(true),
    backup: () => runBackup(read, store, () => ID.unique()),
    async verify(manifestId, manifestSha, expected) {
      await verifyBackup(store, manifestId, manifestSha, expected);
    },
    async deleteData() {
      await write.send("DELETE", "/project").catch((error) => {
        // Already gone, for example when a retry follows a lost answer.
        if (error instanceof AppwriteHttpError && (error.status === 404 || error.type === "project_not_found")) return;
        throw error;
      });
    },
    deleteHosting: () => deleteRailwayProject(app),
  };
}
