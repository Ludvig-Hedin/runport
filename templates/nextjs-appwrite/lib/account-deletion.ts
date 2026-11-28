import { AppwriteException, Query, type Models, type TablesDB, type Users } from "node-appwrite";
import { isSolelyOwnedBy } from "./ownership";
import { DATABASE_ID, DELETIONS_TABLE, OWNER_COLUMN, TABLES } from "./schema";

export const DELETION_COMPLETE = "Your account and its data have been deleted.";
export const DELETION_PENDING = "Your account is closed. Removing the rest of your data will finish shortly.";
export const DELETION_NOT_STARTED = "Nothing was deleted. Try again in a moment.";
const DELETION_UNCONFIRMED = "Could not confirm whether your account closed. Try signing in again to check.";
const DELETION_IN_PROGRESS = "An account deletion request is already in progress.";
const PAGE = 100;
// A worker that finds an enabled account waits for the request that just
// recorded its intent to block it. An abandoned intent expires on its own.
const BLOCK_GRACE_MS = 10 * 60_000;
// Appwrite rejects an empty object in Users.updatePrefs. This replaces
// every preference with a single non-personal value.
const ANONYMOUS_PREFS = { runportAccountDeleted: true };

type Requester = Pick<Models.User, "$id" | "$createdAt" | "email">;
type DeletionRecord = Models.Row & { userId: string; userCreatedAt: string };
export type DeletionClients = { tables: TablesDB; users: Users };
type DeletionResult = { error: string } | { notice: typeof DELETION_COMPLETE | typeof DELETION_PENDING };

const notFound = (error: unknown, type: string) => error instanceof AppwriteException && error.code === 404 && error.type === type;
const conflict = (error: unknown) => error instanceof AppwriteException && error.code === 409;
const placeholder = (id: string) => `deleted-${id.toLowerCase()}@deleted.invalid`;
const recordIds = { databaseId: DATABASE_ID, tableId: DELETIONS_TABLE };
const personal = TABLES.filter(({ personal }) => personal).map(({ id }) => id);

function logFailure(step: string, error: unknown) {
  // Never log the account, its rows, or Appwrite's response body.
  const reason = error instanceof AppwriteException ? error.code : "unexpected error";
  console.error(`Account deletion ${step} (${reason})`);
}

function pageQueries(after: string | undefined): string[] {
  // A cursor row could disappear while this job is running. A keyset
  // boundary still works after that row is deleted.
  return [Query.orderAsc("$id"), Query.limit(PAGE), ...(after ? [Query.greaterThan("$id", after)] : [])];
}

async function* pages<Row extends Models.Row>(tables: TablesDB, tableId: string, filters: string[] = []) {
  let after: string | undefined;
  for (;;) {
    const { rows } = await tables.listRows<Row>({
      databaseId: DATABASE_ID, tableId, queries: [...filters, ...pageQueries(after)], total: false,
    });
    if (!rows.length) return;
    yield rows;
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.$id;
  }
}

async function getUser(users: Users, userId: string) {
  return users.get({ userId }).catch((error) => {
    if (notFound(error, "user_not_found")) return null;
    throw error;
  });
}

class AccountChanged extends Error {}

async function closedUser(users: Users, record: DeletionRecord) {
  const user = await getUser(users, record.userId);
  if (!user || user.$createdAt !== record.userCreatedAt || user.status !== false) throw new AccountChanged();
  return user;
}

