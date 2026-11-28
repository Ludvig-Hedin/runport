import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AppwriteException, ID } from "node-appwrite";
import { createAdminClient } from "@/lib/appwrite";
import { AppwriteHttpError, appwriteApi } from "@/lib/ops/appwrite-rest";
import { type BackupStore, countsOf, runBackup, snapshot, Unsupported, verifyBackup } from "@/lib/ops/backup";
import { type DeleteDeps, type DeleteRecord, type DeleteStore, isActive, type SavedKey } from "@/lib/ops/delete-flow";
import { SafeError } from "@/lib/ops/errors";
import { resumeHosting, stopHosting } from "@/lib/ops/hosting";
import { checkPins } from "@/lib/ops/pins";
import { DATABASE_ID } from "@/lib/schema";
import { readApi, writeApi } from "./registry";
import { deleteRailwayProject, gql, freshProjects, type RunportApp, toPins } from "./railway";

// Wires the pure flows in lib/ops to the real services.

export const BACKUP_BUCKET = "app-backups";
/** The dashboard's own two keys in each app. Every other key is switched off during a delete. */
const DASHBOARD_KEYS = new Set(["runport-dashboard-read", "runport-dashboard-write"]);
/** Client-facing Appwrite services switched off during a delete. */
const SERVICES = ["account", "users", "teams", "tablesdb", "databases", "storage", "functions", "messaging", "graphql"];
/** Time for requests already in flight to finish after the app stops. */
const DRAIN_MS = 15_000;

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

const notFound = (e: unknown) => e instanceof AppwriteException && e.code === 404;

// --- Delete records ---------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function deleteStore(name: string): DeleteStore {
  const { tables } = createAdminClient();
  const ids = { databaseId: DATABASE_ID, tableId: "deletions" };
  const toRow = (r: Partial<DeleteRecord>) => {
    const row: Record<string, unknown> = {};
    if (r.slug) row.slug = r.slug;
    if (r.state) row.state = r.state;
    if (r.gen !== undefined) row.gen = String(r.gen);
    if (r.leaseUntil !== undefined) row.leaseUntil = String(r.leaseUntil);
    if ("owner" in r) row.owner = r.owner ?? null;
    if ("prevStatus" in r) row.prevStatus = r.prevStatus ?? null;
    if ("frozenServices" in r) row.frozenServices = r.frozenServices ?? null;
    // Key ids, names, scopes and expiry only. Never a key's secret.
    if ("savedKeys" in r) row.savedKeys = r.savedKeys ? JSON.stringify(r.savedKeys.map(({ id, name, scopes, expire }) => ({ id, name, scopes, expire }))) : null;
    if ("manifestId" in r) row.manifestId = r.manifestId ?? null;
    if ("manifestSha" in r) row.manifestSha = r.manifestSha ?? null;
    if ("backupName" in r) row.backup = r.backupName || "pending";
    if ("counts" in r) row.counts = JSON.stringify(r.counts ?? {});
    if ("error" in r) row.error = r.error ? r.error.slice(0, 500) : null;
    if (r.updatedAt) row.updatedAtMs = String(r.updatedAt);
    return row;
  };
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
          gen: Number(r.gen ?? 0) || 0,
          owner: str(r.owner) ?? "",
          leaseUntil: Number(r.leaseUntil ?? 0) || 0,
          prevStatus: str(r.prevStatus),
          frozenServices: str(r.frozenServices),
          savedKeys: r.savedKeys ? (JSON.parse(String(r.savedKeys)) as SavedKey[]) : undefined,
          manifestId: str(r.manifestId),
          manifestSha: str(r.manifestSha),
          backupName: str(r.backup) === "pending" ? undefined : str(r.backup),
          counts: r.counts && String(r.counts) !== "{}" ? JSON.parse(String(r.counts)) : undefined,
          error: str(r.error),
          updatedAt: Number(r.updatedAtMs ?? 0) || Date.parse(String(r.$updatedAt)),
        };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async update(key, patch) {
      await tables.updateRow({ ...ids, rowId: key, data: toRow(patch) });
    },
    async claim(key, gen) {
      // One row per lease generation: only one run can create it.
      const rowId = `${createHash("sha256").update(key).digest("hex").slice(0, 24)}-${gen}`;
      try {
        await tables.createRow({ databaseId: DATABASE_ID, tableId: "delete_leases", rowId, data: { recordKey: key, gen: String(gen) } });
        return true;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 409) return false;
        throw error;
      }
    },
  };
}

/** The app's delete record, if one is in progress or stuck. */
export async function activeDelete(app: RunportApp): Promise<DeleteRecord | null> {
  const record = await deleteStore(app.pins.name).get(app.pins.railwayProjectId);
  return record && isActive(record.state) ? record : null;
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
    if (notFound(error)) return null;
    throw error;
  }
}

export async function pauseApp(app: RunportApp): Promise<void> {
  const stopped = await stopHosting(gql, toPins(app.pins));
  if (stopped) await rememberPaused(app.pins.slug, stopped.id);
}

