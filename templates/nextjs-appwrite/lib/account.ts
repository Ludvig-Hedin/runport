"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AppwriteException } from "node-appwrite";
import { routes } from "@/runport.config";
import { createAdminClient, createSessionClient, sessionCookieName } from "./appwrite";
import { TOO_MANY_ATTEMPTS, friendlyError } from "./auth-errors";
import { authMode } from "./config";
import { allowed } from "./rate-limit";
import { type FlashMessage, setFlash } from "./flash";
import { DELETIONS_TABLE, finishPendingDeletions, sweepOwnedRows, tombstone } from "./ownership";
import { DATABASE_ID } from "./schema";
import { getUser } from "./session";

// What a signed-in person can do on their own account page. Every action acts
// as that person through their session, except deleting the account, which
// uses the server key and only removes rows held by that person alone (see
// lib/ownership.ts).

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

/**
 * Deletes the person's account. One way only: once confirmed it is never reopened by code.
 *
 * 1. A record of the request is saved (account id + its creation time).
 * 2. The account is blocked. From here no session can read or write, and a
 *    second tab cannot start another deletion.
 * 3. Rows held by this person alone are deleted and the account becomes an
 *    anonymous placeholder (kept blocked, so its id is never reused).
 * 4. Half a minute later the same clean-up runs again in the background to
 *    catch anything a request already under way wrote late; `bun run setup`
 *    and every later deletion run it too, until the record can be closed.
 */
export async function deleteAccount(_: AccountState, form: FormData): Promise<AccountState> {
  const user = await getUser();
  if (!user) return SIGNED_OUT;
  if (!(await allowed("account", user.email))) return { error: TOO_MANY_ATTEMPTS };
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return { error: "Type your email address exactly to confirm." };
  }
  const { tables, users } = createAdminClient();

  try {
    await tables.upsertRow({
      databaseId: DATABASE_ID,
      tableId: DELETIONS_TABLE,
      rowId: user.$id,
      data: { userId: user.$id, userCreatedAt: user.$createdAt, blockedAt: new Date().toISOString() },
    });
    await users.updateStatus({ userId: user.$id, status: false });
  } catch (error) {
    console.error("could not start account deletion", error);
    return { error: "Nothing was deleted. Try again in a moment." };
  }

  // The account is closed now. Whatever happens next, the clean-up finishes.
  let message: FlashMessage = "Your account and its data have been deleted.";
  try {
    if ((await sweepOwnedRows(tables, user.$id)) > 0) throw new Error("rows left");
    await tombstone(users, user.$id);
  } catch (error) {
    console.error("account closed, clean-up continues in the background", error);
    message = "Your account is closed. Removing the rest of your data will finish shortly.";
  }
  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await finishPendingDeletions(tables, users).catch((error) => console.error("deletion clean-up", error));
  });
  (await cookies()).delete(sessionCookieName());
  await setFlash(message);
  redirect(routes.afterSignOut);
}