/** The committed row must still match and must be unchanged since staging. */
async function deleteMatchingRow<Row extends Models.Row>(
  tables: TablesDB,
  tableId: string,
  rowId: string,
  matches: (row: Row) => boolean,
  beforeCommit?: () => Promise<unknown>,
): Promise<boolean> {
  const ids = { databaseId: DATABASE_ID, tableId, rowId };
  const { $id: transactionId } = await tables.createTransaction();
  let committed = false;
  try {
    await tables.deleteRow({ ...ids, transactionId });
    // Read committed state outside the transaction. It still contains the
    // row. Appwrite rejects the commit if a writer changed it after staging.
    if (!matches(await tables.getRow<Row>(ids))) return false;
    await beforeCommit?.();
    await tables.updateTransaction({ transactionId, commit: true });
    committed = true;
    return true;
  } catch (error) {
    if (notFound(error, "row_not_found") || conflict(error)) return false;
    throw error;
  } finally {
    if (!committed) {
      // Even if Appwrite is unreachable, an uncommitted transaction expires.
      await tables.deleteTransaction({ transactionId }).catch(() => {});
    }
  }
}

async function sweepOwnedRows({ tables, users }: DeletionClients, record: DeletionRecord) {
  for (const tableId of personal) {
    for await (const rows of pages<Models.DefaultRow>(tables, tableId, [Query.equal(OWNER_COLUMN, record.userId)])) {
      for (const row of rows) {
        if (!isSolelyOwnedBy(row, record.userId)) continue;
        await deleteMatchingRow<Models.DefaultRow>(tables, tableId, row.$id,
          (current) => isSolelyOwnedBy(current, record.userId),
          () => closedUser(users, record));
      }
    }
  }
}

async function soleRowsRemain(tables: TablesDB, userId: string) {
  for (const tableId of personal) {
    for await (const rows of pages<Models.DefaultRow>(tables, tableId, [Query.equal(OWNER_COLUMN, userId)])) {
      if (rows.some((row) => isSolelyOwnedBy(row, userId))) return true;
    }
  }
  return false;
}

function identitiesFor(users: Users, userId: string, limit = PAGE) {
  return users.listIdentities({ queries: [Query.equal("userId", userId), Query.limit(limit)], total: false });
}

function prefsAreAnonymous(prefs: Models.User["prefs"]) {
  const keys = Object.keys(prefs ?? {});
  return keys.length === 0 || (keys.length === 1 && prefs.runportAccountDeleted === true);
}

async function anonymise(users: Users, record: DeletionRecord) {
  const { userId } = record;
  await closedUser(users, record);
  await users.deleteSessions({ userId });
  // Removing each page moves the next page to the front.
  for (;;) {
    const { identities } = await identitiesFor(users, userId);
    if (!identities.length) break;
    await closedUser(users, record);
    for (const { $id: identityId } of identities) {
      await users.deleteIdentity({ identityId }).catch((error) => {
        if (!notFound(error, "user_identity_not_found")) throw error;
      });
    }
  }
  // Recheck the account's generation and status before each change.
  if ((await closedUser(users, record)).email.toLowerCase() !== placeholder(userId)) {
    await users.updateEmail({ userId, email: placeholder(userId) });
  }
  if ((await closedUser(users, record)).phone) await users.updatePhone({ userId, number: "" });
  if ((await closedUser(users, record)).name) await users.updateName({ userId, name: "" });
  if ((await closedUser(users, record)).labels.length) await users.updateLabels({ userId, labels: [] });
  if (!prefsAreAnonymous((await closedUser(users, record)).prefs)) {
    await users.updatePrefs({ userId, prefs: ANONYMOUS_PREFS });
  }
}

async function isAnonymous(users: Users, record: DeletionRecord) {
  const { userId } = record;
  const { email, phone, name, labels, prefs } = await closedUser(users, record);
  return email.toLowerCase() === placeholder(userId) && !phone && !name && !labels.length && prefsAreAnonymous(prefs)
    && (await identitiesFor(users, userId, 1)).identities.length === 0
    && (await users.listSessions({ userId, total: false })).sessions.length === 0;
}

async function discardRecord(tables: TablesDB, record: DeletionRecord) {
  await deleteMatchingRow<DeletionRecord>(tables, DELETIONS_TABLE, record.$id,
    (current) => current.$createdAt === record.$createdAt && current.userCreatedAt === record.userCreatedAt);
}

