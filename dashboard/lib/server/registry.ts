import "server-only";
import { cache } from "react";
import { Query } from "node-appwrite";
import { createAdminClient } from "@/lib/appwrite";
import { appwriteApi, type AppwriteApi } from "@/lib/ops/appwrite-rest";
import { DATABASE_ID } from "@/lib/schema";

// The trusted app list. Each row pins the ids the Mac's `sync-dashboard`
// tool recorded when it set the app up: Railway workspace, project,
// environment and service, and the Appwrite project. The dashboard acts only
// on these ids, never on names it finds. Row id = slug, so slugs are unique.

export type AppPins = {
  slug: string;
  name: string;
  repoUrl: string | null;
  workspaceId: string;
  railwayProjectId: string;
  environmentId: string;
  serviceId: string;
  appwriteProjectId: string;
  analyticsSiteId: string | null;
};

const REQUIRED = ["workspaceId", "railwayProjectId", "environmentId", "serviceId", "appwriteProjectId"] as const;

export const loadPins = cache(async (): Promise<AppPins[]> => {
  const { tables } = createAdminClient();
  const res = await tables.listRows({ databaseId: DATABASE_ID, tableId: "apps", queries: [Query.limit(500)] });
  return res.rows
    .map((r) => r as unknown as AppPins & { $id: string })
    .filter((r) => r.$id === r.slug && REQUIRED.every((k) => typeof r[k] === "string" && r[k]))
    .map(({ slug, name, repoUrl, workspaceId, railwayProjectId, environmentId, serviceId, appwriteProjectId, analyticsSiteId }) => ({
      slug, name, repoUrl: repoUrl ?? null, workspaceId, railwayProjectId, environmentId, serviceId, appwriteProjectId, analyticsSiteId: analyticsSiteId ?? null,
    }));
});

/**
 * Per-app Appwrite keys, made by sync-dashboard and kept in the dashboard's
 * RUNPORT_APP_KEYS variable: a read key (project, users, teams, functions,
 * tables, rows, buckets, files: read only) and a write key with only
 * project.write, which can switch services off and delete the project.
 */
type KeyPair = { read: string; write: string };

function keys(slug: string): KeyPair | null {
  try {
    const all = JSON.parse(process.env.RUNPORT_APP_KEYS ?? "{}") as Record<string, KeyPair>;
    const pair = all[slug];
    return pair && typeof pair.read === "string" && typeof pair.write === "string" ? pair : null;
  } catch {
    return null;
  }
}

const endpoint = () => (process.env.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "");

export function readApi(pins: AppPins): AppwriteApi | null {
  const k = keys(pins.slug);
  return k ? appwriteApi(endpoint(), pins.appwriteProjectId, k.read) : null;
}

/** Only for the steps after the backup is verified (and the write freeze). */
export function writeApi(pins: AppPins): AppwriteApi | null {
  const k = keys(pins.slug);
  return k ? appwriteApi(endpoint(), pins.appwriteProjectId, k.write) : null;
}
