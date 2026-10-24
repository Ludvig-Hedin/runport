"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TOO_MANY_ATTEMPTS } from "@/lib/auth-errors";
import { sitePassword } from "@/lib/config";
import { allowed } from "@/lib/rate-limit";
import { UNLOCK_MAX_AGE, safeEqual, safeNextPath, unlockCookieName, unlockToken } from "@/lib/site-lock";

export type UnlockState = { error?: string };

export async function unlock(_: UnlockState, form: FormData): Promise<UnlockState> {
  const next = safeNextPath(String(form.get("next") ?? ""));
  const expected = sitePassword();
  if (!expected) redirect(next);
  const password = String(form.get("password") ?? "");
  if (!password) return { error: "Enter the password." };
  if (!(await allowed("unlock"))) return { error: TOO_MANY_ATTEMPTS };
  // Comparing the two HMACs keeps the check constant-time for any password length.
  const [given, wanted] = await Promise.all([unlockToken(password), unlockToken(expected)]);
  if (!safeEqual(given, wanted)) return { error: "Wrong password." };
  (await cookies()).set(unlockCookieName(), wanted, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: UNLOCK_MAX_AGE,
  });
  redirect(next);
}
