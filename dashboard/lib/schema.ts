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

export const TABLES: TableSpec[] = [
  {
    // What only the Mac's app list knows: the repo. Filled by `bun run sync-apps`.
    id: "apps",
    name: "Apps",
    columns: [
      { type: "varchar", key: "slug", size: 64, required: true },
      { type: "varchar", key: "name", size: 255, required: true },
      { type: "varchar", key: "repoUrl", size: 512, required: false },
      { type: "varchar", key: "git", size: 16, required: false },
    ],
  },
  {
    // One row per deleted app, with where its backup is.
    id: "deletions",
    name: "Deletions",
    columns: [
      { type: "varchar", key: "slug", size: 64, required: true },
      { type: "varchar", key: "name", size: 255, required: true },
      { type: "varchar", key: "backup", size: 255, required: true },
      { type: "varchar", key: "counts", size: 512, required: true },
    ],
  },
];
