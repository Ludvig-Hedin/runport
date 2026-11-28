import { expect, test } from "bun:test";
import type { BackupResult } from "../lib/ops/backup";
import { DeleteBusy, type DeleteDeps, type DeleteRecord, type DeleteStore, LEASE_MS, runDelete, type SavedKey } from "../lib/ops/delete-flow";
import { SafeError } from "../lib/ops/errors";

// Isolated fixtures: an in-memory record and lease store, fake services that
// record every call, and a clock the test moves. No Appwrite, no Railway.

function memoryStore(): DeleteStore & { rows: Map<string, DeleteRecord>; claims: Set<string> } {
  const rows = new Map<string, DeleteRecord>();
  const claims = new Set<string>();
  return {
    rows,
    claims,
    async create(r) {
      if (rows.has(r.key)) return false;
      rows.set(r.key, { ...r });
      return true;
    },
    async get(key) {
      const r = rows.get(key);
      return r ? { ...r } : null;
    },
    async update(key, patch) {
      rows.set(key, { ...rows.get(key)!, ...patch });
    },
    async claim(key, gen) {
      const id = `${key}:${gen}`;
      if (claims.has(id)) return false;
      claims.add(id);
      return true;
    },
  };
}

const BACKUP: BackupResult = { manifestId: "m1", manifestSha: "sha1", name: "fixture-backup", counts: { users: 2, tables: 1, rows: 3, files: 1, bytes: 10 } };
const KEYS: SavedKey[] = [{ id: "k-app", name: "fixture-online", scopes: ["rows.write"], expire: null }];
const SOURCE = { appwriteProjectId: "fixture", railwayProjectId: "rail-1" };

function fakeDeps(store: DeleteStore, over: Partial<DeleteDeps> = {}, clock = { t: 1_000_000 }) {
  const calls: string[] = [];
  let owners = 0;
  const step = (name: string, result?: unknown) => async () => {
    calls.push(name);
    return result as never;
  };
  const deps: DeleteDeps = {
    store,
    now: () => clock.t,
    newOwner: () => `owner-${++owners}-${Math.random()}`,
    source: SOURCE,
    preflight: step("preflight"),
    currentStatus: step("status", "live"),
    stopHosting: step("stop"),
    restartHosting: step("restart"),
    readServices: step("readServices", '["account","tablesdb"]'),
    freezeWrites: async (saved) => void calls.push(`freeze:${saved}`),
    unfreezeWrites: async (saved) => void calls.push(`unfreeze:${saved}`),
    readKeys: step("readKeys", KEYS),
    expireKeys: async (k) => void calls.push(`expire:${k.map((x) => x.id)}`),
    restoreKeys: async (k) => void calls.push(`restoreKeys:${k.map((x) => x.id)}`),
    backup: step("backup", BACKUP),
    verify: async (id, sha) => void calls.push(`verify:${id}:${sha}`),
    deleteData: step("deleteData"),
    recheckHosting: step("recheck"),
    deleteHosting: step("deleteHosting"),
    forget: step("forget"),
    ...over,
  };
  return { deps, calls };
}

const run = (deps: DeleteDeps) => runDelete("rail-1", "fixture", deps, () => {});

test("a delete stops everything, then backs up, then deletes, checking the backup before each delete", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store);
  const record = await run(deps);
  expect(calls).toEqual([
    "preflight", "status", "stop", "readServices", 'freeze:["account","tablesdb"]', "readKeys", "expire:k-app",
    "backup", "verify:m1:sha1",
    "verify:m1:sha1", "deleteData",
    "verify:m1:sha1", "recheck", "deleteHosting", "forget",
  ]);
  expect(record.state).toBe("done");
});

test("each step's before-state is saved before the step acts", async () => {
  const store = memoryStore();
  const seen: Record<string, DeleteRecord | undefined> = {};
  const { deps } = fakeDeps(store, {
    stopHosting: async () => void (seen.stop = store.rows.get("rail-1")),
    freezeWrites: async () => void (seen.freeze = store.rows.get("rail-1")),
    expireKeys: async () => void (seen.expire = store.rows.get("rail-1")),
    deleteData: async () => void (seen.data = store.rows.get("rail-1")),
  });
  await run(deps);
  expect(seen.stop).toMatchObject({ state: "stopping", prevStatus: "live" });
  expect(seen.freeze?.frozenServices).toBe('["account","tablesdb"]');
  expect(seen.expire?.savedKeys).toEqual(KEYS);
  expect(seen.data).toMatchObject({ state: "backed-up", manifestId: "m1", manifestSha: "sha1" });
});

test("a failed backup deletes nothing and puts keys, services and hosting back", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, { backup: async () => { throw new SafeError("Disk full."); } });
  await expect(run(deps)).rejects.toThrow("back as it was");
  expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  expect(calls.slice(-3)).toEqual(["restoreKeys:k-app", 'unfreeze:["account","tablesdb"]', "restart"]);
  expect(store.rows.get("rail-1")?.state).toBe("aborted");
});

test("if writes cannot be switched back on, the app is not restarted and is marked stuck", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, {
    backup: async () => { throw new SafeError("Disk full."); },
    unfreezeWrites: async () => { throw new Error("Appwrite down"); },
  });
  await expect(run(deps)).rejects.toThrow("needs a check");
  expect(calls).not.toContain("restart");
  expect(store.rows.get("rail-1")?.state).toBe("stuck");
});

