"use server";

import { AppwriteException } from "node-appwrite";
import { createSessionClient } from "./appwrite";
import { TOO_MANY_ATTEMPTS, friendlyError } from "./auth-errors";
import { authMode } from "./config";
import { allowed } from "./rate-limit";
import { getUser } from "./session";

// What a signed-in person can do on their own account page. Every action acts
// as that person through their session, so Appwrite's own rules apply.

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
