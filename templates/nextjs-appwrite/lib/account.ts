"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppwriteException, Query } from "node-appwrite";
import { routes } from "@/runport.config";
import { createAdminClient, createSessionClient, sessionCookieName } from "./appwrite";
import { TOO_MANY_ATTEMPTS, friendlyError } from "./auth-errors";
import { authMode } from "./config";
import { setFlash } from "./flash";
import { allowed } from "./rate-limit";
import { DATABASE_ID, OWNER_COLUMN, TABLES } from "./schema";
import { getUser } from "./session";

// What a signed-in person can do on their own account page. Every action acts
// as that person through their session, except deleting the account, which
// uses the server key and selects rows by the server-set `owner` column only.

export type AccountState = { error?: string; notice?: string; name?: string };

const SIGNED_OUT: AccountState = { error: "You are signed out. Sign in again." };

async function guard(): Promise<{ email: string } | AccountState> {
  const user = await getUser();
  if (!user) return SIGNED_OUT;
  if (!(await allowed("account", user.email))) return { error: TOO_MANY_ATTEMPTS };
  return { email: user.email };
}

/** Deletes every session except the one making this request. */
async function endOtherSessions(): Promise<number> {
  const { account } = await createSessionClient();
  const { sessions } = await account.listSessions();
  const others = sessions.filter((s) => !s.current);
  await Promise.all(others.map((s) => account.deleteSession({ sessionId: s.$id })));
  return others.length;
}

export async function updateName(_: AccountState, form: FormData): Promise<AccountState> {
  const check = await guard();
  if ("error" in check) return check;
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Enter a name." };
  if (name.length > 128) return { error: "Use at most 128 characters." };
  try {
    const { account } = await createSessionClient();
    const saved = await account.updateName({ name });
    return { notice: "Saved.", name: saved.name };
  } catch (error) {
    return { error: friendlyError(error, "Could not save the name.") };
  }
}

export async function changePassword(_: AccountState, form: FormData): Promise<AccountState> {
  if (authMode() !== "password") return { error: "This app signs in with email codes, so there is no password." };
  const check = await guard();
  if ("error" in check) return check;
  const oldPassword = String(form.get("current") ?? "");
  const password = String(form.get("password") ?? "");
  if (password.length < 8) return { error: "Password needs at least 8 characters." };
  if (password === oldPassword) return { error: "Choose a password that differs from the current one." };
  try {
    const { account } = await createSessionClient();
    await account.updatePassword({ password, oldPassword });
  } catch (error) {
    if (error instanceof AppwriteException && error.type === "user_invalid_credentials") {
      return { error: "That current password is wrong." };
    }
    return { error: friendlyError(error, "Could not change the password.") };
  }
  // Anyone who knew the old password must not stay signed in elsewhere.
  try {
    await endOtherSessions();
  } catch {
    return { notice: "Password changed. Sign out your other devices below to be safe." };
  }
  return { notice: "Password changed. Other devices were signed out." };
}

/** Signs out one other device, or every other device when no id is given. */
export async function signOutDevices(sessionId?: string): Promise<AccountState> {
  const check = await guard();
  if ("error" in check) return check;
  try {
    if (!sessionId) {
      await endOtherSessions();
    } else {
      const { account } = await createSessionClient();
      const { sessions } = await account.listSessions();
      const target = sessions.find((s) => s.$id === sessionId && !s.current);
      if (target) await account.deleteSession({ sessionId: target.$id });
    }
  } catch (error) {
    return { error: friendlyError(error, "Could not sign out that device.") };
  }
  return { notice: sessionId ? "Device signed out." : "Signed out everywhere else." };
}

const PAGE = 100;
const MAX_PAGES = 1000; // 100,000 rows per table; anything bigger needs a job, not a click

type Row = { $id: string; $permissions: string[] } & Record<string, unknown>;

/**
 * A row is this person's only when both agree: the server-set owner column
 * names them AND the row's own permissions name them. A row where the two
 * disagree is left alone (never deleted, never blocks deletion).
 */
const isOwnRow = (row: Row, userId: string) =>
  row[OWNER_COLUMN] === userId && row.$permissions.some((p) => p.includes(`"user:${userId}"`) || p.includes(`"user:${userId}/`));

/** Walks every row whose owner column names this person, one page at a time. */
async function* ownerRows(tableId: string, userId: string): AsyncGenerator<Row> {
  const { tables } = createAdminClient();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const queries = [Query.equal(OWNER_COLUMN, userId), Query.orderAsc("$id"), Query.limit(PAGE), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
    const { rows } = await tables.listRows({ databaseId: DATABASE_ID, tableId, queries });
    if (rows.length === 0) return;
    for (const row of rows) yield row as unknown as Row;
    cursor = rows[rows.length - 1].$id;
  }
  throw new Error(`Too many rows in ${tableId} to delete in one go`);
}

/** Deletes every row this person owns in one table. Rows whose owner and permissions disagree are skipped. */
async function deleteOwnedRows(tableId: string, userId: string): Promise<void> {
  const { tables } = createAdminClient();
  const own: string[] = [];
  for await (const row of ownerRows(tableId, userId)) if (isOwnRow(row, userId)) own.push(row.$id);
  for (const rowId of own) await tables.deleteRow({ databaseId: DATABASE_ID, tableId, rowId });
}

async function ownedRowsLeft(userId: string): Promise<number> {
  let left = 0;
  for (const table of TABLES.filter((t) => t.personal)) {
    for await (const row of ownerRows(table.id, userId)) if (isOwnRow(row, userId)) left++;
  }
  return left;
}

/**
 * Deletes the person's own rows in every personal table, checks none are left,
 * then deletes the account. If anything fails the account stays, so the person
 * can simply try again: each step picks up where the last attempt stopped.
 */
export async function deleteAccount(_: AccountState, form: FormData): Promise<AccountState> {
  const user = await getUser();
  if (!user) return SIGNED_OUT;
  if (!(await allowed("account", user.email))) return { error: TOO_MANY_ATTEMPTS };
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return { error: "Type your email address exactly to confirm." };
  }
  try {
    // Other devices could keep adding rows while this runs, so sign them out first.
    await endOtherSessions();
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const table of TABLES.filter((t) => t.personal)) await deleteOwnedRows(table.id, user.$id);
      if ((await ownedRowsLeft(user.$id)) === 0) break;
      if (attempt === 2) throw new Error("Rows kept appearing during deletion");
    }
    await createAdminClient().users.delete({ userId: user.$id });
  } catch (error) {
    console.error("account deletion stopped", error);
    return { error: "Deleting stopped before it finished. Your account still exists. Try again to finish." };
  }
  // The account and its sessions are gone; a last sweep catches a row written in the final moment.
  for (const table of TABLES.filter((t) => t.personal)) await deleteOwnedRows(table.id, user.$id).catch(() => {});
  (await cookies()).delete(sessionCookieName());
  await setFlash("Your account and its data have been deleted.");
  redirect(routes.afterSignOut);
}
