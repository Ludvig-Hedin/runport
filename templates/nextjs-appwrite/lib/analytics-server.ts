import { isIP } from "node:net";

const SITE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_EVENT_BYTES = 16_384;

export function analyticsConfig() {
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME;
  const { ANALYTICS_URL: url, ANALYTICS_SITE_ID: siteId } = process.env;
  if (process.env.NODE_ENV !== "production" || (environment && environment !== "production") ||
      !url || !siteId || !SITE_ID.test(siteId)) return null;
  const origin = URL.parse(url);
  if (!origin || origin.protocol !== "https:" || origin.href !== `${origin.origin}/`) return null;
  return { origin: origin.origin, siteId };
}

export function trackingDisabled(headers: Pick<Headers, "get">) {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

function forwardHeaders(request: Request, names: string[]) {
  const headers = new Headers();
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function readEvent(request: Request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode()) as {
        type?: unknown;
        payload?: Record<string, unknown>;
      } | null;
      bytes += value.byteLength;
      if (bytes > MAX_EVENT_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function collectEvent(request: Request): Promise<Response> {
  const analytics = analyticsConfig();
  if (!analytics) return new Response(null, { status: 404 });
  if (trackingDisabled(request.headers)) return new Response(null, { status: 204 });

  const event = await readEvent(request);
  const payload = event?.payload;
  if (event?.type !== "event" || !payload || payload.website !== analytics.siteId) {
    return new Response(null, { status: 400 });
  }

  // Keep paths, strip query strings, fragments and any credentials. The
  // tracker already strips search and hashes, but custom events can set URLs.
  const app = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? app.host;
  const browserOrigin = request.headers.get("origin");
  const site = browserOrigin ? URL.parse(browserOrigin) : URL.parse(`${app.protocol}//${host}`);
  if (!site || site.host !== host) return new Response(null, { status: 400 });
  const page = typeof payload.url === "string" ? URL.parse(payload.url, site) : null;
  if (!page || page.origin !== site.origin) return new Response(null, { status: 400 });
  const referrer = typeof payload.referrer === "string" && payload.referrer ? URL.parse(payload.referrer, page) : null;
  const referrerUrl = referrer && ["https:", "http:"].includes(referrer.protocol)
    ? `${referrer.origin}${referrer.pathname}` : undefined;
  const body = JSON.stringify({
    type: "event",
    payload: {
      website: analytics.siteId,
      url: `${page.origin}${page.pathname}`,
      hostname: page.hostname,
      referrer: referrerUrl,
      screen: payload.screen,
      language: payload.language,
      title: payload.title,
      name: payload.name,
      data: payload.name ? payload.data : undefined,
    },
  });
  const headers = forwardHeaders(request, ["user-agent", "x-umami-cache"]);
  headers.set("content-type", "application/json");
  // As with auth rate limits, only trust the last address appended by Railway.
  const ip = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (process.env.RAILWAY_SERVICE_ID && ip && isIP(ip)) headers.set("x-runport-visitor-ip", ip);
  return proxyAnalytics(analytics.origin + "/api/send", {
    method: "POST", body, headers, cache: "no-store",
  });
}

export async function proxyAnalytics(url: string, init: RequestInit, maxAge?: number) {
  try {
    const upstream = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const headers = new Headers({
      "cache-control": maxAge && upstream.ok ? `private, max-age=${maxAge}` : "no-store",
      "x-content-type-options": "nosniff",
    });
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response(null, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
