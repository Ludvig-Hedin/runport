import "server-only";
import { createHash } from "node:crypto";

// Visitors per app from Runport's Umami (analytics.runport.app), read with a
// view-only account (ANALYTICS_USERNAME / ANALYTICS_PASSWORD). It sees the
// sites only through the "Runport sites" team and cannot change anything.

let session: { token: string; until: number } | null = null;

function origin(): string | null {
  const url = process.env.ANALYTICS_URL?.replace(/\/+$/, "");
  return url && url.startsWith("https://") ? url : null;
}

async function token(): Promise<string> {
  if (session && session.until > Date.now()) return session.token;
  const base = origin();
  const username = process.env.ANALYTICS_USERNAME;
  const password = process.env.ANALYTICS_PASSWORD;
  if (!base || !username || !password) throw new Error("Analytics is not configured.");
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Analytics sign-in failed (HTTP ${res.status}).`);
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error("Analytics sign-in returned no token.");
  session = { token, until: Date.now() + 30 * 60 * 1000 };
  return token;
}

/** Same id mcp/src/analytics.ts gives each app's site, for apps whose variables lack it. */
export function siteIdFor(slug: string): string {
  const namespace = Buffer.from("0c3e97afecbe4f608925d26e88b17945", "hex");
  const bytes = createHash("sha1").update(namespace).update(slug).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.subarray(0, 16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

export type Visitors = { state: "ok"; visitors: number } | { state: "not-set-up" } | { state: "error" };

/** Unique visitors over the last 7 days. */
export async function visitorsLast7Days(slug: string, siteId: string | null): Promise<Visitors> {
  const base = origin();
  if (!base) return { state: "not-set-up" };
  try {
    const id = siteId ?? siteIdFor(slug);
    const auth = { Authorization: `Bearer ${await token()}` };
    // Umami answers zeros for a site that does not exist, so check it first.
    const site = await fetch(`${base}/api/websites/${encodeURIComponent(id)}`, { headers: auth, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (site.status === 404 || site.status === 401 || site.status === 403) return { state: "not-set-up" };
    if (!site.ok || !(await site.json().catch(() => null))) return { state: "not-set-up" };
    const end = Date.now();
    const res = await fetch(`${base}/api/websites/${encodeURIComponent(id)}/stats?startAt=${end - 7 * 86_400_000}&endAt=${end}`, {
      headers: auth,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404 || res.status === 401 || res.status === 403) return { state: "not-set-up" };
    if (!res.ok) return { state: "error" };
    const body = (await res.json()) as { visitors?: number | { value: number } };
    const v = typeof body.visitors === "number" ? body.visitors : body.visitors?.value;
    return typeof v === "number" ? { state: "ok", visitors: v } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}
