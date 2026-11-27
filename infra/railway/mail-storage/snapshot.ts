import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.umask(0o077);
const path = process.argv[2] ?? "/data/limits.sqlite";
const fence = new Database(path, { readwrite: true });
fence.run("PRAGMA busy_timeout = 10000");
fence.run("BEGIN IMMEDIATE");
const scratch = await mkdtemp(join(tmpdir(), "runport-quota-fence-"));
try {
  const copy = join(scratch, "limits.sqlite");
  const reader = new Database(path, { readonly: true });
  try {
    reader.query("VACUUM INTO ?").run(copy);
  } finally {
    reader.close();
  }
  const snapshot = new Database(copy, { readonly: true });
  let rows: unknown;
  try {
    const integrity = snapshot.query("PRAGMA integrity_check").values();
    if (integrity.length !== 1 || integrity[0]?.[0] !== "ok") throw new Error("Cutover snapshot failed integrity_check.");
    rows = snapshot.query("SELECT count(*) FROM sent_by_kind").values()[0]?.[0];
  } finally {
    snapshot.close();
  }
  const bytes = Buffer.from(await Bun.file(copy).arrayBuffer());
  console.log(JSON.stringify({ rows, sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") }));
  // Hold the write fence until the operator stops this deployment or closes
  // the SSH command. The watchdog prevents an abandoned session holding it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Bun.stdin.stream().getReader().read(),
      new Promise<void>(done => { timer = setTimeout(done, 15 * 60_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
} finally {
  fence.run("ROLLBACK");
  fence.close();
  await rm(scratch, { recursive: true, force: true });
}
