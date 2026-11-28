import { AppwriteException, Query, type Models, type TablesDB, type Users } from "node-appwrite";
import { randomBytes } from "node:crypto";
import { isSolelyOwnedBy } from "./ownership";
import { DATABASE_ID, DELETIONS_TABLE, OWNER_COLUMN, TABLES } from "./schema";

export const DELETION_COMPLETE = "Your account is closed and your data has been removed.";
export const DELETION_PENDING = "Your account is closed. Removing the rest of your data will finish shortly.";
export const DELETION_NOT_STARTED = "Nothing was deleted. Try again in a moment.";
const DELETION_UNCONFIRMED = "Could not confirm whether your account closed. Try signing in again to check.";
const DELETION_IN_PROGRESS = "An account deletion request is already in progress.";
const PAGE = 100;
const SETTLE_MS = 10 * 60_000;
// Appwrite rejects an empty object in Users.updatePrefs. This replaces
// every preference with a single non-personal value.
const ANONYMOUS_PREFS = { runportAccountDeleted: true };

type Requester = Pick<Models.User, "$id" | "$createdAt" | "email">;
type Progress = { placeholderEmail?: string | null; verifiedAt?: string | null; remaining?: string | null };
type DeletionRecord = Models.Row & { userId: string; userCreatedAt: string } & Progress;
export type DeletionClients = { tables: TablesDB; users: Users };
type DeletionResult = { error: string } | { notice: typeof DELETION_COMPLETE | typeof DELETION_PENDING };

const notFound = (error: unknown, type: string) => error instanceof AppwriteException && error.code === 404 && error.type === type;
const conflict = (error: unknown) => error instanceof AppwriteException && error.code === 409;
const newPlaceholder = () => `deleted-${randomBytes(16).toString("hex")}@deleted.invalid`;
export const isReservedAccountEmail = (email: string) => /@deleted\.invalid\.?$/i.test(email.trim());
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

async function matchingUser(users: Users, record: DeletionRecord) {
  const user = await getUser(users, record.userId);
  if (!user || user.$createdAt !== record.userCreatedAt) throw new AccountChanged();
  return user;
}

async function closedUser(users: Users, record: DeletionRecord) {
  const user = await matchingUser(users, record);
  if (user.status !== false) throw new Error("Account still active");
  return user;
}

async function readRecord(tables: TablesDB, rowId: string) {
  return tables.getRow<DeletionRecord>({ ...recordIds, rowId }).catch((error) => {
    if (notFound(error, "row_not_found")) return null;
    throw error;
  });
}

export async function hasDeletionRecord(tables: TablesDB, user: Pick<Models.User, "$id" | "$createdAt">) {
  const record = await readRecord(tables, user.$id);
  return record?.userId === user.$id && record.userCreatedAt === user.$createdAt;
}

