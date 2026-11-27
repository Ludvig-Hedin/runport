// Which rows belong to exactly one person, and removing them. Shared by the
// account page (lib/account.ts) and `bun run setup`, so it imports nothing
// Next-specific. Every caller passes an admin TablesDB client.

import { Query, type TablesDB } from "node-appwrite";
import { DATABASE_ID, OWNER_COLUMN, TABLES } from "./schema";

/** Internal table of account deletions that still need their rows swept. No user can read it. */
export const DELETIONS_TABLE = "account_deletions";

type Row = { $id: string; $permissions: string[] } & Record<string, unknown>;

const ROLE = /^[a-z]+\("([^"]+)"\)$/;
const USER_ROLE = /^user:([A-Za-z0-9._-]+)(\/[a-z]+)?$/;

/**
 * The one person every permission on this row names, or null when the row is
 * shared in any way (another user, a team, a member, a label, any, guests or
 * all users) or the permissions cannot be read.
 */
export function soleOwner(permissions: string[]): string | null {
  let owner: string | null = null;
  for (const permission of permissions) {
    const role = ROLE.exec(permission)?.[1];
    const user = role ? USER_ROLE.exec(role)?.[1] : undefined;
    if (!user) return null;
    if (owner && owner !== user) return null;
    owner = user;
  }
  return owner;
}

/**
 * A row is someone's only when the server-set owner column names them AND
 * the row's permissions name nobody else. Shared rows never count, whatever
 * the owner column says.
 */
export const isSolelyOwnedBy = (row: Row, userId: string) =>
  row[OWNER_COLUMN] === userId && soleOwner(row.$permissions) === userId;

const PAGE = 100;
const MAX_PAGES = 1000; // 100,000 rows per table per pass

/** Rows whose owner column names this person and who alone holds them, across one table. */
async function soleRows(tables: TablesDB, tableId: string, userId: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const queries = [Query.equal(OWNER_COLUMN, userId), Query.orderAsc("$id"), Query.limit(PAGE), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
    const { rows } = await tables.listRows({ databaseId: DATABASE_ID, tableId, queries });
    if (rows.length === 0) return found;
    for (const row of rows) if (isSolelyOwnedBy(row as unknown as Row, userId)) found.push(row.$id);
    cursor = rows[rows.length - 1].$id;
  }
  throw new Error(`Too many rows in ${tableId} to handle in one pass`);
}

/** Deletes this person's own rows in every personal table. Returns how many are left (0 when done). */
export async function sweepOwnedRows(tables: TablesDB, userId: string): Promise<number> {
  for (const table of TABLES.filter((t) => t.personal)) {
    for (const rowId of await soleRows(tables, table.id, userId)) {
      await tables.deleteRow({ databaseId: DATABASE_ID, tableId: table.id, rowId });
    }
  }
  let left = 0;
  for (const table of TABLES.filter((t) => t.personal)) left += (await soleRows(tables, table.id, userId)).length;
  return left;
}

/** Finishes deletions that stopped after the account itself was removed. Safe to run any time. */
export async function finishPendingDeletions(tables: TablesDB): Promise<number> {
  const { rows } = await tables.listRows({ databaseId: DATABASE_ID, tableId: DELETIONS_TABLE, queries: [Query.limit(PAGE)] });
  let finished = 0;
  for (const row of rows) {
    const userId = String((row as unknown as Row).userId ?? "");
    if (!userId) continue;
    try {
      if ((await sweepOwnedRows(tables, userId)) === 0) {
        await tables.deleteRow({ databaseId: DATABASE_ID, tableId: DELETIONS_TABLE, rowId: row.$id });
        finished++;
      }
    } catch (error) {
      console.error(`could not finish deleting rows for ${userId}`, error);
    }
  }
  return finished;
}
