import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config";

/** One line per tool call. Never pass secrets in `detail`. */
export async function logAction(tool: string, detail: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(config.logFile), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), tool, ...detail });
  await appendFile(config.logFile, `${line}\n`);
}
