import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config, registryFile } from "./config";

// The list of apps the platform made. No secrets here: keys live in each
// app's gitignored .env.local.

export type AppRecord = {
  slug: string;
  name: string;
  projectId: string;
  folder: string;
  port: number;
  repoUrl: string | null;
  createdAt: string;
};

type Registry = { apps: AppRecord[] };

export async function loadRegistry(): Promise<Registry> {
  try {
    return JSON.parse(await readFile(registryFile(), "utf8")) as Registry;
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
