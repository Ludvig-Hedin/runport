// Copies what only this Mac knows about each app (its name and code repo)
// into the dashboard's "apps" table. No secrets: the registry holds none.
// Run from the dashboard folder: bun run sync-apps
// Reads ~/Programming/apps/.platform.json, or PLATFORM_APPS_DIR.

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppwriteException, Client, Query, TablesDB } from "node-appwrite";

type Record_ = { slug: string; name: string; repoUrl: string | null; git?: string };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run from the dashboard folder so .env.local loads.`);
  return value;
}

const file = join(process.env.PLATFORM_APPS_DIR ?? join(homedir(), "Programming", "apps"), ".platform.json");
const registry = JSON.parse(await readFile(file, "utf8")) as { apps: Record_[] };
const tables = new TablesDB(new Client().setEndpoint(env("APPWRITE_ENDPOINT")).setProject(env("APPWRITE_PROJECT_ID")).setKey(env("APPWRITE_API_KEY")));

const existing = await tables.listRows({ databaseId: "main", tableId: "apps", queries: [Query.limit(500)] });
const bySlug = new Map(existing.rows.map((r) => [String(r.slug), r.$id]));

for (const app of registry.apps) {
  if (!/^[a-z0-9][a-z0-9-]{0,35}$/.test(app.slug)) continue;
  const data = { slug: app.slug, name: app.name, repoUrl: app.repoUrl ?? null, git: app.git ?? null };
  try {
    await tables.upsertRow({ databaseId: "main", tableId: "apps", rowId: bySlug.get(app.slug) ?? app.slug, data });
    console.log(`synced ${app.slug}`);
  } catch (error) {
    console.error(`could not sync ${app.slug}: ${error instanceof AppwriteException ? error.message : error}`);
  }
}
