import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveKey, expiredArchives, finishArchive, type ArchiveKind } from "./retention";
import { alertOwner, bucket, required } from "./shared";

const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 14);
const day = new Date().toISOString().slice(0, 10);

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(0, 500)}`);
}

async function save(file: string, key: string): Promise<void> {
  const size = (await stat(file)).size;
  if (size < 1024) throw new Error(`Backup is only ${size} bytes.`);
  const destination = bucket.file(key);
  const exists = await destination.exists();
  if (!exists) await destination.write(Bun.file(file));
  const stored = (await destination.stat()).size;
  if (stored < 1024 || (!exists && stored !== size)) throw new Error("Stored backup size did not verify.");
  console.log(JSON.stringify({ result: "backup ok", key, bytes: stored }));
}

async function backupDatabase(dir: string, kind: "appwrite" | "analytics", database?: string): Promise<void> {
  const file = join(dir, `${kind}.dump`);
  await run(["pg_dump", "--format=custom", "--no-owner", `--file=${file}`, ...(database ? [`--dbname=${database}`] : [])]);
  await run(["pg_restore", "--list", file]);
  await save(file, archiveKey(kind, day));
}

async function backupGit(dir: string): Promise<void> {
  const file = join(dir, "git.tar.gz");
  const res = await fetch(required("GIT_BACKUP_URL"), {
    method: "POST",
    headers: { Authorization: `Bearer ${required("GIT_BACKUP_TOKEN")}` },
    redirect: "error",
    signal: AbortSignal.timeout(8 * 60_000),
  });
  if (!res.ok) throw new Error(`Git backup service returned HTTP ${res.status}.`);
  await Bun.write(file, res);
  await run(["tar", "-tzf", file, "gitea/conf/app.ini", "gitea/forgejo.db", "git"]);
  await save(file, archiveKey("git", day));
}

async function prune(kind: ArchiveKind): Promise<void> {
  const cutoff = Date.parse(day) - (KEEP_DAYS - 1) * 24 * 60 * 60 * 1000;
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `backups/${kind}-`, continuationToken });
    keys.push(...(listed.contents ?? []).map(({ key }) => key));
    continuationToken = listed.nextContinuationToken;
  } while (continuationToken);
  for (const key of expiredArchives(keys, kind, cutoff, archiveKey(kind, day))) await bucket.delete(key);
}

let dir: string | undefined;
try {
  if (!Number.isInteger(KEEP_DAYS) || KEEP_DAYS < 1) throw new Error("KEEP_DAYS must be a positive integer.");
  const workDir = await mkdtemp(join(tmpdir(), "runport-backup-"));
  dir = workDir;
  const jobs: [ArchiveKind, () => Promise<void>][] = [
    ["appwrite", () => backupDatabase(workDir, "appwrite")],
    ["git", () => backupGit(workDir)],
  ];
  const analyticsDatabase = process.env.ANALYTICS_DATABASE;
  if (analyticsDatabase) jobs.push(["analytics", () => backupDatabase(workDir, "analytics", analyticsDatabase)]);
  const results = await Promise.allSettled(jobs.map(([kind, upload]) => finishArchive(upload, () => prune(kind))));
  const failures = jobs.flatMap(([kind], i) => {
    const result = results[i];
    return result?.status === "rejected" ? [`${kind}: ${(result.reason as Error).message}`] : [];
  });
  if (failures.length) throw new Error(failures.join("\n"));
} catch (error) {
  console.error(JSON.stringify({ result: "backup failed", reason: (error as Error).message }));
  await alertOwner("Runport: nightly backup failed", `Backup for ${day} failed.\n\n${(error as Error).message}\n`).catch(() => {});
  process.exitCode = 1;
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
}
