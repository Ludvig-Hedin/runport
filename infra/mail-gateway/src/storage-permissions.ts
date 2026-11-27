import { closeSync, constants, fchownSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";

function hasCode(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException).code === code;
}

// Pin the directory and files by descriptor. A path swap cannot cause a
// privileged chown of a symlink destination or of a different directory.
export function prepareGatewayStorage(database: string, uid: number, gid: number) {
  if (dirname(database) !== "/data") return;
  try {
    mkdirSync("/data", { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const directory = openSync("/data", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const files: number[] = [];
  try {
    const name = basename(database);
    for (const suffix of ["", "-wal", "-shm", "-journal", ".app-alerts", ".app-alerts-wal", ".app-alerts-shm", ".app-alerts-journal"]) {
      const path = `/proc/self/fd/${directory}/${name}${suffix}`;
      try {
        if (!lstatSync(path).isFile()) throw new Error("Gateway database path must be a regular file.");
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        files.push(file);
        const entry = fstatSync(file);
        if (!entry.isFile() || entry.nlink !== 1) throw new Error("Gateway database file must have one link.");
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
    for (const file of files) fchownSync(file, uid, gid);
    fchownSync(directory, uid, gid);
  } finally {
    for (const file of files) closeSync(file);
    closeSync(directory);
  }
}

if (import.meta.main) {
  const [uid, gid] = process.argv.slice(2).map(Number);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error("The gateway must run as a non-root user and group.");
  }
  prepareGatewayStorage(process.env.DATA_FILE ?? "/data/limits.sqlite", uid, gid);
}
