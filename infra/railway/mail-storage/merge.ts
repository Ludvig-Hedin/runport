import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, lstat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const quotaTable = "CREATE TABLE sent_by_kind (day TEXT NOT NULL, app TEXT NOT NULL, kind TEXT NOT NULL, recipients INTEGER NOT NULL, PRIMARY KEY (day, app, kind))";

export async function mergeQuotas(target: string, incoming: string, previous: string) {
  if (process.getuid?.() === 0 || new Set([target, incoming, previous].map(path => resolve(path))).size !== 3 ||
      !await Bun.file(incoming).exists() || await Bun.file(previous).exists()) {
    throw new Error("Run as the gateway user with a fresh backup path and distinct SQLite files.");
  }
  const directory = dirname(target);
  const marker = join(directory, ".runport-quota-cutover-ready");
  if (await Bun.file(marker).exists()) throw new Error("The quota volume already has a cutover receipt.");
  await access(directory, constants.W_OK | constants.X_OK);
  const existing = await Bun.file(target).exists();
  if (existing) {
    const state = await lstat(target);
    if (!state.isFile() || state.uid !== process.getuid?.()) throw new Error("The existing quota file must be a regular file owned by the gateway user.");
    await access(target, constants.W_OK);
  }

  const db = new Database(target, { create: true, readwrite: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    if (existing) db.query("VACUUM main INTO ?").run(previous);
    db.query("ATTACH DATABASE ? AS snapshot").run(incoming);
    if (existing) db.query("ATTACH DATABASE ? AS prior").run(previous);
    type Schema = "main" | "snapshot" | "prior";
    const integrity = (schema: Schema) => {
      const results = db.query(`PRAGMA ${schema}.integrity_check`).values();
      return results.length === 1 && results[0]?.[0] === "ok";
    };
    const count = (schema: Schema) =>
      (db.query(`SELECT count(*) AS n FROM ${schema}.sent_by_kind`).get() as { n: number }).n;
    const missing = (schema: "snapshot" | "prior") =>
      (db.query(`SELECT count(*) AS n FROM ${schema}.sent_by_kind AS original
                LEFT JOIN main.sent_by_kind AS live USING(day, app, kind)
                WHERE live.recipients IS NULL OR live.recipients < original.recipients`).get() as { n: number }).n;
    if (!integrity("snapshot") || existing && !integrity("prior")) throw new Error("Quota backup failed integrity_check.");
    const result = db.transaction(() => {
      if (!existing) db.run(quotaTable);
      db.run(`INSERT INTO main.sent_by_kind(day, app, kind, recipients)
              SELECT day, app, kind, recipients FROM snapshot.sent_by_kind WHERE true
              ON CONFLICT (day, app, kind)
              DO UPDATE SET recipients = max(sent_by_kind.recipients, excluded.recipients)`);
      const report = {
        snapshotRows: count("snapshot"), priorVolumeRows: existing ? count("prior") : 0,
        mergedRows: count("main"), missingSnapshotKeys: missing("snapshot"),
        missingVolumeKeys: existing ? missing("prior") : 0, integrity: integrity("main"),
      };
      if (!report.integrity || report.missingSnapshotKeys || report.missingVolumeKeys) {
        throw new Error("Quota comparison failed. Merge rolled back.");
      }
      return report;
    }).immediate();
    await access(target, constants.W_OK);
    if ((await lstat(target)).uid !== process.getuid?.()) throw new Error("The gateway user must own its quota database.");
    await writeFile(marker, JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" });
    return result;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.umask(0o077);
  const [incoming, previous] = process.argv.slice(2);
  const mountInfo = await Bun.file("/proc/self/mountinfo").text();
  if (!incoming || !previous || !mountInfo.split("\n").some(line => line.split(" ")[4] === "/data")) {
    throw new Error("The maintenance container needs a mounted /data, a source snapshot, and a backup path.");
  }
  console.log(JSON.stringify(await mergeQuotas("/data/limits.sqlite", incoming, previous)));
}
