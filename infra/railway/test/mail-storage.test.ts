import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeQuotas } from "../mail-storage/merge";

test("cutover fences writers, backs up both quota stores, and preserves the higher counter", async () => {
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
    const fenced = Bun.spawn([process.execPath, new URL("../mail-storage/snapshot.ts", import.meta.url).pathname, source], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    try {
      const stream = fenced.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const result = await stream.read();
        if (result.done) throw new Error("The snapshot command did not emit a receipt.");
        line += new TextDecoder().decode(result.value);
      }
      const payload = JSON.parse(line) as { rows: number; sha256: string; data: string };
      const bytes = Buffer.from(payload.data, "base64");
      expect(payload.rows).toBe(2);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(payload.sha256);
      await Bun.write(snapshot, bytes);
      const concurrent = new Database(source);
      try {
        expect(() => concurrent.run("UPDATE sent_by_kind SET recipients = 100")).toThrow(/locked/);
      } finally {
        concurrent.close();
      }
    } finally {
      fenced.stdin.end();
      expect(await fenced.exited).toBe(0);
    }
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
