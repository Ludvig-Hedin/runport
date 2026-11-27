"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { routes } from "@/runport.config";
import { createAdminClient, createSessionClient, sessionCookieName } from "./appwrite";
import { TOO_MANY_ATTEMPTS, friendlyError } from "./auth-errors";
import { authMode } from "./config";
import { allowed } from "./rate-limit";
import { DATABASE_ID, TABLES } from "./schema";
import { getUser } from "./session";

// What a signed-in person can do on their own account page. Every action acts
// as that person through their session, except deleting the account, which
// needs the server key after their own rows are gone.

export type AccountState = { error?: string; notice?: string };

const SIGNED_OUT: AccountState = { error: "You are signed out. Sign in again." };

async function guard(): Promise<{ email: string } | AccountState> {
  const user = await getUser();
  if (!user) return SIGNED_OUT;
  if (!(await allowed("account", user.email))) return { error: TOO_MANY_ATTEMPTS };
  return { email: user.email };
}

export async function updateName(_: AccountState, form: FormData): Promise<AccountState> {
  const check = await guard();
  if ("error" in check) return check;
  const name = String(form.get("name") ?? "").trim();
  if (name.length > 128) return { error: "Use at most 128 characters." };
  try {
    const { account } = await createSessionClient();
    await account.updateName({ name });
  } catch (error) {
    return { error: friendlyError(error, "Could not save the name.") };
  }
  return { notice: "Saved." };
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
    return { error: friendlyError(error, "Could not change the password. Check the current password.") };
  }
  return { notice: "Password changed." };
}

/** Signs out one other device, or every other device when no id is given. */
export async function signOutDevices(sessionId?: string): Promise<AccountState> {
  const check = await guard();
  if ("error" in check) return check;
  try {
    const { account } = await createSessionClient();
    const { sessions } = await account.listSessions();
    const targets = sessions.filter((s) => !s.current && (!sessionId || s.$id === sessionId));
    await Promise.all(targets.map((s) => account.deleteSession({ sessionId: s.$id })));
  } catch (error) {
    return { error: friendlyError(error, "Could not sign out that device.") };
  }
  return { notice: sessionId ? "Device signed out." : "Signed out everywhere else." };
}

/** Deletes the person's own rows in every app table, then the account itself. */
export async function deleteAccount(_: AccountState, form: FormData): Promise<AccountState> {
  const user = await getUser();
  if (!user) return SIGNED_OUT;
  if (!(await allowed("account", user.email))) return { error: TOO_MANY_ATTEMPTS };
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return { error: "Type your email address exactly to confirm." };
  }
  try {
    // The session client only sees rows this person can read, so shared rows
    // owned by others are never touched. Rows they can read but not delete fail
    // loudly instead of leaving a half-deleted account.
    const { tables } = await createSessionClient();
    for (const table of TABLES) {
      for (;;) {
        const { rows } = await tables.listRows({ databaseId: DATABASE_ID, tableId: table.id, queries: [Query.limit(100)] });
        const own = rows.filter((row) => row.$permissions.some((p) => p.includes(`user:${user.$id}`)));
        if (own.length === 0) break;
        await Promise.all(own.map((row) => tables.deleteRow({ databaseId: DATABASE_ID, tableId: table.id, rowId: row.$id })));
        if (own.length < rows.length) break;
      }
    }
    await createAdminClient().users.delete({ userId: user.$id });
  } catch (error) {
    return { error: friendlyError(error, "Could not delete the account. Nothing was removed from your sign-in.") };
  }
  (await cookies()).delete(sessionCookieName());
  redirect(`${routes.afterSignOut}?deleted=1`);
}
