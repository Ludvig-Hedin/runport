import "server-only";
import { cookies } from "next/headers";
import { DELETION_COMPLETE, DELETION_PENDING } from "./account-deletion";

// A one-off message carried across a redirect, such as "your account was
// deleted". It is set by the server only, lives a minute, and is never taken
// from the URL, so nobody can make the app show a message by sharing a link.

const COOKIE = "rp_flash";
const MESSAGES = [DELETION_COMPLETE, DELETION_PENDING] as const;
export type FlashMessage = (typeof MESSAGES)[number];
const ALLOWED = new Set<string>(MESSAGES);

const options = {
  path: "/", httpOnly: true, sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
} as const;

export async function setFlash(message: FlashMessage): Promise<void> {
  if (!ALLOWED.has(message)) throw new Error("Unknown flash message");
  (await cookies()).set(COOKIE, message, { ...options, maxAge: 60 });
}

/** The pending message, if any. Only known messages are returned. */
export async function readFlash(): Promise<string | undefined> {
  const value = (await cookies()).get(COOKIE)?.value;
  return value && ALLOWED.has(value) ? value : undefined;
}

/** Send the message and the matching cookie expiry in the same response. */
export async function consumeFlash(): Promise<string | undefined> {
  const notice = await readFlash();
  if (notice) (await cookies()).set(COOKIE, "", { ...options, maxAge: 0 });
  return notice;
}
