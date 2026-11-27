import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.umask(0o077);
const path = process.argv[2] ?? "/data/limits.sqlite";
const scratch = await mkdtemp(join(tmpdir(), "runport-quota-snapshot-"));
try {
  const copy = join(scratch, "limits.sqlite");
  const source = new Database(path, { readonly: true });
  try {
    source.query("VACUUM INTO ?").run(copy);
  } finally {
    source.close();
  }
  const snapshot = new Database(copy, { readonly: true });
  let rows = 0;
  try {
    const integrity = snapshot.query("PRAGMA integrity_check").values();
    if (integrity.length !== 1 || integrity[0]?.[0] !== "ok") throw new Error("Cutover snapshot failed integrity_check.");
    if (snapshot.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sent_by_kind'").get()) {
      rows = Number(snapshot.query("SELECT count(*) FROM sent_by_kind").values()[0]?.[0]);
    }
  } finally {
    snapshot.close();
  }
  const bytes = Buffer.from(await Bun.file(copy).arrayBuffer());
  console.log(JSON.stringify({ rows, sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
