import "server-only";
import { cookies } from "next/headers";
import { config } from "./appwrite";
import { safeEqual } from "./site-lock";

// A random value tying the Google/GitHub return trip to the browser that
// started it. Kept in the callback path rather than the query, so it survives
// Appwrite adding its own query parameters.

const MAX_AGE = 10 * 60;
const cookieName = () => `oauth_${config.projectId()}`;

export async function newOAuthState(): Promise<string> {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  (await cookies()).set(cookieName(), state, {
    path: "/auth/oauth",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE,
  });
  return state;
}

/** True when the state matches this browser's cookie. Works once. */
export async function takeOAuthState(state: string): Promise<boolean> {
  const store = await cookies();
  const expected = store.get(cookieName())?.value;
  store.delete({ name: cookieName(), path: "/auth/oauth" });
  return Boolean(expected) && /^[0-9a-f]{48}$/.test(state) && safeEqual(state, expected ?? "");
}
