import "server-only";
import { headers } from "next/headers";

// The app calls Appwrite with an API key, which skips Appwrite's own rate
// limits, so every sign-in step is capped here. Counting before the check
// keeps parallel requests from slipping through. Memory only: right for one
// server process, which is how apps run on the platform.

type Window = { count: number; until: number };
const windows = new Map<string, Window>();

/** Counts one attempt for this key. False once the key has used up its tries for now. */
export function take(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (windows.size > 5000) {
    for (const [k, w] of windows) if (w.until <= now) windows.delete(k);
  }
  const current = windows.get(key);
  const entry = current && current.until > now ? current : { count: 0, until: now + windowMs };
  entry.count += 1;
  windows.set(key, entry);
  return entry.count <= max;
}

export function clear(key: string): void {
  windows.delete(key);
}

/**
 * The visitor's address as the host's proxy saw it. The last X-Forwarded-For
 * entry is the one the proxy added; earlier ones can be made up by the client.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded?.at(-1) ?? "unknown";
}

const MINUTE = 60 * 1000;

/** Limits per sign-in step: [max, window] per email and per visitor address. */
export const LIMITS = {
  sendCode: { email: [3, 10 * MINUTE], ip: [10, 60 * MINUTE] },
  checkCode: { user: [5, 15 * MINUTE] },
  signIn: { email: [10, 15 * MINUTE], ip: [30, 15 * MINUTE] },
  signUp: { ip: [10, 60 * MINUTE] },
  reset: { email: [3, 60 * MINUTE], ip: [10, 60 * MINUTE] },
  unlock: { ip: [10, 15 * MINUTE] },
} as const;

/** True when both the email (if given) and the visitor address are under their limits. */
export async function allowed(step: keyof typeof LIMITS, email?: string): Promise<boolean> {
  const limits = LIMITS[step] as Partial<Record<"email" | "ip", readonly [number, number]>>;
  const checks: boolean[] = [];
  if (limits.ip) checks.push(take(`${step}:ip:${await clientIp()}`, ...limits.ip));
  if (limits.email && email) checks.push(take(`${step}:email:${email.toLowerCase()}`, ...limits.email));
  return checks.every(Boolean);
}
