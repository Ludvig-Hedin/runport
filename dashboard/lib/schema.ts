// The dashboard's own tables. `bun run setup` creates anything missing and
// leaves existing tables and data alone.

export const DATABASE_ID = "main";

export type ColumnSpec =
  | { type: "varchar"; key: string; size: number; required: boolean }
  | { type: "boolean"; key: string; required: boolean; default?: boolean };

export type TableSpec = {
  id: string;
  name: string;
  columns: ColumnSpec[];
};

const text = (key: string, size = 255, required = false): ColumnSpec => ({ type: "varchar", key, size, required });

export const TABLES: TableSpec[] = [
  {
    // The trusted app list, written only by the Mac's sync-dashboard tool.
    // Row id = slug. Every id the dashboard may act on is pinned here.
    id: "apps",
    name: "Apps",
    columns: [
      text("slug", 64, true),
      text("name", 255, true),
      text("repoUrl", 512),
      text("git", 16),
      text("workspaceId", 64),
      text("railwayProjectId", 64),
      text("environmentId", 64),
      text("serviceId", 64),
      text("appwriteProjectId", 64),
      text("analyticsSiteId", 64),
    ],
  },
  {
    // One row per app delete, row id = the app's Railway project id. It is
    // the lock and the saved progress (lib/ops/delete-flow.ts).
    id: "deletions",
    name: "Deletions",
    columns: [
      text("slug", 64, true),
      text("name", 255, true),
      text("backup", 255, true),
      text("counts", 512, true),
      text("state", 16),
      text("owner", 64),
      text("prevStatus", 16),
      text("frozenServices", 512),
      text("manifestId", 64),
      text("manifestSha", 64),
      text("error", 512),
      text("updatedAtMs", 16),
    ],
  },
  {
    // The deployment a pause stopped, so resume starts exactly that one.
    id: "app_state",
    name: "App state",
    columns: [text("slug", 64, true), text("pausedDeploymentId", 64), text("pausedAt", 32)],
  },
];
