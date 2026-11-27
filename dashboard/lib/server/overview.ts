import "server-only";
import { Query } from "node-appwrite";
import { createAdminClient } from "@/lib/appwrite";
import { DATABASE_ID } from "@/lib/schema";
import { visitorsLast7Days, type Visitors } from "./analytics";
import { projectNames } from "./appwrite-console";
import { appStatus, costByProject, listApps, type AppStatus, type RunportApp } from "./railway";

// The plain data each app row shows. Built on the server; holds no secrets.

export type GitInfo = { host: "runport" | "github" | "other"; url: string } | null;

export type AppRow = {
  slug: string;
  name: string;
  url: string | null;
  status: AppStatus;
  lastDeployAt: string | null;
  costUsd: number | null;
  visitors: Visitors;
  git: GitInfo;
};

type Meta = { slug: string; name: string; repoUrl?: string | null; git?: string | null };

async function appMeta(): Promise<Map<string, Meta>> {
  const { tables } = createAdminClient();
  const res = await tables.listRows({ databaseId: DATABASE_ID, tableId: "apps", queries: [Query.limit(500)] });
  return new Map(res.rows.map((r) => [String(r.slug), r as unknown as Meta]));
}

export function gitInfo(repoUrl: string | null | undefined): GitInfo {
  if (!repoUrl) return null;
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== "https:") return null;
    if (url.host === "github.com") return { host: "github", url: url.href };
    if (url.host === "git.runport.app") return { host: "runport", url: url.href };
    return { host: "other", url: url.href };
  } catch {
    return null;
  }
}

export async function appRows(): Promise<AppRow[]> {
  const [apps, cost, meta, names] = await Promise.all([
    listApps(),
    costByProject().catch(() => null),
    appMeta().catch(() => new Map<string, Meta>()),
    projectNames().catch(() => new Map<string, string>()),
  ]);
  const rows = await Promise.all(
    apps.map(async (app: RunportApp): Promise<AppRow> => {
      const m = meta.get(app.slug);
      return {
        slug: app.slug,
        name: names.get(app.slug) ?? m?.name ?? app.slug,
        url: app.url,
        status: appStatus(app.web),
        lastDeployAt: app.web.latestDeployment?.createdAt ?? null,
        costUsd: cost ? (cost.get(app.project.id) ?? 0) : null,
        visitors: await visitorsLast7Days(app.slug, app.analyticsSiteId),
        git: gitInfo(m?.repoUrl),
      };
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
