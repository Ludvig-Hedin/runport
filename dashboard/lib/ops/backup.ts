import { createHash } from "node:crypto";
import { type AppwriteApi, listAll } from "./appwrite-rest";

// The backup taken right before an app is deleted. It covers everything the
// delete removes from Appwrite: users (with password hashes), tables with
// their columns, indexes and rows, and buckets with every file's bytes. It
// refuses apps that use things it cannot restore yet, so a delete never
// destroys data the backup leaves out. restore.ts puts a backup back.

export const MANIFEST_VERSION = 1;
/** Appwrite's default upload limit on this Runport. Bigger files are refused, not skipped. */
export const MAX_FILE_BYTES = 30_000_000;

type Doc = { $id: string; [key: string]: unknown };
export type Column = { key: string; type: string; required: boolean; array?: boolean; size?: number; min?: number; max?: number; default?: unknown; elements?: string[]; format?: string; encrypt?: boolean };
export type Index = { key: string; type: string; columns: string[]; orders?: string[]; lengths?: number[] };
export type TableDoc = Doc & { name: string; $permissions: string[]; rowSecurity: boolean; enabled: boolean; columns: Column[]; indexes: Index[] };
export type UserDoc = Doc & { email: string; name: string; phone: string; password?: string; hash?: string; hashOptions?: Record<string, unknown>; emailVerification: boolean; phoneVerification: boolean; status: boolean; labels: string[]; prefs: Record<string, unknown> };
export type BucketDoc = Doc & { name: string; $permissions: string[]; fileSecurity: boolean; enabled: boolean; maximumFileSize: number; allowedFileExtensions: string[]; compression: string; encryption: boolean; antivirus: boolean };
export type FileDoc = Doc & { name: string; $permissions: string[]; sizeOriginal: number; mimeType: string };

export type Counts = { users: number; tables: number; rows: number; files: number; bytes: number };

export type Manifest = {
  version: number;
  app: string;
  takenAt: string;
  counts: Counts;
  users: UserDoc[];
  databases: { database: Doc & { name: string }; tables: { table: TableDoc; rows: Doc[] }[] }[];
  buckets: { bucket: BucketDoc; files: { file: FileDoc; sha256: string; copyId: string }[] }[];
};

/** Where backups are kept: the dashboard's own private bucket. */
export type BackupStore = {
  put(fileId: string, name: string, bytes: Uint8Array): Promise<void>;
  get(fileId: string): Promise<Uint8Array>;
};

export class Unsupported extends Error {}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const RESTORABLE_COLUMNS = new Set(["varchar", "text", "mediumtext", "longtext", "string", "integer", "double", "float", "boolean", "datetime", "email", "url", "ip", "enum"]);
const RESTORABLE_HASHES = new Set(["argon2", "bcrypt"]);

/** Everything in the project the delete would remove, read with a read-only key. */
export async function snapshot(api: AppwriteApi): Promise<Omit<Manifest, "buckets" | "counts" | "takenAt" | "version"> & { buckets: { bucket: BucketDoc; files: FileDoc[] }[] }> {
  // Things the backup cannot restore. Refuse instead of losing them.
  const teams = await api.get<{ total: number }>("/teams");
  if (teams.total > 0) throw new Unsupported(`It uses ${teams.total} team(s), and team memberships cannot be backed up yet.`);
  const functions = await api.get<{ total: number }>("/functions");
  if (functions.total > 0) throw new Unsupported("It has Appwrite functions, which cannot be backed up yet.");

  const users = await listAll<UserDoc>(api, "/users", "users");
  for (const u of users) {
    if (u.password && !RESTORABLE_HASHES.has(String(u.hash))) throw new Unsupported(`A user has a ${u.hash} password, which cannot be restored yet.`);
  }

  const databases = await Promise.all(
    (await listAll<Doc & { name: string }>(api, "/tablesdb", "databases")).map(async (database) => {
      const tables = await listAll<TableDoc>(api, `/tablesdb/${database.$id}/tables`, "tables");
      return {
        database,
        tables: await Promise.all(
          tables.map(async (table) => {
            for (const c of table.columns) {
              if (!RESTORABLE_COLUMNS.has(c.type)) throw new Unsupported(`Table ${table.name} has a ${c.type} column, which cannot be restored yet.`);
            }
            return { table, rows: await listAll<Doc>(api, `/tablesdb/${database.$id}/tables/${table.$id}/rows`, "rows") };
          }),
        ),
      };
    }),
  );

  const buckets = await Promise.all(
    (await listAll<BucketDoc>(api, "/storage/buckets", "buckets")).map(async (bucket) => {
      const files = await listAll<FileDoc>(api, `/storage/buckets/${bucket.$id}/files`, "files");
      for (const f of files) if (f.sizeOriginal > MAX_FILE_BYTES) throw new Unsupported(`The file ${f.name} is too big to back up here.`);
      return { bucket, files };
    }),
  );
  return { app: api.project, users, databases, buckets };
}

