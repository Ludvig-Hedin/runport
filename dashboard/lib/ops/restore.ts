import { type AppwriteApi } from "./appwrite-rest";
import { SafeError } from "./errors";
import { type BackupStore, type Column, type Counts, type Manifest, countsOf, sha256, snapshot, verifyBackup } from "./backup";

// Puts a backup back into an empty Appwrite project: users with their
// password hashes, tables with columns, indexes and rows (same ids and
// permissions), and buckets with every file. Then it reads the project back
// and checks counts and file checksums against the backup.

const enc = encodeURIComponent;

function columnRequest(c: Column): { path: string; body: Record<string, unknown> } {
  const base: Record<string, unknown> = { key: c.key, required: c.required, array: c.array ?? false };
  if (!c.required && c.default !== undefined && c.default !== null) base.default = c.default;
  switch (c.type) {
    case "varchar":
    case "string":
      return { path: "varchar", body: { ...base, size: c.size ?? 255, ...(c.encrypt ? { encrypt: true } : {}) } };
    case "text":
    case "mediumtext":
    case "longtext":
      return { path: c.type, body: { ...base, ...(c.encrypt ? { encrypt: true } : {}) } };
    case "integer":
      return { path: "integer", body: { ...base, min: c.min, max: c.max } };
    case "double":
    case "float":
      return { path: "float", body: { ...base, min: c.min, max: c.max } };
    case "enum":
      return { path: "enum", body: { ...base, elements: c.elements } };
    case "boolean":
    case "datetime":
    case "email":
    case "url":
    case "ip":
      return { path: c.type, body: base };
    default:
      throw new SafeError(`Cannot restore a ${c.type} column.`);
  }
}

async function waitForColumns(api: AppwriteApi, path: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const table = await api.get<{ columns: { status: string }[]; indexes: { status: string }[] }>(path);
    const all = [...table.columns, ...(table.indexes ?? [])];
    if (all.some((c) => c.status === "failed")) throw new SafeError("Appwrite could not create a column or index.");
    if (all.every((c) => c.status === "available")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new SafeError("Columns did not become ready in time.");
}

/** Strips Appwrite's system fields from a row, leaving the data to write back. */
function rowData(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("$")));
}

export async function restoreBackup(store: BackupStore, manifestId: string, manifestSha: string, target: AppwriteApi): Promise<Counts> {
  const manifest = await verifyBackup(store, manifestId, manifestSha);
  const existing = countsOf(await snapshot(target));
  if (existing.users || existing.tables || existing.files) throw new SafeError("Restore needs an empty project.");

  for (const u of manifest.users) {
    const body = { userId: u.$id, email: u.email || undefined, name: u.name };
    if (u.password && u.hash === "argon2") await target.send("POST", "/users/argon2", { ...body, password: u.password });
    else if (u.password && u.hash === "bcrypt") await target.send("POST", "/users/bcrypt", { ...body, password: u.password });
    else await target.send("POST", "/users", { ...body, phone: u.phone || undefined });
    if (u.phone && u.password) await target.send("PATCH", `/users/${enc(u.$id)}/phone`, { number: u.phone });
    if (u.emailVerification) await target.send("PATCH", `/users/${enc(u.$id)}/verification`, { emailVerification: true });
    if (u.phoneVerification) await target.send("PATCH", `/users/${enc(u.$id)}/verification/phone`, { phoneVerification: true });
    if (u.labels?.length) await target.send("PUT", `/users/${enc(u.$id)}/labels`, { labels: u.labels });
    if (u.prefs && Object.keys(u.prefs).length) await target.send("PATCH", `/users/${enc(u.$id)}/prefs`, { prefs: u.prefs });
    if (u.status === false) await target.send("PATCH", `/users/${enc(u.$id)}/status`, { status: false });
  }

  for (const { database, tables } of manifest.databases) {
    await target.send("POST", "/tablesdb", { databaseId: database.$id, name: database.name });
    for (const { table, rows } of tables) {
      const tablePath = `/tablesdb/${enc(database.$id)}/tables/${enc(table.$id)}`;
      await target.send("POST", `/tablesdb/${enc(database.$id)}/tables`, {
        tableId: table.$id, name: table.name, permissions: table.$permissions, rowSecurity: table.rowSecurity, enabled: table.enabled,
      });
      for (const c of table.columns) {
        const { path, body } = columnRequest(c);
        await target.send("POST", `${tablePath}/columns/${path}`, body);
      }
      await waitForColumns(target, tablePath);
      for (const i of table.indexes ?? []) {
        await target.send("POST", `${tablePath}/indexes`, { key: i.key, type: i.type, columns: i.columns, orders: i.orders, lengths: i.lengths });
      }
      await waitForColumns(target, tablePath);
      for (const row of rows) {
        await target.send("POST", `${tablePath}/rows`, { rowId: row.$id, data: rowData(row), permissions: row.$permissions });
      }
    }
  }

  for (const { bucket, files } of manifest.buckets) {
    await target.send("POST", "/storage/buckets", {
      bucketId: bucket.$id, name: bucket.name, permissions: bucket.$permissions, fileSecurity: bucket.fileSecurity, enabled: bucket.enabled,
      maximumFileSize: bucket.maximumFileSize, allowedFileExtensions: bucket.allowedFileExtensions, compression: bucket.compression,
      encryption: bucket.encryption, antivirus: bucket.antivirus,
    });
    for (const f of files) {
      const bytes = await store.get(f.copyId);
      await target.upload(bucket.$id, f.file.$id, f.file.name, bytes, f.file.$permissions);
    }
  }

  return verifyRestore(manifest, target);
}

/** Reads the restored project back and compares it with the backup. */
export async function verifyRestore(manifest: Manifest, target: AppwriteApi): Promise<Counts> {
  const back = await snapshot(target);
  const counts = countsOf(back);
  for (const key of Object.keys(counts) as (keyof Counts)[]) {
    if (counts[key] !== manifest.counts[key]) throw new SafeError(`Restore check failed: ${key} ${counts[key]} of ${manifest.counts[key]}.`);
  }
  const want = new Map(manifest.users.map((u) => [u.$id, u]));
  for (const u of back.users) {
    const w = want.get(u.$id);
    if (!w || w.email !== u.email || (w.password ?? "") !== (u.password ?? "")) throw new SafeError("Restore check failed: a user differs.");
  }
  for (const { bucket, files } of manifest.buckets) {
    for (const f of files) {
      if (sha256(await target.download(bucket.$id, f.file.$id)) !== f.sha256) throw new SafeError(`Restore check failed: ${f.file.name} differs.`);
    }
  }
  const rowsWant = new Map(manifest.databases.flatMap((d) => d.tables.flatMap((t) => t.rows.map((r) => [`${d.database.$id}/${t.table.$id}/${r.$id}`, JSON.stringify(rowData(r))]))));
  for (const d of back.databases) for (const t of d.tables) for (const r of t.rows) {
    if (rowsWant.get(`${d.database.$id}/${t.table.$id}/${r.$id}`) !== JSON.stringify(rowData(r))) throw new SafeError("Restore check failed: a row differs.");
  }
  return counts;
}