test("an app the backup cannot cover is refused before anything changes", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, { preflight: async () => { throw new SafeError("It uses 1 team(s)."); } });
  await expect(run(deps)).rejects.toThrow("team");
  expect(calls).toEqual([]);
  expect(store.rows.get("rail-1")?.state).toBe("aborted");
});

test("two deletes at once: only one runs", async () => {
  const store = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = fakeDeps(store, { backup: async () => { await gate; return BACKUP; } });
  const second = fakeDeps(store);
  const running = run(first.deps);
  await new Promise((r) => setTimeout(r, 5));
  await expect(run(second.deps)).rejects.toBeInstanceOf(DeleteBusy);
  release();
  await running;
  expect(first.calls.filter((c) => c === "deleteData")).toHaveLength(1);
  expect(second.calls).toEqual([]);
});

test("a saved step cannot be taken over while its lease is live", async () => {
  const store = memoryStore();
  const clock = { t: 1_000_000 };
  await store.create({ key: "rail-1", slug: "fixture", state: "backed-up", gen: 3, owner: "working", leaseUntil: clock.t + 60_000, manifestId: "m1", manifestSha: "sha1", updatedAt: clock.t });
  const { deps, calls } = fakeDeps(store, {}, clock);
  await expect(run(deps)).rejects.toBeInstanceOf(DeleteBusy);
  expect(calls).toEqual([]);
});

test("a run that lost its lease stops before deleting", async () => {
  const store = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { deps, calls } = fakeDeps(store, { backup: async () => { await gate; return BACKUP; } });
  const running = run(deps);
  await new Promise((r) => setTimeout(r, 5));
  // Another run took the lease over meanwhile.
  await store.update("rail-1", { gen: 99, owner: "someone-else" });
  release();
  await expect(running).rejects.toThrow("took over");
  expect(calls).not.toContain("deleteData");
  expect(calls).not.toContain("restart");
});

test("only one of two runs can claim an expired lease", async () => {
  const store = memoryStore();
  const clock = { t: 1_000_000 };
  await store.create({ key: "rail-1", slug: "fixture", state: "backed-up", gen: 1, owner: "crashed", leaseUntil: clock.t - 1, manifestId: "m1", manifestSha: "sha1", updatedAt: 0 });
  await store.claim("rail-1", 2); // a competing run already claimed generation 2
  const { deps, calls } = fakeDeps(store, {}, clock);
  await expect(run(deps)).rejects.toBeInstanceOf(DeleteBusy);
  expect(calls).toEqual([]);
});

test("after the lease expires, a retry continues from the saved, re-checked backup", async () => {
  const store = memoryStore();
  const clock = { t: 1_000_000 };
  const first = fakeDeps(store, { deleteData: async () => { throw new Error("timeout"); } }, clock);
  await expect(run(first.deps)).rejects.toThrow("backup is saved");
  expect(store.rows.get("rail-1")?.state).toBe("backed-up");
  clock.t += LEASE_MS + 1;
  const retry = fakeDeps(store, {}, clock);
  await run(retry.deps);
  expect(retry.calls).toEqual(["verify:m1:sha1", "deleteData", "verify:m1:sha1", "recheck", "deleteHosting", "forget"]);
});

test("a data-deleted record without a saved backup id removes no hosting", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "data-deleted", gen: 1, owner: "old", leaseUntil: 0, updatedAt: 0 });
  const { deps, calls } = fakeDeps(store);
  await expect(run(deps)).rejects.toThrow("incomplete");
  expect(calls).toEqual([]);
});

test("a saved backup from another app stops the delete", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "backed-up", gen: 1, owner: "old", leaseUntil: 0, manifestId: "m1", manifestSha: "sha1", updatedAt: 0 });
  const { deps, calls } = fakeDeps(store, { verify: async () => { throw new SafeError("The saved backup belongs to another app. Nothing was deleted."); } });
  await expect(run(deps)).rejects.toThrow("another app");
  expect(calls).toEqual([]);
});

test("a change to the Railway project during the delete keeps the hosting", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, { recheckHosting: async () => { throw new SafeError("The app's Railway project changed during the delete (1 Railway volume(s)). Its hosting was not removed."); } });
  await expect(run(deps)).rejects.toThrow("hosting was not removed");
  expect(calls).not.toContain("deleteHosting");
  expect(store.rows.get("rail-1")?.state).toBe("data-deleted");
});

test("an aborted run is retried from scratch: settings are read again, never reused", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "aborted", gen: 1, owner: "old", leaseUntil: 0, prevStatus: "sleeping", frozenServices: '["storage"]', savedKeys: [], updatedAt: 0 });
  const { deps, calls } = fakeDeps(store);
  await run(deps);
  expect(calls.slice(0, 5)).toEqual(["preflight", "status", "stop", "readServices", 'freeze:["account","tablesdb"]']);
});

test("a stuck run continues with the settings saved before its freeze", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "stuck", gen: 1, owner: "old", leaseUntil: 0, prevStatus: "live", frozenServices: '["account"]', savedKeys: KEYS, updatedAt: 0 });
  const { deps, calls } = fakeDeps(store);
  await run(deps);
  expect(calls.slice(0, 3)).toEqual(["stop", 'freeze:["account"]', "expire:k-app"]);
  expect(calls).not.toContain("readServices");
  expect(calls).not.toContain("readKeys");
});

test("a finished delete is not run again", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "done", gen: 1, owner: "old", leaseUntil: 0, updatedAt: 0 });
  const { deps, calls } = fakeDeps(store);
  expect((await run(deps)).state).toBe("done");
  expect(calls).toEqual([]);
});
