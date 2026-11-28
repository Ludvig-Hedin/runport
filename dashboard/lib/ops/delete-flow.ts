import type { BackupResult, Counts, Source } from "./backup";
import { SafeError } from "./errors";

// The order of an app delete, with no I/O of its own so it is tested with
// fakes (test/delete-flow.test.ts).
//
// One record per app, keyed by its Railway project id, holds a lease and the
// saved progress. A run owns the record only while it holds the lease: a
// generation number claimed atomically (store.claim) plus an expiry. Another
// run may take over only after the lease has expired, and every step first
// checks that the lease is still its own.
//
//   started → stopping (hosting stopped) → frozen (client services off, every
//   other app key expired) → backed-up (backup checked byte for byte, its id
//   saved) → data-deleted → done
//
// Each step's "before" state is saved before the step acts. Nothing is deleted
// before "backed-up", and every later step checks the saved backup again,
// including that it came from this very app. A failure before "backed-up"
// rolls back: keys and services exactly as they were, then the app restarts
// only if that worked. If rollback fails, the record is "stuck": the app stays
// stopped and shows "needs a check".

export type DeleteState = "started" | "stopping" | "frozen" | "backed-up" | "data-deleted" | "done" | "aborted" | "stuck";

export type SavedKey = { id: string; name: string; scopes: string[]; expire: string | null };

export type DeleteRecord = {
  key: string;
  slug: string;
  state: DeleteState;
  gen: number;
  owner: string;
  leaseUntil: number;
  prevStatus?: string;
  /** Client services that were on, saved before any is switched off. */
  frozenServices?: string;
  /** The app's other keys and their expiry, saved before any is expired. */
  savedKeys?: SavedKey[];
  manifestId?: string;
  manifestSha?: string;
  backupName?: string;
  counts?: Counts;
  error?: string;
  updatedAt: number;
};

export type DeleteStore = {
  /** Creates the record only if none exists. */
  create(record: DeleteRecord): Promise<boolean>;
  get(key: string): Promise<DeleteRecord | null>;
  update(key: string, patch: Partial<DeleteRecord>): Promise<void>;
  /** Atomically claims lease generation `gen` for `key`; false if it was already claimed. */
  claim(key: string, gen: number): Promise<boolean>;
};

export type DeleteDeps = {
  store: DeleteStore;
  now(): number;
  newOwner(): string;
  /** The app's ids, which a saved backup must match. */
  source: Source;
  /** Throws when the app has things the backup cannot restore. Changes nothing. */
  preflight(): Promise<void>;
  currentStatus(): Promise<string>;
  /** Cancels builds, stops everything serving, waits for it and a drain period. */
  stopHosting(): Promise<void>;
  restartHosting(): Promise<void>;
  readServices(): Promise<string>;
  freezeWrites(saved: string): Promise<void>;
  unfreezeWrites(saved: string): Promise<void>;
  readKeys(): Promise<SavedKey[]>;
  expireKeys(keys: SavedKey[]): Promise<void>;
  restoreKeys(keys: SavedKey[]): Promise<void>;
  backup(onProgress: () => Promise<void>): Promise<BackupResult>;
  verify(manifestId: string, manifestSha: string, expected: Counts | undefined, onProgress: () => Promise<void>): Promise<void>;
  deleteData(): Promise<void>;
  /** Re-lists the Railway project and throws if anything was added since the start. */
  recheckHosting(): Promise<void>;
  deleteHosting(): Promise<void>;
  /** After the delete: drop the app from the dashboard's list. Best effort. */
  forget(): Promise<void>;
};

export type DeleteStep = "stop" | "backup" | "check" | "data" | "hosting" | "done";

export const LEASE_MS = 10 * 60 * 1000;

export class DeleteBusy extends SafeError {
  constructor() {
    super("A delete of this app is already running. Wait for it, or try again in 10 minutes if it stopped.");
  }
}

class LeaseLost extends SafeError {
  constructor() {
    super("Another run took over this delete. Nothing more was done here.");
  }
}

const ACTIVE: DeleteState[] = ["started", "stopping", "frozen", "backed-up", "data-deleted", "stuck"];
export const isActive = (state: DeleteState | undefined) => !!state && ACTIVE.includes(state);

