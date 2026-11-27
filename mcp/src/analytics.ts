import { createHash } from "node:crypto";
import { config } from "./config";
import { readSecret } from "./keychain";

const namespace = Buffer.from("0c3e97afecbe4f608925d26e88b17945", "hex");

function websiteId(slug: string): string {
  const bytes = createHash("sha1").update(namespace).update(slug).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.subarray(0, 16).toString("hex").replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
}

type Options = {
  origin?: string;
  password?: () => Promise<string>;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
};
type Website = { id: string; domain: string };

export async function ensureAnalytics(slug: string, domain?: string, options: Options = {}): Promise<{
  ANALYTICS_URL?: string;
  ANALYTICS_SITE_ID?: string;
}> {
  const origin = options.origin ?? process.env.PLATFORM_ANALYTICS_URL ??
    (config.keychainService === "runport-prod" ? "https://analytics.runport.app" : undefined);
  if (!origin) return {};

  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PLATFORM_ANALYTICS_URL must be a plain HTTPS origin.");
  }
  const request = options.request ?? fetch;
  const password = options.password ?? (() => readSecret("analytics-admin-password"));
  const send = (path: string, payload?: unknown, token?: string) =>
    request(url.origin + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

  const login = await send("/api/auth/login", { username: "admin", password: await password() });
  if (!login.ok) throw new Error(`Analytics sign-in failed (HTTP ${login.status}).`);
  const { token, passwordChangeRequired } = await login.json() as { token?: string; passwordChangeRequired?: boolean };
  if (!token || passwordChangeRequired) throw new Error("Umami needs a secured admin account before provisioning sites.");

  const id = websiteId(slug);
  const path = `/api/websites/${id}`;
  const getSite = async () => {
    const response = await send(path, undefined, token);
    if (response.status === 404 || response.status === 401) return null;
    if (!response.ok) throw new Error(`Analytics site lookup failed (HTTP ${response.status}).`);
    return await response.json() as Website | null;
  };

  let site = await getSite();
  if (!site) {
    const created = await send("/api/websites", { id, name: slug, domain: domain ?? `${slug}.${config.mailDomain}` }, token);
    // A concurrent create can win between GET and POST. The same ID also
    // covers a request that succeeded upstream before the caller timed out.
    site = created.ok ? await created.json() as Website : await getSite();
    if (!site) throw new Error(`Analytics site creation failed (HTTP ${created.status}).`);
  }
  if (site.id !== id) throw new Error("Umami returned an unexpected website ID.");
  if (domain && site.domain !== domain) {
    const updated = await send(path, { domain }, token);
    if (!updated.ok) throw new Error(`Analytics domain update failed (HTTP ${updated.status}).`);
  }
  return { ANALYTICS_URL: url.origin, ANALYTICS_SITE_ID: id };
}
