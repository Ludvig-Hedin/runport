// The unlock cookie holds an HMAC of a fixed label keyed with SITE_PASSWORD.
// It proves the visitor knew the password without storing it, and a new
// password gives a new value, so old cookies stop working on their own.
// Web Crypto only, so the same code runs in the proxy and in server actions.

const LABEL = "site-unlock-v1";

export const UNLOCK_MAX_AGE = 60 * 60 * 24 * 30;

// Cookies on localhost are shared across ports, so the name carries the
// project id, like the session cookie.
export function unlockCookieName(): string {
  return `unlock_${process.env.APPWRITE_PROJECT_ID || "app"}`;
}

/** The cookie value for a password. The password must not be empty. */
export async function unlockToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(LABEL));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares every character, so the time taken does not hint at how much matched. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Where to go after unlocking: a path on this site, or "/". Blocks redirects
 * to other sites, and back to /unlock, which would loop.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  try {
    const url = new URL(value, "http://same.site");
    if (url.origin !== "http://same.site" || url.pathname === "/unlock") return "/";
    // Check the result too: "/.//evil.example" parses to "//evil.example",
    // which a browser would treat as another site.
    const path = url.pathname + url.search + url.hash;
    return path.startsWith("//") || path.startsWith("/\\") ? "/" : path;
  } catch {
    return "/";
  }
}