async function acquire(key: string, slug: string, deps: DeleteDeps): Promise<DeleteRecord | "done"> {
  const { store } = deps;
  const owner = deps.newOwner();
  const fresh: DeleteRecord = { key, slug, state: "started", gen: 1, owner, leaseUntil: deps.now() + LEASE_MS, updatedAt: deps.now() };
  if (await store.create(fresh)) {
    if (!(await store.claim(key, 1))) throw new DeleteBusy();
    return fresh;
  }
  const existing = await store.get(key);
  if (!existing) throw new DeleteBusy();
  if (existing.state === "done") return "done";
  if (existing.leaseUntil > deps.now()) throw new DeleteBusy();
  const gen = existing.gen + 1;
  if (!(await store.claim(key, gen))) throw new DeleteBusy();
  // An aborted run put everything back: start clean, with nothing saved from it.
  const reset: Partial<DeleteRecord> =
    existing.state === "aborted"
      ? { state: "started", prevStatus: undefined, frozenServices: undefined, savedKeys: undefined, manifestId: undefined, manifestSha: undefined, backupName: undefined, counts: undefined }
      : {};
  await store.update(key, { ...reset, gen, owner, leaseUntil: deps.now() + LEASE_MS, error: undefined, updatedAt: deps.now() });
  const mine = await store.get(key);
  if (!mine || mine.gen !== gen || mine.owner !== owner) throw new DeleteBusy();
  return mine;
}

export async function runDelete(key: string, slug: string, deps: DeleteDeps, emit: (step: DeleteStep) => void): Promise<DeleteRecord> {
  const { store } = deps;
  const got = await acquire(key, slug, deps);
  if (got === "done") {
    emit("done");
    return (await store.get(key))!;
  }
  let record = got;

  /** Checks the lease is still ours and extends it. */
  const hold = async () => {
    const now = await store.get(key);
    if (!now || now.gen !== record.gen || now.owner !== record.owner || now.leaseUntil <= deps.now()) throw new LeaseLost();
    const leaseUntil = deps.now() + LEASE_MS;
    await store.update(key, { leaseUntil, updatedAt: deps.now() });
    record = { ...record, leaseUntil };
  };
  const save = async (patch: Partial<DeleteRecord>) => {
    await hold();
    record = { ...record, ...patch, updatedAt: deps.now() };
    await store.update(key, { ...patch, updatedAt: record.updatedAt });
  };
  const verifySaved = async () => {
    if (!record.manifestId || !record.manifestSha) throw new SafeError("The saved backup record is incomplete. Nothing more was deleted.");
    await deps.verify(record.manifestId, record.manifestSha, record.counts, hold);
  };

  if (record.state === "started" || record.state === "stopping" || record.state === "frozen" || record.state === "stuck") {
    let stopped = record.state !== "started";
    try {
      if (record.state === "started") {
        await deps.preflight();
        await save({ prevStatus: await deps.currentStatus(), state: "stopping" });
      }
      emit("stop");
      stopped = true;
      await hold();
      await deps.stopHosting();
      if (!record.frozenServices) await save({ frozenServices: await deps.readServices() });
      await hold();
      await deps.freezeWrites(record.frozenServices!);
      if (!record.savedKeys) await save({ savedKeys: await deps.readKeys() });
      await hold();
      await deps.expireKeys(record.savedKeys!);
      await save({ state: "frozen" });
      emit("backup");
      await hold();
      const backup = await deps.backup(hold);
      emit("check");
      await deps.verify(backup.manifestId, backup.manifestSha, backup.counts, hold);
      await save({ state: "backed-up", manifestId: backup.manifestId, manifestSha: backup.manifestSha, backupName: backup.name, counts: backup.counts });
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      const message = error instanceof SafeError ? error.message : "The delete stopped before anything was deleted.";
      if (!stopped) {
        // Refused before anything changed.
        await save({ state: "aborted", error: message });
        throw new SafeError(message);
      }
      const problems: string[] = [];
      if (record.savedKeys) await deps.restoreKeys(record.savedKeys).catch(() => problems.push("switch the app's keys back on"));
      if (record.frozenServices) await deps.unfreezeWrites(record.frozenServices).catch(() => problems.push("switch changes back on"));
      // Restart only when writes are back exactly as they were.
      if (!problems.length && (record.prevStatus === "live" || record.prevStatus === "sleeping")) {
        await deps.restartHosting().catch(() => problems.push("restart the app"));
      }
      if (problems.length) {
        await save({ state: "stuck", error: `${message} Could not ${problems.join(" or ")}.` }).catch(() => {});
        throw new SafeError(`${message} The app is stopped and needs a check: could not ${problems.join(" or ")}. Nothing was deleted.`);
      }
      await save({ state: "aborted", error: message }).catch(() => {});
      throw new SafeError(`${message} Nothing was deleted, and the app is back as it was.`);
    }
  }

  try {
    if (record.state === "backed-up") {
      emit("check");
      await verifySaved();
      emit("data");
      await hold();
      await deps.deleteData();
      await save({ state: "data-deleted" });
    }
    if (record.state === "data-deleted") {
      emit("check");
      await verifySaved();
      emit("hosting");
      await hold();
      await deps.recheckHosting();
      await deps.deleteHosting();
      await save({ state: "done" });
      await deps.forget().catch(() => {});
    }
  } catch (error) {
    if (error instanceof LeaseLost) throw error;
    const message = error instanceof SafeError ? error.message : "The delete stopped partway.";
    await save({ error: message }).catch(() => {});
    throw new SafeError(`${message} The backup is saved; try again to finish.`);
  }
  emit("done");
  return record;
}
