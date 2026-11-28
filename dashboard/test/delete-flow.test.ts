import { expect, test } from "bun:test";
import type { BackupResult } from "../lib/ops/backup";
import { DeleteBusy, type DeleteDeps, type DeleteRecord, type DeleteStore, runDelete, STALE_MS } from "../lib/ops/delete-flow";

// Isolated fixtures: an in-memory lock store and fake services that record
// every call. Nothing here talks to Appwrite or Railway.

function memoryStore(): DeleteStore & { rows: Map<string, DeleteRecord> } {
  const rows = new Map<string, DeleteRecord>();
  return {
    rows,
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
  };
}

const BACKUP: BackupResult = { manifestId: "m1", manifestSha: "sha1", name: "fixture-backup", counts: { users: 2, tables: 1, rows: 3, files: 1, bytes: 10 } };

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
    preflight: step("preflight"),
    stopHosting: step("stop", "live"),
    restartHosting: async (prev) => void calls.push(`restart:${prev}`),
    freezeWrites: step("freeze"),
    unfreezeWrites: step("unfreeze"),
    backup: step("backup", BACKUP),
    verify: async (id, sha) => void calls.push(`verify:${id}:${sha}`),
    deleteData: step("deleteData"),
    deleteHosting: step("deleteHosting"),
    ...over,
  };
  return { deps, calls };
}

test("a delete stops and freezes first, saves the verified backup, then deletes", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store);
  const steps: string[] = [];
  const record = await runDelete("rail-1", "fixture", deps, (s) => steps.push(s));
  expect(calls).toEqual(["preflight", "stop", "freeze", "backup", "verify:m1:sha1", "deleteData", "deleteHosting"]);
  expect(steps).toEqual(["stop", "backup", "check", "data", "hosting", "done"]);
  expect(record.state).toBe("done");
  expect(store.rows.get("rail-1")).toMatchObject({ state: "done", manifestId: "m1", manifestSha: "sha1", prevStatus: "live" });
});

test("the verified backup id is saved before anything is deleted", async () => {
  const store = memoryStore();
  let savedWhenDeleting: DeleteRecord | undefined;
  const { deps } = fakeDeps(store, {
    deleteData: async () => {
      savedWhenDeleting = store.rows.get("rail-1");
    },
  });
  await runDelete("rail-1", "fixture", deps, () => {});
  expect(savedWhenDeleting).toMatchObject({ state: "backed-up", manifestId: "m1", manifestSha: "sha1" });
});

test("a failed backup deletes nothing and puts the app back", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, { backup: async () => { throw new Error("disk full"); } });
  await expect(runDelete("rail-1", "fixture", deps, () => {})).rejects.toThrow("disk full");
  expect(calls).not.toContain("deleteData");
  expect(calls).not.toContain("deleteHosting");
  expect(calls).toContain("unfreeze");
  expect(calls).toContain("restart:live");
  expect(store.rows.get("rail-1")?.state).toBe("aborted");
});

test("a backup that fails its check deletes nothing", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, { verify: async () => { throw new Error("The backup check failed"); } });
  await expect(runDelete("rail-1", "fixture", deps, () => {})).rejects.toThrow("check failed");
  expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  expect(store.rows.get("rail-1")?.state).toBe("aborted");
});

test("an app the backup cannot cover is refused before anything changes", async () => {
  const store = memoryStore();
  const { deps, calls } = fakeDeps(store, { preflight: async () => { throw new Error("It uses 1 team(s)"); } });
  await expect(runDelete("rail-1", "fixture", deps, () => {})).rejects.toThrow("team");
  expect(calls).toEqual([]);
  expect(store.rows.get("rail-1")?.state).toBe("aborted");
});

test("two deletes at once: only one runs, the other is refused", async () => {
  const store = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = fakeDeps(store, { backup: async () => { await gate; return BACKUP; } });
  const second = fakeDeps(store);
  const running = runDelete("rail-1", "fixture", first.deps, () => {});
  await new Promise((r) => setTimeout(r, 5));
  await expect(runDelete("rail-1", "fixture", second.deps, () => {})).rejects.toBeInstanceOf(DeleteBusy);
  release();
  await running;
  expect(first.calls.filter((c) => c === "deleteData")).toHaveLength(1);
  expect(second.calls).toEqual([]);
});

test("a retry after the backup continues only from the saved, re-checked backup", async () => {
  const store = memoryStore();
  const clock = { t: 1_000_000 };
  const first = fakeDeps(store, { deleteData: async () => { throw new Error("Appwrite timed out"); } }, clock);
  await expect(runDelete("rail-1", "fixture", first.deps, () => {})).rejects.toThrow("backup is saved");
  expect(store.rows.get("rail-1")?.state).toBe("backed-up");

  const retry = fakeDeps(store, {}, clock);
  await runDelete("rail-1", "fixture", retry.deps, () => {});
  // No new backup, no new stop: the saved one is checked again, then the deletes run.
  expect(retry.calls).toEqual(["verify:m1:sha1", "deleteData", "deleteHosting"]);
});

test("a retry refuses to delete without a saved backup id", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "backed-up", owner: "old", updatedAt: 0 });
  const { deps, calls } = fakeDeps(store);
  await expect(runDelete("rail-1", "fixture", deps, () => {})).rejects.toThrow("incomplete");
  expect(calls).toEqual([]);
});

test("a retry whose saved backup no longer checks out deletes nothing", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "backed-up", owner: "old", manifestId: "m1", manifestSha: "sha1", updatedAt: 0 });
  const { deps, calls } = fakeDeps(store, { verify: async () => { throw new Error("The backup check failed"); } });
  await expect(runDelete("rail-1", "fixture", deps, () => {})).rejects.toThrow("check failed");
  expect(calls).toEqual([]);
});

test("a crashed run can be taken over once it is stale, keeping the app stopped", async () => {
  const store = memoryStore();
  const clock = { t: 1_000_000 };
  await store.create({ key: "rail-1", slug: "fixture", state: "frozen", owner: "crashed", prevStatus: "sleeping", updatedAt: clock.t });
  const early = fakeDeps(store, {}, clock);
  await expect(runDelete("rail-1", "fixture", early.deps, () => {})).rejects.toBeInstanceOf(DeleteBusy);

  clock.t += STALE_MS + 1;
  const later = fakeDeps(store, {}, clock);
  await runDelete("rail-1", "fixture", later.deps, () => {});
  // Already stopped by the crashed run: no second stop, freeze again, then the rest.
  expect(later.calls).toEqual(["freeze", "backup", "verify:m1:sha1", "deleteData", "deleteHosting"]);
  expect(store.rows.get("rail-1")?.prevStatus).toBe("sleeping");
});

test("a finished delete is not run again", async () => {
  const store = memoryStore();
  await store.create({ key: "rail-1", slug: "fixture", state: "done", owner: "old", updatedAt: 0 });
  const { deps, calls } = fakeDeps(store);
  const record = await runDelete("rail-1", "fixture", deps, () => {});
  expect(record.state).toBe("done");
  expect(calls).toEqual([]);
});
