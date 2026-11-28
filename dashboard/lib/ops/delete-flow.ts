import type { BackupResult, Counts } from "./backup";

// The order of an app delete, with no I/O of its own so it can be tested with
// fakes. One record per app, keyed by its Railway project id (which never
// changes), is both the lock and the saved progress:
//
//   started → frozen (hosting stopped, client writes off) → backed-up (backup
//   checked byte for byte, its id saved) → data-deleted → done
//
// Nothing is deleted before "backed-up" is saved. A failure before that
// switches writes back on, restarts the app if it was running, and marks the
// record "aborted". A failure after it leaves everything stopped, and a retry
// continues from the saved step after checking the saved backup again.

export type DeleteState = "started" | "frozen" | "backed-up" | "data-deleted" | "done" | "aborted";

export type DeleteRecord = {
  key: string;
  slug: string;
  state: DeleteState;
  /** Random id of the run that holds the lock. */
  owner: string;
  /** What the hosting was doing before the delete stopped it. */
  prevStatus?: string;
  manifestId?: string;
  manifestSha?: string;
  backupName?: string;
  counts?: Counts;
  error?: string;
  updatedAt: number;
};

export type DeleteStore = {
  /** Creates the record only if none exists. False when one does: that is the lock. */
  create(record: DeleteRecord): Promise<boolean>;
  get(key: string): Promise<DeleteRecord | null>;
  update(key: string, patch: Partial<DeleteRecord>): Promise<void>;
};

export type DeleteDeps = {
  store: DeleteStore;
  now(): number;
  newOwner(): string;
  /** Throws when the app has things the backup cannot restore. Changes nothing. */
  preflight(): Promise<void>;
  /** Stops the hosting and returns what it was doing ("live", "sleeping", "paused", …). */
  stopHosting(): Promise<string>;
  restartHosting(prevStatus: string): Promise<void>;
  freezeWrites(): Promise<void>;
  unfreezeWrites(): Promise<void>;
  backup(): Promise<BackupResult>;
  verify(manifestId: string, manifestSha: string, expected?: Counts): Promise<void>;
  deleteData(): Promise<void>;
  deleteHosting(): Promise<void>;
};

export type DeleteStep = "stop" | "backup" | "check" | "data" | "hosting" | "done";

/** A run that has not moved for this long is treated as crashed and may be taken over. */
export const STALE_MS = 15 * 60 * 1000;

export class DeleteBusy extends Error {
  constructor() {
    super("A delete of this app is already running. Wait for it, or try again in 15 minutes if it stopped.");
  }
}

export async function runDelete(key: string, slug: string, deps: DeleteDeps, emit: (step: DeleteStep) => void): Promise<DeleteRecord> {
  const { store } = deps;
  const owner = deps.newOwner();
  const fresh: DeleteRecord = { key, slug, state: "started", owner, updatedAt: deps.now() };

  let record: DeleteRecord;
  if (await store.create(fresh)) {
    record = fresh;
  } else {
    const existing = await store.get(key);
    if (!existing) throw new DeleteBusy();
    if (existing.state === "done") {
      emit("done");
      return existing;
    }
    const moving = deps.now() - existing.updatedAt < STALE_MS;
    const midway = existing.state === "started" || existing.state === "frozen";
    if (midway && moving) throw new DeleteBusy();
    // Take the lock over: an aborted run, a crashed run, or a saved step to continue.
    await store.update(key, { owner, error: undefined, updatedAt: deps.now(), ...(existing.state === "aborted" ? { state: "started" as const, prevStatus: undefined } : {}) });
    const mine = await store.get(key);
    if (!mine || mine.owner !== owner) throw new DeleteBusy();
    record = mine;
  }

  const save = async (patch: Partial<DeleteRecord>) => {
    record = { ...record, ...patch, updatedAt: deps.now() };
    await store.update(key, { ...patch, updatedAt: record.updatedAt });
  };

  // Before anything is deleted: stop, freeze, back up, check, save.
  if (record.state === "started" || record.state === "frozen") {
    let froze = record.state === "frozen";
    try {
      if (record.state === "started") await deps.preflight();
      emit("stop");
      const prevStatus = record.prevStatus ?? (await deps.stopHosting());
      if (!record.prevStatus) await save({ prevStatus });
      froze = true;
      await deps.freezeWrites();
      await save({ state: "frozen" });
      emit("backup");
      const backup = await deps.backup();
      emit("check");
      await deps.verify(backup.manifestId, backup.manifestSha, backup.counts);
      await save({ state: "backed-up", manifestId: backup.manifestId, manifestSha: backup.manifestSha, backupName: backup.name, counts: backup.counts });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      // Put the app back the way it was. If that fails too, say so.
      const undo: string[] = [];
      if (froze) await deps.unfreezeWrites().catch(() => undo.push("switch writes back on"));
      if (record.prevStatus) await deps.restartHosting(record.prevStatus).catch(() => undo.push("restart the app"));
      await save({ state: "aborted", error: undo.length ? `${message} Could not ${undo.join(" or ")}.` : message });
      throw new Error(undo.length ? `${message} Could not ${undo.join(" or ")}; check the app.` : message);
    }
  } else if (record.state === "backed-up") {
    // A retry: the saved backup must still be there and whole.
    emit("check");
    if (!record.manifestId || !record.manifestSha) throw new Error("The saved backup record is incomplete. Nothing more was deleted.");
    await deps.verify(record.manifestId, record.manifestSha, record.counts);
  }

  try {
    if (record.state === "backed-up") {
      emit("data");
      await deps.deleteData();
      await save({ state: "data-deleted" });
    }
    if (record.state === "data-deleted") {
      emit("hosting");
      await deps.deleteHosting();
      await save({ state: "done" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await save({ error: message }).catch(() => {});
    throw new Error(`${message} The backup is saved; try again to finish.`);
  }
  emit("done");
  return record;
}
