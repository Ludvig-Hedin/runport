import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  if (!(await destination.exists())) await destination.write(Bun.file(file));
  console.log(JSON.stringify({ result: "backup ok", key, bytes: (await destination.stat()).size }));
}

async function backupAppwrite(dir: string): Promise<void> {
  const file = join(dir, "appwrite.dump");
  await run(["pg_dump", "--format=custom", "--no-owner", `--file=${file}`]);
  await run(["pg_restore", "--list", file]);
  await save(file, `backups/appwrite-${day}.dump`);
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
  await save(file, `backups/git-${day}.tar.gz`);
}

async function prune(): Promise<void> {
  if (!Number.isInteger(KEEP_DAYS) || KEEP_DAYS < 1) throw new Error("KEEP_DAYS must be a positive integer.");
  const cutoff = Date.parse(day) - (KEEP_DAYS - 1) * 24 * 60 * 60 * 1000;
  const listed = await bucket.list({ prefix: "backups/" });
  for (const object of listed.contents ?? []) {
    const date = /^backups\/(?:appwrite-\d{4}-\d{2}-\d{2}\.dump|git-\d{4}-\d{2}-\d{2}\.tar\.gz)$/.test(object.key)
      ? Date.parse(object.key.match(/\d{4}-\d{2}-\d{2}/)![0])
      : NaN;
    if (date < cutoff) await bucket.delete(object.key);
  }
}

const dir = await mkdtemp(join(tmpdir(), "runport-backup-"));
try {
  const results = await Promise.allSettled([backupAppwrite(dir), backupGit(dir)]);
  const failures = results.flatMap((result, i) =>
    result.status === "rejected" ? [`${i === 0 ? "Appwrite" : "Runport Git"}: ${(result.reason as Error).message}`] : [],
  );
  if (failures.length) throw new Error(failures.join("\n"));
  await prune();
} catch (error) {
  console.error(JSON.stringify({ result: "backup failed", reason: (error as Error).message }));
  await alertOwner("Runport: nightly backup failed", `Backup for ${day} failed.\n\n${(error as Error).message}\n`).catch(() => {});
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