/** Resume from the button. Refused while a delete of the app is in progress or stuck. */
export async function resumeApp(app: RunportApp): Promise<void> {
  if (await activeDelete(app)) throw new SafeError("A delete of this app is in progress or needs a check, so it stays stopped.");
  await startAgain(app);
}

async function startAgain(app: RunportApp): Promise<void> {
  await resumeHosting(gql, toPins(app.pins), await pausedDeployment(app.pins.slug));
  await rememberPaused(app.pins.slug, null);
}

// --- What a delete removes --------------------------------------------------

export type Inventory = ReturnType<typeof countsOf> & { blocked: string | null };

const NO_KEYS = "Its backup access is not set up yet; the dashboard setup on your Mac does that.";

export async function inventory(app: RunportApp): Promise<Inventory> {
  const api = readApi(app.pins);
  const none = { users: 0, tables: 0, rows: 0, files: 0, bytes: 0 };
  if (!api || !writeApi(app.pins)) return { ...none, blocked: NO_KEYS };
  // A delete that already has its checked backup: show what that backup holds.
  const active = await activeDelete(app);
  if (active?.counts) return { ...active.counts, blocked: null };
  if (app.extras.length) return { ...none, blocked: `It also has ${app.extras.join(", ")}, which the backup cannot keep.` };
  try {
    return { ...countsOf(await snapshot(api)), blocked: null };
  } catch (error) {
    if (error instanceof Unsupported) return { ...none, blocked: error.message };
    throw error;
  }
}

// --- Delete -------------------------------------------------------------------

type ProjectInfo = { services: { $id: string; enabled: boolean }[] };
type KeyList = { keys: { $id: string; name: string; scopes: string[]; expire: string | null }[] };

export function deleteDeps(app: RunportApp): DeleteDeps {
  const read = readApi(app.pins);
  const write = writeApi(app.pins);
  if (!read || !write) throw new SafeError(NO_KEYS);
  const store = backupStore();
  const pins = toPins(app.pins);
  const source = { appwriteProjectId: app.pins.appwriteProjectId, railwayProjectId: app.pins.railwayProjectId };
  const setServices = async (ids: string[], enabled: boolean) => {
    for (const service of ids.filter((id) => SERVICES.includes(id))) await write.send("PATCH", `/project/services/${service}`, { enabled });
  };
  const putKey = (k: SavedKey, expire: string | null) => write.send("PUT", `/project/keys/${k.id}`, { name: k.name, scopes: k.scopes, expire });
  return {
    store: deleteStore(app.pins.name),
    now: () => Date.now(),
    newOwner: () => randomUUID(),
    source,
    async preflight() {
      if (app.extras.length) throw new Unsupported(`It also has ${app.extras.join(", ")}, which the backup cannot keep.`);
      await snapshot(read);
    },
    currentStatus: async () => app.status,
    async stopHosting() {
      const stopped = await stopHosting(gql, pins, { drainMs: DRAIN_MS });
      if (stopped) await rememberPaused(app.pins.slug, stopped.id);
    },
    restartHosting: () => startAgain(app),
    async readServices() {
      const project = await read.get<ProjectInfo>("/project");
      return JSON.stringify(project.services.filter((s) => SERVICES.includes(s.$id) && s.enabled).map((s) => s.$id));
    },
    freezeWrites: (saved) => setServices(JSON.parse(saved) as string[], false),
    unfreezeWrites: (saved) => setServices(JSON.parse(saved) as string[], true),
    async readKeys() {
      const list = await write.get<KeyList>("/project/keys");
      return list.keys.filter((k) => !DASHBOARD_KEYS.has(k.name)).map((k) => ({ id: k.$id, name: k.name, scopes: k.scopes, expire: k.expire }));
    },
    async expireKeys(keys) {
      // Server keys skip Appwrite's service switches, so they are expired instead.
      const past = new Date(Date.now() - 60_000).toISOString();
      for (const k of keys) await putKey(k, past);
    },
    async restoreKeys(keys) {
      for (const k of keys) await putKey(k, k.expire);
    },
    backup: (onProgress) => runBackup(read, store, () => ID.unique(), source, onProgress),
    async verify(manifestId, manifestSha, expected, onProgress) {
      await verifyBackup(store, manifestId, manifestSha, { expected, source, onProgress });
    },
    async deleteData() {
      await write.send("DELETE", "/project").catch((error) => {
        // Already gone, for example when a retry follows a lost answer.
        if (error instanceof AppwriteHttpError && (error.status === 404 || error.type === "project_not_found")) return;
        throw error;
      });
    },
    async recheckHosting() {
      const now = await freshProjects();
      const result = checkPins(app.pins, now, app.pins.workspaceId, new Set());
      if (result.problem || result.extras.length) {
        throw new SafeError(`The app's Railway project changed during the delete${result.extras.length ? ` (${result.extras.join(", ")})` : ""}. Its hosting was not removed.`);
      }
    },
    deleteHosting: () => deleteRailwayProject(app),
  };
}
