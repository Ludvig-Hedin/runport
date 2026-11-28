import { expect, test } from "bun:test";
import type { AppwriteApi } from "../lib/ops/appwrite-rest";
import { type BackupStore, runBackup, sha256, Unsupported, verifyBackup } from "../lib/ops/backup";
import { restoreBackup } from "../lib/ops/restore";

// An in-memory Appwrite project: just enough of the REST surface that backup
// and restore use. Each test builds its own, so nothing is shared.

type Row = Record<string, unknown> & { $id: string; $permissions: string[] };
type Project = {
  users: Record<string, unknown>[];
  teams: number;
  dbs: { $id: string; name: string; tables: { $id: string; name: string; $permissions: string[]; rowSecurity: boolean; enabled: boolean; columns: Record<string, unknown>[]; indexes: Record<string, unknown>[]; rows: Row[] }[] }[];
  buckets: { $id: string; name: string; $permissions: string[]; fileSecurity: boolean; enabled: boolean; maximumFileSize: number; allowedFileExtensions: string[]; compression: string; encryption: boolean; antivirus: boolean; files: { $id: string; name: string; $permissions: string[]; sizeOriginal: number; mimeType: string; bytes: Uint8Array }[] }[];
};

function fakeProject(id: string, p: Project): AppwriteApi {
  const strip = (path: string) => path.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  const table = (db: string, t: string) => p.dbs.find((d) => d.$id === db)!.tables.find((x) => x.$id === t)!;
  return {
    project: id,
    async get<T>(path: string): Promise<T> {
      const s = strip(path);
      const r = (v: unknown) => v as T;
      if (s[0] === "teams") return r({ total: p.teams });
      if (s[0] === "functions") return r({ total: 0 });
      if (s[0] === "users") return r({ users: p.users });
      if (s[0] === "tablesdb" && s.length === 1) return r({ databases: p.dbs.map(({ tables, ...d }) => d) });
      if (s[0] === "tablesdb" && s.length === 3) return r({ tables: p.dbs.find((d) => d.$id === s[1])!.tables.map(({ rows, ...t }) => t) });
      if (s[0] === "tablesdb" && s.length === 4) {
        const { rows, ...t } = table(s[1]!, s[3]!);
        return r({ ...t, columns: t.columns.map((c) => ({ ...c, status: "available" })), indexes: t.indexes.map((i) => ({ ...i, status: "available" })) });
      }
      if (s[0] === "tablesdb" && s[4] === "rows") return r({ rows: table(s[1]!, s[3]!).rows });
      if (s[0] === "storage" && s.length === 2) return r({ buckets: p.buckets.map(({ files, ...b }) => b) });
      if (s[0] === "storage" && s[3] === "files") return r({ files: p.buckets.find((b) => b.$id === s[2])!.files.map(({ bytes, ...f }) => f) });
      throw new Error(`fake GET ${path}`);
    },
    async send<T>(method: string, path: string, body?: any): Promise<T> {
      const s = strip(path);
      if (method === "POST" && s[0] === "users") {
        p.users.push({ $id: body.userId, email: body.email ?? "", name: body.name ?? "", phone: body.phone ?? "", password: body.password ?? "", hash: s[1] ?? "argon2", emailVerification: false, phoneVerification: false, status: true, labels: [], prefs: {} });
      } else if (method === "PATCH" && s[0] === "users" && s[2] === "verification") {
        Object.assign(p.users.find((u) => u.$id === s[1])!, { emailVerification: body.emailVerification });
      } else if (s[0] === "users") {
        // labels, prefs, status: accepted
      } else if (method === "POST" && s[0] === "tablesdb" && s.length === 1) {
        p.dbs.push({ $id: body.databaseId, name: body.name, tables: [] });
      } else if (method === "POST" && s[0] === "tablesdb" && s.length === 3) {
        p.dbs.find((d) => d.$id === s[1])!.tables.push({ $id: body.tableId, name: body.name, $permissions: body.permissions, rowSecurity: body.rowSecurity, enabled: body.enabled, columns: [], indexes: [], rows: [] });
      } else if (method === "POST" && s[4] === "columns") {
        table(s[1]!, s[3]!).columns.push({ ...body, type: s[5] === "float" ? "double" : s[5] });
      } else if (method === "POST" && s[4] === "indexes") {
        table(s[1]!, s[3]!).indexes.push(body);
      } else if (method === "POST" && s[4] === "rows") {
        table(s[1]!, s[3]!).rows.push({ $id: body.rowId, $permissions: body.permissions, ...body.data });
      } else if (method === "POST" && s[0] === "storage") {
        p.buckets.push({ $id: body.bucketId, name: body.name, $permissions: body.permissions, fileSecurity: body.fileSecurity, enabled: body.enabled, maximumFileSize: body.maximumFileSize, allowedFileExtensions: body.allowedFileExtensions, compression: body.compression, encryption: body.encryption, antivirus: body.antivirus, files: [] });
      } else throw new Error(`fake ${method} ${path}`);
      return undefined as T;
    },
    async download(bucketId, fileId) {
      return p.buckets.find((b) => b.$id === bucketId)!.files.find((f) => f.$id === fileId)!.bytes;
    },
    async upload(bucketId, fileId, name, bytes, permissions) {
      p.buckets.find((b) => b.$id === bucketId)!.files.push({ $id: fileId, name, $permissions: permissions ?? [], sizeOriginal: bytes.length, mimeType: "", bytes });
      return { $id: fileId, sizeOriginal: bytes.length };
    },
  };
}

