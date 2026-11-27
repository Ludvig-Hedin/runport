import { stat } from "node:fs/promises";
import { alertOwner, bucket } from "./shared";

// Nightly: dump each Runport database, check the dump can be read back, put
// it in the bucket under backups/, and delete copies older than KEEP_DAYS.
// The encryption key is not in here; it stays in the owner's Keychain.

const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 14);
const day = new Date().toISOString().slice(0, 10);

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} failed: ${(await new Response(proc.stderr).text()).slice(0, 500)}`);
}

async function backup(name: string, database?: string) {
  const file = `/tmp/${name}-${day}.dump`;
  const key = `backups/${name}-${day}.dump`;
  // PGHOST, PGUSER, PGPASSWORD and the default PGDATABASE come from Railway.
  await run(["pg_dump", "--format=custom", "--no-owner", `--file=${file}`, ...(database ? [`--dbname=${database}`] : [])]);
  await run(["pg_restore", "--list", file]);
  const size = (await stat(file)).size;
  if (size < 1024) throw new Error(`Dump is only ${size} bytes.`);
  await bucket.write(key, Bun.file(file));
  console.log(JSON.stringify({ result: "backup ok", key, bytes: size }));
}

try {
  await backup("appwrite");
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const listed = await bucket.list({ prefix: "backups/" });
  for (const object of listed.contents ?? []) {
    const date = Date.parse(object.key.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "");
    if (date && date < cutoff) await bucket.delete(object.key);
  }
} catch (error) {
  console.error(JSON.stringify({ result: "backup failed", reason: (error as Error).message }));
  await alertOwner("Runport: nightly backup failed", `The database backup for ${day} did not finish.\n\n${(error as Error).message}\n`).catch(() => {});
  process.exit(1);
}

if (process.env.ANALYTICS_DATABASE) {
  try {
    await backup("analytics", process.env.ANALYTICS_DATABASE);
  } catch (error) {
    console.error(JSON.stringify({ result: "analytics backup failed", reason: (error as Error).message }));
    process.exitCode = 1;
  }
}
