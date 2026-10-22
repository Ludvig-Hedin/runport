"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppwriteException, ID } from "node-appwrite";
import { createAdminClient, createSessionClient, sessionCookieName } from "./appwrite";

export type FormState = { error?: string };

async function startSession(email: string, password: string): Promise<void> {
  const { account } = createAdminClient();
  const session = await account.createEmailPasswordSession({ email, password });
  (await cookies()).set(sessionCookieName(), session.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(session.expire),
  });
}

function readCredentials(form: FormData) {
  return {
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    name: String(form.get("name") ?? "").trim(),
  };
}

function message(error: unknown, fallback: string): string {
  return error instanceof AppwriteException ? error.message : fallback;
}

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  const { email, password, name } = readCredentials(form);
  if (password.length < 8) return { error: "Password needs at least 8 characters." };
  try {
    const { account } = createAdminClient();
    await account.create({ userId: ID.unique(), email, password, name: name || undefined });
    await startSession(email, password);
  } catch (error) {
    return { error: message(error, "Could not create the account.") };
  }
  redirect("/items");
}

export async function signIn(_: FormState, form: FormData): Promise<FormState> {
  const { email, password } = readCredentials(form);
  try {
    await startSession(email, password);
  } catch (error) {
    return { error: message(error, "Could not sign in.") };
  }
  redirect("/items");
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
