"use server";

import { redirect } from "next/navigation";
import { AppwriteException, ID } from "node-appwrite";
import { createAdminClient } from "./appwrite";
import { INVALID_EMAIL, TOO_MANY_ATTEMPTS, friendlyError, isEmail } from "./auth-errors";
import {
  clearCodeAttempts,
  clearPendingLogin,
  readPendingLogin,
  savePendingLogin,
  takeCodeAttempt,
} from "./login-code";
import { allowed } from "./rate-limit";
import { setSessionCookie } from "./session";

// Sign-in with a one-time code by email. The same flow creates new accounts.

export type CodeState = { step: "email" | "code"; email?: string; error?: string; notice?: string };

const WRONG_CODE = "That code is not right. Check the email and try again.";
const EXPIRED_CODE = "This code has expired. Send a new code.";

async function sendCode(email: string): Promise<CodeState> {
  if (!isEmail(email)) return { step: "email", email, error: INVALID_EMAIL };
  if (!(await allowed("sendCode", email))) return { step: "email", email, error: TOO_MANY_ATTEMPTS };
  try {
    const { account } = createAdminClient();
    const token = await account.createEmailToken({ userId: ID.unique(), email });
    await savePendingLogin({ userId: token.userId, email, expire: Date.parse(token.expire) });
  } catch (error) {
    return { step: "email", email, error: friendlyError(error, "Could not send the code.") };
  }
  return { step: "code", email };
}

async function resendCode(): Promise<CodeState> {
  const pending = await readPendingLogin();
  if (!pending) return { step: "email" };
  const result = await sendCode(pending.email);
  if (result.error) return { ...result, step: "code" };
  return { ...result, notice: "We sent a new code." };
}

async function verifyCode(input: string): Promise<CodeState> {
  const pending = await readPendingLogin();
  if (!pending) return { step: "email", error: "Your sign-in timed out. Enter your email again." };
  const state: CodeState = { step: "code", email: pending.email };
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return { ...state, error: "Enter the 6-digit code from the email." };
  if (Date.now() > pending.expire) return { ...state, error: EXPIRED_CODE };
  if (!takeCodeAttempt(pending.userId)) return { ...state, error: TOO_MANY_ATTEMPTS };
  try {
    const { account } = createAdminClient();
    await setSessionCookie(await account.createSession({ userId: pending.userId, secret: code }));
  } catch (error) {
    // Appwrite answers the same for a wrong and an expired code.
    if (error instanceof AppwriteException && error.type === "user_invalid_token") {
      return { ...state, error: Date.now() > pending.expire ? EXPIRED_CODE : WRONG_CODE };
    }
    return { ...state, error: friendlyError(error, "Could not sign in.") };
  }
  clearCodeAttempts(pending.userId);
  await clearPendingLogin();
  redirect("/items");
}

/** One action for the whole form. The pressed button's `intent` picks the step. */
export async function emailCode(state: CodeState, form: FormData): Promise<CodeState> {
  switch (form.get("intent")) {
    case "send":
      return sendCode(String(form.get("email") ?? "").trim());
    case "resend":
      return resendCode();
    case "verify":
      return verifyCode(String(form.get("code") ?? ""));
    case "restart":
      await clearPendingLogin();
      return { step: "email" };
    default:
      return state;
  }
}
