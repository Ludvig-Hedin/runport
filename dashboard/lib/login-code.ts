import "server-only";
import { cookies } from "next/headers";
import { config } from "./appwrite";
import { LIMITS, clear, take } from "./rate-limit";

// State between "send code" and "enter code". The user id stays in an
// httpOnly cookie instead of the URL. Codes are bound to the user id inside
// Appwrite, so editing the cookie gains nothing.

export type PendingLogin = { userId: string; email: string; expire: number };

// Longer than a code lives (15 minutes), so an expired code gets a clear message.
const MAX_AGE = 60 * 60;
const cookieName = () => `login_${config.projectId()}`;

function isPendingLogin(value: unknown): value is PendingLogin {
  if (typeof value !== "object" || value === null) return false;
  const { userId, email, expire } = value as Record<string, unknown>;
  return typeof userId === "string" && typeof email === "string" && typeof expire === "number";
}

export async function readPendingLogin(): Promise<PendingLogin | null> {
  const raw = (await cookies()).get(cookieName())?.value;
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return isPendingLogin(value) ? value : null;
  } catch {
    return null;
  }
}

export async function savePendingLogin(login: PendingLogin): Promise<void> {
  (await cookies()).set(cookieName(), Buffer.from(JSON.stringify(login)).toString("base64url"), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE,
  });
}

export async function clearPendingLogin(): Promise<void> {
  (await cookies()).delete(cookieName());
}

/** Counts one code attempt. False once the user has used up their tries for now. */
export function takeCodeAttempt(userId: string): boolean {
  return take(`checkCode:user:${userId}`, ...LIMITS.checkCode.user);
}

export function clearCodeAttempts(userId: string): void {
  clear(`checkCode:user:${userId}`);
}
