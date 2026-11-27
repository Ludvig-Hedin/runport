// Which rows belong to exactly one person, and removing them. Shared by the
// account page (lib/account.ts) and `bun run setup`, so it imports nothing
// Next-specific. Every caller passes an admin TablesDB client.

import { AppwriteException, Query, type TablesDB, type Users } from "node-appwrite";
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

/** The email a deleted account is renamed to, so its real address is free and gone. */
export const tombstoneEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

/**
 * Turns a closed (blocked) account into a permanent, anonymous placeholder:
 * no sessions, linked sign-ins, email, phone, name, preferences or labels.
 * The record itself stays blocked so its id is never given to anyone else.
 * Every step checks first, so running it again picks up where it stopped.
 */
export async function tombstone(users: Users, userId: string): Promise<void> {
  await users.deleteSessions({ userId });
  for (let page = 0; page < 100; page++) {
    const { identities } = await users.listIdentities({ queries: [Query.equal("userId", userId), Query.limit(100)] });
    if (identities.length === 0) break;
    for (const identity of identities) await users.deleteIdentity({ identityId: identity.$id });
  }
  const user = await users.get({ userId });
  if (user.email !== tombstoneEmail(userId)) await users.updateEmail({ userId, email: tombstoneEmail(userId) });
  if (user.phone) await users.updatePhone({ userId, number: "" });
  if (user.name) await users.updateName({ userId, name: "" });
  if (Object.keys(user.prefs ?? {}).length) await users.updatePrefs({ userId, prefs: {} });
  if (user.labels.length) await users.updateLabels({ userId, labels: [] });
}

/** True once nothing identifying is left on the account. */
export async function isTombstoned(users: Users, userId: string): Promise<boolean> {
  const user = await users.get({ userId });
  return user.status === false && user.email === tombstoneEmail(userId) && !user.phone && !user.name && user.labels.length === 0;
}

/**
 * Finishes closed accounts' deletions: sweeps their rows and anonymises them.
 * A record is acted on only when its account is still blocked AND is the same
 * account (same creation time) that asked to be deleted. Code never unblocks
 * an account, so an active account is never touched; a record whose account
 * is active again (unblocked by an admin) or different is simply dropped.
 */
export async function finishPendingDeletions(tables: TablesDB, users: Users): Promise<number> {
  const { rows } = await tables.listRows({ databaseId: DATABASE_ID, tableId: DELETIONS_TABLE, queries: [Query.limit(PAGE)] });
  let closed = 0;
  for (const row of rows) {
    const record = row as unknown as Row;
    const userId = String(record.userId ?? "");
    const close = async () => {
      await tables.deleteRow({ databaseId: DATABASE_ID, tableId: DELETIONS_TABLE, rowId: row.$id });
      closed++;
    };
    try {
      const user = await users.get({ userId }).catch((error) => {
        if (error instanceof AppwriteException && error.code === 404) return null;
        throw error;
      });
      if (!user || user.$createdAt !== record.userCreatedAt || user.status !== false) {
        await close(); // gone, a different account, or reopened by an admin: touch nothing
        continue;
      }
      const left = await sweepOwnedRows(tables, userId);
      await tombstone(users, userId);
      if (left === 0 && (await sweepOwnedRows(tables, userId)) === 0 && (await isTombstoned(users, userId))) await close();
    } catch (error) {
      console.error(`could not finish deleting account ${userId}`, error);
    }
  }
  return closed;
}
