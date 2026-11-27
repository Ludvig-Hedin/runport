import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeQuotas } from "../mail-storage/merge";

test("cutover preserves the higher counter and a verified backup of both stores", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "runport-quota-cutover-"));
  const source = join(scratch, "overlay.sqlite");
  const target = join(scratch, "volume", "limits.sqlite");
  const snapshot = join(scratch, "snapshot.sqlite");
  const backup = join(scratch, "old-volume.sqlite");
  const policy = "CREATE TABLE sent_by_kind(day TEXT, app TEXT, kind TEXT, recipients INTEGER, PRIMARY KEY(day, app, kind))";
  const seed = (path: string, rows: [string, number][]) => {
    const db = new Database(path);
    db.run("PRAGMA journal_mode = WAL");
    db.run(policy);
    for (const [app, count] of rows) {
      db.query("INSERT INTO sent_by_kind VALUES ('2026-11-27', ?, 'login', ?)").run(app, count);
    }
    db.close();
  };
  const counts = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return db.query("SELECT app, recipients FROM sent_by_kind ORDER BY app").values();
    } finally {
      db.close();
    }
  };
  try {
    await mkdir(join(scratch, "volume"));
    seed(source, [["overlap", 9], ["overlay", 3]]);
    seed(target, [["overlap", 4], ["volume", 8]]);
    const copied = Bun.spawnSync([process.execPath, new URL("../mail-storage/snapshot.ts", import.meta.url).pathname, source]);
    expect(copied.exitCode).toBe(0);
    const payload = JSON.parse(copied.stdout.toString()) as { rows: number; sha256: string; data: string };
    const bytes = Buffer.from(payload.data, "base64");
    expect(payload.rows).toBe(2);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(payload.sha256);
    await Bun.write(snapshot, bytes);
    expect(await mergeQuotas(target, snapshot, backup)).toEqual({
      snapshotRows: 2, priorVolumeRows: 2, mergedRows: 3,
      missingSnapshotKeys: 0, missingVolumeKeys: 0, integrity: true,
    });
    expect(counts(target)).toEqual([["overlap", 9], ["overlay", 3], ["volume", 8]]);
    expect(counts(backup)).toEqual([["overlap", 4], ["volume", 8]]);
    expect(await Bun.file(join(scratch, "volume", ".runport-quota-cutover-ready")).exists()).toBe(true);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

const makeDatabase = (path: string, schema: string) => {
  const db = new Database(path);
  try {
    db.run(schema);
  } finally {
    db.close();
  }
};
const quotaRecord = `CREATE TABLE sent_by_kind (day TEXT, app TEXT, kind TEXT, recipients INTEGER, PRIMARY KEY (day, app, kind));
  INSERT INTO sent_by_kind VALUES ('2026-11-27', 'fixture', 'mail', 2);`;

for (const missingSide of ["source", "target"] as const) {
  test(`quota merge accepts a missing table in the ${missingSide}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "runport-quota-empty-"));
    const target = join(scratch, "target.sqlite");
    const source = join(scratch, "source.sqlite");
    const backup = join(scratch, "before.sqlite");
    try {
      const unrelatedTable = "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('retained');";
      makeDatabase(target, missingSide === "target" ? unrelatedTable : quotaRecord);
      makeDatabase(source, missingSide === "source" ? unrelatedTable : quotaRecord);
      const result = await mergeQuotas(target, source, backup);
      expect(result.snapshotRows).toBe(missingSide === "source" ? 0 : 1);
      expect(result.priorVolumeRows).toBe(missingSide === "target" ? 0 : 1);
      expect(result.mergedRows).toBe(1);
      expect(result.missingSnapshotKeys + result.missingVolumeKeys).toBe(0);
      if (missingSide === "target") {
        for (const path of [target, backup]) {
          const db = new Database(path, { readonly: true });
          try {
            expect(db.query("SELECT value FROM unrelated").values()).toEqual([["retained"]]);
          } finally {
            db.close();
          }
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

for (const existing of [true, false]) {
  test(`quota merge retries at the same paths with an ${existing ? "existing" : "absent"} target`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "runport-quota-retry-"));
    const target = join(scratch, "target.sqlite");
    const source = join(scratch, "source.sqlite");
    const backup = join(scratch, "before.sqlite");
    try {
      if (existing) makeDatabase(target, quotaRecord);
      makeDatabase(source, "CREATE TABLE sent_by_kind (bad_column TEXT)");
      await expect(mergeQuotas(target, source, backup)).rejects.toThrow();
      expect(await Bun.file(backup).exists()).toBe(false);
      expect(await Bun.file(target).exists()).toBe(existing);
      expect(await Bun.file(join(scratch, ".runport-quota-cutover-ready")).exists()).toBe(false);
      await rm(source);
      makeDatabase(source, quotaRecord);
      const result = await mergeQuotas(target, source, backup);
      expect(result.mergedRows).toBe(1);
      expect(result.integrity).toBe(true);
      expect(await Bun.file(backup).exists()).toBe(existing);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
