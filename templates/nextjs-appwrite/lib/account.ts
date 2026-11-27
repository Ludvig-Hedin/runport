"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
 * Deletes the person's own rows in every personal table and removes them as a user.
 *
 * 1. A record per account acts as a lock, so two clicks cannot race.
 * 2. The account is blocked: no session can write any more.
 * 3. Rows held by this person alone are deleted until none are left.
 * 4. The account becomes an anonymous, blocked placeholder: email, name,
 *    linked sign-ins and sessions are removed. It is kept so its id is never
 *    reused. The email address is free to sign up again.
 * 5. Rows a request already under way writes late are swept by the next
 *    deletion or `bun run setup`, which only ever touch blocked accounts.
 * If step 3 fails, the account is unblocked, the lock removed, and the
 * person can simply try again.
 */
export async function deleteAccount(_: AccountState, form: FormData): Promise<AccountState> {
  const user = await getUser();
  if (!user) return SIGNED_OUT;
  if (!(await allowed("account", user.email))) return { error: TOO_MANY_ATTEMPTS };
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return { error: "Type your email address exactly to confirm." };
  }
  const { tables, users } = createAdminClient();
  const lock = { databaseId: DATABASE_ID, tableId: DELETIONS_TABLE, rowId: user.$id };

  await finishPendingDeletions(tables, users).catch(() => 0);
  try {
    await tables.createRow({ ...lock, data: { userId: user.$id, blockedAt: new Date().toISOString() } });
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      return { error: "Your account is already being deleted. Reload the page in a moment." };
    }
    return { error: friendlyError(error, "Could not start deleting the account.") };
  }

  try {
    await users.updateStatus({ userId: user.$id, status: false });
    let left = await sweepOwnedRows(tables, user.$id);
    for (let retry = 0; left > 0 && retry < 2; retry++) left = await sweepOwnedRows(tables, user.$id);
    if (left > 0) throw new Error(`${left} rows could not be removed`);
  } catch (error) {
    console.error("account deletion stopped", error);
    // Undo only if no clean-up run has already turned the account into a placeholder.
    const current = await users.get({ userId: user.$id }).catch(() => null);
    if (current && current.email === user.email) {
      await users.updateStatus({ userId: user.$id, status: true }).catch(() => {});
      await tables.deleteRow(lock).catch(() => {});
    }
    return { error: "Deleting stopped before it finished. Nothing else changed and your account still works. Try again." };
  }

  // Data is gone and nobody can sign in; now remove who they were.
  let message: FlashMessage = "Your account and its data have been deleted.";
  try {
    await tombstone(users, user.$id);
  } catch (error) {
    console.error("data deleted, sign-in details not yet removed", error);
    message = "Your data has been deleted. Removing your sign-in details will finish shortly.";
  }
  (await cookies()).delete(sessionCookieName());
  await setFlash(message);
  redirect(routes.afterSignOut);
}