async function finishRecord(clients: DeletionClients, record: DeletionRecord): Promise<"complete" | "pending" | "discarded"> {
  const { tables, users } = clients;
  if (record.$id !== record.userId) {
    await discardRecord(tables, record);
    return "discarded";
  }
  try {
    const user = await getUser(users, record.userId);
    if (!user || user.$createdAt !== record.userCreatedAt) throw new AccountChanged();
    if (user.status !== false) {
      if (Date.now() - Date.parse(record.$createdAt) < BLOCK_GRACE_MS) return "pending";
      throw new AccountChanged();
    }
    // Revoke sign-ins first. Verify two clean sweeps after the mutations.
    await anonymise(users, record);
    await sweepOwnedRows(clients, record);
    if (await soleRowsRemain(tables, record.userId) || await soleRowsRemain(tables, record.userId)) return "pending";
    if (!(await isAnonymous(users, record))) return "pending";
    await discardRecord(tables, record);
    return "complete";
  } catch (error) {
    if (!(error instanceof AccountChanged)) throw error;
    await discardRecord(tables, record);
    return "discarded";
  }
}

export async function finishPendingDeletions(clients: DeletionClients) {
  let failed = 0;
  for await (const records of pages<DeletionRecord>(clients.tables, DELETIONS_TABLE)) {
    for (const record of records) {
      try {
        await finishRecord(clients, record);
      } catch (error) {
        failed++;
        logFailure("will retry", error);
      }
    }
  }
  return { failed };
}

export async function requestAccountDeletion(clients: DeletionClients, requester: Requester): Promise<DeletionResult> {
  const { users, tables } = clients;
  const userId = requester.$id;
  let record: DeletionRecord;
  try {
    const user = await getUser(users, userId);
    if (!user || user.$createdAt !== requester.$createdAt || user.email !== requester.email || !user.status) {
      return { error: DELETION_NOT_STARTED };
    }
    // Create instead of upsert. Only the request that wrote the intent may
    // start closing the account. Another tab cannot replace the record.
    record = await tables.createRow<DeletionRecord>({
      ...recordIds, rowId: userId, data: { userId, userCreatedAt: requester.$createdAt }, permissions: [],
    });
  } catch (error) {
    if (conflict(error)) return { error: DELETION_IN_PROGRESS };
    logFailure("could not record intent", error);
    return { error: DELETION_NOT_STARTED };
  }

  try {
    // A delayed Appwrite response must not start a block near the point
    // when the monitor is allowed to drop an enabled account's intent.
    const user = await getUser(users, userId);
    if (!user || user.$createdAt !== record.userCreatedAt || user.email !== requester.email || !user.status
      || Date.now() - Date.parse(record.$createdAt) >= BLOCK_GRACE_MS / 2) {
      return { error: DELETION_NOT_STARTED };
    }
  } catch (error) {
    logFailure("could not check intent", error);
    return { error: DELETION_NOT_STARTED };
  }

  try {
    const blocked = await users.updateStatus({ userId, status: false });
    if (blocked.status !== false || blocked.$createdAt !== record.userCreatedAt) throw new AccountChanged();
  } catch (error) {
    // A failed response can mean Appwrite committed the block, then lost
    // the connection. Read the account before telling the browser anything.
    logFailure("could not confirm block", error);
    try {
      const user = await getUser(users, userId);
      if (!user || user.$createdAt !== record.userCreatedAt) return { error: DELETION_NOT_STARTED };
      if (user.status !== false) {
        return { error: error instanceof AppwriteException ? DELETION_NOT_STARTED : DELETION_UNCONFIRMED };
      }
    } catch {
      return { error: DELETION_UNCONFIRMED };
    }
  }

  try {
    if (await finishRecord(clients, record) === "complete") return { notice: DELETION_COMPLETE };
  } catch (error) {
    logFailure("will retry", error);
  }
  return { notice: DELETION_PENDING };
}
