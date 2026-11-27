// The app's tables. `bun run setup` creates anything missing and leaves
// existing tables and data alone. Add a table here, then run setup again.

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
    id: "items",
    name: "Items",
    columns: [
      { type: "varchar", key: "title", size: 255, required: true },
      { type: "boolean", key: "done", required: false, default: false },
    ],
  },
];