type Countable = Pick<Manifest, "users" | "databases"> & { buckets: { files: (FileDoc | { file: FileDoc })[] }[] };

export function countsOf(m: Countable): Counts {
  const tables = m.databases.flatMap((d) => d.tables);
  const files = m.buckets.flatMap((b) => b.files.map((f) => ("file" in f ? f.file : f) as FileDoc));
  return {
    users: m.users.length,
    tables: tables.length,
    rows: tables.reduce((n, t) => n + t.rows.length, 0),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.sizeOriginal, 0),
  };
}

export type BackupResult = { manifestId: string; manifestSha: string; name: string; counts: Counts };

/**
 * Copies every file (with its checksum) and then the manifest into the store,
 * named "<app>-<time>". Call it only after writes are stopped.
 */
export async function runBackup(api: AppwriteApi, store: BackupStore, newId: () => string, onStep: (s: "data" | "files") => void = () => {}): Promise<BackupResult> {
  onStep("data");
  const snap = await snapshot(api);
  const name = `${api.project}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  onStep("files");
  const buckets: Manifest["buckets"] = [];
  for (const { bucket, files } of snap.buckets) {
    const copies: Manifest["buckets"][number]["files"] = [];
    for (const file of files) {
      const bytes = await api.download(bucket.$id, file.$id);
      if (bytes.length !== file.sizeOriginal) throw new Error(`The file ${file.name} did not download whole.`);
      const copyId = newId();
      await store.put(copyId, `${name}__${bucket.$id}__${file.$id}`.slice(0, 255), bytes);
      copies.push({ file, sha256: sha256(bytes), copyId });
    }
    buckets.push({ bucket, files: copies });
  }
  const manifest: Manifest = { version: MANIFEST_VERSION, takenAt: new Date().toISOString(), counts: countsOf({ ...snap, buckets }), ...snap, buckets };
  const text = JSON.stringify(manifest);
  const manifestId = newId();
  await store.put(manifestId, `${name}.json`, new TextEncoder().encode(text));
  return { manifestId, manifestSha: sha256(text), name, counts: manifest.counts };
}

/**
 * Reads the backup back from the store and checks it byte for byte: the
 * manifest's checksum and every file copy's checksum. Returns the manifest.
 */
export async function verifyBackup(store: BackupStore, manifestId: string, manifestSha: string, expected?: Counts): Promise<Manifest> {
  const raw = await store.get(manifestId);
  if (sha256(raw) !== manifestSha) throw new Error("The backup check failed: the saved list does not match.");
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
  if (manifest.version !== MANIFEST_VERSION) throw new Error("The backup check failed: unknown backup format.");
  const counts = countsOf(manifest);
  for (const key of Object.keys(counts) as (keyof Counts)[]) {
    if (counts[key] !== manifest.counts[key] || (expected && counts[key] !== expected[key])) {
      throw new Error(`The backup check failed: ${key} ${counts[key]} of ${expected?.[key] ?? manifest.counts[key]}.`);
    }
  }
  for (const { files } of manifest.buckets) {
    for (const f of files) {
      if (sha256(await store.get(f.copyId)) !== f.sha256) throw new Error(`The backup check failed: the copy of ${f.file.name} does not match.`);
    }
  }
  return manifest;
}
