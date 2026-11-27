// The app's tables. `bun run setup` creates anything missing and leaves
// existing tables and data alone. Add a table here, then run setup again.

export const DATABASE_ID = "main";
export const FORM_SUBMISSIONS_TABLE = "form_submissions";

export type ColumnSpec =
  | { type: "varchar"; key: string; size: number; required: boolean }
  | { type: "text"; key: string; required: boolean }
  | { type: "boolean"; key: string; required: boolean; default?: boolean };

export type TableSpec = {
  id: string;
  name: string;
  columns: ColumnSpec[];
  serverOnly?: boolean;
};

export const TABLES: TableSpec[] = [
  {
    id: FORM_SUBMISSIONS_TABLE,
    name: "Form submissions",
    serverOnly: true,
    columns: [
      { type: "varchar", key: "formId", size: 64, required: true },
      { type: "text", key: "payload", required: true },
      { type: "varchar", key: "notification", size: 32, required: true },
    ],
  },
  {
    id: "items",
    name: "Items",
    columns: [
      { type: "varchar", key: "title", size: 255, required: true },
      { type: "boolean", key: "done", required: false, default: false },
    ],
  },
];
