import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config, registryFile } from "./config";
import type { GitHost } from "./git-host";
import type { RailwayWebhook } from "./railway-webhook";

// The list of apps the platform made. No secrets here: keys live in each
// app's gitignored .env.local.

export type AppRecord = {
  slug: string;
  name: string;
  projectId: string;
  /** False when the owner supplied an existing project. Such projects are never deleted by the tool. */
  createdByPlatform: boolean;
  folder: string;
  port: number;
  repoUrl: string | null;
  git: GitHost;
  setupPending?: true;
  createdAt: string;
  alerts?: { origin: string; keychainService: string; environmentId: string; serviceId: string; registrationId?: string; webhook?: RailwayWebhook };
};

type Registry = { apps: AppRecord[] };

export async function loadRegistry(file = registryFile()): Promise<Registry> {
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as { apps: (Omit<AppRecord, "git"> & { git?: GitHost })[] };
    return { apps: stored.apps.map((app) => ({ ...app, git: app.git ?? "github" })) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { apps: [] };
    throw error;
  }
}

async function save(registry: Registry): Promise<void> {
  const file = registryFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(tmp, file);
}

export async function upsertApp(app: AppRecord): Promise<void> {
  const registry = await loadRegistry();
  registry.apps = [...registry.apps.filter((a) => a.slug !== app.slug), app];
  await save(registry);
}

export async function removeApp(slug: string): Promise<void> {
  const registry = await loadRegistry();
  registry.apps = registry.apps.filter((a) => a.slug !== slug);
  await save(registry);
}

export function nextFreePort(apps: AppRecord[]): number {
  const used = new Set(apps.map((a) => a.port));
  for (let port = config.portRange.first; port <= config.portRange.last; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error("No free local port left for a new app.");
}
