import "server-only";
import { visitorsLast7Days, type Visitors } from "./analytics";
import { activeDelete } from "./app-ops";
import { type AppStatus, costByProject, listApps } from "./railway";

// The plain data each app row shows. Built on the server; holds no secrets.

export type GitInfo = { host: "runport" | "github" | "other"; url: string } | null;

export type AppRow = {
  slug: string;
  name: string;
  url: string | null;
  status: AppStatus;
  /** Why actions are off for this app, or null. */
  problem: string | null;
  /** A delete is running, stopped partway, or could not roll back: only Delete (to finish) is offered. */
  deleting: boolean;
  lastDeployAt: string | null;
  costUsd: number | null;
  visitors: Visitors;
  git: GitInfo;
};

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
  const [apps, cost] = await Promise.all([listApps(), costByProject().catch(() => null)]);
  const rows = await Promise.all(
    apps.map(async (app): Promise<AppRow> => {
      const active = app.problem ? null : await activeDelete(app).catch(() => null);
      return {
      slug: app.pins.slug,
      name: app.pins.name,
      url: app.url,
      status: active ? "unverified" : app.status,
      problem: app.problem ?? (active ? (active.state === "stuck" ? "A delete could not undo itself. The app stays stopped." : "A delete is running or stopped partway.") : null),
      deleting: !!active,
      lastDeployAt: app.lastDeployAt,
      costUsd: cost ? (cost.get(app.pins.railwayProjectId) ?? 0) : null,
      visitors: await visitorsLast7Days(app.pins.slug, app.pins.analyticsSiteId),
      git: gitInfo(app.pins.repoUrl),
      };
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