function memoryStore(): BackupStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, put: async (id, _name, bytes) => void files.set(id, bytes.slice()), get: async (id) => files.get(id)!.slice() };
}

const empty = (): Project => ({ users: [], teams: 0, dbs: [], buckets: [] });
const enc = (s: string) => new TextEncoder().encode(s);
const jsonBytes = enc('{"note":"a JSON file must come back byte for byte","n":1}\n');
const binBytes = new Uint8Array([0, 255, 1, 254, 2, 253]);

function seeded(): Project {
  return {
    users: [
      { $id: "u1", email: "a@example.test", name: "A", phone: "", password: "$argon2id$v=19$m=7168,t=5,p=1$c2FsdA$aGFzaA", hash: "argon2", emailVerification: true, phoneVerification: false, status: true, labels: [], prefs: {} },
      { $id: "u2", email: "b@example.test", name: "B", phone: "", password: "", hash: "argon2", emailVerification: false, phoneVerification: false, status: true, labels: [], prefs: {} },
    ],
    teams: 0,
    dbs: [{
      $id: "main", name: "Main",
      tables: [{
        $id: "items", name: "Items", $permissions: ['create("users")'], rowSecurity: true, enabled: true,
        columns: [{ key: "title", type: "varchar", size: 255, required: true }, { key: "done", type: "boolean", required: false, default: false }],
        indexes: [],
        rows: [
          { $id: "r1", $permissions: ['read("user:u1")'], title: "Buy milk", done: false },
          { $id: "r2", $permissions: ['read("user:u2")'], title: "Walk", done: true },
        ],
      }],
    }],
    buckets: [{
      $id: "uploads", name: "Uploads", $permissions: [], fileSecurity: true, enabled: true, maximumFileSize: 30_000_000, allowedFileExtensions: [], compression: "none", encryption: true, antivirus: false,
      files: [
        { $id: "f1", name: "data.json", $permissions: ['read("user:u1")'], sizeOriginal: jsonBytes.length, mimeType: "application/json", bytes: jsonBytes },
        { $id: "f2", name: "blob.bin", $permissions: [], sizeOriginal: binBytes.length, mimeType: "application/octet-stream", bytes: binBytes },
      ],
    }],
  };
}

const SRC = { appwriteProjectId: "fixture", railwayProjectId: "rail-1" };
let ids = 0;
const newId = () => `copy-${++ids}`;

