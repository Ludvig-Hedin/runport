// Creates the database and tables from lib/schema.ts. Safe to run again.
// Row security is on: each row is readable and writable only by its creator.

import { AppwriteException, Client, Permission, Query, Role, TablesDB, TablesDBIndexType, Users } from "node-appwrite";
import { finishPendingDeletions } from "../lib/account-deletion";
import { soleOwner } from "../lib/ownership";
import { DATABASE_ID, DELETIONS_TABLE, OWNER_COLUMN, TABLES, type ColumnSpec } from "../lib/schema";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run from the app folder so .env.local loads.`);
  return value;
}

const client = new Client()
  .setEndpoint(env("APPWRITE_ENDPOINT"))
  .setProject(env("APPWRITE_PROJECT_ID"))
  .setKey(env("APPWRITE_API_KEY"));
const tables = new TablesDB(client);

const isNotFound = (error: unknown) => error instanceof AppwriteException && error.code === 404;

async function exists(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function addColumn(tableId: string, column: ColumnSpec): Promise<void> {
  const base = { databaseId: DATABASE_ID, tableId, key: column.key, required: column.required };
  if (column.type === "varchar") {
    await tables.createVarcharColumn({ ...base, size: column.size });
  } else if (column.type === "text") {
    await tables.createTextColumn(base);
  } else {
    await tables.createBooleanColumn({ ...base, xdefault: column.required ? undefined : column.default });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until Appwrite has finished building a new column, so it can be indexed and queried. */
async function waitForColumn(tableId: string, key: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const column = (await tables.getColumn({ databaseId: DATABASE_ID, tableId, key })) as { status?: string };
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed to build.`);
    await sleep(1000);
  }
  throw new Error(`Column ${tableId}.${key} is still building. Run setup again in a minute.`);
}

/**
 * Gives older rows an owner. Only rows whose permissions all name the same
 * single person are claimed; anything shared or unclear is left alone.
 */
async function backfillOwners(tableId: string): Promise<void> {
  let cursor: string | undefined;
  let claimed = 0;
  for (;;) {
    const queries = [Query.isNull(OWNER_COLUMN), Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
    const { rows } = await tables.listRows({ databaseId: DATABASE_ID, tableId, queries });
    if (rows.length === 0) break;
    for (const row of rows) {
      const owner = soleOwner(row.$permissions);
      if (owner) {
        await tables.updateRow({ databaseId: DATABASE_ID, tableId, rowId: row.$id, data: { [OWNER_COLUMN]: owner } });
        claimed++;
      }
    }
    cursor = rows[rows.length - 1].$id;
  }
  if (claimed) console.log(`gave ${claimed} older ${tableId} rows their owner`);
}

async function ensureOwner(tableId: string): Promise<void> {
  const ids = { databaseId: DATABASE_ID, tableId };
  if (!(await exists(() => tables.getColumn({ ...ids, key: OWNER_COLUMN })))) {
    await tables.createVarcharColumn({ ...ids, key: OWNER_COLUMN, size: 36, required: false });
    console.log(`created column ${tableId}.${OWNER_COLUMN}`);
  }
  await waitForColumn(tableId, OWNER_COLUMN);
  if (!(await exists(() => tables.getIndex({ ...ids, key: "owner_idx" })))) {
    await tables.createIndex({ ...ids, key: "owner_idx", type: TablesDBIndexType.Key, columns: [OWNER_COLUMN] });
    console.log(`created index ${tableId}.owner_idx`);
  }
  await backfillOwners(tableId);
}

async function main(): Promise<void> {
  if (!(await exists(() => tables.get({ databaseId: DATABASE_ID })))) {
    await tables.create({ databaseId: DATABASE_ID, name: "Main" });
    console.log(`created database ${DATABASE_ID}`);
  }

  for (const table of TABLES) {
    const ids = { databaseId: DATABASE_ID, tableId: table.id };
    if (!(await exists(() => tables.getTable(ids)))) {
      await tables.createTable({
        ...ids,
        name: table.name,
        permissions: table.serverOnly ? [] : [Permission.create(Role.users())],
        rowSecurity: true,
      });
      console.log(`created table ${table.id}`);
    }
    for (const column of table.columns) {
      if (!(await exists(() => tables.getColumn({ ...ids, key: column.key })))) {
        await addColumn(table.id, column);
        console.log(`created column ${table.id}.${column.key}`);
      }
    }
    if (table.id === DELETIONS_TABLE) {
      for (const column of table.columns) await waitForColumn(table.id, column.key);
    }
    if (table.personal) await ensureOwner(table.id);
  }

  const { failed } = await finishPendingDeletions({ tables, users: new Users(client) });
  if (failed) console.warn("Some account deletions are pending. The next maintenance run will retry.");
  console.log("setup done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