/** The committed row must still match after staging the mutation. */
async function mutateMatchingRow<Row extends Models.Row>(
  tables: TablesDB,
  tableId: string,
  rowId: string,
  matches: (row: Row) => boolean | Promise<boolean>,
  data?: Progress,
): Promise<boolean> {
  const ids = { databaseId: DATABASE_ID, tableId, rowId };
  const { $id: transactionId } = await tables.createTransaction();
  let committed = false;
  try {
    if (data) await tables.updateRow({ ...ids, transactionId, data });
    else await tables.deleteRow({ ...ids, transactionId });
    // Appwrite also checks timestamps at commit. Personal row permissions
    // are immutable by contract, including within a single timestamp tick.
    if (!(await matches(await tables.getRow<Row>(ids)))) return false;
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
        await mutateMatchingRow<Models.DefaultRow>(tables, tableId, row.$id, async (current) => {
          if (!isSolelyOwnedBy(current, record.userId)) return false;
          await closedUser(users, record);
          return true;
        });
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

const sameRecord = (earlier: DeletionRecord, current: DeletionRecord) =>
  current.$createdAt === earlier.$createdAt && current.userId === earlier.userId
  && current.userCreatedAt === earlier.userCreatedAt
  && current.placeholderEmail === earlier.placeholderEmail && current.verifiedAt === earlier.verifiedAt
  && current.remaining === earlier.remaining;

function saveProgress(tables: TablesDB, record: DeletionRecord, data: Progress) {
  return mutateMatchingRow<DeletionRecord>(tables, DELETIONS_TABLE, record.$id, (current) => sameRecord(record, current), data);
}

function discardRecord(tables: TablesDB, record: DeletionRecord, verify?: () => Promise<boolean>) {
  return mutateMatchingRow<DeletionRecord>(tables, DELETIONS_TABLE, record.$id,
    async (current) => sameRecord(record, current) && (!verify || await verify()));
}

async function ensureBlocked(users: Users, record: DeletionRecord) {
  if ((await matchingUser(users, record)).status === false) return;
  try {
    await users.updateStatus({ userId: record.userId, status: false });
  } catch (error) {
    // A lost reply can follow a committed block. Always verify with a new read.
    logFailure("could not confirm block response", error);
  }
  await closedUser(users, record);
}

/** Snapshot the list before deleting so our own deletes never invalidate its cursor. */
async function removeTargets(users: Users, record: DeletionRecord) {
  const { userId } = record;
  const targetIds: string[] = [];
  let after: string | undefined;
  for (;;) {
    const { targets } = await users.listTargets({
      userId, queries: [Query.limit(PAGE), ...(after ? [Query.cursorAfter(after)] : [])], total: false,
    });
    targetIds.push(...targets.map((target) => target.$id));
    if (targets.length < PAGE) break;
    after = targets.at(-1)!.$id;
  }

  for (const targetId of targetIds) {
    await closedUser(users, record);
    await users.deleteTarget({ userId, targetId }).catch((error) => {
      if (!notFound(error, "user_target_not_found")) logFailure("target removal will retry", error);
    });
  }
}

async function replaceEmail({ tables, users }: DeletionClients, record: DeletionRecord) {
  const { userId, placeholderEmail } = record;
  if (!placeholderEmail) throw new Error("Placeholder has not been saved");
  if ((await closedUser(users, record)).email.toLowerCase() === placeholderEmail) return record;

  try {
    await users.updateEmail({ userId, email: placeholderEmail });
    return record;
  } catch (error) {
    if (!(error instanceof AppwriteException && error.code === 409
      && ["user_email_already_exists", "user_target_already_exists"].includes(error.type))) throw error;
    // A racing worker may already have set the same placeholder.
    if ((await closedUser(users, record)).email.toLowerCase() === placeholderEmail) return record;
  }

  const replacement = { placeholderEmail: newPlaceholder(), verifiedAt: null };
  if (!(await saveProgress(tables, record, replacement))) return record;
  // Persist the replacement before sending it to Appwrite. Another collision
  // is handled by the next run, even if this write has an ambiguous outcome.
  const updated = { ...record, ...replacement };
  try {
    await closedUser(users, updated);
    await users.updateEmail({ userId, email: replacement.placeholderEmail });
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    logFailure("email replacement will retry", error);
  }
  return updated;
}

async function attempt(step: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    logFailure(`${step} will retry`, error);
  }
}

async function anonymise(clients: DeletionClients, record: DeletionRecord) {
  const { users } = clients;
  const { userId } = record;
  await attempt("sessions", async () => {
    await closedUser(users, record);
    await users.deleteSessions({ userId });
  });
  await attempt("identities", async () => {
    // Removing a page moves the next page to the front.
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
  });
  await attempt("email", async () => { record = await replaceEmail(clients, record); });
  await attempt("phone", async () => {
    if ((await closedUser(users, record)).phone) await users.updatePhone({ userId, number: "" });
  });
  await attempt("name", async () => {
    if ((await closedUser(users, record)).name) await users.updateName({ userId, name: "" });
  });
  await attempt("labels", async () => {
    if ((await closedUser(users, record)).labels.length) await users.updateLabels({ userId, labels: [] });
  });
  await attempt("preferences", async () => {
    if (!prefsAreAnonymous((await closedUser(users, record)).prefs)) {
      await users.updatePrefs({ userId, prefs: ANONYMOUS_PREFS });
    }
  });
  // Appwrite may add a target as part of the placeholder update.
  await attempt("targets", async () => { await removeTargets(users, record); });
  return record;
}

async function verifyStep(step: string, clean: () => Promise<boolean>) {
  try {
    return await clean() ? [] : [step];
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    logFailure(`${step} verification will retry`, error);
    return [step];
  }
}

async function remainingWork({ tables, users }: DeletionClients, record: DeletionRecord) {
  const { userId } = record;
  const checks = await Promise.all([
    verifyStep("identities", async () => (await identitiesFor(users, userId, 1)).identities.length === 0),
    verifyStep("sessions", async () => (await users.listSessions({ userId, total: false })).sessions.length === 0),
    verifyStep("targets", async () => (await users.listTargets({ userId, queries: [Query.limit(1)], total: false })).targets.length === 0),
    verifyStep("rows", async () => !(await soleRowsRemain(tables, userId))),
  ]);
  // Read the user's fields last so a late write during the other checks is visible.
  const { status, email, phone, name, labels, prefs } = await matchingUser(users, record);
  return [
    ...checks.flat(),
    ...(status === false ? [] : ["block"]),
    ...(email.toLowerCase() === record.placeholderEmail ? [] : ["email"]),
    ...(phone ? ["phone"] : []),
    ...(name ? ["name"] : []),
    ...(labels.length ? ["labels"] : []),
    ...(prefsAreAnonymous(prefs) ? [] : ["preferences"]),
  ];
}

type Outcome = { blocked: boolean; verified: boolean; remaining: boolean };

async function finishRecord(clients: DeletionClients, record: DeletionRecord, now: () => number): Promise<Outcome> {
  const { tables, users } = clients;
  if (record.$id !== record.userId) throw new Error("Invalid deletion record");
  try {
    // A clean check persisted by a previous run starts the settle period.
    // Any failed check resets it before cleanup can repair the evidence.
    if (record.verifiedAt) {
      const outstanding = await remainingWork(clients, record);
      if (!outstanding.length) {
        if (now() - Date.parse(record.verifiedAt) >= SETTLE_MS) {
          let lateWork: string[] = [];
          await discardRecord(tables, record, async () => {
            lateWork = await remainingWork(clients, record);
            return !lateWork.length;
          });
          if (lateWork.length) {
            const progress = { verifiedAt: null, remaining: lateWork.join(",") };
            await saveProgress(tables, record, progress);
            return { blocked: !lateWork.includes("block"), verified: false, remaining: true };
          }
        }
        return { blocked: true, verified: true, remaining: false };
      }
      const progress = { verifiedAt: null, remaining: outstanding.join(",") };
      if (!(await saveProgress(tables, record, progress))) {
        return { blocked: !outstanding.includes("block"), verified: false, remaining: true };
      }
      record = { ...record, ...progress };
    }

    await matchingUser(users, record);
    if (!record.placeholderEmail) {
      // Older preview records can predate the optional placeholder column.
      const progress = { placeholderEmail: newPlaceholder() };
      if (!(await saveProgress(tables, record, progress))) {
        return { blocked: (await matchingUser(users, record)).status === false, verified: false, remaining: true };
      }
      record = { ...record, ...progress };
    }

    try {
      await ensureBlocked(users, record);
    } catch (error) {
      if (error instanceof AccountChanged) throw error;
      logFailure("block will retry", error);
      await saveProgress(tables, record, { verifiedAt: null, remaining: "block" });
      return { blocked: false, verified: false, remaining: true };
    }

    // The request that attempted the block and a maintenance run can overlap.
    // Reuse whichever placeholder/checkpoint is in the durable record now.
    const latest = await readRecord(tables, record.$id);
    if (!latest || latest.userCreatedAt !== record.userCreatedAt) {
      await closedUser(users, record);
      return { blocked: true, verified: false, remaining: false };
    }
    record = latest;
    if (record.verifiedAt) {
      // Another run verified while this run was waiting to block. Restart the
      // timer before repairing anything, including a status flip our block
      // may already have corrected.
      const progress = { verifiedAt: null, remaining: "verification" };
      if (!(await saveProgress(tables, record, progress))) {
        return { blocked: true, verified: false, remaining: true };
      }
      record = { ...record, ...progress };
    }
    record = await anonymise(clients, record);
    await attempt("row removal", () => sweepOwnedRows(clients, record));
    const outstanding = await remainingWork(clients, record);
    const progress = outstanding.length
      ? { verifiedAt: null, remaining: outstanding.join(",") }
      : { verifiedAt: new Date(now()).toISOString(), remaining: null };
    if (record.verifiedAt !== progress.verifiedAt || record.remaining !== progress.remaining) {
      await saveProgress(tables, record, progress);
    }
    return { blocked: !outstanding.includes("block"), verified: !outstanding.length, remaining: !!outstanding.length };
  } catch (error) {
    if (!(error instanceof AccountChanged)) {
      await saveProgress(tables, record, { verifiedAt: null, remaining: "verification" }).catch((saveError) => {
        logFailure("could not record verification failure", saveError);
      });
      throw error;
    }
    await discardRecord(tables, record);
    return { blocked: false, verified: false, remaining: false };
  }
}

export async function finishPendingDeletions(clients: DeletionClients, now = Date.now) {
  let failed = 0;
  for await (const records of pages<DeletionRecord>(clients.tables, DELETIONS_TABLE)) {
    for (const record of records) {
      try {
        if ((await finishRecord(clients, record, now)).remaining) failed++;
      } catch (error) {
        failed++;
        logFailure("will retry", error);
      }
    }
  }
  return { failed };
}

export async function requestAccountDeletion(clients: DeletionClients, requester: Requester, now = Date.now): Promise<DeletionResult> {
  const { users, tables } = clients;
  const userId = requester.$id;
  let record: DeletionRecord;
  try {
    const user = await getUser(users, userId);
    if (!user || user.$createdAt !== requester.$createdAt || user.email !== requester.email || !user.status) {
      return { error: DELETION_NOT_STARTED };
    }
    // Only one request can create the record for this account.
    record = await tables.createRow<DeletionRecord>({
      ...recordIds, rowId: userId, permissions: [],
      data: { userId, userCreatedAt: requester.$createdAt, placeholderEmail: newPlaceholder() },
    });
  } catch (error) {
    if (conflict(error)) return { error: DELETION_IN_PROGRESS };
    logFailure("could not record intent", error);
    return { error: DELETION_NOT_STARTED };
  }

  // Once recorded, consent is durable even if the request exits before the block.
  try {
    const outcome = await finishRecord(clients, record, now);
    if (outcome.blocked) return { notice: outcome.verified ? DELETION_COMPLETE : DELETION_PENDING };
  } catch (error) {
    logFailure("will retry", error);
    try {
      if ((await matchingUser(users, record)).status === false) return { notice: DELETION_PENDING };
    } catch {
      // Only show a closure notice after verifying the block.
    }
  }
  return { error: DELETION_UNCONFIRMED };
}