test("backup copies everything with checksums and verifies byte for byte", async () => {
  const store = memoryStore();
  const result = await runBackup(fakeProject("fixture", seeded()), store, newId, SRC);
  expect(result.counts).toEqual({ users: 2, tables: 1, rows: 2, files: 2, bytes: jsonBytes.length + binBytes.length });
  const manifest = await verifyBackup(store, result.manifestId, result.manifestSha, { expected: result.counts, source: SRC });
  expect(manifest.buckets[0]!.files.map((f) => f.sha256)).toEqual([sha256(jsonBytes), sha256(binBytes)]);
});

test("a changed file copy fails the check", async () => {
  const store = memoryStore();
  const result = await runBackup(fakeProject("fixture", seeded()), store, newId, SRC);
  const manifest = JSON.parse(new TextDecoder().decode(store.files.get(result.manifestId)!));
  store.files.set(manifest.buckets[0].files[0].copyId, enc('{"note":"tampered"}'));
  await expect(verifyBackup(store, result.manifestId, result.manifestSha)).rejects.toThrow("does not match");
});

test("a changed manifest fails the check", async () => {
  const store = memoryStore();
  const result = await runBackup(fakeProject("fixture", seeded()), store, newId, SRC);
  await expect(verifyBackup(store, result.manifestId, sha256("something else"))).rejects.toThrow("does not match");
});

test("apps with teams are refused, since memberships cannot be restored yet", async () => {
  const p = seeded();
  p.teams = 1;
  await expect(runBackup(fakeProject("fixture", p), memoryStore(), newId, SRC)).rejects.toBeInstanceOf(Unsupported);
});

test("an unknown password hash or column type is refused", async () => {
  const a = seeded();
  (a.users[0] as { hash: string }).hash = "scrypt";
  await expect(runBackup(fakeProject("fixture", a), memoryStore(), newId, SRC)).rejects.toBeInstanceOf(Unsupported);
  const b = seeded();
  b.dbs[0]!.tables[0]!.columns.push({ key: "parent", type: "relationship", required: false });
  await expect(runBackup(fakeProject("fixture", b), memoryStore(), newId, SRC)).rejects.toBeInstanceOf(Unsupported);
});

test("restore into an empty isolated project gives back the same users, rows and file bytes", async () => {
  const store = memoryStore();
  const source = seeded();
  const result = await runBackup(fakeProject("fixture", source), store, newId, SRC);
  const target = empty();
  const counts = await restoreBackup(store, result.manifestId, result.manifestSha, fakeProject("restore-target", target));
  expect(counts).toEqual(result.counts);
  expect(target.users.map((u) => [u.$id, u.email, u.password])).toEqual(source.users.map((u) => [u.$id, u.email, u.password]));
  expect(target.dbs[0]!.tables[0]!.rows).toEqual(source.dbs[0]!.tables[0]!.rows);
  expect(target.buckets[0]!.files.map((f) => sha256(f.bytes))).toEqual([sha256(jsonBytes), sha256(binBytes)]);
});

test("restore refuses a project that is not empty", async () => {
  const store = memoryStore();
  const result = await runBackup(fakeProject("fixture", seeded()), store, newId, SRC);
  await expect(restoreBackup(store, result.manifestId, result.manifestSha, fakeProject("busy", seeded()))).rejects.toThrow("empty project");
});

test("a backup from another app fails the check", async () => {
  const store = memoryStore();
  const result = await runBackup(fakeProject("fixture", seeded()), store, newId, SRC);
  await expect(verifyBackup(store, result.manifestId, result.manifestSha, { source: { appwriteProjectId: "other", railwayProjectId: "rail-1" } })).rejects.toThrow("another app");
});

test("users with two-step sign-in are refused", async () => {
  const p = seeded();
  (p.users[0] as { mfa?: boolean }).mfa = true;
  await expect(runBackup(fakeProject("fixture", p), memoryStore(), newId, SRC)).rejects.toThrow("two-step");
});
