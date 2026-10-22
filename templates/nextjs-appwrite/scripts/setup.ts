// Creates the database and tables from lib/schema.ts. Safe to run again.
// Row security is on: each row is readable and writable only by its creator.

import { AppwriteException, Client, Permission, Role, TablesDB } from "node-appwrite";
import { DATABASE_ID, TABLES, type ColumnSpec } from "../lib/schema";

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
  } else {
    await tables.createBooleanColumn({ ...base, xdefault: column.required ? undefined : column.default });
  }
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
        permissions: [Permission.create(Role.users())],
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
  }
  console.log("setup done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
