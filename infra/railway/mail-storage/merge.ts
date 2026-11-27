import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, link, lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const quotaTable = "CREATE TABLE IF NOT EXISTS sent_by_kind (day TEXT NOT NULL, app TEXT NOT NULL, kind TEXT NOT NULL, recipients INTEGER NOT NULL, PRIMARY KEY (day, app, kind))";

async function existingFile(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function publish(source: string, destination: string, noReplace = false) {
  const file = await open(source, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  if (noReplace) {
    await link(source, destination);
    await rm(source);
  } else {
    if (await existingFile(destination)) throw new Error("Cutover output already exists.");
    await rename(source, destination);
  }
}

export async function mergeQuotas(target: string, incoming: string, previous: string) {
  const uid = process.getuid?.();
  if (uid === 0 || new Set([target, incoming, previous].map(path => resolve(path))).size !== 3 ||
      !(await existingFile(incoming))?.isFile() || await existingFile(previous)) {
    throw new Error("Run as the gateway user with distinct SQLite files and an unused backup path.");
  }
  const directory = dirname(target);
  const marker = join(directory, ".runport-quota-cutover-ready");
  if (await existingFile(marker)) throw new Error("The quota volume already has a cutover receipt.");
  await access(directory, constants.W_OK | constants.X_OK);
  const existing = await existingFile(target);
  if (existing) {
    if (!existing.isFile() || existing.uid !== uid) throw new Error("The existing quota file must be a regular file owned by the gateway user.");
    await access(target, constants.W_OK);
  }

  const targetScratch = await mkdtemp(join(directory, ".quota-merge-"));
  let backupScratch: string | undefined;
  let publishedBackup = false;
  try {
    if (existing) backupScratch = await mkdtemp(join(dirname(previous), ".quota-backup-"));
    const targetFile = existing ? target : join(targetScratch, "target.sqlite");
    const backupFile = backupScratch && join(backupScratch, "volume.sqlite");
    const db = new Database(targetFile, { create: true, readwrite: true });
    const result = await (async () => {
      try {
        db.run("PRAGMA busy_timeout = 10000");
        if (backupFile) {
          db.query("VACUUM main INTO ?").run(backupFile);
          await publish(backupFile, previous);
          publishedBackup = true;
          db.query("ATTACH DATABASE ? AS prior").run(previous);
        }
        db.query("ATTACH DATABASE ? AS snapshot").run(incoming);
        type Source = "snapshot" | "prior";
        const hasQuota = (schema: Source) =>
          !!db.query(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name='sent_by_kind'`).get();
        const integrity = (schema: "main" | Source) => {
          const results = db.query(`PRAGMA ${schema}.integrity_check`).values();
          return results.length === 1 && results[0]?.[0] === "ok";
        };
        const count = (schema: "main" | Source) =>
          (db.query(`SELECT count(*) AS n FROM ${schema}.sent_by_kind`).get() as { n: number }).n;
        const missing = (schema: Source) =>
          (db.query(`SELECT count(*) AS n FROM ${schema}.sent_by_kind AS original
                    LEFT JOIN main.sent_by_kind AS live USING(day, app, kind)
                    WHERE live.recipients IS NULL OR live.recipients < original.recipients`).get() as { n: number }).n;
        if (!integrity("snapshot") || backupFile && !integrity("prior")) {
          throw new Error("Quota backup failed integrity_check.");
        }
        const incomingQuota = hasQuota("snapshot");
        const previousQuota = !!backupFile && hasQuota("prior");

        // Keep the inode of a serving SQLite database. SQLite governs the
        // atomic update and coordinates concurrent writers via its journal.
        return db.transaction(() => {
          db.run(quotaTable);
          if (incomingQuota) {
            db.run(`INSERT INTO main.sent_by_kind(day, app, kind, recipients)
              SELECT day, app, kind, recipients FROM snapshot.sent_by_kind WHERE true
              ON CONFLICT (day, app, kind)
              DO UPDATE SET recipients = max(sent_by_kind.recipients, excluded.recipients)`);
          }
          const report = {
            snapshotRows: incomingQuota ? count("snapshot") : 0,
            priorVolumeRows: previousQuota ? count("prior") : 0,
            mergedRows: count("main"),
            missingSnapshotKeys: incomingQuota ? missing("snapshot") : 0,
            missingVolumeKeys: previousQuota ? missing("prior") : 0,
            integrity: integrity("main"),
          };
          if (!report.integrity || report.missingSnapshotKeys || report.missingVolumeKeys) {
            throw new Error("Quota comparison failed. Merge rolled back.");
          }
          return report;
        }).immediate();
      } finally {
        db.close();
      }
    })();

    // The serving process could have created its database since the initial
    // check. The atomic link refuses to replace that inode.
    if (!existing) await publish(targetFile, target, true);
    await access(target, constants.W_OK);
    const markerFile = join(targetScratch, "ready");
    const receipt = await open(markerFile, "wx", 0o600);
    try {
      await receipt.writeFile(JSON.stringify(result) + "\n");
    } finally {
      await receipt.close();
    }
    await publish(markerFile, marker, true);
    return result;
  } catch (error) {
    if (publishedBackup) await rm(previous);
    throw error;
  } finally {
    await rm(targetScratch, { recursive: true, force: true });
    if (backupScratch) await rm(backupScratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.umask(0o077);
  const [incoming, previous] = process.argv.slice(2);
  const mountInfo = await Bun.file("/proc/self/mountinfo").text();
  if (!incoming || !previous || !mountInfo.split("\n").some(line => line.split(" ")[4] === "/data")) {
    throw new Error("The gateway needs a mounted /data, a source snapshot, and a backup path.");
  }
  console.log(JSON.stringify(await mergeQuotas("/data/limits.sqlite", incoming, previous)));
}
