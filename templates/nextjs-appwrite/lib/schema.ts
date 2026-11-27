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
  /**
   * Each row belongs to one person. Setup adds an indexed `owner` column
   * (and fills it for older rows that clearly have one owner).
   * Set the owner on the server with `ownerData()` from lib/owner.ts.
   */
  personal?: boolean;
};

export const OWNER_COLUMN = "owner";

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
    personal: true,
    columns: [
      { type: "varchar", key: "title", size: 255, required: true },
      { type: "boolean", key: "done", required: false, default: false },
    ],
  },
];
