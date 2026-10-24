import "server-only";
import { cookies } from "next/headers";
import type { Models } from "node-appwrite";
import { createSessionClient, sessionCookieName } from "./appwrite";

/** The signed-in user, or null when signed out or the session expired. */
export async function getUser(): Promise<Models.User | null> {
  try {
    const { account } = await createSessionClient();
    return await account.get();
  } catch {
    return null;
  }
}

/** Signs the browser in by storing the Appwrite session secret in this app's cookie. */
export async function setSessionCookie(session: Models.Session): Promise<void> {
  (await cookies()).set(sessionCookieName(), session.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(session.expire),
  });
}
