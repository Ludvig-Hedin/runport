import "server-only";
import { InputFile } from "node-appwrite/file";
import { Client, ID, Query, Storage, TablesDB, Users, type Models } from "node-appwrite";
import { createAdminClient } from "@/lib/appwrite";
import type { RunportApp } from "./railway";

// Reads an app's users, data and files with the app's own server key (it has
// read scopes for exactly these), and copies them into the dashboard's own
// "app-backups" bucket before a delete.

export const BACKUP_BUCKET = "app-backups";
const PAGE = 100;

function appClient(app: RunportApp) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT ?? "")
    .setProject(app.slug)
    .setKey(app.appwriteKey);
  return { users: new Users(client), tables: new TablesDB(client), storage: new Storage(client) };
}

/**
 * Raw bytes of a stored file. The SDK's getFileDownload parses JSON files into
 * objects, which would corrupt a byte-for-byte copy, so this asks directly.
 */
async function download(project: string, key: string, bucketId: string, fileId: string): Promise<Uint8Array> {
  const endpoint = (process.env.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "");
  const res = await fetch(`${endpoint}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}/download`, {
    headers: { "X-Appwrite-Project": project, "X-Appwrite-Key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Could not read file ${fileId} (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Reads every page of a list, 100 at a time, using the last id as cursor. */
async function all<T extends { $id: string }>(page: (queries: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const queries = [Query.limit(PAGE), ...(out.length ? [Query.cursorAfter(out[out.length - 1]!.$id)] : [])];
    const batch = await page(queries);
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

export type Inventory = {
  users: number;
  rows: number;
  tables: number;
  files: number;
  bytes: number;
};

type Snapshot = {
  users: Models.User[];
  databases: { database: Models.Database; tables: { table: Models.Table; rows: Models.Row[] }[] }[];
  buckets: { bucket: Models.Bucket; files: Models.File[] }[];
};

async function snapshot(app: RunportApp): Promise<Snapshot> {
  const { users, tables, storage } = appClient(app);
  const [userList, databases, buckets] = await Promise.all([
    all((queries) => users.list({ queries }).then((r) => r.users)),
    all((queries) => tables.list({ queries }).then((r) => r.databases)),
    all((queries) => storage.listBuckets({ queries }).then((r) => r.buckets)),
  ]);
  return {
    users: userList,
    databases: await Promise.all(
      databases.map(async (database) => {
        const list = await all((queries) => tables.listTables({ databaseId: database.$id, queries }).then((r) => r.tables));
        return {
          database,
          tables: await Promise.all(
            list.map(async (table) => ({
              table,
              rows: await all((queries) => tables.listRows({ databaseId: database.$id, tableId: table.$id, queries }).then((r) => r.rows)),
            })),
          ),
        };
      }),
    ),
    buckets: await Promise.all(
      buckets.map(async (bucket) => ({
        bucket,
        files: await all((queries) => storage.listFiles({ bucketId: bucket.$id, queries }).then((r) => r.files)),
      })),
    ),
  };
}

function count(s: Snapshot): Inventory {
  const tables = s.databases.flatMap((d) => d.tables);
  const files = s.buckets.flatMap((b) => b.files);
  return {
    users: s.users.length,
    tables: tables.length,
    rows: tables.reduce((n, t) => n + t.rows.length, 0),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.sizeOriginal, 0),
  };
}

/** What a delete would remove, counted live. */
export async function inventory(app: RunportApp): Promise<Inventory> {
  return count(await snapshot(app));
}

export type BackupStep = "users" | "data" | "files" | "check";
export type BackupResult = { name: string; inventory: Inventory };

/**
 * Copies everything into the dashboard's bucket as "<slug>-<time>.json" plus
 * one copy per file, then reads it back and compares the counts. Throws when
 * anything is missing, so the caller never deletes on a bad backup.
 */
export async function backupApp(app: RunportApp, onStep: (step: BackupStep) => void): Promise<BackupResult> {
  onStep("users");
  const snap = await snapshot(app);
  const expected = count(snap);
  const { storage } = dashboardStorage();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${app.slug}-${stamp}`;

  onStep("files");
  const copies: { bucketId: string; fileId: string; backupFileId: string; size: number }[] = [];
  for (const { bucket, files } of snap.buckets) {
    for (const file of files) {
      const bytes = await download(app.slug, app.appwriteKey, bucket.$id, file.$id);
      const backupFileId = ID.unique();
      const saved = await storage.createFile({
        bucketId: BACKUP_BUCKET,
        fileId: backupFileId,
        file: InputFile.fromBuffer(bytes, `${name}__${bucket.$id}__${file.$id}__${file.name}`.slice(0, 255)),
      });
      if (saved.sizeOriginal !== file.sizeOriginal) throw new Error(`File ${file.name} was not copied whole.`);
      copies.push({ bucketId: bucket.$id, fileId: file.$id, backupFileId, size: saved.sizeOriginal });
    }
  }

  onStep("data");
  const manifest = JSON.stringify({ app: app.slug, takenAt: new Date().toISOString(), counts: expected, ...snap, fileCopies: copies });
  const manifestId = ID.unique();
  await storage.createFile({ bucketId: BACKUP_BUCKET, fileId: manifestId, file: InputFile.fromPlainText(manifest, `${name}.json`) });

  onStep("check");
  const own = { project: process.env.APPWRITE_PROJECT_ID ?? "", key: process.env.APPWRITE_API_KEY ?? "" };
  const readBack = JSON.parse(new TextDecoder().decode(await download(own.project, own.key, BACKUP_BUCKET, manifestId))) as Snapshot & {
    fileCopies: typeof copies;
  };
  const got = count(readBack);
  for (const key of Object.keys(expected) as (keyof Inventory)[]) {
    if (got[key] !== expected[key]) throw new Error(`The backup check failed: ${key} ${got[key]} of ${expected[key]}.`);
  }
  for (const copy of readBack.fileCopies) {
    const stored = await storage.getFile({ bucketId: BACKUP_BUCKET, fileId: copy.backupFileId });
    if (stored.sizeOriginal !== copy.size) throw new Error("The backup check failed: a file copy is missing.");
  }
  return { name, inventory: expected };
}

function dashboardStorage() {
  const { client } = createAdminClient();
  return { storage: new Storage(client) };
}
