// The app's tables. `bun run setup` creates anything missing and leaves
// existing tables and data alone. Add a table here, then run setup again.

export const DATABASE_ID = "main";
export const DELETIONS_TABLE = "account_deletions";
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
   * Each row belongs only to its owner, for the lifetime of the row.
   * Create rows through `ownerData()` so the owner and row permissions
   * come from the session. Never change the owner or permissions.
   * Use a separate table for shared rows. Setup indexes and backfills
   * `owner` on older rows that already have one clear owner.
   */
  personal?: boolean;
};

export const OWNER_COLUMN = "owner";

export const TABLES: TableSpec[] = [
  {
    id: DELETIONS_TABLE,
    name: "Account deletions",
    serverOnly: true,
    columns: [
      { type: "varchar", key: "userId", size: 36, required: true },
      { type: "varchar", key: "userCreatedAt", size: 64, required: true },
      { type: "varchar", key: "placeholderEmail", size: 128, required: false },
      { type: "varchar", key: "verifiedAt", size: 64, required: false },
      { type: "varchar", key: "remaining", size: 128, required: false },
    ],
  },
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
