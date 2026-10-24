"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppwriteException, ID } from "node-appwrite";
import { createAdminClient, createSessionClient, sessionCookieName } from "./appwrite";
import { INVALID_EMAIL, TOO_MANY_ATTEMPTS, friendlyError, isEmail } from "./auth-errors";
import { allowed } from "./rate-limit";
import { appUrl, authMode } from "./config";
import { setSessionCookie } from "./session";

// Email + password sign-in, used when AUTH_MODE=password. Sign-out works in every mode.

export type FormState = { error?: string; notice?: string };

const PASSWORD_OFF: FormState = { error: "Sign-in with a password is turned off." };

async function startSession(email: string, password: string): Promise<void> {
  const { account } = createAdminClient();
  await setSessionCookie(await account.createEmailPasswordSession({ email, password }));
}

function readCredentials(form: FormData) {
  return {
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    name: String(form.get("name") ?? "").trim(),
  };
}

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  if (authMode() !== "password") return PASSWORD_OFF;
  const { email, password, name } = readCredentials(form);
  if (!isEmail(email)) return { error: INVALID_EMAIL };
  if (password.length < 8) return { error: "Password needs at least 8 characters." };
  if (!(await allowed("signUp"))) return { error: TOO_MANY_ATTEMPTS };
  try {
    const { account } = createAdminClient();
    await account.create({ userId: ID.unique(), email, password, name: name || undefined });
    await startSession(email, password);
  } catch (error) {
    return { error: friendlyError(error, "Could not create the account.") };
  }
  redirect("/items");
}

export async function signIn(_: FormState, form: FormData): Promise<FormState> {
  if (authMode() !== "password") return PASSWORD_OFF;
  const { email, password } = readCredentials(form);
  if (!isEmail(email)) return { error: INVALID_EMAIL };
  if (!(await allowed("signIn", email))) return { error: TOO_MANY_ATTEMPTS };
  try {
    await startSession(email, password);
  } catch (error) {
    return { error: friendlyError(error, "Could not sign in.") };
  }
  redirect("/items");
}

/** Emails a reset link. Answers the same whether or not the account exists. */
export async function requestReset(_: FormState, form: FormData): Promise<FormState> {
  if (authMode() !== "password") return PASSWORD_OFF;
  const email = String(form.get("email") ?? "").trim();
  if (!isEmail(email)) return { error: INVALID_EMAIL };
  if (!(await allowed("reset", email))) return { error: TOO_MANY_ATTEMPTS };
  try {
    const { account } = createAdminClient();
    await account.createRecovery({ email, url: `${appUrl()}/reset` });
  } catch (error) {
    const unknownUser = error instanceof AppwriteException && error.code === 404;
    if (!unknownUser) return { error: friendlyError(error, "Could not send the link.") };
  }
  return { notice: "If an account exists for that email, we sent a link to reset the password." };
}

export async function resetPassword(_: FormState, form: FormData): Promise<FormState> {
  if (authMode() !== "password") return PASSWORD_OFF;
  const userId = String(form.get("userId") ?? "");
  const secret = String(form.get("secret") ?? "");
  const password = String(form.get("password") ?? "");
  if (!userId || !secret) return { error: "This reset link is not valid. Ask for a new one." };
  if (password.length < 8) return { error: "Password needs at least 8 characters." };
  if (password !== String(form.get("confirm") ?? "")) return { error: "The passwords do not match." };
  try {
    const { account } = createAdminClient();
    await account.updateRecovery({ userId, secret, password });
  } catch (error) {
    if (error instanceof AppwriteException && error.type === "user_invalid_token") {
      return { error: "This reset link has expired or was already used. Ask for a new one." };
    }
    return { error: friendlyError(error, "Could not save the password.") };
  }
  redirect("/login?reset=1");
}

export async function signOut(): Promise<void> {
  try {
    const { account } = await createSessionClient();
    await account.deleteSession({ sessionId: "current" });
  } catch {
    // Already signed out on the Appwrite side. Clearing the cookie is enough.
  }
  (await cookies()).delete(sessionCookieName());
  redirect("/login");
}
