import { stat } from "node:fs/promises";
import { alertOwner, bucket } from "./shared";

// Nightly: dump the Appwrite database, check the dump can be read back, put
// it in the bucket under backups/, and delete copies older than KEEP_DAYS.
// The encryption key is not in here; it stays in the owner's Keychain.

const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 14);
const day = new Date().toISOString().slice(0, 10);
const file = `/tmp/appwrite-${day}.dump`;
const key = `backups/appwrite-${day}.dump`;

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} failed: ${(await new Response(proc.stderr).text()).slice(0, 500)}`);
}

try {
  // PGHOST, PGUSER, PGPASSWORD and PGDATABASE come from the environment.
  await run(["pg_dump", "--format=custom", "--no-owner", `--file=${file}`]);
  await run(["pg_restore", "--list", file]);
  const size = (await stat(file)).size;
  if (size < 1024) throw new Error(`Dump is only ${size} bytes.`);
  await bucket.write(key, Bun.file(file));

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const listed = await bucket.list({ prefix: "backups/" });
  for (const object of listed.contents ?? []) {
    const date = Date.parse(object.key.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "");
    if (date && date < cutoff) await bucket.delete(object.key);
  }
  console.log(JSON.stringify({ result: "backup ok", key, bytes: size }));
} catch (error) {
  console.error(JSON.stringify({ result: "backup failed", reason: (error as Error).message }));
  await alertOwner("Sitedock: nightly backup failed", `The database backup for ${day} did not finish.\n\n${(error as Error).message}\n`).catch(() => {});
  process.exit(1);
}
